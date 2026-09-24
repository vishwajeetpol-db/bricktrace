import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DQMetricsPanel } from "./DQMetricsPanel";
import { useLineageStore } from "../store/lineageStore";

/** Route a fetch mock by URL fragment. First matching fragment (insertion order) wins. */
function routeFetch(routes: [string, any][], fallback: any = {}) {
  return vi.fn((url: string) => {
    const u = String(url);
    for (const [frag, data] of routes) {
      if (u.includes(frag)) {
        const ok = !(data && data.__status && data.__status >= 400);
        return Promise.resolve({
          ok,
          status: ok ? 200 : data.__status,
          json: async () => data,
          text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
        });
      }
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => fallback, text: async () => JSON.stringify(fallback) });
  });
}

const metrics = {
  table_fqn: "main.s.t",
  quality_score: 0.95,
  quality_grade: "A",
  rules_evaluated: 3,
  rules_total: 4,
  sample_size: 10000,
  coverage_complete: true,
  metrics: [
    { rule_id: "r1", column: "email", rule_type: "NOT_NULL", pass_rate: 0.995, failing_rows: 5, status: "pass", severity: "ERROR" },
    { rule_id: "r2", column: "age", rule_type: "RANGE", pass_rate: 0.6, failing_rows: 40, status: "fail", severity: "ERROR" },
  ],
};
const rulesList = { rules: [{ table_fqn: "main.s.t", column_name: "email", rule_type: "NOT_NULL", severity: "ERROR" }] };
const trends = {
  table_fqn: "main.s.t",
  trend: "improving",
  data_points: [
    { run_id: "1", quality_score: 0.8, rules_evaluated: 3, rules_passed: 2, rules_failed: 1, evaluated_at: "2026-09-01T00:00:00Z" },
    { run_id: "2", quality_score: 0.95, rules_evaluated: 3, rules_passed: 3, rules_failed: 0, evaluated_at: "2026-09-10T00:00:00Z" },
  ],
};
const profile = {
  table_full_name: "main.s.t",
  row_count_approx: "12345",
  profile_source: "delta_stats",
  columns: [{ name: "email", distinct_count: 100, null_pct: 0.5, min: null, max: null }],
};
const propagation = {
  table_fqn: "main.s.t",
  upstream_quality: [
    { upstream_table: "main.s.up1", has_dq_rules: true, rule_count: 2 },
    { upstream_table: "main.s.up2", has_dq_rules: false, rule_count: 0 },
  ],
  upstream_count: 2,
  covered_count: 1,
};

function adminRoutes() {
  return routeFetch([
    ["/dq-rules/metrics", metrics],
    ["/dq-rules/trends", trends],
    ["/dq-rules/propagation", propagation],
    ["/diagnostics/profile", profile],
    ["/dq-rules/record-metrics", { status: "ok", run_id: "x" }],
    ["/dq-rules", rulesList], // list (portfolio + per-table)
  ]);
}

describe("DQMetricsPanel", () => {
  beforeEach(() => useLineageStore.setState({ isAdmin: true, allTables: [] }));
  afterEach(() => {
    vi.restoreAllMocks();
    useLineageStore.setState({ isAdmin: false });
  });

  it("renders the table picker and Analyze button", () => {
    global.fetch = routeFetch([["/dq-rules", { rules: [] }]]) as any;
    render(<DQMetricsPanel />);
    expect(screen.getByPlaceholderText("catalog.schema.table")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Analyze/i })).toBeInTheDocument();
  });

  it("shows the empty portfolio onboarding when no rules exist", async () => {
    global.fetch = routeFetch([["/dq-rules", { rules: [] }]]) as any;
    render(<DQMetricsPanel />);
    expect(await screen.findByText(/No DQ rules authored yet/i)).toBeInTheDocument();
  });

  it("lists tables that have rules and analyzes one on click", async () => {
    global.fetch = routeFetch([
      ["/dq-rules/metrics", metrics],
      ["/dq-rules/trends", trends],
      ["/dq-rules/propagation", propagation],
      ["/diagnostics/profile", profile],
      ["/dq-rules/record-metrics", { status: "ok" }],
      ["/dq-rules", { rules: [{ table_fqn: "main.s.t", column_name: "email", rule_type: "NOT_NULL" }] }],
    ]) as any;
    const user = userEvent.setup();
    render(<DQMetricsPanel />);
    const card = await screen.findByText("main.s.t");
    await user.click(card);
    expect(await screen.findByText("95%")).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("renders score, grade, rule results, trend and upstream for an admin", async () => {
    global.fetch = adminRoutes() as any;
    render(<DQMetricsPanel tableFqn="main.s.t" />);
    expect(await screen.findByText("95%")).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
    // rule rows
    expect(screen.getByText("NOT_NULL")).toBeInTheDocument();
    expect(screen.getByText("RANGE")).toBeInTheDocument();
    // trend direction badge
    expect(screen.getByText(/improving/i)).toBeInTheDocument();
    // upstream coverage warning
    expect(screen.getByText(/upstream table\(s\) have no DQ rules/i)).toBeInTheDocument();
  });

  it("does not crash when the table has no rules (short metrics response)", async () => {
    // Backend's no-rules branch omits sample_size / rules_evaluated / rules_total.
    global.fetch = routeFetch([
      ["/dq-rules/metrics", { table_fqn: "main.s.t", metrics: [], quality_score: null, note: "No DQ rules defined" }],
      ["/dq-rules/trends", { table_fqn: "main.s.t", trend: "stable", data_points: [] }],
      ["/dq-rules/propagation", { table_fqn: "main.s.t", upstream_quality: [], upstream_count: 0, covered_count: 0 }],
      ["/diagnostics/profile", { table_full_name: "main.s.t", row_count_approx: null, profile_source: "none", columns: [] }],
      ["/dq-rules/record-metrics", { status: "ok" }],
      ["/dq-rules", { rules: [] }],
    ]) as any;
    render(<DQMetricsPanel tableFqn="main.s.t" />);
    expect(await screen.findByText(/No rules yet/i)).toBeInTheDocument();
    expect(screen.getByText(/No DQ rules defined for this table yet/i)).toBeInTheDocument();
  });

  it("skips live scoring for non-admins but still shows rules & profile", async () => {
    useLineageStore.setState({ isAdmin: false });
    global.fetch = adminRoutes() as any;
    render(<DQMetricsPanel tableFqn="main.s.t" />);
    expect(await screen.findByText(/Live scoring/i)).toBeInTheDocument();
    // authored rule inventory still renders
    expect(await screen.findByText("NOT_NULL")).toBeInTheDocument();
  });
});
