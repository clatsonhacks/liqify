/**
 * One-time user onboarding script for the redesigned LiquidShield contracts.
 *
 * TX 1: create_and_share_policy + create_and_deposit (vault) + create_snapshot
 * TX 2: create_delegation + register_position (needs IDs from TX 1)
 *
 * Run:
 *   USER_PRIVATE_KEY=<base64-32-byte-seed> \
 *   AGENT_ADDRESS=0x... \
 *   OBLIGATION_ID=0x... \
 *   tsx src/onboard_user.ts
 */

import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import {
  PACKAGE_ID,
  SHIELD_REGISTRY_ID,
  SUI_CLOCK_ID,
  RPC_URL,
} from "./types.js";

function userKeypair(): Ed25519Keypair {
  const key = process.env.USER_PRIVATE_KEY;
  if (!key) throw new Error("USER_PRIVATE_KEY env var not set");
  return Ed25519Keypair.fromSecretKey(Buffer.from(key, "base64"));
}

function buildClient(): SuiClient {
  return new SuiClient({ url: RPC_URL });
}

function vecU8(tx: Transaction, s: string) {
  return tx.pure.vector("u8", Array.from(Buffer.from(s, "utf8")));
}

export async function onboardUser(opts: {
  agentAddress:         string;
  obligationId:         string;
  protocol:             "scallop" | "navi";
  collateralAsset:      string;
  debtAsset:            string;
  coinType:             string;
  depositAmount:        bigint;
  maxPerAction:         bigint;
  maxPerWindow:         bigint;
  expiryDurationMs:     number;
  triggerScore:         number;
  minHealthFactorX1000: number;
}): Promise<void> {
  const kp     = userKeypair();
  const client = buildClient();
  const sender = kp.getPublicKey().toSuiAddress();
  const expiresAt = Date.now() + opts.expiryDurationMs;

  console.log("[Onboard] Sender (user/owner):", sender);
  console.log("[Onboard] Agent:              ", opts.agentAddress);
  console.log("[Onboard] Obligation:         ", opts.obligationId);

  // ── TX 1: policy + vault + snapshot ──────────────────────────────────────
  const tx1 = new Transaction();
  tx1.setSender(sender);

  // 1a. Create and share RiskPolicy
  tx1.moveCall({
    target: `${PACKAGE_ID}::risk_policy::create_and_share_policy`,
    arguments: [
      tx1.pure.u8(opts.triggerScore),
      tx1.pure.u64(opts.maxPerAction),
      tx1.pure.u64(opts.maxPerWindow),
      tx1.pure.u64(expiresAt),
      tx1.pure.u64(opts.minHealthFactorX1000),
    ],
  });

  // 1b. Create ShieldVault and deposit initial funds (split from gas coin)
  const [depositCoin] = tx1.splitCoins(tx1.gas, [tx1.pure.u64(opts.depositAmount)]);
  tx1.moveCall({
    target: `${PACKAGE_ID}::shield_vault::create_and_deposit`,
    typeArguments: [opts.coinType],
    arguments: [
      depositCoin,
      tx1.pure.u64(opts.maxPerAction),
      tx1.pure.u64(opts.maxPerWindow),
      tx1.pure.u64(86_400_000), // 24h rolling window
      tx1.object(SUI_CLOCK_ID),
    ],
  });

  // 1c. Create shared RiskSnapshot keyed to obligation_id (not position_id — new API)
  tx1.moveCall({
    target: `${PACKAGE_ID}::shield_oracle::create_snapshot`,
    arguments: [
      tx1.pure.address(opts.obligationId),
      tx1.pure.address(opts.agentAddress),
      tx1.object(SUI_CLOCK_ID),
    ],
  });

  console.log("[Onboard] Submitting TX1 (policy + vault + snapshot) ...");
  const r1 = await client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx1,
    options: { showEffects: true, showObjectChanges: true },
  });
  console.log("[Onboard] TX1:", r1.digest, r1.effects?.status.status);

  if (r1.effects?.status.status !== "success") {
    console.error("[Onboard] TX1 failed:", r1.effects?.status.error);
    return;
  }

  const policyChange   = r1.objectChanges?.find((c) => c.type === "created" && c.objectType?.includes("risk_policy::RiskPolicy"));
  const vaultChange    = r1.objectChanges?.find((c) => c.type === "created" && c.objectType?.includes("shield_vault::ShieldVault"));
  const snapshotChange = r1.objectChanges?.find((c) => c.type === "created" && c.objectType?.includes("shield_oracle::RiskSnapshot"));

  const policyId   = policyChange?.type   === "created" ? policyChange.objectId   : "";
  const vaultId    = vaultChange?.type    === "created" ? vaultChange.objectId    : "";
  const snapshotId = snapshotChange?.type === "created" ? snapshotChange.objectId : "";

  console.log("[Onboard] RiskPolicy:   ", policyId);
  console.log("[Onboard] ShieldVault:  ", vaultId);
  console.log("[Onboard] RiskSnapshot: ", snapshotId);

  if (!policyId || !vaultId || !snapshotId) {
    console.error("[Onboard] Missing IDs from TX1. Aborting.");
    return;
  }

  // ── TX 2: create delegation + register position ────────────────────────────
  // create_delegation binds agent to a specific policy_id
  // register_position needs vault_id, policy_id, snapshot_id from TX1
  const tx2 = new Transaction();
  tx2.setSender(sender);

  // 2a. Create GuardianDelegation (shared, owner can revoke at any time)
  tx2.moveCall({
    target: `${PACKAGE_ID}::guardian_cap::create_delegation`,
    arguments: [
      tx2.pure.address(opts.agentAddress),
      tx2.pure.id(policyId),
      tx2.pure.u64(expiresAt),
    ],
  });

  // 2b. Register the obligation in ShieldRegistry (shared table)
  // New signature: register_position(registry, protocol, obligation_id,
  //                 vault_id, policy_id, snapshot_id, collateral_asset, debt_asset, clock)
  tx2.moveCall({
    target: `${PACKAGE_ID}::shield_registry::register_position`,
    arguments: [
      tx2.object(SHIELD_REGISTRY_ID),
      vecU8(tx2, opts.protocol),
      tx2.pure.address(opts.obligationId),
      tx2.pure.id(vaultId),
      tx2.pure.id(policyId),
      tx2.pure.id(snapshotId),
      vecU8(tx2, opts.collateralAsset),
      vecU8(tx2, opts.debtAsset),
      tx2.object(SUI_CLOCK_ID),
    ],
  });

  console.log("[Onboard] Submitting TX2 (delegation + registry) ...");
  const r2 = await client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx2,
    options: { showEffects: true, showObjectChanges: true },
  });
  console.log("[Onboard] TX2:", r2.digest, r2.effects?.status.status);

  if (r2.effects?.status.status !== "success") {
    console.error("[Onboard] TX2 failed:", r2.effects?.status.error);
    return;
  }

  const delegationChange = r2.objectChanges?.find(
    (c) => c.type === "created" && c.objectType?.includes("guardian_cap::GuardianDelegation"),
  );
  const delegationId = delegationChange?.type === "created" ? delegationChange.objectId : "";

  console.log("[Onboard] GuardianDelegation:", delegationId);
  console.log("");
  console.log("=== Add these to Sefi/.env ===");
  console.log(`RISK_POLICY_ID=${policyId}`);
  console.log(`VAULT_ID=${vaultId}`);
  console.log(`SNAPSHOT_ID=${snapshotId}`);
  console.log(`GUARDIAN_DELEGATION_ID=${delegationId}`);
  console.log("==============================");
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith("onboard_user.ts") ||
    process.argv[1]?.endsWith("onboard_user.js")) {
  onboardUser({
    agentAddress:         process.env.AGENT_ADDRESS         ?? "",
    obligationId:         process.env.OBLIGATION_ID         ?? "",
    protocol:             (process.env.PROTOCOL ?? "scallop") as "scallop" | "navi",
    collateralAsset:      process.env.COLLATERAL_ASSET      ?? "SUI",
    debtAsset:            process.env.DEBT_ASSET            ?? "SUI",
    coinType:             process.env.COIN_TYPE             ?? "0x2::sui::SUI",
    depositAmount:        BigInt(process.env.DEPOSIT_AMOUNT ?? "50000000"),
    maxPerAction:         BigInt(process.env.MAX_PER_ACTION ?? "25000000"),
    maxPerWindow:         BigInt(process.env.MAX_PER_WINDOW ?? "100000000"),
    expiryDurationMs:     30 * 24 * 60 * 60 * 1000, // 30 days
    triggerScore:         Number(process.env.TRIGGER_SCORE  ?? "75"),
    minHealthFactorX1000: 1200,
  }).catch(console.error);
}
