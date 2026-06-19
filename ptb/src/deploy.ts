/**
 * Deploy the LiquidShield Move package to testnet/mainnet.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=<key> SUI_RPC_URL=<url> npm run deploy
 *
 * After deploy, copy the output IDs into your .env file.
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = join(__dirname, "../../contracts");
const ENV_OUTPUT   = join(__dirname, "../../.env.deployed");

function deploySuiPackage(): {
  packageId: string;
  registryId: string;
  daoCap: string;
  digest: string;
} {
  console.log("[Deploy] Building and publishing Move package...");
  console.log("[Deploy] Contracts dir:", CONTRACTS_DIR);

  // Use the sui CLI to publish (must be installed and configured)
  let output: string;
  try {
    output = execSync(
      `sui client publish --gas-budget 200000000 --json "${CONTRACTS_DIR}"`,
      { encoding: "utf-8" },
    );
  } catch (err) {
    console.error("[Deploy] sui publish failed:", err);
    process.exit(1);
  }

  const result = JSON.parse(output);

  const packageId: string = result.objectChanges
    ?.find((c: Record<string,string>) => c.type === "published")
    ?.packageId ?? "";

  // ShieldRegistry is created via init() in shield_registry.move
  const registryId: string = result.objectChanges
    ?.find(
      (c: Record<string,string>) =>
        c.type === "created" &&
        c.objectType?.includes("ShieldRegistry"),
    )
    ?.objectId ?? "";

  // DAOOverrideCap is created via init() in guardian_cap.move
  const daoCap: string = result.objectChanges
    ?.find(
      (c: Record<string,string>) =>
        c.type === "created" &&
        c.objectType?.includes("DAOOverrideCap"),
    )
    ?.objectId ?? "";

  const digest: string = result.digest ?? "";

  return { packageId, registryId, daoCap, digest };
}

function writeEnvFile(ids: {
  packageId: string;
  registryId: string;
  daoCap: string;
  digest: string;
}): void {
  const content = [
    `# LiquidShield deployment — generated ${new Date().toISOString()}`,
    `LIQUIDSHIELD_PACKAGE_ID=${ids.packageId}`,
    `SHIELD_REGISTRY_ID=${ids.registryId}`,
    `DAO_OVERRIDE_CAP_ID=${ids.daoCap}`,
    `DEPLOY_DIGEST=${ids.digest}`,
    ``,
    `# Fill in after onboard_user.ts:`,
    `# RISK_POLICY_ID=`,
    `# VAULT_ID=`,
    `# SNAPSHOT_ID=`,
    `# POSITION_ID=`,
    `# GUARDIAN_CAP_ID=`,
    `# OBLIGATION_ID=`,
    `# AGENT_ADDRESS=`,
    `# AGENT_PRIVATE_KEY=`,
    `# USER_PRIVATE_KEY=`,
    `# COIN_TYPE=0x2::sui::SUI`,
    `# SCALLOP_PACKAGE_ID=`,
    `# SCALLOP_VERSION_ID=`,
    `# SCALLOP_MARKET_ID=`,
  ].join("\n");

  writeFileSync(ENV_OUTPUT, content, "utf-8");
  console.log("[Deploy] Wrote env template to:", ENV_OUTPUT);
}

// ─── Main ────────────────────────────────────────────────────────────────────

const ids = deploySuiPackage();
console.log("[Deploy] Package ID   :", ids.packageId);
console.log("[Deploy] Registry ID  :", ids.registryId);
console.log("[Deploy] DAOOverrideCap:", ids.daoCap);
console.log("[Deploy] TX Digest    :", ids.digest);
writeEnvFile(ids);
