/// Emergency reserve vault. Shared object — the guardian agent can withdraw
/// from it without the user's signature on every rescue, but only within
/// the per-action and rolling daily limits. Each user deploys one vault
/// per coin type (e.g. ShieldVault<USDC>, ShieldVault<SUI>).
module liquidshield::shield_vault {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::transfer;
    use sui::event;
    use sui::clock::{Self, Clock};

    // ═══════════════════════════════════════════════
    // Structs
    // ═══════════════════════════════════════════════

    public struct ShieldVault<phantom T> has key {
        id: UID,
        owner: address,
        balance: Balance<T>,
        /// Lifetime total deposited (for analytics)
        total_deposited: u64,
        /// Lifetime total spent on rescues
        total_spent: u64,
        /// Amount already spent in the current day window
        spent_in_window: u64,
        /// Unix epoch ms when the current spend window started
        window_start_ms: u64,
        /// Rolling window duration in ms (default 86_400_000 = 24 h)
        window_duration_ms: u64,
        /// Hard ceiling on a single rescue withdrawal
        max_per_action: u64,
        /// Hard ceiling on total spend per rolling window
        max_per_window: u64,
    }

    // ═══════════════════════════════════════════════
    // Events
    // ═══════════════════════════════════════════════

    public struct ReserveDepositedEvent has copy, drop {
        vault_id: ID,
        owner: address,
        amount: u64,
        new_balance: u64,
    }

    public struct ReserveWithdrawnEvent has copy, drop {
        vault_id: ID,
        owner: address,
        amount: u64,
        new_balance: u64,
    }

    public struct SpendWindowResetEvent has copy, drop {
        vault_id: ID,
        old_window_start_ms: u64,
        new_window_start_ms: u64,
    }

    // ═══════════════════════════════════════════════
    // Errors
    // ═══════════════════════════════════════════════

    const E_NOT_OWNER: u64 = 1;
    const E_INSUFFICIENT_BALANCE: u64 = 2;
    const E_EXCEEDS_MAX_PER_ACTION: u64 = 3;
    const E_EXCEEDS_WINDOW_LIMIT: u64 = 4;
    const E_ZERO_AMOUNT: u64 = 5;

    // ═══════════════════════════════════════════════
    // Entry — user setup
    // ═══════════════════════════════════════════════

    /// Create a vault and immediately deposit initial reserve.
    /// The vault is shared so the guardian agent can call `reserve_for_rescue`
    /// without the user cosigning every PTB.
    public entry fun create_and_deposit<T>(
        initial_coin: Coin<T>,
        max_per_action: u64,
        max_per_window: u64,
        window_duration_ms: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let owner = tx_context::sender(ctx);
        let amount = coin::value(&initial_coin);
        let vault = ShieldVault<T> {
            id: object::new(ctx),
            owner,
            balance: coin::into_balance(initial_coin),
            total_deposited: amount,
            total_spent: 0,
            spent_in_window: 0,
            window_start_ms: clock::timestamp_ms(clock),
            window_duration_ms,
            max_per_action,
            max_per_window,
        };
        event::emit(ReserveDepositedEvent {
            vault_id: object::id(&vault),
            owner,
            amount,
            new_balance: amount,
        });
        transfer::share_object(vault);
    }

    // ═══════════════════════════════════════════════
    // Owner actions
    // ═══════════════════════════════════════════════

    public entry fun deposit<T>(
        vault: &mut ShieldVault<T>,
        coin: Coin<T>,
        ctx: &mut TxContext,
    ) {
        assert!(vault.owner == tx_context::sender(ctx), E_NOT_OWNER);
        let amount = coin::value(&coin);
        balance::join(&mut vault.balance, coin::into_balance(coin));
        vault.total_deposited = vault.total_deposited + amount;
        event::emit(ReserveDepositedEvent {
            vault_id: object::id(vault),
            owner: vault.owner,
            amount,
            new_balance: balance::value(&vault.balance),
        });
    }

