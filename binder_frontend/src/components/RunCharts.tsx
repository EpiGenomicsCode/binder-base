import type { EnrichmentPoint, Histogram } from "../types";

/**
 * Plain SVG rather than a charting library. These are a bar chart and a step
 * line; pulling in recharts or chart.js to draw them would add a dependency and
 * bundle weight for no capability the page needs, and the bundle already
 * carries Mol*.
 */

const W = 260;
const H = 110;
const PAD_L = 28;
const PAD_B = 18;
const PAD_T = 8;
const PAD_R = 6;

function fmtEdge(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(v < 1 ? 2 : 1);
}

export function HistogramChart({
  title,
  hist,
  unit,
  markAt,
  markLabel,
}: {
  title: string;
  hist: Histogram;
  unit?: string;
  /** Draw a threshold line at this value, e.g. the 2 A designability cut-off. */
  markAt?: number;
  markLabel?: string;
}) {
  const { edges, counts, n, overflow } = hist;
  if (!n) {
    return (
      <div className="chart-card">
        <div className="chart-title">{title}</div>
        <p className="chart-empty">No values recorded.</p>
      </div>
    );
  }

  const lo = edges[0];
  const hi = edges[edges.length - 1];
  const max = Math.max(...counts, 1);
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const barW = plotW / counts.length;
  const xOf = (v: number) => PAD_L + ((v - lo) / (hi - lo)) * plotW;

  return (
    <div className="chart-card">
      <div className="chart-title">
        {title}
        {unit ? <span className="chart-unit"> ({unit})</span> : null}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img"
           aria-label={`${title} distribution over ${n} designs`}>
        {/* y axis: only 0 and the max count, since the shape is the point */}
        <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={H - PAD_B} className="chart-axis" />
        <line x1={PAD_L} y1={H - PAD_B} x2={W - PAD_R} y2={H - PAD_B} className="chart-axis" />
        <text x={PAD_L - 4} y={PAD_T + 6} className="chart-tick chart-tick-y">{max}</text>
        <text x={PAD_L - 4} y={H - PAD_B} className="chart-tick chart-tick-y">0</text>

        {counts.map((c, i) => {
          const h = (c / max) * plotH;
          return (
            <rect
              key={i}
              x={PAD_L + i * barW}
              y={H - PAD_B - h}
              width={Math.max(barW - 0.75, 0.5)}
              height={h}
              className="chart-bar"
            >
              <title>{`${fmtEdge(edges[i])}–${fmtEdge(edges[i + 1])}: ${c}`}</title>
            </rect>
          );
        })}

        {markAt != null && markAt > lo && markAt < hi && (
          <>
            <line x1={xOf(markAt)} y1={PAD_T} x2={xOf(markAt)} y2={H - PAD_B}
                  className="chart-mark" />
            <text x={xOf(markAt) + 3} y={PAD_T + 7} className="chart-mark-label">
              {markLabel ?? fmtEdge(markAt)}
            </text>
          </>
        )}

        <text x={PAD_L} y={H - 5} className="chart-tick">{fmtEdge(lo)}</text>
        <text x={W - PAD_R} y={H - 5} className="chart-tick chart-tick-end">{fmtEdge(hi)}</text>
      </svg>
      <div className="chart-foot">
        n = {n.toLocaleString()}
        {/* The endpoint clamps out-of-range values into the last bin rather than
            dropping them, so say so instead of letting the tail read as real. */}
        {overflow > 0 && (
          <span className="chart-overflow"> · {overflow.toLocaleString()} above {fmtEdge(hi)}, shown in the last bin</span>
        )}
      </div>
    </div>
  );
}

export function EnrichmentChart({
  curve,
  baseRate,
}: {
  curve: EnrichmentPoint[];
  baseRate: number;
}) {
  if (!curve.length) {
    return (
      <div className="chart-card">
        <div className="chart-title">Enrichment</div>
        <p className="chart-empty">Not enough designs to compute a curve.</p>
      </div>
    );
  }

  const maxRate = Math.max(baseRate, ...curve.map((p) => p.hit_rate), 0.01);
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const xOf = (i: number) =>
    PAD_L + (curve.length === 1 ? plotW / 2 : (i / (curve.length - 1)) * plotW);
  const yOf = (r: number) => H - PAD_B - (r / maxRate) * plotH;
  const pts = curve.map((p, i) => `${xOf(i)},${yOf(p.hit_rate)}`).join(" ");

  return (
    <div className="chart-card">
      <div className="chart-title">
        Enrichment<span className="chart-unit"> (hit rate within top k)</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img"
           aria-label="Hit rate within the top k designs against the run base rate">
        <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={H - PAD_B} className="chart-axis" />
        <line x1={PAD_L} y1={H - PAD_B} x2={W - PAD_R} y2={H - PAD_B} className="chart-axis" />
        <text x={PAD_L - 4} y={PAD_T + 6} className="chart-tick chart-tick-y">
          {(maxRate * 100).toFixed(0)}%
        </text>
        <text x={PAD_L - 4} y={H - PAD_B} className="chart-tick chart-tick-y">0</text>

        {/* The run's own base rate. Without it the curve has no meaning:
            enrichment is the ratio of the line to this. */}
        <line x1={PAD_L} y1={yOf(baseRate)} x2={W - PAD_R} y2={yOf(baseRate)}
              className="chart-baseline" />
        <text x={W - PAD_R} y={yOf(baseRate) - 3} className="chart-tick chart-tick-end">
          base {(baseRate * 100).toFixed(1)}%
        </text>

        <polyline points={pts} className="chart-line" />
        {curve.map((p, i) => (
          <g key={p.k}>
            <circle cx={xOf(i)} cy={yOf(p.hit_rate)} r={2.5} className="chart-dot">
              <title>
                {`top ${p.k}: ${(p.hit_rate * 100).toFixed(1)}%${p.fold != null ? ` (${p.fold}x base)` : ""}`}
              </title>
            </circle>
            <text x={xOf(i)} y={H - 5} className="chart-tick chart-tick-mid">{p.k}</text>
          </g>
        ))}
      </svg>
      <div className="chart-foot">
        {curve[0].fold != null
          ? `${curve[0].fold}x base rate at k = ${curve[0].k}`
          : "base rate is 0, so fold enrichment is undefined"}
      </div>
    </div>
  );
}
