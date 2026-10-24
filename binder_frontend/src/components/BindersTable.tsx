import { useEffect, useMemo, useRef, useState } from "react";
import { getRunBinders } from "../api/client";
import type { Binder } from "../types";
import CifViewer from "./CifViewer";
import { LinkedSequenceBlock, statusClass } from "./SequenceBlock";

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
            {/*
              Same file RunTargetStructure shows, so it gets the same theme: the
              run-root CIF encodes the hotspot selection in B_iso_or_equiv
              (score*100 for selected residues, 0 elsewhere), not pLDDT.

              The Target+Binder complex below deliberately stays uncolored. Its
              B-factors are per-atom confidence on a 0-1 scale, so "hotspot"
              would paint every atom yellow and "confidence" would read the whole
              structure as very low.
            */}
            {runCifPath ? (
              <CifViewer cifPath={runCifPath} label="Target protein" coloring="hotspot" />
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

export default function BindersTable({ runId, runCifPath }: { runId: number; runCifPath: string | null }) {
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
