# LiquiFi — Autonomous Pre-Liquidation Guardian for Sui DeFi

LiquiFi is an autonomous risk-guardian system for Sui lending positions. It continuously
turns raw on-chain activity into semantic risk intelligence, scores each protected position,
and — when a position crosses into danger — executes a bounded, fully on-chain rescue
(partial debt repayment or collateral top-up) *before* liquidation bots can act. Every action
is gated by Move-enforced policy, simulated before submission, logged on-chain, and reversible
by the position owner or a DAO.

It is built on **SeFi**, a semantic indexing and intelligence layer that ingests Sui protocol
events (Scallop, DeepBook) into typed, queryable tables and a Cube semantic model, so an AI
agent can reason over financial concepts (health factor, liquidation distance, liquidity,
oracle freshness) instead of raw events.

Built for **Sui Overflow 2026 — Agentic Web / Autonomous Risk Guardian**.

---

## Table of Contents

1. The Problem
2. The Solution
3. System Overview
4. SeFi — The Semantic Intelligence Layer
5. LiquiFi — The Autonomous Guardian
6. On-Chain Architecture (Move)
7. The Risk Model
8. The Rescue Flow
9. Security Model
10. Data Sources
11. Technology Stack
12. Repository Layout
13. HTTP API Reference
14. Running the System
15. Environment Configuration
16. Testnet Deployment
17. Demo Walkthrough
18. Engineering Notes
19. Roadmap to Production

---

## 1. The Problem

Lending borrowers on Sui carry three converging risks:

- **Price shocks.** Collateral value can fall faster than a human can react.
- **Liquidity fragmentation.** During stress, the depth needed to exit dries up.
- **Liquidation bots.** Automated liquidators monitor health factors continuously and act
  the instant a position crosses the boundary — far faster than any manual response.

A borrower can be solvent at midnight and liquidated before waking. Liquidation thresholds are
static relative to the speed of market moves, and the borrower is structurally on the losing
side of a latency race they cannot win by hand.

A liquidation bot profits *after* the user has already crossed the boundary. There is no
widely available system that acts in the borrower's interest *before* that point, autonomously,
within hard safety limits.

---

## 2. The Solution

LiquiFi is a **pre-liquidation** safety layer, not a liquidation bot. It sits above lending
protocols and does four things on a continuous loop:

1. **Indexes** real Sui protocol activity into semantic risk data (SeFi).
2. **Scores** each protected position deterministically and explains the score in plain
   language.
3. **Decides** a bounded rescue (repay or top-up) and simulates it.
4. **Executes** the rescue on-chain through a Move policy/adapter that enforces every limit at
   execution time, then verifies the result.

The central design principle: **the AI recommends and explains, but Move enforces.** The agent
can never move funds outside the bounds encoded on-chain — spend caps, daily budget, protocol
allowlist, expiry, pause, and revocation are all checked by the contracts, not the off-chain
code.

---

## 3. System Overview

The system is four cooperating planes. Off-chain components collect data and reason; on-chain
components custody funds and enforce rules.

```
Sui protocols (Scallop, DeepBook)        Pyth / oracle      User wallet / DAO
        |                                     |                    |
        v                                     v                    v
+--------------------------------------------------------------------------+
|  SeFi  (semantic data plane)                                             |
|    GraphQL indexer  ->  raw event store  ->  typed protocol tables       |
|                                          ->  Cube semantic models        |
+--------------------------------------------------------------------------+
        |
        v
+--------------------------------------------------------------------------+
|  LiquiFi risk agent  (intelligence plane)                                |
|    deterministic risk score  +  reason codes  +  AI explanation          |
|    movement-gated: only re-reasons when the risk picture changes         |
+--------------------------------------------------------------------------+
        |
        v
+--------------------------------------------------------------------------+
|  Execution plane (PTB builder + simulation gates)                        |
|    pre-state read -> on-chain risk snapshot -> dry-run gate -> submit     |
+--------------------------------------------------------------------------+
        |
        v
+--------------------------------------------------------------------------+
|  Move enforcement plane (the law)                                        |
|    RiskPolicy . ShieldVault . ShieldRegistry . GuardianDelegation        |
|    RiskSnapshot . shield_executor . scallop_adapter                      |
+--------------------------------------------------------------------------+
        |
        v
   On-chain rescue + ShieldActivatedEvent  ->  re-indexed by SeFi (audit loop)
```

Processes at runtime:

| Process | Default port | Responsibility |
|---|---|---|
| Backend (SeFi + LiquiFi plane) | 3210 | Indexer, deriver, risk agent, REST API |
| Cube | 4100 | Semantic query layer over the indexed tables |
| Frontend (Next.js) | 3000 | Landing, SeFi console, LiquiFi dashboard |

