/**
 * liquifi derived-table schemas + create/upsert helpers.
 *
 * The helpers mirror DerivedPipelineService.ensureTableShape / upsertRowsIntoTable
 * (derived.js) so the deriver/agent can manage the 4 liquifi tables without
 * instantiating the Hedera-coupled pipeline service. Columns follow person2.md.
 */

function escapeIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function toSqlColumnType(inputType) {
  const normalized = String(inputType || '').trim().toUpperCase();
  if (['TEXT', 'INTEGER', 'REAL', 'BLOB', 'NUMERIC'].includes(normalized)) return normalized;
  return 'TEXT';
}

// ── Table shapes ──────────────────────────────────────────────────────────────

export const TABLE_SHAPES = {
  positions: {
    keyColumns: ['id'],
    columns: [
      { name: 'id', type: 'TEXT', primary_key: true }, // ProtectedPosition object id
      { name: 'wallet_address', type: 'TEXT' },
      { name: 'protocol', type: 'TEXT' },
      { name: 'obligation_id', type: 'TEXT' },
      { name: 'collateral_asset', type: 'TEXT' },
      { name: 'debt_asset', type: 'TEXT' },
      { name: 'collateral_value', type: 'REAL' },
      { name: 'debt_value', type: 'REAL' },
      { name: 'health_factor', type: 'REAL' },
      { name: 'risk_level', type: 'TEXT' },
      { name: 'status', type: 'TEXT' }, // protected | monitoring-only | paused | revoked
      { name: 'policy_id', type: 'TEXT' },
      { name: 'vault_id', type: 'TEXT' },
      { name: 'snapshot_id', type: 'TEXT' },
      { name: 'last_updated', type: 'TEXT' },
    ],
  },
  market_snapshots: {
    keyColumns: ['id'],
    columns: [
      { name: 'id', type: 'TEXT', primary_key: true }, // `${asset_pair}:${ts_ms}`
      { name: 'asset_pair', type: 'TEXT' },
      { name: 'mid_price', type: 'REAL' },
      { name: 'price_confidence', type: 'REAL' },
      { name: 'oracle_age_ms', type: 'INTEGER' },
      { name: 'spread', type: 'REAL' },
      { name: 'liquidity_depth', type: 'REAL' },
      { name: 'volume_24h', type: 'REAL' },
      { name: 'liquidity_score', type: 'REAL' },
      { name: 'price_change_pct_24h', type: 'REAL' },
      { name: 'timestamp', type: 'TEXT' },
    ],
  },
  risk_scores: {
    keyColumns: ['id'],
    columns: [
      { name: 'id', type: 'TEXT', primary_key: true }, // `${position_id}:${ts_ms}`
      { name: 'position_id', type: 'TEXT' },
      { name: 'market', type: 'TEXT' },
      { name: 'protocol', type: 'TEXT' },
      { name: 'risk_score', type: 'INTEGER' },
      { name: 'risk_level', type: 'TEXT' }, // normal | watch | guarded | emergency
      { name: 'reason_codes', type: 'INTEGER' },
      { name: 'reason', type: 'TEXT' },
      { name: 'recommended_action', type: 'TEXT' },
      { name: 'can_execute', type: 'INTEGER' },
      { name: 'timestamp', type: 'TEXT' },
    ],
  },
  risk_actions: {
    keyColumns: ['id'],
    columns: [
      { name: 'id', type: 'TEXT', primary_key: true }, // tx digest (+ordinal) or agent action id
      { name: 'position_id', type: 'TEXT' },
      { name: 'wallet_address', type: 'TEXT' },
      { name: 'protocol', type: 'TEXT' },
      { name: 'action_type', type: 'TEXT' }, // repay | topup
      { name: 'amount', type: 'REAL' },
      { name: 'tx_digest', type: 'TEXT' },
      { name: 'status', type: 'TEXT' }, // executed | blocked | failed | simulated
      { name: 'reason_codes', type: 'INTEGER' },
      { name: 'reason', type: 'TEXT' },
      { name: 'risk_before', type: 'INTEGER' },
      { name: 'risk_after', type: 'INTEGER' },
      // #9 pre/post-execution verification
      { name: 'before_health_factor', type: 'REAL' },
      { name: 'after_health_factor', type: 'REAL' },
      { name: 'before_risk_level', type: 'TEXT' },
      { name: 'after_risk_level', type: 'TEXT' },
      { name: 'simulation_digest', type: 'TEXT' },
      { name: 'result_verified', type: 'INTEGER' }, // 1 = post-state confirmed improved
      { name: 'timestamp', type: 'TEXT' },
    ],
  },

  // ── #20 concurrency / idempotency ──────────────────────────────────────────
  execution_locks: {
    keyColumns: ['key'],
    columns: [
      { name: 'key', type: 'TEXT', primary_key: true }, // idempotency key (obligation_id:nonce)
      { name: 'obligation_id', type: 'TEXT' },
      { name: 'locked_until', type: 'INTEGER' }, // epoch ms
      { name: 'tx_digest', type: 'TEXT' },
      { name: 'status', type: 'TEXT' }, // locked | done | failed
    ],
  },

  // ── #2 typed Scallop event tables ──────────────────────────────────────────
  scallop_borrow_events: {
    keyColumns: ['id'],
    columns: [
      { name: 'id', type: 'TEXT', primary_key: true }, // tx_digest:log_index
      { name: 'obligation_id', type: 'TEXT' },
      { name: 'actor', type: 'TEXT' }, // borrower
      { name: 'coin_type', type: 'TEXT' },
      { name: 'symbol', type: 'TEXT' },
      { name: 'amount', type: 'TEXT' }, // base units (string, can exceed JS int)
      { name: 'tx_digest', type: 'TEXT' },
      { name: 'timestamp', type: 'TEXT' },
    ],
  },
  scallop_repay_events: {
    keyColumns: ['id'],
    columns: [
      { name: 'id', type: 'TEXT', primary_key: true },
      { name: 'obligation_id', type: 'TEXT' },
      { name: 'actor', type: 'TEXT' }, // repayer
      { name: 'coin_type', type: 'TEXT' },
      { name: 'symbol', type: 'TEXT' },
      { name: 'amount', type: 'TEXT' },
      { name: 'tx_digest', type: 'TEXT' },
      { name: 'timestamp', type: 'TEXT' },
    ],
  },
  scallop_collateral_deposit_events: {
    keyColumns: ['id'],
    columns: [
      { name: 'id', type: 'TEXT', primary_key: true },
      { name: 'obligation_id', type: 'TEXT' },
      { name: 'actor', type: 'TEXT' }, // provider
      { name: 'coin_type', type: 'TEXT' },
      { name: 'symbol', type: 'TEXT' },
      { name: 'amount', type: 'TEXT' },
      { name: 'tx_digest', type: 'TEXT' },
      { name: 'timestamp', type: 'TEXT' },
    ],
  },
  scallop_collateral_withdraw_events: {
    keyColumns: ['id'],
    columns: [
      { name: 'id', type: 'TEXT', primary_key: true },
      { name: 'obligation_id', type: 'TEXT' },
      { name: 'actor', type: 'TEXT' }, // taker
      { name: 'coin_type', type: 'TEXT' },
      { name: 'symbol', type: 'TEXT' },
      { name: 'amount', type: 'TEXT' },
      { name: 'tx_digest', type: 'TEXT' },
      { name: 'timestamp', type: 'TEXT' },
    ],
  },
  scallop_liquidation_events: {
    keyColumns: ['id'],
    columns: [
      { name: 'id', type: 'TEXT', primary_key: true },
      { name: 'obligation_id', type: 'TEXT' },
      { name: 'actor', type: 'TEXT' }, // liquidator
      { name: 'debt_type', type: 'TEXT' },
      { name: 'collateral_type', type: 'TEXT' },
      { name: 'repay_amount', type: 'TEXT' },
      { name: 'tx_digest', type: 'TEXT' },
      { name: 'timestamp', type: 'TEXT' },
    ],
  },

  // ── #2/#14 obligation state (latest + history) ─────────────────────────────
  scallop_obligations: {
    keyColumns: ['obligation_id'],
    columns: [
      { name: 'obligation_id', type: 'TEXT', primary_key: true },
      { name: 'owner', type: 'TEXT' },
      { name: 'obligation_key_id', type: 'TEXT' },
      { name: 'total_collateral_usd', type: 'REAL' },
      { name: 'total_debt_usd', type: 'REAL' },
      { name: 'scallop_risk_level', type: 'REAL' },
      { name: 'health_factor_like', type: 'REAL' },
      { name: 'asset_breakdown_json', type: 'TEXT' },
      { name: 'last_read_at', type: 'TEXT' },
    ],
  },
  scallop_obligation_snapshots: {
    keyColumns: ['id'],
    columns: [
      { name: 'id', type: 'TEXT', primary_key: true }, // obligation_id:ts_ms
      { name: 'obligation_id', type: 'TEXT' },
      { name: 'owner', type: 'TEXT' },
      { name: 'collateral_value_usd', type: 'REAL' },
      { name: 'debt_value_usd', type: 'REAL' },
      { name: 'scallop_risk_level', type: 'REAL' },
      { name: 'health_factor_like', type: 'REAL' },
      { name: 'asset_breakdown_json', type: 'TEXT' },
      { name: 'source_sdk_read_at', type: 'TEXT' },
      { name: 'is_reconciled', type: 'INTEGER' },
      { name: 'reconciliation_error', type: 'TEXT' },
      { name: 'created_at', type: 'TEXT' },
    ],
  },

  deepbook_pools: {
    keyColumns: ['pool_id'],
    columns: [
      { name: 'pool_id', type: 'TEXT', primary_key: true },
      { name: 'pool_name', type: 'TEXT' },
      { name: 'base_asset_id', type: 'TEXT' },
      { name: 'base_asset_symbol', type: 'TEXT' },
      { name: 'base_asset_decimals', type: 'INTEGER' },
      { name: 'quote_asset_id', type: 'TEXT' },
      { name: 'quote_asset_symbol', type: 'TEXT' },
      { name: 'quote_asset_decimals', type: 'INTEGER' },
      { name: 'min_size', type: 'TEXT' },
      { name: 'lot_size', type: 'TEXT' },
      { name: 'tick_size', type: 'TEXT' },
      { name: 'indexed_at', type: 'TEXT' },
    ],
  },
  deepbook_daily_volume: {
    keyColumns: ['id'],
    columns: [
      { name: 'id', type: 'TEXT', primary_key: true },
      { name: 'pool_id', type: 'TEXT' },
      { name: 'pool_name', type: 'TEXT' },
      { name: 'base_asset_symbol', type: 'TEXT' },
      { name: 'quote_asset_symbol', type: 'TEXT' },
      { name: 'base_volume', type: 'REAL' },
      { name: 'quote_volume', type: 'REAL' },
      { name: 'window_start', type: 'TEXT' },
      { name: 'window_end', type: 'TEXT' },
      { name: 'indexed_at', type: 'TEXT' },
    ],
  },
  deepbook_trades: {
    keyColumns: ['trade_id'],
    columns: [
      { name: 'trade_id', type: 'TEXT', primary_key: true },
      { name: 'pool_id', type: 'TEXT' },
      { name: 'pool_name', type: 'TEXT' },
      { name: 'side', type: 'TEXT' },
      { name: 'price', type: 'REAL' },
      { name: 'base_volume', type: 'REAL' },
      { name: 'quote_volume', type: 'REAL' },
      { name: 'maker_order_id', type: 'TEXT' },
      { name: 'taker_order_id', type: 'TEXT' },
      { name: 'maker_balance_manager_id', type: 'TEXT' },
      { name: 'taker_balance_manager_id', type: 'TEXT' },
      { name: 'maker_fee', type: 'REAL' },
      { name: 'taker_fee', type: 'REAL' },
      { name: 'tx_digest', type: 'TEXT' },
      { name: 'event_digest', type: 'TEXT' },
      { name: 'timestamp', type: 'TEXT' },
      { name: 'indexed_at', type: 'TEXT' },
    ],
  },
  deepbook_order_updates: {
    keyColumns: ['id'],
    columns: [
      { name: 'id', type: 'TEXT', primary_key: true },
      { name: 'order_id', type: 'TEXT' },
      { name: 'pool_id', type: 'TEXT' },
      { name: 'pool_name', type: 'TEXT' },
      { name: 'balance_manager_id', type: 'TEXT' },
      { name: 'side', type: 'TEXT' },
      { name: 'status', type: 'TEXT' },
      { name: 'price', type: 'REAL' },
      { name: 'original_quantity', type: 'REAL' },
      { name: 'remaining_quantity', type: 'REAL' },
      { name: 'filled_quantity', type: 'REAL' },
      { name: 'timestamp', type: 'TEXT' },
      { name: 'indexed_at', type: 'TEXT' },
    ],
  },
};

