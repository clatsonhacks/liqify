/// Global shared registry + per-user ProtectedPosition objects.
/// Tracks which obligations are enrolled, with their asset config and
/// per-position rescue settings. The executor checks registry membership
/// before allowing any rescue action.
module liquidshield::shield_registry {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::event;
    use std::option::{Self, Option};

    // ═══════════════════════════════════════════════
    // Structs
    // ═══════════════════════════════════════════════

    /// Singleton shared object. Holds all active registrations.
    /// For the hackathon this is a simple append list; production would use
    /// a Table or ObjectTable for O(1) lookup.
    public struct ShieldRegistry has key {
        id: UID,
        admin: address,
        total_registered: u64,
    }

    /// One per user per obligation. Owned by the user; the user passes it
    /// into the rescue PTB as a read-only argument to prove registration.
    public struct ProtectedPosition has key, store {
        id: UID,
        owner: address,
        /// Protocol name, e.g. b"scallop" or b"navi"
        protocol: vector<u8>,
        /// On-chain obligation / account object ID
        obligation_id: address,
        /// Collateral asset type string (for display and routing)
        collateral_asset: vector<u8>,
        /// Debt asset type string
        debt_asset: vector<u8>,
        /// Minimum risk score at which a rescue is triggered (overrides policy default)
        trigger_score_override: Option<u8>,
        /// Whether monitoring and rescue are active
        active: bool,
        /// Registry ID this position is registered under
        registry_id: ID,
    }

    // ═══════════════════════════════════════════════
    // Events
    // ═══════════════════════════════════════════════

    public struct ProtectionRegisteredEvent has copy, drop {
        position_id: ID,
        registry_id: ID,
        owner: address,
        protocol: vector<u8>,
        obligation_id: address,
        collateral_asset: vector<u8>,
        debt_asset: vector<u8>,
    }

    public struct ProtectionDeregisteredEvent has copy, drop {
        position_id: ID,
        registry_id: ID,
        owner: address,
        protocol: vector<u8>,
        obligation_id: address,
    }

    public struct PositionUpdatedEvent has copy, drop {
        position_id: ID,
        owner: address,
        field: vector<u8>,
    }

    // ═══════════════════════════════════════════════
    // Errors
    // ═══════════════════════════════════════════════

    const E_NOT_OWNER: u64 = 1;
    const E_NOT_ACTIVE: u64 = 2;
    const E_WRONG_PROTOCOL: u64 = 3;
    const E_WRONG_OBLIGATION: u64 = 4;

    // ═══════════════════════════════════════════════
    // Init — creates the singleton registry
    // ═══════════════════════════════════════════════

    fun init(ctx: &mut TxContext) {
        let registry = ShieldRegistry {
            id: object::new(ctx),
            admin: tx_context::sender(ctx),
            total_registered: 0,
        };
        transfer::share_object(registry);
    }

    // ═══════════════════════════════════════════════
    // User — register / deregister
    // ═══════════════════════════════════════════════

    /// Register a Scallop or NAVI obligation for protection.
    /// Returns a ProtectedPosition owned by the caller.
    public entry fun register_position(
        registry: &mut ShieldRegistry,
        protocol: vector<u8>,
        obligation_id: address,
        collateral_asset: vector<u8>,
        debt_asset: vector<u8>,
        trigger_score_override: u8,
        use_override: bool,
        ctx: &mut TxContext,
    ) {
        let owner = tx_context::sender(ctx);
        let registry_id = object::id(registry);
        let override_opt = if (use_override) {
            option::some(trigger_score_override)
        } else {
            option::none()
        };

        let position = ProtectedPosition {
            id: object::new(ctx),
            owner,
            protocol,
            obligation_id,
            collateral_asset,
            debt_asset,
            trigger_score_override: override_opt,
            active: true,
            registry_id,
        };

        event::emit(ProtectionRegisteredEvent {
            position_id: object::id(&position),
            registry_id,
            owner,
            protocol: position.protocol,
            obligation_id,
            collateral_asset: position.collateral_asset,
            debt_asset: position.debt_asset,
        });

        registry.total_registered = registry.total_registered + 1;
        // Transfer position to the user; they pass it by reference into rescue PTBs
        transfer::transfer(position, owner);
    }

    /// Deactivate protection. Position object remains but rescues are blocked.
    public entry fun deactivate_position(
        position: &mut ProtectedPosition,
        _registry: &mut ShieldRegistry,
        ctx: &mut TxContext,
    ) {
        assert!(position.owner == tx_context::sender(ctx), E_NOT_OWNER);
        position.active = false;
        event::emit(ProtectionDeregisteredEvent {
            position_id: object::id(position),
            registry_id: position.registry_id,
            owner: position.owner,
            protocol: position.protocol,
            obligation_id: position.obligation_id,
        });
    }

    /// Re-enable protection after deactivation.
    public entry fun activate_position(
        position: &mut ProtectedPosition,
        ctx: &mut TxContext,
    ) {
        assert!(position.owner == tx_context::sender(ctx), E_NOT_OWNER);
        position.active = true;
        event::emit(PositionUpdatedEvent {
            position_id: object::id(position),
            owner: position.owner,
            field: b"active",
        });
    }

    // ═══════════════════════════════════════════════
    // Guard — called by executor
    // ═══════════════════════════════════════════════

    /// Verify this position is active and matches the requested protocol+obligation.
    /// Aborts the PTB if any check fails.
    public fun assert_registered(
        position: &ProtectedPosition,
        protocol: &vector<u8>,
        obligation_id: address,
    ) {
        assert!(position.active, E_NOT_ACTIVE);
        assert!(&position.protocol == protocol, E_WRONG_PROTOCOL);
        assert!(position.obligation_id == obligation_id, E_WRONG_OBLIGATION);
    }

    // ═══════════════════════════════════════════════
    // Accessors
    // ═══════════════════════════════════════════════

    public fun position_owner(p: &ProtectedPosition): address { p.owner }
    public fun position_protocol(p: &ProtectedPosition): &vector<u8> { &p.protocol }
    public fun position_obligation_id(p: &ProtectedPosition): address { p.obligation_id }
    public fun position_active(p: &ProtectedPosition): bool { p.active }
    public fun registry_id(p: &ProtectedPosition): ID { p.registry_id }
    public fun total_registered(r: &ShieldRegistry): u64 { r.total_registered }
}
