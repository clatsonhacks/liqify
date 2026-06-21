# 🚀 Liqify

### Autonomous Liquidation Protection Powered by SeFi

Liqify is an autonomous pre-liquidation protection agent built on top of **SeFi**, a semantic intelligence layer for Sui DeFi.

Instead of requiring users to monitor lending positions 24/7, Liqify continuously analyzes protocol state, market conditions, liquidity stress, and liquidation risk, then executes bounded rescue actions before liquidation occurs.

Built for **Sui Overflow 2026 — Agentic Web / Autonomous Risk Guardian Track**.

---

# 🌐 What is SeFi?

**SeFi (Semantic Finance Infrastructure)** transforms raw Sui blockchain activity into structured, agent-readable financial intelligence.

Traditional AI agents must parse:

* Events
* Objects
* Transactions
* Protocol-specific data structures

for every protocol individually.

SeFi solves this by creating a universal semantic layer.

```text
Raw Blockchain Data
        │
        ▼
     SeFi
        │
        ▼
Semantic Risk Intelligence
        │
        ▼
 AI Agents & Applications
```

SeFi can understand:

* Lending markets
* Borrow positions
* Liquidation risk
* Liquidity conditions
* Oracle freshness
* Protocol health

across multiple Sui protocols.

---

# Why SeFi Matters

Without SeFi:

```text
Agent
 ├── NAVI parser
 ├── Scallop parser
 ├── DeepBook parser
 ├── Oracle parser
 └── Custom logic
```

With SeFi:

```text
Agent
    │
    ▼
  SeFi
    │
    ▼
Unified Financial Intelligence
```

This enables developers to build autonomous financial agents without rebuilding protocol integrations.

---

# 🛡️ What is Liqify?

Liqify is the first autonomous risk guardian built on top of SeFi.

Its purpose is simple:

> Protect users before liquidation happens.

Instead of waiting for liquidation bots to act, Liqify:

1. Monitors positions
2. Computes risk scores
3. Simulates rescue actions
4. Verifies policy constraints
5. Executes rescue transactions

before liquidation thresholds are crossed.

---

# ⚡ Key Features

### Semantic Risk Intelligence

Powered by SeFi.

Aggregates:

* Scallop positions
* NAVI positions
* DeepBook liquidity
* Oracle data
* Market volatility

into a single risk view.

### AI-Assisted Risk Scoring

Combines:

* Position risk
* Liquidity risk
* Oracle risk
* Volatility risk
* Reserve adequacy

into an explainable score.

### Autonomous Rescue

When risk becomes critical:

* Partial debt repayment
* Collateral top-up
* Risk mitigation actions

are executed automatically through Sui PTBs.

### User Controlled Policies

Users define:

* Spending limits
* Rescue budgets
* Allowed protocols
* Expiry periods
* Emergency stop controls

### Full Auditability

Every action is:

* Logged on-chain
* Reproducible
* Policy verified
* Governance controllable

---

# 🏗 Architecture

```text
Sui Protocols
(Scallop, NAVI, DeepBook)

          │
          ▼

        SeFi
 Semantic Finance Layer

          │
          ▼

   Semantic Risk Data

          │
          ▼

       Liqify
 Autonomous Risk Agent

          │
          ▼

   PTB Simulation Layer

          │
          ▼

 Move Policy Enforcement

          │
          ▼

 Autonomous Rescue Action
```

---

# 🔒 Security Model

Liqify follows a fail-closed architecture.

Execution is blocked if:

* Data is stale
* Simulation fails
* Policy expires
* Daily limits are exceeded
* Protocol is not approved
* User revokes permissions

The AI agent never has unrestricted control over user funds.

Move contracts enforce all critical rules.

---

# 🎯 MVP

### Autonomous

✅ Scallop Monitoring

✅ Scallop Rescue

✅ Risk Scoring

✅ Policy Engine

✅ PTB Execution

### Monitoring

⚠️ NAVI Monitoring

⚠️ Risk Analytics

⚠️ Rescue Recommendations

---

# 🌍 Vision

SeFi becomes the financial intelligence layer for Sui.

Liqify demonstrates what becomes possible when autonomous agents can reason over semantic financial data instead of raw blockchain events.

Today:

> Liqify protects borrowers.

Tomorrow:

> Developers build entire autonomous financial systems on top of SeFi.