---

## 4. SeFi — The Semantic Intelligence Layer

SeFi converts blockchain-native data into structured financial intelligence so agents do not
have to hand-parse every protocol.

### Ingestion (Sui GraphQL)

SeFi indexes Sui events through the **GraphQL API** (not the deprecated JSON-RPC path), with
opaque-cursor pagination and per-source sync state. Each configured source (the LiquidShield
package, Scallop) is polled forward from its last cursor; events are written into a generic
`contract_logs` store with the transaction digest, event type, sender, and parsed JSON.

A source can declare its own GraphQL endpoint, so SeFi can index **mainnet Scallop** activity
for intelligence while the guardian itself operates on testnet — both into the same store.

### Typed semantic tables

Raw events are decoded into typed, queryable tables. For Scallop:

- `scallop_borrow_events`, `scallop_repay_events`
- `scallop_collateral_deposit_events`, `scallop_collateral_withdraw_events`
- `scallop_liquidation_events`
- `scallop_obligations` (latest reconciled state), `scallop_obligation_snapshots` (history)

Decoders are derived from the real on-chain event shapes
(`borrow::BorrowEventV3`, `repay::RepayEvent`, `deposit_collateral::CollateralDepositEvent`,
`withdraw_collateral::CollateralWithdrawEvent`, `liquidate::LiquidateEventV2`).

### Cube semantic models

Cube exposes the tables as governed, named metrics so the agent and UI query *concepts* rather
than raw SQL: `scallop_borrows`, `scallop_repays`, `scallop_liquidations`, `scallop_obligations`,
`scallop_obligation_snapshots`, plus the LiquiFi cubes (`positions`, `market_snapshots`,
`risk_scores`, `risk_actions`). Measures include counts, totals, at-risk counts, latest scores,
and reconciliation drift.

### Protocol reconciliation

Event-derived state drifts (interest accrual, price moves, oracle updates). A reconciler reads
live obligation state through the Scallop SDK on an interval and writes trusted snapshots. When
event-derived and live values disagree, the discrepancy is flagged and **the live read is the
source of truth for any execution decision.**

### The SeFi console

A natural-language console answers questions over the semantic layer
("how many Scallop borrows are indexed?", "liquidations last week?"). The answer is computed
deterministically from the indexed data; an LLM layer phrases it. If the LLM is unavailable, a
deterministic semantic fallback still returns the correct numbers with the source tables and
time window cited.

---

## 5. LiquiFi — The Autonomous Guardian

The risk agent runs a fixed-interval loop (default 20s):

1. Refresh positions (from registration events + live Scallop reads) and market snapshots
   (Pyth price + oracle age, DeepBook liquidity).
2. Compute a deterministic risk score and reason-code bit flags for each position.
3. Produce a human-readable explanation — **only when the risk picture has actually moved**
   (severity band or reason codes changed into an elevated state). Unchanged ticks reuse the
   cached explanation; normal/watch states use a free deterministic template. This makes the
   LLM cost event-driven rather than continuous.
4. If a position is at/over the trigger and policy permits: submit an on-chain risk snapshot,
   run the simulation gate, execute the rescue, then verify the post-state.

Wallet-based onboarding discovers a user's Scallop obligations directly from the
`ObligationKey` objects in their wallet — no manually configured obligation id is required.

---

## 6. On-Chain Architecture (Move)

The contracts enforce rules; they do not make discretionary market judgments. The off-chain
agent builds Programmable Transaction Blocks (PTBs); Move validates capabilities, ownership,
scope, limits, freshness, and emits the audit events.

| Module | Responsibility |
|---|---|
| `risk_policy` | Spend caps, daily/window budget, expiry, pause, owner/DAO revoke |
| `shield_vault` | Custodies the emergency reserve; enforces spend counters and routing |
| `shield_registry` | Shared registry of protected obligations and their config |
| `guardian_cap` / GuardianDelegation | Owner-controlled, revocable authorization for the agent |
| `shield_oracle` | On-chain risk snapshot with freshness metadata |
| `shield_executor` | Validates invariants, withdraws reserve, completes the rescue (package-internal) |
| `scallop_adapter` | The single public entry point that runs the full rescue against Scallop |

### Execution boundary

