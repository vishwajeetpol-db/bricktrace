import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExportPanel } from "./ExportPanel";
import { useLineageStore } from "../store/lineageStore";

/** Importing OpenLineage events is admin-gated server-side, so the tab only
 *  renders for admins. Tests that drive it must claim an admin identity. */
function asAdmin() {
  useLineageStore.setState({ isAdmin: true });
}

function routeFetch(handlers: Record<string, any>) {
  return vi.fn().mockImplementation((url: string) => {
    for (const key of Object.keys(handlers)) {
      if (url.includes(key)) return Promise.resolve({ ok: true, json: async () => handlers[key] });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
}

describe("ExportPanel", () => {
  beforeEach(() => {
    (URL as any).createObjectURL = vi.fn(() => "blob:x");
    (URL as any).revokeObjectURL = vi.fn();
    vi.spyOn(window, "alert").mockImplementation(() => {});
    // jsdom anchor click is a noop; ensure it doesn't throw
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useLineageStore.setState({ isAdmin: false, allTables: [] as any });
  });

  it("hides the import tab from non-admins", () => {
    // The backend admin-gates POST /api/import/openlineage, so a non-admin must
    // not be shown a control that can only 403.
    render(<ExportPanel catalog="main" />);
    expect(screen.queryByText("Import Events")).not.toBeInTheDocument();
    expect(screen.getByText("OpenLineage Export")).toBeInTheDocument();
  });

  it("shows the import tab to admins", () => {
    asAdmin();
    render(<ExportPanel catalog="main" />);
    expect(screen.getByText("Import Events")).toBeInTheDocument();
  });

  it("renders export tab by default", () => {
    render(<ExportPanel catalog="main" schema="s" />);
    expect(screen.getByText("Export & Interop")).toBeInTheDocument();
    expect(screen.getByText("Export as OpenLineage JSON")).toBeInTheDocument();
  });

  it("lets the user pick a scope when none is provided (fixes always-disabled export)", async () => {
    // Reached from the sidebar with no browse context: no catalog prop.
    useLineageStore.setState({ allTables: [
      { name: "a", fqdn: "cat1.s1.a", catalog: "cat1", schema: "s1", table_type: "MANAGED" },
      { name: "b", fqdn: "cat1.s2.b", catalog: "cat1", schema: "s2", table_type: "MANAGED" },
      { name: "c", fqdn: "cat2.s.c", catalog: "cat2", schema: "s", table_type: "MANAGED" },
    ] as any });
    const fetchMock = routeFetch({ "export/openlineage": { events: [], count: 0, namespace: "n", byte_size: 2, conformance: { valid: true, event_count: 0, invalid_count: 0, issues: [] } } });
    global.fetch = fetchMock as any;
    const user = userEvent.setup();
    render(<ExportPanel />);
    // With no scope, export is disabled.
    const exportBtn = screen.getByText("Export as OpenLineage JSON").closest("button")!;
    expect(exportBtn).toBeDisabled();
    // Pick a catalog -> export enables and the request carries that catalog.
    await user.selectOptions(screen.getByLabelText("Catalog"), "cat1");
    expect(exportBtn).not.toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Schema"), "s2");
    await user.click(screen.getByText("Preview"));
    await waitFor(() => {
      const url = String(fetchMock.mock.calls.at(-1)?.[0]);
      expect(url).toContain("catalog=cat1");
      expect(url).toContain("schema=s2");
    });
  });

  it("exports openlineage json", async () => {
    const fetchMock = routeFetch({ "export/openlineage": { events: [] } });
    global.fetch = fetchMock as any;
    const user = userEvent.setup();
    render(<ExportPanel catalog="main" schema="s" />);
    await user.click(screen.getByText("Export as OpenLineage JSON"));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("export/openlineage"))).toBe(true);
    });
    expect((URL as any).createObjectURL).toHaveBeenCalled();
  });

  it("imports events and shows result", async () => {
    asAdmin();
    global.fetch = routeFetch({ "import/openlineage": { imported: 2 } }) as any;
    const user = userEvent.setup();
    render(<ExportPanel catalog="main" />);
    await user.click(screen.getByText("Import Events"));
    // textarea empty -> import button disabled; type valid JSON
    const textarea = screen.getByPlaceholderText(/eventType/);
    await user.type(textarea, '{{"eventType":"COMPLETE"}');
    await user.click(screen.getAllByText("Import Events")[1] ?? screen.getByText("Import Events"));
    expect(await screen.findByText(/imported/)).toBeInTheDocument();
  });

  it("shows import parse error", async () => {
    asAdmin();
    global.fetch = routeFetch({}) as any;
    const user = userEvent.setup();
    render(<ExportPanel catalog="main" />);
    await user.click(screen.getByText("Import Events"));
    const textarea = screen.getByPlaceholderText(/eventType/);
    await user.type(textarea, "not json");
    await user.click(screen.getAllByText("Import Events")[1] ?? screen.getByText("Import Events"));
    expect(await screen.findByText(/error/)).toBeInTheDocument();
  });

  it("previews events and shows a conformance badge", async () => {
    global.fetch = routeFetch({
      "export/openlineage": {
        events: [{ eventType: "COMPLETE", outputs: [{ name: "main.s.t" }] }],
        count: 1, namespace: "databricks://h", byte_size: 2048,
        conformance: { valid: true, event_count: 1, invalid_count: 0, issues: [] },
      },
    }) as any;
    const user = userEvent.setup();
    render(<ExportPanel catalog="main" schema="s" />);
    await user.click(screen.getByText("Preview"));
    expect(await screen.findByText(/conformant/)).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument(); // event count
  });

  it("surfaces non-conformant issues in the preview", async () => {
    global.fetch = routeFetch({
      "export/openlineage": {
        events: [{ eventType: "DONE" }], count: 1, namespace: "databricks://h", byte_size: 100,
        conformance: { valid: false, event_count: 1, invalid_count: 1, issues: [{ event_index: 0, issue: "eventType must be one of ..." }] },
      },
    }) as any;
    const user = userEvent.setup();
    render(<ExportPanel catalog="main" schema="s" />);
    await user.click(screen.getByText("Preview"));
    expect(await screen.findByText(/non-conformant/)).toBeInTheDocument();
    expect(screen.getByText(/eventType must be one of/)).toBeInTheDocument();
  });

  it("passes facet toggles through to the export request", async () => {
    const fetchMock = routeFetch({ "export/openlineage": { events: [], count: 0, namespace: "n", byte_size: 2, conformance: { valid: true, event_count: 0, invalid_count: 0, issues: [] } } });
    global.fetch = fetchMock as any;
    const user = userEvent.setup();
    render(<ExportPanel catalog="main" schema="s" />);
    // Turn Documentation off, then preview.
    await user.click(screen.getByText("Documentation"));
    await user.click(screen.getByText("Preview"));
    await waitFor(() => {
      const url = String(fetchMock.mock.calls.at(-1)?.[0]);
      expect(url).toContain("include_docs=false");
      expect(url).toContain("include_schema=true");
    });
  });

  it("exports as ND-JSON when that format is selected", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '{"eventType":"COMPLETE"}' }) as any;
    global.fetch = fetchMock;
    const user = userEvent.setup();
    render(<ExportPanel catalog="main" schema="s" />);
    await user.click(screen.getByText("ND-JSON"));
    await user.click(screen.getByText("Export as OpenLineage JSON"));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c: any[]) => String(c[0]).includes("format=ndjson"))).toBe(true);
    });
    expect((URL as any).createObjectURL).toHaveBeenCalled();
  });

  it("shows an error when preview fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as any;
    const user = userEvent.setup();
    render(<ExportPanel catalog="main" schema="s" />);
    await user.click(screen.getByText("Preview"));
    expect(await screen.findByText(/Preview failed/)).toBeInTheDocument();
  });

  it("shows an error when export fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as any;
    const user = userEvent.setup();
    render(<ExportPanel catalog="main" schema="s" />);
    await user.click(screen.getByText("Export as OpenLineage JSON"));
    expect(await screen.findByText(/Export failed/)).toBeInTheDocument();
  });

  it("copies the payload to the clipboard", async () => {
    global.fetch = routeFetch({
      "export/openlineage": { events: [{ eventType: "COMPLETE" }], count: 1, namespace: "n", byte_size: 10, conformance: { valid: true, event_count: 1, invalid_count: 0, issues: [] } },
    }) as any;
    const user = userEvent.setup();
    // Define AFTER userEvent.setup() — its own clipboard stub would otherwise win.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ExportPanel catalog="main" schema="s" />);
    await user.click(screen.getByText("Copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("reports a clipboard failure", async () => {
    global.fetch = routeFetch({
      "export/openlineage": { events: [], count: 0, namespace: "n", byte_size: 2, conformance: { valid: true, event_count: 0, invalid_count: 0, issues: [] } },
    }) as any;
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("no clip")) }, configurable: true });
    render(<ExportPanel catalog="main" schema="s" />);
    await user.click(screen.getByText("Copy"));
    expect(await screen.findByText(/Clipboard unavailable/)).toBeInTheDocument();
  });

  it("shows the empty-scope message when there are no events", async () => {
    global.fetch = routeFetch({
      "export/openlineage": { events: [], count: 0, namespace: "databricks://h", byte_size: 2, conformance: { valid: true, event_count: 0, invalid_count: 0, issues: [] } },
    }) as any;
    const user = userEvent.setup();
    render(<ExportPanel catalog="main" schema="s" />);
    await user.click(screen.getByText("Preview"));
    expect(await screen.findByText(/nothing to export/)).toBeInTheDocument();
  });

  it("shows a capture error when the snapshot request fails", async () => {
    global.fetch = vi.fn().mockImplementation((url: string, opts?: any) => {
      if (String(url).includes("snapshots/capture")) return Promise.resolve({ ok: false, status: 400, json: async () => ({ detail: "bad scope" }) });
      return Promise.resolve({ ok: true, json: async () => ({ snapshots: [] }) });
    }) as any;
    const user = userEvent.setup();
    render(<ExportPanel catalog="main" />);
    await user.click(screen.getByText("Graph Snapshots"));
    await user.click(screen.getByText("Capture Now"));
    expect(await screen.findByText("bad scope")).toBeInTheDocument();
  });

  it("copies ND-JSON using an already-fetched preview (no re-fetch)", async () => {
    const fetchMock = routeFetch({
      "export/openlineage": { events: [{ eventType: "COMPLETE" }, { eventType: "COMPLETE" }], count: 2, namespace: "n", byte_size: 20, conformance: { valid: true, event_count: 2, invalid_count: 0, issues: [] } },
    });
    global.fetch = fetchMock as any;
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ExportPanel catalog="main" schema="s" />);
    await user.click(screen.getByText("ND-JSON"));
    await user.click(screen.getByText("Preview"));  // one fetch
    await screen.findByText(/conformant/);
    const callsAfterPreview = fetchMock.mock.calls.length;
    await user.click(screen.getByText("Copy"));      // should reuse preview, no new fetch
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(fetchMock.mock.calls.length).toBe(callsAfterPreview);
    // ND-JSON payload = newline-joined events
    expect(writeText.mock.calls[0][0]).toContain("\n");
  });

  it("swallows a snapshot-list load failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("down")) as any;
    const user = userEvent.setup();
    render(<ExportPanel catalog="main" />);
    await user.click(screen.getByText("Graph Snapshots"));
    // No crash; the empty-state renders once loading settles.
    expect(await screen.findByText(/No snapshots yet/)).toBeInTheDocument();
  });

  it("reports a capture network failure", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("snapshots/capture")) return Promise.reject(new Error("boom"));
      return Promise.resolve({ ok: true, json: async () => ({ snapshots: [] }) });
    }) as any;
    const user = userEvent.setup();
    render(<ExportPanel catalog="main" />);
    await user.click(screen.getByText("Graph Snapshots"));
    await user.click(screen.getByText("Capture Now"));
    expect(await screen.findByText(/could not reach the server/)).toBeInTheDocument();
  });

  it("loads snapshots tab and shows empty state", async () => {
    global.fetch = routeFetch({ "/api/snapshots": { snapshots: [] } }) as any;
    const user = userEvent.setup();
    render(<ExportPanel catalog="main" />);
    await user.click(screen.getByText("Graph Snapshots"));
    expect(await screen.findByText(/No snapshots yet/)).toBeInTheDocument();
  });

  it("captures a snapshot", async () => {
    const fetchMock = routeFetch({
      "snapshots/capture": { node_count: 10, edge_count: 8 },
      "/api/snapshots": { snapshots: [{ snapshot_id: "abcdef1234", label: "snap", scope: "main", captured_at: "2024-05-01T00:00:00Z", node_count: 10, edge_count: 8 }] },
    });
    global.fetch = fetchMock as any;
    const user = userEvent.setup();
    render(<ExportPanel catalog="main" />);
    await user.click(screen.getByText("Graph Snapshots"));
    await user.click(screen.getByText("Capture Now"));
    expect(await screen.findByText("snap")).toBeInTheDocument();
    expect(window.alert).toHaveBeenCalled();
  });
});
