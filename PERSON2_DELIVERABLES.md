# liquifi — Person 2 Deliverables (Backend / Indexer / Risk Agent)

Everything the frontend (Person 3) needs: how to run, every API endpoint with real
response shapes, realtime stream, Cube access, and what's still pending for mainnet.

**Status: all 5 phases + 8 production-hardening items built, committed, and verified against real Sui testnet/mainnet. No mock data.**

### Core (Phases 0–5)
| Phase | Deliverable | Status |
|---|---|---|
| 0 | Scaffold (deps, config, manifest, env) | ✅ |
| 1 | Sui GraphQL indexer → SeFi `contract_logs` | ✅ verified (real package events) |
| 2 | Deriver: `positions`, `market_snapshots`, `risk_actions` | ✅ verified (real Pyth/DeepBook/Scallop) |
| 3 | Risk agent: score + OpenAI explain + snapshot + rescue | ✅ verified (HF 0.9 → 95 emergency) |
| 4 | REST API + realtime | ✅ verified (full server boot + HTTP) |
| 5 | Cube semantic models (4 cubes) | ✅ verified (YAML valid, tables resolve) |

### Production hardening (from `tobefixed.md` — Person 2's non-optional items, all solved + tested)
| # | Item | How verified |
|---|---|---|
| 1 | Wallet-based Scallop obligation discovery (`GET /api/scallop/positions`) | real mainnet wallet → obligation $504k/$410k, HF 1.094, resolved from its ObligationKey |
| 2 | Typed Scallop semantic indexing (5 event tables + decoders) | 995 raw mainnet events → 245 typed rows (borrow/repay/deposit/withdraw/liq) |
| 9 | Pre/post-execution verification (`before/after_health_factor`, `result_verified`) | testnet rescue → `result_verified=1`; non-improving → auto-execute disabled |
| 14 | Live protocol-state reconciliation (`scallop_obligation_snapshots`) | live read reconciled; forced stale event-debt flagged `is_reconciled=0` |
| 16 | Scallop Cube models (borrows/repays/liquidations/obligations/snapshots) | 5 YAML valid, tables resolve |
| 19 | Transaction simulation gates (dry-run effect assertions) | gas-ceiling=1M → rescue **blocked** fail-closed |
| 20 | Concurrency/idempotency locks (`execution_locks`) | locked tick **skipped** (no double-rescue) |
| 21 | Monitoring (`GET /api/system/health`) + alerts + freshness gate | live metrics; stalled-indexer/stale-oracle → rescue blocked |

