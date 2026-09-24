import { describe, it, expect } from "vitest";
import { buildFindings } from "./dqFindings";

describe("buildFindings", () => {
  it("flags null columns worst-first and ignores clean ones", () => {
    const out = buildFindings([
      { name: "id", total_rows: 100, distinct_count: 100, null_pct: 0 },
      { name: "amount", total_rows: 100, distinct_count: 50, null_pct: 5 },
      { name: "note", total_rows: 100, distinct_count: 30, null_pct: 20 },
    ]);
    expect(out.map((f) => f.column)).toEqual(["note", "amount"]); // worst-first, id excluded
    expect(out[0].detail).toMatch(/20/);
  });

  it("flags a constant column and sorts it above nulls", () => {
    const out = buildFindings([
      { name: "amount", total_rows: 100, distinct_count: 50, null_pct: 5 },
      { name: "region", total_rows: 100, distinct_count: 1, null_pct: 0 },
    ]);
    expect(out[0].column).toBe("region");
    expect(out[0].kind).toBe("constant");
  });

  it("ignores columns without live stats", () => {
    expect(buildFindings([{ name: "x", distinct_count: 5, null_pct: 3 }])).toEqual([]);
  });

  it("formats sub-1% null with more precision", () => {
    const out = buildFindings([{ name: "c", total_rows: 1000, distinct_count: 10, null_pct: 0.25 }]);
    expect(out[0].detail).toBe("0.25% null");
  });
});
