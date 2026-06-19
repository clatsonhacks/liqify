/// Capability objects that authorize LiquidShield guardian actions.
/// GuardianCap is transferred to the agent keypair; DAOOverrideCap to the admin.
module liquidshield::guardian_cap {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::event;

    // ═══════════════════════════════════════════════
    // Structs
    // ═══════════════════════════════════════════════

    /// Held by the guardian agent address. Authorizes bounded rescue actions
    /// on behalf of `protected_owner`. Must be paired with a valid RiskPolicy.
    public struct GuardianCap has key, store {
        id: UID,
        /// User who granted this capability
        protected_owner: address,
        /// Unix epoch ms — agent cannot act after this
        expires_at_ms: u64,
        /// Set to true by revoke(); blocks all future agent actions
        revoked: bool,
    }

    /// Held by DAO/admin. Can pause or force-revoke any RiskPolicy.
    /// One cap minted at package publish; transfer to multisig for production.
    public struct DAOOverrideCap has key, store {
        id: UID,
    }

    // ═══════════════════════════════════════════════
    // Events
    // ═══════════════════════════════════════════════

    public struct GuardianCapMintedEvent has copy, drop {
        cap_id: ID,
        protected_owner: address,
        agent_address: address,
        expires_at_ms: u64,
    }

    public struct GuardianCapRevokedEvent has copy, drop {
        cap_id: ID,
        protected_owner: address,
    }

    // ═══════════════════════════════════════════════
    // Errors
    // ═══════════════════════════════════════════════

    const E_NOT_OWNER: u64 = 1;
    const E_CAP_REVOKED: u64 = 2;
    const E_CAP_EXPIRED: u64 = 3;

    // ═══════════════════════════════════════════════
    // Public functions
    // ═══════════════════════════════════════════════

    /// User creates a GuardianCap and transfers it to the guardian agent.
    /// Call once per user during onboarding.
    public entry fun mint_and_transfer_guardian_cap(
        agent_address: address,
        expires_at_ms: u64,
        ctx: &mut TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        let cap = GuardianCap {
            id: object::new(ctx),
            protected_owner: sender,
            expires_at_ms,
            revoked: false,
        };
        event::emit(GuardianCapMintedEvent {
            cap_id: object::id(&cap),
            protected_owner: sender,
            agent_address,
            expires_at_ms,
        });
        transfer::transfer(cap, agent_address);
    }

    /// User calls this to permanently disable the agent.
    /// The cap object is burned; no further rescue can be authorized.
    public entry fun revoke_guardian_cap(
        cap: GuardianCap,
        ctx: &mut TxContext,
    ) {
        assert!(cap.protected_owner == tx_context::sender(ctx), E_NOT_OWNER);
        event::emit(GuardianCapRevokedEvent {
            cap_id: object::id(&cap),
            protected_owner: cap.protected_owner,
        });
        let GuardianCap { id, protected_owner: _, expires_at_ms: _, revoked: _ } = cap;
        object::delete(id);
    }

    /// Called by the agent in every PTB to validate the cap before acting.
    public fun assert_valid(cap: &GuardianCap, now_ms: u64) {
        assert!(!cap.revoked, E_CAP_REVOKED);
        assert!(now_ms < cap.expires_at_ms, E_CAP_EXPIRED);
    }

    // ═══════════════════════════════════════════════
    // Accessors
    // ═══════════════════════════════════════════════

    public fun protected_owner(cap: &GuardianCap): address { cap.protected_owner }
    public fun expires_at_ms(cap: &GuardianCap): u64 { cap.expires_at_ms }
    public fun is_revoked(cap: &GuardianCap): bool { cap.revoked }

    // ═══════════════════════════════════════════════
    // Init — creates the one DAOOverrideCap at publish
    // ═══════════════════════════════════════════════

    fun init(ctx: &mut TxContext) {
        let dao_cap = DAOOverrideCap { id: object::new(ctx) };
        transfer::transfer(dao_cap, tx_context::sender(ctx));
    }
}
