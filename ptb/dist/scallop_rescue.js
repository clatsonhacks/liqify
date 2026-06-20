/**
 * Scallop rescue PTB builder.
 *
 * Calls the strict scallop_adapter entry functions which own the entire rescue
 * flow internally (validate → withdraw → Scallop → emit event). No Coin<T>
 * is ever returned to the PTB caller.
 *
 * Entry functions:
 *   scallop_adapter::execute_scallop_repay<T>  — repay debt
 *   scallop_adapter::execute_scallop_topup<T>  — add collateral
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { PACKAGE_ID, SHIELD_REGISTRY_ID, SCALLOP_VERSION_ID, SCALLOP_MARKET_ID, SUI_CLOCK_ID, MAX_SNAPSHOT_AGE_MS, ACTION_REPAY, RPC_URL, } from "./types.js";
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
 * Calls scallop_adapter::execute_scallop_repay which handles:
 *   begin_rescue → apply_repay → complete_rescue
 * No intermediate Coin<T> is returned to the PTB.
 */
export function buildScallopRepayPTB(params) {
    const tx = new Transaction();
    tx.moveCall({
        target: `${PACKAGE_ID}::scallop_adapter::execute_scallop_repay`,
        typeArguments: [params.coinType],
        arguments: [
            tx.object(params.guardianDelegationId), // &GuardianDelegation (shared)
            tx.object(params.policyId), // &RiskPolicy (shared)
            tx.object(params.snapshotId), // &RiskSnapshot (shared)
            tx.object(params.registryId ?? SHIELD_REGISTRY_ID), // &ShieldRegistry (shared singleton)
            tx.object(params.vaultId), // &mut ShieldVault<T> (shared)
            tx.object(SCALLOP_VERSION_ID), // &Version (Scallop)
            tx.object(params.obligationId), // &mut Obligation (Scallop shared)
            tx.object(SCALLOP_MARKET_ID), // &mut Market (Scallop shared)
            tx.pure.address(params.obligationId), // obligation_id: address (cross-check)
            tx.pure.u64(params.amount),
            tx.pure.u64(MAX_SNAPSHOT_AGE_MS),
            tx.object(SUI_CLOCK_ID),
        ],
    });
    return tx;
}
/**
 * Build an atomic Scallop COLLATERAL TOP-UP rescue PTB.
 *
 * Calls scallop_adapter::execute_scallop_topup which handles:
 *   begin_rescue → apply_collateral → complete_rescue
 */
export function buildScallopTopupPTB(params) {
    const tx = new Transaction();
    tx.moveCall({
        target: `${PACKAGE_ID}::scallop_adapter::execute_scallop_topup`,
        typeArguments: [params.coinType],
        arguments: [
            tx.object(params.guardianDelegationId),
            tx.object(params.policyId),
            tx.object(params.snapshotId),
            tx.object(params.registryId ?? SHIELD_REGISTRY_ID),
            tx.object(params.vaultId),
            tx.object(SCALLOP_VERSION_ID),
            tx.object(params.obligationId),
            tx.object(SCALLOP_MARKET_ID),
            tx.pure.address(params.obligationId),
            tx.pure.u64(params.amount),
            tx.pure.u64(MAX_SNAPSHOT_AGE_MS),
            tx.object(SUI_CLOCK_ID),
        ],
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
        registryId: process.env.SHIELD_REGISTRY_ID ?? SHIELD_REGISTRY_ID,
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
