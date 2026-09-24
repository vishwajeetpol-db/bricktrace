import { useMemo, useState } from "react";
import { api, DQProfileColumn, DQRule } from "../../api/client";
import { dimensionForRuleType } from "../../lib/dqDimensions";

const RULE_TYPES = ["NOT_NULL", "UNIQUE", "RANGE", "REGEX", "CUSTOM"] as const;
type RuleType = (typeof RULE_TYPES)[number];

const NEEDS_EXPR: Record<RuleType, boolean> = {
  NOT_NULL: false,
  UNIQUE: false,
  RANGE: true,
  REGEX: true,
  CUSTOM: true,
};
const EXPR_PLACEHOLDER: Record<RuleType, string> = {
  NOT_NULL: "",
  UNIQUE: "",
  RANGE: "min,max — e.g. 0,100",
  REGEX: "regex — e.g. ^[A-Z]{2}$",
  CUSTOM: "boolean SQL — e.g. amount >= 0",
};

/** Collapsible "add a DQ rule" form. Admin-only (the backend enforces it too). */
export function RuleEditor({
  tableFqn,
  columns,
  onSaved,
}: {
  tableFqn: string;
  columns: string[];
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [column, setColumn] = useState("");
  const [ruleType, setRuleType] = useState<RuleType>("NOT_NULL");
  const [expression, setExpression] = useState("");
  const [severity, setSeverity] = useState("ERROR");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const columnRequired = ruleType !== "CUSTOM";
  const canSave =
    !saving &&
    (!columnRequired || column.trim()) &&
    (!NEEDS_EXPR[ruleType] || expression.trim());

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await api.upsertDQRule({
        table_fqn: tableFqn,
        column_name: column.trim() || undefined,
        rule_type: ruleType,
        expression: NEEDS_EXPR[ruleType] ? expression.trim() : "",
        severity,
      });
      setColumn("");
      setExpression("");
      setRuleType("NOT_NULL");
      setOpen(false);
      onSaved();
    } catch (e: any) {
      setError(String(e?.message || "Failed to save rule").replace(/^API error \d+: /, ""));
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 text-[12px] rounded-lg border border-white/[0.1] text-slate-300 hover:border-accent/40 hover:text-white transition-colors"
      >
        + Add rule
      </button>
    );
  }

  return (
    <div className="p-4 bg-surface rounded-lg border border-white/[0.08] space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2">
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">
            Column {columnRequired && <span className="text-red-400">*</span>}
          </label>
          <input
            value={column}
            onChange={(e) => setColumn(e.target.value)}
            list="dq-rule-columns"
            placeholder={ruleType === "CUSTOM" ? "(optional)" : "column"}
            className="w-full px-2.5 py-1.5 bg-surface-50 border border-white/[0.08] rounded-md text-[12px] text-white placeholder-slate-600 focus:outline-none focus:border-accent/40"
          />
          <datalist id="dq-rule-columns">
            {columns.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Type</label>
          <select
            value={ruleType}
            onChange={(e) => setRuleType(e.target.value as RuleType)}
            className="w-full px-2.5 py-1.5 bg-surface-50 border border-white/[0.08] rounded-md text-[12px] text-slate-200 focus:outline-none"
          >
            {RULE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Severity</label>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            className="px-2.5 py-1.5 bg-surface-50 border border-white/[0.08] rounded-md text-[12px] text-slate-200 focus:outline-none"
          >
            <option value="ERROR">ERROR</option>
            <option value="WARN">WARN</option>
          </select>
        </div>
      </div>

      {NEEDS_EXPR[ruleType] && (
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Expression</label>
          <input
            value={expression}
            onChange={(e) => setExpression(e.target.value)}
            placeholder={EXPR_PLACEHOLDER[ruleType]}
            className="w-full px-2.5 py-1.5 bg-surface-50 border border-white/[0.08] rounded-md text-[12px] text-white placeholder-slate-600 font-mono focus:outline-none focus:border-accent/40"
          />
        </div>
      )}

      {error && <p className="text-[12px] text-red-400">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          onClick={save}
          disabled={!canSave}
          className="px-4 py-1.5 bg-accent/90 hover:bg-accent text-white rounded-md text-[12px] font-medium disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save rule"}
        </button>
        <button onClick={() => setOpen(false)} className="px-3 py-1.5 text-[12px] text-slate-400 hover:text-slate-200">
          Cancel
        </button>
      </div>
    </div>
  );
}

interface Suggestion {
  column: string;
  rule_type: "NOT_NULL" | "UNIQUE";
  severity: "ERROR" | "WARN";
  reason: string;
}

/** Propose NOT_NULL / UNIQUE rules from a LIVE column profile (needs total_rows). */
export function RuleSuggestions({
  tableFqn,
  columns,
  existingRules,
  onSaved,
  onRunLiveProfile,
  profiling,
}: {
  tableFqn: string;
  columns: DQProfileColumn[];
  existingRules: DQRule[];
  onSaved: () => void;
  onRunLiveProfile?: () => void;
  profiling?: boolean;
}) {
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const hasExisting = (col: string, type: string) =>
    existingRules.some((r) => r.column_name === col && (r.rule_type || "").toUpperCase() === type);

  const suggestions = useMemo<Suggestion[]>(() => {
    const out: Suggestion[] = [];
    for (const c of columns) {
      if (c.total_rows == null) continue; // needs a live profile
      const nullPct = c.null_pct;
      if ((nullPct === 0 || c.null_count === 0) && !hasExisting(c.name, "NOT_NULL")) {
        // Safe to enforce — no nulls today; the rule catches a future regression.
        out.push({ column: c.name, rule_type: "NOT_NULL", severity: "ERROR", reason: "0% null — enforce" });
      } else if (nullPct != null && nullPct > 0 && nullPct <= 10 && !hasExisting(c.name, "NOT_NULL")) {
        // Small, nonzero null rate — worth watching, but not a hard failure yet.
        out.push({
          column: c.name,
          rule_type: "NOT_NULL",
          severity: "WARN",
          reason: `${nullPct.toFixed(nullPct < 1 ? 2 : 1)}% null — monitor`,
        });
      }
      if (c.distinct_count != null && c.total_rows > 0 && c.distinct_count === c.total_rows && !hasExisting(c.name, "UNIQUE")) {
        out.push({ column: c.name, rule_type: "UNIQUE", severity: "ERROR", reason: "every value distinct" });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, existingRules]);

  const key = (s: Suggestion) => `${s.rule_type}:${s.column}`;
  const selectedCount = suggestions.filter((s) => picked[key(s)]).length;

  const addSelected = async () => {
    setSaving(true);
    setError("");
    try {
      const chosen = suggestions.filter((s) => picked[key(s)]);
      for (const s of chosen) {
        await api.upsertDQRule({
          table_fqn: tableFqn,
          column_name: s.column,
          rule_type: s.rule_type,
          expression: "",
          severity: s.severity,
        });
      }
      setPicked({});
      onSaved();
    } catch (e: any) {
      setError(String(e?.message || "Failed").replace(/^API error \d+: /, ""));
    } finally {
      setSaving(false);
    }
  };

  const hasLive = columns.some((c) => c.total_rows != null);
  if (!hasLive) {
    // No live profile yet — suggestions need distinct/null counts, so offer to run it.
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-[12px] text-slate-500">
          Suggestions come from a live column profile (distinct &amp; null counts).
        </p>
        {onRunLiveProfile && (
          <button
            onClick={onRunLiveProfile}
            disabled={profiling}
            className="px-4 py-1.5 bg-accent/90 hover:bg-accent text-white rounded-md text-[12px] font-medium disabled:opacity-40"
          >
            {profiling ? "Profiling…" : "Profile columns to get suggestions"}
          </button>
        )}
      </div>
    );
  }
  if (suggestions.length === 0) {
    return <p className="text-[12px] text-slate-500">No obvious rules to suggest — columns already covered or too sparse.</p>;
  }

  return (
    <div className="space-y-2">
      {suggestions.map((s) => (
        <label key={key(s)} className="flex items-center gap-2.5 text-[12px] cursor-pointer">
          <input
            type="checkbox"
            checked={!!picked[key(s)]}
            onChange={(e) => setPicked((p) => ({ ...p, [key(s)]: e.target.checked }))}
            className="accent-[#FF4520]"
          />
          <span className="w-2 h-2 rounded-full" style={{ background: dimensionForRuleType(s.rule_type).color }} />
          <span className="text-slate-200">{s.rule_type}</span>
          {s.severity === "WARN" && (
            <span className="text-[9px] uppercase px-1.5 py-0.5 rounded bg-amber-400/10 text-amber-400">warn</span>
          )}
          <span className="text-slate-500">on {s.column}</span>
          <span className="ml-auto text-slate-600">{s.reason}</span>
        </label>
      ))}
      {error && <p className="text-[12px] text-red-400">{error}</p>}
      <button
        onClick={addSelected}
        disabled={saving || selectedCount === 0}
        className="mt-1 px-4 py-1.5 bg-accent/90 hover:bg-accent text-white rounded-md text-[12px] font-medium disabled:opacity-40"
      >
        {saving ? "Adding…" : `Add ${selectedCount || ""} selected`}
      </button>
    </div>
  );
}
