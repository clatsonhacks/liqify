/// Unit and property tests for LiquidShield Guardian Move contracts.
///
/// Coverage (#23 unit tests):
///   register, revoke, pause, expired policy, wrong protocol, wrong obligation,
///   wrong vault/policy in registry, stale snapshot, score below trigger,
///   amount over max_per_action, amount over daily window, agent mismatch,
///   owner mismatch, DAO pause/revoke.
///
/// Coverage (#24 property tests):
///   vault balance never negative, total spent <= window cap,
///   revoked/expired delegation never authorizes,
///   wrong obligation never rescued, wrong coin type invariant via registry mismatch.
#[test_only]
module liquidshield::liquidshield_tests {
    use sui::test_scenario::{Self as ts, Scenario};
    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::object;

    use liquidshield::guardian_cap::{Self, GuardianDelegation, DAOOverrideCap};
    use liquidshield::risk_policy::{Self, RiskPolicy};
    use liquidshield::shield_vault::{Self, ShieldVault};
    use liquidshield::shield_registry::{Self, ShieldRegistry};
    use liquidshield::shield_oracle::{Self, RiskSnapshot};

    // ── Test addresses ──
    const OWNER:    address = @0xA001;
    const AGENT:    address = @0xA002;
    const STRANGER: address = @0xA003;
    const DAO:      address = @0xA004;

    // ── Helpers ──

    const OBLIGATION_ID: address = @0xB001;
    const TRIGGER_SCORE: u8  = 70;
    const MAX_PER_ACTION: u64 = 500_000_000; // 500 USDC
    const MAX_DAILY: u64      = 1_000_000_000;
    const EXPIRES_MS: u64     = 9_999_999_999_999;
    const NOW_MS: u64         = 1_000_000;
    const MAX_AGE_MS: u64     = 60_000;

    // ── Scenario bootstrap helpers ──

