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
 * accordion) so it stays easy to extend as the app grows. Pure frontend, no
 * backend call: every topic describes a shipped BrickTrace capability.
 */

interface Topic {
  id: string;
  title: string;
  icon: typeof Network;
  /** Extra search terms beyond the title (bodies are JSX, so we match on these). */
  keywords: string;
  body: ReactNode;
}

/** Small helpers to keep topic bodies compact + consistent. */
function P({ children }: { children: ReactNode }) {
  return <p className="text-[12.5px] leading-relaxed text-slate-300 mb-2">{children}</p>;
}
function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-1.5 mb-1">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2 text-[12.5px] leading-snug text-slate-400">
          <span className="mt-[7px] w-1 h-1 rounded-full bg-accent shrink-0" />
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}
function K({ children }: { children: ReactNode }) {
  return <kbd className="font-mono text-[11px] px-1.5 py-0.5 rounded border border-white/15 bg-white/[0.05] text-slate-300">{children}</kbd>;
}
function B({ children }: { children: ReactNode }) {
  return <b className="text-slate-200 font-semibold">{children}</b>;
}

const TOPICS: Topic[] = [
  {
    id: "start",
    title: "Getting started",
    icon: Rocket,
    keywords: "overview intro what is bricktrace begin quick start unity catalog trace",
    body: (
      <>
        <P>BrickTrace turns Unity Catalog’s system tables into an interactive lineage graph — showing not just <B>where</B> your data flows, but <B>how</B> each column was built, <B>why</B> it broke, and <B>what breaks</B> when you change it.</P>
        <List items={[
          <>Pick any table from <B>Search</B> (top bar) or <B>Lineage Explorer</B> — it auto-traces the full upstream→downstream cone across every catalog and schema.</>,
          <>Switch view modes — <B>Tables</B>, <B>Pipelines</B>, or <B>Full</B> — and cap the graph to N hops for a local slice.</>,
          <>Click any column to see its reconstructed transformation; click a job/pipeline node for run health and cost.</>,
          <>It reads <B>metadata only</B> — never your table rows.</>,
        ]} />
      </>
    ),
  },
  {
    id: "explorer",
    title: "Lineage Explorer & graph",
    icon: Network,
    keywords: "browse catalog schema table graph reactflow view mode depth business view terms overlay drag zoom search cmd k",
    body: (
      <>
        <P>Browse catalogs → schemas → tables, or open schema-wide / catalog-wide lineage from the picker. The graph is fully interactive.</P>
        <List items={[
          <>In-graph search with <K>⌘/Ctrl</K>+<K>K</K>; drag to rearrange, reset/fit-view, hover tooltips, orphan highlighting.</>,
          <><B>Business view</B> toggle (top-left) relabels technical types into plain language and hides FQNs/IDs/cost — for non-engineers.</>,
          <><B>Data-only vs Data + processing</B> chooses whether to show the jobs/pipelines between datasets.</>,
          <>The <B>Terms</B> overlay paints glossary term chips onto tables; the <B>lightbulb</B> gives an AI plain-English walkthrough of the current graph.</>,
          <>Cross-catalog and Delta Sharing boundaries render as first-class nodes.</>,
        ]} />
      </>
    ),
  },
  {
    id: "transform",
    title: "Transformation lineage",
    icon: Waypoints,
    keywords: "column expression sql pyspark parse generate regenerate build precedence captured plan cdc deep analysis diagnose no transformation logic",
    body: (
      <>
        <P>Click a column in the Table Lineage workspace to see the <B>actual expression</B> that produced it — <span className="font-mono text-[11.5px]">cast · sum · CASE · window · CTE</span> — reconstructed by parsing the producing code, not name-matching.</P>
        <List items={[
          <>Precedence, most trustworthy first: <B>captured Spark plan</B> → <B>CDC/merge spec</B> → <B>SQL/PySpark parse</B> → <B>LLM parse</B> (versioned + stale-flagged).</>,
          <><B>Generate / Regenerate</B> submits a serverless build job (admin-only). Use <B>force rebuild</B> to re-parse after a parser upgrade.</>,
          <>For metadata-driven pipelines with no logic in code, <B>Deep analysis</B> reads the config tables and streams its reasoning live.</>,
          <>If a build materialises nothing, the panel’s <B>diagnostics</B> explain why (no producer, producer outside the discovery window, or source not readable) with a suggested fix.</>,
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
        <List items={[
          <><B>Impact</B> — every downstream table plus the dashboards, jobs and pipelines that read it, grouped by type with deep links (the blast radius).</>,
          <><B>Root Cause</B> — a health-based upstream trace that surfaces the prime suspect and the failure path, so you don’t hand-walk the DAG at 2am.</>,
          <><B>Run health</B> on every job/pipeline node — verdict, success rate, duration trend, per-run cost with a spike flag.</>,
        ]} />
      </>
    ),
  },
  {
    id: "dq",
    title: "Data Quality",
    icon: ShieldCheck,
    keywords: "data quality dq rules trends coverage ring gauge dimension profiling expectations",
    body: (
      <>
        <P>A dashboard for a table’s data-quality posture.</P>
        <List items={[
          <>Coverage ring + quality grade, a trend line, per-rule pass/fail bars, a dimension breakdown, and column profiling.</>,
          <>Rules and metrics history are stored in the app-owned schema; trends compare successive runs.</>,
          <>Deep-links from Reports and from pipeline expectations.</>,
        ]} />
      </>
    ),
  },
  {
    id: "reports",
    title: "Reports",
    icon: FileBarChart,
    keywords: "reports hub executive overview estate kpis root cause data quality",
    body: (
      <>
        <P>A card-grid hub of cross-estate reports.</P>
        <List items={[
          <><B>Executive Overview</B> — estate KPIs, DQ-coverage gauge, tables-by-type, recent activity.</>,
          <><B>Root Cause</B> report and a <B>Data Quality</B> deep-link.</>,
        ]} />
      </>
    ),
  },
  {
    id: "glossary",
    title: "Business Glossary",
    icon: BookOpen,
    keywords: "glossary terms domains kpis propagation wizard link asset column governed vocabulary",
    body: (
      <>
        <P>A governed vocabulary that rides the lineage graph.</P>
        <List items={[
          <><B>Terms, Domains & KPIs</B> with owners, status and formulas; link a term to a table or column.</>,
          <>The <B>Propagation wizard</B> picks a source table, walks its downstream lineage, and applies a term to every table it feeds — one click.</>,
          <>Turn on the graph’s <B>Terms</B> overlay to see domain-coloured term chips on the canvas.</>,
        ]} />
      </>
    ),
  },
  {
    id: "openlineage",
    title: "OpenLineage Export",
    icon: Download,
    keywords: "openlineage export ol 2.0.2 marquez datahub atlan openmetadata facet column lineage nd-json conformance",
    body: (
      <>
        <P>Export your lineage in the industry-standard format so it isn’t locked inside the app.</P>
        <List items={[
          <>Spec-compliant <B>OpenLineage 2.0.2</B> — canonical namespaces, schema + column-lineage facets, deterministic run ids.</>,
          <>Toggle facets, choose <B>JSON</B> or <B>ND-JSON</B>, and preview count/size/conformance before exporting.</>,
          <>Lands cleanly in Marquez, DataHub, Atlan or OpenMetadata.</>,
        ]} />
      </>
    ),
  },
  {
    id: "streaming",
    title: "Streaming Topology",
    icon: Radio,
    keywords: "streaming topology dag freshness throughput backlog pipeline health kafka auto loader metrics live",
    body: (
      <>
        <P>Discover streaming tables and monitor their pipelines. Two tabs: <B>Topology</B> (a source→stream DAG) and <B>Metrics</B> (a live dashboard).</P>
        <List items={[
          <>Ingestion-source classification (Kafka / Kinesis / Event Hub / Auto Loader / Delta) and freshness badges (fresh / lagging / stale).</>,
          <>Per-pipeline status, success rate, throughput, backlog and data-quality with trend sparklines.</>,
          <>Fuzzy catalog picker + 30s auto-refresh. Metrics fail open — a missing grant or a quiet stream shows “unavailable”, never an error.</>,
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
          <><B>Access</B> — who can read the table (the app shows what the service principal can see).</>,
          <><B>ML models</B> — models and feature tables linked to the data.</>,
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
        <P>The bell (top-right) and Home’s <B>Recent Activity</B> surface changes across the estate.</P>
        <List items={[
          <>A background auto-scan populates them on its own: <B>schema changes</B>, <B>sensitive flows</B> (PII landing without a classification tag), and <B>DQ degradation</B>.</>,
          <>Alerts are deduped and capped; admins can also trigger a scan manually.</>,
        ]} />
      </>
    ),
  },
  {
    id: "settings",
    title: "Settings & Admin",
    icon: SettingsIcon,
    keywords: "settings control panel flags plan capture federated sync admin dashboard ops metrics cache evict",
    body: (
      <>
        <P><B>Settings</B> (the Control Panel) is an admin-gated toggle center for opt-in capabilities — Runtime Plan Capture, Captured-Plan Precedence, Federated Sync — all off by default.</P>
        <List items={[
          <>Everyone can see what each capability does and its access requirements; only admins can flip a toggle.</>,
          <>The <B>Admin Dashboard</B> shows latency/memory/cache metrics, cache inventory + eviction, and transformation-lineage invalidate controls.</>,
        ]} />
      </>
    ),
  },
  {
    id: "shortcuts",
    title: "Keyboard shortcuts",
    icon: Command,
    keywords: "keyboard shortcuts hotkeys command palette search theme",
    body: (
      <>
        <List items={[
          <><K>⌘/Ctrl</K>+<K>K</K> — open graph / global search.</>,
          <><K>Esc</K> — close a dialog, drawer, or this Help panel.</>,
          <>Theme is toggled from the sun/moon icon in the top bar.</>,
        ]} />
      </>
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
        <List items={[
          <><B>Metadata only</B> — it reads <span className="font-mono text-[11.5px]">BROWSE</span> + system tables (<span className="font-mono text-[11.5px]">system.access / .billing / .lakeflow</span>), never your table rows.</>,
          <>Writes go to exactly <B>one app-owned schema</B>; everything is scoped to the app’s service principal — you only see what it can see.</>,
          <><B>Admins</B> are members of the workspace group set by <span className="font-mono text-[11.5px]">ADMIN_GROUP_NAME</span> (default <span className="font-mono text-[11.5px]">admins</span>). Admin status is cached ~5 min after a group change.</>,
        ]} />
      </>
    ),
  },
  {
    id: "troubleshoot",
    title: "Troubleshooting",
    icon: Wrench,
    keywords: "faq troubleshooting problem error no transformation logic found access denied warehouse not set stale generate admin empty metrics",
    body: (
      <>
        <List items={[
          <><B>“No transformation logic found.”</B> The table wasn’t built yet, or its producer ran outside the discovery window. Click <B>Generate</B> (admin) — use force rebuild after a parser upgrade.</>,
          <><B>Access denied / empty panel.</B> The app’s service principal lacks a grant on that object. Ask an admin to grant it (see Access & data safety).</>,
          <><B>“No SQL warehouse available.”</B> The app came up without its env — an admin should re-run the deploy’s run step.</>,
          <><B>Streaming metrics show “unavailable.”</B> The stream hasn’t run recently or the SP can’t read its pipeline events — this is fail-open, not an error.</>,
          <><B>I don’t see admin controls.</B> You’re not in the admin group; a workspace admin can add you (allow ~5 min).</>,
        ]} />
      </>
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

  // Close on Escape; focus the search box on open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => { window.removeEventListener("keydown", onKey); clearTimeout(t); };
  }, [open, onClose]);

  // Reset transient state whenever the drawer is opened.
  useEffect(() => {
    if (open) { setQ(""); setExpanded(TOPICS[0].id); }
  }, [open]);

  const query = q.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!query) return TOPICS;
    return TOPICS.filter((t) => (t.title + " " + t.keywords).toLowerCase().includes(query));
  }, [query]);
  // While searching, every match is expanded so answers are visible at a glance.
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
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[440px] h-full flex flex-col bg-surface-100 border-l border-white/[0.08] shadow-[0_0_80px_rgba(0,0,0,0.6)] help-slide"
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-white/[0.06] shrink-0">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-accent/15 text-accent">
            <HelpCircle size={16} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold text-slate-100">Help &amp; Support</div>
            <div className="text-[11px] text-slate-500">Everything BrickTrace can do, in one place</div>
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
        <div className="px-5 py-3 border-b border-white/[0.06] shrink-0">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search help — e.g. “generate”, “admin”, “streaming”…"
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg pl-9 pr-3 py-2 text-[12.5px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-accent/50"
            />
          </div>
        </div>

        {/* Topics */}
        <div className="flex-1 overflow-y-auto px-3 py-3">
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
                    className="w-full flex items-center gap-2.5 px-3.5 py-3 text-left hover:bg-white/[0.03] transition-colors"
                  >
                    <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-accent/10 text-accent shrink-0">
                      <Icon size={15} />
                    </span>
                    <span className="flex-1 text-[13px] font-medium text-slate-100">{t.title}</span>
                    <ChevronDown
                      size={15}
                      className={`text-slate-500 transition-transform ${isOpen ? "rotate-180" : ""}`}
                    />
                  </button>
                  {isOpen && <div className="px-3.5 pb-3.5 pt-0.5">{t.body}</div>}
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-white/[0.06] shrink-0 flex items-center justify-between text-[11px] text-slate-500">
          <span>BrickTrace · Unity Catalog lineage</span>
          <span>Press <K>Esc</K> to close</span>
        </div>
      </div>

      <style>{`
        @keyframes helpFade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes helpSlide { from { transform: translateX(24px); opacity: .6 } to { transform: none; opacity: 1 } }
        .help-fade { animation: helpFade .18s ease both; }
        .help-slide { animation: helpSlide .24s cubic-bezier(.2,.7,.2,1) both; }
        @media (prefers-reduced-motion: reduce) { .help-fade, .help-slide { animation: none; } }
      `}</style>
    </div>,
    document.body
  );
}
