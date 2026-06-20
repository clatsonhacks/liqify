/**
 * Scallop protocol-state reconciliation (#14).
 *
 * Event indexing alone drifts (interest accrual, price moves, oracle updates). This reads
 * LIVE obligation state via the Scallop SDK and writes trusted snapshots — so execution
 * always uses the live/SDK read, never event-derived debt.
 *
 *   scallop_obligations           — latest reconciled state per obligation
 *   scallop_obligation_snapshots  — append-only history (with reconciliation flags)
 *
 * Obligations to reconcile = registered/protected obligations (from positions) + any
 * obligation seen in the typed Scallop event tables (globally watched).
 */

import { upsertRows, ensureTable, TABLE_SHAPES } from './liquidshield-tables.js';

export class ScallopReconciler {
  /**
   * @param {object} opts
   * @param {object} opts.database
   * @param {import('./scallop-reader.js').ScallopReader} opts.scallopReader
   * @param {object} opts.lsConfig
   * @param {function} [opts.logger]
   */
  constructor({ database, scallopReader, lsConfig, logger = () => {} }) {
    this.database = database;
    this.scallopReader = scallopReader;
    this.lsConfig = lsConfig;
    this.logger = logger;
    ensureTable(database, 'scallop_obligations', TABLE_SHAPES.scallop_obligations.columns, TABLE_SHAPES.scallop_obligations.keyColumns);
    ensureTable(database, 'scallop_obligation_snapshots', TABLE_SHAPES.scallop_obligation_snapshots.columns, TABLE_SHAPES.scallop_obligation_snapshots.keyColumns);
  }

  /** Obligation ids worth reconciling: protected positions + obligations seen in events. */
  obligationsToReconcile(limit = 50) {
    const ids = new Set();
    // protected positions (highest priority)
    for (const r of this.database.queryAll(`SELECT DISTINCT obligation_id FROM positions WHERE obligation_id IS NOT NULL AND protocol = 'scallop'`)) {
      if (r.obligation_id) ids.add(r.obligation_id);
    }
    // globally watched obligations from typed event tables (most recent activity)
    const watched = this.database.queryAll(
      `SELECT obligation_id, MAX(timestamp) AS ts FROM (
         SELECT obligation_id, timestamp FROM scallop_borrow_events
         UNION ALL SELECT obligation_id, timestamp FROM scallop_repay_events
         UNION ALL SELECT obligation_id, timestamp FROM scallop_collateral_withdraw_events
       ) WHERE obligation_id IS NOT NULL GROUP BY obligation_id ORDER BY ts DESC LIMIT ?`,
      [limit]
    );
    for (const r of watched) if (r.obligation_id) ids.add(r.obligation_id);
    return [...ids];
  }

  /** Reconcile one obligation: live SDK read -> snapshot + latest. Returns the snapshot or null. */
  async reconcileOne(obligationId, { eventDerivedDebtUsd = null } = {}) {
    const live = await this.scallopReader.readObligation(obligationId);
    const nowIso = new Date().toISOString();
    if (!live) {
      // record a failed reconciliation marker (history only)
      const snap = {
        id: `${obligationId}:${Date.now()}`, obligation_id: obligationId, owner: null,
        collateral_value_usd: null, debt_value_usd: null, scallop_risk_level: null, health_factor_like: null,
        asset_breakdown_json: null, source_sdk_read_at: nowIso, is_reconciled: 0,
        reconciliation_error: this.scallopReader.lastError || 'sdk read returned null', created_at: nowIso,
      };
      upsertRows(this.database, 'scallop_obligation_snapshots', [snap], ['id']);
      return null;
    }

    // Compare event-derived vs live (flag drift; execution trusts the live value).
    let reconciled = 1;
    let reconErr = null;
    if (Number.isFinite(eventDerivedDebtUsd) && live.debtValue > 0) {
      const drift = Math.abs(eventDerivedDebtUsd - live.debtValue) / live.debtValue;
      if (drift > 0.02) { reconciled = 0; reconErr = `debt drift ${(drift * 100).toFixed(1)}% (event ${eventDerivedDebtUsd} vs live ${live.debtValue})`; }
    }

    const snap = {
      id: `${obligationId}:${Date.now()}`,
      obligation_id: obligationId,
      owner: null,
      collateral_value_usd: live.collateralValue,
      debt_value_usd: live.debtValue,
      scallop_risk_level: live.scallopRiskLevel,
      health_factor_like: live.healthFactor,
      asset_breakdown_json: null,
      source_sdk_read_at: nowIso,
      is_reconciled: reconciled,
      reconciliation_error: reconErr,
      created_at: nowIso,
    };
    upsertRows(this.database, 'scallop_obligation_snapshots', [snap], ['id']);
    upsertRows(this.database, 'scallop_obligations', [{
      obligation_id: obligationId, owner: null, obligation_key_id: null,
      total_collateral_usd: live.collateralValue, total_debt_usd: live.debtValue,
      scallop_risk_level: live.scallopRiskLevel, health_factor_like: live.healthFactor,
      asset_breakdown_json: null, last_read_at: nowIso,
    }], ['obligation_id']);
    return snap;
  }

  /** Reconcile all tracked obligations once. */
  async run() {
    const ids = this.obligationsToReconcile();
    let ok = 0;
    for (const id of ids) {
      try { if (await this.reconcileOne(id)) ok += 1; } catch (e) { this.logger('warn', 'reconcile_failed', { obligation_id: id, error: String(e?.message || e) }); }
    }
    if (ids.length) this.logger('info', 'scallop_reconciled', { tracked: ids.length, ok });
    return { tracked: ids.length, ok };
  }
}
