import { memo, useEffect, useState } from "react";
import {
  Home, Search, FolderOpen, Network, GitBranchPlus, ShieldCheck, FileBarChart,
  BookOpen, Bell, Download, Monitor, Radio, Settings as SettingsIcon, Shield,
  Database, ChevronDown, ChevronLeft,
} from "lucide-react";
import { useLineageStore } from "../../store/lineageStore";
import { useFeatureFlagEnabled } from "../../store/featureFlagStore";
import { api } from "../../api/client";
import {
  useRouter, goLanding, goCatalogs, goTableLineage, goDQ, goRootCause, goControlPanel,
  goGlossary, goNotifications, goExport, goBiConsumers, goStreaming, routeHref,
} from "../../hooks/useRouter";

type NavItem = {
  label: string;
  icon: typeof Home;
  /** Route views for which this item is highlighted. */
  views?: string[];
  action?: () => void;
  href?: string;
  adminOnly?: boolean;
};

// Primary destinations (mirror the home rail), then a secondary group so every
// screen the app can reach has an entry here — this rail replaces the old
// top-right hamburger menu.
const PRIMARY: NavItem[] = [
  { label: "Home", icon: Home, action: goLanding, views: ["landing"] },
  { label: "Search", icon: Search, action: () => useLineageStore.getState().setGlobalSearchOpen(true) },
  { label: "Lineage Explorer", icon: Network, action: goCatalogs, views: ["catalogs", "schemas", "tables", "lineage", "schemaLineage", "catalogLineage"] },
  { label: "Impact Analysis", icon: GitBranchPlus, action: () => goTableLineage(), views: ["tableLineage"] },
  { label: "Data Quality", icon: ShieldCheck, action: () => goDQ(), views: ["dq"] },
  { label: "Reports", icon: FileBarChart, action: goRootCause, views: ["rootCause"] },
];
const SECONDARY: NavItem[] = [
  { label: "Business Glossary", icon: BookOpen, action: goGlossary, views: ["glossary"] },
  { label: "Notifications", icon: Bell, action: goNotifications, views: ["notifications"] },
  { label: "OpenLineage Export", icon: Download, action: goExport, views: ["export"] },
  { label: "BI Consumers", icon: Monitor, action: goBiConsumers, views: ["biConsumers"] },
  { label: "Streaming Topology", icon: Radio, action: goStreaming, views: ["streaming"] },
];
const BOTTOM: NavItem[] = [
  { label: "Settings", icon: SettingsIcon, action: goControlPanel, views: ["controlPanel"] },
  { label: "Admin Dashboard", icon: Shield, href: routeHref({ view: "admin" }), adminOnly: true },
];

const COLLAPSE_KEY = "bt.sidenav.collapsed";

