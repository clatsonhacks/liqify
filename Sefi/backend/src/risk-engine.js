/**
 * liquifi risk engine: deterministic scoring + reason codes + an AI explanation.
 *
 * Score weights (person2.md):
 *   40% position risk (health factor / liquidation distance)
 *   25% price volatility
 *   20% DeepBook liquidity
 *   15% oracle deviation / market stress
 *
 * The numeric score and reason-code bit flags are 100% deterministic. Only the
 * human-readable `reason` text is produced by OpenAI (gpt-5), with a deterministic
 * template fallback so the agent loop never depends on the LLM being available.
 */

// Reason-code bit flags — must match ptb/dist/types.js
export const REASON = {
  LOW_HEALTH_FACTOR: 1,
  PRICE_DROP: 2,
  STALE_ORACLE: 4,
  LOW_LIQUIDITY: 8,
  HIGH_VOLATILITY: 16,
  LOW_RESERVE: 32,
};

const clamp = (min, max, v) => Math.max(min, Math.min(max, v));

export function severityFromScore(score) {
  if (score >= 85) return { level: 'emergency', code: 3 };
  if (score >= 70) return { level: 'guarded', code: 2 };
  if (score >= 45) return { level: 'watch', code: 1 };
  return { level: 'normal', code: 0 };
}

/**
 * @param {object} i
 * @param {number|null} i.healthFactor          live HF (1.0 = liquidation boundary)
 * @param {number} i.minHealthFactor            configured safe target (e.g. 1.2)
 * @param {number|null} i.priceChangePct         24h % change (signed)
 * @param {number|null} i.liquidityScore         0..1 (null => unknown/thin)
 * @param {number|null} i.oracleAgeMs
 * @param {number} i.maxOracleAgeMs
 * @param {number|null} [i.reserveAvailable]
 * @param {number|null} [i.requiredRescue]
 * @returns {{score:number, severity:string, severityCode:number, reasonCodes:number, reasons:string[], subRisks:object, hasHealthFactor:boolean}}
 */
export function computeRiskScore(i) {
  const safeHF = i.minHealthFactor > 1 ? i.minHealthFactor : 1.2;
  const hasHF = Number.isFinite(i.healthFactor);

  // position risk: HF >= safeHF -> 0, HF <= 1.0 -> 1
  const positionRisk = hasHF ? clamp(0, 1, (safeHF - i.healthFactor) / (safeHF - 1.0)) : 0;

  // volatility: |24h change| scaled; 10% -> 1.0
  const pct = Number.isFinite(i.priceChangePct) ? Math.abs(i.priceChangePct) : 0;
  const volatilityRisk = clamp(0, 1, pct / 10);

  // liquidity: unknown/thin treated as elevated (0.7); else inverse of score
  const liquidityRisk = i.liquidityScore == null ? 0.7 : clamp(0, 1, 1 - i.liquidityScore);

  // oracle staleness: age/maxAge -> 1 when stale
  const oracleRisk =
    Number.isFinite(i.oracleAgeMs) && i.maxOracleAgeMs > 0
      ? clamp(0, 1, i.oracleAgeMs / i.maxOracleAgeMs)
      : 0;

  let score = Math.round(
    40 * positionRisk + 25 * volatilityRisk + 20 * liquidityRisk + 15 * oracleRisk
  );

  // Direct protocol-threshold escalation (whitepaper trigger bands): a position at or
  // near the liquidation boundary is an emergency regardless of the weighted blend.
  // HF <= 1.0 (liquidatable) -> >=95; HF <= 1.05 (critical buffer) -> >=85.
  if (hasHF) {
    if (i.healthFactor <= 1.0) score = Math.max(score, 95);
    else if (i.healthFactor <= 1.05) score = Math.max(score, 85);
  }
  score = Math.min(100, score);

  // reason codes + human reason fragments
  let codes = 0;
  const reasons = [];
  if (hasHF && i.healthFactor < safeHF) {
    codes |= REASON.LOW_HEALTH_FACTOR;
    reasons.push(`health factor ${i.healthFactor.toFixed(3)} below safe target ${safeHF}`);
  }
  if (Number.isFinite(i.priceChangePct) && i.priceChangePct <= -5) {
    codes |= REASON.PRICE_DROP;
    reasons.push(`collateral price down ${i.priceChangePct.toFixed(1)}% (24h)`);
  }
  if (pct >= 10) {
    codes |= REASON.HIGH_VOLATILITY;
    reasons.push(`high volatility (${pct.toFixed(1)}% move)`);
  }
  if (Number.isFinite(i.oracleAgeMs) && i.oracleAgeMs > i.maxOracleAgeMs) {
    codes |= REASON.STALE_ORACLE;
    reasons.push(`oracle stale (${Math.round(i.oracleAgeMs / 1000)}s old)`);
  }
  if (i.liquidityScore == null || i.liquidityScore < 0.3) {
    codes |= REASON.LOW_LIQUIDITY;
    reasons.push(i.liquidityScore == null ? 'DeepBook liquidity unknown/thin' : `low DeepBook liquidity (${i.liquidityScore})`);
  }
  if (
    Number.isFinite(i.reserveAvailable) &&
    Number.isFinite(i.requiredRescue) &&
    i.reserveAvailable < i.requiredRescue
  ) {
    codes |= REASON.LOW_RESERVE;
    reasons.push('vault reserve below required rescue amount');
  }

  const sev = severityFromScore(score);
  return {
    score,
    severity: sev.level,
    severityCode: sev.code,
    reasonCodes: codes,
    reasons,
    subRisks: { positionRisk, volatilityRisk, liquidityRisk, oracleRisk },
    hasHealthFactor: hasHF,
  };
}

