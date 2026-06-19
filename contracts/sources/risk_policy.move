/// Shared object per user. Stores what the guardian is allowed to do:
/// trigger threshold, per-action and daily spend caps, allowed protocols,
/// expiry, and pause/revoke state.
module liquidshield::risk_policy {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::event;
    use std::vector;
    use liquidshield::guardian_cap::DAOOverrideCap;

    // ═══════════════════════════════════════════════
    // Structs
    // ═══════════════════════════════════════════════

    /// Shared so the agent can read it without the user cosigning each PTB.
    /// Owner can mutate; DAO can pause via DAOOverrideCap.
    public struct RiskPolicy has key {
        id: UID,
        owner: address,
        /// Risk score 0-100 above which the guardian may act
        trigger_score: u8,
        /// Max base-unit coins per single rescue (e.g. 500_000_000 = 500 USDC)
        max_per_action: u64,
        /// Max base-unit coins per day across all rescues
        max_daily: u64,
        /// Unix epoch ms — policy expires and agent cannot act after this
        expires_at_ms: u64,
        /// Temporarily halt agent (owner or DAO)
        paused: bool,
        /// Permanent owner revocation
        revoked: bool,
        /// Allowlisted protocol names, e.g. b"scallop", b"navi"
        allowed_protocols: vector<vector<u8>>,
        /// Min health factor to aim for post-rescue, scaled x1000 (1200 = 1.2)
        min_health_factor_x1000: u64,
        /// Monotonically incrementing version for off-chain audit
        version: u64,
    }

    // ═══════════════════════════════════════════════
    // Events
    // ═══════════════════════════════════════════════

    public struct PolicyCreatedEvent has copy, drop {
        policy_id: ID,
        owner: address,
        trigger_score: u8,
        max_per_action: u64,
        max_daily: u64,
        expires_at_ms: u64,
    }

    public struct PolicyChangedEvent has copy, drop {
        policy_id: ID,
        owner: address,
        field: vector<u8>,
        version: u64,
    }

    public struct PolicyPausedEvent has copy, drop {
        policy_id: ID,
        paused_by: address,
        paused: bool,
        version: u64,
    }

    public struct ProtectionRevokedEvent has copy, drop {
        policy_id: ID,
        owner: address,
    }

    public struct OverrideExecutedEvent has copy, drop {
        policy_id: ID,
        executor: address,
        action: vector<u8>,
        version: u64,
    }

    // ═══════════════════════════════════════════════
    // Errors
    // ═══════════════════════════════════════════════

    const E_NOT_OWNER: u64 = 1;
    const E_POLICY_PAUSED: u64 = 2;
    const E_POLICY_REVOKED: u64 = 3;
    const E_POLICY_EXPIRED: u64 = 4;
    const E_PROTOCOL_NOT_ALLOWED: u64 = 5;
    const E_EXCEEDS_MAX_PER_ACTION: u64 = 6;

    // ═══════════════════════════════════════════════
    // Entry — user setup
    // ═══════════════════════════════════════════════

    /// Create a policy and share it so the agent can use it autonomously.
    /// `allowed_protocols_csv` is a single bytes value; real multi-protocol
    /// support uses repeated calls to add_protocol after creation.
    public entry fun create_and_share_policy(
        trigger_score: u8,
        max_per_action: u64,
        max_daily: u64,
        expires_at_ms: u64,
        min_health_factor_x1000: u64,
        ctx: &mut TxContext,
    ) {
        let owner = tx_context::sender(ctx);
        let policy = RiskPolicy {
            id: object::new(ctx),
            owner,
            trigger_score,
            max_per_action,
            max_daily,
            expires_at_ms,
            paused: false,
            revoked: false,
            allowed_protocols: vector[b"scallop", b"navi"],
            min_health_factor_x1000,
            version: 1,
        };
        event::emit(PolicyCreatedEvent {
            policy_id: object::id(&policy),
            owner,
            trigger_score,
            max_per_action,
            max_daily,
            expires_at_ms,
        });
        transfer::share_object(policy);
    }

    // ═══════════════════════════════════════════════
    // Owner mutations
    // ═══════════════════════════════════════════════

    public entry fun update_trigger_score(
        policy: &mut RiskPolicy,
        new_score: u8,
        ctx: &mut TxContext,
    ) {
        assert!(policy.owner == tx_context::sender(ctx), E_NOT_OWNER);
        policy.trigger_score = new_score;
        policy.version = policy.version + 1;
        event::emit(PolicyChangedEvent {
            policy_id: object::id(policy),
            owner: policy.owner,
            field: b"trigger_score",
            version: policy.version,
        });
    }

    public entry fun update_spend_limits(
        policy: &mut RiskPolicy,
        max_per_action: u64,
        max_daily: u64,
        ctx: &mut TxContext,
    ) {
        assert!(policy.owner == tx_context::sender(ctx), E_NOT_OWNER);
        policy.max_per_action = max_per_action;
        policy.max_daily = max_daily;
        policy.version = policy.version + 1;
        event::emit(PolicyChangedEvent {
            policy_id: object::id(policy),
            owner: policy.owner,
            field: b"spend_limits",
            version: policy.version,
        });
    }

