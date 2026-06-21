"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Activity, AlertTriangle, ArrowRight, Check, CheckCircle2, Coins,
  Clock3, Database, ExternalLink, FlaskConical, Loader2, LockKeyhole, Pause, Play,
  Plus, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Sparkles,
  TrendingDown, TrendingUp, WalletCards, X, Zap,
} from "lucide-react";
import { CardTitle, GuardianShell, SectionCard, Status } from "./GuardianShell";
import { useWalletAddress, WalletConnect } from "./WalletConnect";
import {
  decodeReasonCodes, fmtNum, fmtUsd, riskTone, shortId, timeAgo,
  useActions, useDashboard, useOverride, useRegisterProtection, useRiskScores,
  useScallopPositions, useSimulateRescue, useTriggerAgent,
  type Position, type RiskScore, type ScallopObligation,
} from "../lib/api";

const SUI_EXPLORER = "https://suiscan.xyz/testnet/tx/";

function MiniLine({ values, danger = false }: { values: number[]; danger?: boolean }) {
  if (!values.length) values = [0, 0];
  if (values.length === 1) values = [values[0], values[0]];
  const points = values.map((v, i) => `${(i / (values.length - 1)) * 180},${62 - (Math.max(0, Math.min(100, v)) / 100) * 55}`).join(" ");
  const last = values.at(-1)!;
  return <svg className={`section-mini-line ${danger ? "danger" : ""}`} viewBox="0 0 180 64" preserveAspectRatio="none"><line x1="0" y1="18" x2="180" y2="18"/><polyline points={points}/><circle cx="180" cy={62 - (Math.max(0, Math.min(100, last)) / 100) * 55} r="4"/></svg>;
}

function InfoDot() { return <span className="info-dot">i</span>; }

function EmptyState({ icon, title, hint }: { icon: React.ReactNode; title: string; hint: string }) {
  return <SectionCard className="wallet-empty"><div className="wallet-orbit">{icon}<i/><i/></div><h2>{title}</h2><p>{hint}</p></SectionCard>;
}

/** Latest risk score per position id (from dashboard payload). */
function useScoreMap() {
  const { data } = useDashboard();
  return useMemo(() => {
    const m = new Map<string, RiskScore>();
    for (const s of data?.risk_scores ?? []) m.set(s.position_id, s);
    return m;
  }, [data]);
}

/** Risk-score history series per position (for sparklines). */
function useSeriesMap() {
  const { data } = useRiskScores({ all: true, limit: 500 });
  return useMemo(() => {
    const m = new Map<string, number[]>();
    const rows = [...(data?.risk_scores ?? [])].reverse(); // oldest → newest
    for (const r of rows) {
      const arr = m.get(r.position_id) ?? [];
      arr.push(r.risk_score);
      m.set(r.position_id, arr);
    }
    return m;
  }, [data]);
}

// ── Positions ────────────────────────────────────────────────────────────────

