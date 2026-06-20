/**
 * Scallop obligation reader for liquifi `positions`.
 *
 * Uses the Scallop SDK query layer (getObligationAccountById) which returns real
 * USD-denominated collateral/debt and a risk level. Scallop's risk level >= 1 means
 * liquidatable, so we derive a health-factor-like metric as 1/riskLevel.
 *
 * The Obligation is a shared object; third-party repay (our rescue) needs only it,
 * no ObligationKey — consistent with the rescue PTB.
 *
 * Health-factor fallback: if the SDK is unavailable, the deriver can still compute
 * collateral_value/debt_value from raw amounts + the Pyth price (market_snapshots).
 */

import { Scallop } from '@scallop-io/sui-scallop-sdk';

/** Map Scallop's numeric risk level to a coarse label aligned with our trigger bands. */
export function riskLevelLabel(scallopRiskLevel) {
  const r = Number(scallopRiskLevel);
  if (!Number.isFinite(r)) return 'unknown';
  if (r >= 1.0) return 'emergency';
  if (r >= 0.85) return 'guarded';
  if (r >= 0.6) return 'watch';
  return 'normal';
}

export class ScallopReader {
  /** @param {object} cfg createLiquifiConfig() result */
  constructor(cfg) {
    this.cfg = cfg;
    this.query = null;
    this.initPromise = null;
    this.unavailable = false;
  }

  async ensureQuery() {
    if (this.query) return this.query;
    if (this.unavailable) return null;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          const scallop = new Scallop({ networkType: this.cfg.suiNetwork || 'testnet' });
          const query = await scallop.createScallopQuery();
          if (typeof query.init === 'function') await query.init();
          this.query = query;
          return query;
        } catch (err) {
          this.unavailable = true;
          this.lastError = String(err?.message || err);
          return null;
        }
      })();
    }
    return this.initPromise;
  }

  /**
   * Read live obligation account state.
   * @param {string} obligationId
   * @returns {Promise<{collateralValue:number, debtValue:number, scallopRiskLevel:number, healthFactor:number|null, riskLevel:string}|null>}
   */
  async readObligation(obligationId) {
    if (!obligationId) return null;
    const query = await this.ensureQuery();
    if (!query) return null;
    try {
      const acct = await query.getObligationAccountById(obligationId);
      if (!acct) return null;

      const collateralValue = Number(acct.totalDepositedValue ?? 0);
      const debtValue = Number(acct.totalBorrowedValue ?? 0);
      const scallopRiskLevel = Number(acct.totalRiskLevel ?? 0);
      // riskLevel >= 1 => liquidatable; HF ~ 1/riskLevel. No debt => effectively infinite (null).
      const healthFactor =
        debtValue <= 0 ? null : scallopRiskLevel > 0 ? Math.round((1 / scallopRiskLevel) * 1000) / 1000 : null;

      return {
        collateralValue,
        debtValue,
        scallopRiskLevel,
        healthFactor,
        riskLevel: riskLevelLabel(scallopRiskLevel),
      };
    } catch (err) {
      this.lastError = String(err?.message || err);
      return null;
    }
  }
}
