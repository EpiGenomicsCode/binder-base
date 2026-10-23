import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { getProtein } from "../api/client";
import type { ProteinDetail } from "../types";
import CifViewer from "../components/CifViewer";
import PaeViewer from "../components/PaeViewer";
import ProteinSearchBar from "../components/ProteinSearchBar";
import RunTargetStructure from "../components/RunTargetStructure";
import BindersTable from "../components/BindersTable";
import { LinkedSequenceBlock } from "../components/SequenceBlock";
import { RunMetadata, RunStepsList, configSummary, runLabel } from "../components/RunConfig";

function ProteinSequenceStructure({ protein }: { protein: ProteinDetail }) {
  const [copied, setCopied] = useState(false);
  const [hoverResno, setHoverResno] = useState<number | null>(null);

  function copySequence() {
    navigator.clipboard.writeText(protein.sequence).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <>
      {/* ── Sequence ── */}
      <div className="pd-seq-section">
        <div className="pd-seq-header">
          <span className="pd-chain-label">
            A | 1: {protein.protein_name ?? protein.uniprot_id}
          </span>
          <button className="pill-btn pd-copy-btn" onClick={copySequence}>
            {copied ? "Copied!" : "Copy sequence"}
          </button>
        </div>
        <LinkedSequenceBlock
          seq={protein.sequence}
          hoverResno={hoverResno}
          onHover={setHoverResno}
        />
      </div>

      {/* ── Structure & PAE ── */}
      {(protein.cif_path || protein.pae_json_path) && (
        <div className="pd-structure-section">
          <div className="pd-structure-plots">
            {protein.pae_json_path && (
              <PaeViewer
                paeJsonPath={protein.pae_json_path}
                highlightResidue={hoverResno}
                onHoverResidue={setHoverResno}
              />
            )}
            {protein.cif_path && (
              <CifViewer
                cifPath={protein.cif_path}
                label="AlphaFold Structure"
                highlightResidue={hoverResno}
                onHoverResidue={setHoverResno}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}


export default function ProteinDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [protein, setProtein] = useState<ProteinDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    if (!id) return;
    getProtein(Number(id))
      .then((p) => {
        setProtein(p);
        if (p.runs.length > 0) {
          const paramId = Number(searchParams.get("run"));
          const match = p.runs.find((r) => r.id === paramId);
          setSelectedRunId(match ? match.id : p.runs[0].id);
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <p className="status">Loading...</p>;
  if (error === "404") return <p className="status error">Protein not found.</p>;
  if (error) return <p className="status error">Failed to load protein: {error}</p>;
  if (!protein) return null;

  return (
    <div>
      <div className="pd-topbar">
        <Link to="/proteins" className="pill-btn back-link-inline">← All Proteins</Link>
        <ProteinSearchBar
          value={searchQuery}
          onChange={setSearchQuery}
          onSubmit={(q) => navigate(q ? `/proteins?q=${encodeURIComponent(q)}` : "/proteins")}
          compact
        />
      </div>

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
            {protein.biological_function && (
              <>
                <dt>Function</dt>
                <dd>{protein.biological_function}</dd>
              </>
            )}
          </dl>
        </div>        
      </div>
      
      {/* ── Sequence + Structure (hover-linked) ── */}
      <ProteinSequenceStructure protein={protein} />

      {/* ── Runs + sidebar ── */}
      <h2 style={{ marginBottom: "0.75rem" }}>Binder Runs ({protein.runs.length})</h2>
      {protein.runs.length === 0 ? (
        <p className="status">No binder runs yet.</p>
      ) : (
        <div className="pd-body row g-4">
          <aside className="pd-run-nav col-12 col-lg-3">
            {protein.runs.map((run) => (
              <button
                key={run.id}
                className={`pd-run-nav-item${selectedRunId === run.id ? " active" : ""}`}
                onClick={() => {
                  setSelectedRunId(run.id);
                  setSearchParams({ run: String(run.id) }, { replace: true });
                }}
              >
                {runLabel(run)}
                <span className="run-nav-count">{run.binder_count}</span>
              </button>
            ))}
          </aside>

          <div className="pd-run-content col-12 col-lg-9">
            {(() => {
              const run = protein.runs.find((r) => r.id === selectedRunId);
              if (!run) return null;
              return (
                <>
                  <RunTargetStructure run={run} />

                  {/*
                    Collapsed by default. Provenance is tens of key/value rows
                    plus every step's full config -- needed to reproduce a run,
                    but not what anyone reads first. `key` re-collapses it when
                    the selected run changes.
                  */}
                  <details key={run.id} className="run-config-section">
                    <summary className="run-section-title">
                      Steps &amp; Configuration
                      <span className="run-config-hint">{configSummary(run)}</span>
                    </summary>
                    <dl className="run-config-dl">
                      {run.algorithm && <><dt>Algorithm</dt><dd>{run.algorithm}</dd></>}
                      {run.run_datetime && <><dt>Run date</dt><dd>{new Date(run.run_datetime).toLocaleString()}</dd></>}
                      {run.hardware && <><dt>Hardware</dt><dd>{run.hardware}</dd></>}
                      {run.description && <><dt>Description</dt><dd>{run.description}</dd></>}
                      <RunMetadata metadata={run.metadata} />
                      {run.notes && <><dt>Notes</dt><dd>{run.notes}</dd></>}
                    </dl>
                    <RunStepsList key={run.id} stepsConfig={run.steps_config} />
                  </details>
                  <div className="run-section-title">Binders</div>
                  {/* key resets table state (page, sort, filter) when the run changes */}
                  <BindersTable key={run.id} runId={run.id} runCifPath={run.cif_path} />
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
