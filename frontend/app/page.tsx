"use client";

import { useEffect, useState } from "react";
import type { CSSProperties, FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  Activity, ArrowRight, BarChart3, BrainCircuit, Check, ChevronDown, CircleCheck,
  Database, Gauge, Layers3, LineChart,
  Loader2, LockKeyhole, Network, Paperclip, Search, Send, ShieldCheck, Sparkles,
  Workflow, X, Zap,
} from "lucide-react";
import SeFiGlassShader from "./components/SeFiGlassShader";
import { ShaderComponent } from "./components/ui/waves-shader";

type ProtocolAnswer = {
  request_id: string;
  question: string;
  answer: string;
  confidence: number;
  citations: Array<{ source: string; description: string }>;
  window: { days: number; start: string; end: string };
};

type ProtocolIndexStatus = {
  window_days: number;
  scallop: {
    running: boolean;
    events_total: number;
    sources: Array<{
      key: string;
      history?: {
        start_date?: string | null;
        complete?: boolean;
        oldest_event_at?: string | null;
        events_total?: number;
      } | null;
    }>;
  };
  deepbook: {
    running: boolean;
    history_start_date?: string | null;
    detail_backfill_enabled: boolean;
    storage_bytes?: number;
    max_storage_bytes?: number;
    counts: {
      deepbook_pools: number;
      deepbook_daily_volume: number;
      deepbook_trades: number;
      deepbook_order_updates: number;
    };
  };
};

