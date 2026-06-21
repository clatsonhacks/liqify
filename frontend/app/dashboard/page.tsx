"use client";

import Link from "next/link";
import { useMemo } from "react";
import {
  Activity, AlertTriangle, ArrowUpRight, CheckCircle2, ExternalLink, Gauge,
  ShieldCheck, Zap,
} from "lucide-react";
import { GuardianShell, SectionCard, CardTitle, Status } from "../components/GuardianShell";
import {
  fmtNum, fmtUsd, riskTone, shortId, timeAgo,
  useDashboard, useSystemHealth,
} from "../lib/api";

const SUI_EXPLORER = "https://suiscan.xyz/testnet/tx/";

function Bars({ values }: { values: number[] }) {
  const max = Math.max(100, ...values);
  const labels = ["", "", "", "", "", "", ""];
  const recent = values.slice(-7);
  while (recent.length < 7) recent.unshift(0);
  return (
    <div className="bar-row">
      {recent.map((v, i) => (
        <div key={i} className="bar-column">
          <div className={`bar-pill ${v >= 85 ? "is-dark" : v >= 70 ? "is-mid" : "is-ghost"}`} style={{ height: `${Math.max(6, (v / max) * 100)}%` }}>
            {i === recent.length - 1 && v > 0 ? <span>{v}%</span> : null}
          </div>
          <small>{labels[i] || (i === recent.length - 1 ? "now" : "")}</small>
        </div>
      ))}
    </div>
  );
}

