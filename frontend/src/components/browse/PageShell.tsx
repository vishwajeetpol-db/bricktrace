import { memo, ReactNode } from "react";
import { motion } from "framer-motion";
import { Search } from "lucide-react";
import { useLineageStore } from "../../store/lineageStore";
import SideNav from "../layout/SideNav";
import HeaderActions from "../layout/HeaderActions";

interface Props {
  children: ReactNode;
  /** Page title shown at the left of the top bar. */
  subtitle?: string;
  /** When true, render children directly (no centered max-width container). */
  bare?: boolean;
}

function PageShell({
  children,
  subtitle = "Browse — click any table to explore its lineage",
  bare = false,
}: Props) {
  const setGlobalSearchOpen = useLineageStore((s) => s.setGlobalSearchOpen);

  return (
    <div className="h-screen w-screen flex bg-surface overflow-hidden">
      <SideNav />

      <div className="flex-1 min-w-0 flex flex-col relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(99,102,241,0.04)_0%,transparent_50%)] pointer-events-none" />

        {/* Slim top bar — page title + global search (nav lives in the rail) */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative z-10 flex items-center gap-4 px-8 h-[68px] shrink-0 border-b border-white/[0.06]"
        >
          <h1 className="text-[15px] font-semibold text-slate-200 tracking-tight truncate">{subtitle}</h1>
          <div className="ml-auto flex items-center gap-4">
            <button
              onClick={() => setGlobalSearchOpen(true)}
              className="flex items-center gap-2 px-3 py-2 bg-surface-50/80 hover:bg-surface-50 border border-white/[0.06] hover:border-accent/30 rounded-lg text-[12px] text-slate-400 hover:text-slate-200 transition-all duration-200 w-72"
            >
              <Search size={13} />
              <span className="font-mono">Search any table...</span>
              <kbd className="ml-auto text-[10px] text-slate-600 bg-surface-200 px-1.5 py-0.5 rounded font-mono">⌘K</kbd>
            </button>
            <HeaderActions />
          </div>
        </motion.div>

        {/* Content area */}
        <div className="relative z-10 flex-1 overflow-y-auto scrollbar-thin">
          {bare ? (
            children
          ) : (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.05 }}
              className="max-w-6xl mx-auto px-8 py-8"
            >
              {children}
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}

export default memo(PageShell);
