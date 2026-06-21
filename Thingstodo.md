The biggest gaps are:

1. **Scallop is not being indexed deeply enough.** The manifest has a Scallop source, but the Scallop `events` array is empty, and the indexer is polling by package/module source rather than decoding exact Scallop event types into typed tables.
2. **User position discovery is incomplete.** Production cannot rely on manually configured `OBLIGATION_ID`. Scallop docs clearly say users can have multiple obligations, each obligation is independent, the `Obligation` is shared, and the user owns an `ObligationKey` object that proves ownership.
3. **The current `ProtectedPosition` design blocks true autonomous execution.** The repo stores `ProtectedPosition` as a user-owned object and says the user passes it into rescue PTBs, which conflicts with the “user is sleeping, agent rescues” production model.
4. **Guardian revocation is not robust enough.** `GuardianCap` is transferred to the agent, but the revoke function requires the cap object to be passed into the user’s transaction. If the agent owns it, the user cannot reliably revoke that cap directly.
5. **Execution route enforcement is too loose for production.** `begin_rescue` returns a `Coin<T>` to the PTB, then the off-chain builder is expected to call Scallop and then `complete_rescue`. The PTB is atomic, but the Move contract does not fully prove that funds only went into Scallop.
6. **Production APIs are unsafe.** `/api/simulate-shock`, `/api/trigger-agent`, and `/api/override` are exposed as normal API routes, and `/api/override` can sign a DAO transaction using a private key from environment config. That must not exist in production.

---

# P0 — Must fix before real users or real funds

## 1. Replace manual `OBLIGATION_ID` dependency with wallet-based Scallop position discovery

### Current issue

The config expects one global `OBLIGATION_ID`, plus one `POSITION_ID`, `VAULT_ID`, `RISK_POLICY_ID`, and `GUARDIAN_CAP_ID`. That is not production-ready because it assumes the backend is tracking one preconfigured position instead of discovering each user’s actual Scallop positions.

Scallop docs say:

- `Obligation` records collateral and debt.
- A user can have multiple obligations.
- Obligations are independent.
- `Obligation` is shared.
- The user holds an `ObligationKey` object/NFT in their wallet as ownership proof.

### Required change

Build a production onboarding flow:

```
User connects wallet
↓
Backend queries wallet-owned objects
↓
Find Scallop ObligationKey objects
↓
Resolve each ObligationKey → Obligation ID
↓
Read each obligation through Scallop SDK / object read
↓
Show all positions to the user
↓
User selects which position to protect
↓
LiquidShield registers that exact obligation
```

### Implementation comments

Add a new backend service:

```
services/scallopPositionDiscovery.ts
```

It should expose:

```
discoverScallopObligations(owner: string):Promise<ScallopDiscoveredObligation[]>
```

Return shape:

```
typeScallopDiscoveredObligation= {
  owner:string;
  obligationKeyId:string;
  obligationId:string;
  collateralAssets:Array<{
    coinType:string;
    symbol:string;
    amount:string;
    usdValue:number;
  }>;
  debtAssets:Array<{
    coinType:string;
    symbol:string;
    amount:string;
    usdValue:number;
  }>;
  totalCollateralUsd:number;
  totalDebtUsd:number;
  scallopRiskLevel:number;
  healthFactorLike:number|null;
  lastReadAt:string;
  source:"wallet-owned-obligation-key+scallop-sdk";
};
```

Add API:

```
GET /api/scallop/positions?owner=0x...
```

Frontend should show:

```
Detected Scallop Positions

Position 1
Obligation: 0xabc...
Collateral: SUI / USDC
Debt: USDC
Risk Level: 72%
[Protect this]

Position 2
Obligation: 0xdef...
Collateral: haSUI
Debt: USDC
Risk Level: 88%
[Protect this]
```

### Acceptance test

A production-ready system should pass this:

```
Given a wallet with 2 Scallop ObligationKey objects,
when the user connects wallet,
then LiquidShield shows both obligations,
and the user can select exactly one to protect.
```

---

## 2. Build real Scallop semantic indexing, not only LiquidShield indexing

### Current issue

The manifest has Scallop listed, but its `events` array is empty.

The current indexer loads package sources but does not use the source `modules` list or a typed `events` list; it calls `queryEvents({ module: source.packageId })` and stores generic rows into `contract_logs`.

That is not enough for production Scallop intelligence.

### Required change

Create a real Scallop indexing layer with typed derived tables.

You need these tables:

```
scallop_obligation_keys
scallop_obligations
scallop_borrow_events
scallop_repay_events
scallop_collateral_deposit_events
scallop_collateral_withdraw_events
scallop_liquidation_events
scallop_obligation_snapshots
scallop_asset_risk
scallop_protocol_metrics
```

