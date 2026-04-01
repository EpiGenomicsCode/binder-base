import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getProtein } from "../api/client";
import type { Binder, BinderRun, ProteinDetail } from "../types";
import CifViewer from "../components/CifViewer";

function statusClass(status: string | null): string {
  if (!status) return "s-unknown";
  const s = status.toLowerCase();
  if (s === "success") return "s-success";
  if (s === "failed" || s === "failure") return "s-failed";
  return "s-unknown";
}

function statusDistribution(runs: BinderRun[]) {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const run of runs) {
    for (const b of run.binders) {
      const key = b.status ?? "Unknown";
      counts[key] = (counts[key] ?? 0) + 1;
      total++;
    }
  }
  return { counts, total };
}

function formatSequence(seq: string): { lineNum: number; blocks: string[] }[] {
  const lines: { lineNum: number; blocks: string[] }[] = [];
  for (let i = 0; i < seq.length; i += 60) {
    const chunk = seq.slice(i, i + 60);
    const blocks: string[] = [];
    for (let j = 0; j < chunk.length; j += 10) {
      blocks.push(chunk.slice(j, j + 10));
    }
    lines.push({ lineNum: i + 1, blocks });
  }
  return lines;
}

function runLabel(run: BinderRun): string {
  if (run.description) return run.description;
  const parts = [run.algorithm_version, run.run_datetime ? new Date(run.run_datetime).toLocaleDateString() : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" — ") : `Run #${run.id}`;
}

