/**
 * Shared types and constants for LiquidShield PTB scripts.
 */

// ─── LiquidShield deployment ─────────────────────────────────────────────────

export const PACKAGE_ID =
  process.env.LIQUIDSHIELD_PACKAGE_ID ??
  "0xabc270e8e2a87c3b4f3abf2f13230680f06768e91e4df41b02f49badca4f2bb0";

export const SHIELD_REGISTRY_ID =
  process.env.SHIELD_REGISTRY_ID ??
  "0xa3ba15ab872301aa2123450f412f0b103b4a41bd8c6f4bbccfa72f40ad614a16";

// Per-user objects (set in env after onboard_user.ts)
export const DEFAULT_RISK_POLICY_ID       = process.env.RISK_POLICY_ID            ?? "0x0";
export const DEFAULT_VAULT_ID             = process.env.VAULT_ID                  ?? "0x0";
export const DEFAULT_SNAPSHOT_ID          = process.env.SNAPSHOT_ID               ?? "0x0";
export const DEFAULT_GUARDIAN_DELEGATION_ID = process.env.GUARDIAN_DELEGATION_ID  ?? "0x0";

// Sui system objects
export const SUI_CLOCK_ID = "0x6";

// ─── Scallop testnet contract addresses ──────────────────────────────────────

export const SCALLOP_PACKAGE_ID =
  process.env.SCALLOP_PACKAGE_ID ??
  "0xf03ed2d85004fef0dca83b226532f4b720f25f929944f8b594a20cd5b8ad540b";

export const SCALLOP_VERSION_ID =
  process.env.SCALLOP_VERSION_ID ??
  "0x4666c444257abae5a08643b54b81ff26567aff1cf8a8cc4a693136b8ebe2277d";

export const SCALLOP_MARKET_ID =
  process.env.SCALLOP_MARKET_ID ??
  "0x782d7b6a53b318a9a4bb719a55036b4f05d85e65ed7c79a3798c8e0877e7fa7f";

// ─── Coin type strings ───────────────────────────────────────────────────────

export const SUI_TYPE  = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
export const USDC_TYPE = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

// ─── Risk thresholds ─────────────────────────────────────────────────────────

export const DEFAULT_TRIGGER_SCORE = 85;
export const MAX_SNAPSHOT_AGE_MS   = 120_000; // 2 minutes

// ─── Action type enum ────────────────────────────────────────────────────────

export const ACTION_REPAY  = 0;
export const ACTION_TOPUP  = 1;

// ─── Reason code bit flags ───────────────────────────────────────────────────

export const REASON_LOW_HEALTH_FACTOR = 1n;
export const REASON_PRICE_DROP        = 2n;
export const REASON_STALE_ORACLE      = 4n;
export const REASON_LOW_LIQUIDITY     = 8n;
export const REASON_HIGH_VOLATILITY   = 16n;
export const REASON_LOW_RESERVE       = 32n;

export function composeReasonCodes(...flags: bigint[]): bigint {
  return flags.reduce((acc, f) => acc | f, 0n);
}

// ─── RPC ─────────────────────────────────────────────────────────────────────

export const SUI_TESTNET_RPC = "https://fullnode.testnet.sui.io:443";
export const RPC_URL = process.env.SUI_RPC_URL ?? SUI_TESTNET_RPC;

// ─── PTB parameter bag ───────────────────────────────────────────────────────

export interface RescueParams {
  policyId:             string;
  vaultId:              string;
  snapshotId:           string;
  positionId?:          string; // ProtectedPosition object (begin_rescue arg, deployed flow)
  registryId?:          string; // ShieldRegistry shared object (singleton) — adapter flow only
  guardianDelegationId: string; // agent GuardianCap / GuardianDelegation object
  obligationId:         string;
  protocol:             string;
  /** Amount in base coin units */
  amount:               bigint;
  coinType:             string;
  actionType:           0 | 1;
}
