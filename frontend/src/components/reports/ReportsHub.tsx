import { useState } from "react";
import { motion } from "framer-motion";
import {
  LayoutDashboard, Search, Network, ShieldCheck, ScanSearch, GitBranchPlus, DollarSign,
  ArrowLeft, ArrowRight, Sparkles,
} from "lucide-react";
import { goDQ } from "../../hooks/useRouter";
import { OverviewReport } from "./OverviewReport";
import { RootCauseWizard } from "../RootCauseWizard";

type ReportId = "overview" | "rootCause";

interface ReportCard {
  id?: ReportId;
  title: string;
  desc: string;
  icon: typeof LayoutDashboard;
  tint: string;
  edge: string;
  action?: () => void;
  soon?: boolean;
}

interface Props {
  onSelectTable?: (fqn: string) => void;
}

export function ReportsHub({ onSelectTable }: Props) {
  const [active, setActive] = useState<ReportId | null>(null);

  const cards: ReportCard[] = [
    { id: "overview", title: "Executive Overview", desc: "Estate health at a glance — tables, coverage, quality, activity.", icon: LayoutDashboard, tint: "#FF7A5C", edge: "from-orange-500/70" },
    { id: "rootCause", title: "Root Cause Analysis", desc: "Trace an anomaly upstream through lineage + producer failures.", icon: ScanSearch, tint: "#f87171", edge: "from-rose-500/70" },
    { title: "Data Quality", desc: "Portfolio scores, coverage and trends across your tables.", icon: ShieldCheck, tint: "#34d399", edge: "from-emerald-500/70", action: () => goDQ() },
    { title: "Lineage Coverage", desc: "Tables with vs without lineage, orphans and hub tables.", icon: Network, tint: "#38bdf8", edge: "from-sky-500/70", soon: true },
    { title: "Governance & PII", desc: "Sensitive tables, unclassified gaps and tag coverage.", icon: GitBranchPlus, tint: "#a78bfa", edge: "from-violet-500/70", soon: true },
    { title: "Cost & Impact", desc: "Most expensive producers and highest blast-radius tables.", icon: DollarSign, tint: "#fbbf24", edge: "from-amber-500/70", soon: true },
  ];

  if (active) {
    const meta = cards.find((c) => c.id === active)!;
    return (
      <div>
        <button onClick={() => setActive(null)} className="flex items-center gap-1.5 text-[12px] text-slate-400 hover:text-slate-200 mb-4">
          <ArrowLeft size={13} /> All reports
        </button>
        <div className="flex items-center gap-2.5 mb-5">
          <span className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: `${meta.tint}1a` }}>
            <meta.icon size={18} style={{ color: meta.tint }} />
          </span>
          <h2 className="text-[18px] font-bold text-white tracking-tight">{meta.title}</h2>
        </div>
        {active === "overview" && <OverviewReport onSelectTable={onSelectTable} />}
        {active === "rootCause" && <RootCauseWizard />}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <Sparkles size={15} className="text-accent" />
        <h2 className="text-[18px] font-bold text-white tracking-tight">Reports</h2>
      </div>
      <p className="text-[13px] text-slate-500 mb-6">Insight reports across lineage, quality and governance.</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map((c, i) => (
          <motion.button
            key={c.title}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
            whileHover={c.soon ? undefined : { y: -3 }}
            onClick={() => { if (c.soon) return; if (c.id) setActive(c.id); else c.action?.(); }}
            disabled={c.soon}
            className={`group relative overflow-hidden text-left p-5 bg-surface-50 rounded-2xl border border-white/[0.06] transition-all duration-200 ${
              c.soon ? "opacity-55 cursor-not-allowed" : "hover:bg-surface-100 hover:border-white/[0.12]"
            }`}
          >
            <span className={`absolute top-0 inset-x-0 h-1 bg-gradient-to-r to-transparent ${c.edge}`} />
            <div className="w-11 h-11 rounded-xl flex items-center justify-center mb-3" style={{ background: `${c.tint}1a` }}>
              <c.icon size={20} style={{ color: c.tint }} />
            </div>
            <div className="text-[14px] font-semibold text-slate-100 flex items-center gap-2">
              {c.title}
              {c.soon && <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/[0.05] text-slate-500">soon</span>}
            </div>
            <p className="text-[12px] text-slate-500 mt-1 leading-relaxed">{c.desc}</p>
            {!c.soon && (
              <div className="mt-3 flex items-center gap-1 text-[12px] font-medium text-accent-light opacity-0 group-hover:opacity-100 transition-opacity">
                Open <ArrowRight size={13} className="group-hover:translate-x-0.5 transition-transform" />
              </div>
            )}
          </motion.button>
        ))}
      </div>
    </div>
  );
}