export default function DashboardPage() {
  const { data, isLoading } = useDashboard();
  const { data: health } = useSystemHealth();

  const positions = data?.positions ?? [];
  const scores = data?.risk_scores ?? [];
  const actions = data?.recent_actions ?? [];
  const market = data?.market_snapshot;

  const scoreFor = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of scores) m.set(s.position_id, s.risk_score);
    return m;
  }, [scores]);

  const protectedCount = positions.filter(p => p.status === "protected").length;
  const rescues = actions.filter(a => a.status === "executed").length;
  const blocked = actions.filter(a => a.status === "blocked" || a.status === "failed").length;
  const nearLiq = health?.positions_near_liquidation ?? positions.filter(p => (p.health_factor ?? 99) < 1.1).length;

  const stats = [
    { title: "Protected Positions", value: String(protectedCount), note: `${positions.length} tracked`, featured: true },
    { title: "Successful Rescues", value: String(rescues), note: `${health?.failed_ptb_rate_24h ? `${Math.round(health.failed_ptb_rate_24h * 100)}% failed 24h` : "100% clean"}` },
    { title: "Indexed Events", value: String(data?.indexer?.events_total ?? 0), note: data?.indexer?.running ? "Indexer live" : "Indexer idle" },
    { title: "Near Liquidation", value: String(nearLiq), note: nearLiq ? "Needs attention" : "All safe" },
  ];

  const recentScores = [...scores].sort((a, b) => b.risk_score - a.risk_score).slice(0, 8).map(s => s.risk_score);

  return (
    <GuardianShell
      current="Dashboard"
      title="Dashboard"
      description="Monitor, score, and protect your Scallop positions in real time."
    >
      <div className="dash-stat-grid">
        {stats.map((stat) => (
          <article key={stat.title} className={`stat-card ${stat.featured ? "is-featured" : ""}`}>
            <div><h3>{stat.title}</h3><span aria-hidden><ArrowUpRight size={22}/></span></div>
            <strong>{isLoading ? "…" : stat.value}</strong>
            <p>{stat.note}</p>
          </article>
        ))}
      </div>

      <div className="dash-main-grid">
        <SectionCard className="dash-analytics">
          <CardTitle title="Risk distribution" sub="Highest position risk scores (0–100)"/>
          <Bars values={recentScores.length ? recentScores : [0]}/>
        </SectionCard>

        <SectionCard className="dash-health">
          <CardTitle title="System health" sub="Agent & indexer readiness" icon={<Activity size={20}/>}/>
          <ul className="health-list">
            <li><span>Agent</span><Status tone={health?.agent_ok ? "safe" : "danger"}>{health?.agent_ok ? "Live" : "Down"}</Status></li>
            <li><span>Indexer lag</span><Status tone={health?.indexer_lag_unsafe ? "danger" : "safe"}>{health?.indexer_lag_ms != null ? `${Math.round(health.indexer_lag_ms / 1000)}s` : "—"}</Status></li>
            <li><span>Oracle</span><Status tone={health?.oracle_stale ? "warning" : "safe"}>{health?.oracle_age_ms != null ? `${Math.round(health.oracle_age_ms / 1000)}s old` : "—"}</Status></li>
            <li><span>DeepBook</span><Status tone={health?.deepbook_ok ? "safe" : "neutral"}>{health?.deepbook_ok ? "OK" : "—"}</Status></li>
            <li><span>Blocked (24h)</span><Status tone={blocked ? "warning" : "safe"}>{blocked}</Status></li>
          </ul>
          {data && !data.readiness?.ready && (
            <div className="readiness-warn"><AlertTriangle size={15}/> Missing config: {data.readiness?.missing?.join(", ") || "—"}</div>
          )}
        </SectionCard>

        <SectionCard className="dash-positions">
          <CardTitle title="Protected positions" sub="Live health & risk per Scallop obligation"/>
          {positions.length === 0 ? (
            <p className="dash-empty">No positions indexed yet. Connect a wallet and register protection from the <Link href="/protect">Protect</Link> tab.</p>
          ) : (
            <div className="dash-pos-list">
              {positions.map((p) => {
                const sc = scoreFor.get(p.id);
                return (
                  <Link key={p.id} href="/positions" className="dash-pos-row">
                    <span className="dash-pos-icon"><ShieldCheck size={18}/></span>
                    <div className="dash-pos-meta"><b>{shortId(p.obligation_id || p.id)}</b><small>{p.protocol ?? "Scallop"} · {p.collateral_asset ?? "—"}/{p.debt_asset ?? "—"}</small></div>
                    <div className="dash-pos-num"><small>Collateral</small><b>{fmtUsd(p.collateral_value)}</b></div>
                    <div className="dash-pos-num"><small>HF</small><b>{fmtNum(p.health_factor)}</b></div>
                    <Status tone={riskTone(p.risk_level, sc)}>{sc != null ? `${sc}` : (p.risk_level ?? "—")}</Status>
                  </Link>
                );
              })}
            </div>
          )}
        </SectionCard>

        <SectionCard className="dash-actions">
          <CardTitle title="Recent guardian actions" sub="Rescues, blocks & simulations" icon={<Zap size={20}/>}/>
          {actions.length === 0 ? (
            <p className="dash-empty">No agent actions recorded yet.</p>
          ) : (
            <div className="dash-act-list">
              {actions.slice(0, 6).map((a) => (
                <div key={a.id} className="dash-act-row">
                  <span className={`dash-act-dot ${a.status}`}>{a.status === "executed" ? <CheckCircle2 size={15}/> : a.status === "blocked" || a.status === "failed" ? <AlertTriangle size={15}/> : <Gauge size={15}/>}</span>
                  <div><b>{a.action_type ? `${a.action_type} ${fmtNum(a.amount)}` : (a.reason ?? "action")}</b><small>{shortId(a.position_id || a.id)} · {timeAgo(a.timestamp)}</small></div>
                  <div className="dash-act-delta">{a.risk_before != null && a.risk_after != null ? <span>{a.risk_before}% → <b>{a.risk_after}%</b></span> : <Status tone={a.status === "executed" ? "safe" : a.status === "blocked" ? "danger" : "blue"}>{a.status}</Status>}</div>
                  {a.tx_digest ? <a className="dash-act-link" href={`${SUI_EXPLORER}${a.tx_digest}`} target="_blank" rel="noreferrer"><ExternalLink size={14}/></a> : null}
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard className="dash-market">
          <CardTitle title="Market snapshot" sub={market?.asset_pair ?? "Pyth + DeepBook"} icon={<Gauge size={20}/>}/>
          {!market ? <p className="dash-empty">No market data yet.</p> : (
            <div className="dash-market-grid">
              <div><small>Mid price</small><b>{market.mid_price != null ? `$${fmtNum(market.mid_price, 4)}` : "—"}</b></div>
              <div><small>24h change</small><b className={(market.price_change_pct_24h ?? 0) < 0 ? "neg" : "pos"}>{market.price_change_pct_24h != null ? `${fmtNum(market.price_change_pct_24h)}%` : "—"}</b></div>
              <div><small>Liquidity</small><b>{fmtNum(market.liquidity_score)}</b></div>
              <div><small>Oracle age</small><b>{market.oracle_age_ms != null ? `${Math.round(market.oracle_age_ms / 1000)}s` : "—"}</b></div>
            </div>
          )}
        </SectionCard>
      </div>
    </GuardianShell>
  );
}
