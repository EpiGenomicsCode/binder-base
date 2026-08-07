import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { getProtein, getRunBinders } from "../api/client";
import type { Binder, BinderRun, ProteinDetail } from "../types";
import CifViewer from "../components/CifViewer";
import PaeViewer from "../components/PaeViewer";
import ProteinSearchBar from "../components/ProteinSearchBar";

function statusClass(status: string | null): string {
  if (!status) return "s-unknown";
  const s = status.toLowerCase();
  if (s === "success") return "s-success";
  if (s === "failed" || s === "failure") return "s-failed";
  if (s === "passed") return "s-passed";
  return "s-unknown";
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

// Sequence rendered as per-residue spans, hover-linked to a structure viewer:
// hovering a residue reports its number, and the residue matching `hoverResno`
// is highlighted. Residue number is 1-based (== label_seq_id for full models).
function LinkedSequenceBlock({
  seq,
  hoverResno,
  onHover,
  className = "pd-seq-block",
}: {
  seq: string;
  hoverResno: number | null;
  onHover: (resno: number | null) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      {formatSequence(seq).map(({ lineNum, blocks }) => (
        <div key={lineNum} className="seq-line">
          <span className="seq-num">{lineNum}</span>
          <span className="seq-blocks">
            {blocks.map((block, bi) => (
              <span key={bi}>
                {block.split("").map((aa, ci) => {
                  const resno = lineNum + bi * 10 + ci;
                  return (
                    <span
                      key={ci}
                      className={`seq-res${hoverResno === resno ? " seq-res-hover" : ""}`}
                      onMouseEnter={() => onHover(resno)}
                      onMouseLeave={() => onHover(null)}
                    >
                      {aa}
                    </span>
                  );
                })}
                {bi < blocks.length - 1 ? " " : ""}
              </span>
            ))}
          </span>
          <span className="seq-end">{Math.min(lineNum + 59, seq.length)}</span>
        </div>
      ))}
    </div>
  );
}

// Protein sequence block + AlphaFold structure viewer, hover-linked: hovering a
// residue in either highlights it in the other. Kept as its own component so
// hover state changes don't re-render the rest of the page.
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
              <PaeViewer paeJsonPath={protein.pae_json_path} />
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

// Run's target structure viewer + target sequence, hover-linked the same way.
function RunTargetStructure({ run }: { run: BinderRun }) {
  const [copied, setCopied] = useState(false);
  const [hoverResno, setHoverResno] = useState<number | null>(null);

  function copy() {
    if (!run.target_sequence) return;
    navigator.clipboard.writeText(run.target_sequence).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="run-target-section">
      <div className="run-section-title">DESIGN TARGET PROTEIN STRUCTURE</div>
      <div className="run-target-body">
        <div className="run-target-cif">
          {run.cif_path ? (
            <CifViewer
              cifPath={run.cif_path}
              label="TARGET STRUCTURE"
              coloring="hotspot"
              highlightResidue={hoverResno}
              onHoverResidue={setHoverResno}
            />
          ) : (
            <p className="cif-modal-empty">No structure available.</p>
          )}
        </div>
        <div className="run-target-seq">
          {run.target_sequence ? (
            <>
              <div className="pd-seq-header">
                <span className="pd-chain-label">TARGET SEQUENCE</span>
                <button className="pill-btn pd-copy-btn" onClick={copy}>
                  {copied ? "Copied!" : "Copy sequence"}
                </button>
              </div>
              <LinkedSequenceBlock
                seq={run.target_sequence}
                hoverResno={hoverResno}
                onHover={setHoverResno}
              />
            </>
          ) : (
            <p className="status" style={{ padding: "1rem 1.25rem" }}>
              No sequence available.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function runLabel(run: BinderRun): string {
  if (run.description) return run.description;
  const parts = [run.algorithm_version, run.run_datetime ? new Date(run.run_datetime).toLocaleDateString() : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" — ") : `Run #${run.id}`;
}

interface RunStep {
  name: string;
  config: unknown;
  configPath: string | null;
}

function normalizeSteps(stepsConfig: unknown): RunStep[] {
  if (!stepsConfig) return [];

  const pickConfig = (val: Record<string, unknown>): unknown => {
    if ("config" in val) return val.config;
    if ("config_file" in val) return val.config_file;
    if ("config_path" in val) return val.config_path;
    return null;
  };

  const pickConfigPath = (val: Record<string, unknown>): string | null => {
    for (const k of ["config_path", "config_file_path", "config_file"] as const) {
      const v = val[k];
      if (typeof v === "string") return v;
    }
    // Older format where config field itself was the path string
    if (typeof val.config === "string") return val.config;
    return null;
  };

  const fromEntry = (entry: unknown, idx: number): RunStep => {
    if (typeof entry === "string") return { name: entry, config: null, configPath: null };
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      const name = e.name ?? e.step ?? e.id ?? `Step ${idx + 1}`;
      const config = pickConfig(e);
      const configPath = pickConfigPath(e);
      return {
        name: String(name),
        config: typeof config === "string" ? null : config,
        configPath,
      };
    }
    return { name: `Step ${idx + 1}`, config: null, configPath: null };
  };

  let rawList: unknown[] | null = null;

  if (Array.isArray(stepsConfig)) {
    rawList = stepsConfig;
  } else if (typeof stepsConfig === "object") {
    const obj = stepsConfig as Record<string, unknown>;
    if (Array.isArray(obj.steps)) {
      rawList = obj.steps;
    } else if (obj.steps && typeof obj.steps === "object") {
      return Object.entries(obj.steps as Record<string, unknown>).map(([k, v]) => ({
        name: k,
        config: v && typeof v === "object" ? pickConfig(v as Record<string, unknown>) : v,
        configPath: v && typeof v === "object" ? pickConfigPath(v as Record<string, unknown>) : null,
      }));
    } else {
      return Object.entries(obj).map(([k, v]) => ({
        name: k,
        config: v && typeof v === "object" ? pickConfig(v as Record<string, unknown>) : v,
        configPath: v && typeof v === "object" ? pickConfigPath(v as Record<string, unknown>) : null,
      }));
    }
  }

  return rawList ? rawList.map(fromEntry) : [];
}

function RunStepsList({ stepsConfig }: { stepsConfig: unknown }) {
  const steps = normalizeSteps(stepsConfig);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  if (steps.length === 0) return null;

  function toggle(i: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  }

  return (
    <div className="run-steps-section">
      <div className="run-steps-section-title">Steps</div>
      <ol className="run-steps-list">
        {steps.map((step, i) => {
          const isOpen = expanded.has(i);
          const hasConfig = step.config !== null && step.config !== undefined;
          return (
            <li key={i} className="run-step-item">
              <div className="run-step-header">
                <span className="run-step-name">{step.name}</span>
                {hasConfig && (
                  <button
                    className="run-step-toggle"
                    onClick={() => toggle(i)}
                    aria-expanded={isOpen}
                  >
                    {isOpen ? "Hide config ▲" : "Show config ▼"}
                  </button>
                )}
              </div>
              {isOpen && hasConfig && (
                <pre className="run-step-config">
                  {JSON.stringify(step.config, null, 2)}
                </pre>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}


// The leftover meta.json keys, rendered as extra rows of the run's key/value
// list alongside Algorithm, Run date and the rest — those three were lifted out
// of the same file at import time, so they belong in one list.
//
// Returns a Fragment rather than a wrapper element: `run-config-dl` is a grid,
// so the <dt>/<dd> pairs have to stay direct children of the <dl> to line up.
function RunMetadata({ metadata }: { metadata: unknown }) {
  if (metadata === null || metadata === undefined) return null;

  // A non-object value (array, string, number) has no keys to merge into the
  // list, so it gets a single row under a generic label.
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    return (
      <>
        <dt>Metadata</dt>
        <dd>
          <pre className="run-step-config">{JSON.stringify(metadata, null, 2)}</pre>
        </dd>
      </>
    );
  }

  const entries = Object.entries(metadata as Record<string, unknown>);
  if (entries.length === 0) return null;

  return (
    <>
      {entries.map(([key, val]) => (
        <Fragment key={key}>
          <dt>{key}</dt>
          <dd>
            {val !== null && typeof val === "object" ? (
              <pre className="run-step-config">{JSON.stringify(val, null, 2)}</pre>
            ) : (
              String(val)
            )}
          </dd>
        </Fragment>
      ))}
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

                  <div className="run-config-section">
                    <div className="run-section-title">Steps &amp; Configuration</div>
                    <dl className="run-config-dl">
                      {run.algorithm_version && <><dt>Algorithm</dt><dd>{run.algorithm_version}</dd></>}
                      {run.run_datetime && <><dt>Run date</dt><dd>{new Date(run.run_datetime).toLocaleString()}</dd></>}
                      {run.hardware && <><dt>Hardware</dt><dd>{run.hardware}</dd></>}
                      {run.description && <><dt>Description</dt><dd>{run.description}</dd></>}
                      <RunMetadata metadata={run.metadata} />
                      {run.notes && <><dt>Notes</dt><dd>{run.notes}</dd></>}
                    </dl>
                    <RunStepsList key={run.id} stepsConfig={run.steps_config} />
                  </div>
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

interface BinderModalProps {
  binder: Binder;
  runCifPath: string | null;
  onClose: () => void;
}

function BinderModal({ binder, runCifPath, onClose }: BinderModalProps) {
  const [copied, setCopied] = useState(false);
  const [hoverResno, setHoverResno] = useState<number | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function copySequence() {
    navigator.clipboard.writeText(binder.binder_sequence).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const hasCifs = runCifPath || binder.cif_path;

  return (
    <div className="cif-modal-overlay" onClick={onClose}>
      <div className="cif-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cif-modal-header">
          <span>RANK #{binder.final_rank}</span>
          <span>QUALITY SCORE = {binder.quality_score?.toFixed(3) ?? "—"}</span>
          <span> DESIGN TO TARGET IPTM = {binder.design_to_target_iptm?.toFixed(3) ?? "—"}</span>
          {binder.status
              ? <span className={`status-pill ${statusClass(binder.status)}`}>{binder.status}</span>
              : null}          
          <div className="cif-modal-header-right">
            <button className="cif-modal-close" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="cif-modal-seq-header">
          <span className="cif-modal-seq-label">SEQUENCE</span>
          <button className="pill-btn pd-copy-btn" onClick={copySequence}>
            {copied ? "Copied!" : "Copy sequence"}
          </button>
        </div>
        <LinkedSequenceBlock
          className="cif-modal-sequence"
          seq={binder.binder_sequence}
          hoverResno={hoverResno}
          onHover={setHoverResno}
        />
        {hasCifs ? (
          <div className="cif-modal-viewers">
            {runCifPath ? (
              <CifViewer cifPath={runCifPath} label="Target protein" coloring="none" />
            ) : (
              <div className="cif-viewer-wrap">
                <div className="cif-viewer-label">Target protein</div>
                <div className="cif-viewer-placeholder">No CIF file available</div>
              </div>
            )}
            {binder.cif_path ? (
              <CifViewer
                cifPath={binder.cif_path}
                label="Target + Binder"
                coloring="none"
                highlightResidue={hoverResno}
                onHoverResidue={setHoverResno}
                seqChainLength={binder.binder_length ?? binder.binder_sequence.length}
              />
            ) : (
              <div className="cif-viewer-wrap">
                <div className="cif-viewer-label">Target + Binder</div>
                <div className="cif-viewer-placeholder">No CIF file available</div>
              </div>
            )}
          </div>
        ) : (
          <p className="cif-modal-empty">No CIF files available for this binder.</p>
        )}
        <div className="cif-modal-meta-title">DETAILS</div>
        {(() => {
          const entries: { label: string; value: string }[] = [
            { label: "Rank", value: binder.final_rank != null ? String(binder.final_rank) : "—" },
            { label: "Length", value: binder.binder_length != null ? `${binder.binder_length} aa` : "—" },
            { label: "Quality Score", value: binder.quality_score != null ? binder.quality_score.toFixed(3) : "—" },
            { label: "Design to Target iPTM", value: binder.design_to_target_iptm != null ? binder.design_to_target_iptm.toFixed(3) : "—" },
            ...(binder.failure_reason ? [{ label: "Failure Reason", value: binder.failure_reason }] : []),
            ...(binder.metrics
              ? Object.entries(binder.metrics)
                  .filter(([key]) => key !== "id" && key !== "file_name")
                  .map(([key, val]) => ({ label: key, value: String(val) }))
              : []),
          ];
          const rows: typeof entries[] = [];
          for (let i = 0; i < entries.length; i += 2) rows.push(entries.slice(i, i + 2));
          return (
            <table className="cif-modal-meta-table">
              <tbody>
                {rows.map((pair, i) => (
                  <tr key={i}>
                    <th>{pair[0].label}</th>
                    <td className="cif-modal-meta-val-left">{pair[0].value}</td>
                    <th className="cif-modal-meta-th-right">{pair[1]?.label ?? ""}</th>
                    <td>{pair[1]?.value ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          );
        })()}
      </div>
    </div>
  );
}

type BinderSortKey = "rank" | "quality" | "iptm" | "length" | "status";
type BinderSortDir = "asc" | "desc";
type StatusFilter = "all" | "success" | "passed" | "failed";

function BinderSortIcon({ active, dir }: { active: boolean; dir: BinderSortDir }) {
  if (!active) return <span className="sort-icon inactive">↕</span>;
  return <span className="sort-icon active">{dir === "asc" ? "↑" : "↓"}</span>;
}

const PAGE_SIZES = [20, 50, 100] as const;
type PageSize = typeof PAGE_SIZES[number];

interface BinderColumn {
  id: string;
  label: string;
  sortKey?: BinderSortKey;
  cellClassName?: string;
  render: (b: Binder) => React.ReactNode;
}

const BINDER_COLUMNS: BinderColumn[] = [
  { id: "rank",     label: "Rank",          sortKey: "rank",    render: (b) => b.final_rank ?? "—" },
  { id: "quality",  label: "Quality Score", sortKey: "quality", render: (b) => b.quality_score != null ? b.quality_score.toFixed(3) : "—" },
  { id: "iptm",     label: "iPTM",          sortKey: "iptm",    render: (b) => b.design_to_target_iptm != null ? b.design_to_target_iptm.toFixed(3) : "—" },
  { id: "sequence", label: "Sequence",      cellClassName: "sequence", render: (b) => b.binder_sequence },
  { id: "length",   label: "Length (aa)",   sortKey: "length",  render: (b) => b.binder_length ?? "—" },
  { id: "status",   label: "Status",        sortKey: "status",  render: (b) => b.status ? <span className={`status-pill ${statusClass(b.status)}`}>{b.status}</span> : "—" },
];

const DEFAULT_VISIBLE_BINDER_COLUMNS: string[] = BINDER_COLUMNS.map((c) => c.id);

function BindersTable({ runId, runCifPath }: { runId: number; runCifPath: string | null }) {
  const [selectedBinder, setSelectedBinder] = useState<Binder | null>(null);
  const [sortKey, setSortKey] = useState<BinderSortKey>("rank");
  const [sortDir, setSortDir] = useState<BinderSortDir>("asc");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(20);
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(
    () => new Set(DEFAULT_VISIBLE_BINDER_COLUMNS)
  );
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const columnsMenuRef = useRef<HTMLDivElement>(null);

  // Server-paged binders: sorting, filtering and paging all round-trip, so a run
  // with thousands of designs only ever ships one page to the browser.
  const [binders, setBinders] = useState<Binder[]>([]);
  const [total, setTotal] = useState(0);
  const [metricKeys, setMetricKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    getRunBinders(
      runId,
      { page, pageSize, sort: sortKey, sortDir, status: statusFilter },
      ctrl.signal
    )
      .then((res) => {
        setBinders(res.items);
        setTotal(res.total);
        setMetricKeys(res.metric_keys);
        setLoadError(null);
        setLoading(false);
      })
      .catch((e: Error) => {
        if (e.name === "AbortError") return; // superseded by a newer request
        setLoadError(e.message);
        setLoading(false);
      });
    return () => ctrl.abort();
  }, [runId, page, pageSize, sortKey, sortDir, statusFilter]);

  useEffect(() => {
    if (!columnsMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (columnsMenuRef.current && !columnsMenuRef.current.contains(e.target as Node)) {
        setColumnsMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [columnsMenuOpen]);

  function toggleColumn(id: string) {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      // Ensure at least one column stays visible
      if (next.size === 0) next.add(id);
      return next;
    });
  }

  const metricColumns: BinderColumn[] = useMemo(
    () =>
      metricKeys.map((k) => ({
        id: `metric:${k}`,
        label: k,
        render: (b: Binder) => {
          const v = b.metrics?.[k];
          return v == null || v === "" ? "—" : String(v);
        },
      })),
    [metricKeys]
  );

  const allColumns = useMemo(
    () => [...BINDER_COLUMNS, ...metricColumns],
    [metricColumns]
  );
  const activeColumns = allColumns.filter((c) => visibleColumns.has(c.id));

  function handleSort(key: BinderSortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
    setPage(1);
  }

  function handleStatusFilter(f: StatusFilter) {
    setStatusFilter(f);
    setPage(1);
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);

  if (loadError) return <p className="status error">Failed to load binders: {loadError}</p>;
  if (loading && binders.length === 0) return <p className="status">Loading binders...</p>;
  if (!loading && total === 0 && statusFilter === "all") return <p className="status">No binders.</p>;

  return (
    <>
      <div className="binder-filter-bar">
        {(["all", "success", "passed", "failed"] as const).map((f) => (
          <button
            key={f}
            className={`binder-filter-btn${statusFilter === f ? " active" : ""}`}
            onClick={() => handleStatusFilter(f)}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <span className="binder-filter-count">
          {total} binder{total !== 1 ? "s" : ""}
        </span>
        <div className="binder-columns-menu" ref={columnsMenuRef}>
          <button
            className="binder-columns-btn"
            onClick={() => setColumnsMenuOpen((o) => !o)}
            aria-expanded={columnsMenuOpen}
          >
            Columns ▾
          </button>
          {columnsMenuOpen && (
            <div className="binder-columns-popover">
              <div className="binder-columns-header">
                <button
                  className="binder-columns-reset"
                  onClick={() => setVisibleColumns(new Set(DEFAULT_VISIBLE_BINDER_COLUMNS))}
                >
                  Reset to default
                </button>
              </div>
              <div className="binder-columns-group-label">Standard</div>
              {BINDER_COLUMNS.map((col) => (
                <label key={col.id} className="binder-columns-row">
                  <input
                    type="checkbox"
                    checked={visibleColumns.has(col.id)}
                    onChange={() => toggleColumn(col.id)}
                  />
                  <span>{col.label}</span>
                </label>
              ))}
              {metricColumns.length > 0 && (
                <>
                  <div className="binder-columns-group-label">Metrics</div>
                  {metricColumns.map((col) => (
                    <label key={col.id} className="binder-columns-row">
                      <input
                        type="checkbox"
                        checked={visibleColumns.has(col.id)}
                        onChange={() => toggleColumn(col.id)}
                      />
                      <span>{col.label}</span>
                    </label>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className={`binder-table-wrap${loading ? " is-loading" : ""}`}>
        <table>
        <thead>
          <tr>
            {activeColumns.map((col) =>
              col.sortKey ? (
                <th
                  key={col.id}
                  className="th-sortable"
                  onClick={() => handleSort(col.sortKey!)}
                >
                  {col.label}{" "}
                  <BinderSortIcon active={sortKey === col.sortKey} dir={sortDir} />
                </th>
              ) : (
                <th key={col.id}>{col.label}</th>
              )
            )}
          </tr>
        </thead>
        <tbody>
          {binders.length === 0 && !loading && (
            <tr>
              <td colSpan={activeColumns.length} className="status">
                No binders match this filter.
              </td>
            </tr>
          )}
          {binders.map((b) => (
            <tr
              key={b.id}
              className="binder-row"
              onClick={() => setSelectedBinder(b)}
              title="Click to view structures"
            >
              {activeColumns.map((col) => (
                <td key={col.id} className={col.cellClassName}>
                  {col.render(b)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        </table>
      </div>

      <div className="binder-pagination">
        <div className="binder-page-size-group">
          <span className="binder-page-size-label">Show:</span>
          {PAGE_SIZES.map((s) => (
            <button
              key={s}
              className={`binder-page-size-btn${pageSize === s ? " active" : ""}`}
              onClick={() => { setPageSize(s); setPage(1); }}
            >
              {s}
            </button>
          ))}
        </div>
        {totalPages > 1 && (
          <div className="binder-page-nav">
            <button
              className="binder-page-btn"
              onClick={() => setPage(safePage - 1)}
              disabled={safePage === 1}
            >
              ← Prev
            </button>
            <span className="binder-page-info">
              Page {safePage} of {totalPages}
            </span>
            <button
              className="binder-page-btn"
              onClick={() => setPage(safePage + 1)}
              disabled={safePage === totalPages}
            >
              Next →
            </button>
          </div>
        )}
      </div>

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
