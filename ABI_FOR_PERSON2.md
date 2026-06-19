# LiquidShield Guardian — On-Chain ABI for Backend Integration

Package: `0x1a4bc48f7c7cff2bcada2189e3b9c9686c866579629d06af99278370e41f0ecf`  
Network: Sui Testnet  
Deploy TX: `6Syp53QBTwMv8otN1gm4mZX8wsEbeVyUokHb2At8eDt2`  
Rescue demo TX: `4ow7eMKhAsDowGwQJJdGzGiJTR84KKZMLjdAtwSyfDkN`

---

## Shared Objects (always required)

| Object | ID | Mutability |
|---|---|---|
| ShieldRegistry | `0x0c002ee24b4beb2ce954c9113f12fec6b3549ac8e12739a501a863473a849b8b` | mut |
| Sui Clock | `0x0000000000000000000000000000000000000000000000000000000000000006` | immut |

---

## Event Types (subscribe these for monitoring)

All prefixed with `0x1a4bc48f7c7cff2bcada2189e3b9c9686c866579629d06af99278370e41f0ecf::`

### `shield_executor::ShieldActivatedEvent`
```json
{
  "vault_id":        "0x...",
  "position_id":     "0x...",
  "protocol":        [115,99,97,108,108,111,112],  // bytes of "scallop"
  "obligation_id":   "0x...",
  "amount_used":     "10000000",
  "action_type":     0,    // 0=repay, 1=topup
  "risk_score_before": 90,
  "reason_codes":    "3",  // bit flags: 1=LOW_HF, 2=PRICE_DROP, 4=STALE_ORACLE...
  "executor":        "0x..."
}
```

### `shield_executor::ShieldBlockedEvent`
```json
{
  "vault_id": "0x...", "position_id": "0x...",
  "protocol": [...], "obligation_id": "0x...", "amount": "...",
  "reason": "..." 
}
```

### `shield_oracle::RiskScoreUpdatedEvent`
```json
{
  "snapshot_id": "0x...", "position_id": "0x...",
  "risk_score": 90, "severity": 3, "reason_codes": 3,
  "health_factor_x1000": 900, "collateral_price_usd_x1e6": 98000000,
  "snapshot_at_ms": 1750417200000
}
```

### `risk_policy::PolicyCreatedEvent`
```json
{
  "policy_id": "0x...", "owner": "0x...",
  "trigger_score": 75, "max_per_action": 25000000,
  "max_daily": 100000000, "expires_at_ms": 1758362400000
}
```

### `shield_registry::ProtectionRegisteredEvent`
```json
{
  "position_id": "0x...", "registry_id": "0x...", "owner": "0x...",
  "protocol": [...], "obligation_id": "0x...",
  "collateral_asset": [...], "debt_asset": [...]
}
```

Other event types: `guardian_cap::GuardianCapMintedEvent`, `guardian_cap::GuardianCapRevokedEvent`,
`risk_policy::PolicyChangedEvent`, `risk_policy::PolicyPausedEvent`,
`risk_policy::ProtectionRevokedEvent`, `risk_policy::OverrideExecutedEvent`,
`shield_registry::ProtectionDeregisteredEvent`, `shield_oracle::RiskSnapshotCreatedEvent`,
`shield_vault::ReserveDepositedEvent`, `shield_vault::ReserveWithdrawnEvent`

---

## Entry Functions (user-facing)

### `risk_policy::create_and_share_policy`
Creates a shared RiskPolicy. Emits `PolicyCreatedEvent`.
```
Args:
  trigger_score:          u8       — risk score 0-100 above which guardian acts
  max_per_action:         u64      — max coins per single rescue (base units)
  max_daily:              u64      — max coins per 24h window (base units)
  expires_at_ms:          u64      — unix timestamp ms when policy expires
  min_health_factor_x1000: u64    — target health factor ×1000 (e.g. 1200 = 1.2)
```

### `guardian_cap::mint_and_transfer_guardian_cap`
Mints a GuardianCap and sends it to the agent address.
```
Args:
  agent_address:  address
  expires_at_ms:  u64
```

### `shield_registry::register_position`
Registers a borrowing position. Creates `ProtectedPosition` owned by sender.
```
Args:
  registry:                  &mut ShieldRegistry (SHIELD_REGISTRY_ID)
  protocol:                  vector<u8>   — b"scallop" or b"navi"
  obligation_id:             address      — Scallop obligation object ID
  collateral_asset:          vector<u8>   — e.g. b"SUI"
  debt_asset:                vector<u8>   — e.g. b"USDC"
  trigger_score_override:    u8           — ignored when use_override=false
  use_override:              bool
```

### `shield_oracle::create_snapshot`
Creates a shared RiskSnapshot (one per position, created by user).
```
Args:
  position_id:  ID      — object ID of the ProtectedPosition
  agent:        address — agent that may submit updates
  clock:        &Clock  (0x6)
```

