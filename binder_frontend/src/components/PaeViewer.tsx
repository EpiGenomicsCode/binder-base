import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

interface Props {
  paeJsonPath: string;
  /**
   * Residue (1-based) hovered elsewhere on the page. Drawn as a crosshair over
   * its row and column, which is that residue's whole PAE profile.
   */
  highlightResidue?: number | null;
  /** Reports the scored residue under the cursor (1-based), or null on leave. */
  onHoverResidue?: (resno: number | null) => void;
  /**
   * Inclusive 1-based residue ranges to shade on both axes, e.g. the epitope a
   * run was designed against. The bands make it readable at a glance whether
   * that region is confidently positioned relative to the rest of the chain.
   *
   * A list rather than one range because a binding patch is a set of segments
   * -- shading lo..hi across the gaps would claim residues the design never
   * targeted.
   */
  highlightRanges?: [number, number][];
}

// Color scale matching AlphaFold: dark green (0 Å) → white (max Å)
function paeColor(value: number, max: number): [number, number, number] {
  const t = Math.min(value / max, 1);
  return [
    Math.round(0   + t * 255),
    Math.round(128 + t * (255 - 128)),
    Math.round(80  + t * (255 - 80)),
  ];
}

// Roughly five intervals, snapped to a 1/2/2.5/5 x 10^k step so the labels read
// as round residue numbers rather than n/5.
function axisTicks(n: number): number[] {
  if (n < 20) return [];
  const raw = n / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const out: number[] = [];
  // Stop short of the far edge so the last label does not collide with it.
  for (let r = step; r <= n - step * 0.4; r += step) out.push(Math.round(r));
  return out;
}

interface Hover {
  x: number; // scored residue, 0-based
  y: number; // aligned residue, 0-based
  value: number;
}

