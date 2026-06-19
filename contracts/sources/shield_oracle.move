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

    /// One shared RiskSnapshot per protected position.
    /// The agent updates this every monitoring cycle.
    public struct RiskSnapshot has key {
        id: UID,
        /// The ProtectedPosition this snapshot belongs to
        position_id: ID,
        /// Who is authorized to push updates (the agent address)
        agent: address,
        /// Composite risk score 0-100
        risk_score: u8,
        /// Human-readable severity tag: 0=normal,1=watch,2=guarded,3=emergency
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

    // Low health factor — close to liquidation boundary
    const REASON_LOW_HEALTH_FACTOR: u64   = 1;
    // Price dropped significantly since last snapshot
    const REASON_PRICE_DROP: u64          = 2;
    // Oracle feed is stale or low-confidence
    const REASON_STALE_ORACLE: u64        = 4;
    // DeepBook liquidity thin for the collateral/debt pair
    const REASON_LOW_LIQUIDITY: u64       = 8;
    // High realized or implied volatility
    const REASON_HIGH_VOLATILITY: u64     = 16;
    // Reserve fund almost exhausted
    const REASON_LOW_RESERVE: u64         = 32;

    // ═══════════════════════════════════════════════
    // Events
    // ═══════════════════════════════════════════════

    public struct RiskSnapshotCreatedEvent has copy, drop {
        snapshot_id: ID,
        position_id: ID,
        agent: address,
    }

    public struct RiskScoreUpdatedEvent has copy, drop {
        snapshot_id: ID,
        position_id: ID,
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
    // Agent setup
    // ═══════════════════════════════════════════════

    /// Create a RiskSnapshot for a position and share it.
    /// Called once by the user (or agent during onboarding) per position.
    public entry fun create_snapshot(
        position_id: ID,
        agent: address,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let now = clock::timestamp_ms(clock);
        let snapshot = RiskSnapshot {
            id: object::new(ctx),
            position_id,
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
            position_id,
            agent,
        });
        transfer::share_object(snapshot);
    }

    // ═══════════════════════════════════════════════
    // Agent push
    // ═══════════════════════════════════════════════

    /// Agent submits an updated risk snapshot. This is typically step 1 of
    /// a rescue PTB (or a separate preceding TX in the monitoring loop).
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
            position_id: snapshot.position_id,
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

    /// Abort if the snapshot is older than `max_age_ms` or if the risk score
    /// has not reached `trigger_score`. Both checks must pass for execution.
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

    public fun risk_score(s: &RiskSnapshot): u8 { s.risk_score }
    public fun severity(s: &RiskSnapshot): u8 { s.severity }
    public fun reason_codes(s: &RiskSnapshot): u64 { s.reason_codes }
    public fun recommended_action(s: &RiskSnapshot): u8 { s.recommended_action }
    public fun health_factor_x1000(s: &RiskSnapshot): u64 { s.health_factor_x1000 }
    public fun snapshot_at_ms(s: &RiskSnapshot): u64 { s.snapshot_at_ms }
    public fun position_id(s: &RiskSnapshot): ID { s.position_id }
    public fun agent(s: &RiskSnapshot): address { s.agent }

    // Re-export reason code constants for PTB builders
    public fun reason_low_health_factor(): u64  { REASON_LOW_HEALTH_FACTOR }
    public fun reason_price_drop(): u64         { REASON_PRICE_DROP }
    public fun reason_stale_oracle(): u64       { REASON_STALE_ORACLE }
    public fun reason_low_liquidity(): u64      { REASON_LOW_LIQUIDITY }
    public fun reason_high_volatility(): u64    { REASON_HIGH_VOLATILITY }
    public fun reason_low_reserve(): u64        { REASON_LOW_RESERVE }
}