`shield_executor::begin_rescue` / `complete_rescue` are `public(package)` — they cannot be
called directly from a PTB. The only externally callable rescue entry points are
`scallop_adapter::execute_scallop_repay<T>` and `execute_scallop_topup<T>`, which run the entire
flow internally: validate policy and delegation, withdraw the bounded amount from the vault,
perform the Scallop action, and emit `ShieldActivatedEvent`. This guarantees on-chain that the
agent cannot receive an unrestricted coin and route it elsewhere.

### Core invariants

```
I1  The agent cannot withdraw from the vault without a valid, unrevoked, unexpired delegation.
I2  The delegation alone is insufficient: RiskPolicy must be active (not paused/revoked/expired).
I3  The target protocol + obligation must be registered in the shared ShieldRegistry.
I4  Rescue amount <= max_per_action AND <= remaining window/daily budget.
I5  Withdrawn reserve goes only into the protocol action or back to the vault.
I6  Owner revocation or DAO pause blocks all future execution.
I7  Every successful rescue emits ShieldActivatedEvent with amount, reason, and tx context.
```

### Events

`ProtectionRegisteredEvent`, `ReserveDepositedEvent`, `RiskScoreUpdatedEvent`,
`PolicyChangedEvent`/`PolicyPausedEvent`, `ShieldActivatedEvent`, `ShieldBlockedEvent`,
`OverrideExecutedEvent`, `ProtectionRevokedEvent`.

---

## 7. The Risk Model

The score is **deterministic and explainable**, not learned. The AI only interprets it.

```
score = clamp(0, 100,
    40 * position_risk        # distance from safe health-factor target to liquidation
  + 25 * volatility_risk      # 24h price move
  + 20 * liquidity_risk       # DeepBook spread/depth (inverse of liquidity score)
  + 15 * oracle_risk )        # oracle staleness vs max age
```

A protocol-threshold escalation overrides the blend near the boundary: health factor at or
below 1.0 forces score >= 95; at or below 1.05 forces score >= 85.

Reason-code bit flags (`LOW_HEALTH_FACTOR=1`, `PRICE_DROP=2`, `STALE_ORACLE=4`,
`LOW_LIQUIDITY=8`, `HIGH_VOLATILITY=16`, `LOW_RESERVE=32`) are composed and carried on-chain in
the risk snapshot.

Trigger bands:

| Band | Score | Behavior |
|---|---|---|
| Normal | 0–44 | Log only |
| Watch | 45–69 | Increased monitoring |
| Guarded | 70–84 | Pre-simulate, alert |
| Emergency | 85–100 | Execute bounded rescue if policy, freshness, and simulation pass |

---

## 8. The Rescue Flow

```
1. Read pre-state of the obligation (live).
2. Submit an on-chain RiskSnapshot (score, severity, reason codes, health factor, price).
3. Simulation gate (dry run) asserts:
     - the target obligation is mutated by the transaction
     - no coin is credited to a non-allowlisted address
     - gas is within the configured ceiling
     - the coin type matches the debt asset
4. Concurrency lock: at most one rescue in flight per obligation (no double-rescue).
5. Submit the adapter PTB (execute_scallop_repay / execute_scallop_topup).
6. Read post-state; mark result_verified if risk improved; otherwise flag and
   disable auto-execute for that position.
```

If any gate fails, the action is recorded as `blocked` / `failed` and nothing is submitted.

---

## 9. Security Model

The threat model assumes the agent key, indexer, LLM, and external data can each fail or be
compromised. Safety is preserved because spend limits, protocol scope, freshness, and
revocation live **on-chain**.

Fail-closed rules (the system does nothing harmful when uncertain):

- Stale risk data or oracle beyond max age -> do not execute.
- Indexer lag beyond budget -> do not execute.
- Simulation fails or asserts a violation -> do not submit.
- Policy paused, revoked, expired, or over budget -> do not execute.
- Obligation not registered, or destination not allowlisted -> do not execute.

The worst-case outcome of a bug or attack is "the rescue did not fire," never "funds were
moved improperly."

---

## 10. Data Sources

| Source | Use | Notes |
|---|---|---|
| Sui GraphQL | Event indexing + object reads | Forward-looking data API; no JSON-RPC dependency |
| Pyth (Hermes) | Collateral price + real oracle age | Drives the freshness/fail-closed check |
| DeepBook v3 indexer | Liquidity signal (spread, depth, volume) | Read-only REST; no funds, no gas |
| Scallop SDK | Obligation discovery + collateral/debt/risk reads | Wallet `ObligationKey` -> obligation resolution |

Scallop is a mainnet-only protocol. For testnet end-to-end execution, a minimal Scallop-shaped
demo package mirrors the `repay` / `deposit_collateral` interface so the full rescue path can run
on-chain on testnet. Scallop *intelligence* (borrows, repays, liquidations) is indexed from real
mainnet activity.

