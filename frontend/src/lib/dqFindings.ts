import { DQProfileColumn } from "../api/client";

export interface DQFinding {
  column: string;
  kind: "null" | "constant";
  detail: string;
  /** Higher = worse; used to sort findings worst-first. */
  weight: number;
}

/** Derive data-quality findings from a LIVE column profile (needs null_pct / distinct).
 *  Columns without live stats are ignored. Worst-first. */
export function buildFindings(columns: DQProfileColumn[]): DQFinding[] {
  const out: DQFinding[] = [];
  for (const c of columns) {
    if (c.total_rows == null) continue; // no live profile for this column
    if (c.null_pct != null && c.null_pct > 0) {
      out.push({
        column: c.name,
        kind: "null",
        detail: `${c.null_pct.toFixed(c.null_pct < 1 ? 2 : 1)}% null`,
        weight: c.null_pct,
      });
    }
    if (c.distinct_count === 1 && (c.total_rows ?? 0) > 1) {
      out.push({
        column: c.name,
        kind: "constant",
        detail: "single value (constant column)",
        weight: 200, // constants are almost always worth a look → sort to the top
      });
    }
  }
  return out.sort((a, b) => b.weight - a.weight);
}