    public entry fun add_allowed_protocol(
        policy: &mut RiskPolicy,
        protocol: vector<u8>,
        ctx: &mut TxContext,
    ) {
        assert!(policy.owner == tx_context::sender(ctx), E_NOT_OWNER);
        if (!is_protocol_allowed(policy, &protocol)) {
            vector::push_back(&mut policy.allowed_protocols, protocol);
            policy.version = policy.version + 1;
        };
    }

    public entry fun pause(policy: &mut RiskPolicy, ctx: &mut TxContext) {
        assert!(policy.owner == tx_context::sender(ctx), E_NOT_OWNER);
        policy.paused = true;
        policy.version = policy.version + 1;
        event::emit(PolicyPausedEvent {
            policy_id: object::id(policy),
            paused_by: tx_context::sender(ctx),
            paused: true,
            version: policy.version,
        });
    }

    public entry fun unpause(policy: &mut RiskPolicy, ctx: &mut TxContext) {
        assert!(policy.owner == tx_context::sender(ctx), E_NOT_OWNER);
        policy.paused = false;
        policy.version = policy.version + 1;
        event::emit(PolicyPausedEvent {
            policy_id: object::id(policy),
            paused_by: tx_context::sender(ctx),
            paused: false,
            version: policy.version,
        });
    }

    /// Permanently disables the agent. Cannot be un-revoked.
    public entry fun revoke(policy: &mut RiskPolicy, ctx: &mut TxContext) {
        assert!(policy.owner == tx_context::sender(ctx), E_NOT_OWNER);
        policy.revoked = true;
        policy.version = policy.version + 1;
        event::emit(ProtectionRevokedEvent {
            policy_id: object::id(policy),
            owner: policy.owner,
        });
    }

    // ═══════════════════════════════════════════════
    // DAO overrides
    // ═══════════════════════════════════════════════

    public entry fun dao_pause(
        policy: &mut RiskPolicy,
        _cap: &DAOOverrideCap,
        ctx: &mut TxContext,
    ) {
        policy.paused = true;
        policy.version = policy.version + 1;
        event::emit(OverrideExecutedEvent {
            policy_id: object::id(policy),
            executor: tx_context::sender(ctx),
            action: b"pause",
            version: policy.version,
        });
    }

    public entry fun dao_unpause(
        policy: &mut RiskPolicy,
        _cap: &DAOOverrideCap,
        ctx: &mut TxContext,
    ) {
        policy.paused = false;
        policy.version = policy.version + 1;
        event::emit(OverrideExecutedEvent {
            policy_id: object::id(policy),
            executor: tx_context::sender(ctx),
            action: b"unpause",
            version: policy.version,
        });
    }

    public entry fun dao_revoke(
        policy: &mut RiskPolicy,
        _cap: &DAOOverrideCap,
        ctx: &mut TxContext,
    ) {
        policy.revoked = true;
        policy.version = policy.version + 1;
        event::emit(OverrideExecutedEvent {
            policy_id: object::id(policy),
            executor: tx_context::sender(ctx),
            action: b"revoke",
            version: policy.version,
        });
    }

    // ═══════════════════════════════════════════════
    // Guard — called by executor before any action
    // ═══════════════════════════════════════════════

    /// Aborts if the policy cannot currently authorize a rescue of `amount`
    /// on `protocol`. Callers must also pass the clock for expiry.
    public fun assert_active(
        policy: &RiskPolicy,
        protocol: &vector<u8>,
        amount: u64,
        now_ms: u64,
    ) {
        assert!(!policy.revoked, E_POLICY_REVOKED);
        assert!(!policy.paused, E_POLICY_PAUSED);
        assert!(now_ms < policy.expires_at_ms, E_POLICY_EXPIRED);
        assert!(amount <= policy.max_per_action, E_EXCEEDS_MAX_PER_ACTION);
        assert!(is_protocol_allowed(policy, protocol), E_PROTOCOL_NOT_ALLOWED);
    }

    // ═══════════════════════════════════════════════
    // Accessors
    // ═══════════════════════════════════════════════

    public fun owner(p: &RiskPolicy): address { p.owner }
    public fun trigger_score(p: &RiskPolicy): u8 { p.trigger_score }
    public fun max_per_action(p: &RiskPolicy): u64 { p.max_per_action }
    public fun max_daily(p: &RiskPolicy): u64 { p.max_daily }
    public fun expires_at_ms(p: &RiskPolicy): u64 { p.expires_at_ms }
    public fun is_paused(p: &RiskPolicy): bool { p.paused }
    public fun is_revoked(p: &RiskPolicy): bool { p.revoked }
    public fun min_health_factor_x1000(p: &RiskPolicy): u64 { p.min_health_factor_x1000 }
    public fun version(p: &RiskPolicy): u64 { p.version }

    fun is_protocol_allowed(policy: &RiskPolicy, protocol: &vector<u8>): bool {
        let len = vector::length(&policy.allowed_protocols);
        let mut i = 0;
        while (i < len) {
            if (vector::borrow(&policy.allowed_protocols, i) == protocol) {
                return true
            };
            i = i + 1;
        };
        false
    }
}
