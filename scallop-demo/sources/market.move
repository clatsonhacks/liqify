/// Minimal Scallop-shaped demo protocol for TESTNET end-to-end testing of liquifi.
/// Mirrors the object + entry-function interface the rescue PTB expects
/// (Version, Market, Obligation + repay::repay / deposit_collateral::deposit_collateral),
/// so the full flow (SeFi -> agent -> snapshot -> rescue -> ShieldActivatedEvent) can be
/// exercised on testnet where real Scallop (mainnet-only) does not exist.
module scallop_demo::market {
    use sui::event;

    /// Shared version gate (Scallop passes a &Version to every call).
    public struct Version has key { id: UID, value: u64 }

    /// Shared lending market.
    public struct Market has key { id: UID, total_repaid: u64, total_collateral: u64 }

    /// Shared borrowing position (the rescue target). debt is in base coin units.
    public struct Obligation has key { id: UID, debt: u64, collateral: u64 }

    public struct ObligationCreated has copy, drop { obligation_id: ID, debt: u64 }
    public struct DebtRepaid has copy, drop { obligation_id: ID, amount: u64, remaining_debt: u64 }
    public struct CollateralAdded has copy, drop { obligation_id: ID, amount: u64, total_collateral: u64 }

    fun init(ctx: &mut TxContext) {
        transfer::share_object(Version { id: object::new(ctx), value: 1 });
        transfer::share_object(Market { id: object::new(ctx), total_repaid: 0, total_collateral: 0 });
    }

    /// Create a shared Obligation with an initial debt (so there's something to rescue).
    public entry fun create_obligation(initial_debt: u64, ctx: &mut TxContext) {
        let ob = Obligation { id: object::new(ctx), debt: initial_debt, collateral: 0 };
        event::emit(ObligationCreated { obligation_id: object::id(&ob), debt: initial_debt });
        transfer::share_object(ob);
    }

    // ── helpers used by repay / deposit_collateral modules ──
    public fun apply_repay(market: &mut Market, ob: &mut Obligation, amt: u64) {
        ob.debt = if (ob.debt > amt) { ob.debt - amt } else { 0 };
        market.total_repaid = market.total_repaid + amt;
        event::emit(DebtRepaid { obligation_id: object::id(ob), amount: amt, remaining_debt: ob.debt });
    }

    public fun apply_collateral(market: &mut Market, ob: &mut Obligation, amt: u64) {
        ob.collateral = ob.collateral + amt;
        market.total_collateral = market.total_collateral + amt;
        event::emit(CollateralAdded { obligation_id: object::id(ob), amount: amt, total_collateral: ob.collateral });
    }

    public fun debt(ob: &Obligation): u64 { ob.debt }
    public fun version_value(v: &Version): u64 { v.value }
}
