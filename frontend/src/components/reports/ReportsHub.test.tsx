import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReportsHub } from "./ReportsHub";
import { useLineageStore } from "../../store/lineageStore";

import { createElement } from "react";
vi.mock("framer-motion", () => ({
  motion: new Proxy({}, { get: (_t, tag: string) => (p: any) => {
    const { children, initial, animate, exit, transition, whileHover, ...rest } = p;
    return createElement(tag, rest, children);
  } }),
  AnimatePresence: ({ children }: any) => children,
}));
const goDQ = vi.fn();
vi.mock("../../hooks/useRouter", () => ({ goDQ: () => goDQ() }));
vi.mock("../../api/client", () => ({
  api: { listDQRules: vi.fn().mockResolvedValue({ rules: [] }) },
}));

describe("ReportsHub", () => {
  beforeEach(() => {
    goDQ.mockReset();
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rules: [], notifications: [] }) }) as any;
    useLineageStore.setState({ allTables: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders the report catalog cards", () => {
    render(<ReportsHub />);
    expect(screen.getByText("Executive Overview")).toBeInTheDocument();
    expect(screen.getByText("Root Cause Analysis")).toBeInTheDocument();
    expect(screen.getByText("Data Quality")).toBeInTheDocument();
    expect(screen.getAllByText("soon").length).toBeGreaterThanOrEqual(1);
  });

  it("opens the Executive Overview report", async () => {
    const user = userEvent.setup();
    render(<ReportsHub />);
    await user.click(screen.getByText("Executive Overview"));
    expect(screen.getByText("All reports")).toBeInTheDocument(); // back link
    expect(screen.getByText("Tables")).toBeInTheDocument(); // a KPI label
  });

  it("opens the Root Cause report", async () => {
    const user = userEvent.setup();
    render(<ReportsHub />);
    await user.click(screen.getByText("Root Cause Analysis"));
    expect(screen.getByText("Analyze root cause")).toBeInTheDocument();
  });

  it("deep-links Data Quality to the DQ screen", async () => {
    const user = userEvent.setup();
    render(<ReportsHub />);
    await user.click(screen.getByText("Data Quality"));
    expect(goDQ).toHaveBeenCalled();
  });

  it("does not open 'soon' reports", async () => {
    const user = userEvent.setup();
    render(<ReportsHub />);
    await user.click(screen.getByText("Lineage Coverage"));
    // still on the hub — the overview KPI label is not shown
    expect(screen.queryByText("All reports")).not.toBeInTheDocument();
  });
});