### `shield_vault::create_and_deposit<T>`
Creates a ShieldVault and deposits initial reserve.
```
Type args: [CoinType]
Args:
  deposit:          Coin<T>
  max_per_action:   u64
  max_per_window:   u64
  window_ms:        u64    — rolling window duration in ms (e.g. 86_400_000 for 24h)
  clock:            &Clock (0x6)
```

---

## Agent-callable Functions

### `shield_oracle::submit_risk_snapshot`
Agent pushes latest risk data. Must be called before `begin_rescue`.
```
Args:
  snapshot:                   &mut RiskSnapshot (shared)
  risk_score:                 u8    — 0-100
  severity:                   u8    — 0=normal 1=watch 2=guarded 3=emergency
  reason_codes:               u64   — bit flags (see below)
  recommended_action:         u8    — 0=repay 1=topup
  health_factor_x1000:        u64
  collateral_price_usd_x1e6:  u64
  price_feed_at_ms:           u64
  clock:                      &Clock (0x6)
```

### Reason code bit flags
| Flag | Value | Meaning |
|---|---|---|
| LOW_HEALTH_FACTOR | 1 | HF below threshold |
| PRICE_DROP | 2 | Collateral price fell |
| STALE_ORACLE | 4 | Price feed stale |
| LOW_LIQUIDITY | 8 | Protocol liquidity low |
| HIGH_VOLATILITY | 16 | Market volatile |
| LOW_RESERVE | 32 | Vault reserve low |

---

## Rescue PTB Call Sequence (agent executes)

```typescript
// 1. begin_rescue (validates I1-I5, withdraws from vault)
//    Returns: (Coin<T>, RescueReceipt)  — RescueReceipt is a hot-potato (no drop)
const [coins, receipt] = pkg::shield_executor::begin_rescue<T>(
  cap:                &GuardianCap,       // agent's cap
  policy:             &RiskPolicy,        // shared
  snapshot:           &RiskSnapshot,      // shared
  position:           &ProtectedPosition, // user-owned
  vault:              &mut ShieldVault<T>,// shared
  protocol:           vector<u8>,
  obligation_id:      address,
  amount:             u64,
  max_snapshot_age_ms: u64,
  clock:              &Clock
)

// 2. Protocol action (Scallop repay example)
//    Scallop pkg: 0xd971609b7feb6230585831e7aeb3c121fb21b9431337a30fc99185eb459a05ee
pkg_scallop::repay::repay<T>(
  version:    &Version,   // 0x72bc09c4ce413d76d07f6e712413aebbe3ce3747eadfbc2331fbdb1dbde2d43a
  obligation: &mut Obligation,  // user's Scallop obligation (shared)
  market:     &mut Market,// 0xed80ed898df1e0b7a14b78c92527b47ef88591d5722ded16050d7e101687bb20
  coin:       Coin<T>,
  clock:      &Clock
)

// 3. complete_rescue (consumes receipt, returns leftover, emits ShieldActivatedEvent)
pkg::shield_executor::complete_rescue<T>(
  receipt:     RescueReceipt,    // must be consumed in same PTB
  vault:       &mut ShieldVault<T>,
  leftover:    Coin<T>,          // 0-value coin if all funds used
  action_type: u8                // 0=repay, 1=topup
)
```

---

## Testnet Object IDs (current demo deployment)

| Object | ID |
|---|---|
| RiskPolicy | `0xee1abcfdb3300e2166d8ed2cc9041abad1dcd6bc3423f39e008cde2ead3cb557` |
| GuardianCap | `0x8c6bb40513df72eff7020cdb53684200deaa25f92e9638cfb942fb274885d101` |
| ProtectedPosition | `0x820b4a4921d2866b49b91df8f7ab281d62a623101b7b6c779abb64064974ebbb` |
| RiskSnapshot | `0x12ad8fa2bc4c51e7030c6227827294c11f868988872f84cc68cf896ba3e759e0` |
| ShieldVault (SUI) | `0xcc9a44575022331c4ad22da618847b6c8f41ecda400f2e9042ea7b0ed544ba4f` |
| ShieldRegistry | `0x0c002ee24b4beb2ce954c9113f12fec6b3549ac8e12739a501a863473a849b8b` |
| DAOOverrideCap | `0x2b5a6347816149967714ea205381bf1a56da5d2dd33516c5375b6dafad789be0` |

---

## Scallop Testnet Constants (needed for rescue PTB)

| Constant | ID |
|---|---|
| Protocol Package | `0xd971609b7feb6230585831e7aeb3c121fb21b9431337a30fc99185eb459a05ee` |
| Version Object | `0x72bc09c4ce413d76d07f6e712413aebbe3ce3747eadfbc2331fbdb1dbde2d43a` |
| Market Object | `0xed80ed898df1e0b7a14b78c92527b47ef88591d5722ded16050d7e101687bb20` |
| Coin Decimals Registry | `0x200abe9bf19751cc566ae35aa58e2b7e4ff688fc1130f8d8909ea09bc137d668` |
| xOracle | `0xb112727f380857fd711f89b450a3b22dc4cc55f82b2212b001f2461d6257b0b9` |
