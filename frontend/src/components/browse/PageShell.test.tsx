import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PageShell from "./PageShell";
import { useLineageStore } from "../../store/lineageStore";

vi.mock("framer-motion", () => ({
  motion: new Proxy({}, { get: () => (p: any) => <div onClick={p.onClick}>{p.children}</div> }),
  AnimatePresence: ({ children }: any) => children,
}));
// Branding + nav live in the left rail now — stub it out; it has its own test.
vi.mock("../layout/SideNav", () => ({ default: () => <div data-testid="sidenav" /> }));

describe("PageShell", () => {
  beforeEach(() => {
    useLineageStore.setState({ isAdmin: false, globalSearchOpen: false });
  });

  it("renders children and the left rail", () => {
    render(<PageShell><div>content here</div></PageShell>);
    expect(screen.getByText("content here")).toBeInTheDocument();
    expect(screen.getByTestId("sidenav")).toBeInTheDocument();
  });

  it("opens global search on button click", async () => {
    const user = userEvent.setup();
    render(<PageShell><div>x</div></PageShell>);
    await user.click(screen.getByText("Search any table..."));
    expect(useLineageStore.getState().globalSearchOpen).toBe(true);
  });

  it("renders the subtitle as the page title", () => {
    render(<PageShell subtitle="Data quality metrics"><div>x</div></PageShell>);
    expect(screen.getByText("Data quality metrics")).toBeInTheDocument();
  });

  it("renders children in bare mode", () => {
    render(<PageShell bare><div>bare content</div></PageShell>);
    expect(screen.getByText("bare content")).toBeInTheDocument();
  });
});
