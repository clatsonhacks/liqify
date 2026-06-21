/**
 * liquifi Sui indexer.
 *
 * Polls Sui GraphQL for each manifest source's events and writes them into SeFi's
 * generic `contract_logs` table (reusing database.insertContractLogs / sync_state).
 * Models SeFiIndexer.startListen(): a forever poll loop with per-source cursors.
 *
 * Cursor model: GraphQL endCursor (opaque string) is stored in sync_state.last_tx_id,
 * keyed by entity_id `sui:<sourceKey>`. Event rows reuse contract_logs columns:
 *   contract_id  = package id
 *   event_name   = `module::Event`
 *   data         = JSON.stringify(parsed event json)
 *   tx_hash      = transaction digest
 *   log_index    = deterministic per-digest ordinal (stable across replays)
 *   timestamp    = event ISO timestamp
 */

import fs from 'fs';
import { normalizeEventNode } from './sui-events.js';
import { SuiClient } from './sui-client.js';

const PAGE_SIZE = 50;
const MAX_PAGES_PER_POLL = 20; // backfill cap per source per poll cycle

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function eventOrdinal(cursor, fallback) {
  try {
    const decoded = JSON.parse(Buffer.from(String(cursor || ''), 'base64').toString('utf8'));
    const ordinal = Number(decoded?.e);
    if (Number.isInteger(ordinal) && ordinal >= 0) return ordinal;
  } catch {
    // Fall back to page-local order for non-standard cursors.
  }
  return fallback;
}

function dateKey(value) {
  if (!value) return '';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toISOString().slice(0, 10);
}

export class SuiIndexer {
  /**
   * @param {object} opts
   * @param {import('./sui-client.js').SuiClient} opts.client
   * @param {object} opts.database         SeFiDatabase
   * @param {object} opts.lsConfig         createLiquifiConfig() result
   * @param {string} opts.manifestPath     absolute path to liquidshield manifest JSON
   * @param {function} [opts.logger]
   */
  constructor({ client, database, lsConfig, manifestPath, logger = () => {} }) {
    this.client = client;
    this.database = database;
    this.lsConfig = lsConfig;
    this.manifestPath = manifestPath;
    this.logger = logger;

    this.pollMs = lsConfig.indexPollMs;
    this.isRunning = false;
    this.shouldStop = false;
    this.lastPollAt = null;
    this.eventCallbacks = [];
    this.clientCache = new Map(); // per-source GraphQL client, keyed by url
    this.sources = this.loadSources();
  }

  /** Client for a source: its own graphqlUrl if set (e.g. mainnet Scallop), else the default. */
  clientFor(source) {
    if (!source.graphqlUrl) return this.client;
    if (!this.clientCache.has(source.graphqlUrl)) {
      this.clientCache.set(source.graphqlUrl, new SuiClient({ url: source.graphqlUrl }));
    }
    return this.clientCache.get(source.graphqlUrl);
  }

  onEvent(cb) {
    this.eventCallbacks.push(cb);
    return () => {
      this.eventCallbacks = this.eventCallbacks.filter((c) => c !== cb);
    };
  }

  emit(event, data = {}) {
    for (const cb of this.eventCallbacks) {
      try {
        cb(event, data);
      } catch {
        /* ignore per-callback failures */
      }
    }
  }