---

## 11. Technology Stack

- **Sui Move** — six guardian modules plus the Scallop adapter; capability/object-centric design.
- **Programmable Transaction Blocks** — atomic multi-call rescue, builds off-chain, executes
  through one adapter entry point.
- **Node.js (ESM) + Express** — SeFi backend and the LiquiFi REST API.
- **SQLite** — embedded store for raw events and derived tables.
- **Cube** — semantic model and query layer.
- **@mysten/sui** — GraphQL client, PTB construction, transaction signing.
- **@scallop-io/sui-scallop-sdk** — obligation discovery and live state reads.
- **Pyth Hermes + DeepBook indexer** — real market data over HTTP.
- **Pluggable LLM** (Groq / OpenAI-compatible) for explanations, with a deterministic fallback
  that keeps the agent fully functional when no model is available.
- **Next.js + React + @mysten/dapp-kit** — frontend and wallet connection.

---

## 12. Repository Layout

```
liquidshield-guardian/
  contracts/                Move package (risk_policy, shield_vault, shield_registry,
                            guardian_cap, shield_oracle, shield_executor, scallop_adapter)
  scallop-demo/             Minimal Scallop-shaped Move package for testnet execution
  ptb/                      TypeScript PTB builders + deploy/onboard/rescue scripts
  Sefi/
    backend/src/            SeFi core + the LiquiFi Sui plane:
      sui-client, sui-events, sui-indexer        (ingestion)
      scallop-events, scallop-deriver            (typed Scallop indexing)
      scallop-discovery, scallop-reader,
        scallop-reconciler                       (obligation discovery + live state)
      liquidshield-tables, liquidshield-deriver  (derived tables)
      market-data                                (Pyth + DeepBook)
      risk-engine, risk-agent                    (scoring + autonomous loop)
      alerter                                    (ops alerts)
      liquidshield-api                           (REST + bootstrap)
    cube/model/cubes/       Cube semantic models
  frontend/                 Next.js app (landing, SeFi console, LiquiFi dashboard)
```

---

## 13. HTTP API Reference

All LiquiFi endpoints are served under `/api/*` on the backend (port 3210); the frontend
proxies them. SeFi's own platform endpoints live under `/api/v1/*`.

| Method + path | Description |
|---|---|
| `GET /api/dashboard` | Aggregate: positions, latest risk scores, recent actions, market snapshot, indexer + agent status, readiness |
| `GET /api/positions` | Protected positions with live risk fields |
| `GET /api/risk-scores` | Latest score per position (`?all=true&limit=N` for history) |
| `GET /api/actions` | Rescue audit log with tx digests and before/after state |
| `GET /api/events` | Raw indexed on-chain event feed |
| `GET /api/scallop/positions?owner=0x...` | Wallet-based Scallop obligation discovery |
| `GET /api/system/health` | Indexer lag, oracle freshness, agent status, failed-rescue rate, near-liquidation count |
| `POST /api/simulate-shock` | Demo trigger: stress a position's risk then run an immediate tick |
| `POST /api/trigger-agent` | Force one agent tick |
| `POST /api/override` | On-chain DAO/owner pause / unpause / revoke |
| `POST /api/register-protection` | Re-derive positions from on-chain registrations |

---

## 14. Running the System

Prerequisites: Node.js 20+, Docker (for Cube), the Sui CLI (for deployment), and an `.env`
populated as in the next section.

```
# 1. Backend + Cube (from the Sefi directory)
cd Sefi
npm install
npm start                 # backend on :3210, Cube on :4100

# 2. Frontend (separate terminal)
cd frontend
npm install
npm run dev               # app on :3000

# 3. PTB scripts (deploy / onboard / rescue) build once
cd ptb
npm install
npm run build
```

Confirm readiness:

```
curl -s localhost:3210/api/dashboard      | jq .readiness
curl -s localhost:3210/api/system/health  | jq '{ok, indexer_lag_unsafe, oracle_stale, agent_ok}'
```

---

## 15. Environment Configuration

The backend reads `.env` from either `Sefi/.env` or `Sefi/backend/.env`. Key groups:

