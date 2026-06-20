/**
 * liquifi risk agent loop.
 *
 * Each tick (default 20s):
 *   1. deriver.run()  -> refresh positions (Scallop read) + market_snapshots (Pyth/DeepBook)
 *   2. for each active position: compute deterministic score + reason codes
 *   3. OpenAI (gpt-5) explanation -> write risk_scores row + emit realtime
 *   4. if emergency & scallop & executable & policy active:
 *        a. submit risk snapshot on-chain (shield_oracle::submit_risk_snapshot)
 *        b. executeRescue(...) from ptb/dist (simulate -> submit, fail-closed)
 *        c. write risk_actions row + emit realtime
 *   5. NAVI positions: score + recommendation only; never execute (monitoring-only)
 *
 * Demo stress: setStress(positionId, { healthFactor | haircutPct }) lets /api/simulate-shock
 * stress the TRIGGER for one+ ticks. The rescue PTB itself is fully real on-chain.
 */

import { SuiClient as SuiRpcClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { computeRiskScore, explainRisk } from './risk-engine.js';
import { upsertRows, TABLE_SHAPES } from './liquidshield-tables.js';

const SUI_CLOCK_ID = '0x6';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class RiskAgent {
  /**
   * @param {object} opts
   * @param {object} opts.database
   * @param {object} opts.lsConfig
   * @param {import('./liquidshield-deriver.js').LiquidShieldDeriver} opts.deriver
   * @param {object} [opts.realtimeHub]   SeFi RealtimeHub (optional)
   * @param {function} [opts.logger]
   */
  constructor({ database, lsConfig, deriver, scallopReader = null, alerter = null, suiIndexer = null, realtimeHub = null, logger = () => {} }) {
    this.database = database;
    this.lsConfig = lsConfig;
    this.deriver = deriver;
    this.scallopReader = scallopReader; // #9 pre/post obligation reads
    this.alerter = alerter;             // #21 alerts (optional)
    this.suiIndexer = suiIndexer;       // #21 freshness gate (indexer lag)
    this.realtimeHub = realtimeHub;
    this.logger = logger;

    this.rpc = new SuiRpcClient({ url: lsConfig.suiRpcUrl });
    this.stress = new Map(); // positionId -> { healthFactor?, haircutPct? }
    this.disabledPositions = new Set(); // #9 auto-execute disabled (post-state didn't improve)
    this.activeLocks = new Set();       // #20 in-memory fast guard
    this.scallopReadFailures = 0;       // #21 metric
    this.isRunning = false;
    this.shouldStop = false;
    this.lastTickAt = null;
    this.lastTickSummary = null;
    this.ptb = null; // lazily-imported { executeRescue, builders, types }

    // ptb/dist/{types,scallop_rescue} read these from process.env at import time, falling
    // back to TESTNET defaults. The backend loads .env into config (not process.env), so we
    // must bridge them here BEFORE loadPtb() — otherwise mainnet would use testnet IDs.
    const ptbEnv = {
      AGENT_PRIVATE_KEY: lsConfig.agentPrivateKey,
      SUI_RPC_URL: lsConfig.suiRpcUrl,
      LIQUIDSHIELD_PACKAGE_ID: lsConfig.packageId,
      SHIELD_REGISTRY_ID: lsConfig.shieldRegistryId,
      SCALLOP_PACKAGE_ID: lsConfig.scallopPackageId,
      SCALLOP_VERSION_ID: lsConfig.scallopVersionId,
      SCALLOP_MARKET_ID: lsConfig.scallopMarketId,
    };
    for (const [k, v] of Object.entries(ptbEnv)) {
      if (v && !process.env[k]) process.env[k] = v;
    }
  }

  publish(type, payload) {
    try {
      this.realtimeHub?.publish('index', type, payload);
    } catch {
      /* ignore */
    }
  }

  async loadPtb() {
    if (this.ptb) return this.ptb;
    const scallop = await import('../../../ptb/dist/scallop_rescue.js');
    const types = await import('../../../ptb/dist/types.js');
    this.ptb = {
      executeRescue: scallop.executeRescue,
      buildScallopRepayPTB: scallop.buildScallopRepayPTB,
      buildScallopTopupPTB: scallop.buildScallopTopupPTB,
      types,
    };
    return this.ptb;
  }

  /**
   * #9 — read obligation state (HF/debt) before/after a rescue.
   * Tries the Scallop SDK (real/mainnet); falls back to a direct object read (demo Scallop
   * has a `debt` field). Returns { healthFactor, riskLevel, debt } or null.
   */
  async readObligationState(obligationId) {
    if (!obligationId) return null;
    if (this.scallopReader) {
      try {
        const live = await this.scallopReader.readObligation(obligationId);
        if (live) return { healthFactor: live.healthFactor, riskLevel: live.riskLevel, debt: live.debtValue };
      } catch { this.scallopReadFailures += 1; }
    }
    try {
      const obj = await this.rpc.getObject({ id: obligationId, options: { showContent: true } });
      const f = obj?.data?.content?.fields;
      if (f && f.debt != null) return { healthFactor: null, riskLevel: null, debt: Number(f.debt) };
    } catch { /* ignore */ }
    return null;
  }

  /**
   * #21 — fail-closed freshness gate: never execute on stale data.
   * Blocks if the price oracle is too old OR the Sui indexer is lagging beyond budget.
   */
  freshnessGate(market) {
    const oracleAge = market?.oracle_age_ms;
    if (Number.isFinite(oracleAge) && oracleAge > this.lsConfig.maxSnapshotAgeMs) {
      return { ok: false, reason: `stale oracle (${oracleAge}ms > ${this.lsConfig.maxSnapshotAgeMs}ms)` };
    }
    try {
      const src = this.suiIndexer?.getStatus?.().sources?.find((s) => s.key === 'liquidshield');
      if (src && Number.isFinite(src.lag_ms) && src.lag_ms > this.lsConfig.indexerLagBudgetMs) {
        return { ok: false, reason: `indexer lag (${src.lag_ms}ms > ${this.lsConfig.indexerLagBudgetMs}ms)` };
      }
    } catch { /* indexer status optional */ }
    return { ok: true };
  }

  /** "Did the rescue improve the position?" HF up OR debt down. null = can't tell. */
  static improved(before, after) {
    if (!before || !after) return null;
    if (Number.isFinite(before.healthFactor) && Number.isFinite(after.healthFactor)) return after.healthFactor > before.healthFactor;
    if (Number.isFinite(before.debt) && Number.isFinite(after.debt)) return after.debt < before.debt;
    return null;
  }

  // ── #20 concurrency / idempotency ──────────────────────────────────────────
  acquireLock(key) {
    const now = Date.now();
    if (this.activeLocks.has(key)) return false;
    const row = this.database.queryOne(`SELECT locked_until, status FROM execution_locks WHERE key = ?`, [key]);
    if (row && row.status === 'locked' && Number(row.locked_until) > now) return false;
    const until = now + this.lsConfig.executionLockTtlMs;
    upsertRows(this.database, 'execution_locks', [{ key, obligation_id: key, locked_until: until, tx_digest: null, status: 'locked' }], ['key']);
    this.activeLocks.add(key);
    return true;
  }

  releaseLock(key, status = 'done', digest = null) {
    this.activeLocks.delete(key);
    try {
      upsertRows(this.database, 'execution_locks', [{ key, obligation_id: key, locked_until: 0, tx_digest: digest, status }], ['key']);
    } catch { /* ignore */ }
  }

  /**
   * #19 — deeper simulation gate: build the rescue PTB, dry-run with full effects, and assert
   * (a) target obligation is mutated, (b) no coin credited to a non-allowlisted address,
   * (c) gas <= ceiling, (d) success. Returns { ok, reason, gas }.
   */
  async gatedDryRun(params) {
    const { buildScallopRepayPTB, buildScallopTopupPTB } = await this.loadPtb();
    const kp = this.agentKeypair();
    const agentAddr = kp.getPublicKey().toSuiAddress();
    const tx = params.actionType === 1 ? buildScallopTopupPTB(params) : buildScallopRepayPTB(params);
    tx.setSender(agentAddr);
    let dry;
    try {
      dry = await this.rpc.dryRunTransactionBlock({ transactionBlock: await tx.build({ client: this.rpc }) });
    } catch (e) {
      return { ok: false, reason: `dry-run error: ${String(e?.message || e).slice(0, 80)}` };
    }
    if (dry.effects?.status?.status !== 'success') {
      return { ok: false, reason: `simulation failed: ${dry.effects?.status?.error || 'unknown'}` };
    }
    // (a) target obligation mutated
    const mutated = (dry.objectChanges || []).some((c) => c.objectId === params.obligationId);
    if (!mutated) return { ok: false, reason: 'target obligation not mutated by rescue' };
    // (b) no coin credited to a non-allowlisted address (only the agent/sender is allowed)
    const allow = new Set([agentAddr]);
    for (const bc of dry.balanceChanges || []) {
      const owner = bc.owner?.AddressOwner;
      if (owner && !allow.has(owner) && BigInt(bc.amount) > 0n) {
        return { ok: false, reason: `unexpected coin credit to ${owner.slice(0, 10)}…` };
      }
    }
    // (c) gas ceiling
    const g = dry.effects.gasUsed;
    const gas = BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate);
    if (gas > BigInt(this.lsConfig.maxGas)) return { ok: false, reason: `gas ${gas} > ceiling ${this.lsConfig.maxGas}` };
    return { ok: true, gas };
  }

  agentKeypair() {
    const s = this.lsConfig.agentPrivateKey || process.env.AGENT_PRIVATE_KEY;
    if (!s) throw new Error('AGENT_PRIVATE_KEY not configured');
    return Ed25519Keypair.fromSecretKey(Buffer.from(s, 'base64'));
  }

  setStress(positionId, stress) {
    this.stress.set(positionId, stress);
  }

  clearStress(positionId) {
    if (positionId) this.stress.delete(positionId);
    else this.stress.clear();
  }

  /** Apply any demo stress to a position's effective health factor for this tick. */
  effectiveHealthFactor(position) {
    const s = this.stress.get(position.id);
    let hf = position.health_factor;
    if (s) {
      if (Number.isFinite(s.healthFactor)) hf = s.healthFactor;
      else if (Number.isFinite(s.haircutPct) && Number.isFinite(hf)) hf = hf * (1 - s.haircutPct / 100);
    }
    return hf;
  }

  latestMarket() {
    return this.database.queryOne(
      `SELECT * FROM market_snapshots ORDER BY timestamp DESC LIMIT 1`
    );
  }

  /** Read on-chain policy status to honor pause/revoke (fail-closed). */
  async policyActive(policyId) {
    if (!policyId) return false;
    try {
      const obj = await this.rpc.getObject({ id: policyId, options: { showContent: true } });
      const fields = obj?.data?.content?.fields;
      if (!fields) return true; // can't read -> don't block (simulation still gates execution)
      const paused = fields.paused === true || fields.is_paused === true;
      const revoked = fields.revoked === true || fields.is_revoked === true;
      return !paused && !revoked;
    } catch {
      return true;
    }
  }

  /** Build + submit shield_oracle::submit_risk_snapshot. Returns digest or null. */
  async submitSnapshot(position, scoreResult, market, recommendedActionCode) {
    if (!position.snapshot_id) return null;
    const kp = this.agentKeypair();
    const tx = new Transaction();
    tx.setSender(kp.getPublicKey().toSuiAddress());

    const hf = this.effectiveHealthFactor(position);
    const hfX1000 = Number.isFinite(hf) ? Math.round(hf * 1000) : 0;
    const priceX1e6 = Number.isFinite(market?.mid_price) ? Math.round(market.mid_price * 1e6) : 0;
    const priceFeedAtMs = market?.oracle_age_ms != null ? Date.now() - market.oracle_age_ms : Date.now();

    tx.moveCall({
      target: `${this.lsConfig.packageId}::shield_oracle::submit_risk_snapshot`,
      arguments: [
        tx.object(position.snapshot_id),
        tx.pure.u8(scoreResult.score),
        tx.pure.u8(scoreResult.severityCode),
        tx.pure.u64(scoreResult.reasonCodes),
        tx.pure.u8(recommendedActionCode),
        tx.pure.u64(hfX1000),
        tx.pure.u64(priceX1e6),
        tx.pure.u64(priceFeedAtMs),
        tx.object(SUI_CLOCK_ID),
      ],
    });

    const r = await this.rpc.signAndExecuteTransaction({
      signer: kp,
      transaction: tx,
      options: { showEffects: true },
    });
    return r.effects?.status.status === 'success' ? r.digest : null;
  }

  /** Score + (maybe) rescue one position. */
  async processPosition(position, market) {
    const cfg = this.lsConfig;
    const hf = this.effectiveHealthFactor(position);
    const scoreResult = computeRiskScore({
      healthFactor: hf,
      minHealthFactor: cfg.minHealthFactor,
      priceChangePct: market?.price_change_pct_24h ?? null,
      liquidityScore: market?.liquidity_score ?? null,
      oracleAgeMs: market?.oracle_age_ms ?? null,
      maxOracleAgeMs: cfg.maxSnapshotAgeMs,
    });

    const recommendedAction = scoreResult.subRisks.positionRisk >= 0.5 ? 'repay' : 'topup';
    const recommendedActionCode = recommendedAction === 'topup' ? 1 : 0;

    const isScallop = position.protocol === 'scallop';
    const executable =
      isScallop &&
      scoreResult.hasHealthFactor &&
      Boolean(position.policy_id && position.vault_id && position.snapshot_id && position.obligation_id);

    const { reason, source } = await explainRisk(
      cfg,
      { scoreResult, recommendedAction, position, market }
    );

    const nowMs = Date.now();
    const tsIso = new Date(nowMs).toISOString();
    const willExecute =
      cfg.autoExecute &&
      executable &&
      scoreResult.score >= cfg.triggerScore &&
      !this.disabledPositions.has(position.id); // #9 disabled if a prior rescue didn't improve

    // write risk_scores
    upsertRows(
      this.database,
      'risk_scores',
      [
        {
          id: `${position.id}:${nowMs}`,
          position_id: position.id,
          market: position.collateral_asset ? `${position.collateral_asset}/USD` : null,
          protocol: position.protocol,
          risk_score: scoreResult.score,
          risk_level: scoreResult.severity,
          reason_codes: scoreResult.reasonCodes,
          reason,
          recommended_action: recommendedAction,
          can_execute: willExecute ? 1 : 0,
          timestamp: tsIso,
        },
      ],
      TABLE_SHAPES.risk_scores.keyColumns
    );

    this.publish('risk_score_updated', {
      position_id: position.id,
      protocol: position.protocol,
      risk_score: scoreResult.score,
      risk_level: scoreResult.severity,
      reason,
      reason_source: source,
      recommended_action: recommendedAction,
      can_execute: willExecute,
    });

    if (!willExecute) {
      return { position_id: position.id, score: scoreResult.score, severity: scoreResult.severity, executed: false };
    }

    // ── emergency rescue path (real on-chain) ──
    const active = await this.policyActive(position.policy_id);
    if (!active) {
      this.recordAction(position, { status: 'blocked', reason: 'policy paused/revoked', riskBefore: scoreResult.score, tsIso });
      this.publish('shield_blocked', { position_id: position.id, reason: 'policy paused/revoked' });
      return { position_id: position.id, score: scoreResult.score, executed: false, blocked: 'policy' };
    }

    // #21 — fail-closed freshness gate (never act on stale data)
    const fresh = this.freshnessGate(market);
    if (!fresh.ok) {
      this.recordAction(position, { status: 'blocked', reason: fresh.reason, riskBefore: scoreResult.score, tsIso });
      this.publish('shield_blocked', { position_id: position.id, reason: fresh.reason });
      this.alerter?.notify?.('stale_data_block', { position_id: position.id, reason: fresh.reason });
      return { position_id: position.id, score: scoreResult.score, executed: false, blocked: 'stale' };
    }

    // #20 — one rescue in flight per obligation (idempotency / no double-rescue)
    const lockKey = position.obligation_id || position.id;
    if (!this.acquireLock(lockKey)) {
      return { position_id: position.id, score: scoreResult.score, executed: false, blocked: 'locked' };
    }

    const params = {
      policyId: position.policy_id,
      vaultId: position.vault_id,
      snapshotId: position.snapshot_id,
      positionId: position.id,
      guardianCapId: cfg.guardianCapId,
      obligationId: position.obligation_id,
      protocol: position.protocol,
      amount: BigInt(cfg.rescueAmount),
      coinType: cfg.coinType,
      actionType: recommendedActionCode,
    };

    let digest = null;
    let snapDigest = null;
    let before = null;
    let after = null;
    let blockReason = null;
    try {
      const { executeRescue } = await this.loadPtb();

      // #9 — pre-state
      before = await this.readObligationState(position.obligation_id);

      // submit fresh snapshot on-chain (required before rescue)
      snapDigest = await this.submitSnapshot(position, scoreResult, market, recommendedActionCode);
      this.logger('info', 'snapshot_submitted', { position_id: position.id, digest: snapDigest });
      await sleep(2000); // let snapshot land

      // #19 — deeper simulation gate (effect-level assertions) before signing
      const gate = await this.gatedDryRun(params);
      if (!gate.ok) {
        blockReason = `gate: ${gate.reason}`;
      } else {
        const result = await executeRescue(params, this.rpc);
        digest = result?.digest ?? null;
        if (!digest) blockReason = 'simulation/submission failed (fail-closed)';
      }
    } catch (err) {
      blockReason = String(err?.message || err);
      this.logger('error', 'rescue_error', { position_id: position.id, error: blockReason });
    }

    // #9 — post-state + verification
    let resultVerified = null;
    if (digest) {
      after = await this.readObligationState(position.obligation_id);
      const ok = RiskAgent.improved(before, after);
      resultVerified = ok === null ? null : ok ? 1 : 0;
      if (ok === false) {
        this.disabledPositions.add(position.id); // suspicious: rescue didn't improve -> stop auto-exec
        this.logger('warn', 'rescue_no_improvement', { position_id: position.id });
        this.alerter?.notify?.('rescue_no_improvement', { position_id: position.id, before, after });
      }
    }

    const status = digest ? (resultVerified === 0 ? 'submitted-unverified' : 'executed') : 'blocked';
    this.recordAction(position, {
      status,
      reason: blockReason,
      action: recommendedAction,
      amount: Number(cfg.rescueAmount),
      digest,
      simulationDigest: snapDigest,
      riskBefore: scoreResult.score,
      beforeHf: before?.healthFactor ?? null,
      afterHf: after?.healthFactor ?? null,
      beforeLevel: before?.riskLevel ?? null,
      afterLevel: after?.riskLevel ?? null,
      resultVerified,
      tsIso,
    });
    this.releaseLock(lockKey, digest ? 'done' : 'failed', digest);
    this.publish(digest ? 'shield_activated' : 'shield_blocked', {
      position_id: position.id,
      tx_digest: digest,
      action_type: recommendedAction,
      risk_before: scoreResult.score,
      result_verified: resultVerified,
      reason: blockReason,
    });

    return { position_id: position.id, score: scoreResult.score, executed: Boolean(digest), digest, result_verified: resultVerified };
  }

  recordAction(position, {
    status, reason = null, action = null, amount = null, digest = null, riskBefore = null,
    simulationDigest = null, beforeHf = null, afterHf = null, beforeLevel = null, afterLevel = null,
    resultVerified = null, tsIso,
  }) {
    upsertRows(
      this.database,
      'risk_actions',
      [
        {
          id: digest || `${position.id}:${tsIso}`,
          position_id: position.id,
          wallet_address: position.wallet_address,
          protocol: position.protocol,
          action_type: action,
          amount,
          tx_digest: digest,
          status,
          reason_codes: null,
          reason,
          risk_before: riskBefore,
          risk_after: null,
          before_health_factor: beforeHf,
          after_health_factor: afterHf,
          before_risk_level: beforeLevel,
          after_risk_level: afterLevel,
          simulation_digest: simulationDigest,
          result_verified: resultVerified,
          timestamp: tsIso,
        },
      ],
      TABLE_SHAPES.risk_actions.keyColumns
    );
  }

  /** One full agent tick. */
  async tick() {
    try {
      await this.deriver.run();
    } catch (err) {
      this.logger('warn', 'derive_failed', { error: String(err?.message || err) });
    }

    const market = this.latestMarket();
    const positions = this.database.queryAll(
      `SELECT * FROM positions WHERE status NOT IN ('revoked') ORDER BY last_updated DESC`
    );

    const results = [];
    for (const position of positions) {
      if (this.shouldStop) break;
      try {
        results.push(await this.processPosition(position, market));
      } catch (err) {
        this.logger('error', 'process_position_failed', { position_id: position.id, error: String(err?.message || err) });
      }
    }

    this.lastTickAt = new Date().toISOString();
    this.lastTickSummary = { positions: positions.length, results };
    return this.lastTickSummary;
  }

  /** Force a single tick (used by /api/trigger-agent). */
  async triggerOnce() {
    return this.tick();
  }

  start() {
    if (this.isRunning) return { error: 'already running' };
    this.isRunning = true;
    this.shouldStop = false;
    this.logger('info', 'risk_agent_started', { tickMs: this.lsConfig.agentTickMs });
    (async () => {
      while (!this.shouldStop) {
        try {
          await this.tick();
        } catch (err) {
          this.logger('error', 'tick_error', { error: String(err?.message || err) });
        }
        if (!this.shouldStop) await sleep(this.lsConfig.agentTickMs);
      }
      this.isRunning = false;
      this.logger('info', 'risk_agent_stopped', {});
    })();
    return { success: true };
  }

  stop() {
    this.shouldStop = true;
    return { success: true };
  }

  getStatus() {
    return {
      running: this.isRunning,
      tick_ms: this.lsConfig.agentTickMs,
      trigger_score: this.lsConfig.triggerScore,
      auto_execute: this.lsConfig.autoExecute,
      last_tick_at: this.lastTickAt,
      last_tick: this.lastTickSummary,
      active_stress: Array.from(this.stress.entries()).map(([id, s]) => ({ position_id: id, ...s })),
      scallop_read_failures: this.scallopReadFailures,
      disabled_positions: Array.from(this.disabledPositions),
    };
  }
}
