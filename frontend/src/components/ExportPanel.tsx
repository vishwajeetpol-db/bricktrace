import { useState, useEffect, useMemo } from 'react';
import {
  Share2, Download, Copy, Eye, CheckCircle2, AlertTriangle, Loader2, Camera,
  FileJson, Upload, ShieldCheck, Columns3, BookText, UserRound, GitBranch, Clock, Check,
} from 'lucide-react';
import { useLineageStore } from '../store/lineageStore';
import { api } from '../api/client';

/**
 * ExportPanel — OpenLineage export/import + graph snapshots.
 * Covers capabilities 07 (Versioned Lineage) and 17 (Open Standards).
 *
 * The export tab emits canonical OpenLineage 2.0.2 RunEvents (Marquez / DataHub
 * / Atlan / OpenMetadata compatible): choose which facets to include, preview
 * the payload + conformance, then copy or download as JSON or ND-JSON.
 */

interface Conformance { valid: boolean; event_count: number; invalid_count: number; issues: { event_index: number; issue: string }[] }
interface Preview { events: any[]; count: number; namespace: string; byte_size: number; conformance: Conformance }

type FacetKey = 'schema' | 'column_lineage' | 'ownership' | 'docs' | 'data_quality';
const FACETS: { key: FacetKey; label: string; icon: typeof Columns3; hint: string }[] = [
  { key: 'schema', label: 'Schema', icon: Columns3, hint: 'Column names + types' },
  { key: 'column_lineage', label: 'Column lineage', icon: GitBranch, hint: 'Field-to-field mapping' },
  { key: 'ownership', label: 'Ownership', icon: UserRound, hint: 'Table owner' },
  { key: 'docs', label: 'Documentation', icon: BookText, hint: 'Table comments' },
  { key: 'data_quality', label: 'Data quality', icon: ShieldCheck, hint: 'App-managed DQ rules' },
];

