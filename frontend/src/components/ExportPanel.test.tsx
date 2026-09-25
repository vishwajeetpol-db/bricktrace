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
    useLineageStore.setState({ isAdmin: false });
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