export function PositionsSection() {
  const owner = useWalletAddress();
  const scallop = useScallopPositions(owner);
  const { data: dash } = useDashboard();
  const [selected, setSelected] = useState<string | null>(null);

  const protectedByObligation = useMemo(() => {
    const m = new Map<string, Position>();
    for (const p of dash?.positions ?? []) if (p.obligation_id) m.set(p.obligation_id, p);
    return m;
  }, [dash]);

  if (!owner) {
    return <GuardianShell current="Positions" title="My Positions" description="Detect your Scallop obligations and choose the exact position LiquiFi should protect.">
      <SectionCard className="wallet-empty"><div className="wallet-orbit"><WalletCards size={38}/><i/><i/></div><h2>Connect your Sui wallet</h2><p>Connect a Sui wallet (Slush) to detect your Scallop borrow positions.</p><WalletConnect className="gs-primary"/></SectionCard>
    </GuardianShell>;
  }

  const positions = scallop.data?.positions ?? [];

  return <GuardianShell current="Positions" title="My Positions" description="Detect your Scallop obligations and choose the exact position LiquiFi should protect.">
    <div className="section-note"><InfoDot/>Scallop wallets can hold multiple obligations. Select the exact position you want LiquiFi to protect.</div>
    {scallop.isLoading ? <SectionCard><p style={{ padding: 24 }}>Reading on-chain Scallop obligations for {shortId(owner)}…</p></SectionCard>
      : scallop.isError ? <EmptyState icon={<AlertTriangle size={34}/>} title="Could not read Scallop positions" hint={String(scallop.error?.message || "Backend unavailable")}/>
      : positions.length === 0 ? <EmptyState icon={<Database size={34}/>} title="No Scallop obligations found" hint={`No ObligationKey objects are owned by ${shortId(owner)}. Open a Scallop borrow position first.`}/>
      : <div className="positions-grid">{positions.map((position, index) => {
          const onchain = protectedByObligation.get(position.obligationId);
          const riskPct = Math.round((position.scallopRiskLevel || 0) * 100);
          const protection = onchain ? (onchain.status === "protected" ? "Protected" : onchain.status ?? "Monitor Only") : "Not Protected";
          return <SectionCard key={position.obligationId} className={`position-list-card ${selected === position.obligationId ? "is-selected" : ""}`}>
            <button className="card-select" onClick={() => setSelected(position.obligationId)} aria-label={`Select obligation ${index + 1}`}><span>{index + 1}</span><i/></button>
            <div className="position-list-head"><div><small>SCALLOP OBLIGATION</small><h2>Obligation {index + 1}</h2><code>{shortId(position.obligationId, 8, 6)}</code></div><Status tone={riskTone(position.riskLevel)}>{position.riskLevel}</Status></div>
            <MiniLine values={[riskPct * 0.7, riskPct * 0.8, riskPct * 0.9, riskPct]} danger={riskPct > 80}/>
            <div className="position-data">
              <div><span>Collateral</span><b>{fmtUsd(position.totalCollateralUsd)}</b></div>
              <div><span>Debt</span><b>{fmtUsd(position.totalDebtUsd)}</b></div>
              <div><span>Risk Level</span><b>{riskPct}%</b></div>
              <div><span>Health Factor</span><b>{position.healthFactorLike != null ? fmtNum(position.healthFactorLike) : "—"}</b></div>
            </div>
            <div className="position-card-foot"><Status tone={protection === "Protected" ? "blue" : "neutral"}>{protection}</Status><Link href="/protect">Protect this position <ArrowRight size={15}/></Link></div>
          </SectionCard>;
        })}</div>}
  </GuardianShell>;
}

// ── Protect (onboarding wizard) ──────────────────────────────────────────────

