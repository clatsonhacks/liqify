/**
 * Scallop rescue PTB builder.
 *
 * Matches the DEPLOYED LiquidShield package (shield_executor::begin_rescue →
 * Scallop repay/deposit → shield_executor::complete_rescue). begin_rescue returns
 * a Coin<T> + a RescueReceipt (hot-potato); the PTB routes the coin into Scallop
 * and hands the leftover + receipt to complete_rescue, which returns funds to the
 * vault and emits ShieldActivatedEvent. (The newer scallop_adapter design is not
 * on the deployed testnet package, so this builder targets begin_rescue directly.)
 *
 * Flow:
 *   begin_rescue<T> → SplitCoins → repay/deposit_collateral<T> → complete_rescue<T>
 */

import { SuiClient } from "@mysten/sui/client";
import { Transaction, type TransactionObjectArgument } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import {
  PACKAGE_ID,
  SCALLOP_PACKAGE_ID,
  SCALLOP_VERSION_ID,
  SCALLOP_MARKET_ID,
  SUI_CLOCK_ID,
  MAX_SNAPSHOT_AGE_MS,
  ACTION_REPAY,
  ACTION_TOPUP,
  RPC_URL,
  type RescueParams,
} from "./types.js";

function protocolBytes(protocol: string): number[] {
  return Array.from(Buffer.from(String(protocol || "scallop"), "utf8"));
}

/** begin_rescue<T> — returns [Coin<T>, RescueReceipt] (arg order from deployed package). */
function beginRescue(tx: Transaction, params: RescueParams) {
  return tx.moveCall({
    target: `${PACKAGE_ID}::shield_executor::begin_rescue`,
    typeArguments: [params.coinType],
    arguments: [
      tx.object(params.guardianDelegationId), // GuardianCap (agent-owned)
      tx.object(params.policyId),             // &RiskPolicy (shared)
      tx.object(params.snapshotId),           // &RiskSnapshot (shared)
      tx.object(params.positionId!),          // &ProtectedPosition (agent-owned)
      tx.object(params.vaultId),              // &mut ShieldVault<T> (shared)
      tx.pure.vector("u8", protocolBytes(params.protocol)),
      tx.pure.address(params.obligationId),
      tx.pure.u64(params.amount),
      tx.pure.u64(MAX_SNAPSHOT_AGE_MS),
      tx.object(SUI_CLOCK_ID),
    ],
  });
}

/** complete_rescue<T> — returns leftover coin to the vault, emits ShieldActivatedEvent. */
function completeRescue(
  tx: Transaction,
  params: RescueParams,
  receipt: TransactionObjectArgument,
  leftoverCoin: TransactionObjectArgument,
  actionType: number,
) {
  tx.moveCall({
    target: `${PACKAGE_ID}::shield_executor::complete_rescue`,
    typeArguments: [params.coinType],
    arguments: [receipt, tx.object(params.vaultId), leftoverCoin, tx.pure.u8(actionType)],
  });
}

// ─── Client / keypair helpers ─────────────────────────────────────────────────

function buildClient(): SuiClient {
  return new SuiClient({ url: RPC_URL });
}

function agentKeypair(): Ed25519Keypair {
  const secret = process.env.AGENT_PRIVATE_KEY;
  if (!secret) throw new Error("AGENT_PRIVATE_KEY env var not set");
  return Ed25519Keypair.fromSecretKey(Buffer.from(secret, "base64"));
}

// ─── PTB builders ────────────────────────────────────────────────────────────

/**
 * Build an atomic Scallop REPAY rescue PTB.
 *
 * Calls scallop_adapter::execute_scallop_repay which handles:
 *   begin_rescue → apply_repay → complete_rescue
 * No intermediate Coin<T> is returned to the PTB.
 */
export function buildScallopRepayPTB(params: RescueParams): Transaction {
  const tx = new Transaction();
  const [coin, receipt] = beginRescue(tx, params);
  // Split the exact rescue amount and repay it into the Scallop obligation.
  const [repayCoin] = tx.splitCoins(coin, [tx.pure.u64(params.amount)]);
  tx.moveCall({
    target: `${SCALLOP_PACKAGE_ID}::repay::repay`,
    typeArguments: [params.coinType],
    arguments: [
      tx.object(SCALLOP_VERSION_ID), // &Version
      tx.object(params.obligationId), // &mut Obligation
      tx.object(SCALLOP_MARKET_ID), // &mut Market
      repayCoin, // Coin<T>
      tx.object(SUI_CLOCK_ID), // &Clock
    ],
  });
  completeRescue(tx, params, receipt, coin, ACTION_REPAY);
  return tx;
}

