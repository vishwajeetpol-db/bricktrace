// Workspace grouping colors for the lineage graph.
//
// Lineage is metastore-wide, so a graph can contain producer (entity) nodes that
// ran in DIFFERENT workspaces. Entity nodes carry `workspace_id`; when more than
// one distinct workspace is present we colour-code them so it's obvious the graph
// spans workspaces. Tables are metastore-wide (no workspace), so only entity nodes
// participate.

// Categorical hues that read on the dark surface; cycles if a graph spans more
// workspaces than colours (rare).
export const WORKSPACE_PALETTE = [
  "#38bdf8", // sky
  "#f59e0b", // amber
  "#a78bfa", // violet
  "#fb7185", // rose
  "#34d399", // emerald
  "#f472b6", // pink
  "#facc15", // yellow
  "#22d3ee", // cyan
];

type MaybeEntity = { node_type?: string; workspace_id?: string | null };

/**
 * Map each distinct entity `workspace_id` to a stable colour.
 * Returns an EMPTY map when the graph spans 0 or 1 workspace — the caller shows
 * no indicator in that (common) case, avoiding clutter. Ordering is by sorted
 * workspace_id so a given graph colours consistently across renders.
 */
export function assignWorkspaceColors(nodes: MaybeEntity[]): Map<string, string> {
  const ids = new Set<string>();
  for (const n of nodes || []) {
    if (n?.node_type === "entity" && n.workspace_id) ids.add(String(n.workspace_id));
  }
  const out = new Map<string, string>();
  if (ids.size <= 1) return out; // single (or no) workspace → no indicator
  [...ids].sort().forEach((id, i) => out.set(id, WORKSPACE_PALETTE[i % WORKSPACE_PALETTE.length]));
  return out;
}
