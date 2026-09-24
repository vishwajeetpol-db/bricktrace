import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SideNav from "./SideNav";
import { useLineageStore } from "../../store/lineageStore";
import { useFeatureFlagStore } from "../../store/featureFlagStore";

const nav = {
  goLanding: vi.fn(), goCatalogs: vi.fn(), goTableLineage: vi.fn(), goDQ: vi.fn(),
  goRootCause: vi.fn(), goControlPanel: vi.fn(), goGlossary: vi.fn(), goNotifications: vi.fn(),
  goExport: vi.fn(), goBiConsumers: vi.fn(), goStreaming: vi.fn(),
};
let currentView = "dq";
vi.mock("../../hooks/useRouter", () => ({
  useRouter: () => ({ view: currentView }),
  routeHref: (r: { view: string }) => (r.view === "admin" ? "?admin=true" : "?"),
  goLanding: () => nav.goLanding(),
  goCatalogs: () => nav.goCatalogs(),
  goTableLineage: () => nav.goTableLineage(),
  goDQ: () => nav.goDQ(),
  goRootCause: () => nav.goRootCause(),
  goControlPanel: () => nav.goControlPanel(),
  goGlossary: () => nav.goGlossary(),
  goNotifications: () => nav.goNotifications(),
  goExport: () => nav.goExport(),
  goBiConsumers: () => nav.goBiConsumers(),
  goStreaming: () => nav.goStreaming(),
}));
vi.mock("../../api/client", () => ({
  api: { getUserInfo: vi.fn().mockResolvedValue({ email: "a@b.com", isAdmin: false }) },
}));

describe("SideNav", () => {
  beforeEach(() => {
    Object.values(nav).forEach((f) => f.mockReset());
    currentView = "dq";
    try { localStorage.clear(); } catch { /* ignore */ }
    useLineageStore.setState({ isAdmin: false, globalSearchOpen: false });
    useFeatureFlagStore.setState({ flags: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders all primary + secondary destinations", () => {
    render(<SideNav />);
    ["Home", "Lineage Explorer", "Impact Analysis", "Data Quality", "Reports",
     "Business Glossary", "Notifications", "OpenLineage Export", "BI Consumers", "Streaming Topology", "Settings"]
      .forEach((label) => expect(screen.getByText(label)).toBeInTheDocument());
    expect(screen.queryByText("Browse")).not.toBeInTheDocument();
  });

  it("navigates when an item is clicked", async () => {
    const user = userEvent.setup();
    render(<SideNav />);
    await user.click(screen.getByText("Data Quality"));
    await user.click(screen.getByText("Reports"));
    await user.click(screen.getByText("Impact Analysis"));
    await user.click(screen.getByText("Settings"));
    expect(nav.goDQ).toHaveBeenCalled();
    expect(nav.goRootCause).toHaveBeenCalled();
    expect(nav.goTableLineage).toHaveBeenCalled();
    expect(nav.goControlPanel).toHaveBeenCalled();
  });

  it("opens global search from the Search item", async () => {
    const user = userEvent.setup();
    render(<SideNav />);
    await user.click(screen.getByText("Search"));
    expect(useLineageStore.getState().globalSearchOpen).toBe(true);
  });

  it("hides Admin Dashboard unless admin, then shows it as a new-tab link", () => {
    const { rerender } = render(<SideNav />);
    expect(screen.queryByText("Admin Dashboard")).not.toBeInTheDocument();
    useLineageStore.setState({ isAdmin: true });
    rerender(<SideNav />);
    const link = screen.getByText("Admin Dashboard").closest("a");
    expect(link).toHaveAttribute("href", "?admin=true");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("shows the signed-in user's email", async () => {
    render(<SideNav />);
    expect(await screen.findByText("a@b.com")).toBeInTheDocument();
  });

  it("collapses and expands via the toggle", async () => {
    const user = userEvent.setup();
    render(<SideNav />);
    expect(screen.getByText("Data Quality")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Collapse sidebar"));
    // Labels are hidden when collapsed; the item title is dropped from the DOM.
    expect(screen.queryByText("Data Quality")).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("Expand sidebar"));
    expect(screen.getByText("Data Quality")).toBeInTheDocument();
  });

  it("respects initialCollapsed", () => {
    render(<SideNav initialCollapsed />);
    expect(screen.queryByText("Data Quality")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Expand sidebar")).toBeInTheDocument();
  });

  it("hides Data Quality and Reports when the metadata-only flags are on", () => {
    useFeatureFlagStore.setState({
      flags: [
        { id: "metadata_only.hide_data_quality", enabled: true },
        { id: "metadata_only.hide_reports", enabled: true },
      ] as any,
    });
    render(<SideNav />);
    expect(screen.queryByText("Data Quality")).not.toBeInTheDocument();
    expect(screen.queryByText("Reports")).not.toBeInTheDocument();
    // other items unaffected
    expect(screen.getByText("Lineage Explorer")).toBeInTheDocument();
  });

  it("exposes the workspace slot as disabled", () => {
    render(<SideNav />);
    const ws = screen.getByTitle("Multi-workspace — coming soon");
    expect(ws).toHaveAttribute("aria-disabled", "true");
  });
});
