import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Database, FolderTree, ShieldCheck, Layers, Activity, TableProperties, FilePenLine, Workflow, AlertTriangle } from "lucide-react";
import { useLineageStore } from "../../store/lineageStore";
import { api } from "../../api/client";
import { RingGauge, DimensionDonut } from "../dq/DQCharts";

interface Notif { id?: string | number; type?: string; title?: string; detail?: string; table_fqn?: string; created_at?: string; }

const TYPE_COLORS: Record<string, string> = {
  MANAGED: "#FF7A5C",
  EXTERNAL: "#38bdf8",
  VIEW: "#34d399",
  MATERIALIZED_VIEW: "#fbbf24",
  STREAMING_TABLE: "#a78bfa",
};
const activityIcon = (n: Notif) => {
  const t = (n.type || "").toLowerCase();
  if (t.includes("schema")) return { icon: FilePenLine, color: "text-violet-400" };
  if (t.includes("pipeline") || t.includes("run")) return { icon: Workflow, color: "text-sky-400" };
  if (t.includes("dq") || t.includes("quality")) return { icon: AlertTriangle, color: "text-amber-400" };
  return { icon: TableProperties, color: "text-emerald-400" };
};
function timeAgo(iso?: string): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (Number.isNaN(s)) return "";
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function OverviewReport({ onSelectTable }: { onSelectTable?: (fqn: string) => void }) {
  const allTables = useLineageStore((s) => s.allTables);
  const [rulesByTable, setRulesByTable] = useState<Set<string>>(new Set());
  const [ruleCount, setRuleCount] = useState(0);
  const [govRules, setGovRules] = useState(0);
  const [activity, setActivity] = useState<Notif[]>([]);

  useEffect(() => {
    api.listDQRules().then((r) => {
      setRuleCount(r.rules?.length || 0);
      setRulesByTable(new Set((r.rules || []).map((x) => x.table_fqn || "").filter(Boolean)));
    }).catch(() => {});
    fetch("/api/governance/config").then((r) => r.ok ? r.json() : null).then((d) => {
      if (d?.rules) setGovRules(d.rules.length);
    }).catch(() => {});
    fetch("/api/notifications?limit=6").then((r) => r.ok ? r.json() : null).then((d) => {
      if (d?.notifications) setActivity(d.notifications);
    }).catch(() => {});
  }, []);

  const stats = useMemo(() => {
    const catalogs = new Set(allTables.map((t) => t.catalog));
    const schemas = new Set(allTables.map((t) => `${t.catalog}.${t.schema}`));
    const byType: Record<string, number> = {};
    allTables.forEach((t) => { const k = t.table_type || "MANAGED"; byType[k] = (byType[k] || 0) + 1; });
    const byCatalog: Record<string, number> = {};
    allTables.forEach((t) => { byCatalog[t.catalog] = (byCatalog[t.catalog] || 0) + 1; });
    const topCatalogs = Object.entries(byCatalog).sort((a, b) => b[1] - a[1]).slice(0, 6);
    return { total: allTables.length, catalogs: catalogs.size, schemas: schemas.size, byType, topCatalogs };
  }, [allTables]);

  // Clamp to 1: rulesByTable is estate-wide while stats.total counts only loaded
  // tables, so the ratio can exceed 1 and overfill the ring / show >100%.
  const dqCoverage = stats.total > 0 ? Math.min(1, rulesByTable.size / stats.total) : 0;
  const typeSegments = Object.entries(stats.byType)
    .map(([k, v]) => ({ label: k.replace(/_/g, " "), value: v, color: TYPE_COLORS[k] || "#64748b" }))
    .sort((a, b) => b.value - a.value);
  const maxCat = Math.max(1, ...stats.topCatalogs.map(([, n]) => n));

  return (
    <div className="space-y-5">
      {/* KPI hero */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Kpi icon={Database} label="Tables" value={stats.total.toLocaleString()} tint="#FF7A5C" />
        <Kpi icon={FolderTree} label="Catalogs" value={String(stats.catalogs)} tint="#38bdf8" />
        <Kpi icon={Layers} label="Schemas" value={String(stats.schemas)} tint="#a78bfa" />
        <Kpi icon={ShieldCheck} label="DQ rules" value={ruleCount.toLocaleString()} sub={`${govRules} governance rules`} tint="#34d399" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-4">
        {/* DQ coverage */}
        <Card title="Data-quality coverage" hint={`${rulesByTable.size}/${stats.total} tables`}>
          <div className="flex items-center gap-5">
            <RingGauge value={dqCoverage} />
            <div className="text-[13px] text-slate-400 space-y-1">
              <p><span className="text-slate-100 font-semibold">{rulesByTable.size}</span> tables have DQ rules</p>
              <p><span className="text-slate-100 font-semibold">{stats.total - rulesByTable.size}</span> tables uncovered</p>
              <p className="text-[11px] text-slate-500 pt-1">{ruleCount} rules authored in total</p>
            </div>
          </div>
        </Card>

        {/* Tables by type */}
        <Card title="Tables by type">
          {typeSegments.length === 0 ? (
            <p className="text-[12px] text-slate-500">No tables loaded.</p>
          ) : (
            <div className="flex items-center gap-5">
              <DimensionDonut segments={typeSegments} />
              <div className="flex-1 space-y-1.5">
                {typeSegments.map((s) => (
                  <div key={s.label} className="flex items-center gap-2 text-[12px]">
                    <span className="w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} />
                    <span className="text-slate-300 capitalize">{s.label.toLowerCase()}</span>
                    <span className="ml-auto text-slate-500">{s.value.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-4">
        {/* Top catalogs */}
        <Card title="Largest catalogs" hint="by table count">
          <div className="space-y-2.5">
            {stats.topCatalogs.map(([cat, n]) => (
              <div key={cat} className="flex items-center gap-3 text-[12px]">
                <span className="w-40 shrink-0 truncate text-slate-300" title={cat}>{cat}</span>
                <div className="flex-1 h-2 rounded-full bg-white/[0.06] overflow-hidden">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${(n / maxCat) * 100}%` }} />
                </div>
                <span className="w-12 text-right text-slate-500">{n.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* Recent activity */}
        <Card title="Recent activity" hint={`${activity.length} events`}>
          {activity.length === 0 ? (
            <p className="text-[12px] text-slate-500">No recent activity.</p>
          ) : (
            <div className="space-y-2.5">
              {activity.slice(0, 6).map((n, i) => {
                const m = activityIcon(n);
                const Icon = m.icon;
                return (
                  <button key={n.id ?? i} onClick={() => n.table_fqn && onSelectTable?.(n.table_fqn)}
                    className="w-full flex items-start gap-2.5 text-left group">
                    <span className="w-7 h-7 rounded-full bg-surface border border-white/[0.06] flex items-center justify-center shrink-0">
                      <Icon size={13} className={m.color} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] text-slate-200 truncate group-hover:text-accent-light transition-colors">{n.title || n.type || "Activity"}</div>
                      {(n.table_fqn || n.detail) && <div className="text-[11px] text-slate-500 truncate">{n.table_fqn || n.detail}</div>}
                    </div>
                    <span className="text-[10px] text-slate-600 shrink-0">{timeAgo(n.created_at)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, sub, tint }: { icon: typeof Database; label: string; value: string; sub?: string; tint: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden p-4 bg-surface-50 rounded-xl border border-white/[0.06]">
      <span className="absolute top-0 inset-x-0 h-0.5" style={{ background: `linear-gradient(90deg, ${tint}, transparent)` }} />
      <div className="flex items-center gap-2 mb-1.5">
        <Icon size={14} style={{ color: tint }} />
        <span className="text-[11px] uppercase tracking-wider text-slate-500">{label}</span>
      </div>
      <p className="text-[26px] font-bold text-white leading-none">{value}</p>
      {sub && <p className="text-[11px] text-slate-500 mt-1">{sub}</p>}
    </motion.div>
  );
}

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
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
