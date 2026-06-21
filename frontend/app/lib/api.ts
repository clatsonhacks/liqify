"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";

// All calls are same-origin `/api/*` and proxied to the backend by Next rewrites
// (see next.config.mjs). Override the base with NEXT_PUBLIC_API_BASE if needed.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
  return res.json() as Promise<T>;
}

async function postJSON<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j?.error?.message) detail = j.error.message;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

// ── Backend row types (mirror Sefi/backend/src/liquidshield-tables.js) ─────────

export type Position = {
  id: string;
  wallet_address: string | null;
  protocol: string | null;
  obligation_id: string | null;
  collateral_asset: string | null;
  debt_asset: string | null;
  collateral_value: number | null;
  debt_value: number | null;
  health_factor: number | null;
  risk_level: string | null;
  status: string | null; // protected | monitoring-only | paused | revoked
  policy_id: string | null;
  vault_id: string | null;
  snapshot_id: string | null;
  last_updated: string | null;
};

export type RiskScore = {
  id: string;
  position_id: string;
  market: string | null;
  protocol: string | null;
  risk_score: number;
  risk_level: string | null; // normal | watch | guarded | emergency
  reason_codes: number;
  reason: string | null;
  recommended_action: string | null;
  can_execute: number;
  timestamp: string;
};

export type RiskAction = {
  id: string;
  position_id: string | null;
  wallet_address: string | null;
  protocol: string | null;
  action_type: string | null; // repay | topup
  amount: number | null;
  tx_digest: string | null;
  status: string | null; // executed | blocked | failed | simulated
  reason_codes: number | null;
  reason: string | null;
  risk_before: number | null;
  risk_after: number | null;
  before_health_factor: number | null;
  after_health_factor: number | null;
  before_risk_level: string | null;
  after_risk_level: string | null;
  simulation_digest: string | null;
  result_verified: number | null;
  timestamp: string;
};

export type MarketSnapshot = {
  id: string;
  asset_pair: string;
  mid_price: number | null;
  price_confidence: number | null;
  oracle_age_ms: number | null;
  spread: number | null;
  liquidity_depth: number | null;
  volume_24h: number | null;
  liquidity_score: number | null;
  price_change_pct_24h: number | null;
  timestamp: string;
};

export type IndexerStatus = {
  running?: boolean;
  events_total?: number;
  last_poll_at?: string | null;
  sources?: Array<{ key: string; last_event_at?: string | null }>;
  [k: string]: unknown;
};

export type AgentStatus = {
  running?: boolean;
  scallop_read_failures?: number;
  disabled_positions?: string[];
  [k: string]: unknown;
};

export type Readiness = { ready: boolean; missing: string[] };

export type DashboardData = {
  positions: Position[];
  risk_scores: RiskScore[];
  recent_actions: RiskAction[];
  market_snapshot: MarketSnapshot | null;
  indexer: IndexerStatus;
  agent: AgentStatus;
  readiness: Readiness;
};

export type SystemHealth = {
  ok: boolean;
  indexer_lag_ms: number | null;
  indexer_lag_unsafe: boolean;
  last_liquidshield_event_at: string | null;
  oracle_age_ms: number | null;
  oracle_stale: boolean;
  deepbook_ok: boolean;
  agent_ok: boolean;
  scallop_read_failures: number;
  disabled_positions: string[];
  failed_ptb_rate_24h: number;
  positions_near_liquidation: number;
  last_scallop_event_at: string | null;
  events_total: number;
};

export type ScallopAsset = { coinType: string; symbol: string; amount: string; usdValue: number };

export type ScallopObligation = {
  owner: string;
  obligationKeyId: string;
  obligationId: string;
  locked: boolean;
  collateralAssets: ScallopAsset[];
  debtAssets: ScallopAsset[];
  totalCollateralUsd: number;
  totalDebtUsd: number;
  scallopRiskLevel: number;
  riskLevel: string;
  healthFactorLike: number | null;
  lastReadAt: string;
  source: string;
};

export type IndexedEvent = {
  contract_id: string;
  tx_hash: string;
  event_name: string;
  data: string;
  timestamp: string;
};

// ── Reason-code decoding (mirrors risk-engine.js REASON bit flags) ─────────────

export const REASON_FLAGS: Array<{ bit: number; code: string; label: string }> = [
  { bit: 1, code: "LOW_HEALTH_FACTOR", label: "Low health factor" },
  { bit: 2, code: "PRICE_DROP", label: "Collateral price drop" },
  { bit: 4, code: "STALE_ORACLE", label: "Stale oracle" },
  { bit: 8, code: "LOW_LIQUIDITY", label: "Thin DeepBook liquidity" },
  { bit: 16, code: "HIGH_VOLATILITY", label: "High volatility" },
  { bit: 32, code: "LOW_RESERVE", label: "Low vault reserve" },
];

export function decodeReasonCodes(codes: number | null | undefined) {
  const n = Number(codes ?? 0);
  return REASON_FLAGS.filter((f) => (n & f.bit) !== 0);
}

