/// On-chain risk snapshot store. The off-chain agent pushes a fresh
/// RiskSnapshot before (or as the first step of) each rescue PTB.
/// The executor asserts snapshot freshness so that a stale or missing
/// snapshot blocks execution — fail-closed by design.
module liquidshield::shield_oracle {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::event;
    use sui::clock::{Self, Clock};

    // ═══════════════════════════════════════════════
    // Structs
    // ═══════════════════════════════════════════════

    /// One shared RiskSnapshot per protected obligation.
    /// Keyed by obligation_id (the Scallop / NAVI obligation address).
    public struct RiskSnapshot has key {
        id: UID,
        /// The on-chain obligation address this snapshot tracks.
        /// Used by the executor to prove the snapshot matches the rescue target.
        obligation_id: address,
        /// Who is authorized to push updates (the agent address)
        agent: address,
        /// Composite risk score 0-100
        risk_score: u8,
        /// Human-readable severity: 0=normal,1=watch,2=guarded,3=emergency
        severity: u8,
        /// Encoded reason flags (bit mask): see reason code constants below
        reason_codes: u64,
        /// Recommended action: 0=none,1=alert,2=repay,3=topup
        recommended_action: u8,
        /// Health factor scaled x1000 (e.g. 1250 = 1.25). 0 = not applicable.
        health_factor_x1000: u64,
        /// Oracle price of collateral asset in USD, scaled x1e6
        collateral_price_usd_x1e6: u64,
        /// Unix epoch ms of this snapshot
        snapshot_at_ms: u64,
        /// Unix epoch ms of the price feed used
        price_feed_at_ms: u64,
    }

    // ═══════════════════════════════════════════════
    // Reason code bit flags (OR together)
    // ═══════════════════════════════════════════════

    const REASON_LOW_HEALTH_FACTOR: u64 = 1;
    const REASON_PRICE_DROP: u64        = 2;
    const REASON_STALE_ORACLE: u64      = 4;
    const REASON_LOW_LIQUIDITY: u64     = 8;
    const REASON_HIGH_VOLATILITY: u64   = 16;
    const REASON_LOW_RESERVE: u64       = 32;

    // ═══════════════════════════════════════════════
    // Events
    // ═══════════════════════════════════════════════

    public struct RiskSnapshotCreatedEvent has copy, drop {
        snapshot_id: ID,
        obligation_id: address,
        agent: address,
    }

    public struct RiskScoreUpdatedEvent has copy, drop {
        snapshot_id: ID,
        obligation_id: address,
        risk_score: u8,
        severity: u8,
        reason_codes: u64,
        recommended_action: u8,
        health_factor_x1000: u64,
        snapshot_at_ms: u64,
    }

    // ═══════════════════════════════════════════════
    // Errors
    // ═══════════════════════════════════════════════

    const E_NOT_AGENT: u64 = 1;
    const E_SNAPSHOT_STALE: u64 = 2;
    const E_SCORE_BELOW_TRIGGER: u64 = 3;

    // ═══════════════════════════════════════════════
    // Setup — create snapshot during onboarding
    // ═══════════════════════════════════════════════

    /// Create a RiskSnapshot for an obligation and share it.
    /// Called once per obligation during user onboarding.
    public entry fun create_snapshot(
        obligation_id: address,
        agent: address,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let now = clock::timestamp_ms(clock);
        let snapshot = RiskSnapshot {
            id: object::new(ctx),
            obligation_id,
            agent,
            risk_score: 0,
            severity: 0,
            reason_codes: 0,
            recommended_action: 0,
            health_factor_x1000: 0,
            collateral_price_usd_x1e6: 0,
            snapshot_at_ms: now,
            price_feed_at_ms: now,
        };
        event::emit(RiskSnapshotCreatedEvent {
            snapshot_id: object::id(&snapshot),
            obligation_id,
            agent,
        });
        transfer::share_object(snapshot);
    }

    // ═══════════════════════════════════════════════
    // Agent push
    // ═══════════════════════════════════════════════

    /// Agent submits an updated risk snapshot. Typically the first step of a
    /// rescue PTB or a preceding monitoring TX.
    public entry fun submit_risk_snapshot(
        snapshot: &mut RiskSnapshot,
        risk_score: u8,
        severity: u8,
        reason_codes: u64,
        recommended_action: u8,
        health_factor_x1000: u64,
        collateral_price_usd_x1e6: u64,
        price_feed_at_ms: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(snapshot.agent == tx_context::sender(ctx), E_NOT_AGENT);
        let now = clock::timestamp_ms(clock);
        snapshot.risk_score = risk_score;
        snapshot.severity = severity;
        snapshot.reason_codes = reason_codes;
        snapshot.recommended_action = recommended_action;
        snapshot.health_factor_x1000 = health_factor_x1000;
        snapshot.collateral_price_usd_x1e6 = collateral_price_usd_x1e6;
        snapshot.snapshot_at_ms = now;
        snapshot.price_feed_at_ms = price_feed_at_ms;
        event::emit(RiskScoreUpdatedEvent {
            snapshot_id: object::id(snapshot),
            obligation_id: snapshot.obligation_id,
            risk_score,
            severity,
            reason_codes,
            recommended_action,
            health_factor_x1000,
            snapshot_at_ms: now,
        });
    }

    // ═══════════════════════════════════════════════
    // Guard — called by executor
    // ═══════════════════════════════════════════════

    /// Abort if the snapshot is older than `max_age_ms` or score < `trigger_score`.
    public fun assert_fresh_and_triggered(
        snapshot: &RiskSnapshot,
        trigger_score: u8,
        max_age_ms: u64,
        clock: &Clock,
    ) {
        let now = clock::timestamp_ms(clock);
        assert!(now - snapshot.snapshot_at_ms <= max_age_ms, E_SNAPSHOT_STALE);
        assert!(snapshot.risk_score >= trigger_score, E_SCORE_BELOW_TRIGGER);
    }

    // ═══════════════════════════════════════════════
    // Accessors
    // ═══════════════════════════════════════════════

    /// Returns the obligation address this snapshot tracks.
    /// Used by the executor's cross-object consistency check.
    public fun position_key(s: &RiskSnapshot): address { s.obligation_id }
    public fun obligation_id(s: &RiskSnapshot): address { s.obligation_id }
    public fun risk_score(s: &RiskSnapshot): u8 { s.risk_score }
    public fun severity(s: &RiskSnapshot): u8 { s.severity }
    public fun reason_codes(s: &RiskSnapshot): u64 { s.reason_codes }
    public fun recommended_action(s: &RiskSnapshot): u8 { s.recommended_action }
    public fun health_factor_x1000(s: &RiskSnapshot): u64 { s.health_factor_x1000 }
    public fun snapshot_at_ms(s: &RiskSnapshot): u64 { s.snapshot_at_ms }
    public fun agent(s: &RiskSnapshot): address { s.agent }

    // Re-export reason code constants for PTB builders
    public fun reason_low_health_factor(): u64 { REASON_LOW_HEALTH_FACTOR }
    public fun reason_price_drop(): u64        { REASON_PRICE_DROP }
    public fun reason_stale_oracle(): u64      { REASON_STALE_ORACLE }
    public fun reason_low_liquidity(): u64     { REASON_LOW_LIQUIDITY }
    public fun reason_high_volatility(): u64   { REASON_HIGH_VOLATILITY }
    public fun reason_low_reserve(): u64       { REASON_LOW_RESERVE }
}
