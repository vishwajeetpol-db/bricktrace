import { useCallback, useEffect, useRef } from "react";
import { ReactFlowProvider } from "reactflow";
import Toolbar from "./components/layout/Toolbar";
import LineageCanvas from "./components/graph/LineageCanvas";
import AdminDashboard from "./components/AdminDashboard";
import ControlPanel from "./components/control-panel/ControlPanel";
import Landing from "./components/landing/Landing";
import GlobalSearch from "./components/landing/GlobalSearch";
import LineagePreview from "./components/lineage/LineagePreview";
import TransformPanel from "./components/transform/TransformPanel";
import { DQMetricsPanel } from "./components/DQMetricsPanel";
import { GlossaryPanel } from "./components/GlossaryPanel";
import { NotificationsPanel } from "./components/NotificationsPanel";
import { ExportPanel } from "./components/ExportPanel";
import { ReportsHub } from "./components/reports/ReportsHub";
import TableLineageWorkspace from "./components/table-lineage/TableLineageWorkspace";
import { BiConsumersPanel } from "./components/BiConsumersPanel";
import { StreamingTopologyPanel } from "./components/StreamingTopologyPanel";
import CatalogListView from "./components/browse/CatalogListView";
import SchemaListView from "./components/browse/SchemaListView";
import TableListView from "./components/browse/TableListView";
import PageShell from "./components/browse/PageShell";
import SideNav from "./components/layout/SideNav";
import { useLineageStore } from "./store/lineageStore";
import { useFeatureFlagStore, useFeatureFlagEnabled } from "./store/featureFlagStore";
import { getFeatureFlags } from "./api/controlPanel";
import { api, setLiveMode } from "./api/client";
import { useRouter, goLineage, goLanding } from "./hooks/useRouter";
import { useRecents } from "./hooks/useRecents";

const TABLE_LOAD_MAX_RETRIES = 3;
const TABLE_LOAD_RETRY_DELAY = 2000;

