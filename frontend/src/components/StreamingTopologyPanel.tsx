import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Radio, RefreshCw, Zap, Network, LayoutGrid, GitBranch, AlertTriangle,
  CheckCircle2, Clock, PauseCircle, ExternalLink,
} from "lucide-react";
import { api } from "../api/client";
import type { StreamNode, StreamEdge, StreamPipelineMetrics, StreamFreshness } from "../api/client";
import { goTableLineage } from "../hooks/useRouter";
import { StreamTopologyGraph } from "./graph/StreamTopologyGraph";

interface Props {
  catalog?: string;
}

const FRESH_STYLE: Record<StreamFreshness, string> = {
  fresh: "text-emerald-300 bg-emerald-500/10 border-emerald-500/25",
  lagging: "text-amber-300 bg-amber-500/10 border-amber-500/25",
  stale: "text-red-300 bg-red-500/10 border-red-500/25",
  unknown: "text-slate-400 bg-white/[0.04] border-white/10",
};

const STATUS_META: Record<string, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  active: { label: "Active", cls: "text-emerald-300", Icon: CheckCircle2 },
  idle: { label: "Idle", cls: "text-slate-400", Icon: PauseCircle },
  stale: { label: "Stale", cls: "text-amber-300", Icon: Clock },
  failed: { label: "Failed", cls: "text-red-300", Icon: AlertTriangle },
  unknown: { label: "Unknown", cls: "text-slate-500", Icon: Clock },
};

