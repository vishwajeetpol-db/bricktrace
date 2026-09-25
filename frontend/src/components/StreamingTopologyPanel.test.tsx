import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StreamingTopologyPanel } from "./StreamingTopologyPanel";

const goTableLineage = vi.fn();
vi.mock("../hooks/useRouter", () => ({ goTableLineage: (t?: string) => goTableLineage(t) }));

// The topology tab is a reactflow graph (excluded from coverage + flaky in jsdom);
// stub it so panel tests exercise panel logic, not reactflow internals.
vi.mock("./graph/StreamTopologyGraph", () => ({
  StreamTopologyGraph: ({ nodes }: { nodes: any[] }) => (
    <div data-testid="topo-graph">graph:{nodes.length}</div>
  ),
}));

function routeFetch(handlers: Record<string, any>) {
  return vi.fn().mockImplementation((url: string) => {
    for (const key of Object.keys(handlers)) {
      if (String(url).includes(key)) {
        const h = handlers[key];
        if (h.__http === false) return Promise.resolve({ ok: false, status: h.status || 500, json: async () => ({}), text: async () => `error ${h.status || 500}` });
        return Promise.resolve({ ok: true, status: 200, json: async () => h });
      }
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  });
}

const streamNode = {
  table_catalog: "main", table_schema: "s", table_name: "orders_stream",
  fqn: "main.s.orders_stream", source_kind: "kafka", pipeline_id: "p1",
  pipeline_name: "orders_pipeline", age_seconds: 120, freshness: "fresh",
};

describe("StreamingTopologyPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    goTableLineage.mockReset();
  });

  it("renders header and initial prompt", () => {
    render(<StreamingTopologyPanel />);
    expect(screen.getByText("Streaming Topology")).toBeInTheDocument();
    expect(screen.getByText(/Click "Detect Topology"/)).toBeInTheDocument();
  });

  it("fetches topology + metrics and shows KPI strip and graph", async () => {
    global.fetch = routeFetch({
      "streaming-topology": { streaming_tables: [streamNode], streaming_edges: [{ source: "main.s.raw", target: "main.s.orders_stream" }] },
      "streaming-metrics": { metrics: { p1: { status: "active", throughput_rows: 1200, backlog_records: 0, trend: [1, 2, 3] } }, count: 1 },
    }) as any;
    const user = userEvent.setup();
    render(<StreamingTopologyPanel catalog="main" />);
    await user.click(screen.getByText("Detect Topology"));
    expect(await screen.findByText("Streaming Tables")).toBeInTheDocument();
    // KPI strip + default topology tab (stubbed graph) render
    expect(screen.getByTestId("topo-graph")).toHaveTextContent("graph:1");
    expect(screen.getAllByText("Active Pipelines").length).toBe(1);
  });

  it("switches to the metrics tab and shows per-stream rows with live metrics", async () => {
    global.fetch = routeFetch({
      "streaming-topology": { streaming_tables: [streamNode], streaming_edges: [] },
      "streaming-metrics": { metrics: { p1: { status: "active", throughput_rows: 1200, backlog_records: 5, trend: [1, 2, 3] } }, count: 1 },
    }) as any;
    const user = userEvent.setup();
    render(<StreamingTopologyPanel />);
    await user.click(screen.getByText("Detect Topology"));
    await screen.findByText("Streaming Tables");
    await user.click(screen.getByText("Metrics"));
    expect(await screen.findByText("orders_stream")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText(/1,200 rows/)).toBeInTheDocument();
    expect(screen.getByText("orders_pipeline")).toBeInTheDocument();
  });

  it("drills into lineage from a metrics row", async () => {
    global.fetch = routeFetch({
      "streaming-topology": { streaming_tables: [streamNode], streaming_edges: [] },
      "streaming-metrics": { metrics: { p1: { status: "active" } }, count: 1 },
    }) as any;
    const user = userEvent.setup();
    render(<StreamingTopologyPanel />);
    await user.click(screen.getByText("Detect Topology"));
    await screen.findByText("Streaming Tables");
    await user.click(screen.getByText("Metrics"));
    await user.click(await screen.findByTitle("Open lineage"));
    expect(goTableLineage).toHaveBeenCalledWith("main.s.orders_stream");
  });

  it("filters streams by freshness pill", async () => {
    const stale = { ...streamNode, table_name: "cold_stream", fqn: "main.s.cold_stream", freshness: "stale", pipeline_id: "p2" };
    global.fetch = routeFetch({
      "streaming-topology": { streaming_tables: [streamNode, stale], streaming_edges: [] },
      "streaming-metrics": { metrics: {}, count: 0 },
    }) as any;
    const user = userEvent.setup();
    render(<StreamingTopologyPanel />);
    await user.click(screen.getByText("Detect Topology"));
    await screen.findByText("Streaming Tables");
    await user.click(screen.getByText("Metrics"));
    expect(await screen.findByText("orders_stream")).toBeInTheDocument();
    // click the "stale" pill → only the stale stream remains
    await user.click(screen.getByRole("button", { name: "stale" }));
    await waitFor(() => expect(screen.queryByText("orders_stream")).not.toBeInTheDocument());
    expect(screen.getByText("cold_stream")).toBeInTheDocument();
  });

  it("renders every metric variant, age bucket, and the live toggle", async () => {
    const nodes = [
      { table_catalog: "c", table_schema: "s", table_name: "sec_stream", fqn: "c.s.sec_stream", source_kind: "kafka", pipeline_id: "p1", pipeline_name: "pA", age_seconds: 30, freshness: "fresh" },
      { table_catalog: "c", table_schema: "s", table_name: "min_stream", fqn: "c.s.min_stream", source_kind: "delta", pipeline_id: null, age_seconds: 300, freshness: "lagging" },
      { table_catalog: "c", table_schema: "s", table_name: "hour_stream", fqn: "c.s.hour_stream", pipeline_id: "p3", age_seconds: 7200, freshness: "lagging" },
      { table_catalog: "c", table_schema: "s", table_name: "day_stream", fqn: "c.s.day_stream", pipeline_id: "p4", age_seconds: 172800, freshness: "stale" },
      { table_catalog: "c", table_schema: "s", table_name: "null_stream", fqn: "c.s.null_stream", pipeline_id: "p5", age_seconds: null, freshness: "unknown" },
    ];
    global.fetch = routeFetch({
      "streaming-topology": { streaming_tables: nodes, streaming_edges: [] },
      "streaming-metrics": { metrics: {
        p1: { status: "active", throughput_rows: 1200, backlog_records: 5, trend: [1, 2, 3] },
        p3: { status: "idle", throughput_rows: null, backlog_records: 0, trend: [] },
        p4: { status: "failed" },
        p5: { status: "unknown" },
      }, count: 4 },
    }) as any;
    const user = userEvent.setup();
    render(<StreamingTopologyPanel />);
    await user.click(screen.getByText("Detect Topology"));
    await screen.findByText("Streaming Tables");
    await user.click(screen.getByText("Metrics"));
    // age buckets
    expect(await screen.findByText(/fresh · 30s ago/)).toBeInTheDocument();
    expect(screen.getByText(/lagging · 5m ago/)).toBeInTheDocument();
    expect(screen.getByText(/lagging · 2h ago/)).toBeInTheDocument();
    expect(screen.getByText(/stale · 2d ago/)).toBeInTheDocument();
    expect(screen.getByText(/unknown · —/)).toBeInTheDocument();
    // status variants + throughput/backlog "—" branches + sparkline empty
    expect(screen.getAllByText("Failed").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Idle").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("no data").length).toBeGreaterThanOrEqual(1);
    // pipeline_name fallback to short id when name missing
    expect(screen.getByText("p3".slice(0, 8))).toBeInTheDocument();
    // Live auto-refresh toggle on then off
    await user.click(screen.getByTitle("Auto-refresh every 30s"));
    await user.click(screen.getByTitle("Auto-refresh every 30s"));
  });

  it("triggers detection on Enter in the catalog input", async () => {
    global.fetch = routeFetch({
      "streaming-topology": { streaming_tables: [streamNode], streaming_edges: [] },
      "streaming-metrics": { metrics: {}, count: 0 },
    }) as any;
    const user = userEvent.setup();
    render(<StreamingTopologyPanel />);
    await user.type(screen.getByPlaceholderText(/Catalog/), "main{Enter}");
    expect(await screen.findByText("Streaming Tables")).toBeInTheDocument();
  });

  it("tolerates a metrics fetch failure without blanking the topology", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("streaming-metrics")) return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ streaming_tables: [streamNode], streaming_edges: [] }) });
    }) as any;
    const user = userEvent.setup();
    render(<StreamingTopologyPanel />);
    await user.click(screen.getByText("Detect Topology"));
    // topology still renders even though metrics failed
    expect(await screen.findByText("Streaming Tables")).toBeInTheDocument();
    expect(screen.getByTestId("topo-graph")).toHaveTextContent("graph:1");
  });

  it("fuzzy-filters catalogs and fills the input on select", async () => {
    global.fetch = routeFetch({
      "/api/catalogs": { catalogs: ["prod_sales", "prod_marketing", "dev_sandbox"] },
      "streaming-topology": { streaming_tables: [], streaming_edges: [] },
    }) as any;
    const user = userEvent.setup();
    render(<StreamingTopologyPanel />);
    const input = screen.getByPlaceholderText(/Catalog/);
    await user.click(input);
    // subsequence "psl" matches prod_saLes but not the others
    await user.type(input, "psl");
    const option = await screen.findByText("prod_sales");
    expect(screen.queryByText("dev_sandbox")).not.toBeInTheDocument();
    await user.click(option);
    expect((input as HTMLInputElement).value).toBe("prod_sales");
  });

  it("shows unavailable error", async () => {
    global.fetch = routeFetch({ "streaming-topology": { available: false, error: "no streaming" } }) as any;
    const user = userEvent.setup();
    render(<StreamingTopologyPanel />);
    await user.click(screen.getByText("Detect Topology"));
    expect(await screen.findByText("no streaming")).toBeInTheDocument();
  });

  it("shows HTTP error", async () => {
    global.fetch = routeFetch({ "streaming-topology": { __http: false, status: 502 } }) as any;
    const user = userEvent.setup();
    render(<StreamingTopologyPanel />);
    await user.click(screen.getByText("Detect Topology"));
    expect(await screen.findByText(/502/)).toBeInTheDocument();
  });
});