export function ProtectSection() {
  const owner = useWalletAddress();
  const scallop = useScallopPositions(owner);
  const register = useRegisterProtection();
  const [step, setStep] = useState(0);
  const [asset, setAsset] = useState("USDC");
  const [amount, setAmount] = useState("500");
  const [trigger, setTrigger] = useState(85);
  const [target, setTarget] = useState(70);
  const [maxAction, setMaxAction] = useState("150");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [active, setActive] = useState(false);
  const labels = ["Select Position", "Deposit Reserve", "Guardian Rules", "Review & Activate"];
  const positions = scallop.data?.positions ?? [];
  const selected = positions[selectedIdx];

  const onActivate = () => { register.mutate(undefined, { onSuccess: () => setActive(true) }); };

  return <GuardianShell current="Protect" title="Protect a Position" description="Create a scoped, Move-enforced protection policy in four clear steps.">
    <div className="protect-layout"><SectionCard className="protect-main"><div className="stepper">{labels.map((label, i) => <button key={label} className={`${i === step ? "is-active" : ""} ${i < step ? "is-done" : ""}`} onClick={() => setStep(i)}><span>{i < step ? <Check size={14}/> : i + 1}</span><b>{label}</b></button>)}</div>
      <div className="wizard-body">
        {step === 0 && <><CardTitle title="Select Scallop position" sub="Choose the obligation this policy is allowed to protect."/>
          {!owner ? <div className="explain-box"><WalletCards size={20}/><p>Connect your wallet to load your Scallop obligations.</p></div>
            : positions.length === 0 ? <div className="explain-box"><Database size={20}/><p>{scallop.isLoading ? "Loading obligations…" : "No Scallop obligations found for this wallet."}</p></div>
            : <div className="select-position-list">{positions.map((p, i) => <button key={p.obligationId} className={i === selectedIdx ? "is-selected" : ""} onClick={() => setSelectedIdx(i)}><ShieldCheck size={21}/><span><b>Obligation {i + 1}</b><small>{shortId(p.obligationId, 8, 6)}</small></span><em>{Math.round((p.scallopRiskLevel || 0) * 100)}% risk</em><i/></button>)}</div>}</>}
        {step === 1 && <><CardTitle title="Deposit emergency reserve" sub="Unused funds remain withdrawable by you." icon={<Coins size={20}/>}/><div className="reserve-form"><label>Reserve asset<div className="segment">{["USDC", "SUI"].map(x => <button key={x} className={asset === x ? "is-active" : ""} onClick={() => setAsset(x)}>{x}</button>)}</div></label><label>Amount<div className="amount-field"><input value={amount} onChange={e => setAmount(e.target.value)}/><span>{asset}</span></div></label></div><div className="explain-box"><LockKeyhole size={20}/><p>This reserve is only used for emergency Scallop repay or collateral top-up actions. Unused funds can be withdrawn by you.</p></div></>}
        {step === 2 && <><CardTitle title="Set Guardian rules" sub="Define when LiquiFi may act and how much it can use."/><div className="rule-grid"><RangeRule label="Trigger Risk Level" value={trigger} onChange={setTrigger} suffix="%"/><RangeRule label="Target Risk Level" value={target} onChange={setTarget} suffix="%"/><label className="rule-field"><span>Max Per Action</span><div className="amount-field"><input value={maxAction} onChange={e => setMaxAction(e.target.value)}/><span>{asset}</span></div></label><Field label="Window Limit" value={`${amount} ${asset} / 24h`}/><Field label="Expiry" value="7 days"/></div><div className="allowed-actions"><b>Allowed Actions</b><label><input type="checkbox" defaultChecked/>Partial repay</label><label><input type="checkbox" defaultChecked/>Collateral top-up</label><label className="disabled"><input type="checkbox" disabled/>Swap then repay <Status>Coming soon</Status></label></div></>}
        {step === 3 && !active && <><CardTitle title="Review & Activate" sub="Read the policy in plain English before signing."/><div className="policy-preview"><ShieldCheck size={28}/><p>LiquiFi Guardian can use up to <b>{maxAction} {asset} per action</b> from your emergency vault to protect Scallop obligation <code>{selected ? shortId(selected.obligationId) : "—"}</code> if risk crosses <b>{trigger}%</b>.</p></div><div className="can-cannot"><div><h3><CheckCircle2 size={18}/>The agent can</h3><p>Repay or top up only this obligation</p><p>Act before policy expiry</p><p>Act within your budget limits</p></div><div><h3><X size={18}/>The agent cannot</h3><p>Withdraw funds to itself</p><p>Borrow or withdraw collateral</p><p>Exceed limits or act after revoke</p></div></div>{register.isError && <div className="explain-box" style={{ borderColor: "#f5a3a3" }}><AlertTriangle size={20}/><p>{String(register.error?.message)}</p></div>}</>}
        {step === 3 && active && <div className="activation-success"><span><Check size={32}/></span><h2>Protection Registered</h2><p>LiquiFi re-synced your on-chain protection records. {register.data?.refreshed ?? 0} position(s) refreshed.</p><div>{(register.data?.positions ?? []).slice(0, 3).map(p => <code key={p.id}>Obligation: {shortId(p.obligation_id)}</code>)}</div></div>}
      </div><div className="wizard-foot"><button className="gs-secondary" onClick={() => setStep(s => Math.max(0, s - 1))}>Back</button>{step < 3 ? <button className="gs-primary" onClick={() => setStep(s => s + 1)}>Continue <ArrowRight size={16}/></button> : !active ? <button className="gs-primary" disabled={register.isPending} onClick={onActivate}><ShieldCheck size={16}/>{register.isPending ? "Activating…" : "Activate Guardian"}</button> : <Link className="gs-primary" href="/dashboard">Return to Dashboard</Link>}</div>
    </SectionCard><SectionCard className="policy-side"><span className="policy-side-icon"><ShieldCheck size={34}/></span><h2>Policy Summary</h2><div><span>Obligation</span><code>{selected ? shortId(selected.obligationId) : "—"}</code></div><div><span>Reserve</span><b>{amount} {asset}</b></div><div><span>Trigger / target</span><b>{trigger}% / {target}%</b></div><div><span>Max action</span><b>{maxAction} {asset}</b></div><div><span>Allowed</span><b>Repay + top-up</b></div><hr/><p><LockKeyhole size={15}/>Funds remain owner-controlled.</p></SectionCard></div>
  </GuardianShell>;
}

function RangeRule({ label, value, onChange, suffix }: { label: string; value: number; onChange: (v: number) => void; suffix: string }) { return <label className="range-rule"><span>{label}<b>{value}{suffix}</b></span><input type="range" min="50" max="95" value={value} onChange={e => onChange(Number(e.target.value))}/></label>; }
function Field({ label, value }: { label: string; value: string }) { return <label className="rule-field"><span>{label}</span><button>{value}<SlidersHorizontal size={14}/></button></label>; }

// ── Simulate ─────────────────────────────────────────────────────────────────