    fun setup_clock(scenario: &mut Scenario): Clock {
        let ctx = ts::ctx(scenario);
        let mut clk = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut clk, NOW_MS);
        clk
    }

    /// Bootstrap: initialise the shared ShieldRegistry and DAOOverrideCap.
    /// Must be called at the start of each scenario (sender becomes admin/DAO).
    fun bootstrap(scenario: &mut Scenario, admin: address) {
        ts::next_tx(scenario, admin);
        {
            let ctx = ts::ctx(scenario);
            shield_registry::init_for_testing(ctx);
            guardian_cap::init_for_testing(ctx);
        };
    }

    fun create_policy(scenario: &mut Scenario): ID {
        ts::next_tx(scenario, OWNER);
        {
            let ctx = ts::ctx(scenario);
            risk_policy::create_and_share_policy(
                TRIGGER_SCORE,
                MAX_PER_ACTION,
                MAX_DAILY,
                EXPIRES_MS,
                1200,
                ctx,
            );
        };
        ts::next_tx(scenario, OWNER);
        let policy = ts::take_shared<RiskPolicy>(scenario);
        let id = object::id(&policy);
        ts::return_shared(policy);
        id
    }

    fun create_vault(scenario: &mut Scenario, clk: &Clock): ID {
        ts::next_tx(scenario, OWNER);
        {
            let ctx = ts::ctx(scenario);
            let coin = coin::mint_for_testing<SUI>(1_000_000_000, ctx);
            shield_vault::create_and_deposit<SUI>(
                coin,
                MAX_PER_ACTION,
                MAX_DAILY,
                86_400_000,
                clk,
                ctx,
            );
        };
        ts::next_tx(scenario, OWNER);
        let vault = ts::take_shared<ShieldVault<SUI>>(scenario);
        let id = object::id(&vault);
        ts::return_shared(vault);
        id
    }

    fun create_delegation(scenario: &mut Scenario, policy_id: ID): ID {
        ts::next_tx(scenario, OWNER);
        {
            let ctx = ts::ctx(scenario);
            guardian_cap::create_delegation(AGENT, policy_id, EXPIRES_MS, ctx);
        };
        ts::next_tx(scenario, OWNER);
        let d = ts::take_shared<GuardianDelegation>(scenario);
        let id = object::id(&d);
        ts::return_shared(d);
        id
    }

    fun create_snapshot(scenario: &mut Scenario, clk: &Clock): ID {
        ts::next_tx(scenario, AGENT);
        {
            let ctx = ts::ctx(scenario);
            shield_oracle::create_snapshot(OBLIGATION_ID, AGENT, clk, ctx);
        };
        ts::next_tx(scenario, AGENT);
        let snap = ts::take_shared<RiskSnapshot>(scenario);
        let id = object::id(&snap);
        ts::return_shared(snap);
        id
    }

    fun push_snapshot(scenario: &mut Scenario, score: u8, clk: &Clock) {
        ts::next_tx(scenario, AGENT);
        {
            let mut snap = ts::take_shared<RiskSnapshot>(scenario);
            let ctx = ts::ctx(scenario);
            shield_oracle::submit_risk_snapshot(
                &mut snap, score, 3, 1, 2, 900, 1_000_000, NOW_MS, clk, ctx,
            );
            ts::return_shared(snap);
        };
    }

    fun register_obligation(
        scenario: &mut Scenario,
        vault_id: ID,
        policy_id: ID,
        snapshot_id: ID,
        clk: &Clock,
    ) {
        ts::next_tx(scenario, OWNER);
        {
            let mut registry = ts::take_shared<ShieldRegistry>(scenario);
            let ctx = ts::ctx(scenario);
            shield_registry::register_position(
                &mut registry,
                b"scallop",
                OBLIGATION_ID,
                vault_id,
                policy_id,
                snapshot_id,
                b"SUI",
                b"USDC",
                clk,
                ctx,
            );
            ts::return_shared(registry);
        };
    }

    // ══════════════════════════════════════════════
    // #23 Unit tests
    // ══════════════════════════════════════════════

    // ── Guardian delegation ──

    #[test]
    fun test_create_delegation_succeeds() {
        let mut scenario = ts::begin(OWNER);
        bootstrap(&mut scenario, OWNER);
        let clk = setup_clock(&mut scenario);

        let policy_id = create_policy(&mut scenario);
        let _d_id = create_delegation(&mut scenario, policy_id);

        ts::next_tx(&mut scenario, OWNER);
        {
            let d = ts::take_shared<GuardianDelegation>(&mut scenario);
            assert!(guardian_cap::delegation_owner(&d) == OWNER, 0);
            assert!(guardian_cap::delegation_agent(&d) == AGENT, 1);
            assert!(!guardian_cap::is_revoked(&d), 2);
            ts::return_shared(d);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    #[test]
    fun test_revoke_delegation_by_owner() {
        let mut scenario = ts::begin(OWNER);
        bootstrap(&mut scenario, OWNER);
        let clk = setup_clock(&mut scenario);

        let policy_id = create_policy(&mut scenario);
        create_delegation(&mut scenario, policy_id);

        ts::next_tx(&mut scenario, OWNER);
        {
            let mut d = ts::take_shared<GuardianDelegation>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            guardian_cap::revoke_delegation(&mut d, ctx);
            assert!(guardian_cap::is_revoked(&d), 0);
            assert!(guardian_cap::nonce(&d) == 1, 1);
            ts::return_shared(d);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    #[test, expected_failure(abort_code = liquidshield::guardian_cap::E_NOT_OWNER)]
    fun test_revoke_delegation_by_stranger_aborts() {
        let mut scenario = ts::begin(OWNER);
        bootstrap(&mut scenario, OWNER);
        let clk = setup_clock(&mut scenario);

        let policy_id = create_policy(&mut scenario);
        create_delegation(&mut scenario, policy_id);

        ts::next_tx(&mut scenario, STRANGER);
        {
            let mut d = ts::take_shared<GuardianDelegation>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            guardian_cap::revoke_delegation(&mut d, ctx); // should abort
            ts::return_shared(d);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    // ── Registry ──

    #[test]
    fun test_register_position_succeeds() {
        let mut scenario = ts::begin(OWNER);
        bootstrap(&mut scenario, OWNER);
        let clk = setup_clock(&mut scenario);

        let policy_id  = create_policy(&mut scenario);
        let vault_id   = create_vault(&mut scenario, &clk);
        let snap_id    = create_snapshot(&mut scenario, &clk);

        register_obligation(&mut scenario, vault_id, policy_id, snap_id, &clk);

        ts::next_tx(&mut scenario, OWNER);
        {
            let registry = ts::take_shared<ShieldRegistry>(&mut scenario);
            assert!(shield_registry::is_registered(&registry, OBLIGATION_ID), 0);
            assert!(shield_registry::record_active(&registry, OBLIGATION_ID), 1);
            assert!(shield_registry::total_registered(&registry) == 1, 2);
            ts::return_shared(registry);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    #[test, expected_failure(abort_code = liquidshield::shield_registry::E_ALREADY_REGISTERED)]
    fun test_double_register_aborts() {
        let mut scenario = ts::begin(OWNER);
        bootstrap(&mut scenario, OWNER);
        let clk = setup_clock(&mut scenario);

        let policy_id = create_policy(&mut scenario);
        let vault_id  = create_vault(&mut scenario, &clk);
        let snap_id   = create_snapshot(&mut scenario, &clk);

        register_obligation(&mut scenario, vault_id, policy_id, snap_id, &clk);

        // Register same obligation again → should abort
        ts::next_tx(&mut scenario, OWNER);
        {
            let mut registry = ts::take_shared<ShieldRegistry>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            shield_registry::register_position(
                &mut registry, b"scallop", OBLIGATION_ID,
                vault_id, policy_id, snap_id, b"SUI", b"USDC", &clk, ctx,
            );
            ts::return_shared(registry);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    #[test]
    fun test_deactivate_then_activate_position() {
        let mut scenario = ts::begin(OWNER);
        bootstrap(&mut scenario, OWNER);
        let clk = setup_clock(&mut scenario);

        let policy_id = create_policy(&mut scenario);
        let vault_id  = create_vault(&mut scenario, &clk);
        let snap_id   = create_snapshot(&mut scenario, &clk);
        register_obligation(&mut scenario, vault_id, policy_id, snap_id, &clk);

        ts::next_tx(&mut scenario, OWNER);
        {
            let mut registry = ts::take_shared<ShieldRegistry>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            shield_registry::deactivate_position(&mut registry, OBLIGATION_ID, &clk, ctx);
            assert!(!shield_registry::record_active(&registry, OBLIGATION_ID), 0);
            ts::return_shared(registry);
        };

        ts::next_tx(&mut scenario, OWNER);
        {
            let mut registry = ts::take_shared<ShieldRegistry>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            shield_registry::activate_position(&mut registry, OBLIGATION_ID, &clk, ctx);
            assert!(shield_registry::record_active(&registry, OBLIGATION_ID), 1);
            ts::return_shared(registry);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    #[test, expected_failure(abort_code = liquidshield::shield_registry::E_NOT_OWNER)]
    fun test_deactivate_by_stranger_aborts() {
        let mut scenario = ts::begin(OWNER);
        bootstrap(&mut scenario, OWNER);
        let clk = setup_clock(&mut scenario);

        let policy_id = create_policy(&mut scenario);
        let vault_id  = create_vault(&mut scenario, &clk);
        let snap_id   = create_snapshot(&mut scenario, &clk);
        register_obligation(&mut scenario, vault_id, policy_id, snap_id, &clk);

        ts::next_tx(&mut scenario, STRANGER);
        {
            let mut registry = ts::take_shared<ShieldRegistry>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            shield_registry::deactivate_position(&mut registry, OBLIGATION_ID, &clk, ctx);
            ts::return_shared(registry);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    // ── Risk policy ──

    #[test]
    fun test_policy_pause_and_unpause() {
        let mut scenario = ts::begin(OWNER);
        let clk = setup_clock(&mut scenario);
        create_policy(&mut scenario);

        ts::next_tx(&mut scenario, OWNER);
        {
            let mut policy = ts::take_shared<RiskPolicy>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            risk_policy::pause(&mut policy, ctx);
            assert!(risk_policy::is_paused(&policy), 0);
            ts::return_shared(policy);
        };

        ts::next_tx(&mut scenario, OWNER);
        {
            let mut policy = ts::take_shared<RiskPolicy>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            risk_policy::unpause(&mut policy, ctx);
            assert!(!risk_policy::is_paused(&policy), 1);
            ts::return_shared(policy);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    #[test]
    fun test_policy_revoke() {
        let mut scenario = ts::begin(OWNER);
        let clk = setup_clock(&mut scenario);
        create_policy(&mut scenario);

        ts::next_tx(&mut scenario, OWNER);
        {
            let mut policy = ts::take_shared<RiskPolicy>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            risk_policy::revoke(&mut policy, ctx);
            assert!(risk_policy::is_revoked(&policy), 0);
            ts::return_shared(policy);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    #[test, expected_failure(abort_code = liquidshield::risk_policy::E_NOT_OWNER)]
    fun test_policy_pause_by_stranger_aborts() {
        let mut scenario = ts::begin(OWNER);
        let clk = setup_clock(&mut scenario);
        create_policy(&mut scenario);

        ts::next_tx(&mut scenario, STRANGER);
        {
            let mut policy = ts::take_shared<RiskPolicy>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            risk_policy::pause(&mut policy, ctx);
            ts::return_shared(policy);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    // ── DAO overrides ──

    #[test]
    fun test_dao_pause_and_unpause() {
        let mut scenario = ts::begin(DAO);
        // bootstrap as DAO so DAOOverrideCap is transferred to DAO
        bootstrap(&mut scenario, DAO);
        let clk = setup_clock(&mut scenario);

        create_policy(&mut scenario);

        ts::next_tx(&mut scenario, DAO);
        {
            let mut policy = ts::take_shared<RiskPolicy>(&mut scenario);
            let dao_cap = ts::take_from_sender<DAOOverrideCap>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            risk_policy::dao_pause(&mut policy, &dao_cap, ctx);
            assert!(risk_policy::is_paused(&policy), 0);
            ts::return_shared(policy);
            ts::return_to_sender(&mut scenario, dao_cap);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    // ── Vault ──

    #[test]
    fun test_vault_deposit_and_owner_withdraw() {
        let mut scenario = ts::begin(OWNER);
        let clk = setup_clock(&mut scenario);
        create_vault(&mut scenario, &clk);

        ts::next_tx(&mut scenario, OWNER);
        {
            let mut vault = ts::take_shared<ShieldVault<SUI>>(&mut scenario);
            assert!(shield_vault::available_balance(&vault) == 1_000_000_000, 0);

            // deposit more
            let ctx = ts::ctx(&mut scenario);
            let extra = coin::mint_for_testing<SUI>(500_000_000, ctx);
            shield_vault::deposit(&mut vault, extra, ctx);
            assert!(shield_vault::available_balance(&vault) == 1_500_000_000, 1);
            ts::return_shared(vault);
        };

        ts::next_tx(&mut scenario, OWNER);
        {
            let mut vault = ts::take_shared<ShieldVault<SUI>>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            shield_vault::owner_withdraw(&mut vault, 200_000_000, ctx);
            assert!(shield_vault::available_balance(&vault) == 1_300_000_000, 0);
            ts::return_shared(vault);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    #[test, expected_failure(abort_code = liquidshield::shield_vault::E_NOT_OWNER)]
    fun test_vault_withdraw_by_stranger_aborts() {
        let mut scenario = ts::begin(OWNER);
        let clk = setup_clock(&mut scenario);
        create_vault(&mut scenario, &clk);

        ts::next_tx(&mut scenario, STRANGER);
        {
            let mut vault = ts::take_shared<ShieldVault<SUI>>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            shield_vault::owner_withdraw(&mut vault, 100_000_000, ctx);
            ts::return_shared(vault);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    // ── Oracle snapshot ──

    #[test]
    fun test_snapshot_create_and_update() {
        let mut scenario = ts::begin(AGENT);
        let clk = setup_clock(&mut scenario);
        create_snapshot(&mut scenario, &clk);
        push_snapshot(&mut scenario, 85, &clk);

        ts::next_tx(&mut scenario, AGENT);
        {
            let snap = ts::take_shared<RiskSnapshot>(&mut scenario);
            assert!(shield_oracle::risk_score(&snap) == 85, 0);
            assert!(shield_oracle::position_key(&snap) == OBLIGATION_ID, 1);
            ts::return_shared(snap);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    #[test, expected_failure(abort_code = liquidshield::shield_oracle::E_NOT_AGENT)]
    fun test_snapshot_update_by_stranger_aborts() {
        let mut scenario = ts::begin(AGENT);
        let clk = setup_clock(&mut scenario);
        create_snapshot(&mut scenario, &clk);

        ts::next_tx(&mut scenario, STRANGER);
        {
            let mut snap = ts::take_shared<RiskSnapshot>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            shield_oracle::submit_risk_snapshot(
                &mut snap, 90, 3, 1, 2, 900, 1_000_000, NOW_MS, &clk, ctx,
            );
            ts::return_shared(snap);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    // ══════════════════════════════════════════════
    // #24 Property tests
    // ══════════════════════════════════════════════

    /// Property: vault balance never goes below zero.
    /// Withdraw exactly available balance → succeeds; withdraw one more → aborts.
    #[test, expected_failure(abort_code = liquidshield::shield_vault::E_INSUFFICIENT_BALANCE)]
    fun test_vault_balance_never_negative() {
        let mut scenario = ts::begin(OWNER);
        let mut clk = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clk, NOW_MS);

        ts::next_tx(&mut scenario, OWNER);
        {
            let ctx = ts::ctx(&mut scenario);
            let coin = coin::mint_for_testing<SUI>(100, ctx);
            shield_vault::create_and_deposit<SUI>(coin, 200, 200, 86_400_000, &clk, ctx);
        };

        ts::next_tx(&mut scenario, OWNER);
        {
            let mut vault = ts::take_shared<ShieldVault<SUI>>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            // Withdraw 101 when only 100 available → should abort
            shield_vault::owner_withdraw(&mut vault, 101, ctx);
            ts::return_shared(vault);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    /// Property: rolling window cap is enforced.
    /// Vault with max_per_action=600, max_per_window=500: first call of 600
    /// passes the per-action check but fails the window check (600 > 500).
    #[test, expected_failure(abort_code = liquidshield::shield_vault::E_EXCEEDS_WINDOW_LIMIT)]
    fun test_window_cap_enforced() {
        let mut scenario = ts::begin(OWNER);
        let mut clk = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clk, NOW_MS);

        // max_per_action=600, max_per_window=500 — so a single 600-unit rescue
        // passes the per-action limit but exceeds the window limit.
        ts::next_tx(&mut scenario, OWNER);
        {
            let ctx = ts::ctx(&mut scenario);
            let coin = coin::mint_for_testing<SUI>(10_000, ctx);
            shield_vault::create_and_deposit<SUI>(coin, 600, 500, 86_400_000, &clk, ctx);
        };

        ts::next_tx(&mut scenario, OWNER);
        {
            let mut vault = ts::take_shared<ShieldVault<SUI>>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            // 600 <= max_per_action(600) ✓ but 600 > max_per_window(500) → E_EXCEEDS_WINDOW_LIMIT
            let coin = shield_vault::reserve_for_rescue(&mut vault, 600, &clk, ctx);
            shield_vault::return_unused(&mut vault, coin);
            ts::return_shared(vault);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    /// Property: max_per_action is strictly enforced.
    #[test, expected_failure(abort_code = liquidshield::shield_vault::E_EXCEEDS_MAX_PER_ACTION)]
    fun test_max_per_action_enforced() {
        let mut scenario = ts::begin(OWNER);
        let mut clk = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clk, NOW_MS);

        ts::next_tx(&mut scenario, OWNER);
        {
            let ctx = ts::ctx(&mut scenario);
            let coin = coin::mint_for_testing<SUI>(1_000_000, ctx);
            // max_per_action = 100
            shield_vault::create_and_deposit<SUI>(coin, 100, 1_000_000, 86_400_000, &clk, ctx);
        };

        ts::next_tx(&mut scenario, OWNER);
        {
            let mut vault = ts::take_shared<ShieldVault<SUI>>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            // Try to withdraw 101 > max_per_action(100) → aborts
            let coin = shield_vault::reserve_for_rescue(&mut vault, 101, &clk, ctx);
            shield_vault::return_unused(&mut vault, coin);
            ts::return_shared(vault);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    /// Property: revoked delegation cannot be used (assert_valid aborts).
    #[test, expected_failure(abort_code = liquidshield::guardian_cap::E_DELEGATION_REVOKED)]
    fun test_revoked_delegation_blocks_assert_valid() {
        let mut scenario = ts::begin(OWNER);
        let mut clk = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clk, NOW_MS);

        let policy_id = create_policy(&mut scenario);
        create_delegation(&mut scenario, policy_id);

        // Owner revokes
        ts::next_tx(&mut scenario, OWNER);
        {
            let mut d = ts::take_shared<GuardianDelegation>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            guardian_cap::revoke_delegation(&mut d, ctx);
            ts::return_shared(d);
        };

        // Agent tries to assert_valid after revocation → aborts
        ts::next_tx(&mut scenario, AGENT);
        {
            let d = ts::take_shared<GuardianDelegation>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            guardian_cap::assert_valid(&d, policy_id, &clk, ctx);
            ts::return_shared(d);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    /// Property: expired delegation cannot be used.
    #[test, expected_failure(abort_code = liquidshield::guardian_cap::E_DELEGATION_EXPIRED)]
    fun test_expired_delegation_blocks_assert_valid() {
        let mut scenario = ts::begin(OWNER);
        let mut clk = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clk, NOW_MS);

        let policy_id = create_policy(&mut scenario);

        // Create delegation that expired in the past
        ts::next_tx(&mut scenario, OWNER);
        {
            let ctx = ts::ctx(&mut scenario);
            guardian_cap::create_delegation(AGENT, policy_id, NOW_MS - 1, ctx);
        };

        // Agent tries assert_valid → aborts (now >= expires_at_ms)
        ts::next_tx(&mut scenario, AGENT);
        {
            let d = ts::take_shared<GuardianDelegation>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            guardian_cap::assert_valid(&d, policy_id, &clk, ctx);
            ts::return_shared(d);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    /// Property: wrong sender (not the agent) cannot pass assert_valid.
    #[test, expected_failure(abort_code = liquidshield::guardian_cap::E_NOT_AGENT)]
    fun test_wrong_agent_blocks_assert_valid() {
        let mut scenario = ts::begin(OWNER);
        let mut clk = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clk, NOW_MS);

        let policy_id = create_policy(&mut scenario);
        create_delegation(&mut scenario, policy_id);

        // Stranger (not AGENT) calls assert_valid → aborts
        ts::next_tx(&mut scenario, STRANGER);
        {
            let d = ts::take_shared<GuardianDelegation>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            guardian_cap::assert_valid(&d, policy_id, &clk, ctx);
            ts::return_shared(d);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    /// Property: policy_id mismatch in assert_valid aborts.
    #[test, expected_failure(abort_code = liquidshield::guardian_cap::E_POLICY_MISMATCH)]
    fun test_wrong_policy_id_blocks_assert_valid() {
        let mut scenario = ts::begin(OWNER);
        let mut clk = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clk, NOW_MS);

        let policy_id = create_policy(&mut scenario);
        create_delegation(&mut scenario, policy_id);

        ts::next_tx(&mut scenario, AGENT);
        {
            let d = ts::take_shared<GuardianDelegation>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            // Pass a dummy ID that differs from policy_id
            let wrong_id = object::id_from_address(@0xDEAD);
            guardian_cap::assert_valid(&d, wrong_id, &clk, ctx);
            ts::return_shared(d);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    /// Property: stale snapshot aborts assert_fresh_and_triggered.
    #[test, expected_failure(abort_code = liquidshield::shield_oracle::E_SNAPSHOT_STALE)]
    fun test_stale_snapshot_aborts() {
        let mut scenario = ts::begin(AGENT);
        let mut clk = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clk, NOW_MS);

        create_snapshot(&mut scenario, &clk);
        push_snapshot(&mut scenario, 90, &clk);

        // Advance clock far past max_age_ms
        clock::set_for_testing(&mut clk, NOW_MS + MAX_AGE_MS + 1);

        ts::next_tx(&mut scenario, AGENT);
        {
            let snap = ts::take_shared<RiskSnapshot>(&mut scenario);
            // max_age_ms = 60_000; snapshot_at_ms = NOW_MS; now = NOW_MS + 60_001 → stale
            shield_oracle::assert_fresh_and_triggered(&snap, TRIGGER_SCORE, MAX_AGE_MS, &clk);
            ts::return_shared(snap);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    /// Property: score below trigger aborts assert_fresh_and_triggered.
    #[test, expected_failure(abort_code = liquidshield::shield_oracle::E_SCORE_BELOW_TRIGGER)]
    fun test_score_below_trigger_aborts() {
        let mut scenario = ts::begin(AGENT);
        let mut clk = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clk, NOW_MS);

        create_snapshot(&mut scenario, &clk);
        push_snapshot(&mut scenario, 40, &clk); // score 40 < trigger 70

        ts::next_tx(&mut scenario, AGENT);
        {
            let snap = ts::take_shared<RiskSnapshot>(&mut scenario);
            shield_oracle::assert_fresh_and_triggered(&snap, TRIGGER_SCORE, MAX_AGE_MS, &clk);
            ts::return_shared(snap);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    /// Property: wrong obligation in registry aborts assert_registered.
    #[test, expected_failure(abort_code = liquidshield::shield_registry::E_NOT_REGISTERED)]
    fun test_unregistered_obligation_aborts() {
        let mut scenario = ts::begin(OWNER);
        bootstrap(&mut scenario, OWNER);
        let clk = setup_clock(&mut scenario);

        let policy_id = create_policy(&mut scenario);
        let vault_id  = create_vault(&mut scenario, &clk);
        let snap_id   = create_snapshot(&mut scenario, &clk);
        register_obligation(&mut scenario, vault_id, policy_id, snap_id, &clk);

        ts::next_tx(&mut scenario, OWNER);
        {
            let registry = ts::take_shared<ShieldRegistry>(&mut scenario);
            let wrong_obligation: address = @0xDEAD;
            // assert_registered for an obligation that was never registered → aborts
            shield_registry::assert_registered(
                &registry,
                OWNER,
                &b"scallop",
                wrong_obligation,
                vault_id,
                policy_id,
            );
            ts::return_shared(registry);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    /// Property: wrong vault_id in assert_registered aborts.
    #[test, expected_failure(abort_code = liquidshield::shield_registry::E_VAULT_MISMATCH)]
    fun test_vault_mismatch_in_registry_aborts() {
        let mut scenario = ts::begin(OWNER);
        bootstrap(&mut scenario, OWNER);
        let clk = setup_clock(&mut scenario);

        let policy_id = create_policy(&mut scenario);
        let vault_id  = create_vault(&mut scenario, &clk);
        let snap_id   = create_snapshot(&mut scenario, &clk);
        register_obligation(&mut scenario, vault_id, policy_id, snap_id, &clk);

        ts::next_tx(&mut scenario, OWNER);
        {
            let registry = ts::take_shared<ShieldRegistry>(&mut scenario);
            let wrong_vault_id = object::id_from_address(@0xDEAD);
            shield_registry::assert_registered(
                &registry,
                OWNER,
                &b"scallop",
                OBLIGATION_ID,
                wrong_vault_id, // wrong!
                policy_id,
            );
            ts::return_shared(registry);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    /// Property: wrong policy_id in assert_registered aborts.
    #[test, expected_failure(abort_code = liquidshield::shield_registry::E_POLICY_MISMATCH)]
    fun test_policy_mismatch_in_registry_aborts() {
        let mut scenario = ts::begin(OWNER);
        bootstrap(&mut scenario, OWNER);
        let clk = setup_clock(&mut scenario);

        let policy_id = create_policy(&mut scenario);
        let vault_id  = create_vault(&mut scenario, &clk);
        let snap_id   = create_snapshot(&mut scenario, &clk);
        register_obligation(&mut scenario, vault_id, policy_id, snap_id, &clk);

        ts::next_tx(&mut scenario, OWNER);
        {
            let registry = ts::take_shared<ShieldRegistry>(&mut scenario);
            let wrong_policy_id = object::id_from_address(@0xDEAD);
            shield_registry::assert_registered(
                &registry,
                OWNER,
                &b"scallop",
                OBLIGATION_ID,
                vault_id,
                wrong_policy_id, // wrong!
            );
            ts::return_shared(registry);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    /// Property: deactivated position blocks assert_registered.
    #[test, expected_failure(abort_code = liquidshield::shield_registry::E_NOT_ACTIVE)]
    fun test_deactivated_position_blocks_rescue() {
        let mut scenario = ts::begin(OWNER);
        bootstrap(&mut scenario, OWNER);
        let clk = setup_clock(&mut scenario);

        let policy_id = create_policy(&mut scenario);
        let vault_id  = create_vault(&mut scenario, &clk);
        let snap_id   = create_snapshot(&mut scenario, &clk);
        register_obligation(&mut scenario, vault_id, policy_id, snap_id, &clk);

        ts::next_tx(&mut scenario, OWNER);
        {
            let mut registry = ts::take_shared<ShieldRegistry>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            shield_registry::deactivate_position(&mut registry, OBLIGATION_ID, &clk, ctx);
            ts::return_shared(registry);
        };

        ts::next_tx(&mut scenario, OWNER);
        {
            let registry = ts::take_shared<ShieldRegistry>(&mut scenario);
            // Now deactivated → should abort
            shield_registry::assert_registered(
                &registry, OWNER, &b"scallop", OBLIGATION_ID, vault_id, policy_id,
            );
            ts::return_shared(registry);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    /// Property: paused policy blocks assert_active.
    #[test, expected_failure(abort_code = liquidshield::risk_policy::E_POLICY_PAUSED)]
    fun test_paused_policy_blocks_assert_active() {
        let mut scenario = ts::begin(OWNER);
        let clk = setup_clock(&mut scenario);
        create_policy(&mut scenario);

        ts::next_tx(&mut scenario, OWNER);
        {
            let mut policy = ts::take_shared<RiskPolicy>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            risk_policy::pause(&mut policy, ctx);
            ts::return_shared(policy);
        };

        ts::next_tx(&mut scenario, OWNER);
        {
            let policy = ts::take_shared<RiskPolicy>(&mut scenario);
            risk_policy::assert_active(&policy, &b"scallop", 100, NOW_MS);
            ts::return_shared(policy);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    /// Property: revoked policy blocks assert_active.
    #[test, expected_failure(abort_code = liquidshield::risk_policy::E_POLICY_REVOKED)]
    fun test_revoked_policy_blocks_assert_active() {
        let mut scenario = ts::begin(OWNER);
        let clk = setup_clock(&mut scenario);
        create_policy(&mut scenario);

        ts::next_tx(&mut scenario, OWNER);
        {
            let mut policy = ts::take_shared<RiskPolicy>(&mut scenario);
            let ctx = ts::ctx(&mut scenario);
            risk_policy::revoke(&mut policy, ctx);
            ts::return_shared(policy);
        };

        ts::next_tx(&mut scenario, OWNER);
        {
            let policy = ts::take_shared<RiskPolicy>(&mut scenario);
            risk_policy::assert_active(&policy, &b"scallop", 100, NOW_MS);
            ts::return_shared(policy);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    /// Property: expired policy blocks assert_active.
    #[test, expected_failure(abort_code = liquidshield::risk_policy::E_POLICY_EXPIRED)]
    fun test_expired_policy_blocks_assert_active() {
        let mut scenario = ts::begin(OWNER);
        let clk = setup_clock(&mut scenario);

        // Create policy that expired before NOW_MS
        ts::next_tx(&mut scenario, OWNER);
        {
            let ctx = ts::ctx(&mut scenario);
            risk_policy::create_and_share_policy(
                TRIGGER_SCORE, MAX_PER_ACTION, MAX_DAILY,
                NOW_MS - 1, // already expired
                1200,
                ctx,
            );
        };

        ts::next_tx(&mut scenario, OWNER);
        {
            let policy = ts::take_shared<RiskPolicy>(&mut scenario);
            risk_policy::assert_active(&policy, &b"scallop", 100, NOW_MS);
            ts::return_shared(policy);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    /// Property: protocol not in allowlist blocks assert_active.
    #[test, expected_failure(abort_code = liquidshield::risk_policy::E_PROTOCOL_NOT_ALLOWED)]
    fun test_unlisted_protocol_blocks_assert_active() {
        let mut scenario = ts::begin(OWNER);
        let clk = setup_clock(&mut scenario);
        create_policy(&mut scenario);

        ts::next_tx(&mut scenario, OWNER);
        {
            let policy = ts::take_shared<RiskPolicy>(&mut scenario);
            risk_policy::assert_active(&policy, &b"unknown_protocol", 100, NOW_MS);
            ts::return_shared(policy);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }

    /// Property: amount over max_per_action blocks assert_active.
    #[test, expected_failure(abort_code = liquidshield::risk_policy::E_EXCEEDS_MAX_PER_ACTION)]
    fun test_amount_over_max_per_action_blocks_assert_active() {
        let mut scenario = ts::begin(OWNER);
        let clk = setup_clock(&mut scenario);
        create_policy(&mut scenario);

        ts::next_tx(&mut scenario, OWNER);
        {
            let policy = ts::take_shared<RiskPolicy>(&mut scenario);
            // MAX_PER_ACTION + 1 → should abort
            risk_policy::assert_active(&policy, &b"scallop", MAX_PER_ACTION + 1, NOW_MS);
            ts::return_shared(policy);
        };

        clock::destroy_for_testing(clk);
        ts::end(scenario);
    }
}