### Implementation comments

Do not only store:

```
contract_logs(event_name, data)
```

That is raw storage, not semantic indexing.

Add typed decoders:

```
decodeScallopBorrowEventV3(event)
decodeScallopRepayEventV3(event)
decodeScallopCollateralDepositEvent(event)
decodeScallopCollateralWithdrawEvent(event)
decodeScallopLiquidationEvent(event)
```

Scallop docs mention these relevant emitted events:

- `CollateralDepositEvent` for collateral deposits.
- `CollateralWithdrawEvent` for withdrawals.
- `BorrowEventV3` for borrows.
- `RepayEventV3` for repayments.

You should add exact event types to your manifest once verified from the current Scallop package:

```
{
  "key":"scallop",
  "role":"lending-protocol",
  "packageEnv":"SCALLOP_PACKAGE_ID",
  "package":"<official-mainnet-package>",
  "events": [
"<SCALLOP_PACKAGE>::borrow::BorrowEventV3",
"<SCALLOP_PACKAGE>::repay::RepayEventV3",
"<SCALLOP_PACKAGE>::deposit_collateral::CollateralDepositEvent",
"<SCALLOP_PACKAGE>::withdraw_collateral::CollateralWithdrawEvent",
"<SCALLOP_PACKAGE>::liquidation::LiquidationEvent"
  ]
}
```

Use GraphQL `eventType` filters for exact event types. Sui GraphQL supports filtering events by type, module, sender, and checkpoint fields, but note that `module` and `type` cannot be combined in the same filter.

### Acceptance test

The agent must be able to answer:

```
How many Scallop borrows happened in the last 24h?
How many Scallop repayments happened today?
How many liquidations occurred this week?
Which obligations are above 85% risk level?
Which asset pair has the highest liquidation exposure?
```

If the agent cannot answer those from database tables with timestamps and tx digests, the Scallop indexer is not production-ready.

---

## 3. Replace polling-only indexing with production checkpoint/gRPC ingestion - optional

### Current issue

The current indexer is GraphQL polling-based with cursor state. That is okay for a demo, but not for production liquidation protection. The current code uses a poll loop and a fixed page cap.

Sui’s production indexing docs recommend gRPC streaming as the default for production indexer ingestion when low latency matters, with a polling-based fallback for historical data and reliability.

### Required change

Move to:

```
gRPC checkpoint stream
+
historical checkpoint backfill
+
typed event decoding
+
idempotent database writes
+
lag monitoring
```

### Implementation comments

Production indexing architecture:

```
Sui gRPC checkpoint stream
        ↓
Checkpoint processor
        ↓
Typed event decoder
        ↓
Raw event table
        ↓
Scallop semantic tables
        ↓
Periodic object-state reconciliation
        ↓
Cube / agent tools
```

Keep GraphQL only for:

```
- fallback reads
- object lookups
- dashboard queries
- operational debugging
```

Sui’s blog explains that gRPC streaming reduces latency compared to polling, but must be paired with polling/backfill because streaming alone does not provide historical data or recover from gaps.

### Acceptance test

You need an indexer status panel:

```
{
  "network":"mainnet",
  "latestCheckpointSeen":123456789,
  "latestCheckpointProcessed":123456782,
  "lagCheckpoints":7,
  "lagMs":4200,
  "backfillStatus":"caught_up",
  "streamStatus":"connected",
  "lastScallopEventAt":"2026-06-20T..."
}
```

If indexer lag is high, the agent must not execute rescues.

---

## 4. Verify Scallop mainnet package and object addresses dynamically - optional

### Current issue

The repo uses a testnet manifest and static package IDs.

Scallop publishes an official package-address endpoint and docs showing mainnet core objects like `version`, `market`, `coinDecimalsRegistry`, and `obligationAccessStore`.

### Required change

Do not hardcode Scallop production addresses in random env files only.

Add a Scallop address resolver:

```
services/scallopAddressBook.ts
```

It should:

```
1. Fetch official Scallop addresses.
2. Cache them.
3. Verify network = mainnet.
4. Verify configured addresses match official addresses.
5. Refuse execution if mismatch.
```

### Implementation comments

Required config:

```
SUI_NETWORK=mainnet
SCALLOP_ADDRESS_BOOK_URL=https://sui.apis.scallop.io/addresses/66f8e7ed9bb9e07fdfb86bbb

SCALLOP_CORE_OBJECT=<official>
SCALLOP_VERSION_ID=<official>
SCALLOP_MARKET_ID=<official>
SCALLOP_COIN_DECIMALS_REGISTRY_ID=<official>
SCALLOP_X_ORACLE_ID=<official-if-needed>
```