const RESCUE_STEPS: { key: string; label: string; hint: string }[] = [
  { key: "resolve_obligation", label: "Resolve obligation", hint: "Locate the registered position" },
  { key: "ensure_coins", label: "Ensure agent coins", hint: "Check / convert gas coins" },
  { key: "apply_stress", label: "Apply market stress", hint: "Cross the risk trigger" },
  { key: "submit_snapshot", label: "Submit fresh snapshot", hint: "On-chain risk attestation" },
  { key: "simulate_ptb", label: "Simulate rescue PTB", hint: "Dry-run before signing" },
  { key: "execute_ptb", label: "Execute rescue PTB", hint: "Sign & submit with agent key" },
];

export function SimulateSection() {
  const { data: dash } = useDashboard();
  const { data: actionsData } = useActions(20);
  const rescue = useSimulateRescue();
  const trigger = useTriggerAgent();
  const override = useOverride();
  const positions = dash?.positions ?? [];
  const [positionId, setPositionId] = useState<string>("");
  const activeId = positionId || positions[0]?.id || "";

  // Optimistic progress so the user watches the PTB flow advance while the
  // synchronous request runs; replaced by the real step results on completion.
  const [progressIdx, setProgressIdx] = useState(0);
  useEffect(() => {
    if (!rescue.isPending) return;
    setProgressIdx(0);
    const t = setInterval(() => setProgressIdx(i => Math.min(i + 1, RESCUE_STEPS.length - 1)), 1400);
    return () => clearInterval(t);
  }, [rescue.isPending]);

  const result = rescue.data;
  const lastAction = actionsData?.actions?.find(a => !activeId || a.position_id === activeId) ?? actionsData?.actions?.[0];
  const latestScore = dash?.risk_scores?.find(s => s.position_id === activeId);
  const riskNow = latestScore?.risk_score ?? null;

  const txDigest = result?.tx_digest ?? (rescue.isSuccess ? null : lastAction?.tx_digest) ?? null;
  const explorerUrl = result?.explorer_url ?? (txDigest ? `${SUI_EXPLORER}${txDigest}` : null);
  const riskBefore = result?.risk_before ?? lastAction?.risk_before ?? riskNow ?? null;
  const riskAfter = result?.risk_after ?? lastAction?.risk_after ?? null;
  const executed = Boolean(result?.ok ?? (lastAction?.status === "executed"));

  // Step states: real results when available, else optimistic progress while pending.
  const stepState = (key: string, i: number): "done" | "failed" | "active" | "pending" => {
    if (result) {
      const real = result.steps?.find(s => s.key === key);
      return real ? (real.status === "failed" ? "failed" : "done") : "pending";
    }
    if (rescue.isPending) return i < progressIdx ? "done" : i === progressIdx ? "active" : "pending";
    return "pending";
  };

  return <GuardianShell current="Simulate" title="Testnet Simulation" description="Demonstrate the complete LiquiFi rescue flow with controlled market stress and no mainnet funds.">
    <div className="simulation-banner"><FlaskConical size={22}/><div><b>Testnet Simulation Mode</b><span>No real mainnet funds are used. The agent signs with its own key from the backend.</span></div><Status tone="blue">Sui Testnet</Status></div>
    <div className="simulate-layout"><SectionCard className="sim-control"><CardTitle title="Simulation controls" sub="One click runs the entire rescue: resolve → coins → snapshot → simulate → execute."/>
      <label className="rule-field" style={{ marginBottom: 12 }}><span>Target position</span>
        <select value={activeId} onChange={e => setPositionId(e.target.value)} className="sim-select" disabled={rescue.isPending}>
          {positions.length === 0 && <option value="">Auto-resolve from registry</option>}
          {positions.map(p => <option key={p.id} value={p.id}>{shortId(p.obligation_id || p.id)} · {p.risk_level ?? "?"}</option>)}
        </select>
      </label>
      <button className="gs-primary sim-run" disabled={rescue.isPending} onClick={() => rescue.mutate({ positionId: activeId || undefined })}>
        {rescue.isPending ? <><Loader2 size={16} className="spin"/>Running rescue…</> : <><Play size={16}/>Simulate</>}
      </button>
      <div className="sim-actions" style={{ marginTop: 12 }}>
        <button onClick={() => trigger.mutate()} disabled={trigger.isPending || rescue.isPending}><RefreshCw size={15}/>{trigger.isPending ? "Ticking…" : "Run Agent Tick"}</button>
        <button className={override.isPending ? "is-override" : ""} disabled={override.isPending || rescue.isPending} onClick={() => override.mutate({ action: "pause" })}><Pause size={15}/>DAO Override (Pause)</button>
      </div>
      {rescue.isError && <p className="sim-err">{String(rescue.error?.message)}</p>}
      {result && !result.ok && <p className="sim-err">Rescue blocked: {result.reason ?? "see trace"}</p>}
      {result?.coin && <p className="sim-ok">Agent coins: {((Number(result.coin.total_mist ?? 0)) / 1e9).toFixed(3)} SUI{result.coin.merged ? ` · merged ${result.coin.merged} coins` : ""}</p>}
      {override.data && <p className="sim-ok">Override {override.data.action} → {override.data.status} ({shortId(override.data.digest)})</p>}
    </SectionCard>
      <div className="sim-right"><SectionCard className="wow-card"><CardTitle title="Risk after the rescue" sub="The agent scores and rescues automatically."/><div className="shock-chart">
        <div><span>Before rescue</span><div className="risk-column danger" style={{ height: `${riskBefore ?? 0}%` }}><b>{riskBefore ?? "—"}%</b></div><Status tone="danger">At risk</Status></div>
        <div><span>After rescue</span><div className={`risk-column ${executed ? "safe" : "warning"}`} style={{ height: `${riskAfter ?? 0}%` }}><b>{riskAfter ?? "—"}%</b></div><Status tone={executed ? "safe" : "warning"}>{executed ? `Saved · ${result?.action_type ?? lastAction?.action_type ?? "repay"} ${fmtNum(result?.amount ?? lastAction?.amount)}` : rescue.isPending ? "Working…" : "Monitoring"}</Status></div>
      </div></SectionCard>
      <SectionCard className="trace-card"><CardTitle title="Live execution trace" sub="Each step of the autonomous PTB rescue"/>
        <div className="trace-list">{RESCUE_STEPS.map((s, i) => { const st = stepState(s.key, i); return (
          <div key={s.key} className={st === "done" ? "is-done" : st === "failed" ? "is-failed" : st === "active" ? "is-active" : ""}>
            <span>{st === "done" ? <Check size={13}/> : st === "failed" ? <X size={13}/> : st === "active" ? <Loader2 size={13} className="spin"/> : i + 1}</span>
            <b>{s.label}</b><small>{st === "done" ? "Passed" : st === "failed" ? "Failed" : st === "active" ? "Running…" : s.hint}</small>
          </div>); })}
        </div>
        <footer><code>PTB Digest: {txDigest ? shortId(txDigest) : rescue.isPending ? "pending…" : "—"}</code>{explorerUrl ? <a href={explorerUrl} target="_blank" rel="noreferrer">View on Sui Explorer <ExternalLink size={13}/></a> : <button disabled>View on Sui Explorer <ExternalLink size={13}/></button>}</footer>
      </SectionCard></div>
    </div></GuardianShell>;
}

