/**
 * One-time user onboarding script.
 *
 * TX 1: create_and_share_policy → mint_and_transfer_guardian_cap → register_position
 * TX 2: create_snapshot → create_and_deposit (vault)
 *
 * Run: AGENT_ADDRESS=... tsx src/onboard_user.ts
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
  // Base64-decode the 32-byte seed and pass as Uint8Array
  return Ed25519Keypair.fromSecretKey(Buffer.from(key, "base64"));
}

function buildClient(): SuiClient {
  return new SuiClient({ url: RPC_URL });
}

/** Encode a UTF-8 string as a Move vector<u8> argument */
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

  // ── TX 1: policy + guardian cap + register position ──────────────────────
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

  // 1b. Mint GuardianCap and transfer to agent address
  tx1.moveCall({
    target: `${PACKAGE_ID}::guardian_cap::mint_and_transfer_guardian_cap`,
    arguments: [
      tx1.pure.address(opts.agentAddress),
      tx1.pure.u64(expiresAt),
    ],
  });

  // 1c. Register the obligation in ShieldRegistry
  // register_position(registry, protocol: vector<u8>, obligation_id: address,
  //                   collateral_asset: vector<u8>, debt_asset: vector<u8>,
  //                   trigger_score_override: u8, use_override: bool)
  tx1.moveCall({
    target: `${PACKAGE_ID}::shield_registry::register_position`,
    arguments: [
      tx1.object(SHIELD_REGISTRY_ID),
      vecU8(tx1, opts.protocol),
      tx1.pure.address(opts.obligationId),
      vecU8(tx1, opts.collateralAsset),
      vecU8(tx1, opts.debtAsset),
      tx1.pure.u8(opts.triggerScore),
      tx1.pure.bool(false), // don't override — use policy trigger_score
    ],
  });

  console.log("[Onboard] Submitting TX1 ...");
  const r1 = await client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx1,
    options: { showEffects: true, showObjectChanges: true },
  });
  console.log("[Onboard] TX1:", r1.digest, r1.effects?.status.status);

  // Extract ProtectedPosition object created in TX1
  const positionChange = r1.objectChanges?.find(
    (c) => c.type === "created" && c.objectType?.includes("shield_registry::ProtectedPosition"),
  );
  const guardianCapChange = r1.objectChanges?.find(
    (c) => c.type === "created" && c.objectType?.includes("guardian_cap::GuardianCap"),
  );
  const policyChange = r1.objectChanges?.find(
    (c) => c.type === "created" && c.objectType?.includes("risk_policy::RiskPolicy"),
  );

  const positionId    = positionChange?.type    === "created" ? positionChange.objectId    : "";
  const guardianCapId = guardianCapChange?.type === "created" ? guardianCapChange.objectId : "";
  const policyId      = policyChange?.type      === "created" ? policyChange.objectId      : "";

  console.log("[Onboard] RiskPolicy:        ", policyId);
  console.log("[Onboard] GuardianCap:       ", guardianCapId);
  console.log("[Onboard] ProtectedPosition: ", positionId);

  if (!positionId) {
    console.error("[Onboard] Could not find ProtectedPosition in TX1 output. Aborting.");
    return;
  }

  // ── TX 2: create snapshot + create vault ─────────────────────────────────
  const tx2 = new Transaction();
  tx2.setSender(sender);

  // 2a. Create shared RiskSnapshot for this position
  // create_snapshot(position_id: ID, agent: address, clock: &Clock)
  tx2.moveCall({
    target: `${PACKAGE_ID}::shield_oracle::create_snapshot`,
    arguments: [
      tx2.pure.id(positionId),
      tx2.pure.address(opts.agentAddress),
      tx2.object(SUI_CLOCK_ID),
    ],
  });

  // 2b. Split coins for vault deposit, create vault
  // create_and_deposit<T>(deposit: Coin<T>, max_per_action, max_per_window, window_ms, clock)
  const [depositCoin] = tx2.splitCoins(tx2.gas, [tx2.pure.u64(opts.depositAmount)]);
  tx2.moveCall({
    target: `${PACKAGE_ID}::shield_vault::create_and_deposit`,
    typeArguments: [opts.coinType],
    arguments: [
      depositCoin,
      tx2.pure.u64(opts.maxPerAction),
      tx2.pure.u64(opts.maxPerWindow),
      tx2.pure.u64(86_400_000), // 24h rolling window in ms
      tx2.object(SUI_CLOCK_ID),
    ],
  });

  console.log("[Onboard] Submitting TX2 ...");
  const r2 = await client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx2,
    options: { showEffects: true, showObjectChanges: true },
  });
  console.log("[Onboard] TX2:", r2.digest, r2.effects?.status.status);

  const snapshotChange = r2.objectChanges?.find(
    (c) => c.type === "created" && c.objectType?.includes("shield_oracle::RiskSnapshot"),
  );
  const vaultChange = r2.objectChanges?.find(
    (c) => c.type === "created" && c.objectType?.includes("shield_vault::ShieldVault"),
  );

  const snapshotId = snapshotChange?.type === "created" ? snapshotChange.objectId : "";
  const vaultId    = vaultChange?.type    === "created" ? vaultChange.objectId    : "";

  console.log("[Onboard] RiskSnapshot: ", snapshotId);
  console.log("[Onboard] ShieldVault:  ", vaultId);
  console.log("");
  console.log("=== Add these to ptb/.env ===");
  console.log(`RISK_POLICY_ID=${policyId}`);
  console.log(`GUARDIAN_CAP_ID=${guardianCapId}`);
  console.log(`POSITION_ID=${positionId}`);
  console.log(`SNAPSHOT_ID=${snapshotId}`);
  console.log(`VAULT_ID=${vaultId}`);
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