Runtime check:

```
if (cfg.scallopMarketId!==official.mainnet.core.market) {
thrownewError("Scallop market mismatch. Execution disabled.");
}
```

### Acceptance test

On boot, API should expose:

```
GET /api/system/scallop-address-book
```

Response:

```
{
  "network":"mainnet",
  "verified":true,
  "source":"official-scallop-address-endpoint",
  "version":"0x...",
  "market":"0x...",
  "coinDecimalsRegistry":"0x..."
}
```

---

## 5. Redesign `ShieldRegistry`: no user-owned `ProtectedPosition` in rescue path

### Current issue

The current `ProtectedPosition` is owned by the user, and the comment says the user passes it into rescue PTBs.

That breaks production autonomy.

If the user is sleeping, the agent cannot require a user-owned object as an input unless the user has pre-signed/delegated that object flow.

### Required change

Move protected position records into a shared registry table.

### Current pattern to remove

```
public struct ProtectedPosition has key, store { ... }

transfer::transfer(position, owner);
```

### Production pattern

Use a shared `ShieldRegistry` with a table:

```
use sui::table::{Self, Table};

public struct ShieldRegistry has key {
    id: UID,
    admin: address,
    records: Table<address, ProtectionRecord>, // obligation_id -> config
    owner_index: Table<address, vector<address>>, // owner -> obligation IDs
    total_registered: u64,
}

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
```

Then executor should check:

```
shield_registry::assert_registered(
    registry,
    owner,
    protocol,
    obligation_id,
    vault_id,
    policy_id,
)
```

### Implementation comments

The agent should only need shared objects:

```
RiskPolicy shared object
ShieldVault shared object
RiskSnapshot shared object
ShieldRegistry shared object
Scallop Obligation shared object
Clock object
```

It should not need:

```
User-owned ProtectedPosition object
User signature
User-owned ObligationKey
```

### Acceptance test

```
User registers position once.
User disconnects wallet.
Agent later executes rescue using only shared objects.
No user-owned object is required in the rescue PTB.
```

---

## 6. Redesign `GuardianCap` and revocation

### Current issue

`GuardianCap` is transferred to the agent. The revoke function takes `cap: GuardianCap`, checks that `protected_owner == sender`, then deletes it. But if the agent owns the cap object, the user cannot pass it into a user-signed transaction.

### Required change

Make revocation state live in a **shared owner-controlled delegation object** or rely on shared `RiskPolicy` as the single source of truth.

### Recommended production design

Replace agent-owned `GuardianCap` with:

```
public struct GuardianDelegation has key {
    id: UID,
    owner: address,
    agent: address,
    policy_id: ID,
    expires_at_ms: u64,
    revoked: bool,
    nonce: u64,
}
```

Make it shared.

User can call:

```
public entry fun revoke_delegation(
    delegation: &mut GuardianDelegation,
    ctx: &mut TxContext
) {
    assert!(delegation.owner == tx_context::sender(ctx), E_NOT_OWNER);
    delegation.revoked = true;
    delegation.nonce = delegation.nonce + 1;
}
```

Executor checks:

```
assert!(delegation.agent == tx_context::sender(ctx), E_NOT_AGENT);
assert!(!delegation.revoked, E_REVOKED);
assert!(now < delegation.expires_at_ms, E_EXPIRED);
assert!(delegation.policy_id == object::id(policy), E_POLICY_MISMATCH);
```

### Acceptance test

```
User clicks Revoke.
Agent attempts rescue.
Transaction aborts on-chain.
Dashboard shows: "Revoked — execution blocked."
```

---

## 7. Add owner/vault/policy/snapshot consistency checks

### Current issue

The executor checks the cap, policy, snapshot freshness, registry membership, and vault budget.

But production needs stronger cross-object consistency:

```
cap/delegation owner == policy.owner
policy.owner == vault.owner
registry record owner == policy.owner
snapshot belongs to obligation/record
vault_id in registry == actual vault ID
policy_id in registry == actual policy ID
agent address == authorized delegation agent
```

### Required change

Add explicit checks to `begin_rescue`.

### Implementation comments

In `shield_executor.move`:

```
let owner = risk_policy::owner(policy);

assert!(guardian_delegation::owner(delegation) == owner, E_OWNER_MISMATCH);
assert!(shield_vault::owner(vault) == owner, E_VAULT_OWNER_MISMATCH);
assert!(shield_registry::record_owner(registry, obligation_id) == owner, E_REGISTRY_OWNER_MISMATCH);
assert!(shield_registry::record_vault_id(registry, obligation_id) == object::id(vault), E_VAULT_MISMATCH);
assert!(shield_registry::record_policy_id(registry, obligation_id) == object::id(policy), E_POLICY_MISMATCH);
assert!(shield_oracle::position_key(snapshot) == obligation_id, E_SNAPSHOT_MISMATCH);
```