const formatCompact = (value: number | undefined) => {
  const safe = Number(value || 0);
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(safe >= 10_000_000 ? 0 : 1)}M`;
  if (safe >= 1_000) return `${(safe / 1_000).toFixed(safe >= 10_000 ? 0 : 1)}K`;
  return safe.toLocaleString();
};

const formatDate = (value?: string | null) => {
  if (!value) return "syncing";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "syncing";
  return date.toLocaleDateString("en", { month: "short", day: "numeric" });
};

const SEFI_API_BASE = process.env.NEXT_PUBLIC_SEFI_API_BASE || "http://localhost:3210";

export default function Home() {
  const [activeLayer, setActiveLayer] = useState<"sefi" | "liquifi" | null>(null);
  const [sefiPrompt, setSefiPrompt] = useState("");
  const [sefiAnswers, setSefiAnswers] = useState<ProtocolAnswer[]>([]);
  const [sefiLoading, setSefiLoading] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState("");
  const [sefiError, setSefiError] = useState("");
  const [protocolStatus, setProtocolStatus] = useState<ProtocolIndexStatus | null>(null);
  const sefiOpen = activeLayer === "sefi";
  const liquifiOpen = activeLayer === "liquifi";
  const latestAnswer = sefiAnswers[sefiAnswers.length - 1];
  const scallopHistory = protocolStatus?.scallop.sources.find((source) => source.key === "scallop-mainnet")?.history;
  const deepbookCounts = protocolStatus?.deepbook.counts;
  const graphItems = [
    { label: "Trades", value: deepbookCounts?.deepbook_trades || 0 },
    { label: "Orders", value: deepbookCounts?.deepbook_order_updates || 0 },
    { label: "Daily volume", value: deepbookCounts?.deepbook_daily_volume || 0 },
    { label: "Scallop logs", value: protocolStatus?.scallop.events_total || 0 },
  ];
  const graphMax = Math.max(1, ...graphItems.map((item) => item.value));

  useEffect(() => {
    document.body.style.overflow = activeLayer ? "hidden" : "";
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setActiveLayer(null); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = ""; window.removeEventListener("keydown", onKey); };
  }, [activeLayer]);

  useEffect(() => {
    if (!sefiOpen) return;
    let ignore = false;
    let inFlight = false;
    let statusController: AbortController | null = null;
    const loadStatus = async () => {
      if (inFlight) return;
      inFlight = true;
      statusController = new AbortController();
      const timeout = window.setTimeout(() => statusController?.abort(), 20000);
      try {
        const response = await fetch(`${SEFI_API_BASE}/api/protocol-index/status`, {
          headers: { Accept: "application/json" },
          signal: statusController.signal,
        });
        if (!response.ok) return;
        const payload = await response.json() as ProtocolIndexStatus;
        if (!ignore) setProtocolStatus(payload);
      } catch {
        // Status is a live enhancement; the chat remains usable when it is unavailable.
      } finally {
        window.clearTimeout(timeout);
        inFlight = false;
      }
    };
    loadStatus();
    const timer = window.setInterval(loadStatus, 15000);
    return () => {
      ignore = true;
      statusController?.abort();
      window.clearInterval(timer);
    };
  }, [sefiOpen]);

  const moveLandingLock = (event: ReactPointerEvent<HTMLElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width - .5;
    const y = (event.clientY - bounds.top) / bounds.height - .5;
    event.currentTarget.style.setProperty("--lock-x", `${x * 12}px`);
    event.currentTarget.style.setProperty("--lock-y", `${y * 9}px`);
    event.currentTarget.style.setProperty("--lock-rx", `${y * -2.2}deg`);
    event.currentTarget.style.setProperty("--lock-ry", `${x * 3.2}deg`);
  };

  const resetLandingLock = (event: ReactPointerEvent<HTMLElement>) => {
    event.currentTarget.style.setProperty("--lock-x", "0px");
    event.currentTarget.style.setProperty("--lock-y", "0px");
    event.currentTarget.style.setProperty("--lock-rx", "0deg");
    event.currentTarget.style.setProperty("--lock-ry", "0deg");
  };

  const askProtocolAgent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const question = sefiPrompt.trim();
    if (!question || sefiLoading) return;
    // Smoothly transition into the loading state: empty the composer and surface
    // the in-flight question in the conversation immediately, so the answer stage
    // animates in with a thinking indicator before the response arrives.
    setSefiLoading(true);
    setSefiError("");
    setPendingQuestion(question);
    setSefiPrompt("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 120000);
    try {
      const response = await fetch(`${SEFI_API_BASE}/api/v1/agents/protocol-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        signal: controller.signal,
      });
      const contentType = response.headers.get("content-type") || "";
      const payload = contentType.includes("application/json")
        ? await response.json()
        : { error: { message: await response.text() } };
      if (!response.ok) {
        const rawMessage = payload?.error?.message || "SeFi could not answer that question.";
        const message = response.status >= 500 && rawMessage === "Internal Server Error"
          ? "SeFi backend is unavailable. Start the backend on port 3210 and Cube on port 4100, then try again."
          : rawMessage;
        throw new Error(message);
      }
      setSefiAnswers((current) => [...current.slice(-2), payload as ProtocolAnswer]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "SeFi could not answer that question.";
      setSefiError(
        error instanceof DOMException && error.name === "AbortError"
          ? "SeFi is still working through the indexed data. Try again in a moment after the current query clears."
          : message === "fetch failed"
            ? "SeFi reached the backend, but the agent dependency failed before it could answer."
            : message
      );
      // Restore the question so the user can retry without retyping.
      setSefiPrompt(question);
    } finally {
      window.clearTimeout(timeout);
      setPendingQuestion("");
      setSefiLoading(false);
    }
  };

  // Enter sends the prompt; Shift+Enter inserts a newline.
  const onPromptKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <main className={`perceptionPage ${sefiOpen ? "sefiIsOpen" : ""} ${liquifiOpen ? "liquifiIsOpen" : ""}`}>
      <header className="perceptionHeader">
        <a className="s2Brand" href="#" aria-label="S2 home">s²</a>
        <nav className="perceptionNav" aria-label="Main navigation">
          <a href="#solution">Solution</a><a href="#process">Process</a><a href="#contact">Contact</a><a href="#join">Join</a>
        </nav>
      </header>

      <section className="perceptionHero" aria-labelledby="perception-title" onPointerMove={moveLandingLock} onPointerLeave={resetLandingLock}>
        <div className="landingAmbientShader" aria-hidden="true"><ShaderComponent active={!activeLayer} className="landingShaderAnimation"/><i/><i/><i/><span/><span/></div>
        <div className="productStage">
          <div className="productStageShader" aria-hidden="true"><i/><i/><i/></div>
          <div className="diamondField" aria-hidden="true"><i/><i/><i/><i/><i/></div>
          <div className="portraitReserve" aria-label="Glass LiquiFi lock"><img src="/liquifi-glass-lock-transparent.png" alt="Transparent glass LiquiFi padlock"/></div>
          <h1 id="perception-title" className="splitHeadline productChoices">
            <button type="button" className="productChoice productChoiceLeft" onClick={() => setActiveLayer("sefi")}>
              <span>SeFi</span><small>Power your AI agents with the knowledge of millions of records.</small>
            </button>
            <button type="button" className="productChoice productChoiceRight" onClick={() => setActiveLayer("liquifi")}><span>LiquiFi</span><small>State-of-the-art agent that protects your loans.</small></button>
          </h1>
        </div>
      </section>

      <div className="sefiScrim" aria-hidden="true" onClick={() => setActiveLayer(null)}/>
      <section className="sefiSheet" aria-hidden={!sefiOpen} aria-label="SeFi protocol intelligence layer">
        <div className="sefiBackdrop" aria-hidden="true"><SeFiGlassShader active={sefiOpen}/><div className="sefiGlassVeil"/></div>
        <header className="sefiHeader">
          <button className="sefiBrand" onClick={() => setActiveLayer(null)} aria-label="Close SeFi"><span className="sefiMark"><i/><i/><b/></span><strong>SeFi</strong></button>
          <nav><a href="#sefi-home">Live index</a><a href="#features">Coverage</a><a href="#data">Semantic layer</a><a href="#resources">Ops <ChevronDown size={15}/></a></nav>
          <div className="sefiHeaderActions"><button className="sefiClose" onClick={() => setActiveLayer(null)} aria-label="Close"><X size={19}/></button><a href="#ask">Enter SeFi <ArrowRight size={17}/></a></div>
        </header>

        <div id="sefi-home" className={`sefiHero ${latestAnswer || sefiLoading ? "sefiHeroChat" : ""}`}>
          <div className="sefiHeroCopy">
            <div className="sefiAnnouncement"><Sparkles size={17}/>Live Scallop + DeepBook semantic index</div>
            <h2>Ask the protocols<br/>while the index is <span className="sefiOrb" aria-hidden="true"><i/><b/></span> moving.</h2>
            <p>SeFi answers from the local semantic layer: DeepBook pools, raw trades, order updates, daily volume, and Scallop lending events indexed from the configured history window.</p>
            <div className="sefiLiveStrip" aria-label="Realtime indexed details">
              <article><Database size={16}/><strong>{formatCompact(deepbookCounts?.deepbook_pools)}</strong><span>DeepBook pools</span></article>
              <article><LineChart size={16}/><strong>{formatCompact(deepbookCounts?.deepbook_trades)}</strong><span>raw trades</span></article>
              <article><BarChart3 size={16}/><strong>{formatCompact(deepbookCounts?.deepbook_order_updates)}</strong><span>order updates</span></article>
              <article><Activity size={16}/><strong>{formatDate(scallopHistory?.oldest_event_at)}</strong><span>Scallop oldest</span></article>
            </div>
            <form id="ask" className="sefiAsk" onSubmit={askProtocolAgent}>
              <label htmlFor="sefi-prompt">Ask the indexed Scallop + DeepBook data</label>
              <textarea
                id="sefi-prompt"
                value={sefiPrompt}
                onChange={(event) => setSefiPrompt(event.target.value)}
                onKeyDown={onPromptKeyDown}
                placeholder="Which DeepBook pool has the most order updates, or how many Scallop borrows are indexed?"
                maxLength={2000}
              />
              <div><span><button type="button" aria-label="Attach"><Paperclip size={18}/></button></span><button type="submit" aria-label="Send" disabled={sefiLoading || !sefiPrompt.trim()}>{sefiLoading ? <Loader2 className="sefiSpinner" size={19}/> : <Send size={19}/>}</button></div>
            </form>
          </div>
          {(latestAnswer || sefiError || sefiLoading) && (
            <aside className="sefiAnswerStage" aria-live="polite">
              <div className="sefiGraphPanel">
                <header><span>Index shape</span><em>{protocolStatus?.deepbook.running || protocolStatus?.scallop.running ? "syncing" : "idle"}</em></header>
                <div className="sefiGraphBars">
                  {graphItems.map((item) => (
                    <div key={item.label} style={{ "--bar": `${Math.max(7, (item.value / graphMax) * 100)}%` } as CSSProperties}>
                      <span>{item.label}</span><i/><b>{formatCompact(item.value)}</b>
                    </div>
                  ))}
                </div>
                <footer>
                  <span>Start {formatDate(protocolStatus?.deepbook.history_start_date)}</span>
                  <span>{formatCompact(protocolStatus?.deepbook.storage_bytes)}B stored</span>
                </footer>
              </div>
              <div className="sefiConversation">
                {sefiAnswers.map((item) => (
                  <article className="sefiAnswer" key={item.request_id}>
                    <p className="sefiQuestion">{item.question}</p>
                    <p>{item.answer}</p>
                    <footer>
                      <span>{Math.round(item.confidence * 100)}% confidence</span>
                      <span>Since {formatDate(item.window.start)}</span>
                      {item.citations.slice(0, 4).map((citation) => (
                        <span title={citation.description} key={`${item.request_id}-${citation.source}`}>{citation.source}</span>
                      ))}
                    </footer>
                  </article>
                ))}
                {sefiLoading && (
                  <article className="sefiAnswer sefiAnswerPending">
                    {pendingQuestion && <p className="sefiQuestion">{pendingQuestion}</p>}
                    <p className="sefiThinking"><i/><i/><i/><span>Reading the indexed Scallop + DeepBook data…</span></p>
                  </article>
                )}
                {sefiError && <p className="sefiChatError">{sefiError}</p>}
              </div>
            </aside>
          )}
          <div className="sefiProof"><p>Currently modeled protocols</p><div><strong>DeepBook</strong><i/><strong>Scallop</strong><i/><strong>Cube</strong><i/><strong>Sui GraphQL</strong></div></div>
        </div>

        <div className="sefiLanding">
          <section id="features" className="sefiSection sefiFeatureIntro">
            <div className="sefiSectionCopy">
              <p className="sefiKicker">CURRENT COVERAGE</p>
              <h3>Protocol intelligence grounded in local indexed rows.</h3>
              <p>The page now reflects what is actually indexed: DeepBook pool metadata, daily volume, raw trade/order windows, and Scallop lending activity from the configured package history.</p>
              <a href="#data">Inspect semantic sources <ArrowRight size={16}/></a>
            </div>
            <div className="sefiNetworkCard" aria-label="Connected intelligence visualization">
              <div className="sefiNetworkCore"><span className="sefiMark"><i/><i/><b/></span><strong>SeFi</strong><small>Semantic cube</small></div>
              {["DeepBook pools","Raw trades","Orders","Scallop events","Daily volume","Citations"].map((label,index)=><span className={`sefiNode sefiNode${index+1}`} key={label}><i/>{label}</span>)}
              <svg viewBox="0 0 600 430" aria-hidden="true"><path d="M300 216L125 82M300 216L470 76M300 216L528 215M300 216L466 355M300 216L135 353M300 216L74 216"/></svg>
            </div>
          </section>

          <section className="sefiSection sefiCapabilityGrid" aria-label="SeFi capabilities">
            <article><span><Search size={21}/></span><p>01 / ASK</p><h4>Use normal protocol questions.</h4><small>The agent maps plain English into bounded Cube queries over Scallop and DeepBook models.</small></article>
            <article><span><Network size={21}/></span><p>02 / VERIFY</p><h4>Every answer carries source context.</h4><small>Citations expose the semantic cube or table used, plus the window applied to the query.</small></article>
            <article><span><Workflow size={21}/></span><p>03 / WATCH</p><h4>Index growth is visible on the page.</h4><small>Live widgets show pools, trades, order updates, Scallop progress, and storage growth.</small></article>
          </section>

          <section id="data" className="sefiSection sefiDataSection">
            <div className="sefiDataVisual">
              <div className="sefiQueryLine"><span>query</span><code>DeepBook order flow vs Scallop borrows</code><i/></div>
              <div className="sefiResultStack"><article><Database size={16}/><span><b>{formatCompact(deepbookCounts?.deepbook_order_updates)}</b><small>order updates</small></span><em>raw</em></article><article><Layers3 size={16}/><span><b>{formatCompact(deepbookCounts?.deepbook_trades)}</b><small>trades indexed</small></span><em>live</em></article><article><CircleCheck size={16}/><span><b>{formatCompact(protocolStatus?.scallop.events_total)}</b><small>Scallop events</small></span><em>cited</em></article></div>
            </div>
            <div className="sefiSectionCopy"><p className="sefiKicker">BUILT FOR TRUST</p><h3>Answers only from indexed evidence.</h3><p>If the semantic layer does not have the row, pool, package, or time range, the agent should say the data is not available rather than filling the gap.</p><ul><li><Check size={15}/>Cube semantic query first</li><li><Check size={15}/>Rolling and explicit time windows</li><li><Check size={15}/>Visible citation trail</li></ul></div>
          </section>

          <section className="sefiSection sefiStats"><div><strong>{formatCompact(deepbookCounts?.deepbook_pools)}</strong><span>DeepBook pools</span></div><div><strong>{formatCompact(deepbookCounts?.deepbook_trades)}</strong><span>raw trades</span></div><div><strong>{formatCompact(deepbookCounts?.deepbook_order_updates)}</strong><span>order updates</span></div><div><strong>{formatDate(scallopHistory?.oldest_event_at)}</strong><span>Scallop backfill</span></div></section>

          <section id="resources" className="sefiSection sefiFinalCta"><span className="sefiOrb" aria-hidden="true"><i/><b/></span><p className="sefiKicker">QUERY THE LIVE BACKFILL</p><h3>Ask what the index knows.<br/>See the evidence immediately.</h3><p>Use SeFi for grounded questions about DeepBook pools and Scallop lending events while the Jan 1 raw backfill continues.</p><a href="#ask">Ask the index <ArrowRight size={17}/></a></section>
          <footer className="sefiFooter"><strong>SeFi</strong><span>Local semantic intelligence for Scallop and DeepBook.</span><small>© 2026 S² Labs</small></footer>
        </div>
      </section>

      <section className="liquifiSheet" aria-hidden={!liquifiOpen} aria-label="LiquiFi protection layer">
        <div className="liquifiAurora" aria-hidden="true"><i/><i/></div>
        <header className="liquifiNav">
          <button className="liquifiBrand" type="button" onClick={() => setActiveLayer(null)} aria-label="Close LiquiFi">
            <span><img src="/liquifi-lock-cutout.png" alt=""/></span><strong>LiquiFi</strong>
          </button>
          <nav aria-label="LiquiFi navigation"><a href="#liquifi-about">About</a><a href="#liquifi-security">Security</a><a href="#liquifi-docs">Docs</a></nav>
          <button className="liquifiClose" type="button" onClick={() => setActiveLayer(null)} aria-label="Close LiquiFi"><X size={18}/></button>
        </header>

        <div className="liquifiHeroStage">
          <div className="liquifiHero">
            <div className="liquifiLock"><span aria-hidden="true"/><img src="/liquifi-lock-cutout.png" alt="Blue crystal Sui padlock"/></div>
            <p className="liquifiEyebrow">AUTONOMOUS POSITION PROTECTION</p>
            <h2>Protection That Adapts to Risk.</h2>
            <p className="liquifiCopy">LiquiFi watches every position, understands changing liquidation risk, and coordinates capped rescue actions before thresholds break.</p>
            <div className="liquifiActions"><a href="/dashboard">Open Dashboard <ArrowRight size={16}/></a><a href="/simulate">Try Demo</a></div>
          </div>
          <div className="liquifiColumns" aria-hidden="true">
            {[54,47,39,31,23,16,10,7,10,16,23,31,39,47,54].map((height, index) => <i key={index} style={{"--bar-height": `${height}vh`, "--bar-delay": `${Math.abs(index - 7) * -.14}s`} as CSSProperties}/>) }
          </div>
        </div>

        <div className="liquifiLanding">
          <section id="liquifi-about" className="liquifiSection liquifiMonitorSection">
            <div className="liquifiSectionCopy"><p className="liquifiEyebrow">ALWAYS WATCHING</p><h3>Risk changes every block.<br/>Your protection should too.</h3><p>LiquiFi continuously models position health against price movement, utilization, volatility, and protocol conditions—then prepares the safest eligible response.</p><a href="/dashboard">View live positions <ArrowRight size={16}/></a></div>
            <div className="liquifiMonitorCard">
              <header><span><Activity size={17}/>Position monitor</span><em>LIVE</em></header>
              <div className="liquifiGauge"><div><strong>1.12</strong><small>Health factor</small></div></div>
              <div className="liquifiSignal"><span>Liquidation threshold</span><b>1.00</b><i><u/></i></div>
              <footer><span><i/>Protected</span><small>Updated 2s ago</small></footer>
            </div>
          </section>

          <section className="liquifiSection liquifiFeatureGrid" aria-label="LiquiFi capabilities">
            <article><span><Gauge size={21}/></span><p>RISK ENGINE</p><h4>See pressure before it becomes danger.</h4><small>Real-time health scoring interprets more than a single liquidation threshold.</small></article>
            <article><span><Zap size={21}/></span><p>PTB RESCUE</p><h4>Respond in one coordinated action.</h4><small>Atomic rescue flows reduce execution risk when every block matters.</small></article>
            <article><span><LockKeyhole size={21}/></span><p>CAPPED VAULT</p><h4>Protection without open-ended custody.</h4><small>You choose the reserve, policy, and exact boundaries LiquiFi may use.</small></article>
          </section>

          <section id="liquifi-security" className="liquifiSection liquifiHowSection">
            <div className="liquifiSectionHead"><p className="liquifiEyebrow">FROM SIGNAL TO SAFETY</p><h3>Protection in three precise moves.</h3></div>
            <div className="liquifiSteps"><article><b>01</b><span><Activity size={18}/></span><h4>Monitor</h4><p>Track health, market pressure, and policy conditions continuously.</p></article><article><b>02</b><span><BrainCircuit size={18}/></span><h4>Simulate</h4><p>Evaluate eligible rescue paths before a threshold is crossed.</p></article><article><b>03</b><span><ShieldCheck size={18}/></span><h4>Protect</h4><p>Execute the approved capped response and verify the new position state.</p></article></div>
          </section>

          <section className="liquifiSection liquifiPolicySection">
            <div className="liquifiPolicyCard"><header><ShieldCheck size={18}/><span>Protection policy</span><em>ACTIVE</em></header><div><p>Trigger below</p><strong>1.12 HF</strong></div><div><p>Maximum rescue</p><strong>120 USDC</strong></div><div><p>Execution mode</p><strong>Auto-rescue</strong></div><footer><CircleCheck size={15}/>Policy verified on-chain</footer></div>
            <div className="liquifiSectionCopy"><p className="liquifiEyebrow">CONTROL STAYS WITH YOU</p><h3>Automation with visible boundaries.</h3><p>Every protection policy is explicit, inspectable, and capped. LiquiFi can act quickly because you have already defined what safe action means.</p><ul><li><Check size={15}/>Non-custodial by design</li><li><Check size={15}/>User-defined rescue limits</li><li><Check size={15}/>Full execution history</li></ul></div>
          </section>

          <section className="liquifiSection liquifiFinalCta"><div className="liquifiMiniLock"><img src="/liquifi-lock-cutout.png" alt=""/></div><p className="liquifiEyebrow">STAY AHEAD OF LIQUIDATION</p><h3>Your positions deserve<br/>an always-on guardian.</h3><p>Connect a position, set your policy, and let LiquiFi watch the risk while you keep moving.</p><div className="liquifiActions"><a href="/dashboard">Open Dashboard <ArrowRight size={16}/></a><a href="/simulate">Run Simulation</a></div></section>
          <footer className="liquifiFooter"><strong>LiquiFi</strong><span>Autonomous protection for Sui liquidity.</span><small>© 2026 S² Labs</small></footer>
        </div>
      </section>
    </main>
  );
}