/**
 * Build an atomic Scallop COLLATERAL TOP-UP rescue PTB.
 *
 * begin_rescue → deposit_collateral → complete_rescue (leftover returns to vault).
 */
export function buildScallopTopupPTB(params: RescueParams): Transaction {
  const tx = new Transaction();
  const [coin, receipt] = beginRescue(tx, params);
  const [depositCoin] = tx.splitCoins(coin, [tx.pure.u64(params.amount)]);
  tx.moveCall({
    target: `${SCALLOP_PACKAGE_ID}::deposit_collateral::deposit_collateral`,
    typeArguments: [params.coinType],
    arguments: [
      tx.object(SCALLOP_VERSION_ID), // &Version
      tx.object(params.obligationId), // &mut Obligation
      tx.object(SCALLOP_MARKET_ID), // &mut Market
      depositCoin, // Coin<T>
    ],
  });
  completeRescue(tx, params, receipt, coin, ACTION_TOPUP);
  return tx;
}

// ─── Simulation ───────────────────────────────────────────────────────────────

export async function simulateRescue(
  params: RescueParams,
  client: SuiClient,
): Promise<{ success: boolean; gasEstimate: bigint; error?: string }> {
  const kp = agentKeypair();
  const tx = params.actionType === ACTION_REPAY
    ? buildScallopRepayPTB(params)
    : buildScallopTopupPTB(params);

  tx.setSender(kp.getPublicKey().toSuiAddress());

  try {
    const result = await client.dryRunTransactionBlock({
      transactionBlock: await tx.build({ client }),
    });
    const success = result.effects.status.status === "success";
    const g = result.effects.gasUsed;
    const gasEstimate = BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate);
    return success
      ? { success: true, gasEstimate }
      : { success: false, gasEstimate, error: result.effects.status.error };
  } catch (err) {
    return { success: false, gasEstimate: 0n, error: String(err) };
  }
}

// ─── Execute (fail-closed) ────────────────────────────────────────────────────

export async function executeRescue(
  params: RescueParams,
  client: SuiClient,
): Promise<{ digest: string; gasUsed: bigint } | null> {
  const sim = await simulateRescue(params, client);
  if (!sim.success) {
    console.error("[LiquidShield] Simulation failed:", sim.error);
    return null;
  }
  console.log("[LiquidShield] Simulation OK, gas estimate:", sim.gasEstimate, "MIST");

  const kp = agentKeypair();
  const tx = params.actionType === ACTION_REPAY
    ? buildScallopRepayPTB(params)
    : buildScallopTopupPTB(params);

  tx.setSender(kp.getPublicKey().toSuiAddress());
  const result = await client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true, showEvents: true },
  });

  if (result.effects?.status.status !== "success") {
    console.error("[LiquidShield] TX failed:", result.effects?.status.error);
    return null;
  }

  const g = result.effects.gasUsed;
  return {
    digest: result.digest,
    gasUsed: BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate),
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const _SUI_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

if (process.argv[1]?.endsWith("scallop_rescue.ts") ||
    process.argv[1]?.endsWith("scallop_rescue.js")) {
  const client = buildClient();

  const params: RescueParams = {
    policyId:             process.env.RISK_POLICY_ID          ?? "",
    vaultId:              process.env.VAULT_ID                ?? "",
    snapshotId:           process.env.SNAPSHOT_ID             ?? "",
    positionId:           process.env.POSITION_ID             ?? "",
    guardianDelegationId: process.env.GUARDIAN_DELEGATION_ID  ?? "",
    obligationId:         process.env.OBLIGATION_ID           ?? "",
    protocol:             process.env.PROTOCOL                ?? "scallop",
    amount:               BigInt(process.env.RESCUE_AMOUNT    ?? "50000000"),
    coinType:             process.env.COIN_TYPE               ?? _SUI_TYPE,
    actionType:           (Number(process.env.ACTION_TYPE     ?? "0") as 0 | 1),
  };

  executeRescue(params, client).then((r) => {
    if (r) {
      console.log("[LiquidShield] Rescue TX:", r.digest, "gas:", r.gasUsed, "MIST");
    } else {
      console.error("[LiquidShield] Rescue aborted (fail-closed).");
      process.exit(1);
    }
  });
}
