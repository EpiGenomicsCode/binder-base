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

/**
 * One design's value against its run's distribution, at tile size.
 *
 * The same histogram the run page charts, drawn small enough to sit under a
 * number in the binder modal. It answers the question a bare metric cannot:
 * 2.1 A of placement RMSD is a near miss in a run that mostly landed at 1.4
 * and the best design in a run that mostly landed at 12.
 *
 * Deliberately no percentile. The bins are wide -- placement spans 0-40 A in
 * twenty of them, so the first bin alone can hold most of a run -- and a
 * number interpolated inside one would claim a precision the payload does not
 * have. Where the tick falls among the bars is exactly as much as these bins
 * can honestly say.
 */

const SPARK_W = 160;
const SPARK_H = 26;
const SPARK_PAD_T = 4;

export function MetricSparkline({
  hist, value, verdict, label, markAt,
}: {
  hist: Histogram | undefined;
  /** In the histogram's own units, which are not always the displayed ones. */
  value: number | null | undefined;
  verdict?: "good" | "bad";
  /** For the aria-label, since the tile's own text is not read with it. */
  label: string;
  /** The threshold, where the metric has one. */
  markAt?: number;
}) {
  // Nothing to compare against, or nothing to place: the tile is complete
  // without this, so render nothing rather than an empty frame.
  if (!hist || !hist.n || value == null) return null;

  const { edges, counts, n } = hist;
  const lo = edges[0];
  const hi = edges[edges.length - 1];
  if (!(hi > lo)) return null;

  const max = Math.max(...counts, 1);
  const plotH = SPARK_H - SPARK_PAD_T;
  const barW = SPARK_W / counts.length;
  const xOf = (v: number) =>
    ((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * SPARK_W;
  const x = xOf(value);
  // The endpoint clamps out-of-range values into the end bins, so the tick is
  // clamped the same way and says so rather than sitting silently on the edge.
  const clamped = value < lo ? "below" : value > hi ? "above" : null;

  return (
    <div className="bd-spark"
         title={`${label}: this design against ${n.toLocaleString()} in the run`}>
      <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} className="bd-spark-svg"
           preserveAspectRatio="none" role="img"
           aria-label={`${label} against ${n.toLocaleString()} designs in this run`}>
        {/* A floor for the tick to stand on. Out in a tail the bars are a
            fraction of a pixel tall, and without this the tick reads as
            floating in a blank box rather than as "almost nothing is here". */}
        <line className="bd-spark-base" vectorEffect="non-scaling-stroke"
              x1={0} y1={SPARK_H - 0.5} x2={SPARK_W} y2={SPARK_H - 0.5} />
        {counts.map((c, i) => {
          const h = (c / max) * plotH;
          return (
            <rect key={i} className="bd-spark-bar"
                  x={i * barW} y={SPARK_H - h}
                  width={Math.max(barW - 0.6, 0.4)} height={h} />
          );
        })}
        {/* The box is stretched to the tile's width, so the strokes opt out of
            scaling: without this a 1px tick is drawn 1.2px wide and fuzzy. */}
        {markAt != null && markAt > lo && markAt < hi && (
          <line className="bd-spark-mark" vectorEffect="non-scaling-stroke"
                x1={xOf(markAt)} y1={0} x2={xOf(markAt)} y2={SPARK_H} />
        )}
        <line className={`bd-spark-tick${verdict ? ` bd-spark-${verdict}` : ""}`}
              vectorEffect="non-scaling-stroke"
              x1={x} y1={0} x2={x} y2={SPARK_H} />
      </svg>
      <span className="bd-spark-foot">
        {clamped
          ? `${clamped} the plotted range · n = ${n.toLocaleString()}`
          : `n = ${n.toLocaleString()} in this run`}
      </span>
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