export default function PaeViewer({
  paeJsonPath,
  highlightResidue = null,
  onHoverResidue,
  highlightRanges = [],
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Retained so the readout can look up a value without re-fetching. Flat
  // Float32Array rather than the parsed number[][]: for the largest target in
  // the pilot (2492 residues) that is ~25 MB instead of ~50 MB, and it lets the
  // JSON's nested arrays be collected.
  const paeRef = useRef<Float32Array | null>(null);
  const [n, setN] = useState(0);
  const [maxPae, setMaxPae] = useState<number>(31.75);
  const [hover, setHover] = useState<Hover | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  // Keep the callback current without making it a dependency of the fetch.
  const onHoverRef = useRef(onHoverResidue);
  onHoverRef.current = onHoverResidue;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setHover(null);

    fetch(`/media/${paeJsonPath}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const entry = Array.isArray(data) ? data[0] : data;
        const matrix: number[][] = entry.predicted_aligned_error ?? entry.pae;
        const max: number =
          entry.max_predicted_aligned_error ?? entry.max_pae ?? 31.75;
        const size = matrix.length;

        const canvas = canvasRef.current;
        if (!canvas) {
          // Nothing to paint onto; surface it rather than hanging on "Loading…".
          setError(true);
          setLoading(false);
          return;
        }
        canvas.width = size;
        canvas.height = size;

        const ctx = canvas.getContext("2d")!;
        const img = ctx.createImageData(size, size);
        const flat = new Float32Array(size * size);
        for (let y = 0; y < size; y++) {
          const row = matrix[y];
          for (let x = 0; x < size; x++) {
            const v = row[x];
            flat[y * size + x] = v;
            const [r, g, b] = paeColor(v, max);
            const i = (y * size + x) * 4;
            img.data[i] = r;
            img.data[i + 1] = g;
            img.data[i + 2] = b;
            img.data[i + 3] = 255;
          }
        }
        ctx.putImageData(img, 0, 0);

        paeRef.current = flat;
        setN(size);
        setMaxPae(max);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [paeJsonPath]);

  const ticks = useMemo(() => axisTicks(n), [n]);

  // The square wrapper is exactly the drawn image -- the canvas fills it and
  // both are square -- so client coordinates map onto matrix indices directly.
  // (The previous object-fit: contain layout letterboxed the canvas inside a
  // wider box, which would make this mapping wrong away from the centre.)
  function handleMove(e: MouseEvent<HTMLDivElement>) {
    const pae = paeRef.current;
    if (!n || !pae) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * n);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * n);
    if (x < 0 || y < 0 || x >= n || y >= n) return;
    setHover({ x, y, value: pae[y * n + x] });
    onHoverRef.current?.(x + 1);
  }

  function handleLeave() {
    setHover(null);
    onHoverRef.current?.(null);
  }

  // While the cursor is on the plot the crosshair follows it. Otherwise it
  // follows whatever the sequence block or the 3D viewer is highlighting.
  const external =
    highlightResidue != null && highlightResidue >= 1 && highlightResidue <= n
      ? highlightResidue - 1
      : null;
  const col = hover ? hover.x : external;
  const row = hover ? hover.y : external;
  const pct = (i: number) => `${((i + 0.5) / n) * 100}%`;

  // Band edges span whole residues, so they use the residue's leading edge
  // rather than its centre.
  const bands = !n
    ? []
    : highlightRanges
        .map(([a, b]) => {
          const lo = Math.max(1, Math.min(a, b));
          const hi = Math.min(n, Math.max(a, b));
          if (hi < lo) return null;
          return {
            key: `${lo}-${hi}`,
            start: `${((lo - 1) / n) * 100}%`,
            size: `${((hi - lo + 1) / n) * 100}%`,
          };
        })
        .filter((b): b is { key: string; start: string; size: string } => b !== null);

  return (
    <div className="pae-wrap">
      <div className="cif-viewer-label">Predicted Aligned Error</div>
      <div className="pae-body">
        <span className="pae-axis-y">Aligned residue</span>
        <div className="pae-plot">
          {loading && <p className="pae-status">Loading…</p>}
          {error && <p className="pae-status">Failed to load PAE data.</p>}
          <div
            className="pae-square"
            style={{ display: loading || error ? "none" : "block" }}
            onMouseMove={handleMove}
            onMouseLeave={handleLeave}
          >
            <canvas ref={canvasRef} className="pae-canvas" />
            {bands.map((band) => (
              <span key={`v${band.key}`} className="pae-band pae-band-v"
                    style={{ left: band.start, width: band.size }} />
            ))}
            {bands.map((band) => (
              <span key={`h${band.key}`} className="pae-band pae-band-h"
                    style={{ top: band.start, height: band.size }} />
            ))}
            {col != null && (
              <span className="pae-crosshair pae-crosshair-v" style={{ left: pct(col) }} />
            )}
            {row != null && (
              <span className="pae-crosshair pae-crosshair-h" style={{ top: pct(row) }} />
            )}
            {ticks.map((r) => (
              <span key={`x${r}`} className="pae-tick pae-tick-x" style={{ left: pct(r - 1) }}>
                {r}
              </span>
            ))}
            {ticks.map((r) => (
              <span key={`y${r}`} className="pae-tick pae-tick-y" style={{ top: pct(r - 1) }}>
                {r}
              </span>
            ))}
            {hover && (
              <div
                className="pae-tooltip"
                style={{
                  left: pct(hover.x),
                  top: pct(hover.y),
                  transform: `translate(${
                    (hover.x + 0.5) / n > 0.6 ? "calc(-100% - 12px)" : "12px"
                  }, ${(hover.y + 0.5) / n > 0.6 ? "calc(-100% - 12px)" : "12px"})`,
                }}
              >
                <strong>{hover.value.toFixed(2)} Å</strong>
                <span>
                  scored {hover.x + 1} · aligned {hover.y + 1}
                </span>
              </div>
            )}
          </div>
        </div>
        <div className="pae-legend">
          <span className="pae-legend-val">0 Å</span>
          <div className="pae-legend-bar" />
          <span className="pae-legend-val">{maxPae.toFixed(1)} Å</span>
        </div>
      </div>
      <span className="pae-axis-x">Scored residue</span>
    </div>
  );
}
