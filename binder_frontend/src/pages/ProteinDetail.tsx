import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { getProtein } from "../api/client";
import type { ProteinDetail } from "../types";
import CifViewer from "../components/CifViewer";
import PaeViewer from "../components/PaeViewer";
import ProteinSearchBar from "../components/ProteinSearchBar";
import RunCard from "../components/RunCard";
import { LinkedSequenceBlock } from "../components/SequenceBlock";
import usePageMeta, { count, geneWithAccession } from "../utils/pageMeta";

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
  const [searchQuery, setSearchQuery] = useState("");
  const [searchParams] = useSearchParams();

  useEffect(() => {
    if (!id) return;
    getProtein(Number(id))
      .then(setProtein)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  // Above the early returns below, including the <Navigate>: a hook that some
  // renders reach and others do not changes the hook count between renders,
  // which React treats as an error rather than a missing title.
  const designs = protein
    ? protein.runs.reduce((sum, r) => sum + r.binder_count, 0)
    : 0;
  usePageMeta({
    title: protein
      ? geneWithAccession(protein.gene_name, protein.uniprot_id, `Protein #${protein.id}`)
      : "Protein",
    description: protein
      ? [
          protein.protein_name ?? protein.gene_name ?? protein.uniprot_id ?? "Protein",
          protein.organism ? ` — ${protein.organism}` : "",
          protein.length ? `, ${count(protein.length)} aa` : "",
          `. ${count(protein.runs.length)} binder design run`,
          protein.runs.length === 1 ? "" : "s",
          designs ? `, ${count(designs)} designs` : "",
          " in Binder Base.",
        ].join("")
      : null,
  });

  // Runs used to be panels here, addressed as /proteins/:id?run=<id>. They have
  // their own page now, so keep those links working rather than silently
  // dropping the parameter.
  const legacyRun = Number(searchParams.get("run"));
  if (protein && legacyRun && protein.runs.some((r) => r.id === legacyRun)) {
    return <Navigate to={`/runs/${legacyRun}`} replace />;
  }

  if (loading) return <p className="status">Loading...</p>;
  if (error === "404") return <p className="status error">Protein not found.</p>;
  if (error) return <p className="status error">Failed to load protein: {error}</p>;
  if (!protein) return null;

  return (
    <div>
      <div className="pd-topbar">
        <Link to="/proteins" className="pill-btn back-link-inline">← All Targets</Link>
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

      {/* -- Runs -------------------------------------------------------- */}
      {/* A browsing surface: one card per run with its verdict, linking to the
          run page. The full panel that used to live here -- target viewer,
          configuration, binder table -- is that page now. */}
      <h2 style={{ marginBottom: "0.75rem" }}>Binder Runs ({protein.runs.length})</h2>
      {protein.runs.length === 0 ? (
        <p className="status">No binder runs yet.</p>
      ) : (
        <div className="run-card-list">
          {protein.runs.map((run) => (
            <RunCard key={run.id} run={run} />
          ))}
        </div>
      )}
    </div>
  );
}