/** Deterministic fallback explanation (used when OpenAI is unavailable). */
function templateExplanation(scoreResult, recommendedAction) {
  const reasonText = scoreResult.reasons.length
    ? scoreResult.reasons.join('; ')
    : 'position within safe parameters';
  const verb = recommendedAction === 'topup' ? 'top up collateral' : 'repay debt';
  const action =
    scoreResult.severity === 'emergency'
      ? `Recommend immediate rescue: ${verb}.`
      : scoreResult.severity === 'guarded'
        ? `Pre-staging a rescue (${verb}); monitoring closely.`
        : 'No action required.';
  return `Risk ${scoreResult.score}/100 (${scoreResult.severity}). ${reasonText}. ${action}`;
}

/**
 * Produce a human-readable explanation. Uses OpenAI /responses (gpt-5) when a key is
 * configured; otherwise returns the deterministic template. Never throws.
 * @returns {Promise<{reason:string, source:'openai'|'template'}>}
 */
export async function explainRisk(cfg, { scoreResult, recommendedAction, position, market }, fetchImpl = fetch) {
  if (!cfg.openaiApiKey) {
    return { reason: templateExplanation(scoreResult, recommendedAction), source: 'template' };
  }
  try {
    const payload = {
      protocol: position?.protocol,
      collateral_asset: position?.collateral_asset,
      debt_asset: position?.debt_asset,
      health_factor: position?.health_factor,
      risk_score: scoreResult.score,
      severity: scoreResult.severity,
      reason_codes: scoreResult.reasonCodes,
      sub_risks: scoreResult.subRisks,
      market: market
        ? { price: market.mid_price, oracle_age_ms: market.oracle_age_ms, liquidity_score: market.liquidity_score, price_change_pct_24h: market.price_change_pct_24h }
        : null,
      recommended_action: recommendedAction,
    };
    const res = await fetchImpl(`${cfg.openaiApiBaseUrl}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.openaiApiKey}` },
      body: JSON.stringify({
        model: cfg.openaiModel || 'gpt-5',
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: 'You are the liquifi risk guardian. In 1-2 plain-English sentences, explain why this Sui DeFi borrowing position is at the given risk level and what bounded rescue action is recommended. Be concrete and concise. Do not invent numbers beyond those given.',
              },
            ],
          },
          { role: 'user', content: [{ type: 'input_text', text: JSON.stringify(payload) }] },
        ],
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
    const text =
      body.output_text ||
      body.output?.flatMap((o) => o.content || []).map((c) => c.text || c.output_text).find((t) => t) ||
      null;
    if (!text) throw new Error('empty output');
    return { reason: String(text).trim(), source: 'openai' };
  } catch {
    return { reason: templateExplanation(scoreResult, recommendedAction), source: 'template' };
  }
}
