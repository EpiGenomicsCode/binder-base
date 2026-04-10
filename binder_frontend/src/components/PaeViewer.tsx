import { useEffect, useRef, useState } from "react";

interface Props {
  paeJsonPath: string;
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

export default function PaeViewer({ paeJsonPath }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [maxPae, setMaxPae] = useState<number>(31.75);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError(false);

    fetch(`/media/${paeJsonPath}`)
      .then((r) => r.json())
      .then((data) => {
        const entry = Array.isArray(data) ? data[0] : data;
        const matrix: number[][] =
          entry.predicted_aligned_error ?? entry.pae;
        const max: number =
          entry.max_predicted_aligned_error ?? entry.max_pae ?? 31.75;
        setMaxPae(max);

        const canvas = canvasRef.current;
        if (!canvas) return;
        const n = matrix.length;
        canvas.width = n;
        canvas.height = n;

        const ctx = canvas.getContext("2d")!;
        const img = ctx.createImageData(n, n);
        for (let y = 0; y < n; y++) {
          for (let x = 0; x < n; x++) {
            const [r, g, b] = paeColor(matrix[y][x], max);
            const i = (y * n + x) * 4;
            img.data[i] = r;
            img.data[i + 1] = g;
            img.data[i + 2] = b;
            img.data[i + 3] = 255;
          }
        }
        ctx.putImageData(img, 0, 0);
        setLoading(false);
      })
      .catch(() => {
        setError(true);
        setLoading(false);
      });
  }, [paeJsonPath]);

  return (
    <div className="pae-wrap">
      <div className="cif-viewer-label">Predicted Aligned Error</div>
      <div className="pae-body">
        <span className="pae-axis-y">Aligned residue</span>
        <div className="pae-plot">
          {loading && <p className="pae-status">Loading…</p>}
          {error && <p className="pae-status">Failed to load PAE data.</p>}
          <canvas
            ref={canvasRef}
            className="pae-canvas"
            style={{ display: loading || error ? "none" : "block" }}
          />
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
