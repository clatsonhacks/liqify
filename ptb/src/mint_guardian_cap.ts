/**
 * Creates a new GuardianDelegation (shared object) granting an agent rescue rights.
 *
 * Replaces the old mint_and_transfer_guardian_cap pattern. The delegation is a
 * SHARED object — the owner can revoke it at any time without the agent's co-sign.
 *
 * Run after onboard_user.ts if you need a standalone delegation (e.g., rotating agents):
 *   USER_PRIVATE_KEY=<base64-seed> \
 *   NEW_AGENT_ADDRESS=0x... \
 *   RISK_POLICY_ID=0x... \
 *   tsx src/mint_guardian_cap.ts
 */

import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import { PACKAGE_ID, RPC_URL } from "./types.js";

// Delegation valid for 30 days from now
const EXPIRY_MS = Date.now() + 30 * 24 * 60 * 60 * 1000;

function deployerKeypair(): Ed25519Keypair {
  const key = process.env.USER_PRIVATE_KEY;
  if (!key) throw new Error("USER_PRIVATE_KEY not set");
  return Ed25519Keypair.fromSecretKey(Buffer.from(key, "base64"));
}

async function main() {
  const newAgentAddress = process.env.NEW_AGENT_ADDRESS;
  if (!newAgentAddress) throw new Error("NEW_AGENT_ADDRESS not set");

  const policyId = process.env.RISK_POLICY_ID;
  if (!policyId) throw new Error("RISK_POLICY_ID not set");

  const kp     = deployerKeypair();
  const client = new SuiClient({ url: RPC_URL });
  const sender = kp.getPublicKey().toSuiAddress();
  console.log("[CreateDelegation] Owner:    ", sender);
  console.log("[CreateDelegation] Agent:    ", newAgentAddress);
  console.log("[CreateDelegation] PolicyID: ", policyId);
  console.log("[CreateDelegation] Expires:  ", new Date(EXPIRY_MS).toISOString());

  const tx = new Transaction();
  tx.setSender(sender);

  // guardian_cap::create_delegation(agent: address, policy_id: ID, expires_at_ms: u64)
  tx.moveCall({
    target: `${PACKAGE_ID}::guardian_cap::create_delegation`,
    arguments: [
      tx.pure.address(newAgentAddress),
      tx.pure.id(policyId),
      tx.pure.u64(EXPIRY_MS),
    ],
  });

  console.log("[CreateDelegation] Submitting TX ...");
  const result = await client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true },
  });

  console.log("[CreateDelegation] TX:", result.digest, result.effects?.status.status);

  if (result.effects?.status.status !== "success") {
    console.error("[CreateDelegation] Failed:", result.effects?.status.error);
    process.exit(1);
  }

  const delegationChange = result.objectChanges?.find(
    (c) => c.type === "created" && c.objectType?.includes("guardian_cap::GuardianDelegation"),
  );
  const delegationId = delegationChange?.type === "created" ? delegationChange.objectId : "";

  console.log("");
  console.log("=== GuardianDelegation Created ===");
  console.log("GUARDIAN_DELEGATION_ID=", delegationId);
  console.log("AGENT_ADDRESS=", newAgentAddress);
  console.log("==================================");
  console.log("Update Sefi/.env with GUARDIAN_DELEGATION_ID.");
  console.log(`Fund the agent address with testnet SUI for gas:`);
  console.log(`  https://faucet.sui.io/?address=${newAgentAddress}`);
}

main().catch(console.error);
