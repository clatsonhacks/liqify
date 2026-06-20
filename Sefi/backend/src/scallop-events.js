/**
 * Typed Scallop event decoders (#2 semantic indexing).
 *
 * Field shapes verified against live Scallop mainnet events (2026-06):
 *   deposit_collateral::CollateralDepositEvent  { provider, obligation, deposit_asset, deposit_amount }
 *   withdraw_collateral::CollateralWithdrawEvent { taker, obligation, withdraw_asset, withdraw_amount }
 *   repay::RepayEvent                            { repayer, obligation, asset, amount, time }
 *   liquidate::LiquidateEventV2                  { liquidator, obligation, debt_type, collateral_type, repay_on_behalf, ... }
 *   borrow::BorrowEventV3                        { borrower, obligation, asset|borrow_asset, amount|borrow_amount, ... } (field-tolerant)
 *
 * Each decoder returns a row matching the corresponding TABLE_SHAPES table.
 * Coin type strings arrive without the 0x prefix; we keep them as-is and extract a symbol.
 */

/** last `::Foo` segment of a coin type, e.g. "…::sui::SUI" -> "SUI". */
function symbolOf(coinType) {
  const s = String(coinType || '');
  const parts = s.split('::');
  return parts.length ? parts[parts.length - 1].replace(/>.*$/, '') : '';
}

const pick = (json, ...keys) => {
  for (const k of keys) if (json && json[k] != null) return json[k];
  return null;
};

/**
 * Map of short event_name (`module::Event`) -> { table, decode(json, meta) -> row }.
 * meta = { txDigest, timestamp, logIndex }.
 */
export const SCALLOP_EVENT_TABLE = {
  'borrow::BorrowEventV3': {
    table: 'scallop_borrow_events',
    decode: (j, m) => {
      const coin = pick(j, 'asset', 'borrow_asset');
      return {
        id: `${m.txDigest}:${m.logIndex}`,
        obligation_id: pick(j, 'obligation'),
        actor: pick(j, 'borrower'),
        coin_type: coin,
        symbol: symbolOf(coin),
        amount: String(pick(j, 'amount', 'borrow_amount') ?? ''),
        tx_digest: m.txDigest,
        timestamp: m.timestamp,
      };
    },
  },
  'repay::RepayEvent': {
    table: 'scallop_repay_events',
    decode: (j, m) => ({
      id: `${m.txDigest}:${m.logIndex}`,
      obligation_id: pick(j, 'obligation'),
      actor: pick(j, 'repayer'),
      coin_type: pick(j, 'asset'),
      symbol: symbolOf(pick(j, 'asset')),
      amount: String(pick(j, 'amount') ?? ''),
      tx_digest: m.txDigest,
      timestamp: m.timestamp,
    }),
  },
  'deposit_collateral::CollateralDepositEvent': {
    table: 'scallop_collateral_deposit_events',
    decode: (j, m) => ({
      id: `${m.txDigest}:${m.logIndex}`,
      obligation_id: pick(j, 'obligation'),
      actor: pick(j, 'provider'),
      coin_type: pick(j, 'deposit_asset'),
      symbol: symbolOf(pick(j, 'deposit_asset')),
      amount: String(pick(j, 'deposit_amount') ?? ''),
      tx_digest: m.txDigest,
      timestamp: m.timestamp,
    }),
  },
  'withdraw_collateral::CollateralWithdrawEvent': {
    table: 'scallop_collateral_withdraw_events',
    decode: (j, m) => ({
      id: `${m.txDigest}:${m.logIndex}`,
      obligation_id: pick(j, 'obligation'),
      actor: pick(j, 'taker'),
      coin_type: pick(j, 'withdraw_asset'),
      symbol: symbolOf(pick(j, 'withdraw_asset')),
      amount: String(pick(j, 'withdraw_amount') ?? ''),
      tx_digest: m.txDigest,
      timestamp: m.timestamp,
    }),
  },
  'liquidate::LiquidateEventV2': {
    table: 'scallop_liquidation_events',
    decode: (j, m) => ({
      id: `${m.txDigest}:${m.logIndex}`,
      obligation_id: pick(j, 'obligation'),
      actor: pick(j, 'liquidator'),
      debt_type: pick(j, 'debt_type'),
      collateral_type: pick(j, 'collateral_type'),
      repay_amount: String(pick(j, 'repay_on_behalf', 'repay_amount') ?? ''),
      tx_digest: m.txDigest,
      timestamp: m.timestamp,
    }),
  },
};

/** The event_names we decode (used to fill the manifest + filter contract_logs). */
export const SCALLOP_EVENT_NAMES = Object.keys(SCALLOP_EVENT_TABLE);