export default function ProteinDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [protein, setProtein] = useState<ProteinDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);

  useEffect(() => {
    if (!id) return;
    getProtein(Number(id))
      .then((p) => {
        setProtein(p);
        if (p.runs.length > 0) setSelectedRunId(p.runs[0].id);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  function copySequence() {
    if (!protein) return;
    navigator.clipboard.writeText(protein.sequence).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (loading) return <p className="status">Loading...</p>;
  if (error === "404") return <p className="status error">Protein not found.</p>;
  if (error) return <p className="status error">Failed to load protein: {error}</p>;
  if (!protein) return null;

  const totalBinders = protein.runs.reduce((sum, r) => sum + r.binders.length, 0);
  const { counts, total: distTotal } = statusDistribution(protein.runs);

  return (
    <div>
      <p className="back-link"><Link to="/">← All Proteins</Link></p>

      {/* ── Header ── */}
      <div className="pd-header">
        <div className="pd-header-left">
          <h1>{protein.protein_name ?? protein.uniprot_id ?? `Protein #${protein.id}`}</h1>
          <dl className="pd-meta">
            <dt>Protein</dt>
            <dd>{protein.protein_name ?? "—"}</dd>
            <dt>Gene</dt>
            <dd>{protein.gene_name ?? "—"}</dd>
            <dt>Source organism</dt>
            <dd>{protein.organism ?? "—"}</dd>
            <dt>UniProt</dt>
            <dd>
              {protein.uniprot_id ? (
                <a
                  href={`https://www.uniprot.org/uniprotkb/${protein.uniprot_id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {protein.uniprot_id} ↗
                </a>
              ) : "—"}
            </dd>
            <dt>Length</dt>
            <dd>{protein.length != null ? `${protein.length} aa` : "—"}</dd>
          </dl>
        </div>        
      </div>

      {/* ── Sequence ── */}
      <div className="pd-seq-section">
        <div className="pd-seq-header">
          <span className="pd-chain-label">
            A | 1: {protein.protein_name ?? protein.uniprot_id}
          </span>
          <button className="pd-copy-btn" onClick={copySequence}>
            {copied ? "Copied!" : "Copy sequence"}
          </button>
        </div>
        <div className="pd-seq-block">
          {formatSequence(protein.sequence).map(({ lineNum, blocks }) => (
            <div key={lineNum} className="seq-line">
              <span className="seq-num">{lineNum}</span>
              <span className="seq-blocks">{blocks.join(" ")}</span>
              <span className="seq-end">{Math.min(lineNum + 59, protein.sequence.length)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Runs + sidebar ── */}
      <h2 style={{ marginBottom: "0.75rem" }}>Binder Runs ({protein.runs.length})</h2>
      {protein.runs.length === 0 ? (
        <p className="status">No binder runs yet.</p>
      ) : (
        <div className="pd-body">
          <aside className="pd-run-nav">
            {protein.runs.map((run) => (
              <button
                key={run.id}
                className={`pd-run-nav-item${selectedRunId === run.id ? " active" : ""}`}
                onClick={() => setSelectedRunId(run.id)}
              >
                {runLabel(run)}
              </button>
            ))}
          </aside>

          <div className="pd-run-content">
            {(() => {
              const run = protein.runs.find((r) => r.id === selectedRunId);
              if (!run) return null;
              const sorted = [...run.binders].sort(
                (a, b) => (a.final_rank ?? Infinity) - (b.final_rank ?? Infinity)
              );
              return <BindersTable binders={sorted} runCifPath={run.cif_path} />;
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

interface BinderModalProps {
  binder: Binder;
  runCifPath: string | null;
  onClose: () => void;
}

function BinderModal({ binder, runCifPath, onClose }: BinderModalProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const hasCifs = runCifPath || binder.cif_path;

  return (
    <div className="cif-modal-overlay" onClick={onClose}>
      <div className="cif-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cif-modal-header">
          <span>RANK #{binder.final_rank}, QUALITY SCORE: {binder.quality_score?.toFixed(3) ?? "—"}, DESIGN TO TARGET IPTM: {binder.design_to_target_iptm?.toFixed(3) ?? "—"}</span>
          <button className="cif-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="cif-modal-sequence">
          {formatSequence(binder.binder_sequence).map(({ lineNum, blocks }) => (
            <div key={lineNum} className="seq-line">
              <span className="seq-num">{lineNum}</span>
              <span className="seq-blocks">{blocks.join(" ")}</span>
              <span className="seq-end">{Math.min(lineNum + 59, binder.binder_sequence.length)}</span>
            </div>
          ))}
        </div>
        {hasCifs ? (
          <div className="cif-modal-viewers">
            {runCifPath && (
              <CifViewer cifPath={runCifPath} label="Target protein" />
            )}
            {binder.cif_path && (
              <CifViewer cifPath={binder.cif_path} label="Binder" />
            )}
          </div>
        ) : (
          <p className="cif-modal-empty">No CIF files available for this binder.</p>
        )}
      </div>
    </div>
  );
}

function BindersTable({ binders, runCifPath }: { binders: Binder[]; runCifPath: string | null }) {
  const [selectedBinder, setSelectedBinder] = useState<Binder | null>(null);

  if (binders.length === 0) return <p className="status">No binders.</p>;

  return (
    <>
      <table>
        <thead>
          <tr>
            <th>Rank</th>
            <th>Quality Score</th>
            <th>iPTM</th>
            <th>Sequence</th>
            <th>Length (aa)</th>
          </tr>
        </thead>
        <tbody>
          {binders.map((b) => (
            <tr
              key={b.id}
              className="binder-row"
              onClick={() => setSelectedBinder(b)}
              title="Click to view structures"
            >
              <td>{b.final_rank ?? "—"}</td>
              <td>{b.quality_score != null ? b.quality_score.toFixed(3) : "—"}</td>
              <td>{b.design_to_target_iptm != null ? b.design_to_target_iptm.toFixed(3) : "—"}</td>
              <td className="sequence">{b.binder_sequence}</td>
              <td>{b.binder_length ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {selectedBinder && (
        <BinderModal
          binder={selectedBinder}
          runCifPath={runCifPath}
          onClose={() => setSelectedBinder(null)}
        />
      )}
    </>
  );
}
