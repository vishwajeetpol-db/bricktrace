import { useCallback, useEffect, useMemo, useState } from "react";
import { useLineageStore } from "../store/lineageStore";
import {
  api,
  DQMetricsResult,
  DQRule,
  DQTrends,
  DQProfile,
  DQPropagation,
} from "../api/client";
import { RingGauge, TrendLine, DimensionDonut, scoreColor, gradeColor } from "./dq/DQCharts";
import { dimensionForRuleType, DQ_DIMENSIONS } from "../lib/dqDimensions";

interface Props {
  tableFqn?: string;
}

const FQN_RE = /^[^.]+\.[^.]+\.[^.]+$/;

export function DQMetricsPanel({ tableFqn = "" }: Props) {
  const isAdmin = useLineageStore((s) => s.isAdmin);
  const allTables = useLineageStore((s) => s.allTables);

  const [inputFqn, setInputFqn] = useState(tableFqn);
  const [selected, setSelected] = useState(tableFqn);
  const [sampleSize, setSampleSize] = useState(10000);

  const [metrics, setMetrics] = useState<DQMetricsResult | null>(null);
  const [metricsErr, setMetricsErr] = useState("");
  const [rules, setRules] = useState<DQRule[]>([]);
  const [trends, setTrends] = useState<DQTrends | null>(null);
  const [profile, setProfile] = useState<DQProfile | null>(null);
  const [propagation, setPropagation] = useState<DQPropagation | null>(null);
  const [loading, setLoading] = useState(false);

  // Portfolio (no table selected): every table that has authored rules.
  const [portfolio, setPortfolio] = useState<DQRule[]>([]);
  const [portfolioLoaded, setPortfolioLoaded] = useState(false);

  useEffect(() => {
    api
      .listDQRules()
      .then((r) => setPortfolio(r.rules || []))
      .catch(() => setPortfolio([]))
      .finally(() => setPortfolioLoaded(true));
  }, []);

  const analyze = useCallback(
    async (fqn: string) => {
      if (!FQN_RE.test(fqn)) return;
      const [catalog, schema, table] = fqn.split(".");
      setSelected(fqn);
      setLoading(true);
      setMetrics(null);
      setMetricsErr("");
      setRules([]);
      setTrends(null);
      setProfile(null);
      setPropagation(null);

      const results = await Promise.allSettled([
        isAdmin ? api.getDQMetrics(fqn, sampleSize) : Promise.reject(new Error("admin-only")),
        api.listDQRules(fqn),
        api.getDQTrends(fqn),
        api.getColumnProfile(catalog, schema, table),
        api.getDQPropagation(catalog, schema, table),
      ]);

      const [mRes, rRes, tRes, pRes, propRes] = results;
      if (mRes.status === "fulfilled") {
        setMetrics(mRes.value);
        // Persist the run so the trend fills in over time (admin write).
        const m = mRes.value;
        if (m.quality_score != null) {
          const passed = m.metrics.filter((x) => x.status === "pass").length;
          const evaluated = m.rules_evaluated ?? 0;
          api
            .recordDQMetrics({
              table_fqn: fqn,
              quality_score: m.quality_score,
              rules_evaluated: evaluated,
              rules_passed: passed,
              rules_failed: evaluated - passed,
            })
            .catch(() => {});
        }
      } else if (isAdmin) {
        setMetricsErr(String((mRes.reason as Error)?.message || "Failed to run checks"));
      }
      if (rRes.status === "fulfilled") setRules(rRes.value.rules || []);
      if (tRes.status === "fulfilled") setTrends(tRes.value);
      if (pRes.status === "fulfilled") setProfile(pRes.value);
      if (propRes.status === "fulfilled") setPropagation(propRes.value);
      setLoading(false);
    },
    [isAdmin, sampleSize],
  );

  useEffect(() => {
    if (tableFqn && FQN_RE.test(tableFqn)) analyze(tableFqn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableFqn]);

  // Rules to reason about: prefer live metrics, else the authored inventory.
  const ruleTypes = useMemo(
    () => (metrics ? metrics.metrics.map((m) => m.rule_type) : rules.map((r) => r.rule_type)),
    [metrics, rules],
  );
  const dimensionSegments = useMemo(() => {
    const counts: Record<string, number> = {};
    ruleTypes.forEach((rt) => {
      const d = dimensionForRuleType(rt);
      counts[d.key] = (counts[d.key] || 0) + 1;
    });
    return Object.values(DQ_DIMENSIONS)
      .map((d) => ({ label: d.label, value: counts[d.key] || 0, color: d.color }))
      .filter((s) => s.value > 0);
  }, [ruleTypes]);

  const tableOptions = useMemo(() => {
    const q = inputFqn.toLowerCase();
    return allTables
      .filter((t) => !q || t.fqdn.toLowerCase().includes(q))
      .slice(0, 50)
      .map((t) => t.fqdn);
  }, [allTables, inputFqn]);

  // Portfolio grouped by table.
  const portfolioByTable = useMemo(() => {
    const by: Record<string, DQRule[]> = {};
    portfolio.forEach((r) => {
      const key = r.table_fqn || "";
      if (key) (by[key] = by[key] || []).push(r);
    });
    return Object.entries(by).sort((a, b) => b[1].length - a[1].length);
  }, [portfolio]);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Picker row */}
      <div className="flex flex-wrap items-end gap-3 mb-6">
        <div className="flex-1 min-w-[280px]">
          <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1.5">Table</label>
          <input
            value={inputFqn}
            onChange={(e) => setInputFqn(e.target.value)}
            list="dq-tables"
            placeholder="catalog.schema.table"
            className="w-full px-3.5 py-2 bg-surface-50 border border-white/[0.08] rounded-lg text-[13px] text-white placeholder-slate-600 focus:border-accent/40 focus:outline-none"
            onKeyDown={(e) => e.key === "Enter" && analyze(inputFqn)}
          />
          <datalist id="dq-tables">
            {tableOptions.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </div>
        <div>
          <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1.5">Sample</label>
          <select
            value={sampleSize}
            onChange={(e) => setSampleSize(Number(e.target.value))}
            className="px-3 py-2 bg-surface-50 border border-white/[0.08] rounded-lg text-[13px] text-slate-200 focus:outline-none"
          >
            {[1000, 10000, 100000, 1000000].map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()} rows
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={() => analyze(inputFqn)}
          disabled={loading || !FQN_RE.test(inputFqn)}
          className="px-5 py-2 bg-accent/90 hover:bg-accent text-white rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
        >
          {loading ? "Analyzing…" : "Analyze"}
        </button>
        {selected && (
          <button
            onClick={() => {
              setSelected("");
              setInputFqn("");
              setMetrics(null);
            }}
            className="px-3 py-2 text-[12px] text-slate-400 hover:text-slate-200"
          >
            ← All tables
          </button>
        )}
      </div>

      {!isAdmin && (
        <p className="text-amber-400/80 text-[12px] mb-4">
          Live scoring executes rule expressions against your data and is admin-only — you can still see authored rules,
          column profiling, trend history and upstream coverage below.
        </p>
      )}

      {/* No table selected → portfolio / onboarding */}
      {!selected && (
        <Portfolio
          loaded={portfolioLoaded}
          groups={portfolioByTable}
          onPick={(f) => {
            setInputFqn(f);
            analyze(f);
          }}
        />
      )}

      {selected && (
        <div className="space-y-6">
          {metricsErr && !metrics && (
            <p className="text-red-400 text-[13px]">{metricsErr}</p>
          )}

          {/* KPI row */}
          <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-4">
            <div className="flex items-center gap-5 p-5 bg-surface-50 rounded-xl border border-white/[0.06]">
              <div className="relative">
                <RingGauge value={metrics?.quality_score ?? null} />
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wider text-slate-500">Quality score</p>
                <div className="flex items-center gap-2 mt-1">
                  {metrics?.quality_grade ? (
                    <span
                      className="w-9 h-9 rounded-lg flex items-center justify-center text-[18px] font-bold"
                      style={{ color: gradeColor(metrics.quality_grade), background: `${gradeColor(metrics.quality_grade)}1a` }}
                    >
                      {metrics.quality_grade}
                    </span>
                  ) : (
                    <span className="text-[12px] text-slate-500">
                      {metrics
                        ? metrics.metrics.length === 0
                          ? "No rules yet"
                          : "Partial coverage"
                        : isAdmin
                        ? "Run to score"
                        : "Admin-only"}
                    </span>
                  )}
                  {trends && trends.data_points.length >= 2 && (
                    <TrendBadge dir={trends.trend} />
                  )}
                </div>
                {metrics && metrics.sample_size != null && (
                  <p className="text-[11px] text-slate-500 mt-1.5">
                    {metrics.rules_evaluated}/{metrics.rules_total} rules · {metrics.sample_size.toLocaleString()} rows
                  </p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Kpi label="Rules" value={String((metrics?.rules_total ?? rules.length) || 0)} sub="authored" />
              <Kpi
                label="Passing"
                value={metrics ? `${metrics.metrics.filter((m) => m.status === "pass").length}` : "—"}
                sub={metrics ? `of ${metrics.rules_evaluated ?? 0} run` : "run to see"}
                tone="good"
              />
              <Kpi
                label="Failing rows"
                value={metrics ? metrics.metrics.reduce((s, m) => s + (m.failing_rows || 0), 0).toLocaleString() : "—"}
                sub="across rules"
                tone="bad"
              />
              <Kpi
                label="Coverage"
                value={
                  metrics && (metrics.rules_total ?? 0) > 0
                    ? `${Math.round(((metrics.rules_evaluated ?? 0) / (metrics.rules_total as number)) * 100)}%`
                    : "—"
                }
                sub={metrics?.coverage_complete === false ? "incomplete" : "of rules"}
              />
            </div>
          </div>

          {/* Trend */}
          <Section title="Quality trend" hint={trends ? `${trends.data_points.length} run(s)` : ""}>
            <TrendLine points={(trends?.data_points ?? []).map((d) => ({ y: d.quality_score }))} />
          </Section>

          {/* Per-rule + dimensions */}
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
            <Section title="Rule results">
              <RuleResults metrics={metrics} rules={rules} isAdmin={isAdmin} />
            </Section>
            <Section title="Rules by dimension">
              {dimensionSegments.length === 0 ? (
                <p className="text-[12px] text-slate-500">No rules authored.</p>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <DimensionDonut segments={dimensionSegments} />
                  <div className="w-full space-y-1.5">
                    {dimensionSegments.map((s) => (
                      <div key={s.label} className="flex items-center gap-2 text-[12px]">
                        <span className="w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} />
                        <span className="text-slate-300">{s.label}</span>
                        <span className="ml-auto text-slate-500">{s.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Section>
          </div>

          {/* Column profiling */}
          <Section
            title="Column profile"
            hint={profile?.row_count_approx ? `~${Number(profile.row_count_approx).toLocaleString()} rows` : ""}
          >
            <ColumnProfile profile={profile} />
          </Section>

          {/* Upstream quality */}
          <Section
            title="Upstream quality"
            hint={propagation ? `${propagation.covered_count}/${propagation.upstream_count} covered` : ""}
          >
            <UpstreamQuality propagation={propagation} onPick={(f) => { setInputFqn(f); analyze(f); }} />
          </Section>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="p-5 bg-surface-50 rounded-xl border border-white/[0.06]">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[13px] font-semibold text-slate-200">{title}</h3>
        {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  const color = tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-red-400" : "text-white";
  return (
    <div className="p-3.5 bg-surface-50 rounded-xl border border-white/[0.06]">
      <p className="text-[11px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`text-[22px] font-bold mt-0.5 ${color}`}>{value}</p>
      {sub && <p className="text-[11px] text-slate-500">{sub}</p>}
    </div>
  );
}

function TrendBadge({ dir }: { dir: "improving" | "stable" | "degrading" }) {
  const map = {
    improving: { t: "↑ improving", c: "text-emerald-400 bg-emerald-400/10" },
    degrading: { t: "↓ degrading", c: "text-red-400 bg-red-400/10" },
    stable: { t: "→ stable", c: "text-slate-400 bg-white/[0.05]" },
  }[dir];
  return <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${map.c}`}>{map.t}</span>;
}

function RuleResults({
  metrics,
  rules,
  isAdmin,
}: {
  metrics: DQMetricsResult | null;
  rules: DQRule[];
  isAdmin: boolean;
}) {
  if (metrics && metrics.metrics.length > 0) {
    const sorted = [...metrics.metrics].sort((a, b) => (a.pass_rate ?? 2) - (b.pass_rate ?? 2));
    return (
      <div className="space-y-2">
        {sorted.map((m, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="w-40 shrink-0 truncate text-[12px]">
              <span className="text-slate-200">{m.rule_type}</span>
              {m.column && <span className="text-slate-500"> · {m.column}</span>}
            </div>
            <div className="flex-1 h-2.5 rounded-full bg-white/[0.06] overflow-hidden">
              {m.pass_rate != null && (
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.max(2, m.pass_rate * 100)}%`, background: scoreColor(m.pass_rate) }}
                />
              )}
            </div>
            <div className="w-24 shrink-0 text-right text-[12px]">
              {m.pass_rate != null ? (
                <span style={{ color: scoreColor(m.pass_rate) }}>{Math.round(m.pass_rate * 100)}%</span>
              ) : (
                <span className="text-slate-500" title={m.error}>{m.status}</span>
              )}
              {m.failing_rows ? <span className="text-slate-600"> · {m.failing_rows.toLocaleString()}✗</span> : null}
            </div>
          </div>
        ))}
      </div>
    );
  }
  // No live metrics — show the authored rule inventory.
  if (rules.length > 0) {
    return (
      <div className="space-y-2">
        {!isAdmin && <p className="text-[11px] text-slate-500 mb-2">Authored rules (live scoring is admin-only):</p>}
        {rules.map((r, i) => (
          <div key={i} className="flex items-center gap-3 text-[12px]">
            <span className="w-2 h-2 rounded-full" style={{ background: dimensionForRuleType(r.rule_type).color }} />
            <span className="text-slate-200">{r.rule_type}</span>
            {r.column_name && <span className="text-slate-500">· {r.column_name}</span>}
            {r.expression && <span className="text-slate-600 truncate font-mono text-[11px]">{r.expression}</span>}
            {r.severity && <span className="ml-auto text-[10px] uppercase text-slate-500">{r.severity}</span>}
          </div>
        ))}
      </div>
    );
  }
  return (
    <p className="text-[12px] text-slate-500">
      No DQ rules defined for this table yet. Author NOT_NULL / UNIQUE / RANGE / REGEX / CUSTOM rules to start scoring.
    </p>
  );
}

function ColumnProfile({ profile }: { profile: DQProfile | null }) {
  if (!profile || profile.columns.length === 0) {
    return (
      <p className="text-[12px] text-slate-500">
        No profiling stats available. Run <span className="font-mono">ANALYZE TABLE … COMPUTE STATISTICS</span>, or use
        Live mode for an ad-hoc profile.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {profile.columns.slice(0, 30).map((c) => {
        const nullPct = c.null_pct != null ? c.null_pct : null;
        return (
          <div key={c.name} className="p-3 bg-surface rounded-lg border border-white/[0.06]">
            <p className="text-[12px] text-slate-200 font-medium truncate" title={c.name}>{c.name}</p>
            <div className="mt-2 space-y-1.5">
              {nullPct != null && (
                <div>
                  <div className="flex justify-between text-[10px] text-slate-500">
                    <span>Null</span>
                    <span>{nullPct.toFixed(1)}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden mt-0.5">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${Math.min(100, nullPct)}%`, background: nullPct > 5 ? "#f87171" : "#34d399" }}
                    />
                  </div>
                </div>
              )}
              {c.distinct_count != null && (
                <p className="text-[11px] text-slate-500">
                  Distinct: <span className="text-slate-300">{c.distinct_count.toLocaleString()}</span>
                </p>
              )}
              {(c.min != null || c.max != null) && (
                <p className="text-[11px] text-slate-500 truncate">
                  Range: <span className="text-slate-300">{String(c.min ?? "?")} → {String(c.max ?? "?")}</span>
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function UpstreamQuality({
  propagation,
  onPick,
}: {
  propagation: DQPropagation | null;
  onPick: (fqn: string) => void;
}) {
  if (!propagation || propagation.upstream_quality.length === 0) {
    return <p className="text-[12px] text-slate-500">No upstream tables found in lineage.</p>;
  }
  return (
    <div className="space-y-2">
      {propagation.covered_count < propagation.upstream_count && (
        <p className="text-[12px] text-amber-400/80">
          {propagation.upstream_count - propagation.covered_count} upstream table(s) have no DQ rules — quality here can
          silently inherit their issues.
        </p>
      )}
      {propagation.upstream_quality.map((u) => (
        <div key={u.upstream_table} className="flex items-center gap-3 text-[12px]">
          <span className={`w-2 h-2 rounded-full ${u.has_dq_rules ? "bg-emerald-400" : "bg-slate-600"}`} />
          <button onClick={() => onPick(u.upstream_table)} className="text-slate-300 hover:text-accent truncate font-mono text-[11px]">
            {u.upstream_table}
          </button>
          <span className="ml-auto text-slate-500">{u.has_dq_rules ? `${u.rule_count} rule(s)` : "no rules"}</span>
        </div>
      ))}
    </div>
  );
}

function Portfolio({
  loaded,
  groups,
  onPick,
}: {
  loaded: boolean;
  groups: [string, DQRule[]][];
  onPick: (fqn: string) => void;
}) {
  if (!loaded) return <p className="text-[12px] text-slate-500">Loading…</p>;
  if (groups.length === 0) {
    return (
      <div className="p-8 bg-surface-50 rounded-xl border border-white/[0.06] text-center">
        <p className="text-[15px] text-slate-200 font-medium mb-1">No DQ rules authored yet</p>
        <p className="text-[13px] text-slate-500 mb-4">
          Pick any table above to profile its columns, or add rules to start scoring quality over time.
        </p>
      </div>
    );
  }
  return (
    <div>
      <p className="text-[12px] text-slate-500 mb-3">{groups.length} table(s) with DQ rules</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {groups.map(([fqn, rs]) => {
          const dims = new Map<string, { color: string; n: number }>();
          rs.forEach((r) => {
            const d = dimensionForRuleType(r.rule_type);
            const e = dims.get(d.label) || { color: d.color, n: 0 };
            e.n += 1;
            dims.set(d.label, e);
          });
          return (
            <button
              key={fqn}
              onClick={() => onPick(fqn)}
              className="text-left p-4 bg-surface-50 hover:bg-surface-100 rounded-xl border border-white/[0.06] hover:border-accent/30 transition-colors"
            >
              <p className="text-[13px] text-slate-200 font-medium truncate" title={fqn}>
                {fqn.split(".").slice(-1)[0]}
              </p>
              <p className="text-[11px] text-slate-500 truncate mb-3">{fqn}</p>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-slate-400">{rs.length} rule(s)</span>
                <div className="ml-auto flex gap-1">
                  {[...dims.values()].map((d, i) => (
                    <span key={i} className="w-2.5 h-2.5 rounded-sm" style={{ background: d.color }} title={`${d.n}`} />
                  ))}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
