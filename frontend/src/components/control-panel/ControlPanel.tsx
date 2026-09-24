import { memo, useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, SlidersHorizontal, RefreshCw, Database, Share2 } from "lucide-react";
import { useLineageStore } from "../../store/lineageStore";
import { useFeatureFlagStore } from "../../store/featureFlagStore";
import SideNav from "../layout/SideNav";
import {
  getFeatureFlags,
  setFeatureFlag,
  getPlanCaptureStatus,
  getFederatedSyncStatus,
} from "../../api/controlPanel";
import type { FeatureFlagCard as FlagCardType } from "../../api/controlPanel";
import ModuleSection from "./ModuleSection";
import AccessRequirementsModal from "./AccessRequirementsModal";

interface Props {
  open: boolean;
  onClose: () => void;
}

function ControlPanel({ open, onClose }: Props) {
  const isAdmin = useLineageStore((s) => s.isAdmin);
  const {
    flags, loading, error, planCaptureStatus, federatedSyncStatus,
    setFlags, setLoading, setError, updateFlagEnabled, setPlanCaptureStatus, setFederatedSyncStatus,
  } = useFeatureFlagStore();
  const [busyFlagId, setBusyFlagId] = useState<string | null>(null);
  const [accessModalFlag, setAccessModalFlag] = useState<FlagCardType | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    getFeatureFlags()
      .then((r) => setFlags(r.flags))
      .catch((e: any) => setError(e.message || "Failed to load feature flags"));
    getPlanCaptureStatus().then(setPlanCaptureStatus).catch(() => {});
    getFederatedSyncStatus().then(setFederatedSyncStatus).catch(() => {});
  }, [setFlags, setLoading, setError, setPlanCaptureStatus, setFederatedSyncStatus]);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const handleToggle = useCallback(
    async (flagId: string, next: boolean) => {
      setBusyFlagId(flagId);
      updateFlagEnabled(flagId, next); // optimistic
      try {
        await setFeatureFlag(flagId, next);
        // Status cards depend on flag state — refresh after a confirmed change.
        getPlanCaptureStatus().then(setPlanCaptureStatus).catch(() => {});
        getFederatedSyncStatus().then(setFederatedSyncStatus).catch(() => {});
      } catch (e: any) {
        updateFlagEnabled(flagId, !next); // revert on failure
        setError(e.message || "Failed to update flag");
      } finally {
        setBusyFlagId(null);
      }
    },
    [updateFlagEnabled, setError, setPlanCaptureStatus, setFederatedSyncStatus],
  );

  const byModule = (label: string) => flags.filter((f) => f.module_label === label);

  if (!open) {
    return <AccessRequirementsModal flag={accessModalFlag} onClose={() => setAccessModalFlag(null)} />;
  }

  return (
    <div className="h-screen w-screen flex bg-surface overflow-hidden">
      <SideNav />
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 h-[68px] shrink-0 border-b border-white/[0.06]">
          <div className="flex items-center gap-3">
            <SlidersHorizontal size={16} className="text-accent" />
            <span className="font-semibold text-[15px] text-slate-100 tracking-tight">Control Panel</span>
            {!isAdmin && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/[0.04] text-slate-500 border border-white/[0.06]">
                Read-only — admin required to toggle
              </span>
            )}
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            className="text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-40"
            title="Refresh"
          >
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        {error && (
          <div className="px-6 py-3 text-[12px] text-red-400 bg-red-500/5 border-b border-red-500/10">{error}</div>
        )}

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-[820px] mx-auto p-6 space-y-6">
                <ModuleSection
                  moduleLabel="Lineage Tracking"
                  flags={byModule("Lineage Tracking")}
                  isAdmin={isAdmin}
                  busyFlagId={busyFlagId}
                  onToggle={handleToggle}
                  onOpenAccessCheck={setAccessModalFlag}
                  statusSlot={
                    planCaptureStatus ? (
                      <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
                        <Database size={10} />
                        {planCaptureStatus.captured_plan_count.toLocaleString()} plans · {planCaptureStatus.distinct_targets} tables
                      </div>
                    ) : null
                  }
                />
                <ModuleSection
                  moduleLabel="Column Transformation"
                  flags={byModule("Column Transformation")}
                  isAdmin={isAdmin}
                  busyFlagId={busyFlagId}
                  onToggle={handleToggle}
                  onOpenAccessCheck={setAccessModalFlag}
                />
                <ModuleSection
                  moduleLabel="Federated Sync"
                  flags={byModule("Federated Sync")}
                  isAdmin={isAdmin}
                  busyFlagId={busyFlagId}
                  onToggle={handleToggle}
                  onOpenAccessCheck={setAccessModalFlag}
                  statusSlot={
                    federatedSyncStatus ? (
                      <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
                        <Share2 size={10} />
                        {federatedSyncStatus.registered_peers} peers · {federatedSyncStatus.reachable_overlap} reachable
                      </div>
                    ) : null
                  }
                />
                <ModuleSection
                  moduleLabel="Metadata-Only Mode"
                  flags={byModule("Metadata-Only Mode")}
                  isAdmin={isAdmin}
                  busyFlagId={busyFlagId}
                  onToggle={handleToggle}
                  onOpenAccessCheck={setAccessModalFlag}
                />
                {!loading && flags.length === 0 && !error && (
                  <div className="text-center py-8 text-[12px] text-slate-500">No capabilities registered.</div>
                )}
          </div>
        </div>
      </div>
      <AccessRequirementsModal flag={accessModalFlag} onClose={() => setAccessModalFlag(null)} />
    </div>
  );
}

export default memo(ControlPanel);