function fmtAge(sec?: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

/** Tiny inline SVG sparkline — no chart lib, matching the DQ dashboard approach. */
function Sparkline({ values }: { values: number[] }) {
  if (!values.length) return <span className="text-slate-600 text-[10px]">no data</span>;
  const w = 72, h = 20, max = Math.max(...values, 1), min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => `${(i / Math.max(values.length - 1, 1)) * w},${h - ((v - min) / span) * h}`)
    .join(" ");
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline points={pts} fill="none" stroke="#34d399" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

export function StreamingTopologyPanel({ catalog = "" }: Props) {
  const [inputCatalog, setInputCatalog] = useState(catalog);
  const [nodes, setNodes] = useState<StreamNode[]>([]);
  const [edges, setEdges] = useState<StreamEdge[]>([]);
  const [metrics, setMetrics] = useState<Record<string, StreamPipelineMetrics>>({});
  const [loading, setLoading] = useState(false);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"topology" | "metrics">("topology");
  const [freshFilter, setFreshFilter] = useState<StreamFreshness | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [catalogs, setCatalogs] = useState<string[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const comboRef = useRef<HTMLDivElement | null>(null);

  // Catalog list for the fuzzy picker — loaded once, best-effort.
  useEffect(() => {
    api.getCatalogs().then((d) => setCatalogs(d.catalogs || [])).catch(() => {});
  }, []);

  // Close the suggestion dropdown on an outside click.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (comboRef.current && !comboRef.current.contains(e.target as Node)) setShowSuggest(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // Subsequence fuzzy match (chars in order, gaps allowed), ranked by tightness.
  const suggestions = useMemo(() => {
    const q = inputCatalog.trim().toLowerCase();
    if (!q) return catalogs.slice(0, 8);
    const scored: { name: string; score: number }[] = [];
    for (const name of catalogs) {
      const lower = name.toLowerCase();
      let qi = 0, first = -1, last = -1;
      for (let i = 0; i < lower.length && qi < q.length; i++) {
        if (lower[i] === q[qi]) {
          if (first < 0) first = i;
          last = i;
          qi++;
        }
      }
      if (qi === q.length) scored.push({ name, score: (last - first) + (lower.startsWith(q) ? -100 : 0) });
    }
    return scored.sort((a, b) => a.score - b.score).slice(0, 8).map((s) => s.name);
  }, [inputCatalog, catalogs]);

  const fetchMetrics = useCallback(async (streamNodes: StreamNode[]) => {
    const pids = Array.from(new Set(streamNodes.map((n) => n.pipeline_id).filter(Boolean))) as string[];
    if (!pids.length) {
      setMetrics({});
      return;
    }
    setMetricsLoading(true);
    try {
      const data = await api.getStreamingMetrics(pids);
      setMetrics(data.metrics || {});
    } catch {
      // Metrics are best-effort — a failure here shouldn't blank the topology.
      setMetrics({});
    } finally {
      setMetricsLoading(false);
    }
  }, []);

  const fetchTopology = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.getStreamingTopology(inputCatalog || undefined);
      if (data.available === false) {
        setError(data.error || "Streaming topology unavailable");
        setNodes([]);
        setEdges([]);
        setMetrics({});
      } else {
        setNodes(data.streaming_tables || []);
        setEdges(data.streaming_edges || []);
        await fetchMetrics(data.streaming_tables || []);
      }
    } catch (e: any) {
      setError(e?.message || "Failed to fetch streaming topology");
    } finally {
      setLoading(false);
    }
  }, [inputCatalog, fetchMetrics]);

  // Auto-refresh loop — re-pulls topology + metrics on an interval when enabled.
  useEffect(() => {
    if (autoRefresh && nodes.length) {
      timer.current = setInterval(fetchTopology, 30000);
      return () => {
        if (timer.current) clearInterval(timer.current);
      };
    }
    return undefined;
  }, [autoRefresh, nodes.length, fetchTopology]);

  const filtered = useMemo(
    () => (freshFilter ? nodes.filter((n) => (n.freshness || "unknown") === freshFilter) : nodes),
    [nodes, freshFilter],
  );

  // KPI rollups across the discovered streams.
  const kpis = useMemo(() => {
    const byFresh = { fresh: 0, lagging: 0, stale: 0, unknown: 0 };
    for (const n of nodes) byFresh[(n.freshness || "unknown") as StreamFreshness]++;
    const statuses = Object.values(metrics);
    const failed = statuses.filter((m) => m.status === "failed").length;
    const active = statuses.filter((m) => m.status === "active").length;
    const totalThroughput = statuses.reduce((s, m) => s + (m.throughput_rows || 0), 0);
    const totalBacklog = statuses.reduce((s, m) => s + (m.backlog_records || 0), 0);
    return { total: nodes.length, byFresh, failed, active, totalThroughput, totalBacklog };
  }, [nodes, metrics]);

  const hasData = nodes.length > 0;

  return (
    <div className="text-slate-200 p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center gap-3 mb-1">
          <Radio size={22} className="text-emerald-400" />
          <h1 className="text-xl font-semibold">Streaming Topology</h1>
        </div>
        <p className="text-sm text-slate-400 mb-4">
          Discover streaming tables, trace their source-to-sink flow, and monitor freshness, pipeline
          health and throughput.
        </p>

        <div className="flex gap-2 mb-5">
          <div ref={comboRef} className="relative flex-1">
            <input
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-accent/50"
              placeholder="Catalog (optional — type to search, leave blank for all)"
              value={inputCatalog}
              role="combobox"
              aria-expanded={showSuggest}
              aria-autocomplete="list"
              onChange={(e) => {
                setInputCatalog(e.target.value);
                setShowSuggest(true);
                setActiveIdx(-1);
              }}
              onFocus={() => setShowSuggest(true)}
              onKeyDown={(e) => {
                if (showSuggest && suggestions.length) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1));
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActiveIdx((i) => Math.max(i - 1, 0));
                    return;
                  }
                  if (e.key === "Enter" && activeIdx >= 0) {
                    e.preventDefault();
                    setInputCatalog(suggestions[activeIdx]);
                    setShowSuggest(false);
                    return;
                  }
                  if (e.key === "Escape") {
                    setShowSuggest(false);
                    return;
                  }
                }
                if (e.key === "Enter") {
                  setShowSuggest(false);
                  fetchTopology();
                }
              }}
            />
            {showSuggest && suggestions.length > 0 && (
              <ul className="absolute z-20 mt-1 w-full max-h-60 overflow-y-auto rounded-lg border border-white/[0.1] bg-[#141821] shadow-xl py-1">
                {suggestions.map((c, i) => (
                  <li key={c}>
                    <button
                      type="button"
                      onClick={() => {
                        setInputCatalog(c);
                        setShowSuggest(false);
                      }}
                      className={`w-full text-left px-3 py-1.5 text-sm font-mono truncate ${
                        i === activeIdx ? "bg-accent/20 text-accent-light" : "text-slate-300 hover:bg-white/[0.06]"
                      }`}
                    >
                      {c}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            onClick={fetchTopology}
            disabled={loading}
            className="flex items-center gap-1.5 px-4 py-2 bg-accent hover:bg-accent-dark text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            {loading ? "Scanning..." : "Detect Topology"}
          </button>
          {hasData && (
            <button
              onClick={() => setAutoRefresh((v) => !v)}
              title="Auto-refresh every 30s"
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                autoRefresh
                  ? "bg-accent/20 border-accent/40 text-accent-light"
                  : "bg-white/[0.04] border-white/[0.08] text-slate-400 hover:text-slate-200"
              }`}
            >
              <Clock size={14} className={autoRefresh ? "animate-pulse" : ""} />
              Live
            </button>
          )}
        </div>

        {error && (
          <div className="p-3 mb-4 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-300">
            {error}
          </div>
        )}

        {hasData && (
          <>
            {/* KPI strip */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
              <Kpi label="Streaming Tables" value={kpis.total} accent="text-emerald-300" />
              <Kpi label="Fresh" value={kpis.byFresh.fresh} accent="text-emerald-300" />
              <Kpi label="Lagging / Stale" value={kpis.byFresh.lagging + kpis.byFresh.stale} accent="text-amber-300" />
              <Kpi label="Active Pipelines" value={kpis.active} accent="text-emerald-300" />
              <Kpi label="Failed" value={kpis.failed} accent={kpis.failed ? "text-red-300" : "text-slate-400"} />
            </div>

            {/* Tabs + freshness filter */}
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <div className="inline-flex rounded-lg border border-white/[0.08] overflow-hidden">
                <TabBtn active={tab === "topology"} onClick={() => setTab("topology")} Icon={Network} label="Topology" />
                <TabBtn active={tab === "metrics"} onClick={() => setTab("metrics")} Icon={LayoutGrid} label="Metrics" />
              </div>
              <div className="flex items-center gap-1.5">
                {(["fresh", "lagging", "stale"] as StreamFreshness[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFreshFilter((cur) => (cur === f ? null : f))}
                    className={`text-[11px] px-2 py-1 rounded-full border capitalize ${
                      freshFilter === f ? FRESH_STYLE[f] : "text-slate-500 border-white/10 hover:text-slate-300"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>

            {tab === "topology" ? (
              <StreamTopologyGraph nodes={filtered} edges={edges} metrics={metrics} onSelect={goTableLineage} />
            ) : (
              <MetricsTable nodes={filtered} metrics={metrics} loading={metricsLoading} />
            )}
          </>
        )}

        {!loading && !error && !hasData && (
          <div className="text-center py-12 text-slate-500 text-sm">
            Click "Detect Topology" to discover streaming tables and their data flow.
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="p-4 bg-white/[0.02] border border-white/[0.06] rounded-xl">
      <div className={`text-2xl font-bold ${accent}`}>{value}</div>
      <div className="text-xs text-slate-400 mt-1">{label}</div>
    </div>
  );
}

function TabBtn({ active, onClick, Icon, label }: { active: boolean; onClick: () => void; Icon: typeof Network; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors ${
        active ? "bg-accent/20 text-accent-light" : "text-slate-400 hover:text-slate-200"
      }`}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}

function MetricsTable({
  nodes,
  metrics,
  loading,
}: {
  nodes: StreamNode[];
  metrics: Record<string, StreamPipelineMetrics>;
  loading: boolean;
}) {
  return (
    <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl overflow-x-auto">
      <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-2">
        <span className="text-xs text-slate-400 font-medium">Per-stream operational metrics</span>
        {loading && <RefreshCw size={11} className="animate-spin text-slate-500" />}
      </div>
      <table className="w-full text-xs min-w-[860px]">
        <thead>
          <tr className="border-b border-white/[0.04] text-slate-500">
            <th className="text-left px-4 py-2 font-medium">Stream</th>
            <th className="text-left px-4 py-2 font-medium">Source</th>
            <th className="text-left px-4 py-2 font-medium">Freshness</th>
            <th className="text-left px-4 py-2 font-medium">Pipeline</th>
            <th className="text-left px-4 py-2 font-medium">Status</th>
            <th className="text-right px-4 py-2 font-medium">Throughput</th>
            <th className="text-right px-4 py-2 font-medium">Backlog</th>
            <th className="text-left px-4 py-2 font-medium">Trend</th>
            <th className="px-2 py-2" />
          </tr>
        </thead>
        <tbody>
          {nodes.map((n, i) => {
            const fqn = n.fqn || `${n.table_catalog}.${n.table_schema}.${n.table_name}`;
            const m = n.pipeline_id ? metrics[n.pipeline_id] : undefined;
            const status = STATUS_META[m?.status || "unknown"];
            const fresh = (n.freshness || "unknown") as StreamFreshness;
            return (
              <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <Zap size={11} className="text-emerald-400 shrink-0" />
                    <span className="font-mono text-slate-300 truncate max-w-[220px]" title={fqn}>
                      {n.table_name}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-slate-400 capitalize">{n.source_kind || "—"}</td>
                <td className="px-4 py-2.5">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full border capitalize ${FRESH_STYLE[fresh]}`}>
                    {fresh} · {fmtAge(n.age_seconds)}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-slate-500 truncate max-w-[160px]" title={n.pipeline_name || ""}>
                  {n.pipeline_name || (n.pipeline_id ? n.pipeline_id.slice(0, 8) : "—")}
                </td>
                <td className="px-4 py-2.5">
                  <span className={`inline-flex items-center gap-1 ${status.cls}`}>
                    <status.Icon size={11} />
                    {status.label}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right text-slate-300">
                  {m?.throughput_rows != null ? `${m.throughput_rows.toLocaleString()} rows` : <span className="text-slate-600">—</span>}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {m?.backlog_records != null ? (
                    <span className={m.backlog_records > 0 ? "text-amber-300" : "text-slate-400"}>
                      {m.backlog_records.toLocaleString()}
                    </span>
                  ) : (
                    <span className="text-slate-600">—</span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <Sparkline values={m?.trend || []} />
                </td>
                <td className="px-2 py-2.5 text-right">
                  <div className="flex items-center gap-1 justify-end">
                    <button
                      title="Open lineage"
                      onClick={() => goTableLineage(fqn)}
                      className="p-1 rounded hover:bg-white/[0.06] text-slate-500 hover:text-emerald-300"
                    >
                      <GitBranch size={12} />
                    </button>
                    <button
                      title="Impact analysis"
                      onClick={() => goTableLineage(fqn)}
                      className="p-1 rounded hover:bg-white/[0.06] text-slate-500 hover:text-emerald-300"
                    >
                      <ExternalLink size={12} />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