> **Verification environments (expected, by design):** Scallop-intelligence items (1,2,14,16) were verified against **mainnet** Scallop — the only network it's deployed on. Execution items (9,19,20,21) were verified against the **demo Scallop** on testnet (real Scallop is mainnet-only, so a testnet stand-in is required to exercise the rescue PTB). Full agent-rescue regression passes with all 8 active.
>
> **`before_health_factor` / `after_health_factor` (#9):** these populate from the Scallop SDK and therefore only on a **real mainnet Scallop obligation**. On the testnet demo Scallop, `readObligationState` falls back to the obligation object's on-chain `debt` field, so verification works via **debt-decrease** (`result_verified=1` when debt drops) — the HF columns stay null but the rescue is still verified. With a real mainnet obligation, the HF columns fill in.
>
> **On-chain (Move) production items are Person 1's** — see `CLATSON_TODO.md` (#5 shared registry, #6 GuardianDelegation, #7 consistency checks, #8 strict Scallop adapters, #23/#24 tests).

---

## 1. Architecture (one line)

`Sui events → indexer → SeFi SQLite → deriver (Pyth + DeepBook + Scallop) → risk agent → on-chain snapshot + rescue PTB → REST API + realtime SSE + Cube`. Built entirely inside **SeFi** (`Sefi/backend/`); SeFi's Hedera path is untouched.

---

## 2. Run the backend

```bash
cd Sefi/backend
cp .env.example .env        # fill OPENAI_API_KEY; object IDs/agent key pre-filled
npm install
npm start                   # indexer + risk agent + API on http://localhost:3210
```

- **Base URL:** `http://localhost:3210`
- liquifi endpoints live under `/api/*` (SeFi's own admin API is under `/api/v1/*`).
- Check it's alive + demo-ready: `curl localhost:3210/api/dashboard | jq .readiness`

---

## 3. REST API

All responses are JSON. All `/api/*` endpoints are open (no auth) for the hackathon.

### GET `/api/dashboard`  — one aggregate call for the whole UI
```jsonc
{
  "positions": [ /* see /api/positions */ ],
  "risk_scores": [ /* latest score per position, see /api/risk-scores */ ],
  "recent_actions": [ /* last 20, see /api/actions */ ],
  "market_snapshot": {
    "asset_pair": "SUI/USD", "mid_price": 0.7209, "price_confidence": 0.00077,
    "oracle_age_ms": 5274, "spread": 0.007, "liquidity_depth": 72.5,
    "volume_24h": 109.15, "liquidity_score": 0.045, "price_change_pct_24h": 0.70,
    "timestamp": "2026-06-20T..."
  },
  "indexer": { "running": true, "events_total": 8, "last_poll_at": "...",
               "sources": [ { "key": "liquidshield", "events_total": 7, "lag_ms": 123, "cursor": "..." } ] },
  "agent": { "running": true, "tick_ms": 20000, "trigger_score": 85,
             "auto_execute": true, "last_tick_at": "...", "active_stress": [] },
  "readiness": { "ready": false, "missing": ["OBLIGATION_ID", "..."] }
}
```

### GET `/api/positions`
```jsonc
{ "positions": [ {
  "id": "0x820b...",            // ProtectedPosition object id (use as positionId)
  "wallet_address": "0x3d16...",
  "protocol": "scallop",         // or "navi" (monitoring-only)
  "obligation_id": "0x...",
  "collateral_asset": "SUI", "debt_asset": "USDC",
  "collateral_value": 1200.0, "debt_value": 800.0,   // null until real obligation
  "health_factor": 0.92,                              // null until real obligation
  "risk_level": "emergency",     // normal|watch|guarded|emergency|monitoring|unknown
  "status": "protected",         // protected|monitoring-only|paused|revoked
  "policy_id": "0x...", "vault_id": "0x...", "snapshot_id": "0x...",
  "last_updated": "2026-06-20T..."
} ] }
```

### GET `/api/risk-scores`  ( `?all=true&limit=100` for history )
```jsonc
{ "risk_scores": [ {
  "id": "0x820b...:1750420000000", "position_id": "0x820b...",
  "market": "SUI/USD", "protocol": "scallop",
  "risk_score": 95, "risk_level": "emergency",
  "reason_codes": 9,                       // bit flags: 1 LOW_HF,2 PRICE_DROP,4 STALE_ORACLE,8 LOW_LIQ,16 VOL,32 LOW_RESERVE
  "reason": "Risk 95/100 (emergency). health factor 0.900 below safe target 1.2...",
  "recommended_action": "repay",           // repay|topup
  "can_execute": 1, "timestamp": "2026-06-20T..."
} ] }
```

### GET `/api/actions`  ( `?limit=100` )  — execution audit trail
```jsonc
{ "actions": [ {
  "id": "4ow7eMK...", "position_id": "0x820b...", "protocol": "scallop",
  "action_type": "repay", "amount": 10000000,
  "tx_digest": "4ow7eMK...",               // real Sui tx — link to explorer
  "status": "executed",                    // executed|blocked|failed|simulated
  "reason": null, "risk_before": 90, "risk_after": null,
  "timestamp": "2026-06-20T..."
} ] }
```

### GET `/api/events`  ( `?limit=100` )  — raw indexed on-chain events feed
```jsonc
{ "events": [ { "contract_id": "0x1a4b...", "tx_hash": "...",
  "event_name": "shield_executor::ShieldActivatedEvent",
  "data": "{...parsed event json...}", "timestamp": "2026-06-20T..." } ] }
```

### GET `/api/scallop/positions?owner=0x…`  — wallet-based obligation discovery (#1)
Discovers ALL Scallop obligations owned by a wallet (a user can have multiple), resolved from their ObligationKey objects.
```jsonc
{ "owner": "0x…", "count": 1, "positions": [ {
  "obligationId": "0xed0d...", "obligationKeyId": "0x425b...", "locked": false,
  "collateralAssets": [ { "coinType": "...::hasui::HASUI", "symbol": "HASUI", "amount": "119000000000", "usdValue": 504714.33 } ],
  "debtAssets": [ { "coinType": "...::usdc::USDC", "symbol": "USDC", "amount": "...", "usdValue": 409677.14 } ],
  "totalCollateralUsd": 504714.33, "totalDebtUsd": 409677.14,
  "scallopRiskLevel": 0.914, "riskLevel": "guarded", "healthFactorLike": 1.094,
  "source": "wallet-owned-obligation-key+scallop-sdk", "lastReadAt": "..."
} ] }
```
Frontend: show "Detected Scallop Positions" with a [Protect this] button per obligation. (Scallop is mainnet-only → use a mainnet `owner`.)

### GET `/api/system/health`  — ops monitoring (#21)
```jsonc
{ "ok": true,
  "indexer_lag_ms": 1200, "indexer_lag_unsafe": false,   // ms since last poll (indexer keeping up?)
  "last_liquidshield_event_at": "...",
  "oracle_age_ms": 3234, "oracle_stale": false,
  "deepbook_ok": true, "agent_ok": true,
  "scallop_read_failures": 0, "disabled_positions": [],
  "failed_ptb_rate_24h": 0, "positions_near_liquidation": 0,
  "last_scallop_event_at": "...", "events_total": 23 }
```
Use for an ops/status panel. When `indexer_lag_unsafe` or `oracle_stale` is true, the agent fail-closes (won't rescue).

### Typed Scallop data (#2/#14) — query via Cube or raw
Typed tables fill from real Scallop events: `scallop_borrow_events`, `scallop_repay_events`, `scallop_collateral_deposit_events`, `scallop_collateral_withdraw_events`, `scallop_liquidation_events`, plus `scallop_obligations` + `scallop_obligation_snapshots`. Query named metrics via the Cube cubes (§5) or raw SQL. (Populated when indexing mainnet Scallop, e.g. `SCALLOP_MAINNET_BENCH=1`.)

### POST `/api/register-protection`
Re-derives positions (picks up new on-chain registrations). Body: none required.
→ `{ "refreshed": 1, "positions": [ ... ] }`

### POST `/api/simulate-shock`  — **demo trigger** (real on-chain rescue follows)
Stresses the trigger for a position then forces an immediate agent tick.
```jsonc
// body (all optional): positionId defaults to env POSITION_ID
{ "positionId": "0x820b...", "healthFactor": 0.88 }   // OR { "haircutPct": 20 }
// → { "applied": {...}, "tick": {...}, "latest_score": { "risk_score": 95, "risk_level": "emergency", "can_execute": 1 } }
```
The price stress only moves the *trigger*; the rescue PTB that fires is 100% real on-chain.

### POST `/api/trigger-agent`  — force one agent tick now
→ `{ "tick": { "positions": 1, "results": [ { "position_id": "...", "score": 95, "executed": true, "digest": "..." } ] } }`

### POST `/api/sui/sync` · GET `/api/sui/status`  — Sui indexer control
The Sui indexer auto-polls every ~10s; `/api/sui/sync` forces an immediate poll. This is what
the SeFi UI's sync button now calls (the old Hedera "Full Sync" is disabled — liquifi is Sui-only).
→ `{ "inserted": 3, "status": { "running": true, "events_total": 11, "sources": [...] } }`

### POST `/api/override`  — **real on-chain** DAO pause/unpause/revoke
```jsonc
{ "action": "pause" }   // pause|unpause|revoke ; needs USER_PRIVATE_KEY (DAO cap holder) in .env
// → { "action": "pause", "policy_id": "0x...", "digest": "...", "status": "success" }
```
After a pause, the next `simulate-shock` rescue is **blocked** (fail-closed) → shows as a `blocked` row in `/api/actions`.

---

## 4. Realtime (Server-Sent Events)

SeFi's SSE hub, channel **`index`** carries all liquifi events:

```js
const es = new EventSource('http://localhost:3210/api/v1/realtime/stream?channels=index');
es.onmessage = (e) => { const ev = JSON.parse(e.data); /* ev.type, ev.payload */ };
```
Event `type`s to react to:
- `risk_score_updated` → `{ position_id, risk_score, risk_level, reason, reason_source, recommended_action, can_execute }`
- `shield_activated` → `{ position_id, tx_digest, action_type, risk_before }`
- `shield_blocked` → `{ position_id, reason }`
- `shock_applied`, `override_executed`
- plus raw indexed event names (e.g. `shield_executor::ShieldActivatedEvent`)

---

## 5. Cube semantic layer (optional, for analytics)

9 cubes: `positions`, `market_snapshots`, `risk_scores`, `risk_actions` + Scallop (#16): `scallop_borrows`, `scallop_repays`, `scallop_liquidations`, `scallop_obligations`, `scallop_obligation_snapshots`.
Query via SeFi's existing proxy (needs the Cube service running — `Sefi/docker-compose.yml`):
```
POST /api/v1/cube/query   { "query": { "measures": ["risk_scores.emergency_count"], "dimensions": ["risk_scores.protocol"] } }
```
Named measures available: `positions.min_health_factor`, `positions.avg_health_factor`,
`market_snapshots.last_price`, `market_snapshots.avg_liquidity_score`, `risk_scores.latest_score`,
`risk_scores.emergency_count`, `risk_actions.executed_count`, `risk_actions.blocked_count`, etc.
For the live UI you can just use the REST endpoints above — Cube is for charts/aggregates.

---

## 6. `readiness` — your pre-demo check

`/api/dashboard.readiness = { ready: boolean, missing: string[] }`. When `ready: true`, all
on-chain wiring (package, policy, vault, snapshot, position, guardian cap, obligation, agent key)
is present and the autonomous rescue can fire. Show a banner if `!ready`.

---

## 7. Demo sequence (what the UI drives)

1. `GET /api/dashboard` → show 2 positions (Scallop executable, NAVI monitoring), live market data.
2. `POST /api/simulate-shock {healthFactor:0.9}` → score jumps to 95 / emergency (watch `risk_score_updated`).
3. Agent auto-submits snapshot + rescue → `shield_activated` SSE → new `/api/actions` row with real `tx_digest`.
4. Show the digest on Suiscan (real `ShieldActivatedEvent`).
5. `POST /api/override {action:"pause"}` → `POST /api/simulate-shock` again → `shield_blocked` (fail-closed).

---

## 8. ⚠️ Pending / what must change before mainnet

**Testnet: ✅ complete** — full autonomous rescue works end-to-end via the demo Scallop (real obligation, debt reduced on rescue, all 8 hardening fixes active). **Backend code is done.** Remaining items are (a) config/ops for mainnet and (b) the **on-chain Move redesign owned by Person 1** (`CLATSON_TODO.md`: #5 shared registry, #6 GuardianDelegation, #7 consistency checks, #8 strict Scallop adapters, #23/#24 tests).

Config/ops for mainnet:

| Item | Status | Action |
|---|---|---|
| **Real `OBLIGATION_ID`** | ⏳ pending | On testnet we use the demo Scallop. For mainnet, discover via `GET /api/scallop/positions?owner=…` (#1), then onboard the chosen obligation. |
| **Coin-type alignment** | ⚠️ check | `COIN_TYPE` must equal the **debt asset** you borrow, and the **vault reserve must hold that same coin**. `.env.example` default is `COIN_TYPE=0x2::sui::SUI` — if debt is USDC, set `COIN_TYPE` to USDC's type and fund the vault in USDC. |
| **Funded vault** | ⏳ ops | Vault reserve ≥ `RESCUE_AMOUNT`, in the debt coin. |
| **Onboarded position** | ⏳ ops | Run Person 1's `ptb/onboard_user.ts` with the real obligation id → fill object IDs into `.env`. |
| **Mainnet env** | ✅ ready (env swap) | Flip the "MAINNET SWITCH-OVER" block in `.env.example`. Backend bridges these to the PTB layer automatically. |
| **Agent wallet gas** | ⏳ ops | Fund `AGENT_ADDRESS` (`0xdd731e…`) with SUI for snapshot + rescue gas. |
| **`OPENAI_API_KEY`** | ✅ set | Real gpt-5 `reason` text; deterministic template fallback if absent. |
| **Coin-type alignment** | ⚠️ check | `COIN_TYPE` must equal the **debt asset** you borrow, and the **vault reserve must hold that same coin**. `.env.example` default is `COIN_TYPE=0x2::sui::SUI` (fine for a SUI vault demo) — if debt is USDC, set `COIN_TYPE` to USDC's type and fund the vault in USDC. |
| **Funded vault** | ⏳ ops | Vault reserve ≥ `RESCUE_AMOUNT`, in the debt coin. |
| **Onboarded position** | ⏳ ops | Run Person 1's `ptb/onboard_user.ts` with the real obligation id → fill object IDs into `.env`. |
| **Mainnet env** | ✅ ready (env swap) | Flip the "MAINNET SWITCH-OVER" block in `.env.example`: GraphQL/RPC URLs, package + registry + DAO cap ids, Scallop mainnet ids, `DEEPBOOK_POOL_NAME=SUI_USDC`, coin type. Backend now bridges these to the PTB layer automatically. |
| **Agent wallet gas** | ⏳ ops | Fund `AGENT_ADDRESS` (`0xdd731e…`) with SUI for snapshot + rescue gas. |
| **`OPENAI_API_KEY`** | ⏳ optional | For real gpt-5 `reason` text; without it, deterministic template is used (loop never breaks). |

**Costs (measured):** publish ≈ 0.093 SUI, rescue ≈ 0.001 SUI; full setup gas < 0.25 SUI.
**DeepBook needs no funding** — we only read its indexer REST API. **Scallop needs no deployment** — we call the already-deployed protocol.

**Safety:** everything is fail-closed — bad config/stale data/paused policy → the rescue simply doesn't execute (logged as `failed`/`blocked`). It never loses funds.

---

## 9. Quick reference

- Backend dir: `Sefi/backend/` · entry: `src/server.js` · port `3210`
- Core modules: `liquidshield-config`, `sui-client`, `sui-events`, `sui-indexer`, `liquidshield-tables`, `market-data`, `scallop-reader`, `liquidshield-deriver`, `risk-engine`, `risk-agent`, `liquidshield-api`
- Hardening modules: `scallop-events`, `scallop-deriver` (typed indexing), `scallop-discovery` (wallet), `scallop-reconciler` (reconciliation), `alerter` (#21)
- Cube models: `Sefi/cube/model/cubes/{positions,market_snapshots,risk_scores,risk_actions,scallop_borrows,scallop_repays,scallop_liquidations,scallop_obligations,scallop_obligation_snapshots}.yml`
- On-chain ABI + object IDs: `ABI_FOR_PERSON2.md` · Move handoff for Person 1: `CLATSON_TODO.md`
- Demo Scallop (testnet stand-in): `scallop-demo/` (package `0xf03ed2d8…`)