### Acceptance test

Try to execute a rescue with:

```
correct policy but wrong vault
correct vault but wrong obligation
correct snapshot but wrong user
wrong agent
expired delegation
revoked policy
```

Every case must abort.

---

## 8. Add strict Scallop adapter modules to enforce destination routing

### Current issue

The current `shield_executor::begin_rescue` returns a `Coin<T>`, then the PTB builder calls Scallop’s `repay` or `deposit_collateral`, then calls `complete_rescue`.

Sui PTBs are atomic, so if a command fails, effects are applied atomically or not at all.

But production security should not rely on the off-chain PTB builder routing the coin correctly.

### Required change

Create Move protocol adapters:

```
scallop_repay_adapter.move
scallop_topup_adapter.move
```

The adapter should own the full rescue call:

```
public entry fun execute_scallop_repay<T>(
    delegation: &GuardianDelegation,
    policy: &RiskPolicy,
    registry: &ShieldRegistry,
    snapshot: &RiskSnapshot,
    vault: &mut ShieldVault<T>,
    scallop_version: &ScallopVersion,
    obligation: &mut ScallopObligation,
    scallop_market: &mut ScallopMarket,
    clock: &Clock,
    amount: u64,
    ctx: &mut TxContext
) {
    // 1. LiquidShield checks
    // 2. withdraw from vault
    // 3. call Scallop repay internally
    // 4. emit ShieldActivatedEvent
}
```

### Why this matters

Scallop docs support the rescue idea because anyone can deposit collateral into another user’s obligation, and anyone can repay a borrowing obligation without the `ObligationKey`.

But LiquidShield must prove that the agent cannot route funds elsewhere.

### Acceptance test

There should be no production PTB where the agent receives an unrestricted `Coin<T>` and manually chooses where to send it.

---

## 9. Add pre-execution and post-execution Scallop state verification

### Current issue

The current Scallop reader reads one obligation and derives health factor-like value from Scallop risk level.

That is useful, but production execution requires confirmation before and after rescue.

### Required change

Every rescue must have:

```
pre_state
planned_action
simulation_result
execution_tx
post_state
state_delta
```

### Implementation comments

Before execution:

```
constbefore=awaitreadObligation(obligationId);
constplan=computeRescuePlan(before,policy,vault);
constsim=awaitdryRunTransactionBlock(ptb);

if (!sim.success)block;
if (before.riskLevel<trigger)block;
if (plan.amount>policy.maxPerAction)block;
```

After execution:

```
constafter=awaitreadObligation(obligationId);

if (after.riskLevel>=before.riskLevel) {
markActionAsSuspicious();
disableAutoExecuteForThisPosition();
}
```

Store:

```
risk_actions.before_risk_level
risk_actions.after_risk_level
risk_actions.before_health_factor
risk_actions.after_health_factor
risk_actions.simulation_digest
risk_actions.execution_digest
risk_actions.result_verified
```

### Acceptance test

Dashboard must show:

```
Before: HF 1.08
Action: Repay 120 USDC
After: HF 1.39
Verified at: checkpoint 123456
```

If post-state is missing, the action should not be marked “successfully protected”; it should be marked “submitted, verification pending.”

---

## 10. Remove production access to `/api/simulate-shock - optional`

### Current issue

`/api/simulate-shock` changes risk-agent stress state and can trigger the agent. That is demo tooling, not production infrastructure.

### Required change

Remove it from production builds.

Use feature flag:

```
ENABLE_DEMO_ROUTES=false
```

Code:

```
if (cfg.enableDemoRoutes) {
app.post('/api/simulate-shock', ...)
}
```

Production should return:

```
{
  "error":"DEMO_ROUTE_DISABLED"
}
```

### Acceptance test

On production:

```
POST /api/simulate-shock
```

must return `404` or `403`.

---

## 11. Lock down `/api/trigger-agent` and `/api/override - optional`

### Current issue

The backend exposes `/api/trigger-agent`, and `/api/override` can sign on-chain transactions using private keys from env.

### Required change

Split APIs into:

```
Public read API
Authenticated user API
Internal operator API
Signer service API
```

### Production route design

Public:

```
GET /api/dashboard
GET /api/positions/:owner
GET /api/scallop/positions/:owner
GET /api/actions/:owner
```

User-authenticated:

```
POST /api/protection/register
POST /api/protection/revoke
POST /api/vault/deposit-intent
POST /api/vault/withdraw-intent
```

