/// Global shared registry keyed by obligation_id.
/// Replaces the old user-owned ProtectedPosition: because records live in a
/// shared Table, the guardian agent can verify registration without the user
/// online — satisfying the "user is asleep, agent rescues" requirement.
module liquidshield::shield_registry {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::event;
    use sui::table::{Self, Table};
    use sui::clock::{Self, Clock};
    use std::vector;

    // ═══════════════════════════════════════════════
    // Structs
    // ═══════════════════════════════════════════════

    /// Singleton shared registry. Holds all active protection records.
    public struct ShieldRegistry has key {
        id: UID,
        admin: address,
        /// obligation_id -> ProtectionRecord
        records: Table<address, ProtectionRecord>,
        /// owner -> list of registered obligation_ids (for enumeration)
        owner_index: Table<address, vector<address>>,
        total_registered: u64,
    }

    /// One record per obligation. Stored by value in the shared Table so no
    /// user-owned object is needed in rescue PTBs.
    public struct ProtectionRecord has store {
        owner: address,
        protocol: vector<u8>,
        obligation_id: address,
        vault_id: ID,
        policy_id: ID,
        snapshot_id: ID,
        collateral_asset: vector<u8>,
        debt_asset: vector<u8>,
        active: bool,
        created_at_ms: u64,
        updated_at_ms: u64,
    }

    // ═══════════════════════════════════════════════
    // Events
    // ═══════════════════════════════════════════════

    public struct ProtectionRegisteredEvent has copy, drop {
        registry_id: ID,
        owner: address,
        protocol: vector<u8>,
        obligation_id: address,
        vault_id: ID,
        policy_id: ID,
        collateral_asset: vector<u8>,
        debt_asset: vector<u8>,
    }

    public struct ProtectionDeregisteredEvent has copy, drop {
        registry_id: ID,
        owner: address,
        obligation_id: address,
    }

    public struct PositionUpdatedEvent has copy, drop {
        registry_id: ID,
        owner: address,
        obligation_id: address,
        field: vector<u8>,
    }

    // ═══════════════════════════════════════════════
    // Errors
    // ═══════════════════════════════════════════════

    const E_NOT_OWNER: u64 = 1;
    const E_NOT_ACTIVE: u64 = 2;
    const E_WRONG_PROTOCOL: u64 = 3;
    const E_NOT_REGISTERED: u64 = 4;
    const E_VAULT_MISMATCH: u64 = 5;
    const E_POLICY_MISMATCH: u64 = 6;
    const E_ALREADY_REGISTERED: u64 = 7;
    const E_REGISTRY_OWNER_MISMATCH: u64 = 8;

    // ═══════════════════════════════════════════════
    // Init — creates the singleton shared registry
    // ═══════════════════════════════════════════════

