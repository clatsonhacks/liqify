import fs from 'fs';
import { ensureTable, upsertRows, TABLE_SHAPES } from './liquidshield-tables.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const INDEX_WINDOW_MS = 7 * DAY_MS;
const REQUEST_LIMIT = 10000;
const MIN_SPLIT_WINDOW_MS = 5 * 60 * 1000;

function utcDayStart(timestampMs) {
  const date = new Date(timestampMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function toIso(timestampMs) {
  const value = Number(timestampMs);
  if (!Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

function fileSize(path) {
  if (!path) return 0;
  try {
    return fs.statSync(path).size;
  } catch {
    return 0;
  }
}

function databaseStorageBytes(database) {
  const dbPath = database?.config?.dbPath;
  const cubePath = database?.config?.cubeDbPath;
  return [
    dbPath,
    dbPath ? `${dbPath}-wal` : null,
    dbPath ? `${dbPath}-shm` : null,
    cubePath,
    cubePath ? `${cubePath}-wal` : null,
    cubePath ? `${cubePath}-shm` : null,
  ].reduce((total, path) => total + fileSize(path), 0);
}

async function getJson(fetchImpl, url, timeoutMs = 15000, attempts = 2) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`DeepBook request timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error || `DeepBook request failed with HTTP ${response.status}`);
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  const cause = lastError instanceof Error && lastError.cause
    ? `: ${String(lastError.cause?.message || lastError.cause)}`
    : '';
  throw new Error(`${message}${cause}`);
}

export class DeepBookIndexer {
  constructor({ database, lsConfig, fetchImpl = fetch, logger = () => {} }) {
    this.database = database;
    this.config = lsConfig;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.running = false;
    this.lastRunAt = null;
    this.lastError = null;
    this.lastSummary = null;

    for (const table of [
      'deepbook_pools',
      'deepbook_daily_volume',
      'deepbook_trades',
      'deepbook_order_updates',
    ]) {
      ensureTable(database, table, TABLE_SHAPES[table].columns, TABLE_SHAPES[table].keyColumns);
    }
  }

  async fetchPools() {
    const [pools, summary] = await Promise.all([
      getJson(this.fetchImpl, `${this.config.deepbookIndexerUrl}/get_pools`),
      getJson(this.fetchImpl, `${this.config.deepbookIndexerUrl}/summary`).catch(() => []),
    ]);
    if (!Array.isArray(pools)) throw new Error('DeepBook get_pools returned a non-array payload');
    const volumeByPool = new Map(
      (Array.isArray(summary) ? summary : []).map((item) => [
        String(item.trading_pairs || ''),
        Number(item.quote_volume || 0),
      ])
    );
    try {
      const historicalVolumes = this.database.queryAll(
        `SELECT pool_name, SUM(quote_volume) AS quote_volume FROM deepbook_daily_volume GROUP BY pool_name`
      );
      for (const row of historicalVolumes) {
        const poolName = String(row.pool_name || '');
        const volume = Number(row.quote_volume || 0);
        if (poolName && volume > (volumeByPool.get(poolName) || 0)) {
          volumeByPool.set(poolName, volume);
        }
      }
    } catch {
      // Fresh databases will not have daily volume yet; live summary sorting is enough.
    }
    const indexedAt = new Date().toISOString();
    const rows = pools
      .map((pool) => ({
        pool_id: pool.pool_id,
        pool_name: pool.pool_name,
        base_asset_id: pool.base_asset_id,
        base_asset_symbol: pool.base_asset_symbol,
        base_asset_decimals: Number(pool.base_asset_decimals),
        quote_asset_id: pool.quote_asset_id,
        quote_asset_symbol: pool.quote_asset_symbol,
        quote_asset_decimals: Number(pool.quote_asset_decimals),
        min_size: String(pool.min_size ?? ''),
        lot_size: String(pool.lot_size ?? ''),
        tick_size: String(pool.tick_size ?? ''),
        indexed_at: indexedAt,
      }))
      .sort(
        (left, right) =>
          (volumeByPool.get(right.pool_name) || 0) - (volumeByPool.get(left.pool_name) || 0)
      );
    upsertRows(this.database, 'deepbook_pools', rows, TABLE_SHAPES.deepbook_pools.keyColumns);
    return rows;
  }

  windowSyncKey(poolName, startMs) {
    return `deepbook:${poolName}:${new Date(startMs).toISOString()}`;
  }

  dailyVolumeSyncKey(startMs) {
    return `deepbook-volume:${new Date(startMs).toISOString().slice(0, 10)}`;
  }

  async indexDailyVolumes(pools, startMs, endMs, { forceRecent = false } = {}) {
    const poolByName = new Map(pools.map((pool) => [pool.pool_name, pool]));
    const currentDayMs = utcDayStart(endMs);
    let rowsWritten = 0;
    let windows = 0;
    for (let cursor = startMs; cursor < endMs; cursor += DAY_MS) {
      const windowEnd = Math.min(cursor + DAY_MS, endMs);
      const isMutable = windowEnd > currentDayMs;
      if (forceRecent && !isMutable) continue;
      const syncKey = this.dailyVolumeSyncKey(cursor);
      if (!forceRecent && Number(this.database.getSyncState(syncKey)?.last_index) === 1) continue;
      const params = `start_time=${Math.floor(cursor / 1000)}&end_time=${Math.floor(windowEnd / 1000)}`;
      const [quoteVolumes, baseVolumes] = await Promise.all([
        getJson(this.fetchImpl, `${this.config.deepbookIndexerUrl}/all_historical_volume?${params}&volume_in_base=false`),
        getJson(this.fetchImpl, `${this.config.deepbookIndexerUrl}/all_historical_volume?${params}&volume_in_base=true`),
      ]);
      const indexedAt = new Date().toISOString();
      const rows = Object.keys({ ...(quoteVolumes || {}), ...(baseVolumes || {}) })
        .map((poolName) => {
          const pool = poolByName.get(poolName);
          if (!pool) return null;
          return {
            id: `${poolName}:${new Date(cursor).toISOString().slice(0, 10)}`,
            pool_id: pool.pool_id,
            pool_name: poolName,
            base_asset_symbol: pool.base_asset_symbol,
            quote_asset_symbol: pool.quote_asset_symbol,
            base_volume: Number(baseVolumes?.[poolName] || 0) / (10 ** pool.base_asset_decimals),
            quote_volume: Number(quoteVolumes?.[poolName] || 0) / (10 ** pool.quote_asset_decimals),
            window_start: new Date(cursor).toISOString(),
            window_end: new Date(windowEnd).toISOString(),
            indexed_at: indexedAt,
          };
        })
        .filter(Boolean);
      rowsWritten += upsertRows(
        this.database,
        'deepbook_daily_volume',
        rows,
        TABLE_SHAPES.deepbook_daily_volume.keyColumns
      );
      windows += 1;
      this.database.updateSyncState(syncKey, 'deepbook_daily_volume', {
        lastTimestamp: new Date(windowEnd).toISOString(),
        lastIndex: 1,
        incrementBy: rows.length,
      });
    }
    return { rows: rowsWritten, windows };
  }

  async fetchRange(resource, poolName, startMs, endMs) {
    const params = `start_time=${Math.floor(startMs / 1000)}&end_time=${Math.floor(endMs / 1000)}&limit=${REQUEST_LIMIT}`;
    let rows;
    const span = endMs - startMs;
    try {
      rows = await getJson(
        this.fetchImpl,
        `${this.config.deepbookIndexerUrl}/${resource}/${encodeURIComponent(poolName)}?${params}`,
        Number(this.config.deepbookRequestTimeoutMs || 30000),
        2
      );
    } catch (error) {
      if (span <= MIN_SPLIT_WINDOW_MS) throw error;
      const midpoint = startMs + Math.floor(span / 2);
      const left = await this.fetchRange(resource, poolName, startMs, midpoint);
      const right = await this.fetchRange(resource, poolName, midpoint, endMs);
      return [...left, ...right];
    }
    if (!Array.isArray(rows)) return [];
    if (rows.length < REQUEST_LIMIT) return rows;

    if (span <= MIN_SPLIT_WINDOW_MS) {
      throw new Error(
        `DeepBook ${resource} exceeded ${REQUEST_LIMIT} rows for ${poolName} in a ${span}ms window`
      );
    }

    const midpoint = startMs + Math.floor(span / 2);
    const left = await this.fetchRange(resource, poolName, startMs, midpoint);
    const right = await this.fetchRange(resource, poolName, midpoint, endMs);
    return [...left, ...right];
  }

  async indexWindow(pool, startMs, endMs, { force = false } = {}) {
    const syncKey = this.windowSyncKey(pool.pool_name, startMs);
    if (!force && Number(this.database.getSyncState(syncKey)?.last_index) === 1) {
      return { trades: 0, orders: 0, skipped: true };
    }

    const trades = await this.fetchRange('trades', pool.pool_name, startMs, endMs);
    const orders = await this.fetchRange('order_updates', pool.pool_name, startMs, endMs);
    const indexedAt = new Date().toISOString();
    const tradeRows = (Array.isArray(trades) ? trades : [])
      .map((trade) => ({
        trade_id: String(
          trade.trade_id ||
            trade.event_digest ||
            `${pool.pool_name}:${trade.timestamp}:${trade.maker_order_id}:${trade.taker_order_id}`
        ),
        pool_id: pool.pool_id,
        pool_name: pool.pool_name,
        side: trade.type || (trade.taker_is_bid ? 'buy' : 'sell'),
        price: Number(trade.price),
        base_volume: Number(trade.base_volume),
        quote_volume: Number(trade.quote_volume),
        maker_order_id: String(trade.maker_order_id || ''),
        taker_order_id: String(trade.taker_order_id || ''),
        maker_balance_manager_id: trade.maker_balance_manager_id || null,
        taker_balance_manager_id: trade.taker_balance_manager_id || null,
        maker_fee: Number(trade.maker_fee),
        taker_fee: Number(trade.taker_fee),
        tx_digest: trade.digest || null,
        event_digest: trade.event_digest || null,
        timestamp: toIso(trade.timestamp),
        indexed_at: indexedAt,
      }))
      .filter((row) => row.timestamp);
    const orderRows = (Array.isArray(orders) ? orders : [])
      .map((order) => ({
        id: `${pool.pool_name}:${order.order_id}:${order.status}:${order.timestamp}`,
        order_id: String(order.order_id || ''),
        pool_id: pool.pool_id,
        pool_name: pool.pool_name,
        balance_manager_id: order.balance_manager_id || null,
        side: order.type || null,
        status: order.status || null,
        price: Number(order.price),
        original_quantity: Number(order.original_quantity),
        remaining_quantity: Number(order.remaining_quantity),
        filled_quantity: Number(order.filled_quantity),
        timestamp: toIso(order.timestamp),
        indexed_at: indexedAt,
      }))
      .filter((row) => row.timestamp);

    const tradesWritten = upsertRows(
      this.database,
      'deepbook_trades',
      tradeRows,
      TABLE_SHAPES.deepbook_trades.keyColumns
    );
    const ordersWritten = upsertRows(
      this.database,
      'deepbook_order_updates',
      orderRows,
      TABLE_SHAPES.deepbook_order_updates.keyColumns
    );
    this.database.updateSyncState(syncKey, 'deepbook_window', {
      lastTimestamp: new Date(endMs).toISOString(),
      lastIndex: 1,
      incrementBy: tradesWritten + ordersWritten,
    });
    return { trades: tradesWritten, orders: ordersWritten, skipped: false };
  }

  async run({ forceRecent = false } = {}) {
    if (this.running) return this.lastSummary || { running: true };
    this.running = true;
    this.lastError = null;
    const startedAt = new Date().toISOString();
    try {
      const pools = await this.fetchPools();
      const endMs = Date.now();
      const configuredStartMs = this.config.protocolHistoryStartDate
        ? new Date(this.config.protocolHistoryStartDate).getTime()
        : NaN;
      const cutoffMs = Number.isFinite(configuredStartMs)
        ? configuredStartMs
        : endMs - this.config.protocolHistoryDays * DAY_MS;
      const startMs = utcDayStart(cutoffMs);
      const currentDayMs = utcDayStart(endMs);
      const volumeResult = await this.indexDailyVolumes(pools, startMs, endMs, { forceRecent });
      if (typeof this.database.forceSave === 'function') {
        await this.database.forceSave();
      }
      if (!this.config.deepbookDetailBackfillEnabled) {
        this.lastRunAt = new Date().toISOString();
        this.lastSummary = {
          running: false,
          started_at: startedAt,
          completed_at: this.lastRunAt,
          history_days: this.config.protocolHistoryDays,
          history_start_date: Number.isFinite(configuredStartMs) ? new Date(startMs).toISOString() : null,
          pools: pools.length,
          daily_volume_rows: volumeResult.rows,
          daily_volume_windows: volumeResult.windows,
          detail_backfill_enabled: false,
          windows: 0,
          trades: 0,
          orders: 0,
          failed_windows: 0,
          failures: [],
        };
        this.database.logActivity(
          'deepbook_indexed',
          'deepbook',
          `Indexed ${volumeResult.rows} daily DeepBook volume rows`
        );
        return this.lastSummary;
      }
      let trades = 0;
      let orders = 0;
      let windows = 0;
      const failures = [];
      let storageLimited = false;
      let storageBytes = databaseStorageBytes(this.database);
      const maxStorageBytes = Number(this.config.deepbookMaxStorageBytes || 0);
      const snapshotEveryWindows = Number(this.config.deepbookSnapshotEveryWindows || 25);
      const detailWindowMs = Number(this.config.deepbookDetailWindowMs || INDEX_WINDOW_MS);

      for (const pool of pools) {
        if (storageLimited) break;
        for (let cursor = startMs; cursor < endMs; cursor += detailWindowMs) {
          const windowEnd = Math.min(cursor + detailWindowMs, endMs);
          const isMutable = windowEnd > currentDayMs;
          if (forceRecent && !isMutable) continue;
          try {
            const result = await this.indexWindow(pool, cursor, windowEnd, {
              force: forceRecent && isMutable,
            });
            trades += result.trades;
            orders += result.orders;
            if (!result.skipped) windows += 1;
            if (windows > 0 && windows % snapshotEveryWindows === 0 && typeof this.database.forceSave === 'function') {
              await this.database.forceSave();
            }
            storageBytes = databaseStorageBytes(this.database);
            if (maxStorageBytes > 0 && storageBytes >= maxStorageBytes) {
              storageLimited = true;
              this.logger('warn', 'deepbook_storage_cap_reached', {
                bytes: storageBytes,
                max_bytes: maxStorageBytes,
                pool: pool.pool_name,
                window_end: new Date(windowEnd).toISOString(),
              });
              break;
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push({
              pool_name: pool.pool_name,
              start: new Date(cursor).toISOString(),
              end: new Date(windowEnd).toISOString(),
              error: message,
            });
            this.logger('warn', 'deepbook_window_failed', {
              pool: pool.pool_name,
              start: new Date(cursor).toISOString(),
              end: new Date(windowEnd).toISOString(),
              error: message,
            });
            break;
          }
        }
      }

      const cutoffIso = new Date(cutoffMs).toISOString();
      this.database.runStatement(`DELETE FROM deepbook_trades WHERE timestamp < ?`, [cutoffIso]);
      this.database.runStatement(`DELETE FROM deepbook_order_updates WHERE timestamp < ?`, [cutoffIso]);
      if (typeof this.database.forceSave === 'function') {
        await this.database.forceSave();
      }
      storageBytes = databaseStorageBytes(this.database);

      this.lastRunAt = new Date().toISOString();
      this.lastSummary = {
        running: false,
        started_at: startedAt,
        completed_at: this.lastRunAt,
        history_days: this.config.protocolHistoryDays,
        history_start_date: Number.isFinite(configuredStartMs) ? new Date(startMs).toISOString() : null,
        pools: pools.length,
        daily_volume_rows: volumeResult.rows,
        daily_volume_windows: volumeResult.windows,
        windows,
        trades,
        orders,
        failed_windows: failures.length,
        failures: failures.slice(0, 20),
        detail_backfill_enabled: true,
        storage_limited: storageLimited,
        storage_bytes: storageBytes,
        max_storage_bytes: maxStorageBytes,
      };
      this.lastError = storageLimited
        ? `DeepBook storage cap reached at ${storageBytes} bytes`
        : (failures.length > 0 ? `${failures.length} DeepBook windows failed` : null);
      this.database.logActivity(
        'deepbook_indexed',
        'deepbook',
        `Indexed ${trades} trades and ${orders} order updates`
      );
      return this.lastSummary;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger('warn', 'deepbook_index_failed', { error: this.lastError });
      throw error;
    } finally {
      this.running = false;
    }
  }

  getStatus() {
    const counts = {};
    for (const table of [
      'deepbook_pools',
      'deepbook_daily_volume',
      'deepbook_trades',
      'deepbook_order_updates',
    ]) {
      counts[table] = Number(
        this.database.queryOne(`SELECT COUNT(*) AS count FROM ${table}`)?.count || 0
      );
    }
    return {
      running: this.running,
      history_days: this.config.protocolHistoryDays,
      history_start_date: this.config.protocolHistoryStartDate || null,
      detail_backfill_enabled: Boolean(this.config.deepbookDetailBackfillEnabled),
      storage_bytes: databaseStorageBytes(this.database),
      max_storage_bytes: Number(this.config.deepbookMaxStorageBytes || 0),
      last_run_at: this.lastRunAt,
      last_error: this.lastError,
      counts,
      last_summary: this.lastSummary,
    };
  }
}
