/**
 * Scallop rescue PTB builder.
 *
 * Atomic rescue flow:
 *   1. shield_executor::begin_rescue    — validate I1-I5, withdraw vault coins
 *   2. scallop::repay::repay            — repay borrowed debt (third-party repay)
 *      OR
 *      scallop::deposit_collateral::deposit_collateral — add collateral
 *   3. shield_executor::complete_rescue — return leftover, emit ShieldActivatedEvent
 *
 * Scallop function signatures (from sdk src/builders/coreBuilder.ts):
 *   repay::repay<T>(version, obligation, market, coin, clock)  — void
 *   deposit_collateral::deposit_collateral<T>(version, obligation, market, coin) — void
 *
 * Leftover handling:
 *   begin_rescue withdraws exactly `amount` coins.
 *   We splitCoins(rescueCoins, [amount]) → repayPart (exact) + rescueCoins (0 remainder).
 *   Scallop call consumes repayPart. The 0-value rescueCoins goes to complete_rescue.
 */

import { SuiClient } from "@mysten/sui/client";
import { Transaction, type TransactionResult } from "@mysten/sui/transactions";
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
 * Scallop's repay::repay takes the coin by value and is void (no change returned).
 * We split the rescue coins into [repayPart, 0-remainder] before the Scallop call
 * so the 0-remainder serves as the leftover coin for complete_rescue.
 */
export function buildScallopRepayPTB(params: RescueParams): Transaction {
  const tx = new Transaction();

  // Step 1 — validate all invariants and withdraw from vault
  const beginResult: TransactionResult = tx.moveCall({
    target: `${PACKAGE_ID}::shield_executor::begin_rescue`,
    typeArguments: [params.coinType],
    arguments: [
      tx.object(params.guardianCapId),
      tx.object(params.policyId),
      tx.object(params.snapshotId),
      tx.object(params.positionId),
      tx.object(params.vaultId),
      tx.pure.vector("u8", Array.from(Buffer.from(params.protocol, "utf8"))),
      tx.pure.address(params.obligationId),
      tx.pure.u64(params.amount),
      tx.pure.u64(MAX_SNAPSHOT_AGE_MS),
      tx.object(SUI_CLOCK_ID),
    ],
  });
  const rescueCoins = beginResult[0]; // Coin<T> with params.amount value
  const receipt     = beginResult[1]; // RescueReceipt (hot-potato)

  // Split out the exact repay amount; rescueCoins becomes the 0-value remainder
  // and will be returned to the vault as "leftover" in step 3.
  const [repayPart] = tx.splitCoins(rescueCoins, [tx.pure.u64(params.amount)]);

  // Step 2 — Scallop third-party repay
  // Function: {protocol_pkg}::repay::repay<T>(version, obligation, market, coin, clock)
  // The obligation owner does NOT need to co-sign — this is the third-party repay path.
  tx.moveCall({
    target: `${SCALLOP_PACKAGE_ID}::repay::repay`,
    typeArguments: [params.coinType],
    arguments: [
      tx.object(SCALLOP_VERSION_ID),
      tx.object(params.obligationId), // &mut Obligation — shared, no owner sig needed
      tx.object(SCALLOP_MARKET_ID),
      repayPart,                      // Coin<T> consumed by repay
      tx.object(SUI_CLOCK_ID),
    ],
  });

  // Step 3 — consume receipt, return 0-value leftover to vault, emit event
  tx.moveCall({
    target: `${PACKAGE_ID}::shield_executor::complete_rescue`,
    typeArguments: [params.coinType],
    arguments: [
      receipt,
      tx.object(params.vaultId),
      rescueCoins, // 0-value remainder after split
      tx.pure.u8(ACTION_REPAY),
    ],
  });

  return tx;
}

/**
 * Build an atomic Scallop COLLATERAL TOP-UP rescue PTB.
 *
 * Scallop's deposit_collateral::deposit_collateral is also void.
 * Same leftover pattern: split → deposit split part → return remainder to vault.
 */
export function buildScallopTopupPTB(params: RescueParams): Transaction {
  const tx = new Transaction();

  // Step 1 — validate + withdraw
  const beginResult: TransactionResult = tx.moveCall({
    target: `${PACKAGE_ID}::shield_executor::begin_rescue`,
    typeArguments: [params.coinType],
    arguments: [
      tx.object(params.guardianCapId),
      tx.object(params.policyId),
      tx.object(params.snapshotId),
      tx.object(params.positionId),
      tx.object(params.vaultId),
      tx.pure.vector("u8", Array.from(Buffer.from(params.protocol, "utf8"))),
      tx.pure.address(params.obligationId),
      tx.pure.u64(params.amount),
      tx.pure.u64(MAX_SNAPSHOT_AGE_MS),
      tx.object(SUI_CLOCK_ID),
    ],
  });
  const rescueCoins = beginResult[0];
  const receipt     = beginResult[1];

  // Split: depositPart = exact amount, rescueCoins = 0 remainder
  const [depositPart] = tx.splitCoins(rescueCoins, [tx.pure.u64(params.amount)]);

  // Step 2 — Scallop deposit collateral
  // Function: {protocol_pkg}::deposit_collateral::deposit_collateral<T>(version, obligation, market, coin)
  tx.moveCall({
    target: `${SCALLOP_PACKAGE_ID}::deposit_collateral::deposit_collateral`,
    typeArguments: [params.coinType],
    arguments: [
      tx.object(SCALLOP_VERSION_ID),
      tx.object(params.obligationId),
      tx.object(SCALLOP_MARKET_ID),
      depositPart,
    ],
  });

  // Step 3 — finalise
  tx.moveCall({
    target: `${PACKAGE_ID}::shield_executor::complete_rescue`,
    typeArguments: [params.coinType],
    arguments: [
      receipt,
      tx.object(params.vaultId),
      rescueCoins, // 0-value remainder
      tx.pure.u8(ACTION_TOPUP),
    ],
  });

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
    policyId:      process.env.RISK_POLICY_ID    ?? "",
    vaultId:       process.env.VAULT_ID          ?? "",
    snapshotId:    process.env.SNAPSHOT_ID       ?? "",
    positionId:    process.env.POSITION_ID       ?? "",
    guardianCapId: process.env.GUARDIAN_CAP_ID   ?? "",
    obligationId:  process.env.OBLIGATION_ID     ?? "",
    protocol:      process.env.PROTOCOL          ?? "scallop",
    amount:        BigInt(process.env.RESCUE_AMOUNT ?? "50000000"),
    coinType:      process.env.COIN_TYPE         ?? _SUI_TYPE,
    actionType:    (Number(process.env.ACTION_TYPE ?? "0") as 0 | 1),
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
