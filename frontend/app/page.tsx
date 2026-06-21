"use client";

import { useEffect, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import {
  Activity, ArrowRight, BrainCircuit, Check, ChevronDown, CircleCheck,
  Code2, Database, FileText, Gauge, Globe2, GraduationCap, Layers3,
  LockKeyhole, Network, Paperclip, Search, Send, ShieldCheck, Sparkles,
  Workflow, X, Zap,
} from "lucide-react";
import SeFiGlassShader from "./components/SeFiGlassShader";
import { ShaderComponent } from "./components/ui/waves-shader";

export default function Home() {
  const [activeLayer, setActiveLayer] = useState<"sefi" | "liquifi" | null>(null);
  const sefiOpen = activeLayer === "sefi";
  const liquifiOpen = activeLayer === "liquifi";

  useEffect(() => {
    document.body.style.overflow = activeLayer ? "hidden" : "";
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setActiveLayer(null); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = ""; window.removeEventListener("keydown", onKey); };
  }, [activeLayer]);

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
      <section className="sefiSheet" aria-hidden={!sefiOpen} aria-label="SeFi intelligence layer">
        <div className="sefiBackdrop" aria-hidden="true"><SeFiGlassShader active={sefiOpen}/><div className="sefiGlassVeil"/></div>
        <header className="sefiHeader">
          <button className="sefiBrand" onClick={() => setActiveLayer(null)} aria-label="Close SeFi"><span className="sefiMark"><i/><i/><b/></span><strong>SeFi</strong></button>
          <nav><a href="#sefi-home">Home</a><a href="#features">Features</a><a href="#data">Data Layer</a><a href="#resources">Resources <ChevronDown size={15}/></a></nav>
          <div className="sefiHeaderActions"><button className="sefiClose" onClick={() => setActiveLayer(null)} aria-label="Close"><X size={19}/></button><a href="#ask">Enter SeFi <ArrowRight size={17}/></a></div>
        </header>

        <div className="sefiHero">
          <div className="sefiAnnouncement"><Sparkles size={17}/>Experience verified intelligence for autonomous agents</div>
          <h2>Build, reason, and act<br/>with <span className="sefiOrb" aria-hidden="true"><i/><b/></span> trusted data.</h2>
          <p>Ask across markets, protocols, governance, and on-chain activity. SeFi turns millions of records into clear, attributable intelligence your agents can use.</p>
          <div className="sefiModes"><button><BrainCircuit size={17}/>Brainstorm</button><button><Code2 size={17}/>Code</button><button><FileText size={17}/>Research</button><button><GraduationCap size={17}/>Advice</button><button>More</button></div>
          <form id="ask" className="sefiAsk" onSubmit={(event) => event.preventDefault()}>
            <label htmlFor="sefi-prompt">Ask anything</label><textarea id="sefi-prompt" placeholder="What is changing across Sui liquidity markets?"/>
            <div><span><button type="button" aria-label="Attach"><Paperclip size={18}/></button><button type="button" aria-label="Browse sources"><Globe2 size={18}/></button></span><button type="submit" aria-label="Send"><Send size={19}/></button></div>
          </form>
          <div className="sefiProof"><p>Intelligence across the Sui ecosystem</p><div><strong>Scallop</strong><i/><strong>Suilend</strong><i/><strong>DeepBook</strong><i/><strong>Walrus</strong><i/><strong>Pyth</strong></div></div>
        </div>

        <div className="sefiLanding">
          <section id="features" className="sefiSection sefiFeatureIntro">
            <div className="sefiSectionCopy">
              <p className="sefiKicker">ONE INTELLIGENCE LAYER</p>
              <h3>Every signal your agents need. Already connected.</h3>
              <p>SeFi resolves fragmented market activity into one queryable knowledge layer—fresh, attributable, and structured for autonomous decisions.</p>
              <a href="#data">Explore the data layer <ArrowRight size={16}/></a>
            </div>
            <div className="sefiNetworkCard" aria-label="Connected intelligence visualization">
              <div className="sefiNetworkCore"><span className="sefiMark"><i/><i/><b/></span><strong>SeFi</strong><small>Knowledge graph</small></div>
              {["Markets","Protocols","Governance","Research","On-chain","Risk"].map((label,index)=><span className={`sefiNode sefiNode${index+1}`} key={label}><i/>{label}</span>)}
              <svg viewBox="0 0 600 430" aria-hidden="true"><path d="M300 216L125 82M300 216L470 76M300 216L528 215M300 216L466 355M300 216L135 353M300 216L74 216"/></svg>
            </div>
          </section>

          <section className="sefiSection sefiCapabilityGrid" aria-label="SeFi capabilities">
            <article><span><Search size={21}/></span><p>01 / DISCOVER</p><h4>Ask across millions of records.</h4><small>Natural-language discovery across protocols, markets, governance, and verified research.</small></article>
            <article><span><Network size={21}/></span><p>02 / CONNECT</p><h4>See the context behind every move.</h4><small>Relationships, timelines, entities, and provenance arrive together—not as disconnected rows.</small></article>
            <article><span><Workflow size={21}/></span><p>03 / ACT</p><h4>Ship intelligence into any agent.</h4><small>Consistent, structured outputs designed for tools, workflows, copilots, and autonomous systems.</small></article>
          </section>

          <section id="data" className="sefiSection sefiDataSection">
            <div className="sefiDataVisual">
              <div className="sefiQueryLine"><span>query</span><code>liquidity shifts on Sui</code><i/></div>
              <div className="sefiResultStack"><article><Database size={16}/><span><b>42,806</b><small>records resolved</small></span><em>0.18s</em></article><article><Layers3 size={16}/><span><b>18</b><small>sources connected</small></span><em>live</em></article><article><CircleCheck size={16}/><span><b>100%</b><small>attributable output</small></span><em>verified</em></article></div>
            </div>
            <div className="sefiSectionCopy"><p className="sefiKicker">BUILT FOR TRUST</p><h3>Answers your agents can inspect.</h3><p>Every response carries its source trail. Your system can reason quickly without giving up the ability to verify what it knows.</p><ul><li><Check size={15}/>Source-level attribution</li><li><Check size={15}/>Continuously refreshed context</li><li><Check size={15}/>Agent-ready structured responses</li></ul></div>
          </section>

          <section className="sefiSection sefiStats"><div><strong>18M+</strong><span>indexed records</span></div><div><strong>99.9%</strong><span>data availability</span></div><div><strong>&lt;200ms</strong><span>retrieval latency</span></div><div><strong>24/7</strong><span>continuous updates</span></div></section>

          <section id="resources" className="sefiSection sefiFinalCta"><span className="sefiOrb" aria-hidden="true"><i/><b/></span><p className="sefiKicker">YOUR AGENTS, BETTER INFORMED</p><h3>Start with a question.<br/>Build from trusted answers.</h3><p>Connect your first agent to the intelligence layer powering the next generation of on-chain products.</p><a href="#ask">Enter SeFi <ArrowRight size={17}/></a></section>
          <footer className="sefiFooter"><strong>SeFi</strong><span>Verified intelligence for autonomous systems.</span><small>© 2026 S² Labs</small></footer>
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
