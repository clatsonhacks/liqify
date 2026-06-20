/**
 * Creates a real Scallop testnet Obligation by opening a position and
 * depositing SUI as collateral. Prints the Obligation object ID.
 *
 * Run:
 *   USER_PRIVATE_KEY=<base64-seed> tsx src/create_obligation.ts
 *
 * The printed OBLIGATION_ID goes into ptb/.env and is used by onboard_user.ts
 * when re-registering the position with a real obligation.
 */

import { SuiClient } from "@mysten/sui/client";
import { Transaction, type TransactionResult } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import {
  SCALLOP_PACKAGE_ID,
  SCALLOP_VERSION_ID,
  SCALLOP_MARKET_ID,
  SUI_TYPE,
  RPC_URL,
} from "./types.js";

// 0.1 SUI as collateral — enough to open an obligation without exhausting gas
const COLLATERAL_AMOUNT = 100_000_000n;

function keypair(): Ed25519Keypair {
  const key = process.env.USER_PRIVATE_KEY;
  if (!key) throw new Error("USER_PRIVATE_KEY not set");
  return Ed25519Keypair.fromSecretKey(Buffer.from(key, "base64"));
}

async function main() {
  const kp     = keypair();
  const client = new SuiClient({ url: RPC_URL });
  const sender = kp.getPublicKey().toSuiAddress();
  console.log("[CreateObligation] Sender:", sender);

  const tx = new Transaction();
  tx.setSender(sender);

  // Step 1 — open_obligation returns (Obligation, ObligationKey, HotPotato)
  // Scallop: {protocol_pkg}::open_obligation::open_obligation(version)
  const openResult: TransactionResult = tx.moveCall({
    target: `${SCALLOP_PACKAGE_ID}::open_obligation::open_obligation`,
    arguments: [tx.object(SCALLOP_VERSION_ID)],
  });
  const obligation     = openResult[0]; // &mut Obligation (shared after return)
  const obligationKey  = openResult[1]; // ObligationKey NFT → transfer to sender
  const hotPotato      = openResult[2]; // HotPotato — must be consumed this TX

  // Step 2 — split SUI for collateral deposit
  const [collateral] = tx.splitCoins(tx.gas, [tx.pure.u64(COLLATERAL_AMOUNT)]);

  // Step 3 — deposit_collateral::deposit_collateral<T>(version, obligation, market, coin)
  tx.moveCall({
    target: `${SCALLOP_PACKAGE_ID}::deposit_collateral::deposit_collateral`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx.object(SCALLOP_VERSION_ID),
      obligation,
      tx.object(SCALLOP_MARKET_ID),
      collateral,
    ],
  });

  // Step 4 — return_obligation to consume the hot potato and share the obligation
  // open_obligation::return_obligation(version, obligation, hotPotato)
  tx.moveCall({
    target: `${SCALLOP_PACKAGE_ID}::open_obligation::return_obligation`,
    arguments: [
      tx.object(SCALLOP_VERSION_ID),
      obligation,
      hotPotato,
    ],
  });

  // Step 5 — transfer ObligationKey to sender (needed to borrow/withdraw later)
  tx.transferObjects([obligationKey], tx.pure.address(sender));

  console.log("[CreateObligation] Submitting TX ...");
  const result = await client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true },
  });

  console.log("[CreateObligation] TX:", result.digest, result.effects?.status.status);

  if (result.effects?.status.status !== "success") {
    console.error("[CreateObligation] Failed:", result.effects?.status.error);
    process.exit(1);
  }

  // Find the created Obligation object (shared)
  const obligationChange = result.objectChanges?.find(
    (c) => c.type === "created" && c.objectType?.includes("::obligation::Obligation"),
  );
  const obligationKeyChange = result.objectChanges?.find(
    (c) => c.type === "created" && c.objectType?.includes("::obligation::ObligationKey"),
  );

  const obligationId    = obligationChange?.type    === "created" ? obligationChange.objectId    : "";
  const obligationKeyId = obligationKeyChange?.type === "created" ? obligationKeyChange.objectId : "";

  console.log("");
  console.log("=== Scallop Obligation Created ===");
  console.log("OBLIGATION_ID=", obligationId);
  console.log("OBLIGATION_KEY_ID=", obligationKeyId);
  console.log("===================================");
  console.log("");
  console.log("Add OBLIGATION_ID to ptb/.env, then re-run onboard_user.ts");
  console.log("to register this position with a real Scallop obligation.");
}

main().catch(console.error);
