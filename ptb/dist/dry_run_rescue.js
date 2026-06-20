/**
 * Dry-run the full rescue PTB to confirm our LiquidShield invariants pass
 * and diagnose what the Scallop call returns (may abort if obligation is not real).
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { PACKAGE_ID, SCALLOP_PACKAGE_ID, SCALLOP_VERSION_ID, SCALLOP_MARKET_ID, SUI_CLOCK_ID, MAX_SNAPSHOT_AGE_MS, ACTION_REPAY, RPC_URL, SUI_TYPE, } from "./types.js";
const client = new SuiClient({ url: RPC_URL });
function agentKeypair() {
    const s = process.env.AGENT_PRIVATE_KEY;
    if (!s)
        throw new Error("AGENT_PRIVATE_KEY not set");
    return Ed25519Keypair.fromSecretKey(Buffer.from(s, "base64"));
}
const kp = agentKeypair();
const policyId = process.env.RISK_POLICY_ID ?? "";
const vaultId = process.env.VAULT_ID ?? "";
const snapshotId = process.env.SNAPSHOT_ID ?? "";
const positionId = process.env.POSITION_ID ?? "";
const capId = process.env.GUARDIAN_CAP_ID ?? "";
const obligId = process.env.OBLIGATION_ID ?? "";
const amount = BigInt(process.env.RESCUE_AMOUNT ?? "10000000");
const protocol = process.env.PROTOCOL ?? "scallop";
const coinType = process.env.COIN_TYPE ?? SUI_TYPE;
// ── Phase A: dry-run only begin_rescue (our contracts) ─────────────────────
const txA = new Transaction();
txA.setSender(kp.getPublicKey().toSuiAddress());
const beginResult = txA.moveCall({
    target: `${PACKAGE_ID}::shield_executor::begin_rescue`,
    typeArguments: [coinType],
    arguments: [
        txA.object(capId),
        txA.object(policyId),
        txA.object(snapshotId),
        txA.object(positionId),
        txA.object(vaultId),
        txA.pure.vector("u8", Array.from(Buffer.from(protocol, "utf8"))),
        txA.pure.address(obligId),
        txA.pure.u64(amount),
        txA.pure.u64(MAX_SNAPSHOT_AGE_MS),
        txA.object(SUI_CLOCK_ID),
    ],
});
// Transfer the rescue coins to sender so we don't need to consume the receipt
// (dry-run will abort here but lets us see if begin_rescue itself works)
txA.transferObjects([beginResult[0]], txA.pure.address(kp.getPublicKey().toSuiAddress()));
console.log("[DryRun-A] Checking begin_rescue invariants ...");
const dryA = await client.dryRunTransactionBlock({
    transactionBlock: await txA.build({ client }),
});
console.log("[DryRun-A] Status:", dryA.effects.status.status);
if (dryA.effects.status.error) {
    console.log("[DryRun-A] Error:", dryA.effects.status.error);
}
else {
    console.log("[DryRun-A] All I1-I5 invariants PASSED");
}
// ── Phase B: dry-run full PTB including Scallop repay ────────────────────
console.log("\n[DryRun-B] Checking full rescue PTB (including Scallop repay) ...");
const txB = new Transaction();
txB.setSender(kp.getPublicKey().toSuiAddress());
const br = txB.moveCall({
    target: `${PACKAGE_ID}::shield_executor::begin_rescue`,
    typeArguments: [coinType],
    arguments: [
        txB.object(capId),
        txB.object(policyId),
        txB.object(snapshotId),
        txB.object(positionId),
        txB.object(vaultId),
        txB.pure.vector("u8", Array.from(Buffer.from(protocol, "utf8"))),
        txB.pure.address(obligId),
        txB.pure.u64(amount),
        txB.pure.u64(MAX_SNAPSHOT_AGE_MS),
        txB.object(SUI_CLOCK_ID),
    ],
});
const rescueCoins = br[0];
const receipt = br[1];
const [repayPart] = txB.splitCoins(rescueCoins, [txB.pure.u64(amount)]);
txB.moveCall({
    target: `${SCALLOP_PACKAGE_ID}::repay::repay`,
    typeArguments: [coinType],
    arguments: [
        txB.object(SCALLOP_VERSION_ID),
        txB.object(obligId),
        txB.object(SCALLOP_MARKET_ID),
        repayPart,
        txB.object(SUI_CLOCK_ID),
    ],
});
txB.moveCall({
    target: `${PACKAGE_ID}::shield_executor::complete_rescue`,
    typeArguments: [coinType],
    arguments: [
        receipt,
        txB.object(vaultId),
        rescueCoins,
        txB.pure.u8(ACTION_REPAY),
    ],
});
const dryB = await client.dryRunTransactionBlock({
    transactionBlock: await txB.build({ client }),
});
console.log("[DryRun-B] Status:", dryB.effects.status.status);
if (dryB.effects.status.error) {
    console.log("[DryRun-B] Error:", dryB.effects.status.error);
}
else {
    console.log("[DryRun-B] Full PTB PASSED — ready to submit");
    const g = dryB.effects.gasUsed;
    const gas = BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate);
    console.log("[DryRun-B] Gas estimate:", gas, "MIST");
}