// ── Activity ─────────────────────────────────────────────────────────────────

const FILTERS = ["All", "Risk Updates", "PTB Executions", "Blocked Actions", "Vault Events"];

export function ActivitySection() {
  const { data: actionsData } = useActions(100);
  const { data: dash } = useDashboard();
  const [filter, setFilter] = useState("All");
  const actions = actionsData?.actions ?? [];

  const rows = useMemo(() => actions.map(a => ({
    time: new Date(a.timestamp).toLocaleTimeString(),
    event: a.action_type ? `${a.action_type === "repay" ? "Repay" : "TopUp"}` : "Action",
    position: shortId(a.position_id || a.id),
    before: a.risk_before != null ? `${a.risk_before}%` : "—",
    action: a.amount != null ? `${a.action_type} ${fmtNum(a.amount)}` : (a.reason ?? "—"),
    after: a.risk_after != null ? `${a.risk_after}%` : "—",
    status: a.status ?? "—",
  })), [actions]);

  const visible = filter === "All" ? rows : rows.filter(r =>
    filter === "Risk Updates" ? true :
    filter === "PTB Executions" ? r.status === "executed" || r.status === "simulated" :
    filter === "Blocked Actions" ? r.status === "blocked" || r.status === "failed" :
    filter === "Vault Events" ? r.event.includes("TopUp") : true);

  const executed = actions.filter(a => a.status === "executed").length;
  const blocked = actions.filter(a => a.status === "blocked" || a.status === "failed").length;
  const verified = actions.filter(a => a.result_verified === 1).length;
  const series = [...actions].reverse().map(a => a.risk_after ?? a.risk_before ?? 0).slice(-12);

  return <GuardianShell current="Activity" title="Guardian Activity" description="Every risk update, policy decision, PTB execution, and vault event in one auditable timeline.">
    <div className="activity-kpis">
      <SectionCard><span>Total actions</span><strong>{actions.length}</strong><MiniLine values={series.length ? series : [0, 0]}/></SectionCard>
      <SectionCard><span>Successful rescues</span><strong>{executed}</strong><Status tone="safe">{executed ? `${verified}/${executed} verified` : "—"}</Status></SectionCard>
      <SectionCard><span>Blocked actions</span><strong>{blocked}</strong><Status tone={blocked ? "warning" : "safe"}>{blocked ? "Policy protected" : "None"}</Status></SectionCard>
      <SectionCard><span>Indexer events</span><strong>{dash?.indexer?.events_total ?? "—"}</strong><Status tone="blue">{dash?.indexer?.running ? "Healthy" : "Idle"}</Status></SectionCard>
    </div>
    <SectionCard className="activity-table-card"><div className="activity-toolbar"><div>{FILTERS.map(x => <button key={x} className={filter === x ? "is-active" : ""} onClick={() => setFilter(x)}>{x}</button>)}</div><button><Search size={15}/>Search events</button></div>
      <div className="activity-table"><table><thead><tr>{["Time", "Event", "Position", "Risk Before", "Action", "Risk After", "Status"].map(x => <th key={x}>{x}</th>)}</tr></thead>
        <tbody>{visible.length === 0 ? <tr><td colSpan={7} style={{ textAlign: "center", padding: 28, opacity: .6 }}>No agent actions recorded yet.</td></tr> : visible.map((row, i) => <tr key={i}>
          <td>{row.time}</td><td>{row.event}</td><td><code>{row.position}</code></td><td>{row.before}</td><td>{row.action}</td><td>{row.after}</td>
          <td><Status tone={row.status === "executed" ? "safe" : row.status === "blocked" || row.status === "failed" ? "danger" : row.status === "simulated" ? "blue" : "neutral"}>{row.status}</Status></td>
        </tr>)}</tbody></table></div></SectionCard>
  </GuardianShell>;
}

