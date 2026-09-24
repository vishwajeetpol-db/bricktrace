import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { OverviewReport } from "./OverviewReport";
import { useLineageStore } from "../../store/lineageStore";

import { createElement } from "react";
vi.mock("framer-motion", () => ({
  motion: new Proxy({}, { get: (_t, tag: string) => (p: any) => {
    const { children, initial, animate, exit, transition, whileHover, ...rest } = p;
    return createElement(tag, rest, children);
  } }),
}));
vi.mock("../../api/client", () => ({
  api: { listDQRules: vi.fn().mockResolvedValue({ rules: [{ table_fqn: "main.s.a", rule_type: "NOT_NULL", column_name: "x" }] }) },
}));

function t(catalog: string, schema: string, name: string, type = "MANAGED") {
  return { name, fqdn: `${catalog}.${schema}.${name}`, catalog, schema, table_type: type };
}

describe("OverviewReport", () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rules: [], notifications: [] }) }) as any;
    useLineageStore.setState({
      allTables: [t("main", "s", "a"), t("main", "s", "b", "VIEW"), t("dev", "x", "c")],
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("computes estate KPIs from the loaded tables", () => {
    render(<OverviewReport />);
    expect(screen.getByText("Tables")).toBeInTheDocument();
    expect(screen.getByText("Catalogs")).toBeInTheDocument();
    expect(screen.getByText("Schemas")).toBeInTheDocument();
    expect(screen.getAllByText("3").length).toBeGreaterThanOrEqual(1);   // 3 tables
  });

  it("shows DQ coverage from authored rules", async () => {
    render(<OverviewReport />);
    // one table (main.s.a) has a rule out of 3 loaded tables
    expect(await screen.findByText("1/3 tables")).toBeInTheDocument();
  });

  it("renders the largest-catalogs breakdown", () => {
    render(<OverviewReport />);
    expect(screen.getByText("Largest catalogs")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
  });
});