function readCollapsed(fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(COLLAPSE_KEY);
    return v == null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

/** Shared left navigation rail. `initialCollapsed` seeds the state (e.g. the graph
 *  view passes true to preserve width); the user's toggle is persisted globally. */
function SideNav({ initialCollapsed }: { initialCollapsed?: boolean }) {
  const isAdmin = useLineageStore((s) => s.isAdmin);
  const hideDataQuality = useFeatureFlagEnabled("metadata_only.hide_data_quality");
  const route = useRouter();
  const [collapsed, setCollapsed] = useState(() => readCollapsed(initialCollapsed ?? false));
  const [userEmail, setUserEmail] = useState<string | null>(null);

  useEffect(() => {
    api.getUserInfo().then((u) => setUserEmail(u.email)).catch(() => {});
  }, []);
  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch { /* private mode */ }
  }, [collapsed]);

  const initials = (userEmail || "AD").slice(0, 2).toUpperCase();

  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    const active = !!item.views?.includes(route.view);
    const cls = `w-full flex items-center gap-3 py-2.5 rounded-xl text-[13px] font-medium transition-all whitespace-nowrap ${collapsed ? "justify-center px-0" : "px-4"} ${
      active
        ? "bg-rose-500/30 text-[#fff1f2] border border-rose-300/50 shadow-[inset_0_0_16px_rgba(244,63,94,0.25)]"
        : "text-[#ffe4e6]/75 hover:text-[#fff1f2] hover:bg-white/[0.07] border border-transparent"
    }`;
    const body = (
      <>
        <Icon size={17} className="shrink-0" />
        {!collapsed && item.label}
      </>
    );
    return item.href ? (
      <a key={item.label} href={item.href} target="_blank" rel="noopener noreferrer"
         title={collapsed ? item.label : undefined} className={cls}>
        {body}
      </a>
    ) : (
      <button key={item.label} onClick={item.action} title={collapsed ? item.label : undefined} className={cls}>
        {body}
      </button>
    );
  };

  return (
    <aside className={`shrink-0 flex flex-col border-r border-white/10 bg-gradient-to-b from-[#4a0d17] to-[#29070f] text-[#fff1f2] transition-[width] duration-300 ease-out ${collapsed ? "w-[68px]" : "w-[248px]"}`}>
      {/* Logo */}
      <button
        onClick={goLanding}
        className={`flex items-center gap-2.5 h-[68px] shrink-0 hover:opacity-90 transition-opacity ${collapsed ? "justify-center px-0" : "px-5"}`}
        aria-label="Home"
      >
        <img src="/bricktrace-logo.png" alt="" className="w-10 h-10 object-contain shrink-0" />
        {!collapsed && (
          <span className="text-[19px] font-bold tracking-tight whitespace-nowrap">
            <span className="text-[#fff1f2]">Brick</span><span className="text-[#FF8A66]">Trace</span>
          </span>
        )}
      </button>

      {/* Nav */}
      <nav className="flex-1 px-3 py-2 space-y-1 overflow-y-auto overflow-x-hidden">
        {PRIMARY.filter((i) => !(hideDataQuality && i.label === "Data Quality")).map(renderItem)}
        <div className="my-2 border-t border-white/[0.08]" />
        {SECONDARY.map(renderItem)}
        <div className="my-2 border-t border-white/[0.08]" />
        {BOTTOM.filter((i) => !i.adminOnly || isAdmin).map(renderItem)}
      </nav>

      {/* Workspace selector — deferred (single-workspace app); visibly disabled. */}
      <div className="px-3 pb-3">
        {collapsed ? (
          <div className="flex justify-center py-2 text-[#fecdd3]/30" title="Multi-workspace — coming soon">
            <Database size={16} />
          </div>
        ) : (
          <div aria-disabled="true" title="Multi-workspace — coming soon"
               className="rounded-xl border border-white/[0.06] bg-black/15 px-3 py-2.5 opacity-45 cursor-not-allowed select-none">
            <div className="text-[9px] uppercase tracking-wider text-[#fecdd3]/40 font-medium mb-1">Workspace</div>
            <div className="flex items-center gap-2">
              <Database size={14} className="text-[#fecdd3]/45" />
              <span className="text-[12px] text-[#fecdd3]/60 flex-1 truncate">All Workspaces</span>
              <ChevronDown size={14} className="text-[#fecdd3]/35" />
            </div>
          </div>
        )}
      </div>

      {/* Signed-in user */}
      <div className="px-3 pb-2 border-t border-white/10 pt-3">
        <div title={collapsed ? (userEmail || "User") : undefined}
             className={`w-full flex items-center gap-2.5 py-1.5 ${collapsed ? "justify-center px-0" : "px-2"}`}>
          <span className="w-9 h-9 rounded-full bg-gradient-to-br from-orange-500 to-rose-600 flex items-center justify-center text-[12px] font-bold text-[#fff1f2] shrink-0">
            {initials}
          </span>
          {!collapsed && (
            <div className="text-left flex-1 min-w-0">
              <div className="text-[12px] font-semibold text-[#fff1f2] truncate">{userEmail ? userEmail.split("@")[0] : "User"}</div>
              <div className="text-[10px] text-[#fecdd3]/65 truncate">{userEmail || "—"}</div>
            </div>
          )}
        </div>
      </div>

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed((v) => !v)}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        className={`flex items-center gap-2.5 py-3 border-t border-white/10 bg-black/20 text-[#fecdd3]/75 hover:text-[#fff1f2] text-[12px] transition-colors ${collapsed ? "justify-center px-0" : "px-5"}`}
      >
        <ChevronLeft size={15} className={`shrink-0 transition-transform ${collapsed ? "rotate-180" : ""}`} />
        {!collapsed && <span>Collapse</span>}
      </button>
    </aside>
  );
}

export default memo(SideNav);
