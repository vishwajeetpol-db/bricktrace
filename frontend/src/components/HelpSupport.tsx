import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  HelpCircle, X, Search, ChevronDown, Rocket, Network, GitBranchPlus, Waypoints,
  ShieldCheck, FileBarChart, BookOpen, Download, Radio, ShieldAlert, Bell,
  Settings as SettingsIcon, Command, Lock, LifeBuoy, Wrench,
} from "lucide-react";

/**
 * Help & Support — a single, app-wide reference drawer opened from the header
 * Help button. Content is data-driven (searchable topics rendered as an
 * accordion) so it stays easy to extend. Each topic carries a detailed
 * explanation, a numbered "Try it" walkthrough, and — where a flow is worth
 * seeing — an animated diagram in the same style as the pitch deck. Pure
 * frontend, no backend call.
 */

interface Topic {
  id: string;
  title: string;
  icon: typeof Network;
  keywords: string;   // extra search terms beyond the title (bodies are JSX)
  body: ReactNode;
}

/* ---------- compact body helpers ---------- */
function P({ children }: { children: ReactNode }) {
  return <p className="text-[13px] leading-relaxed text-slate-300 mb-2.5">{children}</p>;
}
function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-1.5 mb-1">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2 text-[13px] leading-snug text-slate-400">
          <span className="mt-[7px] w-1 h-1 rounded-full bg-accent shrink-0" />
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}
function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="mt-1.5 space-y-2">
      {items.map((s, i) => (
        <li key={i} className="flex gap-2.5 text-[13px] leading-snug text-slate-300">
          <span className="flex items-center justify-center w-5 h-5 rounded-full bg-accent/15 text-accent text-[11px] font-semibold shrink-0 mt-px">{i + 1}</span>
          <span>{s}</span>
        </li>
      ))}
    </ol>
  );
}
function SubH({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500 mt-4 mb-1.5">{children}</div>;
}
function K({ children }: { children: ReactNode }) {
  return <kbd className="font-mono text-[11px] px-1.5 py-0.5 rounded border border-white/15 bg-white/[0.05] text-slate-300">{children}</kbd>;
}
function B({ children }: { children: ReactNode }) {
  return <b className="text-slate-200 font-semibold">{children}</b>;
}
function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[11.5px] text-slate-300">{children}</span>;
}
function Tag({ kind, children }: { kind: "det" | "declared" | "ai"; children: ReactNode }) {
  const c = kind === "ai" ? "text-violet-300 border-violet-400/60"
    : kind === "declared" ? "text-sky-300 border-sky-400/60"
    : "text-emerald-300 border-emerald-400/60";
  return <span className={`font-mono text-[9.5px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${c} whitespace-nowrap`}>{children}</span>;
}

/* ---------- animated diagram wrapper ---------- */
function Fig({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <figure className="my-3 rounded-xl border border-white/[0.07] bg-black/20 p-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-slate-500 mb-1.5">{caption}</div>
      <svg viewBox="0 0 520 190" className="w-full h-auto text-slate-300" aria-hidden="true">{children}</svg>
    </figure>
  );
}
// reusable node + spark bits (className-driven so the <style> block styles them)
function Spark({ path, dur, begin = "0s", cls = "" }: { path: string; dur: string; begin?: string; cls?: string }) {
  return (
    <circle r="4.5" className={`hspark ${cls}`}>
      <animateMotion dur={dur} begin={begin} repeatCount="indefinite"><mpath href={`#${path}`} /></animateMotion>
    </circle>
  );
}

