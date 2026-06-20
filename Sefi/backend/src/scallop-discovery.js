/**
 * Wallet-based Scallop obligation discovery (#1).
 *
 * Replaces the manual single-OBLIGATION_ID model: given an owner address, enumerate ALL
 * their Scallop obligations (a user can have multiple, each independent), resolved from the
 * ObligationKey objects they hold — then read each obligation's collateral/debt/risk.
 *
 * Uses the Scallop SDK:
 *   query.getObligations(owner)        -> [{ id, keyId, locked }]  (does ObligationKey->obligation resolution)
 *   query.getObligationAccountById(id) -> ObligationAccount (USD values + risk + per-coin breakdown)
 */

import { Scallop } from '@scallop-io/sui-scallop-sdk';
import { riskLevelLabel } from './scallop-reader.js';

export class ScallopDiscovery {
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
          const scallop = new Scallop({ networkType: this.cfg.suiNetwork || 'mainnet' });
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
   * Discover all Scallop obligations owned by `owner`.
   * @param {string} owner wallet address
   * @returns {Promise<ScallopDiscoveredObligation[]>}
   */
  async discoverScallopObligations(owner) {
    if (!owner) return [];
    const query = await this.ensureQuery();
    if (!query) return [];

    let obligations;
    try {
      obligations = await query.getObligations(owner); // [{ id, keyId, locked }]
    } catch (err) {
      this.lastError = String(err?.message || err);
      return [];
    }
    if (!Array.isArray(obligations) || obligations.length === 0) return [];

    const out = [];
    for (const ob of obligations) {
      let acct = null;
      try {
        acct = await query.getObligationAccountById(ob.id);
      } catch {
        /* keep going; return what we can */
      }
      const collateralAssets = acct
        ? Object.values(acct.collaterals || {}).filter(Boolean).map((c) => ({
            coinType: c.coinType, symbol: c.symbol, amount: String(c.depositedAmount ?? ''), usdValue: Number(c.depositedValue ?? 0),
          }))
        : [];
      const debtAssets = acct
        ? Object.values(acct.debts || {}).filter(Boolean).map((d) => ({
            coinType: d.coinType, symbol: d.symbol, amount: String(d.borrowedAmount ?? ''), usdValue: Number(d.borrowedValue ?? 0),
          }))
        : [];
      const scallopRiskLevel = Number(acct?.totalRiskLevel ?? 0);
      const totalDebtUsd = Number(acct?.totalBorrowedValue ?? 0);
      const healthFactorLike = totalDebtUsd <= 0 ? null
        : scallopRiskLevel > 0 ? Math.round((1 / scallopRiskLevel) * 1000) / 1000 : null;

      out.push({
        owner,
        obligationKeyId: ob.keyId,
        obligationId: ob.id,
        locked: Boolean(ob.locked),
        collateralAssets,
        debtAssets,
        totalCollateralUsd: Number(acct?.totalDepositedValue ?? 0),
        totalDebtUsd,
        scallopRiskLevel,
        riskLevel: riskLevelLabel(scallopRiskLevel),
        healthFactorLike,
        lastReadAt: new Date().toISOString(),
        source: 'wallet-owned-obligation-key+scallop-sdk',
      });
    }
    return out;
  }
}