```
# Sui network
SUI_GRAPHQL_URL, SUI_RPC_URL, SUI_NETWORK

# LiquidShield deployment (package + shared objects)
LIQUIDSHIELD_PACKAGE_ID, SHIELD_REGISTRY_ID, DAO_OVERRIDE_CAP_ID

# Per-position objects (from onboarding)
RISK_POLICY_ID, VAULT_ID, SNAPSHOT_ID, GUARDIAN_DELEGATION_ID, OBLIGATION_ID

# Agent identity (holds the delegation; signs snapshots + rescues)
AGENT_ADDRESS, AGENT_PRIVATE_KEY        # fund with gas; never commit a real key

# Scallop constants (demo on testnet; real on mainnet)
SCALLOP_PACKAGE_ID, SCALLOP_VERSION_ID, SCALLOP_MARKET_ID

# Market data
PYTH_HERMES_URL, PYTH_PRICE_FEED_ID, DEEPBOOK_INDEXER_URL, DEEPBOOK_POOL_NAME

# Risk agent
SEFI_AGENT_TICK_MS, LIQUIDSHIELD_TRIGGER_SCORE, MAX_SNAPSHOT_AGE_MS,
MIN_HEALTH_FACTOR, RESCUE_AMOUNT, LIQUIDSHIELD_AUTO_EXECUTE,
MAX_GAS, EXECUTION_LOCK_TTL_MS, INDEXER_LAG_BUDGET_MS

# LLM (optional; deterministic fallback if absent)
GROQ_API_KEY / OPENAI_API_KEY, model selection
```

Moving to mainnet is an environment swap — every address is read from env, so no code change is
required. On mainnet the vault holds real funds: keep the reserve small, set conservative caps,
and leave auto-execute off until the moment of demonstration.

---

## 16. Testnet Deployment

The guardian package and a Scallop-shaped demo package are deployed on Sui testnet. The exact
object ids (package, shared registry, DAO cap, per-position policy/vault/snapshot/delegation,
demo Scallop version/market) are tracked in `.env` and in the on-chain ABI notes
(`ABI_FOR_PERSON2.md`). The end-to-end rescue path has been exercised on testnet, producing real
`ShieldActivatedEvent` transactions that SeFi re-indexes into the action ledger.

---

## 17. Demo Walkthrough

The narrative runs landing -> SeFi -> LiquiFi.

1. **Landing.** A split entry to the SeFi intelligence console and the LiquiFi guardian.
2. **SeFi console.** Show the live semantic index — indexed Scallop and DeepBook coverage — and
   ask it questions answered from the indexed data.
3. **LiquiFi dashboard.** Protected positions, live market data, risk distribution, and a
   system-health panel (agent, indexer lag, oracle freshness).
4. **Protect.** Connect a wallet; LiquiFi discovers its Scallop obligations from the wallet's
   `ObligationKey` objects.
5. **Simulate.** Drive a position into the emergency band; the agent submits an on-chain snapshot
   and executes a real rescue. The action appears in the audit log with a transaction digest and
   before/after verification.
6. **Override.** Pause the policy on-chain; the next rescue attempt is blocked, demonstrating
   fail-closed governance.

---

## 18. Engineering Notes

- **GraphQL, not JSON-RPC.** Sui's JSON-RPC data path is deprecated; all reads use GraphQL with
  cursor pagination, so the indexer is forward-compatible.
- **Movement-gated reasoning.** The LLM explanation is only computed when a position's risk
  state changes; otherwise the cached explanation is reused. This turns continuous per-tick LLM
  usage into event-driven usage and keeps cost negligible.
- **Provider-agnostic LLM with deterministic fallback.** The explanation path prefers a
  lightweight model but degrades to a deterministic template; the agent loop never depends on an
  LLM being reachable.
- **Live read is the source of truth.** Execution always uses live SDK/object reads, not
  event-derived state, with drift flagged by the reconciler.
- **Idempotent, locked execution.** Per-obligation locks prevent duplicate rescues across ticks.

---

## 19. Roadmap to Production

Implemented: GraphQL indexing, typed Scallop semantic tables, Cube models, wallet-based
obligation discovery, protocol-state reconciliation, deterministic risk scoring with explainable
output, on-chain snapshots, simulation-gated and movement-gated autonomous rescue through the
Scallop adapter, pre/post-execution verification, concurrency locks, monitoring and alerts, and
DAO/owner override — all exercised on testnet.

Production hardening (in progress / planned): production checkpoint/gRPC ingestion, dynamic
verification of official protocol addresses, tiered API authentication and per-wallet privacy
scoping, isolated signer/key management, formal Move test and fuzz suites, an external security
audit, and a multi-service production deployment topology.

---

LiquiFi demonstrates the broader thesis behind SeFi: when raw chain data becomes semantic
financial intelligence, autonomous agents can reason and act safely on it. Today that protects
borrowers from liquidation. The same foundation generalizes to any autonomous financial system
that needs to understand Sui DeFi rather than merely observe it.