const TOPICS: Topic[] = [
  {
    id: "start",
    title: "Getting started",
    icon: Rocket,
    keywords: "overview intro what is bricktrace begin quick start unity catalog trace how to use",
    body: (
      <>
        <P>BrickTrace turns Unity Catalog’s system tables into an interactive lineage graph — showing not just <B>where</B> your data flows, but <B>how</B> each column was built, <B>why</B> it broke, and <B>what breaks</B> when you change it. It reads <B>metadata only</B> — never your table rows.</P>
        <Fig caption="pick a table → auto-trace the whole cone">
          <path id="gs1" className="hflow" d="M60 95 C130 95 130 55 200 55" markerEnd="url(#ah-a)" />
          <path id="gs2" className="hflow" d="M60 95 C130 95 130 135 200 135" markerEnd="url(#ah-a)" />
          <path id="gs3" className="hflow" d="M320 95 C390 95 390 55 456 55" markerEnd="url(#ah-a)" />
          <path id="gs4" className="hflow" d="M320 95 C390 95 390 135 456 135" markerEnd="url(#ah-a)" />
          <g className="hnode"><rect x="18" y="78" width="44" height="34" rx="8" /></g>
          <text className="hsub" x="40" y="128" textAnchor="middle">source</text>
          <circle className="hhalo" cx="260" cy="95" r="20" />
          <g className="hhot"><rect x="200" y="73" width="120" height="44" rx="10" /></g>
          <text className="hlbl" x="260" y="92" textAnchor="middle">your table</text>
          <text className="hsub" x="260" y="106" textAnchor="middle">click to trace</text>
          <g className="hnode"><rect x="456" y="38" width="46" height="32" rx="8" /><rect x="456" y="120" width="46" height="32" rx="8" /></g>
          <text className="hsub" x="479" y="90" textAnchor="middle">downstream</text>
          <Spark path="gs1" dur="2.4s" /><Spark path="gs2" dur="2.4s" begin="-1.2s" />
          <Spark path="gs3" dur="2.2s" /><Spark path="gs4" dur="2.2s" begin="-1.1s" />
        </Fig>
        <SubH>Try it</SubH>
        <Steps items={[
          <>Open <B>Search</B> (top bar) or <B>Lineage Explorer</B> and pick any table.</>,
          <>It auto-traces the full upstream→downstream cone across every catalog and schema.</>,
          <>Switch view modes — <B>Tables</B>, <B>Pipelines</B>, or <B>Full</B> — and cap the graph to N hops for a local slice.</>,
          <>Click a <B>column</B> for its reconstructed transformation; click a <B>job/pipeline</B> node for run health and cost.</>,
        ]} />
      </>
    ),
  },
  {
    id: "explorer",
    title: "Lineage Explorer & graph",
    icon: Network,
    keywords: "browse catalog schema table graph reactflow view mode depth business view terms overlay drag zoom search cmd k explain",
    body: (
      <>
        <P>Browse catalogs → schemas → tables, or open schema-wide / catalog-wide lineage from the picker. The trace is built from real <Mono>system.access.table_lineage</Mono> / <Mono>column_lineage</Mono> edges — no name-matching, zero false positives.</P>
        <List items={[
          <>In-graph search with <K>⌘/Ctrl</K>+<K>K</K>; drag to rearrange, reset/fit-view, hover tooltips, orphan highlighting.</>,
          <><B>Business view</B> toggle (top-left) relabels technical types into plain language and hides FQNs/IDs/cost.</>,
          <><B>Data-only vs Data + processing</B> chooses whether to show the jobs/pipelines between datasets — data-only uses precise per-row pairs, not a fabricated mesh.</>,
          <>The <B>Terms</B> overlay paints glossary chips onto tables; the <B>lightbulb</B> gives an AI plain-English walkthrough of exactly what’s on screen.</>,
          <>Cross-catalog and Delta Sharing boundaries render as first-class, expandable nodes.</>,
        ]} />
        <SubH>Try it</SubH>
        <Steps items={[
          <>Pick a table, then use the <B>view mode</B> switch (top of the graph) to move between Tables / Pipelines / Full.</>,
          <>Press <K>⌘/Ctrl</K>+<K>K</K> to jump to any node by name.</>,
          <>Flip <B>Technical ⇄ Business</B> top-left, then try the <B>Terms</B> toggle and the <B>lightbulb</B>.</>,
        ]} />
      </>
    ),
  },
  {
    id: "derive",
    title: "How column lineage is derived (priority)",
    icon: Waypoints,
    keywords: "transformation column expression sql pyspark parse generate regenerate build precedence priority captured plan cdc merge deep analysis llm ai deterministic order choices derive diagnose no transformation logic force rebuild",
    body: (
      <>
        <P>This is the part that makes BrickTrace different. Unity Catalog only records that <Mono>column A depends on column B</Mono>. BrickTrace reconstructs the <B>actual expression</B> — <Mono>cast · sum · CASE · window · CTE · a*b</Mono> — for each column, tagged with a transform category.</P>
        <P>It derives that expression from the <B>most trustworthy source available, in a fixed priority order</B> — deterministic ground truth first, AI only as a last resort. It never guesses when it can read.</P>
        <Fig caption="producer code → precedence engine → column expression">
          <path id="tp1" className="hflow" d="M74 95 H150" markerEnd="url(#ah-a)" />
          <path id="tp2" className="hflow" d="M330 95 H404" markerEnd="url(#ah-a)" />
          <g className="hnode"><rect x="14" y="76" width="60" height="38" rx="9" /></g>
          <text className="hlbl" x="44" y="92" textAnchor="middle">producer</text>
          <text className="hsub" x="44" y="105" textAnchor="middle">code</text>
          {/* precedence gates */}
          <g className="hhot"><rect x="150" y="34" width="180" height="20" rx="6" /></g>
          <text className="hgate" x="160" y="48">1 · captured Spark plan</text>
          <g className="hnode"><rect x="150" y="60" width="180" height="20" rx="6" /></g>
          <text className="hgate" x="160" y="74">2 · CDC / merge spec</text>
          <g className="hnode"><rect x="150" y="110" width="180" height="20" rx="6" /></g>
          <text className="hgate" x="160" y="124">3 · SQL / PySpark parse</text>
          <g className="hnode"><rect x="150" y="136" width="180" height="20" rx="6" /></g>
          <text className="hgate" x="160" y="150">4 · LLM parse (fallback)</text>
          <g className="hnode"><rect x="404" y="74" width="102" height="42" rx="10" /></g>
          <text className="hlbl" x="455" y="90" textAnchor="middle">amount_usd =</text>
          <text className="hsub" x="455" y="104" textAnchor="middle">amount * fx</text>
          <Spark path="tp1" dur="1.8s" /><Spark path="tp2" dur="1.8s" begin="-.9s" />
        </Fig>
        <SubH>The four sources, in priority order</SubH>
        <div className="space-y-2">
          <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-2.5">
            <div className="flex items-center gap-2 mb-0.5"><span className="font-mono text-accent font-bold">1</span><B>Captured Spark plan</B><Tag kind="det">deterministic</Tag></div>
            <div className="text-[12.5px] text-slate-400 leading-snug">The exact analyzed plan Spark actually ran, captured at write time (<Mono>df.explain</Mono>) by the opt-in <B>Runtime Plan Capture</B>. Zero inference — it’s ground truth.</div>
          </div>
          <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-2.5">
            <div className="flex items-center gap-2 mb-0.5"><span className="font-mono text-accent font-bold">2</span><B>CDC / merge spec</B><Tag kind="declared">declared</Tag></div>
            <div className="text-[12.5px] text-slate-400 leading-snug">For <Mono>MERGE</Mono>/CDC writes, the declared column mapping is read verbatim from the operation spec — no parsing needed.</div>
          </div>
          <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-2.5">
            <div className="flex items-center gap-2 mb-0.5"><span className="font-mono text-accent font-bold">3</span><B>SQL / PySpark AST parse</B><Tag kind="det">deterministic</Tag></div>
            <div className="text-[12.5px] text-slate-400 leading-snug">The producing SQL or PySpark is genuinely parsed (<Mono>sqlparse</Mono> / Python AST) to reconstruct each column — resolving CTEs, joins, window functions and chained <Mono>.withColumn</Mono> steps.</div>
          </div>
          <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-2.5">
            <div className="flex items-center gap-2 mb-0.5"><span className="font-mono text-accent font-bold">4</span><B>LLM source parse</B><Tag kind="ai">AI · fallback</Tag></div>
            <div className="text-[12.5px] text-slate-400 leading-snug">Only when nothing above is available, an LLM reads the source and infers the expression. The result is <B>versioned and stale-flagged</B>, so you always know it’s AI-derived.</div>
          </div>
        </div>
        <SubH>Why this order</SubH>
        <P>Higher tiers require <B>less inference</B> and sit closer to what actually executed, so they win. A captured plan is ground truth; an LLM parse is a best-effort fallback. Every result keeps a <B>version ref</B>, so you can diff a captured plan against an AI parse side by side — no black box.</P>
        <SubH>Metadata-driven pipelines (deep analysis)</SubH>
        <P>When a generic, config-driven engine carries no column logic in its code, a separate agentic pass <B>detects the config mechanism</B>, reads the pipeline’s runtime parameters, <B>queries the config table(s)</B>, and derives per-column logic from that config — streaming each step live.</P>
        <SubH>Try it</SubH>
        <Steps items={[
          <>Open a table in the <B>Table Lineage</B> workspace (click a table in the graph).</>,
          <>Open the <B>Column Transformation</B> panel and click a column — you’ll see the expression, its category, and the tier it came from.</>,
          <>No lineage yet? Click <B>Generate</B> (admin) to submit a build; use <B>Regenerate / force rebuild</B> to re-parse after a parser upgrade.</>,
          <>For a config-driven table with no code logic, run <B>Deep analyze</B> to derive columns from config.</>,
          <>Use the <B>History</B> / <B>Producers</B> tabs to compare versions or multiple writers and spot divergence.</>,
          <>If a build makes nothing, read the panel’s <B>diagnostics</B> — it explains why (no producer, outside the discovery window, or source unreadable) with a fix.</>,
        ]} />
      </>
    ),
  },
  {
    id: "impact",
    title: "Impact & Root Cause",
    icon: GitBranchPlus,
    keywords: "blast radius downstream impact analysis root cause failure path run health incident 2am",
    body: (
      <>
        <P>Understand consequences before and after a change.</P>
        <Fig caption="blast radius — everything a change touches">
          <path id="im1" className="hflow" d="M132 95 C200 95 200 45 268 45" markerEnd="url(#ah-a)" />
          <path id="im2" className="hflow" d="M132 95 H268" markerEnd="url(#ah-a)" />
          <path id="im3" className="hflow" d="M132 95 C200 95 200 145 268 145" markerEnd="url(#ah-a)" />
          <path id="im4" className="hflow" d="M330 45 H430" markerEnd="url(#ah-a)" />
          <circle className="hhalo" cx="90" cy="95" r="20" />
          <g className="hhot"><rect x="40" y="76" width="92" height="38" rx="9" /></g>
          <text className="hlbl" x="86" y="92" textAnchor="middle">changed</text>
          <text className="hsub" x="86" y="105" textAnchor="middle">table</text>
          <g className="hnode"><rect x="268" y="28" width="62" height="32" rx="8" /><rect x="268" y="79" width="62" height="32" rx="8" /><rect x="268" y="129" width="62" height="32" rx="8" /></g>
          <text className="hsub" x="299" y="48" textAnchor="middle">dashboard</text>
          <text className="hsub" x="299" y="99" textAnchor="middle">table</text>
          <text className="hsub" x="299" y="149" textAnchor="middle">job</text>
          <g className="hnode"><rect x="430" y="29" width="72" height="32" rx="8" /></g>
          <text className="hsub" x="466" y="49" textAnchor="middle">+ their readers</text>
          <Spark path="im1" dur="2.2s" /><Spark path="im2" dur="2.2s" begin="-.7s" /><Spark path="im3" dur="2.2s" begin="-1.4s" /><Spark path="im4" dur="1.8s" />
        </Fig>
        <List items={[
          <><B>Impact</B> — every downstream table plus the dashboards, jobs and pipelines that read it, grouped by type with deep links.</>,
          <><B>Root Cause</B> — a health-based upstream trace that surfaces the prime suspect and the failure path, so you don’t hand-walk the DAG at 2am.</>,
          <><B>Run health</B> on every job/pipeline node — verdict, success rate, duration trend, per-run cost with a spike flag.</>,
        ]} />
        <SubH>Try it</SubH>
        <Steps items={[
          <>Open a table → the <B>Impact</B> panel lists the full downstream blast radius; click any node to jump to it.</>,
          <>After a breakage, open <B>Root Cause</B> — it walks upstream by run health to the likely culprit.</>,
          <>Hover the activity icon on any job/pipeline node for its health + last-5 runs.</>,
        ]} />
      </>
    ),
  },
  {
    id: "dq",
    title: "Data Quality",
    icon: ShieldCheck,
    keywords: "data quality dq rules trends coverage ring gauge dimension profiling expectations grade",
    body: (
      <>
        <P>A dashboard for a table’s data-quality posture: a coverage ring + quality grade, a trend line, per-rule pass/fail bars, a dimension breakdown, and column profiling.</P>
        <SubH>Try it</SubH>
        <Steps items={[
          <>Open <B>Data Quality</B> from the left rail (or the DQ deep-link on a table).</>,
          <>Read the coverage ring + grade, then scan per-rule bars and the trend to see if quality is improving or degrading.</>,
          <>Rules and metrics history live in the app-owned schema; successive runs form the trend.</>,
        ]} />
      </>
    ),
  },
  {
    id: "reports",
    title: "Reports",
    icon: FileBarChart,
    keywords: "reports hub executive overview estate kpis root cause data quality card grid",
    body: (
      <>
        <P>A card-grid hub of cross-estate reports: an <B>Executive Overview</B> (estate KPIs, DQ-coverage gauge, tables-by-type, recent activity), plus <B>Root Cause</B> and a <B>Data Quality</B> deep-link.</P>
        <SubH>Try it</SubH>
        <Steps items={[
          <>Open <B>Reports</B> from the left rail.</>,
          <>Start on <B>Executive Overview</B> for estate-wide KPIs, then drill into a specific report card.</>,
        ]} />
      </>
    ),
  },
  {
    id: "glossary",
    title: "Business Glossary",
    icon: BookOpen,
    keywords: "glossary terms domains kpis propagation wizard link asset column governed vocabulary overlay",
    body: (
      <>
        <P>A governed vocabulary that rides the lineage graph — <B>Terms, Domains & KPIs</B> with owners, status and formulas.</P>
        <Fig caption="term propagation — a term flows downstream">
          <path id="gl1" className="hflow v" d="M120 55 C190 55 190 95 260 95" markerEnd="url(#ah-v)" />
          <path id="gl2" className="hflow v" d="M320 95 C390 95 390 50 460 50" markerEnd="url(#ah-v)" />
          <path id="gl3" className="hflow v" d="M320 95 C390 95 390 140 460 140" markerEnd="url(#ah-v)" />
          <g className="hhot v"><rect x="24" y="36" width="96" height="40" rx="10" /></g>
          <text className="hlbl" x="72" y="52" textAnchor="middle">sales_raw</text>
          <text className="hsub v" x="72" y="66" textAnchor="middle">🏷 Revenue</text>
          <g className="hnode"><rect x="260" y="76" width="60" height="38" rx="9" /></g>
          <text className="hsub v" x="290" y="99" textAnchor="middle">🏷 Revenue</text>
          <g className="hnode"><rect x="460" y="34" width="52" height="32" rx="8" /><rect x="460" y="124" width="52" height="32" rx="8" /></g>
          <text className="hsub v" x="486" y="53" textAnchor="middle">🏷</text>
          <text className="hsub v" x="486" y="143" textAnchor="middle">🏷</text>
          <Spark path="gl1" dur="2.8s" cls="v" /><Spark path="gl2" dur="2.8s" begin="-.9s" cls="v" /><Spark path="gl3" dur="2.8s" begin="-1.8s" cls="v" />
        </Fig>
        <List items={[
          <>Link a term to a table or column at either grain.</>,
          <>The <B>Propagation wizard</B> picks a source table, walks its downstream lineage, and applies a term to every table it feeds — one click.</>,
          <>Turn on the graph’s <B>Terms</B> overlay to see domain-coloured chips on the canvas.</>,
        ]} />
        <SubH>Try it</SubH>
        <Steps items={[
          <>Open <B>Business Glossary</B> → add a term under <B>Terms</B> (name, domain, owner).</>,
          <>Expand the term and <B>link</B> it to a source table.</>,
          <>Go to <B>Propagation</B>, enter that source table, and click <B>Find suggestions</B> → <B>Apply all</B> to tag everything downstream.</>,
        ]} />
      </>
    ),
  },
  {
    id: "openlineage",
    title: "OpenLineage Export",
    icon: Download,
    keywords: "openlineage export ol 2.0.2 marquez datahub atlan openmetadata facet column lineage nd-json conformance preview",
    body: (
      <>
        <P>Export your lineage in the industry-standard format so it isn’t locked inside the app — spec-compliant <B>OpenLineage 2.0.2</B> with schema + column-lineage facets and deterministic run ids.</P>
        <Fig caption="BrickTrace → OpenLineage → any catalog">
          <path id="ol1" className="hflow" d="M116 95 H210" markerEnd="url(#ah-a)" />
          <path id="ol2" className="hflow" d="M300 95 C370 95 370 40 452 40" markerEnd="url(#ah-a)" />
          <path id="ol3" className="hflow" d="M300 95 C370 95 370 80 452 80" markerEnd="url(#ah-a)" />
          <path id="ol4" className="hflow" d="M300 95 C370 95 370 120 452 120" markerEnd="url(#ah-a)" />
          <path id="ol5" className="hflow" d="M300 95 C370 95 370 160 452 160" markerEnd="url(#ah-a)" />
          <g className="hhot"><rect x="20" y="76" width="96" height="40" rx="10" /></g>
          <text className="hlbl" x="68" y="99" textAnchor="middle">BrickTrace</text>
          <circle className="hhalo" cx="255" cy="95" r="18" />
          <g className="hnode"><rect x="210" y="77" width="90" height="36" rx="9" /></g>
          <text className="hlbl" x="255" y="92" textAnchor="middle">OL 2.0.2</text>
          <text className="hsub" x="255" y="104" textAnchor="middle">ND-JSON</text>
          <g className="hsub" fill="currentColor">
            <text x="456" y="43">Marquez</text><text x="456" y="83">DataHub</text><text x="456" y="123">Atlan</text><text x="456" y="163">OpenMetadata</text>
          </g>
          <Spark path="ol1" dur="1.6s" /><Spark path="ol2" dur="2s" /><Spark path="ol3" dur="2s" begin="-.5s" /><Spark path="ol4" dur="2s" begin="-1s" /><Spark path="ol5" dur="2s" begin="-1.5s" />
        </Fig>
        <SubH>Try it</SubH>
        <Steps items={[
          <>Open <B>OpenLineage Export</B> and choose a scope (catalog / schema).</>,
          <>Toggle the <B>facets</B> you want (schema, column-lineage, ownership, docs, data-quality).</>,
          <>Pick <B>JSON</B> or <B>ND-JSON</B>, check the live <B>preview</B> (count · size · conformance), then copy/download.</>,
        ]} />
      </>
    ),
  },
  {
    id: "streaming",
    title: "Streaming Topology",
    icon: Radio,
    keywords: "streaming topology dag freshness throughput backlog pipeline health kafka auto loader metrics live sparkline",
    body: (
      <>
        <P>Discover streaming tables and monitor their pipelines. Two tabs: <B>Topology</B> (a source→stream DAG) and <B>Metrics</B> (a live dashboard).</P>
        <Fig caption="source → stream → pipeline → live metrics">
          <path id="st1" className="hflow g" d="M96 60 H190" markerEnd="url(#ah-g)" />
          <path id="st2" className="hflow g" d="M96 135 H190" markerEnd="url(#ah-g)" />
          <path id="st3" className="hflow" d="M300 60 C350 60 350 95 400 95" markerEnd="url(#ah-a)" />
          <path id="st4" className="hflow" d="M300 135 C350 135 350 95 400 95" markerEnd="url(#ah-a)" />
          <g className="hnode"><rect x="14" y="44" width="82" height="32" rx="8" /><rect x="10" y="119" width="90" height="32" rx="8" /></g>
          <text className="hsub" x="55" y="64" textAnchor="middle">Kafka</text>
          <text className="hsub" x="55" y="139" textAnchor="middle">Auto Loader</text>
          <g className="hnode"><rect x="190" y="44" width="110" height="32" rx="8" /><rect x="190" y="119" width="110" height="32" rx="8" /></g>
          <text className="hsub g" x="245" y="64" textAnchor="middle">● orders_stream</text>
          <text className="hsub" x="245" y="139" textAnchor="middle">● cdc_target</text>
          <circle className="hhalo" cx="425" cy="95" r="20" />
          <g className="hhot"><rect x="400" y="74" width="110" height="42" rx="10" /></g>
          <text className="hlbl" x="455" y="90" textAnchor="middle">pipeline</text>
          <text className="hsub" x="455" y="104" textAnchor="middle">1.2k rows/s · lag 0s</text>
          <Spark path="st1" dur="2.2s" cls="g" /><Spark path="st2" dur="2.2s" begin="-1.1s" cls="g" /><Spark path="st3" dur="2s" /><Spark path="st4" dur="2s" begin="-1s" />
        </Fig>
        <List items={[
          <>Ingestion-source classification (Kafka / Kinesis / Event Hub / Auto Loader / Delta) and freshness badges (fresh / lagging / stale).</>,
          <>Per-pipeline status, success rate, throughput, backlog and data-quality with trend sparklines.</>,
          <>Fuzzy catalog picker + 30s auto-refresh; metrics fail open — a quiet stream shows “unavailable”, never an error.</>,
        ]} />
        <SubH>Try it</SubH>
        <Steps items={[
          <>Open <B>Streaming Topology</B>, type a catalog in the fuzzy picker (or leave blank), and click <B>Detect Topology</B>.</>,
          <>Explore the <B>Topology</B> tab’s DAG, then switch to <B>Metrics</B> for live status/throughput/backlog.</>,
          <>Flip <B>Live</B> on for 30s auto-refresh; click a stream to drill into its lineage.</>,
        ]} />
      </>
    ),
  },
  {
    id: "governance",
    title: "Governance, Access & ML",
    icon: ShieldAlert,
    keywords: "governance classification pii sensitivity ownership access grants ml models feature lineage",
    body: (
      <>
        <P>Per-table panels in the Table Lineage workspace.</P>
        <List items={[
          <><B>Governance</B> — ownership + column sensitivity from UC tags and app rules, with downstream propagation.</>,
          <><B>Access</B> — who can read the table (the app shows what its service principal can see).</>,
          <><B>ML models</B> — models and feature tables linked to the data.</>,
        ]} />
        <SubH>Try it</SubH>
        <Steps items={[
          <>Open a table → open the <B>Governance</B> panel to see owners + sensitive columns.</>,
          <>Open <B>Access</B> for grantees, and <B>ML models</B> for linked models/features.</>,
        ]} />
      </>
    ),
  },
  {
    id: "notifications",
    title: "Notifications",
    icon: Bell,
    keywords: "notifications bell recent activity auto scan schema change sensitive flow dq degradation alerts",
    body: (
      <>
        <P>The bell (top-right) and Home’s <B>Recent Activity</B> surface changes across the estate. A background auto-scan populates them on its own: <B>schema changes</B>, <B>sensitive flows</B> (PII landing without a classification tag), and <B>DQ degradation</B>. Alerts are deduped and capped.</P>
        <SubH>Try it</SubH>
        <Steps items={[
          <>Click the <B>bell</B> (top-right) or open Home’s <B>Recent Activity</B>.</>,
          <>Admins can trigger a scan manually from the notifications area.</>,
        ]} />
      </>
    ),
  },
  {
    id: "settings",
    title: "Settings & Admin",
    icon: SettingsIcon,
    keywords: "settings control panel flags plan capture federated sync admin dashboard ops metrics cache evict toggle",
    body: (
      <>
        <P><B>Settings</B> (the Control Panel) is an admin-gated toggle center for opt-in capabilities — Runtime Plan Capture, Captured-Plan Precedence, Federated Sync — all off by default. Everyone can see what each does and its access requirements; only admins can flip a toggle.</P>
        <P>The <B>Admin Dashboard</B> shows latency/memory/cache metrics, cache inventory + eviction, and transformation-lineage invalidate controls.</P>
        <SubH>Try it</SubH>
        <Steps items={[
          <>Open <B>Settings</B> to review capabilities and their access requirements.</>,
          <>Admins: flip a capability on, then use the panel’s guidance for any grants it needs.</>,
        ]} />
      </>
    ),
  },
  {
    id: "shortcuts",
    title: "Keyboard shortcuts",
    icon: Command,
    keywords: "keyboard shortcuts hotkeys command palette search theme escape",
    body: (
      <List items={[
        <><K>⌘/Ctrl</K>+<K>K</K> — open graph / global search.</>,
        <><K>Esc</K> — close a dialog, drawer, or this Help panel.</>,
        <>Theme is toggled from the sun/moon icon in the top bar.</>,
      ]} />
    ),
  },
  {
    id: "access",
    title: "Access & data safety",
    icon: Lock,
    keywords: "security permissions metadata only service principal admin group grants browse system tables privacy rows",
    body: (
      <>
        <P>BrickTrace is designed to be safe to share across a workspace.</P>
        <Fig caption="metadata in · nothing risky out">
          <path id="ax1" className="hflow g" d="M150 50 C210 50 210 95 270 95" markerEnd="url(#ah-g)" />
          <path id="ax2" className="hflow g" d="M150 95 H270" markerEnd="url(#ah-g)" />
          <path id="ax3" className="hflow g" d="M150 140 C210 140 210 95 270 95" markerEnd="url(#ah-g)" />
          <path id="ax4" className="hflow" d="M380 95 H470" markerEnd="url(#ah-a)" />
          <g className="hsub" fill="currentColor" textAnchor="end">
            <text x="146" y="54">system.access</text><text x="146" y="99">system.lakeflow</text><text x="146" y="144">system.billing</text>
          </g>
          <circle className="hhalo" cx="325" cy="95" r="18" />
          <g className="hhot"><rect x="270" y="76" width="110" height="40" rx="10" /></g>
          <text className="hlbl" x="325" y="92" textAnchor="middle">BrickTrace</text>
          <text className="hsub" x="325" y="105" textAnchor="middle">reads only</text>
          <g className="hnode"><rect x="470" y="78" width="44" height="36" rx="9" /></g>
          <text className="hsub" x="492" y="128" textAnchor="middle">1 schema</text>
          <Spark path="ax1" dur="2s" cls="g" /><Spark path="ax2" dur="2s" begin="-.7s" cls="g" /><Spark path="ax3" dur="2s" begin="-1.4s" cls="g" /><Spark path="ax4" dur="1.8s" />
        </Fig>
        <List items={[
          <><B>Metadata only</B> — it reads <Mono>BROWSE</Mono> + system tables (<Mono>system.access / .billing / .lakeflow</Mono>), never your table rows.</>,
          <>Writes go to exactly <B>one app-owned schema</B>; everything is scoped to the app’s service principal — you only see what it can see.</>,
          <><B>Admins</B> are members of the workspace group set by <Mono>ADMIN_GROUP_NAME</Mono> (default <Mono>admins</Mono>). Admin status is cached ~5 min after a group change.</>,
        ]} />
      </>
    ),
  },
  {
    id: "troubleshoot",
    title: "Troubleshooting",
    icon: Wrench,
    keywords: "faq troubleshooting problem error no transformation logic found access denied warehouse not set stale generate empty metrics admin controls",
    body: (
      <List items={[
        <><B>“No transformation logic found.”</B> The table wasn’t built yet, or its producer ran outside the discovery window. Click <B>Generate</B> (admin) — use force rebuild after a parser upgrade.</>,
        <><B>Access denied / empty panel.</B> The app’s service principal lacks a grant on that object. Ask an admin to grant it (see Access & data safety).</>,
        <><B>“No SQL warehouse available.”</B> The app came up without its env — an admin should re-run the deploy’s run step.</>,
        <><B>Streaming metrics show “unavailable.”</B> The stream hasn’t run recently or the SP can’t read its pipeline events — this is fail-open, not an error.</>,
        <><B>I don’t see admin controls.</B> You’re not in the admin group; a workspace admin can add you (allow ~5 min).</>,
      ]} />
    ),
  },
  {
    id: "about",
    title: "About & support",
    icon: LifeBuoy,
    keywords: "about support contact version help docs feedback maintainers",
    body: (
      <>
        <P>BrickTrace — end-to-end data lineage for Databricks, deployed as a self-contained Databricks App.</P>
        <List items={[
          <>For access requests or a capability you need enabled, contact a <B>workspace admin</B> — capabilities are managed in Settings.</>,
          <>For product questions or issues, reach out to the BrickTrace maintainers in your organization.</>,
        ]} />
      </>
    ),
  },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function HelpSupport({ open, onClose }: Props) {
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<string | null>(TOPICS[0].id);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => { window.removeEventListener("keydown", onKey); clearTimeout(t); };
  }, [open, onClose]);

  useEffect(() => {
    if (open) { setQ(""); setExpanded(TOPICS[0].id); }
  }, [open]);

  const query = q.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!query) return TOPICS;
    return TOPICS.filter((t) => (t.title + " " + t.keywords).toLowerCase().includes(query));
  }, [query]);
  const searching = query.length > 0;

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[3000] flex justify-end bg-black/55 backdrop-blur-sm help-fade"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Help and support"
    >
      {/* arrowhead defs shared by every diagram */}
      <svg width="0" height="0" className="absolute" aria-hidden="true"><defs>
        <marker id="ah-a" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#FF4520" /></marker>
        <marker id="ah-g" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#34d399" /></marker>
        <marker id="ah-v" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#8b5cf6" /></marker>
      </defs></svg>

      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[780px] h-full flex flex-col bg-surface-100 border-l border-white/[0.08] shadow-[0_0_80px_rgba(0,0,0,0.6)] help-slide"
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 px-6 py-4 border-b border-white/[0.06] shrink-0">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-accent/15 text-accent">
            <HelpCircle size={16} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold text-slate-100">Help &amp; Support</div>
            <div className="text-[11px] text-slate-500">Detailed guide to every BrickTrace feature — with steps to try each one</div>
          </div>
          <button
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close help"
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-white/[0.06] transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Search */}
        <div className="px-6 py-3 border-b border-white/[0.06] shrink-0">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search help — e.g. “priority”, “generate”, “admin”, “streaming”…"
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg pl-9 pr-3 py-2 text-[12.5px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-accent/50"
            />
          </div>
        </div>

        {/* Topics */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {filtered.length === 0 && (
            <div className="py-14 text-center text-[12px] text-slate-500">
              No help topics match “{q}”. Try a different term.
            </div>
          )}
          <div className="space-y-1.5">
            {filtered.map((t) => {
              const Icon = t.icon;
              const isOpen = searching || expanded === t.id;
              return (
                <div key={t.id} className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
                  <button
                    onClick={() => setExpanded(isOpen && !searching ? null : t.id)}
                    aria-expanded={isOpen}
                    className="w-full flex items-center gap-2.5 px-4 py-3 text-left hover:bg-white/[0.03] transition-colors"
                  >
                    <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-accent/10 text-accent shrink-0">
                      <Icon size={15} />
                    </span>
                    <span className="flex-1 text-[13px] font-semibold text-slate-100">{t.title}</span>
                    <ChevronDown
                      size={15}
                      className={`text-slate-500 transition-transform ${isOpen ? "rotate-180" : ""}`}
                    />
                  </button>
                  {isOpen && <div className="px-5 pb-4 pt-0.5 max-w-[680px]">{t.body}</div>}
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-white/[0.06] shrink-0 flex items-center justify-between text-[11px] text-slate-500">
          <span>BrickTrace · Unity Catalog lineage</span>
          <span>Press <K>Esc</K> to close</span>
        </div>
      </div>

      <style>{`
        @keyframes helpFade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes helpSlide { from { transform: translateX(28px); opacity: .5 } to { transform: none; opacity: 1 } }
        .help-fade { animation: helpFade .18s ease both; }
        .help-slide { animation: helpSlide .26s cubic-bezier(.2,.7,.2,1) both; }
        .hflow { fill: none; stroke: #FF4520; stroke-width: 2.1; stroke-dasharray: 6 7; animation: hmarch 1s linear infinite; }
        .hflow.g { stroke: #34d399; } .hflow.v { stroke: #8b5cf6; }
        @keyframes hmarch { to { stroke-dashoffset: -13; } }
        .hspark { fill: #FF4520; } .hspark.g { fill: #34d399; } .hspark.v { fill: #8b5cf6; }
        .hnode rect { fill: rgba(148,163,184,0.10); stroke: rgba(148,163,184,0.30); stroke-width: 1.3; }
        .hhot rect { fill: rgba(255,69,32,0.14); stroke: #FF4520; stroke-width: 1.8; }
        .hhot.v rect { fill: rgba(139,92,246,0.14); stroke: #8b5cf6; }
        .hhalo { fill: #FF4520; transform-box: fill-box; transform-origin: center; animation: hhalo 2s ease-in-out infinite; }
        @keyframes hhalo { 0%,100% { opacity: .45; r: 18; } 50% { opacity: 0; r: 30; } }
        .hlbl { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 11px; fill: currentColor; }
        .hsub { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 9px; fill: #94a3b8; }
        .hsub.v { fill: #a78bfa; } .hsub.g { fill: #34d399; }
        .hgate { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 9.5px; fill: #cbd5e1; }
        @media (prefers-reduced-motion: reduce) { .help-fade, .help-slide, .hflow, .hspark, .hhalo { animation: none; } }
      `}</style>
    </div>,
    document.body
  );
}