// ── Risk engine ──────────────────────────────────────────────────────────────

export function RiskSection() {
  const { data: dash } = useDashboard();
  const scores = dash?.risk_scores ?? [];
  const [activeId, setActiveId] = useState<string>("");
  const selected = scores.find(s => s.position_id === (activeId || scores[0]?.position_id)) ?? scores[0];
  const market = dash?.market_snapshot;
  const reasons = decodeReasonCodes(selected?.reason_codes);
  const score = selected?.risk_score ?? 0;
  const tone = riskTone(selected?.risk_level, score);

  // Weighted contribution per the whitepaper formula (position 40 / volatility 25 / liquidity 20 / oracle 15).
  const factors = [
    { label: "Position Risk", value: 40, code: "LOW_HEALTH_FACTOR", active: reasons.some(r => r.code === "LOW_HEALTH_FACTOR" || r.code === "PRICE_DROP") },
    { label: "Price Volatility", value: 25, code: "HIGH_VOLATILITY", active: reasons.some(r => r.code === "HIGH_VOLATILITY") },
    { label: "DeepBook Liquidity", value: 20, code: "LOW_LIQUIDITY", active: reasons.some(r => r.code === "LOW_LIQUIDITY") },
    { label: "Oracle Freshness", value: 15, code: "STALE_ORACLE", active: reasons.some(r => r.code === "STALE_ORACLE") },
  ];
  const [activeFactor, setActiveFactor] = useState(0);

  return <GuardianShell current="Risk engine" title="Risk Engine" description="A transparent view of why Guardian acts — deterministic scoring, not a black-box chatbot.">
    {scores.length === 0 ? <EmptyState icon={<Search size={34}/>} title="No risk scores yet" hint="The agent writes a deterministic risk score for each protected position on every tick."/> : <>
    <div className="risk-layout">
      <SectionCard className="risk-score-card"><CardTitle title="AI Risk Score" sub={`Position ${shortId(selected?.position_id)}`}/><div className="risk-orb"><span style={{ "--score": `${score}%` } as React.CSSProperties}/><strong>{score}<small>/100</small></strong></div><Status tone={tone}>{selected?.risk_level ?? "—"}</Status><p>Intervention threshold: 85</p>
        {scores.length > 1 && <select className="sim-select" style={{ marginTop: 12 }} value={selected?.position_id} onChange={e => setActiveId(e.target.value)}>{scores.map(s => <option key={s.position_id} value={s.position_id}>{shortId(s.position_id)}</option>)}</select>}
      </SectionCard>
      <SectionCard className="factor-card"><CardTitle title="Risk factors" sub="Weighting from the deterministic engine."/><div className="factor-list">{factors.map((f, i) => <button key={f.code} className={activeFactor === i ? "is-active" : ""} onClick={() => setActiveFactor(i)}><span>{f.label}<b>{f.value}%</b></span><i><em style={{ width: `${f.value * 2}%`, opacity: f.active ? 1 : .35 }}/></i></button>)}</div><div className="factor-reason"><Status tone={factors[activeFactor].active ? "warning" : "safe"}>{factors[activeFactor].code}</Status><p>{factors[activeFactor].active ? "This factor is currently contributing to the risk score." : "This factor is within tolerance."}</p></div></SectionCard>
      <SectionCard className="risk-explain"><CardTitle title="Guardian recommendation" sub="Human-readable action rationale" icon={<Sparkles size={20}/>}/><p>{selected?.reason || "No active risk drivers."}</p><div><Zap size={23}/><span><small>Recommended action</small><b>{selected?.recommended_action || "Monitor"}</b></span></div><Link className="gs-primary" href="/simulate">Open Rescue Simulation <ArrowRight size={15}/></Link></SectionCard>
    </div>
    <SectionCard className="guardrail-card"><CardTitle title="Guardrail status" sub="All required checks before Guardian may submit a PTB."/><div>{[
      ["Agent Authorized", dash?.agent?.running ? "Yes" : "No"],
      ["Indexer Healthy", dash?.indexer?.running ? "Yes" : "No"],
      ["Oracle Fresh", market?.oracle_age_ms != null ? `${Math.round((market.oracle_age_ms) / 1000)}s` : "—"],
      ["DeepBook Liquidity", market?.liquidity_score != null ? "OK" : "—"],
      ["Can Execute", selected?.can_execute ? "Yes" : "No"],
      ["Reason Codes", String(selected?.reason_codes ?? 0)],
    ].map(([a, b]) => <span key={a}><CheckCircle2 size={18}/><small>{a}</small><b>{b}</b></span>)}</div></SectionCard>
    </>}
  </GuardianShell>;
}