Internal only:

```
POST /internal/agent/tick
POST /internal/agent/execute
POST /internal/indexer/replay
```

Admin/multisig only:

```
POST /admin/pause
POST /admin/unpause
POST /admin/emergency-disable
```

### Implementation comments

Do not keep admin private keys in the web backend.

Use:

```
- multisig wallet for DAO/admin actions
- HSM/KMS or isolated signer for agent key
- signed JWT or mTLS for internal calls
- rate limiting
- IP allowlist for internal endpoints
- audit logs for every privileged request
```

### Acceptance test

A random internet client must not be able to:

```
trigger the agent
pause policies
simulate shocks
invoke signer actions
read other users’ full private position details
```

---

## 12. Add production key management - optional

### Current issue

Config includes `AGENT_PRIVATE_KEY` and `USER_PRIVATE_KEY`.

That is not acceptable for a production system handling real funds.

### Required change

Use separate signer infrastructure.

### Implementation comments

Minimum production key setup:

```
Agent signer:
- separate process
- no public HTTP access
- only accepts signed action requests from risk engine
- rate limited
- logs every signing request
- refuses if policy pre-check hash does not match

DAO/admin:
- multisig
- no env private key
- no backend direct signing

User:
- user signs onboarding, deposit, withdrawal, revoke
- user private key never touches backend
```

### Acceptance test

Search the production repo and deployment env:

```
USER_PRIVATE_KEY
DAO_PRIVATE_KEY
ADMIN_PRIVATE_KEY
```

None should exist.

---

## 13. Add Scallop action support for both repay and collateral top-up

### Current issue

The PTB builder supports repay and mentions collateral top-up, but the production system must prove both routes with real Scallop function signatures, coin types, and object requirements.

Scallop docs explicitly allow collateral deposits into another user’s obligation and repayment without the obligation key.

### Required change

Implement separate verified adapters:

```
ScallopRepayAdapter
ScallopCollateralTopupAdapter
```

### Implementation comments

Risk planner chooses:

```
if (vaultCoinType===debtCoinType) {
action="repay";
}elseif (vaultCoinType is allowed collateral){
action="topup";
}elseif (swapAllowed&&DeepBookRouteSafe) {
action="swap_then_repay";
}else {
action="notify_only";
}
```

For production, do **not** enable `swap_then_repay` until DeepBook routing, slippage, and failure handling are audited.

### Acceptance test

For each supported asset pair:

```
USDC debt → USDC repay works
SUI collateral → SUI top-up works
wrong coin type → blocked before signing
unsupported asset → blocked before signing
```

---

## 14. Add protocol-state reconciliation

### Current issue

Event indexing alone is not enough. Positions change through interest accrual, price changes, oracle updates, and protocol-level config changes.

### Required change

Add periodic reconciliation:

```
event-derived state
+
Scallop SDK live state
+
object reads
+
oracle reads
=
trusted position snapshot
```

### Implementation comments

Create:

```
services/scallopReconciler.ts
```

It should run:

```
every 10–30 seconds for protected positions
every 1–5 minutes for global watched positions
```

Write to:

```
scallop_obligation_snapshots
```

Columns:

```
obligation_id
owner
collateral_value_usd
debt_value_usd
scallop_risk_level
health_factor_like
asset_breakdown_json
source_event_checkpoint
source_sdk_read_at
is_reconciled
reconciliation_error
created_at
```

### Acceptance test

If event-derived debt says `$5,000` but SDK read says `$5,250`, the system must use the SDK/protocol read for execution and flag the difference.

---

## 15. Add user consent and clear policy preview

### Current issue

Production users must understand what the agent can and cannot do.

### Required change

Before creating policy, show:

```
LiquidShield can:
- monitor this Scallop obligation
- use up to X USDC per action
- use up to Y USDC per 24h
- repay debt or top up collateral
- act until expiry time

LiquidShield cannot:
- withdraw funds to the agent
- borrow on your behalf
- withdraw collateral from Scallop
- trade unless separately enabled
- act after revocation
```

Scallop docs say withdraw and borrow require the `ObligationKey`, but repay and deposit collateral do not. That is the exact safety story you should show users.

### Acceptance test

User must sign a transaction that stores these constraints on-chain before the agent can act.

---

# P1 — Required before public beta

## 16. Add typed Cube semantic models for Scallop

Current Cube models only cover broad LiquidShield tables. Production Scallop Q&A needs Scallop-specific cubes.

Add cubes:

```
ScallopObligations
ScallopBorrows
ScallopRepays
ScallopLiquidations
ScallopCollateralEvents
ScallopRiskSnapshots
LiquidShieldPolicies
LiquidShieldActions
```