// ── Helpers (replicated from derived.js) ────────────────────────────────────────

/** Create the table if missing, or ALTER-ADD any missing columns. */
export function ensureTable(database, tableName, targetColumns, keyColumns = []) {
  if (!Array.isArray(targetColumns) || targetColumns.length === 0) return;

  const exists = Boolean(
    database.queryOne(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
      [String(tableName)]
    )?.name
  );

  if (!exists) {
    const columnSql = targetColumns
      .map((c) => {
        const constraints = c.primary_key ? 'PRIMARY KEY' : '';
        return `${escapeIdentifier(c.name)} ${toSqlColumnType(c.type)} ${constraints}`.trim();
      })
      .join(', ');
    database.runStatement(`CREATE TABLE IF NOT EXISTS ${escapeIdentifier(tableName)} (${columnSql})`);
    if (Array.isArray(keyColumns) && keyColumns.length > 1) {
      database.runStatement(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${escapeIdentifier(`uq_${tableName}_${keyColumns.join('_')}`)} ON ${escapeIdentifier(tableName)} (${keyColumns
          .map((c) => escapeIdentifier(c))
          .join(', ')})`
      );
    }
    return;
  }

  const existing = new Set(
    database
      .queryAll(`PRAGMA table_info(${escapeIdentifier(tableName)})`)
      .map((c) => String(c.name || '').trim())
      .filter(Boolean)
  );
  for (const c of targetColumns) {
    if (existing.has(c.name)) continue;
    database.runStatement(
      `ALTER TABLE ${escapeIdentifier(tableName)} ADD COLUMN ${escapeIdentifier(c.name)} ${toSqlColumnType(c.type)}`
    );
  }
}

/** Upsert rows (INSERT ... ON CONFLICT(keyColumns) DO UPDATE). Returns change count. */
export function upsertRows(database, tableName, rows, keyColumns = []) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const columns = Object.keys(rows[0]);
  const insertCols = columns.map((c) => escapeIdentifier(c)).join(', ');
  const placeholders = columns.map(() => '?').join(', ');

  let sql;
  if (keyColumns.length > 0) {
    const updateCols = columns.filter((c) => !keyColumns.includes(c));
    if (updateCols.length > 0) {
      const updateSet = updateCols.map((c) => `${escapeIdentifier(c)} = excluded.${escapeIdentifier(c)}`).join(', ');
      sql = `INSERT INTO ${escapeIdentifier(tableName)} (${insertCols}) VALUES (${placeholders}) ON CONFLICT(${keyColumns
        .map((c) => escapeIdentifier(c))
        .join(', ')}) DO UPDATE SET ${updateSet}`;
    } else {
      sql = `INSERT OR IGNORE INTO ${escapeIdentifier(tableName)} (${insertCols}) VALUES (${placeholders})`;
    }
  } else {
    sql = `INSERT INTO ${escapeIdentifier(tableName)} (${insertCols}) VALUES (${placeholders})`;
  }

  const db = database.db;
  const stmt = db.prepare(sql);
  let changes = 0;
  const tx = db.transaction((items) => {
    for (const item of items) {
      const values = columns.map((c) => (Object.prototype.hasOwnProperty.call(item, c) ? item[c] : null));
      changes += Number(stmt.run(values).changes || 0);
    }
  });
  tx.immediate(rows);
  database.invalidateMetricsCache();
  database.scheduleSave();
  return changes;
}

/** Ensure all 4 liquifi tables exist with current shape. */
export function ensureAllTables(database) {
  for (const [name, shape] of Object.entries(TABLE_SHAPES)) {
    ensureTable(database, name, shape.columns, shape.keyColumns);
  }
}
