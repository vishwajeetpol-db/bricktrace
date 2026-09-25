import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OverviewReport } from "./OverviewReport";
import { useLineageStore } from "../../store/lineageStore";
import { api } from "../../api/client";

vi.mock("framer-motion", () => ({
  motion: new Proxy({}, { get: () => (p: any) => <div>{p.children}</div> }),
}));
// The SVG charts are covered by their own DQCharts tests; stub them here.
vi.mock("../dq/DQCharts", () => ({
  RingGauge: ({ value }: any) => <div data-testid="ring">{Math.round((value || 0) * 100)}</div>,
  DimensionDonut: ({ segments }: any) => <div data-testid="donut">{segments.length}</div>,
}));
vi.mock("../../api/client", () => ({
  api: { listDQRules: vi.fn() },
}));

function tbl(catalog: string, schema: string, name: string, table_type = "MANAGED") {
  return { name, fqdn: `${catalog}.${schema}.${name}`, catalog, schema, table_type };
}

describe("OverviewReport", () => {
  beforeEach(() => {
    (api.listDQRules as any).mockResolvedValue({ rules: [{ table_fqn: "c1.s.a" }, { table_fqn: "c1.s.b" }] });
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("governance/config")) return Promise.resolve({ ok: true, json: async () => ({ rules: [{}, {}, {}] }) });
      if (String(url).includes("notifications")) return Promise.resolve({ ok: true, json: async () => ({ notifications: [
        { id: 1, type: "schema_change", title: "Schema changed", table_fqn: "c1.s.a", created_at: new Date(Date.now() - 30_000).toISOString() },
        { id: 2, type: "pipeline run", title: "Pipeline ran", created_at: new Date(Date.now() - 5 * 60_000).toISOString() },
        { id: 3, type: "dq quality", title: "DQ breach", detail: "row check", created_at: new Date(Date.now() - 2 * 3600_000).toISOString() },
        { id: 4, type: "new_table", title: "New table", created_at: new Date(Date.now() - 3 * 86400_000).toISOString() },
      ] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }) as any;
    useLineageStore.setState({ allTables: [
      tbl("c1", "s", "a"), tbl("c1", "s", "b"), tbl("c1", "s2", "c", "VIEW"), tbl("c2", "s", "d", "STREAMING_TABLE"),
    ] as any });
  });
  afterEach(() => { vi.restoreAllMocks(); useLineageStore.setState({ allTables: [] as any }); });

  it("renders KPI stats from the table index", async () => {
    render(<OverviewReport />);
    // KPI labels + the 2 catalogs / 3 schemas derived from the index.
    expect(screen.getByText("Tables")).toBeInTheDocument();
    expect(screen.getByText("Catalogs")).toBeInTheDocument();
    expect(screen.getByText("Schemas")).toBeInTheDocument();
    expect(await screen.findByText("3 governance rules")).toBeInTheDocument();
  });

  it("computes DQ coverage (2 of 4 tables) and type segments", async () => {
    render(<OverviewReport />);
    // ring gauge shows 50% coverage
    expect(await screen.findByTestId("ring")).toHaveTextContent("50");
    // 3 distinct types -> donut with 3 segments
    expect(screen.getByTestId("donut")).toHaveTextContent("3");
  });

  it("renders recent activity with varied time labels and navigates on click", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<OverviewReport onSelectTable={onSelect} />);
    expect(await screen.findByText("Schema changed")).toBeInTheDocument();
    expect(screen.getByText(/s ago/)).toBeInTheDocument();
    expect(screen.getByText(/m ago/)).toBeInTheDocument();
    expect(screen.getByText(/h ago/)).toBeInTheDocument();
    expect(screen.getByText(/d ago/)).toBeInTheDocument();
    await user.click(screen.getByText("Schema changed"));
    expect(onSelect).toHaveBeenCalledWith("c1.s.a");
    // an activity row without a table_fqn should not navigate
    onSelect.mockClear();
    await user.click(screen.getByText("Pipeline ran"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("handles activity rows with missing fields (fallback title, no time, detail)", async () => {
    (api.listDQRules as any).mockResolvedValue({ rules: [] });
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("notifications")) return Promise.resolve({ ok: true, json: async () => ({ notifications: [
        // no title, no created_at, a `detail`, an unknown type -> default icon + "" time + type fallback
        { type: "misc_event", detail: "some detail" },
        // no title and no type -> "Activity" fallback
        { id: 9, created_at: "not-a-date" },
      ] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }) as any;
    render(<OverviewReport />);
    expect(await screen.findByText("misc_event")).toBeInTheDocument(); // title falls back to type
    expect(screen.getByText("some detail")).toBeInTheDocument();
    expect(screen.getByText("Activity")).toBeInTheDocument();          // title/type both absent
  });

  it("shows empty states when there are no tables or activity", async () => {
    useLineageStore.setState({ allTables: [] as any });
    (api.listDQRules as any).mockResolvedValue({ rules: [] });
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("notifications")) return Promise.resolve({ ok: true, json: async () => ({ notifications: [] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }) as any;
    render(<OverviewReport />);
    expect(await screen.findByText("No tables loaded.")).toBeInTheDocument();
    expect(screen.getByText("No recent activity.")).toBeInTheDocument();
  });

  it("survives failed API calls", async () => {
    (api.listDQRules as any).mockRejectedValue(new Error("nope"));
    global.fetch = vi.fn().mockRejectedValue(new Error("down")) as any;
    render(<OverviewReport />);
    // still renders the KPI shell without throwing
    expect(await screen.findByText("Tables")).toBeInTheDocument();
  });
});