export function ExportPanel({ catalog = '', schema = '' }: { catalog?: string; schema?: string }) {
  // Importing OpenLineage events injects lineage into the shared graph, so the
  // backend admin-gates it. Hide the tab for non-admins rather than showing a
  // control that always 403s.
  const isAdmin = useLineageStore((s) => s.isAdmin);
  const allTables = useLineageStore((s) => s.allTables);
  const setAllTables = useLineageStore((s) => s.setAllTables);
  const [activeTab, setActiveTab] = useState<'export' | 'import' | 'snapshots'>('export');

  // Scope is self-service: seed from the browsed catalog/schema (props) but let
  // the user pick, so reaching this screen from the sidebar (no browse context)
  // still works instead of leaving the export permanently disabled.
  const [scopeCatalog, setScopeCatalog] = useState(catalog);
  const [scopeSchema, setScopeSchema] = useState(schema);

  // Load the table index if it isn't already hydrated (direct entry point).
  useEffect(() => {
    if (allTables.length === 0) {
      api.getTables().then((d) => setAllTables(d.tables || [])).catch(() => { /* picker stays empty */ });
    }
  }, [allTables.length, setAllTables]);

  const catalogs = useMemo(
    () => Array.from(new Set(allTables.map((t) => t.catalog))).filter(Boolean).sort(),
    [allTables],
  );
  const schemas = useMemo(
    () => Array.from(new Set(allTables.filter((t) => t.catalog === scopeCatalog).map((t) => t.schema))).filter(Boolean).sort(),
    [allTables, scopeCatalog],
  );

  // Export controls
  const [facets, setFacets] = useState<Record<FacetKey, boolean>>({
    schema: true, column_lineage: true, ownership: true, docs: true, data_quality: false,
  });
  const [fmt, setFmt] = useState<'json' | 'ndjson'>('json');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const [importData, setImportData] = useState('');
  const [importResult, setImportResult] = useState<any>(null);
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);

  const exportParams = (format: 'json' | 'ndjson') => {
    const p = new URLSearchParams({ catalog: scopeCatalog, format });
    if (scopeSchema) p.set('schema', scopeSchema);
    p.set('include_schema', String(facets.schema));
    p.set('include_column_lineage', String(facets.column_lineage));
    p.set('include_ownership', String(facets.ownership));
    p.set('include_docs', String(facets.docs));
    p.set('include_data_quality', String(facets.data_quality));
    return p;
  };

  const runPreview = async () => {
    setPreviewing(true);
    setExportError(null);
    try {
      const res = await fetch(`/api/export/openlineage?${exportParams('json')}`);
      if (!res.ok) { setExportError(`Preview failed (HTTP ${res.status})`); return; }
      setPreview(await res.json());
    } catch {
      setExportError('Preview failed — could not reach the server.');
    } finally {
      setPreviewing(false);
    }
  };

  const download = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch(`/api/export/openlineage?${exportParams(fmt)}`);
      if (!res.ok) { setExportError(`Export failed (HTTP ${res.status})`); return; }
      let text: string;
      if (fmt === 'ndjson') {
        text = await res.text();
      } else {
        const data = await res.json();
        setPreview(data);
        text = JSON.stringify(data.events ?? data, null, 2);
      }
      const blob = new Blob([text], { type: fmt === 'ndjson' ? 'application/x-ndjson' : 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `openlineage_${scopeCatalog}${scopeSchema ? '.' + scopeSchema : ''}_${new Date().toISOString().slice(0, 10)}.${fmt === 'ndjson' ? 'ndjson' : 'json'}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setExportError('Export failed — could not reach the server.');
    } finally {
      setExporting(false);
    }
  };

  const copyPayload = async () => {
    const data = preview ?? (await (await fetch(`/api/export/openlineage?${exportParams('json')}`)).json());
    setPreview(data);
    const text = fmt === 'ndjson'
      ? (data.events ?? []).map((e: any) => JSON.stringify(e)).join('\n')
      : JSON.stringify(data.events ?? data, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setExportError('Clipboard unavailable in this browser.');
    }
  };

  const handleImportOpenLineage = async () => {
    try {
      const events = JSON.parse(importData);
      const res = await fetch('/api/import/openlineage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: Array.isArray(events) ? events : [events] }),
      });
      setImportResult(await res.json());
    } catch (e: any) {
      setImportResult({ error: e.message });
    }
  };

  const loadSnapshots = async () => {
    setSnapshotLoading(true);
    try {
      const params = scopeCatalog ? `?scope=${scopeCatalog}${scopeSchema ? '.' + scopeSchema : ''}` : '';
      const res = await fetch(`/api/snapshots${params}`);
      const data = await res.json();
      setSnapshots(data.snapshots || []);
    } catch (e) {
      console.error('Failed to load snapshots:', e);
    } finally {
      setSnapshotLoading(false);
    }
  };

  const captureSnapshot = async () => {
    setCaptureError(null);
    if (!scopeCatalog) { setCaptureError('Select a catalog before capturing a snapshot.'); return; }
    try {
      const res = await fetch('/api/snapshots/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ catalog: scopeCatalog, schema_name: scopeSchema || null }),
      });
      if (!res.ok) {
        let detail = `Capture failed (HTTP ${res.status})`;
        try { const body = await res.json(); if (body?.detail) detail = String(body.detail); } catch { /* keep */ }
        setCaptureError(detail);
        return;
      }
      const data = await res.json();
      alert(`Snapshot captured: ${data.node_count} nodes, ${data.edge_count} edges`);
      loadSnapshots();
    } catch (e) {
      console.error('Capture failed:', e);
      setCaptureError('Capture failed — could not reach the server.');
    }
  };

  const tabs: { key: typeof activeTab; label: string }[] = [
    { key: 'export', label: 'OpenLineage Export' },
    ...(isAdmin ? [{ key: 'import' as const, label: 'Import Events' }] : []),
    { key: 'snapshots', label: 'Graph Snapshots' },
  ];

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-2 mb-1">
        <Share2 size={16} className="text-accent" />
        <h2 className="text-[18px] font-bold text-white tracking-tight">Export &amp; Interop</h2>
      </div>
      <p className="text-[13px] text-slate-500 mb-6">Canonical OpenLineage 2.0.2 — Marquez, DataHub, Atlan &amp; OpenMetadata compatible.</p>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 bg-surface-50 rounded-xl p-1 border border-white/[0.06] w-fit">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => { setActiveTab(t.key); if (t.key === 'snapshots') loadSnapshots(); }}
            className={`px-3.5 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${
              activeTab === t.key ? 'bg-accent text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'export' && (
        <div className="space-y-4">
          <div className="p-4 bg-surface-50 rounded-xl border border-white/[0.06]">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[11px] uppercase tracking-wider text-slate-500">Scope</div>
              <FileJson size={18} className="text-slate-600" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Catalog"
                value={scopeCatalog}
                onChange={(e) => { setScopeCatalog(e.target.value); setScopeSchema(''); setPreview(null); }}
                className="px-3 py-2 bg-surface-100 border border-white/[0.08] rounded-lg text-[13px] font-mono text-slate-200 focus:border-accent/40 focus:outline-none min-w-[200px]"
              >
                <option value="">Select a catalog…</option>
                {/* Keep the seeded catalog selectable even before the index loads. */}
                {scopeCatalog && !catalogs.includes(scopeCatalog) && <option value={scopeCatalog}>{scopeCatalog}</option>}
                {catalogs.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select
                aria-label="Schema"
                value={scopeSchema}
                onChange={(e) => { setScopeSchema(e.target.value); setPreview(null); }}
                disabled={!scopeCatalog}
                className="px-3 py-2 bg-surface-100 border border-white/[0.08] rounded-lg text-[13px] font-mono text-slate-200 focus:border-accent/40 focus:outline-none disabled:opacity-50 min-w-[180px]"
              >
                <option value="">All schemas</option>
                {scopeSchema && !schemas.includes(scopeSchema) && <option value={scopeSchema}>{scopeSchema}</option>}
                {schemas.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <span className="text-[12px] font-mono text-accent-light">
                {scopeCatalog ? `${scopeCatalog}${scopeSchema ? '.' + scopeSchema : ' · all schemas'}` : 'no scope selected'}
              </span>
            </div>
          </div>

          {/* Facet toggles */}
          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">Facets to include</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {FACETS.map((f) => {
                const on = facets[f.key];
                const Icon = f.icon;
                return (
                  <button
                    key={f.key}
                    onClick={() => setFacets((cur) => ({ ...cur, [f.key]: !cur[f.key] }))}
                    aria-pressed={on}
                    className={`flex items-start gap-2.5 p-3 rounded-xl border text-left transition-colors ${
                      on ? 'bg-accent/10 border-accent/40' : 'bg-surface-50 border-white/[0.06] hover:border-white/[0.12]'
                    }`}
                  >
                    <span className={`mt-0.5 w-4 h-4 rounded flex items-center justify-center shrink-0 border ${on ? 'bg-accent border-accent' : 'border-white/20'}`}>
                      {on && <Check size={11} className="text-white" />}
                    </span>
                    <span className="min-w-0">
                      <span className={`flex items-center gap-1.5 text-[12.5px] font-medium ${on ? 'text-slate-100' : 'text-slate-300'}`}>
                        <Icon size={12} className={on ? 'text-accent-light' : 'text-slate-500'} /> {f.label}
                      </span>
                      <span className="block text-[11px] text-slate-500 mt-0.5">{f.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Format + actions */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-0.5 rounded-lg bg-surface-50 border border-white/[0.06] p-0.5">
              {(['json', 'ndjson'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFmt(f)}
                  className={`px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
                    fmt === f ? 'bg-accent text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {f === 'json' ? 'JSON' : 'ND-JSON'}
                </button>
              ))}
            </div>
            <button onClick={runPreview} disabled={!scopeCatalog || previewing}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-surface-100 border border-white/[0.08] text-slate-200 rounded-lg text-[13px] font-medium hover:border-accent/40 disabled:opacity-50 transition-colors">
              {previewing ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />} Preview
            </button>
            <button onClick={download} disabled={!scopeCatalog || exporting}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-accent text-white rounded-lg text-[13px] font-medium hover:bg-accent-dark disabled:opacity-50 transition-colors">
              {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Export as OpenLineage JSON
            </button>
            <button onClick={copyPayload} disabled={!scopeCatalog}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-surface-100 border border-white/[0.08] text-slate-200 rounded-lg text-[13px] font-medium hover:border-accent/40 disabled:opacity-50 transition-colors">
              {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>

          {exportError && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[13px] text-rose-300">{exportError}</div>
          )}

          {/* Preview + conformance */}
          {preview && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-[12px] text-slate-400"><span className="text-slate-100 font-semibold">{preview.count}</span> events</span>
                <span className="text-[12px] text-slate-400"><span className="text-slate-100 font-semibold">{(preview.byte_size / 1024).toFixed(1)}</span> KB</span>
                <span className="text-[12px] text-slate-500 font-mono truncate">{preview.namespace}</span>
                {preview.conformance?.valid ? (
                  <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 text-[11px] font-semibold border border-emerald-500/25">
                    <CheckCircle2 size={12} /> OpenLineage 2.0.2 conformant
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 text-[11px] font-semibold border border-amber-500/25">
                    <AlertTriangle size={12} /> {preview.conformance?.invalid_count} non-conformant
                  </span>
                )}
              </div>
              {preview.conformance && !preview.conformance.valid && preview.conformance.issues.length > 0 && (
                <ul className="text-[11px] text-amber-300/90 list-disc pl-5 space-y-0.5">
                  {preview.conformance.issues.slice(0, 5).map((iss, i) => (
                    <li key={i}>event {iss.event_index}: {iss.issue}</li>
                  ))}
                </ul>
              )}
              {preview.events.length > 0 && (
                <pre className="p-3 bg-surface-100 rounded-xl border border-white/[0.06] text-[11px] text-slate-300 overflow-auto max-h-80 scrollbar-thin font-mono">
                  {JSON.stringify(preview.events[0], null, 2)}
                </pre>
              )}
              {preview.count === 0 && (
                <p className="text-[12px] text-slate-500">No producing entities in scope — nothing to export. Try a broader catalog/schema.</p>
              )}
            </div>
          )}
        </div>
      )}

      {activeTab === 'import' && (
        <div className="space-y-4">
          <p className="text-slate-500 text-[13px] flex items-center gap-1.5">
            <Upload size={13} /> Paste OpenLineage RunEvent JSON to import external lineage into the graph.
          </p>
          <textarea value={importData} onChange={(e) => setImportData(e.target.value)}
            placeholder='{"eventType": "COMPLETE", "job": {...}, "inputs": [...], "outputs": [...]}'
            className="w-full h-48 px-4 py-3 bg-surface-50 border border-white/[0.08] rounded-xl text-slate-200 font-mono text-xs focus:border-accent/40 focus:outline-none" />
          <button onClick={handleImportOpenLineage} disabled={!importData}
            className="flex items-center gap-1.5 px-4 py-2 bg-accent text-white rounded-lg text-[13px] font-medium hover:bg-accent-dark disabled:opacity-50 transition-colors">
            <Upload size={14} /> Import Events
          </button>
          {importResult && (
            <pre className="p-3 bg-surface-100 rounded-xl border border-white/[0.06] text-xs text-slate-300 overflow-auto scrollbar-thin">
              {JSON.stringify(importResult, null, 2)}
            </pre>
          )}
        </div>
      )}

      {activeTab === 'snapshots' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-slate-500 text-[13px] flex items-center gap-1.5"><Clock size={13} /> Point-in-time graph snapshots for historical comparison.</p>
            <button onClick={captureSnapshot} disabled={!scopeCatalog}
              title={!scopeCatalog ? 'Select a catalog first' : undefined}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-accent text-white rounded-lg text-[13px] font-medium hover:bg-accent-dark disabled:opacity-50 transition-colors">
              <Camera size={14} /> Capture Now
            </button>
          </div>
          {captureError && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[13px] text-rose-300">{captureError}</div>
          )}
          {snapshotLoading ? <p className="text-slate-500 text-[13px]">Loading...</p> :
            snapshots.length === 0 ? (
              <div className="p-8 text-center bg-surface-50 rounded-xl border border-white/[0.06]">
                <Camera size={22} className="text-slate-600 mx-auto mb-2" />
                <p className="text-slate-500 text-[13px]">No snapshots yet. Capture one to start tracking changes.</p>
              </div>
            ) :
            <div className="space-y-2">
              {snapshots.map((s: any) => (
                <div key={s.snapshot_id} className="p-3 bg-surface-50 rounded-xl border border-white/[0.06] flex items-center justify-between">
                  <div>
                    <p className="text-slate-100 text-[13px] font-medium">{s.label || s.scope}</p>
                    <p className="text-[11px] text-slate-500">{new Date(s.captured_at).toLocaleString()} · {s.node_count} nodes · {s.edge_count} edges</p>
                  </div>
                  <span className="text-[11px] text-slate-600 font-mono">{s.snapshot_id.slice(0, 8)}</span>
                </div>
              ))}
            </div>
          }
        </div>
      )}
    </div>
  );
}
