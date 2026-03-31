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

export default function ProteinDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [protein, setProtein] = useState<ProteinDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!id) return;
    getProtein(Number(id))
      .then(setProtein)
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

        <div className="pd-header-right">
          <div className="pd-stat-row">
            <span className="pd-stat-label">Binder runs</span>
            <span className="pd-stat-badge">{protein.runs.length}</span>
          </div>
          <div className="pd-stat-row">
            <span className="pd-stat-label">Total binders</span>
            <span className="pd-stat-badge">{totalBinders}</span>
          </div>
          {distTotal > 0 && (
            <div className="pd-dist">
              <p className="pd-dist-label">Status distribution</p>
              {Object.entries(counts).map(([s, n]) => (
                <div key={s} className="pd-dist-row">
                  <span className={`pd-dist-dot ${statusClass(s)}`} />
                  <span className="pd-dist-name">{s}</span>
                  <span className="pd-dist-pct">{((n / distTotal) * 100).toFixed(1)}%</span>
                </div>
              ))}
            </div>
          )}
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
        <div className="pd-seq-block">{protein.sequence}</div>
      </div>

      {/* ── Runs + sidebar ── */}
      <div className="pd-body">
        <div className="pd-runs">
          <h2>Binder Runs ({protein.runs.length})</h2>
          {protein.runs.length === 0 ? (
            <p className="status">No binder runs yet.</p>
          ) : (
            protein.runs.map((run) => <RunCard key={run.id} run={run} />)
          )}
        </div>

        <aside className="pd-sidebar">
          <div className="pd-panel">
            <div className="pd-panel-title">Status Legend</div>
            <div className="pd-legend-item">
              <span className="pd-legend-dot s-success" />
              <div>
                <div className="pd-legend-name">Success</div>
                <div className="pd-legend-desc">Binder passed all filters</div>
              </div>
            </div>
            <div className="pd-legend-item">
              <span className="pd-legend-dot s-failed" />
              <div>
                <div className="pd-legend-name">Failed</div>
                <div className="pd-legend-desc">See failure_reason for details</div>
              </div>
            </div>
            <div className="pd-legend-item">
              <span className="pd-legend-dot s-unknown" />
              <div>
                <div className="pd-legend-name">Unknown</div>
                <div className="pd-legend-desc">Status not yet assigned</div>
              </div>
            </div>
          </div>
        </aside>
      </div>
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
          <span>Binder #{binder.id}</span>
          <button className="cif-modal-close" onClick={onClose}>✕</button>
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

function RunCard({ run }: { run: BinderRun }) {
  const [selectedBinder, setSelectedBinder] = useState<Binder | null>(null);

  return (
    <div className="run-card">
      <div className="run-card-header">
        <span className="run-title">
          Run #{run.id}
          {run.algorithm_version && (
            <span className="run-algo"> — {run.algorithm_version}</span>
          )}
        </span>
        <span className="run-date">{new Date(run.run_datetime).toLocaleString()}</span>
      </div>

      {(run.hardware || run.description || run.notes) && (
        <dl className="run-meta">
          {run.hardware && <><dt>Hardware</dt><dd>{run.hardware}</dd></>}
          {run.description && <><dt>Description</dt><dd>{run.description}</dd></>}
          {run.notes && <><dt>Notes</dt><dd>{run.notes}</dd></>}
        </dl>
      )}

      <h4>Binders ({run.binders.length})</h4>
      {run.binders.length === 0 ? (
        <p className="status">No binders.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Length (aa)</th>
              <th>Status</th>
              <th>Sequence</th>
              <th>Failure Reason</th>
            </tr>
          </thead>
          <tbody>
            {run.binders.map((b) => (
              <tr
                key={b.id}
                className="binder-row"
                onClick={() => setSelectedBinder(b)}
                title="Click to view structures"
              >
                <td>{b.id}</td>
                <td>{b.binder_length ?? "—"}</td>
                <td>
                  <span className={`status-pill ${statusClass(b.status)}`}>
                    {b.status ?? "—"}
                  </span>
                </td>
                <td className="sequence">{b.binder_sequence}</td>
                <td>{b.failure_reason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selectedBinder && (
        <BinderModal
          binder={selectedBinder}
          runCifPath={run.cif_path}
          onClose={() => setSelectedBinder(null)}
        />
      )}
    </div>
  );
}
