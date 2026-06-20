/**
 * End-to-end rescue demo (no external protocol needed).
 *
 * Proves the full LiquidShield hot-potato flow on testnet:
 *   1. begin_rescue  — validates I1-I5, withdraws coins from vault
 *   2. (protocol step skipped — all coins returned as leftover)
 *   3. complete_rescue — consumes receipt, returns coins, emits ShieldActivatedEvent
 *
 * This fires a real ShieldActivatedEvent on Sui testnet without requiring
 * a live Scallop obligation. With a real obligation the only change would
 * be inserting the Scallop repay call between steps 1 and 3.
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { PACKAGE_ID, SUI_CLOCK_ID, MAX_SNAPSHOT_AGE_MS, ACTION_REPAY, RPC_URL, SUI_TYPE, } from "./types.js";
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
const tx = new Transaction();
tx.setSender(kp.getPublicKey().toSuiAddress());
// Step 1 — validate I1-I5, withdraw rescue funds from vault
const beginResult = tx.moveCall({
    target: `${PACKAGE_ID}::shield_executor::begin_rescue`,
    typeArguments: [coinType],
    arguments: [
        tx.object(capId),
        tx.object(policyId),
        tx.object(snapshotId),
        tx.object(positionId),
        tx.object(vaultId),
        tx.pure.vector("u8", Array.from(Buffer.from(protocol, "utf8"))),
        tx.pure.address(obligId),
        tx.pure.u64(amount),
        tx.pure.u64(MAX_SNAPSHOT_AGE_MS),
        tx.object(SUI_CLOCK_ID),
    ],
});
const rescueCoins = beginResult[0]; // Coin<SUI> with `amount` MIST
const receipt = beginResult[1]; // RescueReceipt hot-potato
// ── In production: insert Scallop repay or deposit_collateral here ─────────
// tx.moveCall({ target: `${SCALLOP_PACKAGE_ID}::repay::repay`, ... });
// For this demo we return all coins as leftover (0 spent on protocol).
// ────────────────────────────────────────────────────────────────────────────
// Step 3 — consume receipt, return coins to vault, emit ShieldActivatedEvent
tx.moveCall({
    target: `${PACKAGE_ID}::shield_executor::complete_rescue`,
    typeArguments: [coinType],
    arguments: [
        receipt,
        tx.object(vaultId),
        rescueCoins, // all coins returned as leftover
        tx.pure.u8(ACTION_REPAY),
    ],
});
// ── Dry-run first ─────────────────────────────────────────────────────────
console.log("[TestRescue] Dry-running ...");
tx.setSender(kp.getPublicKey().toSuiAddress());
const dryTx = new Transaction();
dryTx.setSender(kp.getPublicKey().toSuiAddress());
// rebuild for dry run
const beginDry = dryTx.moveCall({
    target: `${PACKAGE_ID}::shield_executor::begin_rescue`,
    typeArguments: [coinType],
    arguments: [
        dryTx.object(capId),
        dryTx.object(policyId),
        dryTx.object(snapshotId),
        dryTx.object(positionId),
        dryTx.object(vaultId),
        dryTx.pure.vector("u8", Array.from(Buffer.from(protocol, "utf8"))),
        dryTx.pure.address(obligId),
        dryTx.pure.u64(amount),
        dryTx.pure.u64(MAX_SNAPSHOT_AGE_MS),
        dryTx.object(SUI_CLOCK_ID),
    ],
});
dryTx.moveCall({
    target: `${PACKAGE_ID}::shield_executor::complete_rescue`,
    typeArguments: [coinType],
    arguments: [
        beginDry[1],
        dryTx.object(vaultId),
        beginDry[0],
        dryTx.pure.u8(ACTION_REPAY),
    ],
});
const dry = await client.dryRunTransactionBlock({
    transactionBlock: await dryTx.build({ client }),
});
console.log("[TestRescue] Dry-run status:", dry.effects.status.status);
if (dry.effects.status.error) {
    console.error("[TestRescue] Dry-run error:", dry.effects.status.error);
    process.exit(1);
}
const g = dry.effects.gasUsed;
const gasEst = BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate);
console.log("[TestRescue] Gas estimate:", gasEst, "MIST");
// ── Submit ─────────────────────────────────────────────────────────────────
console.log("[TestRescue] Submitting rescue TX ...");
const result = await client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true, showEvents: true },
});
console.log("[TestRescue] TX:", result.digest);
console.log("[TestRescue] Status:", result.effects?.status.status);
if (result.effects?.status.status === "success") {
    const shieldEvent = result.events?.find((e) => e.type.includes("shield_executor::ShieldActivatedEvent"));
    if (shieldEvent) {
        console.log("\n=== ShieldActivatedEvent emitted ===");
        console.log(JSON.stringify(shieldEvent.parsedJson, null, 2));
    }
    console.log("\n[TestRescue] SUCCESS — full LiquidShield rescue flow proven on testnet!");
    console.log("[TestRescue] Explorer:", `https://suiexplorer.com/txblock/${result.digest}?network=testnet`);
}
else {
    console.error("[TestRescue] TX failed:", result.effects?.status.error);
    process.exit(1);
}
