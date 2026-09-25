import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  BookMarked, Search, Sparkles, Layers, Gauge, Link2, GitBranch, X, Check,
  Loader2, ChevronRight, Target, Boxes, ArrowRight, Plus,
} from 'lucide-react';
import { useLineageStore } from '../store/lineageStore';
import { api } from '../api/client';
import { goTableLineage } from '../hooks/useRouter';

interface Term {
  term_id: string;
  name: string;
  definition: string;
  domain: string;
  owner: string;
  status: string;
  synonyms: string;
}

interface Domain {
  domain_id: string;
  name: string;
  description: string;
  owner: string;
  color: string;
}

interface Kpi {
  kpi_id: string;
  name: string;
  definition: string;
  formula_sql: string;
  source_tables: string;
  owner: string;
  domain: string;
  granularity: string;
}

interface AssetLink {
  link_id?: string;
  term_id: string;
  asset_type: string;
  asset_fqn: string;
  column_name?: string;
}

interface MissingTerm { term_id: string; name: string; domain?: string }
interface Suggestion { target_table: string; missing_terms: MissingTerm[] }
interface PropagationResult {
  source_table: string;
  source_terms: { term_id: string; term_name: string; domain?: string }[];
  downstream_count: number;
  suggestions: Suggestion[];
  suggestion_count: number;
  note?: string;
}

type Tab = 'terms' | 'domains' | 'kpis' | 'propagation';

async function jget<T = any>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Split a 3-part FQN into its parts, or null if it isn't a plain table id. */
function splitFqn(fqn: string): { catalog: string; schema: string; table: string } | null {
  const p = fqn.trim().split('.');
  if (p.length !== 3 || p.some((s) => !s)) return null;
  return { catalog: p[0], schema: p[1], table: p[2] };
}

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
  approved: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25',
  deprecated: 'bg-rose-500/15 text-rose-300 border-rose-500/25',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${STATUS_STYLES[status] || 'bg-white/[0.05] text-slate-400 border-white/10'}`}>
      {status}
    </span>
  );
}

function StatCard({ icon: Icon, label, value, tint, sub }: {
  icon: typeof BookMarked; label: string; value: React.ReactNode; tint: string; sub?: string;
}) {
  return (
    <div className="relative overflow-hidden p-4 bg-surface-50 rounded-2xl border border-white/[0.06]">
      <span className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r to-transparent" style={{ backgroundImage: `linear-gradient(to right, ${tint}b3, transparent)` }} />
      <div className="flex items-center gap-2.5">
        <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${tint}1a` }}>
          <Icon size={17} style={{ color: tint }} />
        </span>
        <div className="min-w-0">
          <div className="text-[20px] font-bold text-slate-100 leading-none">{value}</div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mt-1">{label}</div>
        </div>
      </div>
      {sub && <div className="text-[11px] text-slate-500 mt-2">{sub}</div>}
    </div>
  );
}

