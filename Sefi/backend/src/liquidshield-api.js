/**
 * liquifi REST API + bootstrap.
 *
 * bootstrapLiquifi(): wires the Sui plane (SuiClient -> SuiIndexer -> deriver -> RiskAgent)
 * onto SeFi's existing database + realtimeHub, starts the indexer + agent loops, and
 * returns a ctx. registerLiquidShieldRoutes(): mounts the frontend-facing /api/* endpoints.
 *
 * Mounted under /api/* (SeFi's own API lives under /api/v1, so no collision).
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiClient as SuiRpcClient } from '@mysten/sui/client';

import { createLiquifiConfig, liquifiReadiness } from './liquidshield-config.js';
import { SuiClient } from './sui-client.js';
import { SuiIndexer } from './sui-indexer.js';
import { ScallopReader } from './scallop-reader.js';
import { ScallopDeriver } from './scallop-deriver.js';
import { ScallopDiscovery } from './scallop-discovery.js';
import { ScallopReconciler } from './scallop-reconciler.js';
import { LiquidShieldDeriver } from './liquidshield-deriver.js';
import { RiskAgent } from './risk-agent.js';

const SUI_CLOCK_ID = '0x6';

function asyncRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      res.status(500).json({ error: { code: 'LIQUIFI_ERROR', message: String(err?.message || err) } });
    }
  };
}

function intParam(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Start the liquifi Sui plane. Non-fatal: logs and returns ctx with whatever started.
 * @returns {Promise<object>} ctx
 */
export async function bootstrapLiquifi({ database, realtimeHub, logger = () => {} }) {
  const lsConfig = createLiquifiConfig();
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const manifestPath = join(__dirname, '..', '..', 'contracts', 'manifests', 'liquidshield.testnet.manifest.json');

  const suiClient = new SuiClient({ url: lsConfig.suiGraphqlUrl });
  const suiIndexer = new SuiIndexer({ client: suiClient, database, lsConfig, manifestPath, logger });
  // Forward indexed Sui events to the realtime 'index' channel.
  suiIndexer.onEvent((name, data) => {
    try {
      realtimeHub?.publish('index', String(name || 'sui_event'), data || {});
    } catch {
      /* ignore */
    }
  });

  const scallopReader = new ScallopReader(lsConfig);
  const scallopDiscovery = new ScallopDiscovery(lsConfig);
  const deriver = new LiquidShieldDeriver({ database, lsConfig, scallopReader, logger });
  const scallopDeriver = new ScallopDeriver({ database, logger });
  const scallopReconciler = new ScallopReconciler({ database, scallopReader, lsConfig, logger });
  const riskAgent = new RiskAgent({ database, lsConfig, deriver, scallopReader, realtimeHub, logger });

  // Start loops (don't block server startup on a slow first poll).
  suiIndexer.start().catch((e) => logger('warn', 'sui_indexer_start_failed', { error: String(e?.message || e) }));
  riskAgent.start();
  // Typed Scallop semantic indexing: decode new raw Scallop events into typed tables every cycle.
  const scallopDeriveTimer = setInterval(() => {
    try { scallopDeriver.run(); } catch (e) { logger('warn', 'scallop_derive_failed', { error: String(e?.message || e) }); }
  }, lsConfig.indexPollMs);
  scallopDeriveTimer.unref?.();
  // Live protocol-state reconciliation (#14): SDK reads -> trusted obligation snapshots.
  const reconcileTimer = setInterval(() => {
    scallopReconciler.run().catch((e) => logger('warn', 'reconcile_loop_failed', { error: String(e?.message || e) }));
  }, Math.max(lsConfig.indexPollMs * 3, 30_000));
  reconcileTimer.unref?.();

  const readiness = liquifiReadiness(lsConfig);
  logger('info', 'liquifi_bootstrapped', { ready: readiness.ready, missing: readiness.missing });

  return { lsConfig, suiClient, suiIndexer, scallopReader, scallopDiscovery, deriver, scallopDeriver, scallopReconciler, riskAgent, database, realtimeHub };
}