// ── Vault ────────────────────────────────────────────────────────────────────

export function VaultSection() {
  const { data: dash } = useDashboard();
  const { data: actionsData } = useActions(20);
  const override = useOverride();
  const positions = dash?.positions ?? [];
  const pos = positions[0];
  const actions = actionsData?.actions ?? [];

  // Sum executed reserve usage in the last 24h.
  const since = Date.now() - 24 * 3600 * 1000;
  const usedToday = actions.filter(a => a.status === "executed" && new Date(a.timestamp).getTime() > since)
    .reduce((s, a) => s + (a.amount ?? 0), 0);
  const balance = pos?.collateral_value ?? 0;

  return <GuardianShell current="Vault" title="Emergency Vault" description="The isolated reserve Guardian can use for capped rescue actions.">
    {!pos ? <EmptyState icon={<WalletCards size={34}/>} title="No vault yet" hint="Register a protection policy to create your emergency reserve vault."/> : <>
    <div className="vault-layout">
      <SectionCard className="vault-hero"><div><span className="vault-icon"><WalletCards size={28}/></span><small>Vault collateral value</small><strong>{fmtNum(balance)}<em>USD</em></strong><p>{pos.vault_id ? `Vault ${shortId(pos.vault_id)}` : "Vault not yet created"}</p></div>
        <div className="vault-ring"><span style={{ "--used": `${balance ? Math.min(100, (usedToday / balance) * 100) : 0}%` } as React.CSSProperties}/><b>{fmtNum(usedToday)}<small>used today</small></b></div>
        <div className="vault-stats"><span><small>Used today</small><b>{fmtNum(usedToday)} USD</b></span><span><small>Debt</small><b>{fmtUsd(pos.debt_value)}</b></span><span><small>Health factor</small><b>{fmtNum(pos.health_factor)}</b></span></div>
      </SectionCard>
      <SectionCard className="vault-actions"><CardTitle title="Manage funds" sub="Deposits and withdrawals are signed by your connected wallet."/>
        <div className="explain-box"><LockKeyhole size={20}/><p>Reserve deposits are owner-signed transactions. Use the onboarding flow to fund or withdraw — Guardian can never move funds to itself.</p></div>
        <button className={pos.status === "paused" ? "resume" : "pause"} disabled={override.isPending} onClick={() => override.mutate({ action: pos.status === "paused" ? "unpause" : "pause" })}>{pos.status === "paused" ? <Play size={15}/> : <Pause size={15}/>} {pos.status === "paused" ? "Resume Guardian" : "Pause Guardian"}</button>
        {override.isError && <p className="sim-err">{String(override.error?.message)}</p>}
      </SectionCard>
    </div>
    <div className="vault-bottom"><SectionCard className="vault-rules"><CardTitle title="Vault rules" sub="Funds can only be used for:" icon={<LockKeyhole size={19}/>}/><div>{["Selected Scallop obligation", "Allowed repay or top-up actions", "Within max per-action limit", "Inside the active time window"].map(x => <span key={x}><Check size={15}/>{x}</span>)}</div></SectionCard>
      <SectionCard className="vault-events"><CardTitle title="Recent vault events" sub="Guardian rescue activity"/><div>{actions.length === 0 ? <p style={{ opacity: .6 }}>No vault activity yet.</p> : actions.slice(0, 5).map(a => <span key={a.id}><i className={a.status === "executed" ? "out" : "in"}>{a.status === "executed" ? <TrendingDown size={15}/> : <TrendingUp size={15}/>}</i><b>{a.action_type ?? a.status}<small>{timeAgo(a.timestamp)}</small></b><em>{a.amount != null ? `−${fmtNum(a.amount)}` : a.status}</em></span>)}</div></SectionCard></div>
    </>}
  </GuardianShell>;
}