    /// Owner withdraws unused reserve at any time.
    public entry fun owner_withdraw<T>(
        vault: &mut ShieldVault<T>,
        amount: u64,
        ctx: &mut TxContext,
    ) {
        assert!(vault.owner == tx_context::sender(ctx), E_NOT_OWNER);
        assert!(amount > 0, E_ZERO_AMOUNT);
        assert!(balance::value(&vault.balance) >= amount, E_INSUFFICIENT_BALANCE);
        let withdrawn = coin::from_balance(balance::split(&mut vault.balance, amount), ctx);
        event::emit(ReserveWithdrawnEvent {
            vault_id: object::id(vault),
            owner: vault.owner,
            amount,
            new_balance: balance::value(&vault.balance),
        });
        transfer::public_transfer(withdrawn, vault.owner);
    }

    // ═══════════════════════════════════════════════
    // Guardian access — called inside rescue PTBs
    // ═══════════════════════════════════════════════

    /// Withdraw `amount` coins for a rescue. Enforces per-action and rolling
    /// window limits. Returns the coins to be passed to the protocol adapter.
    ///
    /// This is called by `shield_executor` after validating GuardianCap and
    /// RiskPolicy. The executor must call `record_spend` in the same PTB to
    /// account for what was actually used.
    public fun reserve_for_rescue<T>(
        vault: &mut ShieldVault<T>,
        amount: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ): Coin<T> {
        assert!(amount > 0, E_ZERO_AMOUNT);
        assert!(amount <= vault.max_per_action, E_EXCEEDS_MAX_PER_ACTION);
        assert!(balance::value(&vault.balance) >= amount, E_INSUFFICIENT_BALANCE);

        maybe_reset_window(vault, clock);

        assert!(
            vault.spent_in_window + amount <= vault.max_per_window,
            E_EXCEEDS_WINDOW_LIMIT,
        );

        vault.spent_in_window = vault.spent_in_window + amount;
        vault.total_spent = vault.total_spent + amount;

        coin::from_balance(balance::split(&mut vault.balance, amount), ctx)
    }

    /// Return leftover coins to the vault (e.g. if only a partial repay was
    /// needed). Called by the executor in the same PTB after the protocol call.
    public fun return_unused<T>(vault: &mut ShieldVault<T>, coin: Coin<T>) {
        let amount = coin::value(&coin);
        // Reverse the spend counters for the unused portion
        if (amount > 0) {
            vault.spent_in_window = if (vault.spent_in_window >= amount) {
                vault.spent_in_window - amount
            } else {
                0
            };
            vault.total_spent = if (vault.total_spent >= amount) {
                vault.total_spent - amount
            } else {
                0
            };
        };
        balance::join(&mut vault.balance, coin::into_balance(coin));
    }

    // ═══════════════════════════════════════════════
    // Internal
    // ═══════════════════════════════════════════════

    fun maybe_reset_window<T>(vault: &mut ShieldVault<T>, clock: &Clock) {
        let now = clock::timestamp_ms(clock);
        if (now >= vault.window_start_ms + vault.window_duration_ms) {
            event::emit(SpendWindowResetEvent {
                vault_id: object::id(vault),
                old_window_start_ms: vault.window_start_ms,
                new_window_start_ms: now,
            });
            vault.window_start_ms = now;
            vault.spent_in_window = 0;
        }
    }

    // ═══════════════════════════════════════════════
    // Accessors
    // ═══════════════════════════════════════════════

    public fun owner<T>(v: &ShieldVault<T>): address { v.owner }
    public fun available_balance<T>(v: &ShieldVault<T>): u64 { balance::value(&v.balance) }
    public fun spent_in_window<T>(v: &ShieldVault<T>): u64 { v.spent_in_window }
    public fun total_spent<T>(v: &ShieldVault<T>): u64 { v.total_spent }
    public fun max_per_action<T>(v: &ShieldVault<T>): u64 { v.max_per_action }
    public fun max_per_window<T>(v: &ShieldVault<T>): u64 { v.max_per_window }
    public fun remaining_in_window<T>(v: &ShieldVault<T>): u64 {
        if (v.max_per_window > v.spent_in_window) {
            v.max_per_window - v.spent_in_window
        } else {
            0
        }
    }
}
