# Clatson (Person 1) — Move contract redesign for production

Person 2 has finished the backend production-hardening (typed Scallop indexing, wallet discovery, reconciliation, Cube models, pre/post verification, simulation gates, concurrency locks, monitoring). These were verified on testnet. The remaining production blockers are **on-chain (Move)** and are yours, because they require rewriting + redeploying the contracts (new object IDs ripple into the backend env, so coordinate the redeploy).

Each item below is from `tobefixed.md` with its acceptance test, and a note on **which backend piece it unlocks**.

---

## #5 — Shared `ShieldRegistry` table (drop user-owned `ProtectedPosition`)
**Problem:** `ProtectedPosition` is a user-owned object that the rescue PTB requires as input. That breaks "user is asleep, agent rescues" — the agent can't depend on a user-owned object.

**Change:** move protection records into a **shared** registry table keyed by obligation id:
```move
public struct ShieldRegistry has key {
    id: UID,
    admin: address,
    records: Table<address, ProtectionRecord>,        // obligation_id -> config
    owner_index: Table<address, vector<address>>,     // owner -> obligation ids
    total_registered: u64,
}
public struct ProtectionRecord has store {
    owner: address, protocol: vector<u8>, obligation_id: address,
    vault_id: ID, policy_id: ID, snapshot_id: ID,
    collateral_asset: vector<u8>, debt_asset: vector<u8>,
    active: bool, created_at_ms: u64, updated_at_ms: u64,
}
```
Executor checks `shield_registry::assert_registered(registry, owner, protocol, obligation_id, vault_id, policy_id)`.

**Acceptance:** user registers once → disconnects wallet → agent later rescues using ONLY shared objects (RiskPolicy, ShieldVault, RiskSnapshot, ShieldRegistry, Scallop Obligation, Clock). No user-owned object in the rescue PTB.

**Unlocks backend:** the agent can drop the per-position object inputs; `positions`/registry become a pure read. (Backend currently passes `positionId` into the PTB — once shared, that input goes away.)

---

## #6 — Revocable shared `GuardianDelegation` (replace agent-owned `GuardianCap`)
**Problem:** `GuardianCap` is transferred to the agent; `revoke` needs the cap object passed into the user's tx — but if the agent owns it, the user can't revoke directly.

**Change:** shared delegation object the owner controls:
```move
public struct GuardianDelegation has key {
    id: UID, owner: address, agent: address, policy_id: ID,
    expires_at_ms: u64, revoked: bool, nonce: u64,
}
public entry fun revoke_delegation(d: &mut GuardianDelegation, ctx: &mut TxContext) {
    assert!(d.owner == tx_context::sender(ctx), E_NOT_OWNER);
    d.revoked = true; d.nonce = d.nonce + 1;
}
```
Executor asserts: `agent == sender`, `!revoked`, `now < expires_at_ms`, `policy_id == object::id(policy)`.

**Acceptance:** user clicks Revoke → agent's next rescue aborts on-chain → dashboard shows "Revoked — execution blocked."

**Unlocks backend:** `/api/override` + the agent's revocation handling become reliable; `policyActive()` already reads pause/revoke — point it at the delegation too.

---

## #7 — Cross-object consistency checks in `begin_rescue`
**Problem:** executor checks cap/policy/snapshot/registry/vault individually but doesn't prove they all belong to the **same owner + same registered obligation**.

**Change:** add to `begin_rescue` (or the new adapter):
```move
let owner = risk_policy::owner(policy);
assert!(guardian_delegation::owner(delegation) == owner, E_OWNER_MISMATCH);
assert!(shield_vault::owner(vault) == owner, E_VAULT_OWNER_MISMATCH);
assert!(shield_registry::record_owner(registry, obligation_id) == owner, E_REGISTRY_OWNER_MISMATCH);
assert!(shield_registry::record_vault_id(registry, obligation_id) == object::id(vault), E_VAULT_MISMATCH);
assert!(shield_registry::record_policy_id(registry, obligation_id) == object::id(policy), E_POLICY_MISMATCH);
assert!(shield_oracle::position_key(snapshot) == obligation_id, E_SNAPSHOT_MISMATCH);
```

**Acceptance:** every mismatched combination (right policy/wrong vault, right vault/wrong obligation, right snapshot/wrong user, wrong agent, expired delegation, revoked policy) **aborts**.

**Unlocks backend:** makes the backend's #19 simulation assertions on-chain-enforced (defense in depth), not just simulated.

---

## #8 — Strict Move Scallop adapter modules (no unrestricted `Coin<T>`)
**Problem:** `begin_rescue` returns a `Coin<T>` to the off-chain PTB builder, which is trusted to route it to Scallop. Production must prove on-chain that funds can only go into Scallop.

**Change:** adapter modules that own the whole flow internally:
```move
public entry fun execute_scallop_repay<T>(
    delegation: &GuardianDelegation, policy: &RiskPolicy, registry: &ShieldRegistry,
    snapshot: &RiskSnapshot, vault: &mut ShieldVault<T>,
    scallop_version: &Version, obligation: &mut Obligation, scallop_market: &mut Market,
    clock: &Clock, amount: u64, ctx: &mut TxContext,
) {
    // 1. LiquidShield checks (#7)  2. withdraw from vault  3. call Scallop repay internally  4. emit ShieldActivatedEvent
}
// + execute_scallop_topup<T> (deposit_collateral)
```
Scallop allows third-party repay + collateral deposit without the ObligationKey, so this is valid.

**Acceptance:** there is no production PTB where the agent receives an unrestricted `Coin<T>` and chooses the destination. The repay/topup amount goes to Scallop or aborts.

**Unlocks backend:** the agent calls one adapter entry fn instead of building begin→scallop→complete; #19's "no coin to non-allowlisted address" becomes a contract guarantee. Backend's `scallop_rescue.ts` builders get replaced by a single `moveCall` to the adapter.

---

## #23 / #24 — Move test suite + fuzz/property tests
**#23 unit tests** (each aborts with a specific code): register, revoke, pause, expired policy, wrong protocol/obligation/vault/policy/snapshot, stale snapshot, score below trigger, amount over max_per_action, amount over daily/window, unsupported coin type, agent mismatch, DAO pause/revoke.

**#24 properties:** vault balance never negative; total spent ≤ window cap; agent cannot withdraw to itself; revoked/expired delegation never authorizes; wrong obligation/coin type never rescued.

---

## Coordination note
When you redeploy with these changes, the package id + object IDs change. Send Person 2 the new:
`LIQUIDSHIELD_PACKAGE_ID`, `SHIELD_REGISTRY_ID`, delegation object id (replaces `GUARDIAN_CAP_ID`), and the adapter entry-function names/signatures. Backend is env-driven, so it's a config swap + a small change in the agent to call the new adapter entry fn (instead of the begin→scallop→complete builders).

## Already done (don't redo)
#13 repay+topup (PTB level) ✅ · #18 deterministic risk engine ✅ · and all backend items #1,#2,#9,#14,#16,#19,#20,#21 ✅ (Person 2).