export function GlossaryPanel() {
  const isAdmin = useLineageStore((s) => s.isAdmin);
  const allTables = useLineageStore((s) => s.allTables);
  const setAllTables = useLineageStore((s) => s.setAllTables);

  const [terms, setTerms] = useState<Term[]>([]);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [kpis, setKpis] = useState<Kpi[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>('terms');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Add/edit forms (one visible at a time, per tab).
  const [showTermForm, setShowTermForm] = useState(false);
  const [termForm, setTermForm] = useState<Partial<Term>>({ name: '', definition: '', domain: '', owner: '', status: 'draft', synonyms: '' });
  const [showDomainForm, setShowDomainForm] = useState(false);
  const [domainForm, setDomainForm] = useState<Partial<Domain>>({ name: '', description: '', owner: '', color: '#FF4520' });
  const [showKpiForm, setShowKpiForm] = useState(false);
  const [kpiForm, setKpiForm] = useState<Partial<Kpi>>({ name: '', definition: '', formula_sql: '', source_tables: '', owner: '', domain: '', granularity: 'daily' });

  // Per-term expansion → linked assets + link editor.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, AssetLink[]>>({});
  const [linkDraft, setLinkDraft] = useState('');

  const fetchTerms = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (searchQuery) params.set('q', searchQuery);
    if (statusFilter) params.set('status', statusFilter);
    const data = await jget<{ terms: Term[] }>(`/api/glossary/terms?${params}`);
    setTerms(data?.terms || []);
    setLoading(false);
  }, [searchQuery, statusFilter]);

  const fetchDomains = useCallback(async () => {
    const data = await jget<{ domains: Domain[] }>('/api/glossary/domains');
    setDomains(data?.domains || []);
  }, []);

  const fetchKpis = useCallback(async () => {
    const data = await jget<{ kpis: Kpi[] }>('/api/glossary/kpis');
    setKpis(data?.kpis || []);
  }, []);

  useEffect(() => { fetchTerms(); }, [fetchTerms]);
  useEffect(() => { fetchDomains(); fetchKpis(); }, [fetchDomains, fetchKpis]);

  // Populate the table picker used by linking + propagation if the index isn't
  // already loaded (other screens hydrate it; this one may be a direct entry).
  useEffect(() => {
    if (allTables.length === 0) {
      api.getTables().then((d) => setAllTables(d.tables || [])).catch(() => { /* picker just stays free-text */ });
    }
  }, [allTables.length, setAllTables]);

  const approvedCount = useMemo(() => terms.filter((t) => t.status === 'approved').length, [terms]);
  const approvedPct = terms.length ? Math.round((approvedCount / terms.length) * 100) : 0;

  const submitTerm = async () => {
    await fetch('/api/glossary/terms', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(termForm),
    });
    setShowTermForm(false);
    setTermForm({ name: '', definition: '', domain: '', owner: '', status: 'draft', synonyms: '' });
    fetchTerms();
  };

  const submitDomain = async () => {
    await fetch('/api/glossary/domains', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(domainForm),
    });
    setShowDomainForm(false);
    setDomainForm({ name: '', description: '', owner: '', color: '#FF4520' });
    fetchDomains();
  };

  const submitKpi = async () => {
    await fetch('/api/glossary/kpis', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(kpiForm),
    });
    setShowKpiForm(false);
    setKpiForm({ name: '', definition: '', formula_sql: '', source_tables: '', owner: '', domain: '', granularity: 'daily' });
    fetchKpis();
  };

  const deleteTerm = async (termId: string) => {
    if (!confirm('Delete this term?')) return;
    await fetch(`/api/glossary/terms/${termId}`, { method: 'DELETE' });
    fetchTerms();
  };

  const toggleExpand = async (term: Term) => {
    if (expanded === term.term_id) { setExpanded(null); return; }
    setExpanded(term.term_id);
    setLinkDraft('');
    if (!links[term.term_id]) {
      const data = await jget<{ links: AssetLink[] }>(`/api/glossary/terms/${term.term_id}`);
      setLinks((cur) => ({ ...cur, [term.term_id]: data?.links || [] }));
    }
  };

  const linkTermToTable = async (termId: string, fqn: string) => {
    const parts = splitFqn(fqn);
    if (!parts) return;
    await fetch('/api/glossary/link', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term_id: termId, asset_type: 'table', asset_fqn: fqn, column_name: '' }),
    });
    setLinkDraft('');
    const data = await jget<{ links: AssetLink[] }>(`/api/glossary/terms/${termId}`);
    setLinks((cur) => ({ ...cur, [termId]: data?.links || [] }));
  };

  const addBtn = { terms: '+ Add Term', domains: '+ Add Domain', kpis: '+ Add KPI' } as const;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <BookMarked size={16} className="text-accent" />
            <h2 className="text-[18px] font-bold text-white tracking-tight">Business Glossary</h2>
          </div>
          <p className="text-[13px] text-slate-500">Shared definitions, domains and metrics — wired to real Unity Catalog assets.</p>
        </div>
        {activeTab !== 'propagation' && (
          <button
            onClick={() => {
              if (activeTab === 'terms') setShowTermForm((v) => !v);
              else if (activeTab === 'domains') setShowDomainForm((v) => !v);
              else setShowKpiForm((v) => !v);
            }}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-accent text-white rounded-lg text-[13px] font-medium hover:bg-accent-dark transition-colors shrink-0"
          >
            {(activeTab === 'terms' && showTermForm) || (activeTab === 'domains' && showDomainForm) || (activeTab === 'kpis' && showKpiForm)
              ? 'Cancel' : addBtn[activeTab]}
          </button>
        )}
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard icon={BookMarked} label="Glossary Terms" value={terms.length} tint="#FF7A5C" sub={`${approvedCount} approved · ${terms.length - approvedCount} in progress`} />
        <StatCard icon={Gauge} label="Approved" value={`${approvedPct}%`} tint="#34d399" sub="Lifecycle coverage" />
        <StatCard icon={Layers} label="Data Domains" value={domains.length} tint="#38bdf8" sub="Ownership areas" />
        <StatCard icon={Target} label="Governed Metrics" value={kpis.length} tint="#a78bfa" sub="KPI definitions" />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-surface-50 rounded-xl p-1 border border-white/[0.06] w-fit">
        {([
          ['terms', 'Terms', BookMarked],
          ['domains', 'Domains', Layers],
          ['kpis', 'KPIs', Target],
          ['propagation', 'Propagation', GitBranch],
        ] as const).map(([tab, label, Icon]) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${
              activeTab === tab ? 'bg-accent text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </div>

      {/* ---------------- Terms ---------------- */}
      {activeTab === 'terms' && (
        <>
          <div className="flex items-center gap-2 mb-4">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                placeholder="Search terms..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && fetchTerms()}
                className="w-full pl-9 pr-4 py-2 bg-surface-50 border border-white/[0.08] rounded-lg text-[13px] text-slate-200 placeholder-slate-500 focus:border-accent/40 focus:outline-none"
              />
            </div>
            <div className="flex gap-1">
              {(['approved', 'draft', 'deprecated'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter((cur) => (cur === s ? null : s))}
                  className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-colors ${
                    statusFilter === s ? STATUS_STYLES[s] : 'bg-surface-50 text-slate-400 border-white/[0.06] hover:text-slate-200'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {showTermForm && (
            <div className="mb-5 p-4 bg-surface-50 rounded-xl border border-white/[0.08]">
              <div className="grid grid-cols-2 gap-3">
                <input placeholder="Term name" value={termForm.name} onChange={(e) => setTermForm({ ...termForm, name: e.target.value })}
                  className="px-3 py-2 bg-surface-100 border border-white/[0.08] rounded-lg text-[13px] text-slate-200 placeholder-slate-500 focus:border-accent/40 focus:outline-none" />
                <input placeholder="Domain" value={termForm.domain} onChange={(e) => setTermForm({ ...termForm, domain: e.target.value })}
                  className="px-3 py-2 bg-surface-100 border border-white/[0.08] rounded-lg text-[13px] text-slate-200 placeholder-slate-500 focus:border-accent/40 focus:outline-none" />
                <input placeholder="Owner" value={termForm.owner} onChange={(e) => setTermForm({ ...termForm, owner: e.target.value })}
                  className="px-3 py-2 bg-surface-100 border border-white/[0.08] rounded-lg text-[13px] text-slate-200 placeholder-slate-500 focus:border-accent/40 focus:outline-none" />
                <select value={termForm.status} onChange={(e) => setTermForm({ ...termForm, status: e.target.value })}
                  className="px-3 py-2 bg-surface-100 border border-white/[0.08] rounded-lg text-[13px] text-slate-200 focus:border-accent/40 focus:outline-none">
                  <option value="draft">Draft</option>
                  <option value="approved">Approved</option>
                  <option value="deprecated">Deprecated</option>
                </select>
              </div>
              <textarea placeholder="Definition" value={termForm.definition} onChange={(e) => setTermForm({ ...termForm, definition: e.target.value })}
                className="w-full mt-3 px-3 py-2 bg-surface-100 border border-white/[0.08] rounded-lg text-[13px] text-slate-200 placeholder-slate-500 focus:border-accent/40 focus:outline-none" rows={3} />
              <button onClick={submitTerm} className="mt-3 flex items-center gap-1.5 px-3.5 py-2 bg-accent text-white rounded-lg text-[13px] font-medium hover:bg-accent-dark transition-colors">
                <Check size={14} /> Save Term
              </button>
            </div>
          )}

          <div className="space-y-2.5">
            {loading ? (
              <div className="flex items-center gap-2 text-slate-500 text-[13px]"><Loader2 size={14} className="animate-spin" /> Loading terms…</div>
            ) : terms.length === 0 ? (
              <div className="p-8 text-center bg-surface-50 rounded-xl border border-white/[0.06]">
                <BookMarked size={22} className="text-slate-600 mx-auto mb-2" />
                <p className="text-slate-500 text-[13px]">No terms found. Add your first business term above.</p>
              </div>
            ) : terms.map((term) => {
              const isOpen = expanded === term.term_id;
              const tLinks = links[term.term_id] || [];
              return (
                <div key={term.term_id} className="bg-surface-50 rounded-xl border border-white/[0.06] hover:border-white/[0.12] transition-colors overflow-hidden">
                  <div className="p-4 flex items-start gap-3">
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleExpand(term)}
                      onKeyDown={(e) => { if (e.key === 'Enter') toggleExpand(term); }}
                      className="flex items-start gap-3 flex-1 min-w-0 text-left cursor-pointer"
                    >
                      <ChevronRight size={15} className={`text-slate-500 mt-0.5 shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2.5 flex-wrap">
                          <h3 className="font-semibold text-slate-100 text-[14px]">{term.name}</h3>
                          <StatusBadge status={term.status} />
                          {term.domain && <span className="text-[11px] text-accent-light">{term.domain}</span>}
                        </div>
                        <p className="mt-1 text-[12.5px] text-slate-400 leading-relaxed">{term.definition}</p>
                        {term.owner && <p className="mt-1 text-[11px] text-slate-500">Owner: {term.owner}</p>}
                      </div>
                    </div>
                    {isAdmin && (
                      <button
                        onClick={() => deleteTerm(term.term_id)}
                        title="Delete term (admin)"
                        className="text-rose-400 hover:text-rose-300 text-[15px] leading-none px-1 shrink-0"
                      >×</button>
                    )}
                  </div>

                  {isOpen && (
                    <div className="px-4 pb-4 pl-11 border-t border-white/[0.06] pt-3">
                      <div className="flex items-center gap-1.5 mb-2">
                        <Link2 size={12} className="text-slate-500" />
                        <span className="text-[11px] uppercase tracking-wider text-slate-500 font-medium">Linked assets</span>
                      </div>
                      {tLinks.length === 0 ? (
                        <p className="text-[12px] text-slate-500 mb-3">Not linked to any table yet.</p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5 mb-3">
                          {tLinks.map((l, i) => (
                            <button
                              key={l.link_id || i}
                              onClick={() => goTableLineage(l.asset_fqn)}
                              title="Open in lineage"
                              className="flex items-center gap-1.5 px-2 py-1 bg-surface-100 border border-white/[0.08] rounded-lg text-[11px] font-mono text-slate-300 hover:border-accent/40 hover:text-accent-light transition-colors"
                            >
                              <Boxes size={11} className="text-slate-500" />
                              {l.asset_fqn}{l.column_name ? `.${l.column_name}` : ''}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <input
                          list="glossary-tables"
                          placeholder="catalog.schema.table"
                          value={linkDraft}
                          onChange={(e) => setLinkDraft(e.target.value)}
                          className="flex-1 px-3 py-1.5 bg-surface-100 border border-white/[0.08] rounded-lg text-[12px] font-mono text-slate-200 placeholder-slate-500 focus:border-accent/40 focus:outline-none"
                        />
                        <button
                          onClick={() => linkTermToTable(term.term_id, linkDraft)}
                          disabled={!splitFqn(linkDraft)}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-accent/90 text-white rounded-lg text-[12px] font-medium hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          <Link2 size={12} /> Link
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ---------------- Domains ---------------- */}
      {activeTab === 'domains' && (
        <>
          {showDomainForm && (
            <div className="mb-5 p-4 bg-surface-50 rounded-xl border border-white/[0.08]">
              <div className="grid grid-cols-2 gap-3">
                <input placeholder="Domain name" value={domainForm.name} onChange={(e) => setDomainForm({ ...domainForm, name: e.target.value })}
                  className="px-3 py-2 bg-surface-100 border border-white/[0.08] rounded-lg text-[13px] text-slate-200 placeholder-slate-500 focus:border-accent/40 focus:outline-none" />
                <input placeholder="Owner" value={domainForm.owner} onChange={(e) => setDomainForm({ ...domainForm, owner: e.target.value })}
                  className="px-3 py-2 bg-surface-100 border border-white/[0.08] rounded-lg text-[13px] text-slate-200 placeholder-slate-500 focus:border-accent/40 focus:outline-none" />
              </div>
              <textarea placeholder="Description" value={domainForm.description} onChange={(e) => setDomainForm({ ...domainForm, description: e.target.value })}
                className="w-full mt-3 px-3 py-2 bg-surface-100 border border-white/[0.08] rounded-lg text-[13px] text-slate-200 placeholder-slate-500 focus:border-accent/40 focus:outline-none" rows={2} />
              <div className="flex items-center gap-3 mt-3">
                <label className="flex items-center gap-2 text-[12px] text-slate-400">
                  Color
                  <input type="color" value={domainForm.color} onChange={(e) => setDomainForm({ ...domainForm, color: e.target.value })}
                    className="w-8 h-8 rounded bg-transparent border border-white/[0.08] cursor-pointer" />
                </label>
                <button onClick={submitDomain} className="flex items-center gap-1.5 px-3.5 py-2 bg-accent text-white rounded-lg text-[13px] font-medium hover:bg-accent-dark transition-colors">
                  <Check size={14} /> Save Domain
                </button>
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {domains.map((d) => (
              <div key={d.domain_id} className="p-4 bg-surface-50 rounded-xl border border-white/[0.06] border-l-[3px]" style={{ borderLeftColor: d.color || '#FF4520' }}>
                <h3 className="font-semibold text-slate-100 text-[14px]">{d.name}</h3>
                <p className="text-[12.5px] text-slate-400 mt-1 leading-relaxed">{d.description}</p>
                {d.owner && <p className="text-[11px] text-slate-500 mt-2">Owner: {d.owner}</p>}
              </div>
            ))}
            {domains.length === 0 && (
              <div className="md:col-span-2 p-8 text-center bg-surface-50 rounded-xl border border-white/[0.06]">
                <Layers size={22} className="text-slate-600 mx-auto mb-2" />
                <p className="text-slate-500 text-[13px]">No domains defined yet.</p>
              </div>
            )}
          </div>
        </>
      )}

      {/* ---------------- KPIs ---------------- */}
      {activeTab === 'kpis' && (
        <>
          {showKpiForm && (
            <div className="mb-5 p-4 bg-surface-50 rounded-xl border border-white/[0.08]">
              <div className="grid grid-cols-2 gap-3">
                <input placeholder="KPI name" value={kpiForm.name} onChange={(e) => setKpiForm({ ...kpiForm, name: e.target.value })}
                  className="px-3 py-2 bg-surface-100 border border-white/[0.08] rounded-lg text-[13px] text-slate-200 placeholder-slate-500 focus:border-accent/40 focus:outline-none" />
                <input placeholder="Domain" value={kpiForm.domain} onChange={(e) => setKpiForm({ ...kpiForm, domain: e.target.value })}
                  className="px-3 py-2 bg-surface-100 border border-white/[0.08] rounded-lg text-[13px] text-slate-200 placeholder-slate-500 focus:border-accent/40 focus:outline-none" />
                <input placeholder="Owner" value={kpiForm.owner} onChange={(e) => setKpiForm({ ...kpiForm, owner: e.target.value })}
                  className="px-3 py-2 bg-surface-100 border border-white/[0.08] rounded-lg text-[13px] text-slate-200 placeholder-slate-500 focus:border-accent/40 focus:outline-none" />
                <select value={kpiForm.granularity} onChange={(e) => setKpiForm({ ...kpiForm, granularity: e.target.value })}
                  className="px-3 py-2 bg-surface-100 border border-white/[0.08] rounded-lg text-[13px] text-slate-200 focus:border-accent/40 focus:outline-none">
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </div>
              <textarea placeholder="Definition" value={kpiForm.definition} onChange={(e) => setKpiForm({ ...kpiForm, definition: e.target.value })}
                className="w-full mt-3 px-3 py-2 bg-surface-100 border border-white/[0.08] rounded-lg text-[13px] text-slate-200 placeholder-slate-500 focus:border-accent/40 focus:outline-none" rows={2} />
              <input placeholder="Source tables (comma-separated FQNs)" value={kpiForm.source_tables} onChange={(e) => setKpiForm({ ...kpiForm, source_tables: e.target.value })}
                className="w-full mt-3 px-3 py-2 bg-surface-100 border border-white/[0.08] rounded-lg text-[12px] font-mono text-slate-200 placeholder-slate-500 focus:border-accent/40 focus:outline-none" />
              <textarea placeholder="Formula SQL" value={kpiForm.formula_sql} onChange={(e) => setKpiForm({ ...kpiForm, formula_sql: e.target.value })}
                className="w-full mt-3 px-3 py-2 bg-surface-100 border border-white/[0.08] rounded-lg text-[12px] font-mono text-emerald-300 placeholder-slate-500 focus:border-accent/40 focus:outline-none" rows={3} />
              <button onClick={submitKpi} className="mt-3 flex items-center gap-1.5 px-3.5 py-2 bg-accent text-white rounded-lg text-[13px] font-medium hover:bg-accent-dark transition-colors">
                <Check size={14} /> Save KPI
              </button>
            </div>
          )}
          <div className="space-y-2.5">
            {kpis.map((kpi) => (
              <div key={kpi.kpi_id} className="p-4 bg-surface-50 rounded-xl border border-white/[0.06]">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <Target size={14} className="text-violet-400" />
                  <h3 className="font-semibold text-slate-100 text-[14px]">{kpi.name}</h3>
                  {kpi.domain && <span className="text-[11px] text-accent-light">{kpi.domain}</span>}
                  {kpi.granularity && <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/[0.05] text-slate-500">{kpi.granularity}</span>}
                </div>
                <p className="mt-1.5 text-[12.5px] text-slate-400 leading-relaxed">{kpi.definition}</p>
                {kpi.formula_sql && (
                  <pre className="mt-2 p-2.5 bg-surface-100 rounded-lg text-[11.5px] text-emerald-300 overflow-x-auto scrollbar-thin font-mono">{kpi.formula_sql}</pre>
                )}
                {kpi.source_tables && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {kpi.source_tables.split(',').map((s) => s.trim()).filter(Boolean).map((src) => (
                      <button key={src} onClick={() => goTableLineage(src)}
                        className="flex items-center gap-1 px-2 py-1 bg-surface-100 border border-white/[0.08] rounded-lg text-[11px] font-mono text-slate-300 hover:border-accent/40 hover:text-accent-light transition-colors">
                        <Boxes size={11} className="text-slate-500" /> {src}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {kpis.length === 0 && (
              <div className="p-8 text-center bg-surface-50 rounded-xl border border-white/[0.06]">
                <Target size={22} className="text-slate-600 mx-auto mb-2" />
                <p className="text-slate-500 text-[13px]">No KPIs defined yet.</p>
              </div>
            )}
          </div>
        </>
      )}

      {/* ---------------- Propagation (centerpiece) ---------------- */}
      {activeTab === 'propagation' && <PropagationWizard />}

      {/* Shared table datalist for the link + propagation pickers. */}
      <datalist id="glossary-tables">
        {allTables.slice(0, 2000).map((t) => <option key={t.fqdn} value={t.fqdn} />)}
      </datalist>
    </div>
  );
}

/** Term propagation down lineage — the glossary's signature workflow.
 *  Given a source table with linked terms, walk its downstream lineage and
 *  surface tables that don't carry those terms yet, with one-click apply. */
function PropagationWizard() {
  const [source, setSource] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PropagationResult | null>(null);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    const parts = splitFqn(source);
    if (!parts) { setError('Enter a full table name: catalog.schema.table'); return; }
    setError(null);
    setRunning(true);
    setResult(null);
    setApplied(new Set());
    const qs = new URLSearchParams({ catalog: parts.catalog, schema: parts.schema, table: parts.table });
    const data = await jget<Partial<PropagationResult>>(`/api/glossary/propagate-suggestions?${qs}`);
    setRunning(false);
    if (!data) { setError('Failed to compute suggestions.'); return; }
    // The backend's early returns (no linked terms / no downstream) omit
    // source_terms + downstream_count, so normalize to safe defaults — reading
    // .length on the raw response would otherwise crash the panel.
    setResult({
      source_table: data.source_table ?? source,
      source_terms: data.source_terms ?? [],
      downstream_count: data.downstream_count ?? 0,
      suggestions: data.suggestions ?? [],
      suggestion_count: data.suggestion_count ?? (data.suggestions?.length ?? 0),
      note: data.note,
    });
  };

  const applyLink = async (targetTable: string, term: MissingTerm) => {
    const key = `${targetTable}::${term.term_id}`;
    await fetch('/api/glossary/link', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term_id: term.term_id, asset_type: 'table', asset_fqn: targetTable, column_name: '' }),
    });
    setApplied((cur) => new Set(cur).add(key));
  };

  const applyAll = async (s: Suggestion) => {
    for (const term of s.missing_terms) await applyLink(s.target_table, term);
  };

  return (
    <div>
      <div className="p-4 bg-surface-50 rounded-xl border border-white/[0.06] mb-4">
        <div className="flex items-center gap-2 mb-1">
          <Sparkles size={14} className="text-accent" />
          <h3 className="text-[14px] font-semibold text-slate-100">Propagate terms down lineage</h3>
        </div>
        <p className="text-[12.5px] text-slate-500 mb-3 leading-relaxed">
          Pick a source table with linked terms. BrickTrace walks its downstream lineage and finds tables missing those terms — apply in one click.
        </p>
        <div className="flex items-center gap-2">
          <input
            list="glossary-tables"
            placeholder="catalog.schema.table"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run()}
            className="flex-1 px-3 py-2 bg-surface-100 border border-white/[0.08] rounded-lg text-[13px] font-mono text-slate-200 placeholder-slate-500 focus:border-accent/40 focus:outline-none"
          />
          <button
            onClick={run}
            disabled={running || !splitFqn(source)}
            className="flex items-center gap-1.5 px-4 py-2 bg-accent text-white rounded-lg text-[13px] font-medium hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {running ? <Loader2 size={14} className="animate-spin" /> : <GitBranch size={14} />}
            {running ? 'Tracing…' : 'Find suggestions'}
          </button>
        </div>
        {error && <p className="mt-2 text-[12px] text-rose-400">{error}</p>}
      </div>

      {result && (
        <div>
          {/* Source terms summary */}
          <div className="flex items-center gap-2 mb-3 flex-wrap text-[12px] text-slate-400">
            <span>Source terms:</span>
            {result.source_terms.length === 0 ? (
              <span className="text-slate-500">none linked to <span className="font-mono">{result.source_table}</span> — link terms on the Terms tab first.</span>
            ) : result.source_terms.map((t) => (
              <span key={t.term_id} className="px-2 py-0.5 rounded-full bg-accent/10 text-accent-light text-[11px] font-medium">{t.term_name}</span>
            ))}
            {result.downstream_count > 0 && <span className="text-slate-500 ml-1">· {result.downstream_count} downstream tables</span>}
          </div>

          {result.suggestions.length === 0 ? (
            <div className="p-8 text-center bg-surface-50 rounded-xl border border-white/[0.06]">
              <Check size={22} className="text-emerald-400 mx-auto mb-2" />
              <p className="text-slate-400 text-[13px]">{result.note || 'No propagation needed — downstream tables already carry these terms.'}</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {result.suggestions.map((s) => {
                const allDone = s.missing_terms.every((t) => applied.has(`${s.target_table}::${t.term_id}`));
                return (
                  <div key={s.target_table} className="p-4 bg-surface-50 rounded-xl border border-white/[0.06]">
                    <div className="flex items-center justify-between gap-3 mb-2.5">
                      <button onClick={() => goTableLineage(s.target_table)}
                        className="flex items-center gap-1.5 text-[13px] font-mono text-slate-200 hover:text-accent-light transition-colors min-w-0">
                        <Boxes size={13} className="text-slate-500 shrink-0" />
                        <span className="truncate">{s.target_table}</span>
                        <ArrowRight size={12} className="text-slate-600 shrink-0" />
                      </button>
                      {!allDone && (
                        <button onClick={() => applyAll(s)}
                          className="flex items-center gap-1.5 px-2.5 py-1 bg-accent/90 text-white rounded-lg text-[11px] font-medium hover:bg-accent transition-colors shrink-0">
                          <Plus size={11} /> Apply all
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {s.missing_terms.map((t) => {
                        const done = applied.has(`${s.target_table}::${t.term_id}`);
                        return (
                          <button
                            key={t.term_id}
                            onClick={() => !done && applyLink(s.target_table, t)}
                            disabled={done}
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-colors ${
                              done
                                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25 cursor-default'
                                : 'bg-surface-100 text-slate-300 border-white/[0.08] hover:border-accent/40 hover:text-accent-light'
                            }`}
                          >
                            {done ? <Check size={11} /> : <Link2 size={11} />}
                            {t.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
