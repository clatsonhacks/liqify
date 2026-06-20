/**
 * Agent submits a fresh risk snapshot before rescue.
 * Run this immediately before scallop_rescue.ts to ensure snapshot is fresh.
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { PACKAGE_ID, SUI_CLOCK_ID, RPC_URL, REASON_LOW_HEALTH_FACTOR, REASON_PRICE_DROP } from "./types.js";
const client = new SuiClient({ url: RPC_URL });
function agentKeypair() {
    const s = process.env.AGENT_PRIVATE_KEY;
    if (!s)
        throw new Error("AGENT_PRIVATE_KEY not set");
    return Ed25519Keypair.fromSecretKey(Buffer.from(s, "base64"));
}
const snapshotId = process.env.SNAPSHOT_ID ?? "";
const riskScore = Number(process.env.RISK_SCORE ?? "90"); // above trigger 75
const healthFactor = Number(process.env.HEALTH_FACTOR ?? "900"); // 0.9x — unhealthy
const kp = agentKeypair();
const tx = new Transaction();
tx.setSender(kp.getPublicKey().toSuiAddress());
// submit_risk_snapshot(snapshot, risk_score, severity, reason_codes,
//   recommended_action, health_factor_x1000, collateral_price_usd_x1e6,
//   price_feed_at_ms, clock)
const reasonCodes = Number(REASON_LOW_HEALTH_FACTOR | REASON_PRICE_DROP); // 1 | 2 = 3
tx.moveCall({
    target: `${PACKAGE_ID}::shield_oracle::submit_risk_snapshot`,
    arguments: [
        tx.object(snapshotId),
        tx.pure.u8(riskScore), // risk_score = 90
        tx.pure.u8(3), // severity = EMERGENCY
        tx.pure.u64(reasonCodes), // LOW_HEALTH_FACTOR | PRICE_DROP
        tx.pure.u8(0), // recommended_action = REPAY
        tx.pure.u64(healthFactor), // health_factor_x1000 = 900 (0.9)
        tx.pure.u64(98_000_000), // collateral_price_usd_x1e6 = $98
        tx.pure.u64(Date.now()), // price_feed_at_ms
        tx.object(SUI_CLOCK_ID),
    ],
});
const r = await client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true },
});
console.log("[SubmitSnapshot] TX:", r.digest, r.effects?.status.status);
console.log("[SubmitSnapshot] Snapshot updated: score=", riskScore, "health=", healthFactor);
