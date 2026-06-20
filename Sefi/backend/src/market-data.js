/**
 * Real market-data fetchers for liquifi `market_snapshots`.
 *
 * Price + oracle freshness:  Pyth Hermes (public REST, no auth until 2026-07-31)
 *   GET /api/latest_price_feeds?ids[]=<feed>
 *   -> [{ id, price:{price,conf,expo,publish_time}, ema_price }]
 *
 * Liquidity:  DeepBook v3 testnet indexer
 *   GET /summary            -> array of pair summaries (pre-scaled)
 *   GET /orderbook/:pool    -> { bids:[[price,qty]], asks:[[price,qty]] } for depth
 *
 * Verified vs testnet 2026-06: Pyth SUI/USD ~0.72 matches DeepBook SUI_DBUSDC last_price.
 */

function clamp(min, max, v) {
  return Math.max(min, Math.min(max, v));
}

async function getJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Pyth latest price for the configured feed. Returns null on failure. */
export async function fetchPythPrice(cfg) {
  if (!cfg.pythPriceFeedId) return null;
  const url = `${cfg.pythHermesUrl}/api/latest_price_feeds?ids[]=${cfg.pythPriceFeedId}`;
  try {
    const arr = await getJson(url);
    const feed = Array.isArray(arr) ? arr[0] : null;
    if (!feed?.price) return null;
    const expo = Number(feed.price.expo);
    const price = Number(feed.price.price) * 10 ** expo;
    const conf = Number(feed.price.conf) * 10 ** expo;
    const publishTimeMs = Number(feed.price.publish_time) * 1000;
    return {
      price,
      conf,
      publishTimeMs,
      oracleAgeMs: Date.now() - publishTimeMs,
    };
  } catch {
    return null;
  }
}

/** DeepBook /summary row for the configured pool. Returns null if absent/empty. */
export async function fetchDeepBookSummary(cfg) {
  try {
    const all = await getJson(`${cfg.deepbookIndexerUrl}/summary`);
    if (!Array.isArray(all)) return null;
    const row = all.find((r) => String(r.trading_pairs || '') === cfg.deepbookPoolName);
    if (!row) return null;
    const highestBid = Number(row.highest_bid);
    const lowestAsk = Number(row.lowest_ask);
    const spread = Number.isFinite(lowestAsk) && Number.isFinite(highestBid) ? lowestAsk - highestBid : null;
    return {
      lastPrice: Number(row.last_price),
      highestBid,
      lowestAsk,
      spread,
      baseVolume: Number(row.base_volume),
      quoteVolume: Number(row.quote_volume),
      priceChangePct24h: Number(row.price_change_percent_24h),
    };
  } catch {
    return null;
  }
}

/** DeepBook order-book depth (sum of bid+ask quantity). Returns null on failure. */
export async function fetchDeepBookDepth(cfg, depth = 20) {
  try {
    const ob = await getJson(`${cfg.deepbookIndexerUrl}/orderbook/${cfg.deepbookPoolName}?level=2&depth=${depth}`);
    const sum = (arr) => (Array.isArray(arr) ? arr.reduce((a, [, qty]) => a + Number(qty || 0), 0) : 0);
    const total = sum(ob?.bids) + sum(ob?.asks);
    return Number.isFinite(total) && total > 0 ? total : null;
  } catch {
    return null;
  }
}

/**
 * Liquidity score in [0,1]: tighter spread + deeper book + more volume = higher.
 * Returns null when there's no usable DeepBook data (so the agent flags LOW_LIQUIDITY).
 */
export function computeLiquidityScore({ spread, lastPrice, quoteVolume, depth }) {
  if (!Number.isFinite(spread) || !Number.isFinite(lastPrice) || lastPrice <= 0) return null;
  const spreadBps = (spread / lastPrice) * 10_000;
  const spreadComponent = clamp(0, 1, 1 - spreadBps / 100); // 0 bps -> 1, >=100 bps -> 0
  const volumeComponent = Number.isFinite(quoteVolume) ? clamp(0, 1, quoteVolume / 1000) : 0;
  const depthComponent = Number.isFinite(depth) && depth > 0 ? clamp(0, 1, depth / 10_000) : 0;
  const score = 0.5 * spreadComponent + 0.3 * volumeComponent + 0.2 * depthComponent;
  return Math.round(score * 1000) / 1000;
}

/**
 * Build one market_snapshots row from real sources.
 * mid_price prefers Pyth (oracle-grade); falls back to DeepBook last_price.
 * @returns {object|null} a row matching TABLE_SHAPES.market_snapshots, or null if no price at all.
 */
export async function buildMarketSnapshot(cfg) {
  const [pyth, summary] = await Promise.all([fetchPythPrice(cfg), fetchDeepBookSummary(cfg)]);
  const depth = summary ? await fetchDeepBookDepth(cfg) : null;

  const midPrice = pyth?.price ?? summary?.lastPrice ?? null;
  if (midPrice == null) return null; // no real price available -> caller fails closed

  const liquidityScore = summary
    ? computeLiquidityScore({
        spread: summary.spread,
        lastPrice: summary.lastPrice,
        quoteVolume: summary.quoteVolume,
        depth,
      })
    : null;

  const nowMs = Date.now();
  const assetPair = `${cfg.collateralAsset}/USD`;
  return {
    id: `${assetPair}:${nowMs}`,
    asset_pair: assetPair,
    mid_price: midPrice,
    price_confidence: pyth?.conf ?? null,
    oracle_age_ms: pyth ? Math.round(pyth.oracleAgeMs) : null,
    spread: summary?.spread ?? null,
    liquidity_depth: depth,
    volume_24h: summary?.quoteVolume ?? null,
    liquidity_score: liquidityScore,
    price_change_pct_24h: summary?.priceChangePct24h ?? null,
    timestamp: new Date(nowMs).toISOString(),
  };
}
