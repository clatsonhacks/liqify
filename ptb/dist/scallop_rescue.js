/**
 * Scallop rescue PTB builder.
 *
 * Matches the DEPLOYED LiquidShield package (0xabc270e8…), where the rescue flow
 * lives entirely inside the strict scallop_adapter entry functions:
 *
 *   scallop_adapter::execute_scallop_repay<T>  (action_type 0)
 *   scallop_adapter::execute_scallop_topup<T>  (action_type 1)
 *
 * Each entry fn owns begin_rescue → apply_repay/apply_collateral → complete_rescue
 * internally. shield_executor::begin_rescue is public(package) and CANNOT be called
 * from a PTB, so we make a single moveCall to the adapter. No intermediate Coin<T>
 * is ever surfaced to the PTB. The 4th validation object is the shared
 * &ShieldRegistry (singleton), not a per-user ProtectedPosition.
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { PACKAGE_ID, SHIELD_REGISTRY_ID, SCALLOP_VERSION_ID, SCALLOP_MARKET_ID, SUI_CLOCK_ID, MAX_SNAPSHOT_AGE_MS, ACTION_REPAY, RPC_URL, } from "./types.js";
/**
 * Shared argument list for both scallop_adapter entry functions — they have
 * identical signatures and differ only in the Scallop call made internally.
 */
function adapterArgs(tx, params) {
    return [
        tx.object(params.guardianDelegationId), // &GuardianDelegation (agent-owned)
        tx.object(params.policyId), // &RiskPolicy (shared)
        tx.object(params.snapshotId), // &RiskSnapshot (shared)
        tx.object(params.registryId || SHIELD_REGISTRY_ID), // &ShieldRegistry (shared singleton)
        tx.object(params.vaultId), // &mut ShieldVault<T> (shared)
        tx.object(SCALLOP_VERSION_ID), // &Version
        tx.object(params.obligationId), // &mut Obligation
        tx.object(SCALLOP_MARKET_ID), // &mut Market
        tx.pure.address(params.obligationId), // obligation_id: address
        tx.pure.u64(params.amount), // amount: u64
        tx.pure.u64(MAX_SNAPSHOT_AGE_MS), // max_snapshot_age_ms: u64
        tx.object(SUI_CLOCK_ID), // &Clock
    ];
}
// ─── Client / keypair helpers ─────────────────────────────────────────────────
function buildClient() {
    return new SuiClient({ url: RPC_URL });
}
function agentKeypair() {
    const secret = process.env.AGENT_PRIVATE_KEY;
    if (!secret)
        throw new Error("AGENT_PRIVATE_KEY env var not set");
    return Ed25519Keypair.fromSecretKey(Buffer.from(secret, "base64"));
}
// ─── PTB builders ────────────────────────────────────────────────────────────
/**
 * Build an atomic Scallop REPAY rescue PTB.
 *
 * Single call to scallop_adapter::execute_scallop_repay<T>, which internally runs
 * begin_rescue → apply_repay → complete_rescue. No Coin<T> is returned to the PTB.
 */
export function buildScallopRepayPTB(params) {
    const tx = new Transaction();
    tx.moveCall({
        target: `${PACKAGE_ID}::scallop_adapter::execute_scallop_repay`,
        typeArguments: [params.coinType],
        arguments: adapterArgs(tx, params),
    });
    return tx;
}
/**
 * Build an atomic Scallop COLLATERAL TOP-UP rescue PTB.
 *
 * Single call to scallop_adapter::execute_scallop_topup<T>, which internally runs
 * begin_rescue → apply_collateral → complete_rescue.
 */
export function buildScallopTopupPTB(params) {
    const tx = new Transaction();
    tx.moveCall({
        target: `${PACKAGE_ID}::scallop_adapter::execute_scallop_topup`,
        typeArguments: [params.coinType],
        arguments: adapterArgs(tx, params),
    });
    return tx;
}
// ─── Simulation ───────────────────────────────────────────────────────────────
export async function simulateRescue(params, client) {
    const kp = agentKeypair();
    const tx = params.actionType === ACTION_REPAY
        ? buildScallopRepayPTB(params)
        : buildScallopTopupPTB(params);
    tx.setSender(kp.getPublicKey().toSuiAddress());
    // Set an explicit gas budget so tx.build() does NOT trigger the SDK's automatic
    // budget estimation. Auto-estimation runs its own dry-run and, when the rescue
    // Move call aborts, throws an opaque "could not automatically determine a budget:
    // MoveAbort(...)" that hides the real on-chain error. With a fixed budget the abort
    // flows through dryRunTransactionBlock below and surfaces as a clean status.error.
    tx.setGasBudget(Number(process.env.MAX_GAS ?? "200000000"));
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
    }
    catch (err) {
        return { success: false, gasEstimate: 0n, error: String(err) };
    }
}
// ─── Execute (fail-closed) ────────────────────────────────────────────────────
export async function executeRescue(params, client) {
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
    const params = {
        policyId: process.env.RISK_POLICY_ID ?? "",
        vaultId: process.env.VAULT_ID ?? "",
        snapshotId: process.env.SNAPSHOT_ID ?? "",
        positionId: process.env.POSITION_ID ?? "",
        guardianDelegationId: process.env.GUARDIAN_DELEGATION_ID ?? "",
        obligationId: process.env.OBLIGATION_ID ?? "",
        protocol: process.env.PROTOCOL ?? "scallop",
        amount: BigInt(process.env.RESCUE_AMOUNT ?? "50000000"),
        coinType: process.env.COIN_TYPE ?? _SUI_TYPE,
        actionType: Number(process.env.ACTION_TYPE ?? "0"),
    };
    executeRescue(params, client).then((r) => {
        if (r) {
            console.log("[LiquidShield] Rescue TX:", r.digest, "gas:", r.gasUsed, "MIST");
        }
        else {
            console.error("[LiquidShield] Rescue aborted (fail-closed).");
            process.exit(1);
        }
    });
}
