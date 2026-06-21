import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.js';
import { SeFiDatabase } from '../src/database.js';
import { DeepBookIndexer } from '../src/deepbook-indexer.js';

function response(payload) {
  return {
    ok: true,
    status: 200,
    async json() {
      return payload;
    },
  };
}

test('DeepBookIndexer materializes typed pool, trade, and order history with stable day checkpoints', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sefi-deepbook-'));
  const manifestsDir = path.join(tempDir, 'manifests');
  fs.mkdirSync(manifestsDir, { recursive: true });
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
  const lsConfig = {
    deepbookIndexerUrl: 'https://deepbook.test',
    protocolHistoryDays: 1,
    deepbookDetailBackfillEnabled: true,
  };
  const fetchImpl = async (url) => {
    const text = String(url);
    if (text.endsWith('/get_pools')) {
      return response([{
        pool_id: 'pool-1',
        pool_name: 'SUI_USDC',
        base_asset_id: 'sui',
        base_asset_symbol: 'SUI',
        base_asset_decimals: 9,
        quote_asset_id: 'usdc',
        quote_asset_symbol: 'USDC',
        quote_asset_decimals: 6,
        min_size: 1,
        lot_size: 1,
        tick_size: 1,
      }]);
    }
    if (text.endsWith('/summary')) {
      return response([{ trading_pairs: 'SUI_USDC', quote_volume: 10.5 }]);
    }
    if (text.includes('/all_historical_volume')) {
      return response({ SUI_USDC: text.includes('volume_in_base=true') ? 10_000_000_000 : 10_500_000 });
    }
    if (text.includes('/trades/SUI_USDC')) {
      return response([{
        trade_id: 'trade-1',
        type: 'buy',
        price: 1.05,
        base_volume: 10,
        quote_volume: 10.5,
        timestamp: now - 60_000,
      }]);
    }
    if (text.includes('/order_updates/SUI_USDC')) {
      return response([{
        order_id: 'order-1',
        type: 'buy',
        status: 'Placed',
        price: 1.04,
        original_quantity: 5,
        remaining_quantity: 2,
        filled_quantity: 3,
        timestamp: now - 30_000,
      }]);
    }
    throw new Error(`Unexpected URL: ${text}`);
  };

  try {
    const indexer = new DeepBookIndexer({ database, lsConfig, fetchImpl });
    const result = await indexer.run();
    assert.equal(result.pools, 1);
    assert.equal(database.queryOne('SELECT COUNT(*) count FROM deepbook_trades').count, 1);
    assert.equal(database.queryOne('SELECT COUNT(*) count FROM deepbook_order_updates').count, 1);
    assert.equal(database.queryOne('SELECT COUNT(*) count FROM deepbook_daily_volume').count, 2);
    assert.equal(
      database.queryOne(`SELECT price FROM deepbook_trades WHERE trade_id = 'trade-1'`).price,
      1.05
    );
    const checkpoints = database.queryAll(
      `SELECT entity_id FROM sync_state WHERE entity_id LIKE 'deepbook:SUI_USDC:%' ORDER BY entity_id`
    );
    assert.deepEqual(
      checkpoints.map((row) => row.entity_id),
      ['deepbook:SUI_USDC:2026-06-20T00:00:00.000Z']
    );
  } finally {
    Date.now = originalNow;
    await database.close();
  }
});
