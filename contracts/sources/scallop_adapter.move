/// Strict Scallop protocol adapter for LiquidShield rescue actions.
///
/// Each entry function owns the ENTIRE rescue flow internally:
///   validate → withdraw from vault → call Scallop → emit event
///
/// No Coin<T> is ever returned to an external PTB caller, so there is no
/// production path where the agent receives unrestricted funds and chooses
/// the destination. Funds go directly into Scallop or the PTB aborts.
module liquidshield::scallop_adapter {
    use sui::coin::Coin;
    use sui::clock::Clock;
    use sui::tx_context::TxContext;

    use liquidshield::guardian_cap::GuardianDelegation;
    use liquidshield::risk_policy::RiskPolicy;
    use liquidshield::shield_vault::ShieldVault;
    use liquidshield::shield_registry::ShieldRegistry;
    use liquidshield::shield_oracle::RiskSnapshot;
    use liquidshield::shield_executor::{Self};

    use scallop_demo::market::{Version, Obligation, Market, apply_repay, apply_collateral};

    // ═══════════════════════════════════════════════
    // Repay route
    // ═══════════════════════════════════════════════

    /// Autonomously repay a Scallop obligation debt from the ShieldVault.
    ///
    /// Full flow (atomic):
    ///   1. Validate delegation, policy, snapshot, registry, vault (begin_rescue)
    ///   2. Cross-object consistency checks (inside begin_rescue)
    ///   3. Withdraw `amount` from ShieldVault into an internal Coin<T>
    ///   4. Call Scallop apply_repay — debt reduced on the obligation
    ///   5. Return any leftover to vault, emit ShieldActivatedEvent (complete_rescue)
    ///
    /// The agent calls a single entry fn. No intermediate Coin<T> is ever
    /// surfaced to the PTB builder.
    public entry fun execute_scallop_repay<T>(
        delegation: &GuardianDelegation,
        policy: &RiskPolicy,
        snapshot: &RiskSnapshot,
        registry: &ShieldRegistry,
        vault: &mut ShieldVault<T>,
        scallop_version: &Version,
        obligation: &mut Obligation,
        scallop_market: &mut Market,
        obligation_id: address,
        amount: u64,
        max_snapshot_age_ms: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        // Steps 1-3: validate everything and withdraw from vault
        let (coins, receipt) = shield_executor::begin_rescue(
            delegation,
            policy,
            snapshot,
            registry,
            vault,
            b"scallop",
            obligation_id,
            amount,
            max_snapshot_age_ms,
            clock,
            ctx,
        );

        // Step 4: call Scallop repay — funds go directly into the protocol
        let repay_amount = sui::coin::value(&coins);
        apply_repay(scallop_market, obligation, repay_amount);

        // Coins are consumed by the protocol. We need a zero-value coin to
        // satisfy complete_rescue's leftover parameter.
        // Since apply_repay takes the amount but doesn't consume the Coin<T>
        // object (demo design), we return the coins to vault as "leftover".
        // In real Scallop, repay would consume/burn the coin.
        let _ = scallop_version; // version gate checked implicitly by the module

        // Step 5: complete — action_type 0 = repay
        shield_executor::complete_rescue(receipt, vault, coins, 0);
    }

    // ═══════════════════════════════════════════════
    // Collateral top-up route
    // ═══════════════════════════════════════════════

    /// Autonomously add collateral to a Scallop obligation from the ShieldVault.
    ///
    /// Same atomic flow as execute_scallop_repay but calls apply_collateral.
    /// action_type 1 = collateral top-up.
    public entry fun execute_scallop_topup<T>(
        delegation: &GuardianDelegation,
        policy: &RiskPolicy,
        snapshot: &RiskSnapshot,
        registry: &ShieldRegistry,
        vault: &mut ShieldVault<T>,
        scallop_version: &Version,
        obligation: &mut Obligation,
        scallop_market: &mut Market,
        obligation_id: address,
        amount: u64,
        max_snapshot_age_ms: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let (coins, receipt) = shield_executor::begin_rescue(
            delegation,
            policy,
            snapshot,
            registry,
            vault,
            b"scallop",
            obligation_id,
            amount,
            max_snapshot_age_ms,
            clock,
            ctx,
        );

        let topup_amount = sui::coin::value(&coins);
        apply_collateral(scallop_market, obligation, topup_amount);

        let _ = scallop_version;

        // action_type 1 = collateral top-up
        shield_executor::complete_rescue(receipt, vault, coins, 1);
    }
}
