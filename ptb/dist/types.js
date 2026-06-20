/**
 * Shared types and constants for LiquidShield PTB scripts.
 */
// ─── LiquidShield deployment (testnet 2026-06-20) ────────────────────────────
export const PACKAGE_ID = process.env.LIQUIDSHIELD_PACKAGE_ID ??
    "0x1a4bc48f7c7cff2bcada2189e3b9c9686c866579629d06af99278370e41f0ecf";
export const SHIELD_REGISTRY_ID = process.env.SHIELD_REGISTRY_ID ??
    "0x0c002ee24b4beb2ce954c9113f12fec6b3549ac8e12739a501a863473a849b8b";
// Per-user objects (set in env after onboard_user.ts)
export const DEFAULT_RISK_POLICY_ID = process.env.RISK_POLICY_ID ?? "0x0";
export const DEFAULT_VAULT_ID = process.env.VAULT_ID ?? "0x0";
export const DEFAULT_SNAPSHOT_ID = process.env.SNAPSHOT_ID ?? "0x0";
export const DEFAULT_POSITION_ID = process.env.POSITION_ID ?? "0x0";
export const GUARDIAN_CAP_ID = process.env.GUARDIAN_CAP_ID ?? "0x0";
// Sui system objects
export const SUI_CLOCK_ID = "0x6";
// ─── Scallop testnet contract addresses ──────────────────────────────────────
// Source: @scallop-io/sui-scallop-sdk src/constants/testAddress.ts
/** Scallop core protocol package */
export const SCALLOP_PACKAGE_ID = process.env.SCALLOP_PACKAGE_ID ??
    "0xd971609b7feb6230585831e7aeb3c121fb21b9431337a30fc99185eb459a05ee";
/** Version shared object (required by every Scallop call) */
export const SCALLOP_VERSION_ID = process.env.SCALLOP_VERSION_ID ??
    "0x72bc09c4ce413d76d07f6e712413aebbe3ce3747eadfbc2331fbdb1dbde2d43a";
/** Market shared object */
export const SCALLOP_MARKET_ID = process.env.SCALLOP_MARKET_ID ??
    "0xed80ed898df1e0b7a14b78c92527b47ef88591d5722ded16050d7e101687bb20";
/** Coin decimals registry (required by borrow/withdraw calls) */
export const SCALLOP_COIN_DECIMALS_REGISTRY_ID = "0x200abe9bf19751cc566ae35aa58e2b7e4ff688fc1130f8d8909ea09bc137d668";
/** xOracle (required by borrow/withdraw calls) */
export const SCALLOP_XORACLE_ID = "0xb112727f380857fd711f89b450a3b22dc4cc55f82b2212b001f2461d6257b0b9";
// ─── Coin type strings ───────────────────────────────────────────────────────
export const SUI_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
export const USDC_TYPE = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
// ─── Risk thresholds ─────────────────────────────────────────────────────────
export const DEFAULT_TRIGGER_SCORE = 85;
export const MAX_SNAPSHOT_AGE_MS = 120_000; // 2 minutes
// ─── Action type enum ────────────────────────────────────────────────────────
export const ACTION_REPAY = 0;
export const ACTION_TOPUP = 1;
// ─── Reason code bit flags ───────────────────────────────────────────────────
export const REASON_LOW_HEALTH_FACTOR = 1n;
export const REASON_PRICE_DROP = 2n;
export const REASON_STALE_ORACLE = 4n;
export const REASON_LOW_LIQUIDITY = 8n;
export const REASON_HIGH_VOLATILITY = 16n;
export const REASON_LOW_RESERVE = 32n;
export function composeReasonCodes(...flags) {
    return flags.reduce((acc, f) => acc | f, 0n);
}
// ─── RPC ─────────────────────────────────────────────────────────────────────
export const SUI_TESTNET_RPC = "https://fullnode.testnet.sui.io:443";
export const RPC_URL = process.env.SUI_RPC_URL ?? SUI_TESTNET_RPC;
