import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RuleEditor, RuleSuggestions } from "./RuleEditor";
import { api } from "../../api/client";

afterEach(() => vi.restoreAllMocks());

describe("RuleEditor", () => {
  it("opens the form and saves a NOT_NULL rule (no expression field)", async () => {
    const upsert = vi.spyOn(api, "upsertDQRule").mockResolvedValue({ rule_id: "r1", status: "upserted" });
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(<RuleEditor tableFqn="main.s.t" columns={["email", "id"]} onSaved={onSaved} />);

    await user.click(screen.getByText("+ Add rule"));
    // NOT_NULL is the default → no expression field
    expect(screen.queryByPlaceholderText(/boolean SQL/i)).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("column"), "email");
    await user.click(screen.getByText("Save rule"));

    await waitFor(() => expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ table_fqn: "main.s.t", column_name: "email", rule_type: "NOT_NULL", expression: "" }),
    ));
    expect(onSaved).toHaveBeenCalled();
  });

  it("shows an expression field for CUSTOM and requires it", async () => {
    const user = userEvent.setup();
    render(<RuleEditor tableFqn="main.s.t" columns={[]} onSaved={() => {}} />);
    await user.click(screen.getByText("+ Add rule"));
    await user.selectOptions(screen.getByDisplayValue("NOT_NULL"), "CUSTOM");
    expect(screen.getByPlaceholderText(/boolean SQL/i)).toBeInTheDocument();
    // Save disabled until an expression is entered (column optional for CUSTOM)
    expect(screen.getByText("Save rule")).toBeDisabled();
  });

  it("surfaces a save error", async () => {
    vi.spyOn(api, "upsertDQRule").mockRejectedValue(new Error("API error 403: Admin required"));
    const user = userEvent.setup();
    render(<RuleEditor tableFqn="main.s.t" columns={["id"]} onSaved={() => {}} />);
    await user.click(screen.getByText("+ Add rule"));
    await user.type(screen.getByPlaceholderText("column"), "id");
    await user.click(screen.getByText("Save rule"));
    expect(await screen.findByText("Admin required")).toBeInTheDocument();
  });
});

describe("RuleSuggestions", () => {
  const liveCols = [
    { name: "id", total_rows: 100, distinct_count: 100, null_count: 0, null_pct: 0 },
    { name: "email", total_rows: 100, distinct_count: 90, null_count: 0, null_pct: 0 },
    { name: "note", total_rows: 100, distinct_count: 50, null_count: 20, null_pct: 20 },
  ];

  it("suggests UNIQUE + NOT_NULL for id, NOT_NULL for email, nothing for note", () => {
    render(<RuleSuggestions tableFqn="main.s.t" columns={liveCols} existingRules={[]} onSaved={() => {}} />);
    // id → NOT_NULL + UNIQUE (two rows), email → NOT_NULL (one), note → none
    expect(screen.getAllByText("on id").length).toBe(2);
    expect(screen.getByText("on email")).toBeInTheDocument();
    expect(screen.queryByText("on note")).not.toBeInTheDocument();
    expect(screen.getAllByText("UNIQUE").length).toBe(1);
  });

  it("hides suggestions already covered by existing rules", () => {
    render(
      <RuleSuggestions
        tableFqn="main.s.t"
        columns={liveCols}
        existingRules={[{ column_name: "id", rule_type: "NOT_NULL" }, { column_name: "id", rule_type: "UNIQUE" }]}
        onSaved={() => {}}
      />,
    );
    expect(screen.queryByText("on id")).not.toBeInTheDocument();
    expect(screen.getByText("on email")).toBeInTheDocument();
  });

  it("prompts to run a live profile (with a CTA) when there is no live data", async () => {
    const onRun = vi.fn();
    const user = userEvent.setup();
    render(
      <RuleSuggestions
        tableFqn="main.s.t"
        columns={[{ name: "x", distinct_count: 5, null_pct: 0 }]}
        existingRules={[]}
        onSaved={() => {}}
        onRunLiveProfile={onRun}
      />,
    );
    expect(screen.getByText(/Suggestions come from a live column profile/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Profile columns to get suggestions/i }));
    expect(onRun).toHaveBeenCalled();
  });

  it("adds selected suggestions", async () => {
    const upsert = vi.spyOn(api, "upsertDQRule").mockResolvedValue({ rule_id: "r", status: "upserted" });
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(<RuleSuggestions tableFqn="main.s.t" columns={liveCols} existingRules={[]} onSaved={onSaved} />);
    const boxes = screen.getAllByRole("checkbox");
    await user.click(boxes[0]);
    await user.click(screen.getByRole("button", { name: /Add 1 selected/i }));
    await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
    expect(onSaved).toHaveBeenCalled();
  });
});
