import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HelpSupport from "./HelpSupport";

describe("HelpSupport", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders nothing when closed", () => {
    const { container } = render(<HelpSupport open={false} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Help & Support")).not.toBeInTheDocument();
  });

  it("shows the panel and the first topic expanded when open", () => {
    render(<HelpSupport open onClose={() => {}} />);
    expect(screen.getByText("Help & Support")).toBeInTheDocument();
    // first topic (Getting started) is expanded by default
    expect(screen.getByText(/turns Unity Catalog/i)).toBeInTheDocument();
  });

  it("expands a topic on click and collapses it again", async () => {
    const user = userEvent.setup();
    render(<HelpSupport open onClose={() => {}} />);
    // Streaming Topology body is hidden until its header is clicked
    expect(screen.queryByText(/source→stream DAG/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Streaming Topology/i }));
    expect(await screen.findByText(/source→stream DAG/i)).toBeInTheDocument();
  });

  it("filters topics by search and auto-expands matches", async () => {
    const user = userEvent.setup();
    render(<HelpSupport open onClose={() => {}} />);
    await user.type(screen.getByPlaceholderText(/Search help/i), "admin");
    // matching topics remain; a clearly-unrelated one drops out
    await waitFor(() => expect(screen.queryByRole("button", { name: /Data Quality/i })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Settings & Admin/i })).toBeInTheDocument();
    // match bodies are shown without a click (searching auto-expands)
    expect(screen.getByText(/admin-gated toggle center/i)).toBeInTheDocument();
  });

  it("shows an empty state when nothing matches", async () => {
    const user = userEvent.setup();
    render(<HelpSupport open onClose={() => {}} />);
    await user.type(screen.getByPlaceholderText(/Search help/i), "zzzznope");
    expect(await screen.findByText(/No help topics match/i)).toBeInTheDocument();
  });

  it("closes on the X button, overlay click, and Escape", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<HelpSupport open onClose={onClose} />);
    await user.click(screen.getByLabelText("Close help"));
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<HelpSupport open onClose={onClose} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