Questions the agent should answer:

```
What is my riskiest Scallop position?
Which Scallop assets saw most borrowing today?
How many Scallop liquidations happened this week?
How much USDC debt is near liquidation?
Which protected positions have low vault reserves?
```

Every answer should include:

```
source table
last updated timestamp
tx digest / object id where applicable
confidence
```

---

## 17. Build Scallop docs/source RAG for agent Q&A -optional

Do not let the agent answer Scallop questions from memory.

Add a tool layer:

```
searchScallopDocs(query)
queryScallopEvents(query)
getObligationState(obligationId)
getWalletScallopPositions(wallet)
getScallopLiquidationStats(timeRange)
```

Agent answer format:

```
Answer:
...

Data used:
- scallop_obligation_snapshots, updated 14s ago
- Scallop docs: Borrowing Function
- tx digest: 0x...
```

---

## 18. Add risk-engine determinism

The AI should explain, not freely decide.

Production decision should be:

```
Deterministic eligibility:
- obligation is registered
- policy active
- vault funded
- risk above threshold
- snapshot fresh
- Scallop state verified
- PTB simulation passed

AI role:
- summarize reasons
- classify market stress
- explain recommended action
```

Do not let the LLM directly choose amounts.

Amount calculation must be deterministic:

```
targetRiskLevel=0.70;
currentRiskLevel=scallop.totalRiskLevel;
repayNeeded=computeRepayToReachTarget(currentRiskLevel,targetRiskLevel,debt,collateral);
amount=min(repayNeeded,policy.maxPerAction,vault.remainingWindow);
```

---

## 19. Add transaction simulation gates

Before signing:

```
dryRun PTB
verify expected object mutations
verify expected events
verify gas budget
verify no unexpected transfers
verify Scallop obligation is the target
verify coin type is correct
```

Reject execution if:

```
simulation fails
gas > max configured gas
Scallop state changed too much since snapshot
coin type mismatch
policy version changed
vault balance changed unexpectedly
```

---

## 20. Add concurrency and object-lock protection

Sui shared objects can be hit by many PTBs. Your system must avoid duplicate rescues.

Add:

```
per-obligation execution lock
per-vault execution lock
policy version check
snapshot nonce
idempotency key
```

Database:

```
execution_locks(
key textprimarykey,
  obligation_id text,
  locked_untiltimestamp,
  tx_digest text,
  status text
)
```

Move:

```
policy.version
snapshot.nonce
registry.record.nonce
```

If an agent tick is already executing for an obligation, the next tick must skip.

---

## 21. Add monitoring and alerting

Production dashboard must include:

```
Indexer lag
Scallop SDK read failures
Pyth/oracle freshness
DeepBook API status
Agent signer status
Failed PTB rate
Dry-run failure rate
Vault low-reserve alerts
Positions near liquidation
```

Ops alerts:

```
PagerDuty / Discord / Telegram:
- indexer lag > 10s
- signer down
- failed rescues > threshold
- Scallop address mismatch
- oracle stale
- agent blocked by policy unexpectedly
```

---

## 22. Add privacy and data access controls

Not every user’s position should be exposed.

Public:

```
aggregate protocol stats
anonymized liquidation metrics
```

Private:

```
wallet positions
vault balance
registered policies
agent actions
```

Require wallet auth:

```
Sign-In With Sui wallet
session JWT
address-bound API access
```

A user should not be able to call:

```
GET /api/positions?owner=someone_else
```

and see private LiquidShield vault data.

---

# P2 — Security, audits, and launch hardening

## 23. Formal Move test suite

Add tests for:

```
register position
revoke policy
pause policy
expired policy
wrong protocol
wrong obligation
wrong vault
wrong policy
wrong snapshot
stale snapshot
risk score below trigger
amount over max_per_action
amount over daily/window limit
unsupported coin type
agent mismatch
DAO pause
DAO revoke
```

Each failure must abort with a specific code.

---

## 24. Fuzz and property tests

Properties:

```
Vault balance can never go negative.
Total spent cannot exceed max window.
Agent cannot withdraw to itself.
Revoked policy can never authorize action.
Expired delegation can never authorize action.
Wrong obligation cannot be rescued.
Wrong coin type cannot be used.
```

---

## 25. External audit

You need audit coverage for:

```
Move contracts
PTB builder
Scallop adapters
agent signer service
indexer correctness
risk-engine amount calculation
API auth
```

Do not launch with real funds without at least one external Move/security review.

---

## 26. Production deployment structure

Separate services:

```
frontend-web
api-server
indexer-worker
scallop-reconciler
risk-agent
signer-service
cube-api
postgres
redis/queue
monitoring
```

