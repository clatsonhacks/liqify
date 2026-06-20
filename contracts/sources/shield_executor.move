/// Execution gateway for LiquidShield rescue actions.
///
/// Uses a hot-potato receipt for atomicity (package-internal only):
///   1. begin_rescue()   — validates all invariants + cross-object consistency,
///                         withdraws vault coins, returns (Coin<T>, RescueReceipt).
///   2. <adapter calls scallop repay / topup>
///   3. complete_rescue() — consumes receipt, records spend, emits events.
///
/// Both begin_rescue and complete_rescue are public(package) so only modules
/// in this package (scallop_adapter) can build the pattern. External PTBs
/// cannot obtain a naked Coin<T> from the vault.
module liquidshield::shield_executor {
    use sui::object::{Self, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::coin::Coin;
    use sui::clock::{Self, Clock};
    use sui::event;

    use liquidshield::guardian_cap::{Self, GuardianDelegation};
    use liquidshield::risk_policy::{Self, RiskPolicy};
    use liquidshield::shield_vault::{Self, ShieldVault};
    use liquidshield::shield_registry::{Self, ShieldRegistry};
    use liquidshield::shield_oracle::{Self, RiskSnapshot};

    // ═══════════════════════════════════════════════
    // Hot-potato receipt — no abilities, consumed in same PTB
    // ═══════════════════════════════════════════════

    public struct RescueReceipt {
        vault_id: ID,
        obligation_id: address,
        protocol: vector<u8>,
        amount: u64,
        risk_score: u8,
        reason_codes: u64,
        executor: address,
    }

    // ═══════════════════════════════════════════════
    // Events
    // ═══════════════════════════════════════════════

    public struct ShieldActivatedEvent has copy, drop {
        vault_id: ID,
        obligation_id: address,
        protocol: vector<u8>,
        action_type: u8,     // 0 = repay, 1 = collateral top-up
        amount_used: u64,
        risk_score_before: u8,
        reason_codes: u64,
        executor: address,
    }

    public struct ShieldBlockedEvent has copy, drop {
        obligation_id: address,
        protocol: vector<u8>,
        block_reason: vector<u8>,
        executor: address,
    }

    // ═══════════════════════════════════════════════
    // Errors
    // ═══════════════════════════════════════════════

    const E_OWNER_MISMATCH: u64 = 1;
    const E_VAULT_OWNER_MISMATCH: u64 = 2;
    const E_SNAPSHOT_MISMATCH: u64 = 3;

    // ═══════════════════════════════════════════════
    // Rescue entry — package-internal step 1
    // ═══════════════════════════════════════════════

    /// Validate all invariants then withdraw rescue funds from the vault.
    /// Visibility is public(package) — only scallop_adapter (same package)
    /// can call this, so no external PTB can obtain an unrestricted Coin<T>.
    ///
    /// Invariants (fail-closed):
    ///   D1  GuardianDelegation: sender==agent, !revoked, !expired, policy_id matches
    ///   D2  RiskPolicy: !paused, !revoked, !expired, protocol allowed, amount within cap
    ///   D3  RiskSnapshot: fresh & score >= trigger
    ///   D4  ShieldRegistry: registered, active, correct owner/vault/policy
    ///   D5  ShieldVault: sufficient balance and daily budget
    ///
    /// Cross-object consistency (#7):
    ///   C1  delegation.owner == policy.owner
    ///   C2  vault.owner      == policy.owner
    ///   C3  registry record owner    == policy.owner   (checked inside assert_registered)
    ///   C4  registry record vault_id == object::id(vault) (checked inside assert_registered)
    ///   C5  registry record policy_id== object::id(policy)(checked inside assert_registered)
    ///   C6  snapshot.obligation_id   == obligation_id (arg)
    public(package) fun begin_rescue<T>(
        delegation: &GuardianDelegation,
        policy: &RiskPolicy,
        snapshot: &RiskSnapshot,
        registry: &ShieldRegistry,
        vault: &mut ShieldVault<T>,
        protocol: vector<u8>,
        obligation_id: address,
        amount: u64,
        max_snapshot_age_ms: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ): (Coin<T>, RescueReceipt) {
        let now_ms = clock::timestamp_ms(clock);

        // D1 — delegation check
        guardian_cap::assert_valid(delegation, object::id(policy), clock, ctx);

        // D2 — policy check (protocol allowlist + amount cap + not paused/revoked)
        risk_policy::assert_active(policy, &protocol, amount, now_ms);

        // D3 — freshness + score threshold
        shield_oracle::assert_fresh_and_triggered(
            snapshot,
            risk_policy::trigger_score(policy),
            max_snapshot_age_ms,
            clock,
        );

        // C6 — snapshot must be for THIS obligation
        assert!(
            shield_oracle::position_key(snapshot) == obligation_id,
            E_SNAPSHOT_MISMATCH,
        );

        let policy_owner = risk_policy::owner(policy);

        // C1 — delegation created by the same owner as the policy
        assert!(
            guardian_cap::delegation_owner(delegation) == policy_owner,
            E_OWNER_MISMATCH,
        );

        // C2 — vault belongs to the same owner
        assert!(
            shield_vault::owner(vault) == policy_owner,
            E_VAULT_OWNER_MISMATCH,
        );

        // D4 + C3 + C4 + C5 — full registry check
        shield_registry::assert_registered(
            registry,
            policy_owner,
            &protocol,
            obligation_id,
            object::id(vault),
            object::id(policy),
        );

        // D5 — withdraw from vault (enforces per-action and rolling window limits)
        let coins = shield_vault::reserve_for_rescue(vault, amount, clock, ctx);

        let receipt = RescueReceipt {
            vault_id: object::id(vault),
            obligation_id,
            protocol,
            amount,
            risk_score: shield_oracle::risk_score(snapshot),
            reason_codes: shield_oracle::reason_codes(snapshot),
            executor: tx_context::sender(ctx),
        };

        (coins, receipt)
    }

    // ═══════════════════════════════════════════════
    // Rescue exit — package-internal step 3
    // ═══════════════════════════════════════════════

    /// Consume the receipt, return any leftover coins to vault, emit event.
    /// `action_type`: 0 = debt repay, 1 = collateral top-up
    public(package) fun complete_rescue<T>(
        receipt: RescueReceipt,
        vault: &mut ShieldVault<T>,
        leftover: Coin<T>,
        action_type: u8,
    ) {
        let RescueReceipt {
            vault_id: _,
            obligation_id,
            protocol,
            amount,
            risk_score,
            reason_codes,
            executor,
        } = receipt;

        shield_vault::return_unused(vault, leftover);

        event::emit(ShieldActivatedEvent {
            vault_id: object::id(vault),
            obligation_id,
            protocol,
            action_type,
            amount_used: amount,
            risk_score_before: risk_score,
            reason_codes,
            executor,
        });
    }

    // ═══════════════════════════════════════════════
    // Blocked attempt logger — public entry
    // ═══════════════════════════════════════════════

    /// Emit ShieldBlockedEvent when the agent decides not to execute.
    public entry fun record_blocked_attempt(
        obligation_id: address,
        protocol: vector<u8>,
        block_reason: vector<u8>,
        ctx: &mut TxContext,
    ) {
        event::emit(ShieldBlockedEvent {
            obligation_id,
            protocol,
            block_reason,
            executor: tx_context::sender(ctx),
        });
    }
}
