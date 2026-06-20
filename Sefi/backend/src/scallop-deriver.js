/**
 * Scallop semantic deriver (#2).
 *
 * Reads raw Scallop events from SeFi's contract_logs and decodes them into typed tables
 * (scallop_borrow_events, scallop_repay_events, etc.). Tracks its own cursor (max processed
 * contract_logs.id) in sync_state so it's incremental + idempotent.
 */

import { ensureTable, upsertRows, TABLE_SHAPES } from './liquidshield-tables.js';
import { SCALLOP_EVENT_TABLE, SCALLOP_EVENT_NAMES } from './scallop-events.js';

const SYNC_KEY = 'scallop_deriver';
const BATCH = 2000;

const SCALLOP_TABLES = [
  'scallop_borrow_events',
  'scallop_repay_events',
  'scallop_collateral_deposit_events',
  'scallop_collateral_withdraw_events',
  'scallop_liquidation_events',
];

export class ScallopDeriver {
  constructor({ database, logger = () => {} }) {
    this.database = database;
    this.logger = logger;
    for (const t of SCALLOP_TABLES) ensureTable(database, t, TABLE_SHAPES[t].columns, TABLE_SHAPES[t].keyColumns);
  }

  /** Decode any new Scallop rows in contract_logs into typed tables. Returns count written. */
  run() {
    const cursor = Number(this.database.getSyncState(SYNC_KEY)?.last_index ?? 0) || 0;
    const placeholders = SCALLOP_EVENT_NAMES.map(() => '?').join(', ');
    const rows = this.database.queryAll(
      `SELECT id, event_name, data, tx_hash, timestamp, log_index
         FROM contract_logs
        WHERE event_name IN (${placeholders}) AND id > ?
        ORDER BY id ASC LIMIT ?`,
      [...SCALLOP_EVENT_NAMES, cursor, BATCH]
    );
    if (rows.length === 0) return 0;

    const byTable = {}; // table -> rows[]
    let maxId = cursor;
    for (const r of rows) {
      maxId = Math.max(maxId, Number(r.id));
      const spec = SCALLOP_EVENT_TABLE[r.event_name];
      if (!spec) continue;
      let json;
      try { json = JSON.parse(r.data); } catch { continue; }
      const row = spec.decode(json, { txDigest: r.tx_hash, timestamp: r.timestamp, logIndex: r.log_index });
      if (!row.obligation_id) continue; // skip events without an obligation (not position-relevant)
      (byTable[spec.table] ||= []).push(row);
    }

    let written = 0;
    for (const [table, tableRows] of Object.entries(byTable)) {
      written += upsertRows(this.database, table, tableRows, TABLE_SHAPES[table].keyColumns);
    }

    this.database.updateSyncState(SYNC_KEY, 'deriver', { lastIndex: maxId, incrementBy: written });
    if (written > 0) this.logger('info', 'scallop_derived', { written, cursor: maxId });
    return written;
  }
}
