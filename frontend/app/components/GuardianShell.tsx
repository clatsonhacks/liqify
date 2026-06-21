"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import {
  Activity, FileKey2, FlaskConical, Grid2X2, Layers3, LogOut, Search,
  Settings, ShieldCheck, WalletCards,
} from "lucide-react";
import { useDashboard, useSystemHealth } from "../lib/api";
import { WalletConnect } from "./WalletConnect";

const NAV = [
  { label: "Dashboard", href: "/dashboard", icon: Grid2X2 },
  { label: "Positions", href: "/positions", icon: Layers3 },
  { label: "Protect", href: "/protect", icon: ShieldCheck },
  { label: "Simulate", href: "/simulate", icon: FlaskConical },
  { label: "Activity", href: "/activity", icon: Activity },
  { label: "Risk engine", href: "/risk-engine", icon: Search },
  { label: "Vault", href: "/vault", icon: WalletCards },
  { label: "Policy", href: "/policy", icon: FileKey2 },
];

export type GuardianRoute = typeof NAV[number]["label"];

export function BrandMark() {
  return <span className="gs-brand-mark"><i/><i/></span>;
}

function StatusCard() {
  const { data } = useSystemHealth();
  const agentOk = data?.agent_ok ?? false;
  const indexerOk = data ? !data.indexer_lag_unsafe : false;
  const tone = data?.ok ? "safe" : agentOk || indexerOk ? "warning" : "danger";
  return (
    <section className="gs-download-card" aria-label="System status">
      <span><ShieldCheck size={15}/></span>
      <h3>Guardian Status</h3>
      <p className={`gs-status ${tone}`} style={{ marginTop: 6 }}>
        {data ? (data.ok ? "All systems healthy" : "Degraded") : "Connecting…"}
      </p>
      <div className="gs-status-mini">
        <span>Agent <b className={agentOk ? "ok" : "bad"}>{agentOk ? "live" : "down"}</b></span>
        <span>Indexer <b className={indexerOk ? "ok" : "bad"}>{indexerOk ? "synced" : "lag"}</b></span>
        <span>Events <b>{data?.events_total ?? "—"}</b></span>
      </div>
    </section>
  );
}

export function GuardianShell({ current, title, description, children, action }: { current: GuardianRoute; title: string; description: string; children: ReactNode; action?: ReactNode }) {
  const { data } = useDashboard();
  const positionCount = data?.positions?.length ?? 0;
  return (
    <main className="gs-page">
      <div className="gs-frame">
        <aside className="gs-sidebar">
          <Link href="/" className="gs-brand"><BrandMark/><strong>LiquiFi</strong></Link>
          <nav className="gs-menu" aria-label="Dashboard menu">
            <p>MENU</p>
            {NAV.slice(0, 5).map(({ label, href, icon: Icon }) => (
              <Link key={label} href={href} className={`gs-menu-link ${current === label ? "is-active" : ""}`}>
                <Icon size={22} strokeWidth={1.75}/><span>{label}</span>{label === "Positions" && positionCount ? <b>{positionCount}</b> : null}
              </Link>
            ))}
          </nav>
          <nav className="gs-menu gs-general" aria-label="General dashboard menu">
            <p>GENERAL</p>
            {NAV.slice(5).map(({ label, href, icon: Icon }) => (
              <Link key={label} href={href} className={`gs-menu-link ${current === label ? "is-active" : ""}`}>
                <Icon size={22} strokeWidth={1.75}/><span>{label}</span>
              </Link>
            ))}
            <Link href="/policy" className="gs-menu-link"><Settings size={22} strokeWidth={1.75}/><span>Settings</span></Link>
            <Link href="/" className="gs-menu-link"><LogOut size={22} strokeWidth={1.75}/><span>Exit</span></Link>
          </nav>
          <StatusCard/>
        </aside>

        <section className="gs-main">
          <header className="gs-topbar">
            <div className="gs-topbar-net"><span className="gs-net-dot"/>Sui Testnet</div>
            <div className="gs-topbar-actions">
              <WalletConnect/>
            </div>
          </header>
          <div className="gs-workspace">
            <div className="gs-page-head">
              <div><h1>{title}</h1><p>{description}</p></div>
              <div className="gs-head-actions">{action}</div>
            </div>
            <div className="gs-content">
              {children}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

export function SectionCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <article className={`gs-card ${className}`}>{children}</article>;
}

export function CardTitle({ title, sub, icon }: { title: string; sub?: string; icon?: ReactNode }) {
  return <div className="gs-card-title">{icon ? <span>{icon}</span> : null}<div><h2>{title}</h2>{sub ? <p>{sub}</p> : null}</div></div>;
}

export function Status({ children, tone = "neutral" }: { children: ReactNode; tone?: "safe" | "warning" | "danger" | "blue" | "neutral" }) {
  return <span className={`gs-status ${tone}`}>{children}</span>;
}
