import { memo, useMemo } from "react";
import ReactFlow, {
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
} from "reactflow";
import "reactflow/dist/style.css";
import { Radio, Zap, Database, Waves, DownloadCloud, Activity } from "lucide-react";
import type { StreamNode, StreamEdge, StreamPipelineMetrics, StreamSourceKind } from "../../api/client";

// Freshness → node accent. Sources are neutral; streams carry their SLA color.
const FRESH_COLOR: Record<string, string> = {
  fresh: "#34d399",
  lagging: "#fbbf24",
  stale: "#f87171",
  unknown: "#94a3b8",
};

const SOURCE_ICON: Record<StreamSourceKind, typeof Radio> = {
  kafka: Waves,
  kinesis: Waves,
  eventhub: Waves,
  autoloader: DownloadCloud,
  delta: Database,
  stream: Radio,
};

interface StreamNodeData {
  label: string;
  fqn: string;
  role: "source" | "stream";
  sourceKind?: StreamSourceKind;
  freshness?: string;
  metrics?: StreamPipelineMetrics;
  onSelect?: (fqn: string) => void;
}

const GraphNode = memo(({ data }: NodeProps<StreamNodeData>) => {
  const isStream = data.role === "stream";
  const color = isStream ? FRESH_COLOR[data.freshness || "unknown"] : "#64748b";
  const Icon = isStream ? Zap : SOURCE_ICON[data.sourceKind || "stream"];
  const tput = data.metrics?.throughput_rows;
  const backlog = data.metrics?.backlog_records;
  return (
    <div
      onClick={() => isStream && data.onSelect?.(data.fqn)}
      title={data.fqn}
      className={`rounded-xl border px-3 py-2 shadow-lg backdrop-blur-sm ${isStream ? "cursor-pointer hover:brightness-125" : ""}`}
      style={{
        background: "rgba(15,23,42,0.9)",
        borderColor: `${color}66`,
        minWidth: 190,
        maxWidth: 230,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div className="flex items-center gap-2">
        <Icon size={14} style={{ color }} className="shrink-0" />
        <span className="text-[11px] font-mono text-slate-200 truncate">{data.label}</span>
      </div>
      {isStream && (
        <div className="mt-1.5 flex items-center gap-2 flex-wrap">
          <span
            className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full"
            style={{ background: `${color}22`, color, border: `1px solid ${color}44` }}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
            {data.freshness || "unknown"}
          </span>
          {data.sourceKind && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-white/[0.06] text-slate-400 border border-white/10">
              {data.sourceKind}
            </span>
          )}
          {typeof tput === "number" && (
            <span className="inline-flex items-center gap-1 text-[9px] text-emerald-300">
              <Activity size={9} /> {tput.toLocaleString()} rows
            </span>
          )}
          {typeof backlog === "number" && backlog > 0 && (
            <span className="text-[9px] text-amber-300">backlog {backlog.toLocaleString()}</span>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
});
GraphNode.displayName = "StreamGraphNode";

const nodeTypes = { stream: GraphNode };

interface Props {
  nodes: StreamNode[];
  edges: StreamEdge[];
  metrics: Record<string, StreamPipelineMetrics>;
  onSelect?: (fqn: string) => void;
}

/** Layered source → streaming-table DAG. Self-contained reactflow instance (not
 *  tied to the lineage store), laid out in two columns with simple vertical
 *  stacking so it renders without an external layout engine. */
export function StreamTopologyGraph({ nodes, edges, metrics, onSelect }: Props) {
  const { rfNodes, rfEdges } = useMemo(() => {
    const streamFqns = new Set(nodes.map((n) => `${n.table_catalog}.${n.table_schema}.${n.table_name}`));
    const sourceFqns = Array.from(
      new Set(edges.map((e) => e.source).filter((s) => s && !streamFqns.has(s))),
    );

    const COL_SRC = 0;
    const COL_STREAM = 380;
    const ROW = 96;

    const srcNodes: Node<StreamNodeData>[] = sourceFqns.map((fqn, i) => ({
      id: `src:${fqn}`,
      type: "stream",
      position: { x: COL_SRC, y: i * ROW },
      data: { label: fqn.split(".").pop() || fqn, fqn, role: "source" },
    }));

    const streamNodes: Node<StreamNodeData>[] = nodes.map((n, i) => {
      const fqn = `${n.table_catalog}.${n.table_schema}.${n.table_name}`;
      return {
        id: `stream:${fqn}`,
        type: "stream",
        position: { x: COL_STREAM, y: i * ROW },
        data: {
          label: n.table_name,
          fqn,
          role: "stream",
          sourceKind: n.source_kind,
          freshness: n.freshness,
          metrics: n.pipeline_id ? metrics[n.pipeline_id] : undefined,
          onSelect,
        },
      };
    });

    const rfEdges: Edge[] = edges
      .filter((e) => e.source && e.target)
      .map((e, i) => ({
        id: `e${i}`,
        source: streamFqns.has(e.source) ? `stream:${e.source}` : `src:${e.source}`,
        target: `stream:${e.target}`,
        animated: true,
        style: { stroke: "#34d39955" },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#34d399" },
      }));

    return { rfNodes: [...srcNodes, ...streamNodes], rfEdges };
  }, [nodes, edges, metrics, onSelect]);

  return (
    <div className="h-[560px] rounded-xl border border-white/[0.06] bg-black/20 overflow-hidden">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
        maxZoom={1.5}
      >
        <Background color="#1e293b" gap={20} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
