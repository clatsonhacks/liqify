/// Execution gateway for LiquidShield rescue actions.
///
/// Uses a hot-potato receipt pattern for atomicity:
///   1. begin_rescue()  — validates all invariants, withdraws vault coins,
///                        returns (Coin<T>, RescueReceipt).
///   2. <caller does the protocol-specific move_call, e.g. scallop::repay>
///   3. complete_rescue() — consumes the receipt, records spend, emits events.
///
/// If step 3 is never called the receipt cannot be dropped, so the PTB aborts
/// and all state changes (vault withdrawal, protocol repay) are rolled back.
///
/// ShieldBlockedEvent is emitted when a rescue attempt is rejected by the
/// deterministic guards, giving the off-chain indexer an audit trail.
module liquidshield::shield_executor {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::coin::Coin;
    use sui::clock::{Self, Clock};
    use sui::event;

    use liquidshield::guardian_cap::{Self, GuardianCap};
    use liquidshield::risk_policy::{Self, RiskPolicy};
    use liquidshield::shield_vault::{Self, ShieldVault};
    use liquidshield::shield_registry::{Self, ProtectedPosition};
    use liquidshield::shield_oracle::{Self, RiskSnapshot};

    // ═══════════════════════════════════════════════
    // Hot-potato receipt — no abilities, must be consumed in same PTB
    // ═══════════════════════════════════════════════

    /// Created by begin_rescue, consumed by complete_rescue.
    /// Carries metadata needed to finalize the action log.
    public struct RescueReceipt {
        vault_id: ID,
        position_id: ID,
        protocol: vector<u8>,
        obligation_id: address,
        amount: u64,
        risk_score: u8,
        reason_codes: u64,
        executor: address,
    }

    // ═══════════════════════════════════════════════
    // Events
    // ═══════════════════════════════════════════════

    public struct ShieldActivatedEvent has copy, drop {
        position_id: ID,
        vault_id: ID,
        protocol: vector<u8>,
        obligation_id: address,
        action_type: u8,     // 0 = repay, 1 = collateral top-up
        amount_used: u64,
        risk_score_before: u8,
        reason_codes: u64,
        executor: address,
    }

    public struct ShieldBlockedEvent has copy, drop {
        position_id: ID,
        protocol: vector<u8>,
        obligation_id: address,
        block_reason: vector<u8>,
        executor: address,
    }

    // ═══════════════════════════════════════════════
    // Errors
    // ═══════════════════════════════════════════════

    const E_WRONG_OWNER: u64 = 1;

    // ═══════════════════════════════════════════════
    // Rescue entry — step 1 of rescue PTB
    // ═══════════════════════════════════════════════

    /// Validate all invariants then withdraw rescue funds from the vault.
    /// The returned Coin<T> must be passed into the protocol adapter call
    /// (e.g. scallop::repay) in the same PTB.
    /// The returned RescueReceipt must be passed into complete_rescue.
    ///
    /// Invariants checked (fail-closed):
    ///   I1  GuardianCap valid & not expired
    ///   I2  RiskPolicy active, unexpired, protocol allowed, amount within cap
    ///   I3  RiskSnapshot fresh & score >= trigger
    ///   I4  ProtectedPosition active, matching protocol + obligation
    ///   I5  ShieldVault has sufficient balance and daily budget
    public fun begin_rescue<T>(
        cap: &GuardianCap,
        policy: &RiskPolicy,
        snapshot: &RiskSnapshot,
        position: &ProtectedPosition,
        vault: &mut ShieldVault<T>,
        protocol: vector<u8>,
        obligation_id: address,
        amount: u64,
        max_snapshot_age_ms: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ): (Coin<T>, RescueReceipt) {
        // I1 — capability check
        guardian_cap::assert_valid(cap, clock::timestamp_ms(clock));

        // I2 — policy check (also validates protocol allowlist + amount cap)
        risk_policy::assert_active(policy, &protocol, amount, clock::timestamp_ms(clock));

        // I3 — freshness + score threshold
        shield_oracle::assert_fresh_and_triggered(
            snapshot,
            risk_policy::trigger_score(policy),
            max_snapshot_age_ms,
            clock,
        );

        // I4 — registry membership
        shield_registry::assert_registered(position, &protocol, obligation_id);

        // I5 — vault withdrawal (also enforces per-action and window limits)
        let coins = shield_vault::reserve_for_rescue(vault, amount, clock, ctx);

        let receipt = RescueReceipt {
            vault_id: object::id(vault),
            position_id: shield_oracle::position_id(snapshot),
            protocol,
            obligation_id,
            amount,
            risk_score: shield_oracle::risk_score(snapshot),
            reason_codes: shield_oracle::reason_codes(snapshot),
            executor: tx_context::sender(ctx),
        };

        (coins, receipt)
    }

    // ═══════════════════════════════════════════════
    // Rescue exit — step 3 of rescue PTB
    // ═══════════════════════════════════════════════

    /// Consume the receipt, optionally return unused coins to the vault,
    /// and emit ShieldActivatedEvent.
    ///
    /// `action_type`: 0 = debt repay, 1 = collateral top-up
    /// `leftover`:    coins not consumed by the protocol call (can be zero-value)
    public fun complete_rescue<T>(
        receipt: RescueReceipt,
        vault: &mut ShieldVault<T>,
        leftover: Coin<T>,
        action_type: u8,
    ) {
        let RescueReceipt {
            vault_id: _,
            position_id,
            protocol,
            obligation_id,
            amount,
            risk_score,
            reason_codes,
            executor,
        } = receipt;

        // Return any unspent coins (e.g. partial repay used less than reserved)
        shield_vault::return_unused(vault, leftover);

        event::emit(ShieldActivatedEvent {
            position_id,
            vault_id: object::id(vault),
            protocol,
            obligation_id,
            action_type,
            amount_used: amount,
            risk_score_before: risk_score,
            reason_codes,
            executor,
        });
    }

    // ═══════════════════════════════════════════════
    // Blocked attempt logger (called off-chain via separate TX)
    // ═══════════════════════════════════════════════

    /// Emit a ShieldBlockedEvent when the agent decides not to execute
    /// (e.g. simulation failed, guards not met) so the indexer has an audit
    /// trail of near-miss events.
    public entry fun record_blocked_attempt(
        position_id: ID,
        protocol: vector<u8>,
        obligation_id: address,
        block_reason: vector<u8>,
        ctx: &mut TxContext,
    ) {
        event::emit(ShieldBlockedEvent {
            position_id,
            protocol,
            obligation_id,
            block_reason,
            executor: tx_context::sender(ctx),
        });
    }
}