  /** Read manifest JSON, resolve each source's package id (env override wins). */
  loadSources() {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
    } catch (err) {
      this.logger('warn', 'manifest_load_failed', { error: String(err?.message || err) });
      return [];
    }
    const out = [];
    for (const src of manifest.sources || []) {
      if (src.external === true) continue;
      // Optional env gate: source only active when its enabledEnv var === '1' (e.g. a
      // heavy mainnet backfill you opt into for a benchmark, off by default).
      if (src.enabledEnv && String(process.env[src.enabledEnv] || '') !== '1') {
        continue;
      }
      const envPackage = src.packageEnv ? String(process.env[src.packageEnv] || '').trim() : '';
      const packageId = envPackage || String(src.package || '').trim();
      if (!packageId) {
        this.logger('info', 'source_skipped_no_package', { key: src.key, role: src.role });
        continue;
      }
      const graphqlUrl = src.graphqlUrl ? String(src.graphqlUrl).trim() : (src.graphqlUrlEnv ? String(process.env[src.graphqlUrlEnv] || '').trim() : '');
      const historyDays = Number.isFinite(Number(src.historyDays)) ? Math.max(0, Number(src.historyDays)) : 0;
      const explicitHistoryStartDate = src.historyStartDate
        ? dateKey(src.historyStartDate)
        : (historyDays ? dateKey(this.lsConfig.protocolHistoryStartDate) : '');
      out.push({
        key: src.key,
        role: src.role,
        packageId,
        modules: src.modules || [],
        graphqlUrl: graphqlUrl || null,
        historyDays,
        historyStartDate: explicitHistoryStartDate,
      });
    }
    return out;
  }

  syncKey(source) {
    return `sui:${source.key}`;
  }

  historySyncKey(source) {
    return source.historyStartDate
      ? `sui-history:${source.key}:${source.historyStartDate}`
      : `sui-history:${source.key}`;
  }

  /** Register each source as a contract row so SeFi status/UI sees it. */
  registerSources() {
    for (const source of this.sources) {
      this.database.registerContract({
        id: source.packageId,
        name: `liquifi:${source.key}`,
        canonicalName: source.key,
        category: source.role || 'sui',
        sourceFile: 'liquidshield.testnet.manifest.json',
      });
    }
  }

  /**
   * Drain new events for one source from its stored cursor.
   * @returns {Promise<number>} events inserted this cycle
   */
  async pollSource(source) {
    const syncId = this.syncKey(source);
    const client = this.clientFor(source);
    let cursor = this.database.getSyncState(syncId)?.last_tx_id || null;
    let inserted = 0;

    for (let page = 0; page < MAX_PAGES_PER_POLL && !this.shouldStop; page += 1) {
      let result;
      try {
        result = await client.queryEvents({
          module: source.packageId,
          after: cursor,
          first: PAGE_SIZE,
        });
      } catch (err) {
        this.logger('warn', 'query_events_failed', { key: source.key, error: String(err?.message || err) });
        break;
      }

      const nodes = result.nodes || [];
      if (nodes.length === 0) break;

      // Normalize once; assign a deterministic per-digest ordinal as log_index.
      const events = [];
      const rows = [];
      let lastTs = null;
      for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
        const node = nodes[nodeIndex];
        const ev = normalizeEventNode(node, source.key);
        const ordinal = eventOrdinal(node.cursor, nodeIndex);
        events.push(ev);
        rows.push({
          contract_id: source.packageId,
          tx_hash: ev.digest,
          event_name: ev.eventName,
          data: JSON.stringify(ev.json),
          block_number: null,
          log_index: ordinal,
          timestamp: ev.timestamp,
        });
        lastTs = ev.timestamp || lastTs;
      }

      const insertedNow = this.database.insertContractLogs(rows);
      inserted += insertedNow;

      // advance cursor + persist
      cursor = result.endCursor || cursor;
      this.database.updateSyncState(syncId, 'sui_package', {
        lastTimestamp: lastTs || undefined,
        lastTxId: cursor,
        incrementBy: insertedNow,
      });

      // fan out each event to realtime listeners
      for (const ev of events) {
        this.emit(ev.eventName, {
          source: source.key,
          event_name: ev.eventName,
          type: ev.typeRepr,
          digest: ev.digest,
          sender: ev.sender,
          timestamp: ev.timestamp,
          json: ev.json,
        });
      }

      if (insertedNow > 0) {
        this.database.logActivity('sui_indexed', source.key, `Indexed ${insertedNow} ${source.key} events`);
      }

      if (!result.hasNextPage) break;
    }

    return inserted;
  }

  /**
   * Resume a newest-to-oldest backfill until the configured cutoff is reached.
   * The first page's end cursor becomes the live forward cursor after completion.
   */
  async backfillSource(source) {
    if (!source.historyDays && !source.historyStartDate) return { inserted: 0, complete: true };

    const syncId = this.historySyncKey(source);
    const state = this.database.getSyncState(syncId);
    if (Number(state?.last_index) === 1) return { inserted: 0, complete: true };

    const client = this.clientFor(source);
    const cutoff = source.historyStartDate
      ? new Date(`${source.historyStartDate}T00:00:00.000Z`)
      : new Date(Date.now() - source.historyDays * 24 * 60 * 60 * 1000);
    let before = state?.last_tx_id || null;
    let inserted = 0;
    let complete = false;
    let newestCursor = this.database.getSyncState(this.syncKey(source))?.last_tx_id || null;
    let newestTimestamp = null;
    let oldestTimestamp = state?.last_timestamp && state.last_timestamp !== '0.0'
      ? state.last_timestamp
      : null;

    for (let page = 0; page < MAX_PAGES_PER_POLL && !this.shouldStop; page += 1) {
      const result = await client.queryEventsBackward({
        module: source.packageId,
        before,
        last: PAGE_SIZE,
      });
      const nodes = result.nodes || [];
      if (nodes.length === 0) {
        complete = true;
        break;
      }
      if (!newestCursor) newestCursor = result.endCursor || null;

      const rows = [];
      for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
        const node = nodes[nodeIndex];
        const ev = normalizeEventNode(node, source.key);
        const timestamp = ev.timestamp ? new Date(ev.timestamp) : null;
        if (
          ev.timestamp &&
          (!newestTimestamp || new Date(ev.timestamp).getTime() > new Date(newestTimestamp).getTime())
        ) {
          newestTimestamp = ev.timestamp;
        }
        if (timestamp && timestamp < cutoff) {
          complete = true;
          continue;
        }
        rows.push({
          contract_id: source.packageId,
          tx_hash: ev.digest,
          event_name: ev.eventName,
          data: JSON.stringify(ev.json),
          block_number: null,
          log_index: eventOrdinal(node.cursor, nodeIndex),
          timestamp: ev.timestamp,
        });
        if (
          ev.timestamp &&
          (!oldestTimestamp || new Date(ev.timestamp).getTime() < new Date(oldestTimestamp).getTime())
        ) {
          oldestTimestamp = ev.timestamp;
        }
      }

      const insertedNow = this.database.insertContractLogs(rows);
      inserted += insertedNow;
      before = result.startCursor || before;

      this.database.updateSyncState(syncId, 'sui_history', {
        lastTimestamp: oldestTimestamp || undefined,
        lastTxId: before,
        lastIndex: complete ? 1 : 0,
        incrementBy: insertedNow,
      });

      if (complete || !result.hasPreviousPage) {
        complete = true;
        break;
      }
    }

    if (complete) {
      this.database.updateSyncState(syncId, 'sui_history', {
        lastTimestamp: oldestTimestamp || cutoff.toISOString(),
        lastTxId: before,
        lastIndex: 1,
      });
      if (!this.database.getSyncState(this.syncKey(source))?.last_tx_id && newestCursor) {
        this.database.updateSyncState(this.syncKey(source), 'sui_package', {
          lastTimestamp: newestTimestamp || undefined,
          lastTxId: newestCursor,
        });
      }
      this.database.logActivity(
        'sui_history_complete',
        source.key,
        `Indexed ${source.historyStartDate || `${source.historyDays} days`} of ${source.key} history`
      );
    }

    if (inserted > 0) {
      this.logger('info', 'sui_history_indexed', {
        key: source.key,
        inserted,
        cutoff: cutoff.toISOString(),
        complete,
      });
    }
    return { inserted, complete };
  }

  /** One pass over all sources. */
  async pollOnce() {
    let total = 0;
    for (const source of this.sources) {
      if (this.shouldStop) break;
      const history = await this.backfillSource(source);
      total += history.inserted;
      if (!history.complete) continue;
      total += await this.pollSource(source);
    }
    this.lastPollAt = new Date().toISOString();
    return total;
  }

  /** Start the forever poll loop (non-blocking; runs in background). */
  async start() {
    if (this.isRunning) return { error: 'already running' };
    if (this.sources.length === 0) {
      this.logger('warn', 'no_sui_sources', {});
      return { error: 'no sources configured' };
    }
    this.isRunning = true;
    this.shouldStop = false;
    this.registerSources();
    this.logger('info', 'sui_indexer_started', { sources: this.sources.map((s) => s.key), pollMs: this.pollMs });

    (async () => {
      while (!this.shouldStop) {
        try {
          await this.pollOnce();
        } catch (err) {
          this.logger('error', 'sui_poll_error', { error: String(err?.message || err) });
        }
        if (!this.shouldStop) await sleep(this.pollMs);
      }
      this.isRunning = false;
      this.logger('info', 'sui_indexer_stopped', {});
    })();

    return { success: true };
  }

  stop() {
    this.shouldStop = true;
    return { success: true };
  }

  getStatus() {
    const sources = this.sources.map((s) => {
      const ss = this.database.getSyncState(this.syncKey(s));
      const lastTs = ss?.last_timestamp && ss.last_timestamp !== '0.0' ? ss.last_timestamp : null;
      const lagMs = lastTs ? Date.now() - new Date(lastTs).getTime() : null;
      return {
        key: s.key,
        role: s.role,
        package_id: s.packageId,
        cursor: ss?.last_tx_id || null,
        events_total: Number(ss?.items_synced || 0),
        last_event_at: lastTs,
        lag_ms: lagMs,
        history: (s.historyDays || s.historyStartDate)
          ? {
              days: s.historyDays,
              start_date: s.historyStartDate || null,
              complete: Number(this.database.getSyncState(this.historySyncKey(s))?.last_index) === 1,
              events_total: Number(this.database.getSyncState(this.historySyncKey(s))?.items_synced || 0),
              oldest_event_at: this.database.getSyncState(this.historySyncKey(s))?.last_timestamp || null,
            }
          : null,
      };
    });
    return {
      running: this.isRunning,
      poll_ms: this.pollMs,
      last_poll_at: this.lastPollAt,
      events_total: sources.reduce((a, s) => a + s.events_total, 0),
      sources,
    };
  }
}