Do not run everything inside one Node process.

---

## 27. Incident controls

Add emergency kill switches:

```
global pause
per-user pause
per-protocol pause
per-asset pause
disable auto-execute
disable Scallop adapter
disable signer
```

Add admin action logs:

```
admin_actions(
  actor,
action,
  reason,
  target,
  tx_digest,
  created_at
)
```

---

# 

## Solved

| No. | Item | Status | Why |
| --- | --- | --- | --- |
| **13** | Scallop repay + collateral top-up support | **Solved at PTB level** | `scallop_rescue.ts` now has both `buildScallopRepayPTB` and `buildScallopTopupPTB`, and both use Scallop repay/top-up calls inside the PTB. |
| **18** | Deterministic risk engine | **Solved** | Risk score and reason codes are deterministic; OpenAI is only used for human-readable explanation with a deterministic fallback. |

---

## Partially solved

| No. | Item | Status | What is solved | What is still missing |
| --- | --- | --- | --- | --- |
| **4** | Mainnet env/address setup | **Partial** | `.env.example` has a mainnet switch-over section and config reads Sui/Scallop values from env. | No dynamic official Scallop address resolver or startup verification against Scallop’s official address book. |
| **7** | Cross-object consistency checks | **Partial** | `begin_rescue` checks GuardianCap, RiskPolicy, RiskSnapshot, ProtectedPosition, and Vault. | It still does not fully prove `policy.owner == vault.owner == position.owner == cap.protected_owner`, or that registry/vault/policy/snapshot all belong to the same registered obligation. |
| **9** | Pre/post execution verification | **Partial** | PTB dry-run exists before execution. | No post-rescue Scallop read proving health/risk improved; `risk_after` is still written as `null`. |
| **14** | Live Scallop state reconciliation | **Partial** | `ScallopReader` reads live obligation state using `getObligationAccountById` and derives a health-factor-like metric. | Only registered obligations are read. No global Scallop obligation snapshots table, no reconciliation loop with history. |
| **16** | Cube semantic models | **Partial** | 4 cubes exist: `positions`, `market_snapshots`, `risk_scores`, `risk_actions`. | Still no Scallop-specific cubes like `scallop_borrows`, `scallop_repays`, `scallop_liquidations`, `scallop_obligations`. |
| **19** | Transaction simulation gates | **Partial** | `simulateRescue()` dry-runs before signing and fails closed if simulation fails. | No verification of expected object mutations, expected events, exact destination, gas ceiling, or unexpected transfers. |
| **21** | Monitoring / status | **Partial** | `/api/dashboard` and `/api/sui/status` expose indexer status, agent status, readiness, event totals, cursor, and lag. | No real production alerts, no PagerDuty/Discord hooks, no automatic disable when indexer lag is unsafe. |
| **27** | Emergency override controls | **Partial** | RiskPolicy supports owner pause/revoke and DAO pause/unpause/revoke. | No global kill switch, per-protocol pause, per-asset pause, signer disable, or incident admin log. |

---

## Still open / not production-ready

| No. | Item | Status | Comment |
| --- | --- | --- | --- |
| **1** | Wallet-based Scallop ObligationKey discovery | **Still open** | Repo still depends on `OBLIGATION_ID`, `POSITION_ID`, `VAULT_ID`, `RISK_POLICY_ID`, `GUARDIAN_CAP_ID`, etc. `liquifiReadiness()` still requires `OBLIGATION_ID`. |
| **2** | Real Scallop semantic indexing | **Still open** | Manifest still has Scallop `events: []`, including the new opt-in `scallop-mainnet` benchmark. It is not decoding Scallop borrow/repay/liquidation events into typed tables. |
| **3** | gRPC/checkpoint indexer | **Still open** | Current indexer is still GraphQL polling with cursor and page caps, not checkpoint/gRPC ingestion. |
| **5** | Shared registry table instead of user-owned `ProtectedPosition` | **Still open** | `ProtectedPosition` is still owned by the user, and comments say the user passes it into rescue PTBs. |
| **6** | Revocable shared GuardianDelegation | **Still open** | GuardianCap is still transferred to the agent, and `revoke_guardian_cap` still requires the cap object itself. That means user-side direct cap revocation is still structurally weak. |
| **8** | Strict Move Scallop adapter modules | **Still open** | Repay/top-up exists in the PTB builder, but there is no `scallop_repay_adapter.move` or `scallop_topup_adapter.move`; contract still returns a `Coin<T>` from `begin_rescue`. |
| **10** | Remove production `/api/simulate-shock` | **Still open** | `/api/simulate-shock` is still mounted as an open route. |
| **11** | Lock down `/api/trigger-agent` and `/api/override` | **Still open** | `/api/trigger-agent` is open, and `/api/override` signs with `USER_PRIVATE_KEY` from env. |
| **12** | Production key management | **Still open** | Config still loads `AGENT_PRIVATE_KEY` and `USER_PRIVATE_KEY`. |
| **15** | User consent / policy preview | **Still open** | Onboarding is still a script using `USER_PRIVATE_KEY`, not a production wallet UX with plain-English policy preview. |
| **17** | Scallop docs/source RAG | **Still open** | No Scallop docs search/tooling layer found. Agent can explain risk, but not answer arbitrary Scallop reference questions with docs provenance. |
| **20** | Concurrency locks / idempotency | **Still open** | No per-obligation execution lock, per-vault lock, idempotency key, or duplicate rescue prevention found in the risk agent flow. |
| **22** | Privacy / user-scoped API access | **Still open** | Docs explicitly say all `/api/*` endpoints are open for the hackathon. |
| **23** | Move test suite | **Still open** | I found SeFi backend tests mentioned in the audit, but not a Move contract test suite covering vault/policy/guardian/rescue failure cases. |
| **24** | Fuzz/property tests | **Still open** | No fuzz/property test evidence found. |
| **25** | External audit | **Still open** | There is an internal SeFi audit report, but not an external Move/protocol/security audit for LiquidShield contracts and PTBs. |
| **26** | Production service split | **Still open** | `bootstrapLiquifi()` wires indexer, deriver, risk agent, and API into one backend path; no separate signer/indexer/reconciler/agent services yet. |

