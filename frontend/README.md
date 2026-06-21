# LiquiFi Guardian — Frontend Dashboard

Next.js (App Router) dashboard for LiquiFi Guardian, wired to the SeFi/LiquidShield
backend and Sui wallets (Slush via the Wallet Standard).

## Running locally

The dashboard talks to the backend over `/api/*`, which Next proxies to the
Express backend (no CORS setup needed — see `next.config.mjs`).

1. **Start the backend** (from `../Sefi/backend`):
   ```bash
   cd ../Sefi/backend && npm install && SEFI_PORT=3210 npm start
   ```
2. **Start the frontend** (this folder):
   ```bash
   npm install && npm run dev
   ```
3. Open http://localhost:3000 → **Open Dashboard**.

### Configuration

| Env var                  | Default                  | Purpose                                   |
| ------------------------ | ------------------------ | ----------------------------------------- |
| `BACKEND_URL`            | `http://localhost:3210`  | Backend the `/api/*` proxy forwards to    |
| `NEXT_PUBLIC_SUI_NETWORK`| `testnet`                | Sui network for wallet + dapp-kit         |
| `NEXT_PUBLIC_API_BASE`   | `` (same-origin)         | Override API base (skip the Next proxy)   |

## How it's wired

- **Wallet** — `app/providers.tsx` sets up `@mysten/dapp-kit` (`SuiClientProvider`
  + `WalletProvider autoConnect`). Slush is auto-detected via the Wallet Standard.
  `app/components/WalletConnect.tsx` exposes the connect button + `useWalletAddress()`.
- **Data layer** — `app/lib/api.ts` holds typed React Query hooks for every
  backend route: `useDashboard`, `useSystemHealth`, `useScallopPositions(owner)`,
  `useActions`, `useRiskScores`, `useEvents`, and mutations `useSimulateShock`,
  `useTriggerAgent`, `useRegisterProtection`, `useOverride`. Polls every ~5s.
- **Pages** (all consume live data, no placeholders):
  - `/dashboard` — stats, risk distribution, system health, positions, recent
    rescues (with Sui explorer links), market snapshot.
  - `/positions` — wallet-based Scallop obligation discovery (`/api/scallop/positions`).
  - `/protect` — onboarding wizard + plain-English policy preview → `register-protection`.
  - `/simulate` — `simulate-shock` + `trigger-agent`, live execution trace, DAO override.
  - `/activity` — `risk_actions` timeline with filters.
  - `/risk-engine` — deterministic score + decoded reason codes + guardrails.
  - `/vault` / `/policy` — vault reserve + Move-enforced policy, pause/revoke via `/api/override`.

## Backend endpoints used

`GET /api/dashboard`, `/api/system/health`, `/api/scallop/positions?owner=`,
`/api/positions`, `/api/risk-scores`, `/api/actions`, `/api/events`,
`POST /api/register-protection`, `/api/simulate-shock`, `/api/trigger-agent`,
`/api/override` — all defined in `Sefi/backend/src/liquidshield-api.js`.
