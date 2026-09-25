import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HeaderActions from "./HeaderActions";
import { useThemeStore } from "../../store/themeStore";

const goNotifications = vi.fn();
vi.mock("../../hooks/useRouter", () => ({ goNotifications: () => goNotifications() }));

describe("HeaderActions", () => {
  beforeEach(() => {
    goNotifications.mockReset();
    useThemeStore.setState({ theme: "dark" });
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ count: 0 }) }) as any;
  });
  afterEach(() => vi.restoreAllMocks());

  it("navigates to notifications when the bell is clicked", async () => {
    const user = userEvent.setup();
    render(<HeaderActions />);
    await user.click(screen.getByLabelText("Notifications"));
    expect(goNotifications).toHaveBeenCalled();
  });

  it("toggles the theme", async () => {
    const user = userEvent.setup();
    render(<HeaderActions />);
    await user.click(screen.getByLabelText("Toggle theme"));
    expect(useThemeStore.getState().theme).toBe("light");
  });

  it("shows an unread badge when there are unread notifications", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ count: 5 }) }) as any;
    render(<HeaderActions />);
    expect(await screen.findByText("5")).toBeInTheDocument();
  });

  it("caps the unread badge at 9+", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ count: 42 }) }) as any;
    render(<HeaderActions />);
    expect(await screen.findByText("9+")).toBeInTheDocument();
  });

  it("shows no badge when there are no unread notifications", async () => {
    render(<HeaderActions />);
    await waitFor(() => expect(screen.getByLabelText("Notifications")).toBeInTheDocument());
    expect(screen.queryByText("9+")).not.toBeInTheDocument();
  });
});