---

## The most important changes since last check

### 1. Scallop mainnet benchmark source was added, but it is not real semantic indexing yet

The manifest now has a `scallop-mainnet` source that can be enabled with `SCALLOP_MAINNET_BENCH=1`, but the Scallop event arrays are still empty. So it can benchmark package-level event capture, but it still cannot answer production questions like “how many Scallop liquidations happened today?” from typed tables.

### 2. PTB execution is much stronger now

The PTB builder now supports both repay and collateral top-up, runs dry-run simulation before submit, and fails closed if simulation fails. That is a real improvement.

### 3. Risk engine is much cleaner

The score is deterministic, reason codes are deterministic, and GPT is only used for explanation. This is exactly the right production direction.

### 4. API/dashboard/readiness is better, but still not safe

The dashboard has readiness, indexer status, agent status, and recent actions. But the repo still exposes open routes, including shock simulation, trigger-agent, and override signing. That is okay for demo, not for production.

---

## The 5 biggest things still blocking production

### 1. Obligation discovery is still not solved

You still need:

```
Connect wallet
→ query owned Scallop ObligationKey objects
→ resolve obligation IDs
→ show user positions
→ user selects one
→ register protection
```

Right now, the repo still expects `OBLIGATION_ID` and per-position object IDs in env/readiness.

### 2. Scallop is still not semantically indexed

You need typed tables:

```
scallop_obligations
scallop_borrows
scallop_repays
scallop_collateral_deposits
scallop_collateral_withdrawals
scallop_liquidations
scallop_obligation_snapshots
```

Current tables are only:

```
positions
market_snapshots
risk_scores
risk_actions
```

### 3. User-owned `ProtectedPosition` still blocks true autonomous rescue

The agent still needs the user-owned `ProtectedPosition` object in the rescue PTB. That is not correct for “user is sleeping, agent rescues.” This must become a shared registry table keyed by obligation ID.

### 4. GuardianCap revocation still has the same problem

The GuardianCap is transferred to the agent. If the user wants to revoke that cap directly, they likely cannot pass an agent-owned cap into their own transaction. You can rely on `RiskPolicy.revoke()` as the practical revocation path, but the cap design itself is still not production-clean.

### 5. Backend still holds/signs with private keys - optional

Production cannot have `AGENT_PRIVATE_KEY` and `USER_PRIVATE_KEY` in the normal API backend, especially with `/api/override` using `USER_PRIVATE_KEY` to sign. That must move to isolated signer/multisig flows.

---

## Final verdict

The updated repo is now a **end-to-end hackathon testnet demo**:

```
LiquidShield events index
positions derive
Scallop live obligation read
Pyth + DeepBook market data
deterministic risk score
OpenAI explanation
on-chain risk snapshot
dry-run rescue PTB
Scallop repay/top-up PTB
REST + SSE + Cube dashboard data
DAO pause/revoke demo
```

But it is **not production-ready yet** because the real production foundations are still open:

```
wallet-based obligation discovery
typed Scallop indexing
shared registry
revocable shared delegation
strict Move Scallop adapters
post-execution verification
auth/privacy
key management
concurrency locks
external audit
```