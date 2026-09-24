import { describe, it, expect } from "vitest";
import { assignWorkspaceColors, WORKSPACE_PALETTE } from "./workspaceColors";

const ent = (workspace_id: string | null) => ({ node_type: "entity", workspace_id });
const tbl = () => ({ node_type: "table" });

describe("assignWorkspaceColors", () => {
  it("returns empty for a single workspace (no indicator)", () => {
    expect(assignWorkspaceColors([ent("111"), ent("111"), tbl()]).size).toBe(0);
  });

  it("returns empty when no entity has a workspace_id", () => {
    expect(assignWorkspaceColors([ent(null), tbl()]).size).toBe(0);
  });

  it("assigns a distinct colour per workspace when >1", () => {
    const m = assignWorkspaceColors([ent("111"), ent("222"), ent("111")]);
    expect(m.size).toBe(2);
    expect(m.get("111")).not.toBe(m.get("222"));
    expect(WORKSPACE_PALETTE).toContain(m.get("111"));
  });

  it("is stable across renders (sorted by workspace_id)", () => {
    const a = assignWorkspaceColors([ent("999"), ent("111")]);
    const b = assignWorkspaceColors([ent("111"), ent("999")]);
    expect(a.get("111")).toBe(b.get("111"));
    expect(a.get("999")).toBe(b.get("999"));
  });

  it("ignores table nodes' absence of workspace_id", () => {
    const m = assignWorkspaceColors([ent("111"), ent("222"), tbl(), tbl()]);
    expect(m.size).toBe(2);
  });
});
