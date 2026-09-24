/**
 * Lightweight, dependency-free SVG charts for the Data Quality screen.
 * All are theme-matched (dark surface, orange accent) and responsive via viewBox.
 */

export function scoreColor(v: number | null): string {
  if (v == null) return "#64748b"; // slate-500
  if (v >= 0.99) return "#34d399"; // emerald-400
  if (v >= 0.9) return "#fbbf24"; // amber-400
  if (v >= 0.75) return "#fb923c"; // orange-400
  return "#f87171"; // red-400
}

export function gradeColor(grade: string | null): string {
  switch (grade) {
    case "A": return "#34d399";
    case "B": return "#38bdf8";
    case "C": return "#fbbf24";
    case "D": return "#fb923c";
    case "F": return "#f87171";
    default: return "#64748b";
  }
}

/** Circular progress ring with the score in the middle. */
export function RingGauge({
  value,
  size = 132,
  stroke = 11,
}: {
  value: number | null;
  size?: number;
  stroke?: number;
}) {
  const r = size / 2 - stroke;
  const circ = 2 * Math.PI * r;
  const v = value ?? 0;
  const color = scoreColor(value);
  const offset = circ * (1 - v);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Quality score">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={stroke} />
      {value != null && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dashoffset 0.6s ease" }}
        />
      )}
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fill="#f1f5f9" fontSize={size * 0.26} fontWeight={700}>
        {value != null ? `${Math.round(v * 100)}%` : "—"}
      </text>
    </svg>
  );
}

/** Score-over-time line chart. `points` are ordered oldest→newest, y in 0..1. */
export function TrendLine({
  points,
  width = 640,
  height = 150,
}: {
  points: { y: number | null; label?: string }[];
  width?: number;
  height?: number;
}) {
  const valid = points.filter((p) => p.y != null) as { y: number; label?: string }[];
  if (valid.length < 2) {
    return (
      <div className="h-[150px] flex items-center justify-center text-[12px] text-slate-500">
        Not enough history yet — run checks a few times to build a trend.
      </div>
    );
  }
  const pad = { l: 32, r: 12, t: 12, b: 20 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const n = valid.length;
  const x = (i: number) => pad.l + (n === 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (val: number) => pad.t + (1 - val) * h;
  const line = valid.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.y)}`).join(" ");
  const area = `${line} L${x(n - 1)},${pad.t + h} L${x(0)},${pad.t + h} Z`;
  const last = valid[n - 1];
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Quality trend">
      {[0, 0.5, 1].map((g) => (
        <g key={g}>
          <line x1={pad.l} x2={width - pad.r} y1={y(g)} y2={y(g)} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
          <text x={pad.l - 6} y={y(g)} textAnchor="end" dominantBaseline="central" fill="#64748b" fontSize={10}>
            {Math.round(g * 100)}
          </text>
        </g>
      ))}
      <path d={area} fill="url(#dqTrendFill)" opacity={0.5} />
      <path d={line} fill="none" stroke="#FF4520" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(n - 1)} cy={y(last.y)} r={3.5} fill="#FF4520" />
      <defs>
        <linearGradient id="dqTrendFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FF4520" stopOpacity={0.35} />
          <stop offset="100%" stopColor="#FF4520" stopOpacity={0} />
        </linearGradient>
      </defs>
    </svg>
  );
}

/** Tiny inline sparkline for portfolio cards. */
export function Sparkline({ values, width = 96, height = 26 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return <div style={{ width, height }} className="text-[10px] text-slate-600 flex items-center">—</div>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * (width - 2) + 1;
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4);
  const d = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`).join(" ");
  const up = values[values.length - 1] >= values[0];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <path d={d} fill="none" stroke={up ? "#34d399" : "#f87171"} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

/** Donut of rule coverage by DQ dimension. */
export function DimensionDonut({
  segments,
  size = 132,
  stroke = 18,
}: {
  segments: { label: string; value: number; color: string }[];
  size?: number;
  stroke?: number;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const r = size / 2 - stroke / 2;
  const circ = 2 * Math.PI * r;
  let acc = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Rules by dimension">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={stroke} />
      {total > 0 &&
        segments.map((s, i) => {
          const frac = s.value / total;
          const dash = frac * circ;
          const seg = (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={stroke}
              strokeDasharray={`${dash} ${circ - dash}`}
              strokeDashoffset={-acc * circ}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          );
          acc += frac;
          return seg;
        })}
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fill="#f1f5f9" fontSize={size * 0.2} fontWeight={700}>
        {total}
      </text>
    </svg>
  );
}
