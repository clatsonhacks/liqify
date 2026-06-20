/**
 * liquifi (LiquidShield Guardian) configuration.
 *
 * Loads all Sui / LiquidShield / Scallop / Pyth / DeepBook / agent settings from env.
 * Mirrors the parsing style of config.js but is scoped to the liquifi plane that
 * runs alongside SeFi's Hedera indexer. The Hedera config (config.js) is untouched.
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

function parseDotEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  const result = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const sep = normalized.indexOf('=');
    if (sep <= 0) continue;
    const key = normalized.slice(0, sep).trim();
    if (!key) continue;
    let value = normalized.slice(sep + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      // Strip inline comments on unquoted values (e.g. `RESCUE_AMOUNT=10000000  # note`).
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    result[key] = value;
  }
  return result;
}

function parsePositiveInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return fallback;
  if (parsed > max) return fallback;
  return parsed;
}

function str(value, fallback = '') {
  const v = String(value ?? '').trim();
  return v || fallback;
}

/**
 * Build the liquifi config object from the given env (defaults to process.env,
 * merged with Sefi/.env when reading the real process env).
 */
export function createLiquifiConfig(runtimeEnv = process.env) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const sefiRoot = join(__dirname, '..', '..');
  const backendRoot = join(__dirname, '..');
  const shouldLoadDotEnv = runtimeEnv === process.env;
  // Support .env in either Sefi/.env (SeFi default) or Sefi/backend/.env (next to .env.example).
  // backend/.env wins over root .env; process.env wins over both.
  const rootEnv = shouldLoadDotEnv ? parseDotEnvFile(join(sefiRoot, '.env')) : {};
  const backendEnv = shouldLoadDotEnv ? parseDotEnvFile(join(backendRoot, '.env')) : {};
  const env = { ...rootEnv, ...backendEnv, ...runtimeEnv };

  return {
    // ── Networks ──────────────────────────────────────────────────────────────
    suiGraphqlUrl: str(env.SUI_GRAPHQL_URL, 'https://graphql.testnet.sui.io/graphql'),
    suiRpcUrl: str(env.SUI_RPC_URL, 'https://fullnode.testnet.sui.io:443'),
    suiNetwork: str(env.SUI_NETWORK, 'testnet'),

    // ── LiquidShield deployment ─────────────────────────────────────────────────
    packageId: str(env.LIQUIDSHIELD_PACKAGE_ID),
    shieldRegistryId: str(env.SHIELD_REGISTRY_ID),
    daoOverrideCapId: str(env.DAO_OVERRIDE_CAP_ID),

    // ── Per-position objects (from onboard_user.ts) ─────────────────────────────
    riskPolicyId: str(env.RISK_POLICY_ID),
    vaultId: str(env.VAULT_ID),
    snapshotId: str(env.SNAPSHOT_ID),
    positionId: str(env.POSITION_ID),
    guardianCapId: str(env.GUARDIAN_CAP_ID),
    obligationId: str(env.OBLIGATION_ID),
    protocol: str(env.PROTOCOL, 'scallop'),
    collateralAsset: str(env.COLLATERAL_ASSET, 'SUI'),
    debtAsset: str(env.DEBT_ASSET, 'USDC'),
    coinType: str(env.COIN_TYPE, '0x2::sui::SUI'),

    // ── Agent identity ──────────────────────────────────────────────────────────
    agentAddress: str(env.AGENT_ADDRESS),
    agentPrivateKey: str(env.AGENT_PRIVATE_KEY),
    userPrivateKey: str(env.USER_PRIVATE_KEY),

    // ── Scallop testnet constants ───────────────────────────────────────────────
    scallopPackageId: str(env.SCALLOP_PACKAGE_ID),
    scallopVersionId: str(env.SCALLOP_VERSION_ID),
    scallopMarketId: str(env.SCALLOP_MARKET_ID),
    scallopCoinDecimalsRegistryId: str(env.SCALLOP_COIN_DECIMALS_REGISTRY_ID),
    scallopXOracleId: str(env.SCALLOP_XORACLE_ID),

    // ── Market data (real sources) ──────────────────────────────────────────────
    pythHermesUrl: str(env.PYTH_HERMES_URL, 'https://hermes.pyth.network'),
    pythPriceFeedId: str(env.PYTH_PRICE_FEED_ID),
    deepbookIndexerUrl: str(env.DEEPBOOK_INDEXER_URL, 'https://deepbook-indexer.testnet.mystenlabs.com'),
    deepbookPoolName: str(env.DEEPBOOK_POOL_NAME, 'SUI_DBUSDC'),

    // ── Risk agent loop ─────────────────────────────────────────────────────────
    agentTickMs: parsePositiveInt(env.SEFI_AGENT_TICK_MS, 20000, 2000, 600000),
    triggerScore: parsePositiveInt(env.LIQUIDSHIELD_TRIGGER_SCORE, 85, 1, 100),
    maxSnapshotAgeMs: parsePositiveInt(env.MAX_SNAPSHOT_AGE_MS, 120000, 1000, 3600000),
    minHealthFactor: Number(str(env.MIN_HEALTH_FACTOR, '1.2')) || 1.2,
    rescueAmount: str(env.RESCUE_AMOUNT, '10000000'), // base units; bigint at use site
    autoExecute: str(env.LIQUIDSHIELD_AUTO_EXECUTE, 'true') !== 'false',
    indexPollMs: parsePositiveInt(env.SEFI_LISTEN_DELAY_MS, 5000, 1000, 300000),

    // ── AI explanation (OpenAI gpt-5; reuses SeFi keys) ─────────────────────────
    openaiApiKey: str(env.OPENAI_API_KEY),
    openaiApiBaseUrl: str(env.OPENAI_API_BASE_URL, 'https://api.openai.com/v1'),
    openaiModel: str(env.OPENAI_MODEL_STRONG, 'gpt-5'),
  };
}

/** Quick check that the minimum on-chain wiring is present for the agent to act. */
export function liquifiReadiness(cfg) {
  const missing = [];
  const required = {
    LIQUIDSHIELD_PACKAGE_ID: cfg.packageId,
    RISK_POLICY_ID: cfg.riskPolicyId,
    VAULT_ID: cfg.vaultId,
    SNAPSHOT_ID: cfg.snapshotId,
    POSITION_ID: cfg.positionId,
    GUARDIAN_CAP_ID: cfg.guardianCapId,
    OBLIGATION_ID: cfg.obligationId,
    AGENT_PRIVATE_KEY: cfg.agentPrivateKey,
  };
  for (const [key, value] of Object.entries(required)) {
    if (!value) missing.push(key);
  }
  return { ready: missing.length === 0, missing };
}