// ── Query hooks ────────────────────────────────────────────────────────────────

const POLL_MS = 5_000;

export function useDashboard(options?: Partial<UseQueryOptions<DashboardData>>) {
  return useQuery<DashboardData>({
    queryKey: ["dashboard"],
    queryFn: () => getJSON<DashboardData>("/api/dashboard"),
    refetchInterval: POLL_MS,
    ...options,
  });
}

export function useSystemHealth() {
  return useQuery<SystemHealth>({
    queryKey: ["system-health"],
    queryFn: () => getJSON<SystemHealth>("/api/system/health"),
    refetchInterval: POLL_MS,
  });
}

export function usePositions() {
  return useQuery<{ positions: Position[] }>({
    queryKey: ["positions"],
    queryFn: () => getJSON("/api/positions"),
    refetchInterval: POLL_MS,
  });
}

export function useRiskScores(opts?: { all?: boolean; limit?: number }) {
  const qs = new URLSearchParams();
  if (opts?.all) qs.set("all", "true");
  if (opts?.limit) qs.set("limit", String(opts.limit));
  const suffix = qs.toString() ? `?${qs}` : "";
  return useQuery<{ risk_scores: RiskScore[] }>({
    queryKey: ["risk-scores", opts?.all ?? false, opts?.limit ?? null],
    queryFn: () => getJSON(`/api/risk-scores${suffix}`),
    refetchInterval: POLL_MS,
  });
}

export function useActions(limit = 50) {
  return useQuery<{ actions: RiskAction[] }>({
    queryKey: ["actions", limit],
    queryFn: () => getJSON(`/api/actions?limit=${limit}`),
    refetchInterval: POLL_MS,
  });
}

export function useEvents(limit = 50) {
  return useQuery<{ events: IndexedEvent[] }>({
    queryKey: ["events", limit],
    queryFn: () => getJSON(`/api/events?limit=${limit}`),
    refetchInterval: POLL_MS,
  });
}

export function useScallopPositions(owner: string | null | undefined) {
  return useQuery<{ owner: string; count: number; positions: ScallopObligation[] }>({
    queryKey: ["scallop-positions", owner],
    queryFn: () => getJSON(`/api/scallop/positions?owner=${owner}`),
    enabled: Boolean(owner && owner.startsWith("0x")),
    refetchInterval: 15_000,
  });
}

// ── Mutations ──────────────────────────────────────────────────────────────────

export function useSimulateShock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { positionId?: string; haircutPct?: number; healthFactor?: number }) =>
      postJSON("/api/simulate-shock", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["risk-scores"] });
      qc.invalidateQueries({ queryKey: ["actions"] });
    },
  });
}

export type SimulateRescueStep = {
  key: string;
  status: "done" | "failed" | "skipped";
  [k: string]: unknown;
};

export type SimulateRescueResult = {
  ok: boolean;
  obligation_id: string;
  position_id: string | null;
  coin: { ok: boolean; total_mist?: string; coin_objects?: number; merged?: number };
  status: string;
  tx_digest: string | null;
  snapshot_digest: string | null;
  explorer_url: string | null;
  risk_before: number | null;
  risk_after: number | null;
  action_type: string | null;
  amount: number | null;
  result_verified: number | null;
  reason: string | null;
  steps: SimulateRescueStep[];
};

// One-click end-to-end rescue: resolve obligation -> ensure coins -> snapshot ->
// simulate PTB -> execute (signed by the agent key on the backend) -> return digest.
export function useSimulateRescue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body?: { positionId?: string }) =>
      postJSON<SimulateRescueResult>("/api/simulate-rescue", body ?? {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["risk-scores"] });
      qc.invalidateQueries({ queryKey: ["actions"] });
    },
  });
}

export function useTriggerAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => postJSON("/api/trigger-agent"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["actions"] });
    },
  });
}

export function useRegisterProtection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => postJSON<{ refreshed: number; positions: Position[] }>("/api/register-protection"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["positions"] });
    },
  });
}

export function useOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { action: "pause" | "unpause" | "revoke"; policyId?: string }) =>
      postJSON<{ action: string; policy_id: string; digest: string; status: string }>("/api/override", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["positions"] });
    },
  });
}

// ── Formatting helpers ──────────────────────────────────────────────────────────

export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function shortId(id: string | null | undefined, head = 6, tail = 4): string {
  if (!id) return "—";
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Backend `risk_level` (string) or a numeric 0–100 score → UI status tone. */
export function riskTone(level: string | null | undefined, score?: number): "safe" | "warning" | "danger" | "blue" | "neutral" {
  const lv = (level || "").toLowerCase();
  if (lv === "emergency" || lv === "critical") return "danger";
  if (lv === "guarded" || lv === "watch") return "warning";
  if (lv === "normal" || lv === "safe") return "safe";
  if (typeof score === "number") {
    if (score >= 85) return "danger";
    if (score >= 70) return "warning";
    if (score >= 45) return "blue";
    return "safe";
  }
  return "neutral";
}