export default function App() {
  const route = useRouter();
  const { addRecent } = useRecents();
  const focusTable = useLineageStore((s) => s.focusTable);
  const scope = useLineageStore((s) => s.scope);
  const catalog = useLineageStore((s) => s.catalog);
  const schema = useLineageStore((s) => s.schema);
  const liveMode = useLineageStore((s) => s.liveMode);
  const isAdmin = useLineageStore((s) => s.isAdmin);
  const hideDataQuality = useFeatureFlagEnabled("metadata_only.hide_data_quality");
  const hideReports = useFeatureFlagEnabled("metadata_only.hide_reports");
  const retryCount = useRef(0);
  const lineageAbortRef = useRef<AbortController | null>(null);

  // Fetch user info (admin status) on mount
  useEffect(() => {
    api.getUserInfo()
      .then((info) => useLineageStore.getState().setIsAdmin(info.isAdmin))
      .catch(() => useLineageStore.getState().setIsAdmin(false));
  }, []);

  // Load feature flags app-wide so the nav + routes can honour metadata-only toggles.
  useEffect(() => {
    getFeatureFlags()
      .then((r) => useFeatureFlagStore.getState().setFlags(r.flags))
      .catch(() => { /* nav falls back to showing everything */ });
  }, []);

  // R5: Check system-table / SP-grant health on mount and surface as a banner
  useEffect(() => {
    api.getHealth()
      .then((h) => {
        const sh = h.system_health;
        if (!sh.system_tables_available) {
          useLineageStore.getState().setHealthWarning(
            "System tables unavailable — lineage data cannot be fetched. " +
            "Ensure the service principal has SELECT on system.access.table_lineage."
          );
        } else if (!sh.sp_grants_valid) {
          const missing = sh.missing_grants.join(", ");
          useLineageStore.getState().setHealthWarning(
            `Service-principal grants incomplete. Missing: ${missing}`
          );
        } else {
          useLineageStore.getState().setHealthWarning(null);
        }
      })
      .catch(() => { /* health check failure is non-blocking */ });
  }, []);

  // Load all tables on mount with retry (transient failures only — 4xx aren't retried)
  const loadTables = useCallback(() => {
    useLineageStore.getState().setAllTablesLoading(true);
    api.getTables()
      .then((r) => {
        if (r.tables.length > 0) {
          retryCount.current = 0;
          useLineageStore.getState().setAllTables(r.tables);
        } else if (retryCount.current < TABLE_LOAD_MAX_RETRIES) {
          retryCount.current++;
          setTimeout(loadTables, TABLE_LOAD_RETRY_DELAY);
        } else {
          useLineageStore.getState().setAllTables([]);
        }
      })
      .catch((e: any) => {
        console.error("Failed to load tables:", e);
        const msg = String(e?.message || "");
        const is4xx = /API error 4\d\d/.test(msg);
        if (!is4xx && retryCount.current < TABLE_LOAD_MAX_RETRIES) {
          retryCount.current++;
          setTimeout(loadTables, TABLE_LOAD_RETRY_DELAY);
        } else {
          useLineageStore.getState().setAllTablesLoading(false);
        }
      });
  }, []);

  useEffect(() => {
    loadTables();
  }, [loadTables]);

  // Fetch lineage for a catalog/schema. An empty schema fetches catalog-wide
  // lineage across every schema. Cancels any in-flight request so quick switches don't race.
  const fetchLineage = useCallback(async (cat: string, sch: string) => {
    setLiveMode(useLineageStore.getState().liveMode);
    lineageAbortRef.current?.abort();
    const controller = new AbortController();
    lineageAbortRef.current = controller;
    useLineageStore.setState({ loading: true, error: null });
    try {
      const data = sch
        ? await api.getLineage(cat, sch, controller.signal)
        : await api.getCatalogLineage(cat, controller.signal);
      if (controller.signal.aborted) return;
      useLineageStore.getState().setLineageData({
        nodes: data.nodes,
        edges: data.edges,
        cached: data.cached,
        cachedAt: data.cached_at,
        cacheExpiresAt: data.cache_expires_at,
        fetchDurationMs: data.fetch_duration_ms,
        lineageWindowDays: data.lineage_window_days,
        truncated: data.truncated,
        graphWarnings: data.graph_warnings ?? null,
      });
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      useLineageStore.getState().setError(err.message || "Failed to load lineage data");
    }
  }, []);

  // Selecting any object (table) auto-loads its COMPLETE end-to-end lineage —
  // every source back to every target, across catalogs/schemas/Delta Sharing —
  // via the cross-catalog trace. No manual action; the only knob is view mode.
  const fetchTrace = useCallback(async (table: string) => {
    setLiveMode(useLineageStore.getState().liveMode);
    lineageAbortRef.current?.abort();
    const controller = new AbortController();
    lineageAbortRef.current = controller;
    useLineageStore.setState({ loading: true, error: null });
    try {
      const data = await api.getLineageTrace(table, controller.signal);
      if (controller.signal.aborted) return;
      useLineageStore.getState().setLineageData({
        nodes: data.nodes,
        edges: data.edges,
        // Precise (source_table → target_table) pairs. Without forwarding these the
        // store resets tableEdges to [], and business "Data only" falls back to
        // cross-producting each entity's inputs × outputs — the dense mesh.
        tableEdges: data.table_edges ?? [],
        cached: data.cached,
        cachedAt: data.cached_at,
        cacheExpiresAt: data.cache_expires_at,
        fetchDurationMs: data.fetch_duration_ms,
        lineageWindowDays: data.lineage_window_days,
        truncated: data.truncated,
        graphWarnings: data.graph_warnings ?? null,
      });
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      useLineageStore.getState().setError(err.message || "Failed to load lineage data");
    }
  }, []);

  // Sync the rendered graph from the route. Handles deep links, back/forward,
  // table-focused lineage, whole-schema lineage, and whole-catalog lineage.
  useEffect(() => {
    const store = useLineageStore.getState();
    if (route.view === "lineage") {
      if (store.focusTable !== route.table) {
        store.setFocusTable(route.table);
        addRecent(route.table);
        fetchTrace(route.table);
      }
    } else if (route.view === "schemaLineage") {
      const matches = store.scope === "schema" && !store.focusTable
        && store.catalog === route.catalog && store.schema === route.schema;
      if (!matches) {
        store.enterScopeLineage("schema", route.catalog, route.schema);
        fetchLineage(route.catalog, route.schema);
      }
    } else if (route.view === "catalogLineage") {
      const matches = store.scope === "catalog" && !store.focusTable
        && store.catalog === route.catalog;
      if (!matches) {
        store.enterScopeLineage("catalog", route.catalog, "");
        fetchLineage(route.catalog, "");
      }
    } else if (route.view === "tableLineage") {
      // The Table Lineage workspace owns its own graph loading (via the tree
      // selection); don't let the route-sync effect clear focusTable here.
    } else if (store.focusTable) {
      store.setFocusTable(null);
    }
  }, [route, focusTable, addRecent, fetchLineage, fetchTrace]);

  // Re-fetch lineage when live mode is toggled (if a graph is currently loaded)
  const prevLiveMode = useRef(liveMode);
  useEffect(() => {
    if (prevLiveMode.current !== liveMode && catalog && (schema || focusTable || scope === "catalog")) {
      if (focusTable) fetchTrace(focusTable);
      else fetchLineage(catalog, schema);
    }
    prevLiveMode.current = liveMode;
  }, [liveMode, focusTable, catalog, schema, scope, fetchLineage, fetchTrace]);

  // Navigation handler called by Landing / search / drill-down / etc.
  const handleSelectTable = useCallback((fqdn: string) => {
    goLineage(fqdn);
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!catalog || !schema) return;
    fetchLineage(catalog, schema);
  }, [catalog, schema, fetchLineage]);

  // === Render by route ===

  if (route.view === "admin") {
    if (!isAdmin) {
      return (
        <div className="h-screen w-screen flex items-center justify-center bg-surface">
          <div className="text-center">
            <div className="text-red-400 text-[14px] font-medium mb-2">Access Denied</div>
            <div className="text-slate-500 text-[13px]">Admin dashboard is only available to workspace admins.</div>
          </div>
        </div>
      );
    }
    return <AdminDashboard open={true} onClose={() => window.close()} />;
  }

  if (route.view === "controlPanel") {
    // Readable by any authenticated user — toggles are admin-gated inside the
    // panel itself (see FeatureToggleCard), so a non-admin can still see what
    // capabilities exist and their access requirements.
    return <ControlPanel open={true} onClose={goLanding} />;
  }

  if (route.view === "dq" && !hideDataQuality) {
    return (
      <>
        <PageShell subtitle="Column-level data quality metrics" bare>
          <DQMetricsPanel tableFqn={route.table} />
        </PageShell>
        <GlobalSearch onSelectTable={handleSelectTable} />
      </>
    );
  }

  if (route.view === "glossary") {
    return (
      <>
        <PageShell subtitle="Business glossary" bare>
          <GlossaryPanel />
        </PageShell>
        <GlobalSearch onSelectTable={handleSelectTable} />
      </>
    );
  }

  if (route.view === "notifications") {
    return (
      <>
        <PageShell subtitle="Recent activity & alerts" bare>
          <NotificationsPanel />
        </PageShell>
        <GlobalSearch onSelectTable={handleSelectTable} />
      </>
    );
  }

  if (route.view === "export") {
    return (
      <>
        <PageShell subtitle="OpenLineage export & interop" bare>
          {/* catalog/schema are required — the capture endpoint rejects an empty
              scope, so mounting without them made "Capture Now" always 400. */}
          <ExportPanel catalog={catalog} schema={schema} />
        </PageShell>
        <GlobalSearch onSelectTable={handleSelectTable} />
      </>
    );
  }

  if (route.view === "rootCause" && !hideReports) {
    return (
      <>
        <PageShell subtitle="Reports" bare>
          <div className="max-w-6xl mx-auto px-8 py-8">
            <ReportsHub onSelectTable={handleSelectTable} />
          </div>
        </PageShell>
        <GlobalSearch onSelectTable={handleSelectTable} />
      </>
    );
  }

  if (route.view === "biConsumers") {
    return (
      <>
        <PageShell subtitle="BI & dashboard consumers" bare>
          <BiConsumersPanel />
        </PageShell>
        <GlobalSearch onSelectTable={handleSelectTable} />
      </>
    );
  }

  if (route.view === "streaming") {
    return (
      <>
        <PageShell subtitle="Streaming topology" bare>
          <StreamingTopologyPanel />
        </PageShell>
        <GlobalSearch onSelectTable={handleSelectTable} />
      </>
    );
  }

  if (route.view === "tableLineage") {
    return <TableLineageWorkspace initialTable={route.table} />;
  }

  if (route.view === "lineage" || route.view === "schemaLineage" || route.view === "catalogLineage") {
    return (
      <>
        <ReactFlowProvider>
          <div className="h-screen w-screen flex overflow-hidden bg-surface">
            <SideNav initialCollapsed />
            <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
              <Toolbar onGenerate={handleGenerate} />
              <div className="flex-1 relative">
                <LineageCanvas />
              </div>
            </div>
          </div>
        </ReactFlowProvider>
        <GlobalSearch onSelectTable={handleSelectTable} />
        <LineagePreview />
        <TransformPanel />
      </>
    );
  }

  if (route.view === "catalogs") {
    return (
      <>
        <CatalogListView />
        <GlobalSearch onSelectTable={handleSelectTable} />
      </>
    );
  }

  if (route.view === "schemas") {
    return (
      <>
        <SchemaListView catalog={route.catalog} />
        <GlobalSearch onSelectTable={handleSelectTable} />
      </>
    );
  }

  if (route.view === "tables") {
    return (
      <>
        <TableListView catalog={route.catalog} schema={route.schema} onSelectTable={handleSelectTable} />
        <GlobalSearch onSelectTable={handleSelectTable} />
      </>
    );
  }

  // Default: landing
  return (
    <>
      <Landing onSelectTable={handleSelectTable} />
      <GlobalSearch onSelectTable={handleSelectTable} />
    </>
  );
}
