/// Shared delegation object that the owner fully controls.
/// Replaces the old transferred GuardianCap: because this object is shared,
/// the owner can revoke it at any time without needing the agent to co-sign.
module liquidshield::guardian_cap {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::event;
    use sui::clock::{Self, Clock};

    // ═══════════════════════════════════════════════
    // Structs
    // ═══════════════════════════════════════════════

    /// Shared so the owner can mutate (revoke) directly and the agent can read
    /// it without the user cosigning rescue PTBs.
    public struct GuardianDelegation has key {
        id: UID,
        /// User who created this delegation
        owner: address,
        /// The guardian agent keypair address authorized to act
        agent: address,
        /// Must match the RiskPolicy used in each rescue PTB
        policy_id: ID,
        /// Agent cannot act after this timestamp (ms)
        expires_at_ms: u64,
        /// Set to true by revoke_delegation(); permanently blocks agent
        revoked: bool,
        /// Incremented on each revocation for off-chain event ordering
        nonce: u64,
    }

    /// Held by DAO/admin. One minted at package publish; transfer to multisig
    /// for production. Used by risk_policy dao_pause / dao_revoke.
    public struct DAOOverrideCap has key, store {
        id: UID,
    }

    // ═══════════════════════════════════════════════
    // Events
    // ═══════════════════════════════════════════════

    public struct DelegationCreatedEvent has copy, drop {
        delegation_id: ID,
        owner: address,
        agent: address,
        policy_id: ID,
        expires_at_ms: u64,
    }

    public struct DelegationRevokedEvent has copy, drop {
        delegation_id: ID,
        owner: address,
        nonce: u64,
    }

    // ═══════════════════════════════════════════════
    // Errors
    // ═══════════════════════════════════════════════

    const E_NOT_OWNER: u64 = 1;
    const E_DELEGATION_REVOKED: u64 = 2;
    const E_DELEGATION_EXPIRED: u64 = 3;
    const E_NOT_AGENT: u64 = 4;
    const E_POLICY_MISMATCH: u64 = 5;

    // ═══════════════════════════════════════════════
    // Entry — user setup
    // ═══════════════════════════════════════════════

    /// User creates a shared delegation granting `agent` bounded rescue rights.
    /// `policy_id` is the ID of the RiskPolicy shared object that must accompany
    /// every rescue PTB — binding delegation to a specific policy.
    public entry fun create_delegation(
        agent: address,
        policy_id: ID,
        expires_at_ms: u64,
        ctx: &mut TxContext,
    ) {
        let owner = tx_context::sender(ctx);
        let d = GuardianDelegation {
            id: object::new(ctx),
            owner,
            agent,
            policy_id,
            expires_at_ms,
            revoked: false,
            nonce: 0,
        };
        event::emit(DelegationCreatedEvent {
            delegation_id: object::id(&d),
            owner,
            agent,
            policy_id,
            expires_at_ms,
        });
        transfer::share_object(d);
    }

    /// Owner permanently disables the agent by flipping `revoked = true`.
    /// No cap object needed — owner address check suffices on a shared object.
    public entry fun revoke_delegation(
        d: &mut GuardianDelegation,
        ctx: &mut TxContext,
    ) {
        assert!(d.owner == tx_context::sender(ctx), E_NOT_OWNER);
        d.revoked = true;
        d.nonce = d.nonce + 1;
        event::emit(DelegationRevokedEvent {
            delegation_id: object::id(d),
            owner: d.owner,
            nonce: d.nonce,
        });
    }

    // ═══════════════════════════════════════════════
    // Guard — called by executor before every rescue
    // ═══════════════════════════════════════════════

    /// Asserts:
    ///   1. tx sender is the authorized agent
    ///   2. delegation has not been revoked
    ///   3. current time is before the expiry
    ///   4. delegation policy_id matches the policy object used in this PTB
    public fun assert_valid(
        d: &GuardianDelegation,
        policy_id: ID,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        assert!(d.agent == tx_context::sender(ctx), E_NOT_AGENT);
        assert!(!d.revoked, E_DELEGATION_REVOKED);
        assert!(clock::timestamp_ms(clock) < d.expires_at_ms, E_DELEGATION_EXPIRED);
        assert!(d.policy_id == policy_id, E_POLICY_MISMATCH);
    }

    // ═══════════════════════════════════════════════
    // Accessors
    // ═══════════════════════════════════════════════

    public fun delegation_owner(d: &GuardianDelegation): address { d.owner }
    public fun delegation_agent(d: &GuardianDelegation): address { d.agent }
    public fun delegation_policy_id(d: &GuardianDelegation): ID { d.policy_id }
    public fun delegation_expires_at_ms(d: &GuardianDelegation): u64 { d.expires_at_ms }
    public fun is_revoked(d: &GuardianDelegation): bool { d.revoked }
    public fun nonce(d: &GuardianDelegation): u64 { d.nonce }

    // ═══════════════════════════════════════════════
    // Init — creates the one DAOOverrideCap at publish
    // ═══════════════════════════════════════════════

    fun init(ctx: &mut TxContext) {
        let dao_cap = DAOOverrideCap { id: object::new(ctx) };
        transfer::transfer(dao_cap, tx_context::sender(ctx));
    }

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) {
        init(ctx);
    }
}
