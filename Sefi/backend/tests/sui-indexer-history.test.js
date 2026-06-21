import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.js';
import { SeFiDatabase } from '../src/database.js';
import { SuiIndexer } from '../src/sui-indexer.js';

function eventNode(timestamp, digest, ordinal) {
  return {
    cursor: Buffer.from(JSON.stringify({ t: 1, e: ordinal })).toString('base64'),
    contents: {
      type: { repr: '0xabc::borrow::BorrowEventV3' },
      json: { obligation: `obligation-${ordinal}`, borrower: '0x1', asset: '0x2::sui::SUI', amount: '1' },
    },
    timestamp,
    sender: { address: '0x1' },
    transaction: { digest },
  };
}

test('SuiIndexer backfills newest-to-oldest, stops at the rolling cutoff, and seeds live cursor', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sefi-sui-history-'));
  const manifestsDir = path.join(tempDir, 'manifests');
  fs.mkdirSync(manifestsDir, { recursive: true });
  const manifestPath = path.join(manifestsDir, 'sui.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    sources: [{ key: 'scallop-mainnet', role: 'protocol-intelligence', package: '0xabc', historyDays: 30 }],
  }));
  const config = createConfig({
    SEFI_DB_PATH: path.join(tempDir, 'sefi.db'),
    SEFI_CUBE_DB_PATH: path.join(tempDir, 'sefi.cube.db'),
    SEFI_MANIFESTS_DIR: manifestsDir,
  });
  const database = new SeFiDatabase(config);
  await database.init();
  const now = Date.UTC(2026, 5, 21, 12);
  const originalNow = Date.now;
  Date.now = () => now;
  const within = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
  const outside = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
  const client = {
    async queryEventsBackward() {
      return {
        nodes: [eventNode(outside, 'old', 1), eventNode(within, 'new', 2)],
        startCursor: 'oldest-cursor',
        endCursor: 'newest-cursor',
        hasPreviousPage: true,
      };
    },
    async queryEvents() {
      return { nodes: [], endCursor: 'newest-cursor', hasNextPage: false };
    },
  };

  try {
    const indexer = new SuiIndexer({
      client,
      database,
      lsConfig: { indexPollMs: 5000, protocolHistoryDays: 30 },
      manifestPath,
    });
    const result = await indexer.backfillSource(indexer.sources[0]);
    assert.equal(result.complete, true);
    assert.equal(result.inserted, 1);
    assert.equal(database.queryOne(`SELECT COUNT(*) count FROM contract_logs`).count, 1);
    assert.equal(database.getSyncState('sui:scallop-mainnet').last_tx_id, 'newest-cursor');
    assert.equal(database.getSyncState('sui-history:scallop-mainnet').last_index, 1);
  } finally {
    Date.now = originalNow;
    await database.close();
  }
});
