/**
 * liquifi deriver: turns raw indexed events (contract_logs) + live reads into the
 * 4 semantic tables the agent/frontend consume.
 *
 *   positions        <- ProtectionRegisteredEvent + Scallop obligation read (live)
 *   market_snapshots <- Pyth Hermes + DeepBook indexer (live)
 *   risk_actions     <- ShieldActivatedEvent / ShieldBlockedEvent (on-chain audit trail)
 *   risk_scores      <- written by the risk agent (Phase 3), not here
 *
 * Reuses ensureTable/upsertRows (liquidshield-tables.js). risk_scores is created here
 * so the agent can write to it immediately.
 */

import { ensureAllTables, upsertRows, TABLE_SHAPES } from './liquidshield-tables.js';
import { decodeByteVector } from './sui-events.js';
import { buildMarketSnapshot } from './market-data.js';

const LS = '0x1a4bc48f7c7cff2bcada2189e3b9c9686c866579629d06af99278370e41f0ecf';

function parseJsonSafe(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export class LiquidShieldDeriver {
  /**
   * @param {object} opts
   * @param {object} opts.database
   * @param {object} opts.lsConfig
   * @param {import('./scallop-reader.js').ScallopReader} opts.scallopReader
   * @param {function} [opts.logger]
   */
  constructor({ database, lsConfig, scallopReader, logger = () => {} }) {
    this.database = database;
    this.lsConfig = lsConfig;
    this.scallopReader = scallopReader;
    this.logger = logger;
    ensureAllTables(database);
  }

  /** All raw rows for a given short event name (across both Scallop & LiquidShield packages). */
  rawEvents(eventName) {
    return this.database.queryAll(
      `SELECT contract_id, tx_hash, event_name, data, timestamp
         FROM contract_logs WHERE event_name = ? ORDER BY timestamp ASC`,
      [eventName]
    );
  }

  /**
   * Rebuild `positions` from registration events, enriching Scallop ones with a live
   * obligation read. The per-position object ids (policy/vault/snapshot) are attached
   * from config for the demo's protected position.
   */
  async refreshPositions() {
    const cfg = this.lsConfig;
    const regs = this.rawEvents('shield_registry::ProtectionRegisteredEvent');
    let written = 0;

    for (const ev of regs) {
      const j = parseJsonSafe(ev.data);
      if (!j) continue;

      const positionId = j.position_id;
      const protocol = decodeByteVector(j.protocol) || 'scallop';
      const obligationId = j.obligation_id || '';
      const collateralAsset = decodeByteVector(j.collateral_asset) || cfg.collateralAsset;
      const debtAsset = decodeByteVector(j.debt_asset) || cfg.debtAsset;
      const isThisDemoPosition = positionId === cfg.positionId;

      let collateralValue = null;
      let debtValue = null;
      let healthFactor = null;
      let riskLevel = protocol === 'navi' ? 'monitoring' : 'unknown';
      let status = protocol === 'navi' ? 'monitoring-only' : 'protected';

      if (protocol === 'scallop' && obligationId) {
        const read = await this.scallopReader.readObligation(obligationId);
        if (read) {
          collateralValue = read.collateralValue;
          debtValue = read.debtValue;
          healthFactor = read.healthFactor;
          riskLevel = read.riskLevel;
        }
      }

      const row = {
        id: positionId,
        wallet_address: j.owner || null,
        protocol,
        obligation_id: obligationId,
        collateral_asset: collateralAsset,
        debt_asset: debtAsset,
        collateral_value: collateralValue,
        debt_value: debtValue,
        health_factor: healthFactor,
        risk_level: riskLevel,
        status,
        policy_id: isThisDemoPosition ? cfg.riskPolicyId || null : null,
        vault_id: isThisDemoPosition ? cfg.vaultId || null : null,
        snapshot_id: isThisDemoPosition ? cfg.snapshotId || null : null,
        last_updated: new Date().toISOString(),
      };
      written += upsertRows(this.database, 'positions', [row], TABLE_SHAPES.positions.keyColumns);
    }
    return written;
  }

  /** Append one real market snapshot (Pyth + DeepBook). Returns the row or null. */
  async refreshMarket() {
    const row = await buildMarketSnapshot(this.lsConfig);
    if (!row) {
      this.logger('warn', 'market_snapshot_unavailable', {});
      return null;
    }
    upsertRows(this.database, 'market_snapshots', [row], TABLE_SHAPES.market_snapshots.keyColumns);
    return row;
  }

  /** Mirror on-chain ShieldActivated/ShieldBlocked events into risk_actions (audit trail). */
  syncActionsFromEvents() {
    const activated = this.rawEvents('shield_executor::ShieldActivatedEvent');
    const blocked = this.rawEvents('shield_executor::ShieldBlockedEvent');
    const rows = [];

    for (const ev of activated) {
      const j = parseJsonSafe(ev.data);
      if (!j) continue;
      rows.push({
        id: ev.tx_hash || `${j.position_id}:${ev.timestamp}`,
        position_id: j.position_id || null,
        wallet_address: j.executor || null,
        protocol: decodeByteVector(j.protocol) || 'scallop',
        action_type: Number(j.action_type) === 1 ? 'topup' : 'repay',
        amount: j.amount_used != null ? Number(j.amount_used) : null,
        tx_digest: ev.tx_hash || null,
        status: 'executed',
        reason_codes: j.reason_codes != null ? Number(j.reason_codes) : null,
        reason: null,
        risk_before: j.risk_score_before != null ? Number(j.risk_score_before) : null,
        risk_after: null,
        timestamp: ev.timestamp,
      });
    }

    for (const ev of blocked) {
      const j = parseJsonSafe(ev.data);
      if (!j) continue;
      rows.push({
        id: ev.tx_hash || `${j.position_id}:${ev.timestamp}`,
        position_id: j.position_id || null,
        wallet_address: null,
        protocol: decodeByteVector(j.protocol) || 'scallop',
        action_type: null,
        amount: j.amount != null ? Number(j.amount) : null,
        tx_digest: ev.tx_hash || null,
        status: 'blocked',
        reason_codes: null,
        reason: typeof j.reason === 'string' ? j.reason : decodeByteVector(j.reason) || null,
        risk_before: null,
        risk_after: null,
        timestamp: ev.timestamp,
      });
    }

    if (rows.length === 0) return 0;
    return upsertRows(this.database, 'risk_actions', rows, TABLE_SHAPES.risk_actions.keyColumns);
  }

  /** One full derive cycle. */
  async run() {
    const positions = await this.refreshPositions();
    const market = await this.refreshMarket();
    const actions = this.syncActionsFromEvents();
    return { positions, market: market ? 1 : 0, actions };
  }
}