    fun init(ctx: &mut TxContext) {
        let registry = ShieldRegistry {
            id: object::new(ctx),
            admin: tx_context::sender(ctx),
            records: table::new(ctx),
            owner_index: table::new(ctx),
            total_registered: 0,
        };
        transfer::share_object(registry);
    }

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) {
        init(ctx);
    }

    // ═══════════════════════════════════════════════
    // User — register / deactivate / activate
    // ═══════════════════════════════════════════════

    /// Register an obligation for protection. Each obligation_id can only be
    /// registered once. The caller supplies their vault_id, policy_id, and
    /// snapshot_id so the executor can verify cross-object consistency.
    public entry fun register_position(
        registry: &mut ShieldRegistry,
        protocol: vector<u8>,
        obligation_id: address,
        vault_id: ID,
        policy_id: ID,
        snapshot_id: ID,
        collateral_asset: vector<u8>,
        debt_asset: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(
            !table::contains(&registry.records, obligation_id),
            E_ALREADY_REGISTERED,
        );
        let owner = tx_context::sender(ctx);
        let now = clock::timestamp_ms(clock);

        let record = ProtectionRecord {
            owner,
            protocol,
            obligation_id,
            vault_id,
            policy_id,
            snapshot_id,
            collateral_asset,
            debt_asset,
            active: true,
            created_at_ms: now,
            updated_at_ms: now,
        };

        // Update owner index
        if (!table::contains(&registry.owner_index, owner)) {
            table::add(&mut registry.owner_index, owner, vector[]);
        };
        vector::push_back(
            table::borrow_mut(&mut registry.owner_index, owner),
            obligation_id,
        );

        event::emit(ProtectionRegisteredEvent {
            registry_id: object::id(registry),
            owner,
            protocol: record.protocol,
            obligation_id,
            vault_id,
            policy_id,
            collateral_asset: record.collateral_asset,
            debt_asset: record.debt_asset,
        });

        table::add(&mut registry.records, obligation_id, record);
        registry.total_registered = registry.total_registered + 1;
    }

    /// Deactivate protection. Record stays in the table but rescues are blocked.
    public entry fun deactivate_position(
        registry: &mut ShieldRegistry,
        obligation_id: address,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(table::contains(&registry.records, obligation_id), E_NOT_REGISTERED);
        let owner = tx_context::sender(ctx);
        let record = table::borrow_mut(&mut registry.records, obligation_id);
        assert!(record.owner == owner, E_NOT_OWNER);
        record.active = false;
        record.updated_at_ms = clock::timestamp_ms(clock);
        event::emit(ProtectionDeregisteredEvent {
            registry_id: object::id(registry),
            owner,
            obligation_id,
        });
    }

    /// Re-enable protection after deactivation.
    public entry fun activate_position(
        registry: &mut ShieldRegistry,
        obligation_id: address,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(table::contains(&registry.records, obligation_id), E_NOT_REGISTERED);
        let owner = tx_context::sender(ctx);
        let record = table::borrow_mut(&mut registry.records, obligation_id);
        assert!(record.owner == owner, E_NOT_OWNER);
        record.active = true;
        record.updated_at_ms = clock::timestamp_ms(clock);
        event::emit(PositionUpdatedEvent {
            registry_id: object::id(registry),
            owner,
            obligation_id,
            field: b"active",
        });
    }

    // ═══════════════════════════════════════════════
    // Guard — called by executor in begin_rescue
    // ═══════════════════════════════════════════════

    /// Full cross-object consistency check. Aborts if:
    ///   - obligation not registered
    ///   - record not active
    ///   - record owner != expected owner
    ///   - protocol mismatch
    ///   - vault_id mismatch
    ///   - policy_id mismatch
    public fun assert_registered(
        registry: &ShieldRegistry,
        owner: address,
        protocol: &vector<u8>,
        obligation_id: address,
        vault_id: ID,
        policy_id: ID,
    ) {
        assert!(table::contains(&registry.records, obligation_id), E_NOT_REGISTERED);
        let record = table::borrow(&registry.records, obligation_id);
        assert!(record.active, E_NOT_ACTIVE);
        assert!(record.owner == owner, E_REGISTRY_OWNER_MISMATCH);
        assert!(&record.protocol == protocol, E_WRONG_PROTOCOL);
        assert!(record.vault_id == vault_id, E_VAULT_MISMATCH);
        assert!(record.policy_id == policy_id, E_POLICY_MISMATCH);
    }

    // ═══════════════════════════════════════════════
    // Accessors for individual record fields
    // ═══════════════════════════════════════════════

    public fun record_owner(registry: &ShieldRegistry, obligation_id: address): address {
        table::borrow(&registry.records, obligation_id).owner
    }

    public fun record_vault_id(registry: &ShieldRegistry, obligation_id: address): ID {
        table::borrow(&registry.records, obligation_id).vault_id
    }

    public fun record_policy_id(registry: &ShieldRegistry, obligation_id: address): ID {
        table::borrow(&registry.records, obligation_id).policy_id
    }

    public fun record_active(registry: &ShieldRegistry, obligation_id: address): bool {
        table::borrow(&registry.records, obligation_id).active
    }

    public fun is_registered(registry: &ShieldRegistry, obligation_id: address): bool {
        table::contains(&registry.records, obligation_id)
    }

    public fun total_registered(r: &ShieldRegistry): u64 { r.total_registered }
}