/** Mount the frontend-facing /api/* routes. */
export function registerLiquidShieldRoutes(app, ctx) {
  const { database, lsConfig, suiIndexer, riskAgent, realtimeHub, scallopDiscovery } = ctx;

  // ── GET /api/scallop/positions?owner=0x… — wallet-based obligation discovery (#1) ──
  app.get('/api/scallop/positions', asyncRoute(async (req, res) => {
    const owner = String(req.query.owner || '').trim();
    if (!owner.startsWith('0x')) {
      return res.status(400).json({ error: { code: 'BAD_OWNER', message: 'owner query param (0x…) required' } });
    }
    const positions = await scallopDiscovery.discoverScallopObligations(owner);
    res.json({ owner, count: positions.length, positions });
  }));

  const latestMarket = () =>
    database.queryOne(`SELECT * FROM market_snapshots ORDER BY timestamp DESC LIMIT 1`);

  // Latest risk score per position.
  const latestScores = () =>
    database.queryAll(`
      SELECT rs.* FROM risk_scores rs
      JOIN (SELECT position_id, MAX(timestamp) AS ts FROM risk_scores GROUP BY position_id) m
        ON rs.position_id = m.position_id AND rs.timestamp = m.ts
    `);

  // ── GET /api/positions ──────────────────────────────────────────────────────
  app.get('/api/positions', asyncRoute(async (_req, res) => {
    res.json({ positions: database.queryAll(`SELECT * FROM positions ORDER BY last_updated DESC`) });
  }));

  // ── GET /api/risk-scores ────────────────────────────────────────────────────
  app.get('/api/risk-scores', asyncRoute(async (req, res) => {
    const limit = intParam(req.query.limit, 50, 1, 500);
    const all = req.query.all === 'true';
    res.json({
      risk_scores: all
        ? database.queryAll(`SELECT * FROM risk_scores ORDER BY timestamp DESC LIMIT ?`, [limit])
        : latestScores(),
    });
  }));

  // ── GET /api/actions ────────────────────────────────────────────────────────
  app.get('/api/actions', asyncRoute(async (req, res) => {
    const limit = intParam(req.query.limit, 50, 1, 500);
    res.json({
      actions: database.queryAll(`SELECT * FROM risk_actions ORDER BY timestamp DESC LIMIT ?`, [limit]),
    });
  }));

  // ── GET /api/events (raw indexed events feed) ────────────────────────────────
  app.get('/api/events', asyncRoute(async (req, res) => {
    const limit = intParam(req.query.limit, 50, 1, 500);
    res.json({
      events: database.queryAll(
        `SELECT contract_id, tx_hash, event_name, data, timestamp FROM contract_logs ORDER BY timestamp DESC LIMIT ?`,
        [limit]
      ),
    });
  }));

  // ── GET /api/dashboard (aggregate) ───────────────────────────────────────────
  app.get('/api/dashboard', asyncRoute(async (_req, res) => {
    const readiness = liquifiReadiness(lsConfig);
    res.json({
      positions: database.queryAll(`SELECT * FROM positions ORDER BY last_updated DESC`),
      risk_scores: latestScores(),
      recent_actions: database.queryAll(`SELECT * FROM risk_actions ORDER BY timestamp DESC LIMIT 20`),
      market_snapshot: latestMarket(),
      indexer: suiIndexer.getStatus(),
      agent: riskAgent.getStatus(),
      readiness, // { ready, missing[] } — demo-readiness at a glance
    });
  }));

  // ── POST /api/register-protection ─────────────────────────────────────────────
  // Re-derives positions (picks up new ProtectionRegisteredEvents) and returns them.
  // Full onboarding (object creation) is Person 1's ptb/onboard_user.ts.
  app.post('/api/register-protection', asyncRoute(async (_req, res) => {
    const written = await ctx.deriver.refreshPositions();
    res.json({ refreshed: written, positions: database.queryAll(`SELECT * FROM positions`) });
  }));

  // ── POST /api/simulate-shock ──────────────────────────────────────────────────
  // REAL demo tooling: stresses the TRIGGER (collateral price haircut OR absolute HF)
  // for the target position, then forces an immediate agent tick. The rescue PTB that
  // fires is fully real on-chain.
  app.post('/api/simulate-shock', asyncRoute(async (req, res) => {
    const body = req.body || {};
    const positionId = body.positionId || req.query.positionId || lsConfig.positionId;
    if (!positionId) {
      return res.status(400).json({ error: { code: 'NO_POSITION', message: 'positionId required (or set POSITION_ID)' } });
    }
    const haircutPct = body.haircutPct != null ? Number(body.haircutPct) : (req.query.haircutPct != null ? Number(req.query.haircutPct) : undefined);
    const healthFactor = body.healthFactor != null ? Number(body.healthFactor) : (req.query.healthFactor != null ? Number(req.query.healthFactor) : undefined);

    const stress = {};
    if (Number.isFinite(healthFactor)) stress.healthFactor = healthFactor;
    else if (Number.isFinite(haircutPct)) stress.haircutPct = haircutPct;
    else stress.healthFactor = 0.9; // sensible default that triggers emergency

    riskAgent.setStress(positionId, stress);
    realtimeHub?.publish('index', 'shock_applied', { position_id: positionId, ...stress });
    const summary = await riskAgent.triggerOnce();
    const score = database.queryOne(
      `SELECT * FROM risk_scores WHERE position_id = ? ORDER BY timestamp DESC LIMIT 1`,
      [positionId]
    );
    res.json({ applied: { position_id: positionId, ...stress }, tick: summary, latest_score: score });
  }));

  // ── POST /api/trigger-agent ───────────────────────────────────────────────────
  app.post('/api/trigger-agent', asyncRoute(async (_req, res) => {
    const summary = await riskAgent.triggerOnce();
    res.json({ tick: summary });
  }));

  // ── Sui indexer control (replaces the Hedera "Full Sync") ──────────────────────
  // The Sui indexer auto-polls, but this lets the UI force an immediate sync.
  app.post('/api/sui/sync', asyncRoute(async (_req, res) => {
    const t0 = Date.now();
    const inserted = await suiIndexer.pollOnce();
    const durationMs = Date.now() - t0;
    const status = suiIndexer.getStatus();
    res.json({ inserted, duration_ms: durationMs, events_total: status.events_total, status });
  }));
  app.get('/api/sui/status', asyncRoute(async (_req, res) => {
    res.json(suiIndexer.getStatus());
  }));

  // ── POST /api/override (real on-chain DAO pause/unpause/revoke) ────────────────
  app.post('/api/override', asyncRoute(async (req, res) => {
    const body = req.body || {};
    const action = String(body.action || req.query.action || 'pause').toLowerCase(); // pause|unpause|revoke
    const policyId = body.policyId || lsConfig.riskPolicyId;
    const daoCapId = lsConfig.daoOverrideCapId;
    const signerKey = lsConfig.userPrivateKey || process.env.USER_PRIVATE_KEY;

    if (!policyId) return res.status(400).json({ error: { code: 'NO_POLICY', message: 'RISK_POLICY_ID not set' } });
    if (!daoCapId) return res.status(400).json({ error: { code: 'NO_DAO_CAP', message: 'DAO_OVERRIDE_CAP_ID not set' } });
    if (!signerKey) {
      return res.status(400).json({ error: { code: 'NO_SIGNER', message: 'USER_PRIVATE_KEY (DAO cap holder) required to sign override' } });
    }
    const fn = { pause: 'dao_pause', unpause: 'dao_unpause', revoke: 'dao_revoke' }[action];
    if (!fn) return res.status(400).json({ error: { code: 'BAD_ACTION', message: 'action must be pause|unpause|revoke' } });

    const rpc = new SuiRpcClient({ url: lsConfig.suiRpcUrl });
    const kp = Ed25519Keypair.fromSecretKey(Buffer.from(signerKey, 'base64'));
    const tx = new Transaction();
    tx.setSender(kp.getPublicKey().toSuiAddress());
    tx.moveCall({
      target: `${lsConfig.packageId}::risk_policy::${fn}`,
      arguments: [tx.object(policyId), tx.object(daoCapId)],
    });
    const r = await rpc.signAndExecuteTransaction({ signer: kp, transaction: tx, options: { showEffects: true } });
    const ok = r.effects?.status.status === 'success';
    realtimeHub?.publish('index', 'override_executed', { action, policy_id: policyId, digest: r.digest, ok });
    res.json({ action, policy_id: policyId, digest: r.digest, status: r.effects?.status.status });
  }));
}