// ── Policy ───────────────────────────────────────────────────────────────────

export function PolicySection() {
  const { data: dash } = useDashboard();
  const override = useOverride();
  const positions = dash?.positions ?? [];
  const pos = positions[0];
  const status = pos?.status === "revoked" ? "Revoked" : pos?.status === "paused" ? "Paused" : "Active";

  return <GuardianShell current="Policy" title="Guardian Policy" description="See exactly what LiquiFi can do, for which obligation, and within which limits.">
    {!pos ? <EmptyState icon={<ShieldCheck size={34}/>} title="No active policy" hint="Register a protection policy from the Protect tab to see its Move-enforced limits here."/> : <>
    <div className="policy-layout"><SectionCard className="policy-details"><div className="policy-detail-head"><span><ShieldCheck size={29}/></span><div><small>MOVE-ENFORCED POLICY</small><h2>Scallop Guardian</h2></div><Status tone={status === "Active" ? "safe" : status === "Paused" ? "warning" : "danger"}>{status}</Status></div>
      <div className="policy-detail-grid">{[
        ["Owner", shortId(pos.wallet_address)],
        ["Protected Protocol", pos.protocol ?? "Scallop"],
        ["Protected Obligation", shortId(pos.obligation_id)],
        ["Policy ID", shortId(pos.policy_id)],
        ["Vault ID", shortId(pos.vault_id)],
        ["Snapshot ID", shortId(pos.snapshot_id)],
        ["Collateral", fmtUsd(pos.collateral_value)],
        ["Debt", fmtUsd(pos.debt_value)],
      ].map(([a, b]) => <div key={a}><span>{a}</span><b>{b}</b></div>)}</div></SectionCard>
      <SectionCard className="permission-map"><CardTitle title="Permission boundary" sub="The Guardian cannot move outside this path."/><div className="permission-flow"><span><WalletCards size={22}/><b>Your Vault</b></span><i/><span><ShieldCheck size={22}/><b>Move Policy</b></span><i/><span><Database size={22}/><b>{shortId(pos.obligation_id, 4, 3)}</b></span></div><div className="permission-list"><span><Check size={15}/>Partial repay</span><span><Check size={15}/>Collateral top-up</span><span className="blocked"><X size={15}/>Withdraw to agent</span><span className="blocked"><X size={15}/>Borrow on your behalf</span></div></SectionCard></div>
    <SectionCard className="policy-controls"><div><CardTitle title="Policy controls" sub="DAO pause/revoke executes on-chain via the override cap."/><div className="policy-buttons">
      <button disabled={override.isPending} onClick={() => override.mutate({ action: status === "Paused" ? "unpause" : "pause", policyId: pos.policy_id ?? undefined })}><Pause size={15}/>{status === "Paused" ? "Resume Guardian" : "Pause Guardian"}</button>
      <button disabled><Clock3 size={15}/>Extend Expiry</button>
      <button disabled><SlidersHorizontal size={15}/>Update Limits</button>
      <button className="danger" disabled={override.isPending} onClick={() => override.mutate({ action: "revoke", policyId: pos.policy_id ?? undefined })}><X size={15}/>Revoke Agent</button>
    </div>{override.data && <p className="sim-ok">Override {override.data.action} → {override.data.status} ({shortId(override.data.digest)})</p>}{override.isError && <p className="sim-err">{String(override.error?.message)}</p>}</div>
      <div className="revoke-warning"><AlertTriangle size={23}/><p><b>Revoking stops future protection immediately.</b>Your vault funds remain withdrawable by you.</p></div></SectionCard>
    </>}
  </GuardianShell>;
}
