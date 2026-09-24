import { useState } from 'react';
import { Loader2, Search, ArrowLeft, AlertTriangle, CheckCircle2 } from 'lucide-react';

interface Candidate {
  candidate_table: string;
  candidate_column: string;
  hop_distance: number;
  score: number;
  evidence: string[];
}

interface RootCauseResult {
  candidates: Candidate[];
  upstream_path: any[];
  timeline: any[];
  summary: string;
}

interface Props {
  catalog?: string;
  schema?: string;
  table?: string;
  column?: string;
}

export function RootCauseWizard({ catalog = '', schema = '', table = '', column = '' }: Props) {
  const [formState, setFormState] = useState({ catalog, schema, table, column, anomaly_timestamp: '' });
  const [result, setResult] = useState<RootCauseResult | null>(null);
  const [error, setError] = useState('');
  const [step, setStep] = useState<'input' | 'analyzing' | 'results'>('input');

  const runAnalysis = async () => {
    setError('');
    setStep('analyzing');
    try {
      const res = await fetch('/api/root-cause/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          catalog: formState.catalog, schema_name: formState.schema, table: formState.table,
          column: formState.column, anomaly_timestamp: formState.anomaly_timestamp || undefined,
          max_hops: 6, include_dq: true, include_run_health: true,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setResult(await res.json());
      setStep('results');
    } catch (e: any) {
      setError(e.message || 'Analysis failed');
      setStep('input');
    }
  };

  const scoreColor = (s: number) => (s >= 0.8 ? '#f87171' : s >= 0.5 ? '#fbbf24' : '#34d399');
  const inputCls = "w-full px-3 py-2 bg-surface-50 border border-white/[0.08] rounded-lg text-[13px] text-white placeholder-slate-600 focus:outline-none focus:border-accent/40";

  return (
    <div className="max-w-3xl">
      <p className="text-slate-400 text-[13px] mb-5">
        Trace a data-quality issue or anomaly back to its likely source by walking upstream lineage
        and correlating with producer run failures.
      </p>

      {step === 'input' && (
        <div className="space-y-4 p-5 bg-surface-50 rounded-xl border border-white/[0.06]">
          <div className="grid grid-cols-2 gap-3">
            {(['catalog', 'schema', 'table', 'column'] as const).map((f) => (
              <div key={f}>
                <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">{f}</label>
                <input value={(formState as any)[f]} onChange={(e) => setFormState({ ...formState, [f]: e.target.value })}
                  className={inputCls} placeholder={f === 'column' ? 'affected_column' : `my_${f}`} />
              </div>
            ))}
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Anomaly timestamp (optional)</label>
            <input type="datetime-local" value={formState.anomaly_timestamp}
              onChange={(e) => setFormState({ ...formState, anomaly_timestamp: e.target.value })} className={inputCls} />
          </div>
          {error && <p className="text-red-400 text-[12px]">{error}</p>}
          <button onClick={runAnalysis}
            disabled={!formState.catalog || !formState.schema || !formState.table || !formState.column}
            className="w-full py-2.5 bg-accent/90 hover:bg-accent text-white rounded-lg text-[13px] font-medium disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2">
            <Search size={14} /> Analyze root cause
          </button>
        </div>
      )}

      {step === 'analyzing' && (
        <div className="text-center py-16 bg-surface-50 rounded-xl border border-white/[0.06]">
          <Loader2 size={26} className="animate-spin text-accent mx-auto mb-4" />
          <p className="text-slate-300 text-[13px]">Walking upstream lineage and correlating failures…</p>
          <p className="text-[11px] text-slate-600 mt-2">This may take 10–30 seconds</p>
        </div>
      )}

      {step === 'results' && result && (
        <div className="space-y-5">
          <button onClick={() => setStep('input')} className="flex items-center gap-1.5 text-[12px] text-accent hover:text-accent-light">
            <ArrowLeft size={13} /> Run another analysis
          </button>

          {result.candidates.length === 0 ? (
            <div className="p-6 bg-emerald-500/[0.06] border border-emerald-500/20 rounded-xl flex items-start gap-3">
              <CheckCircle2 size={18} className="text-emerald-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-emerald-300 font-medium text-[14px]">No likely root cause found</p>
                <p className="text-[12px] text-slate-400 mt-1">No upstream producer failures or DQ violations were detected in the analysis window.</p>
              </div>
            </div>
          ) : (
            <div>
              <h3 className="text-[14px] font-semibold text-slate-100 mb-3">
                {result.candidates.length} candidate{result.candidates.length > 1 ? 's' : ''} found
              </h3>
              <div className="space-y-3">
                {result.candidates.map((c, i) => (
                  <div key={i} className="p-4 bg-surface-50 rounded-xl border border-white/[0.06]">
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <p className="font-medium text-[13px] text-white truncate">
                          <span className="text-slate-500 mr-1">#{i + 1}</span>{c.candidate_table}
                          {c.candidate_column && <span className="text-accent">.{c.candidate_column}</span>}
                        </p>
                        <p className="text-[11px] text-slate-500 mt-0.5">{c.hop_distance} hop{c.hop_distance > 1 ? 's' : ''} upstream</p>
                      </div>
                      <span className="text-[18px] font-bold shrink-0" style={{ color: scoreColor(c.score) }}>
                        {Math.round(c.score * 100)}%
                      </span>
                    </div>
                    {c.evidence.length > 0 && (
                      <div className="mt-3 space-y-1.5">
                        {c.evidence.map((ev, j) => (
                          <p key={j} className="text-[11px] text-slate-400 flex items-start gap-1.5">
                            <AlertTriangle size={12} className="text-amber-400 shrink-0 mt-0.5" /> {ev}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
