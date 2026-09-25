import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GlossaryPanel } from "./GlossaryPanel";
import { useLineageStore } from "../store/lineageStore";

const goTableLineage = vi.fn();
vi.mock("../hooks/useRouter", () => ({ goTableLineage: (t?: string) => goTableLineage(t) }));

function routeFetch(handlers: Record<string, any>) {
  return vi.fn().mockImplementation((url: string) => {
    for (const key of Object.keys(handlers)) {
      if (url.includes(key)) return Promise.resolve({ ok: true, json: async () => handlers[key] });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
}

const term = { term_id: "t1", name: "Revenue", definition: "money in", domain: "Finance", owner: "cfo", status: "approved", synonyms: "" };
const domain = { domain_id: "d1", name: "Finance", description: "money things", owner: "cfo", color: "#123456" };
const kpi = { kpi_id: "k1", name: "MRR", definition: "monthly recurring", formula_sql: "SELECT 1", source_tables: "t", owner: "o", domain: "Finance", granularity: "monthly" };

function fullFetch(overrides: Record<string, any> = {}) {
  return routeFetch({
    "glossary/terms": { terms: [term] },
    "glossary/domains": { domains: [domain] },
    "glossary/kpis": { kpis: [kpi] },
    ...overrides,
  });
}

describe("GlossaryPanel", () => {
  beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    goTableLineage.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useLineageStore.setState({ isAdmin: false });
  });

  it("loads and shows terms by default", async () => {
    global.fetch = fullFetch() as any;
    render(<GlossaryPanel />);
    expect(await screen.findByText("Revenue")).toBeInTheDocument();
    // "approved" now appears both as the term's status badge and as a status
    // filter pill — the badge is what matters here.
    expect(screen.getAllByText("approved").length).toBeGreaterThanOrEqual(1);
  });

  it("switches to domains tab", async () => {
    global.fetch = fullFetch() as any;
    const user = userEvent.setup();
    render(<GlossaryPanel />);
    await screen.findByText("Revenue");
    await user.click(screen.getByText("Domains"));
    expect(await screen.findByText("money things")).toBeInTheDocument();
  });

  it("switches to kpis tab", async () => {
    global.fetch = fullFetch() as any;
    const user = userEvent.setup();
    render(<GlossaryPanel />);
    await screen.findByText("Revenue");
    await user.click(screen.getByText("KPIs"));
    expect(await screen.findByText("MRR")).toBeInTheDocument();
    expect(screen.getByText("SELECT 1")).toBeInTheDocument();
  });

  it("toggles the add-term form and submits", async () => {
    const fetchMock = fullFetch();
    global.fetch = fetchMock as any;
    const user = userEvent.setup();
    render(<GlossaryPanel />);
    await screen.findByText("Revenue");
    await user.click(screen.getByText("+ Add Term"));
    await user.type(screen.getByPlaceholderText("Term name"), "New");
    await user.click(screen.getByText("Save Term"));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => c[1]?.method === "POST" && String(c[0]).includes("glossary/terms"))).toBe(true);
    });
  });

  it("deletes a term", async () => {
    // Term deletion is admin-gated server-side, so the control only renders for
    // admins — claim an admin identity to drive it.
    useLineageStore.setState({ isAdmin: true });
    const fetchMock = fullFetch();
    global.fetch = fetchMock as any;
    const user = userEvent.setup();
    render(<GlossaryPanel />);
    await screen.findByText("Revenue");
    await user.click(screen.getByText("×"));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => c[1]?.method === "DELETE")).toBe(true);
    });
  });

  it("hides the delete control from non-admins", async () => {
    // A hard delete of the term plus all its asset links — non-admins get 403,
    // so the button must not be offered.
    global.fetch = fullFetch() as any;
    render(<GlossaryPanel />);
    await screen.findByText("Revenue");
    expect(screen.queryByText("×")).not.toBeInTheDocument();
  });

  it("shows empty terms state", async () => {
    global.fetch = fullFetch({ "glossary/terms": { terms: [] } }) as any;
    render(<GlossaryPanel />);
    expect(await screen.findByText(/No terms found/)).toBeInTheDocument();
  });

  it("searches terms on Enter", async () => {
    const fetchMock = fullFetch();
    global.fetch = fetchMock as any;
    const user = userEvent.setup();
    render(<GlossaryPanel />);
    await screen.findByText("Revenue");
    const search = screen.getByPlaceholderText("Search terms...");
    await user.type(search, "rev{Enter}");
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("q=rev"))).toBe(true);
    });
  });

  it("edits all add-term form fields", async () => {
    global.fetch = fullFetch() as any;
    const user = userEvent.setup();
    render(<GlossaryPanel />);
    await screen.findByText("Revenue");
    await user.click(screen.getByText("+ Add Term"));
    await user.type(screen.getByPlaceholderText("Term name"), "N");
    await user.type(screen.getByPlaceholderText("Domain"), "D");
    await user.type(screen.getByPlaceholderText("Owner"), "O");
    await user.type(screen.getByPlaceholderText("Definition"), "def");
    await user.selectOptions(screen.getByRole("combobox"), "approved");
    expect((screen.getByPlaceholderText("Term name") as HTMLInputElement).value).toBe("N");
    // toggle form closed via Cancel
    await user.click(screen.getByText("Cancel"));
    expect(screen.queryByPlaceholderText("Term name")).not.toBeInTheDocument();
  });

  it("shows empty domains and kpis states", async () => {
    global.fetch = fullFetch({ "glossary/domains": { domains: [] }, "glossary/kpis": { kpis: [] } }) as any;
    const user = userEvent.setup();
    render(<GlossaryPanel />);
    await screen.findByText("Revenue");
    await user.click(screen.getByText("Domains"));
    expect(await screen.findByText("No domains defined yet.")).toBeInTheDocument();
    await user.click(screen.getByText("KPIs"));
    expect(await screen.findByText("No KPIs defined yet.")).toBeInTheDocument();
  });

  it("adds a domain from the Domains tab", async () => {
    const fetchMock = fullFetch();
    global.fetch = fetchMock as any;
    const user = userEvent.setup();
    render(<GlossaryPanel />);
    await screen.findByText("Revenue");
    await user.click(screen.getByText("Domains"));
    await user.click(screen.getByText("+ Add Domain"));
    await user.type(screen.getByPlaceholderText("Domain name"), "Marketing");
    await user.click(screen.getByText("Save Domain"));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => c[1]?.method === "POST" && String(c[0]).includes("glossary/domains"))).toBe(true);
    });
  });

  it("adds a KPI from the KPIs tab", async () => {
    const fetchMock = fullFetch();
    global.fetch = fetchMock as any;
    const user = userEvent.setup();
    render(<GlossaryPanel />);
    await screen.findByText("Revenue");
    await user.click(screen.getByText("KPIs"));
    await user.click(screen.getByText("+ Add KPI"));
    await user.type(screen.getByPlaceholderText("KPI name"), "ARR");
    await user.click(screen.getByText("Save KPI"));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => c[1]?.method === "POST" && String(c[0]).includes("glossary/kpis"))).toBe(true);
    });
  });

  it("expands a term and links it to a table", async () => {
    const fetchMock = fullFetch({ "glossary/terms/t1": { term, links: [] } });
    global.fetch = fetchMock as any;
    const user = userEvent.setup();
    render(<GlossaryPanel />);
    await user.click(await screen.findByText("Revenue"));
    // expanded term shows the "not linked" prompt + a link editor
    expect(await screen.findByText(/Not linked to any table yet/)).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("catalog.schema.table"), "main.sales.orders");
    await user.click(screen.getByText("Link"));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => c[1]?.method === "POST" && String(c[0]).includes("glossary/link"))).toBe(true);
    });
  });

  it("filters terms by status pill (adds status= and toggles off)", async () => {
    const fetchMock = fullFetch();
    global.fetch = fetchMock as any;
    const user = userEvent.setup();
    render(<GlossaryPanel />);
    await screen.findByText("Revenue");
    // "approved" is both a status badge (span) and a filter pill (button) — target the pill.
    await user.click(screen.getByRole("button", { name: "approved" }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("status=approved"))).toBe(true));
    // toggling the same pill off drops the filter again
    await user.click(screen.getByRole("button", { name: "approved" }));
    await waitFor(() => {
      const last = String(fetchMock.mock.calls.at(-1)?.[0]);
      expect(last.includes("status=")).toBe(false);
    });
  });

  it("shows linked assets on a term and navigates to lineage", async () => {
    // A single term detail fetch (/terms/t1) must beat the /terms list route, so
    // match the more-specific path first.
    global.fetch = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("glossary/terms/t1")) return Promise.resolve({ ok: true, json: async () => ({ term, links: [{ link_id: "l1", term_id: "t1", asset_type: "table", asset_fqn: "main.s.orders", column_name: "" }] }) });
      if (u.includes("glossary/terms")) return Promise.resolve({ ok: true, json: async () => ({ terms: [term] }) });
      if (u.includes("glossary/domains")) return Promise.resolve({ ok: true, json: async () => ({ domains: [domain] }) });
      if (u.includes("glossary/kpis")) return Promise.resolve({ ok: true, json: async () => ({ kpis: [kpi] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }) as any;
    const user = userEvent.setup();
    render(<GlossaryPanel />);
    await user.click(await screen.findByText("Revenue"));
    const chip = await screen.findByText("main.s.orders");
    await user.click(chip);
    expect(goTableLineage).toHaveBeenCalledWith("main.s.orders");
  });

  it("collapses an expanded term when clicked again", async () => {
    global.fetch = fullFetch({ "glossary/terms/t1": { term, links: [] } }) as any;
    const user = userEvent.setup();
    render(<GlossaryPanel />);
    await user.click(await screen.findByText("Revenue"));
    expect(await screen.findByText(/Not linked to any table yet/)).toBeInTheDocument();
    await user.click(screen.getByText("Revenue"));
    await waitFor(() => expect(screen.queryByText(/Not linked to any table yet/)).not.toBeInTheDocument());
  });

  it("navigates from a KPI source-table chip", async () => {
    global.fetch = fullFetch() as any;
    const user = userEvent.setup();
    render(<GlossaryPanel />);
    await screen.findByText("Revenue");
    await user.click(screen.getByText("KPIs"));
    await screen.findByText("MRR");
    await user.click(screen.getByText("t")); // source_tables chip from the kpi fixture
    expect(goTableLineage).toHaveBeenCalledWith("t");
  });

  it("propagation: warns when the source has no linked terms", async () => {
    const propResult = { source_table: "main.bronze.sales", source_terms: [], downstream_count: 0, suggestions: [], suggestion_count: 0, note: "No terms linked to source table" };
    global.fetch = fullFetch({ "propagate-suggestions": propResult }) as any;
    const user = userEvent.setup();
    render(<GlossaryPanel />);
    await screen.findByText("Revenue");
    await user.click(screen.getByText("Propagation"));
    await user.type(screen.getByPlaceholderText("catalog.schema.table"), "main.bronze.sales");
    await user.click(screen.getByText("Find suggestions"));
    expect(await screen.findByText(/none linked to/)).toBeInTheDocument();
    expect(screen.getByText(/No terms linked to source table/)).toBeInTheDocument();
  });

  it("propagation: rejects an incomplete table name", async () => {
    global.fetch = fullFetch() as any;
    const user = userEvent.setup();
    render(<GlossaryPanel />);
    await screen.findByText("Revenue");
    await user.click(screen.getByText("Propagation"));
    // button is disabled for a bad fqn, but Enter still triggers run() -> error
    await user.type(screen.getByPlaceholderText("catalog.schema.table"), "justacatalog{Enter}");
    expect(await screen.findByText(/Enter a full table name/)).toBeInTheDocument();
  });

  it("propagation: applies a single missing term", async () => {
    const propResult = {
      source_table: "main.bronze.sales",
      source_terms: [{ term_id: "t1", term_name: "Revenue" }],
      downstream_count: 1,
      suggestions: [{ target_table: "main.gold.rev", missing_terms: [{ term_id: "t1", name: "Revenue" }] }],
      suggestion_count: 1,
    };
    const fetchMock = fullFetch({ "propagate-suggestions": propResult });
    global.fetch = fetchMock as any;
    const user = userEvent.setup();
    render(<GlossaryPanel />);
    await screen.findByText("Revenue");
    await user.click(screen.getByText("Propagation"));
    await user.type(screen.getByPlaceholderText("catalog.schema.table"), "main.bronze.sales");
    await user.click(screen.getByText("Find suggestions"));
    await screen.findByText("main.gold.rev");
    // click the individual term chip (not "Apply all")
    const chips = screen.getAllByText("Revenue");
    await user.click(chips[chips.length - 1]);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[1]?.method === "POST" && String(c[0]).includes("glossary/link"))).toBe(true));
  });

  it("runs the propagation wizard and applies a suggestion", async () => {
    const propResult = {
      source_table: "main.bronze.sales",
      source_terms: [{ term_id: "t1", term_name: "Revenue", domain: "Finance" }],
      downstream_count: 2,
      suggestions: [{ target_table: "main.gold.revenue_daily", missing_terms: [{ term_id: "t1", name: "Revenue", domain: "Finance" }] }],
      suggestion_count: 1,
    };
    const fetchMock = fullFetch({ "propagate-suggestions": propResult });
    global.fetch = fetchMock as any;
    const user = userEvent.setup();
    render(<GlossaryPanel />);
    await screen.findByText("Revenue");
    await user.click(screen.getByText("Propagation"));
    await user.type(screen.getByPlaceholderText("catalog.schema.table"), "main.bronze.sales");
    await user.click(screen.getByText("Find suggestions"));
    // downstream table + its missing term chip render
    expect(await screen.findByText("main.gold.revenue_daily")).toBeInTheDocument();
    await user.click(screen.getByText("Apply all"));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => c[1]?.method === "POST" && String(c[0]).includes("glossary/link"))).toBe(true);
    });
  });
});
