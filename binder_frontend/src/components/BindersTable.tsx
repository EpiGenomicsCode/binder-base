import { useEffect, useMemo, useRef, useState } from "react";
import { getRunBinders } from "../api/client";
import type { Binder } from "../types";
import CifViewer from "./CifViewer";
import ExportMenu from "./ExportMenu";
import { LinkedSequenceBlock, statusClass } from "./SequenceBlock";
import {
  compositionView, filterView, groupMetrics, headlineMetrics, liabilityView,
} from "../utils/binderMetrics";

interface BinderModalProps {
  binder: Binder;
  onClose: () => void;
  /** The run's epitope and crop faces, in the target's numbering. */
  epitope?: [number, number][];
  masked?: [number, number][];
}

function BinderModal({ binder, onClose, epitope = [], masked = [] }: BinderModalProps) {
  const [copied, setCopied] = useState(false);
  const [hoverResno, setHoverResno] = useState<number | null>(null);
  // The complex panel answers one of two questions: how confident is the model
  // (pLDDT), or did the binder land on the patch it was aimed at. They need
  // different colourings and cannot be shown at once, so they are a toggle.
  const [complexColoring, setComplexColoring] =
    useState<"confidence" | "epitope">("confidence");
  const canShowEpitope = epitope.length > 0;

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

  // Both viewers key off the binder chain's length: one to isolate it, one to
  // decide which chain of the complex the sequence block hovers against.
  const binderLength = binder.binder_length ?? binder.binder_sequence.length;

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
        {binder.cif_path ? (
          <div className="cif-modal-viewers">
            {/*
              Both panels read the same file -- the target+binder complex, which
              is the only structure a pruned run keeps per binder -- and both use
              the confidence theme, so one legend reading applies to both.

              The run's own target structure is not shown here: the run page
              already devotes a panel to it, and repeating it cost the binder
              the only view where it can be seen on its own. The left panel
              filters the complex down to the binder chain instead.

              "confidence" is correct despite B_iso_or_equiv being on a 0-1
              scale in these files: Mol* colors from _ma_qa_metric_local, which
              carries the same pLDDT on the usual 0-100 scale, and only falls
              back to B-factor when that category is absent.
            */}
            <CifViewer
              cifPath={binder.cif_path}
              label="Binder"
              coloring="confidence"
              highlightResidue={hoverResno}
              onHoverResidue={setHoverResno}
              seqChainLength={binderLength}
              isolateChainLength={binderLength}
            />
            <div className="cif-panel">
              {canShowEpitope && (
                <div className="cif-coloring-toggle" role="group"
                     aria-label="Target + Binder colouring">
                  {([
                    ["confidence", "pLDDT"],
                    ["epitope", "Epitope"],
                  ] as const).map(([mode, text]) => (
                    <button
                      key={mode}
                      type="button"
                      className={`cif-coloring-btn${complexColoring === mode ? " active" : ""}`}
                      aria-pressed={complexColoring === mode}
                      onClick={() => setComplexColoring(mode)}
                    >
                      {text}
                    </button>
                  ))}
                </div>
              )}
              <CifViewer
                cifPath={binder.cif_path}
                label="Target + Binder"
                coloring={canShowEpitope ? complexColoring : "confidence"}
                highlightResidue={hoverResno}
                onHoverResidue={setHoverResno}
                seqChainLength={binderLength}
                epitopeRanges={epitope}
                maskedRanges={masked}
              />
            </div>
          </div>
        ) : (
          <p className="cif-modal-empty">No CIF files available for this binder.</p>
        )}
        <BinderDetails binder={binder} />
      </div>
    </div>
  );
}

type RawMetrics = Record<string, unknown> | null;

function MetricGrid({
  entries, quiet,
}: { entries: { key: string; label: string; value: string }[]; quiet?: boolean }) {
  if (!entries.length) return <p className="bd-none">Nothing recorded.</p>;
  return (
    <dl className={`bd-grid${quiet ? " bd-grid-quiet" : ""}`}>
      {entries.map((e) => (
        <div className="bd-row" key={e.key}>
          <dt title={e.key}>{e.label}</dt>
          <dd>{e.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** ~10 liability types, as the table the CSV flattened. */
function Liabilities({ metrics }: { metrics: RawMetrics }) {
  const view = liabilityView(metrics);
  if (!view) return <p className="bd-none">Nothing recorded.</p>;
  return (
    <>
      {view.summary.length > 0 && (
        <dl className="bd-grid">
          {view.summary.map((e) => (
            <div className="bd-row" key={e.label}>
              <dt>{e.label}</dt>
              <dd>{e.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {view.flagged.length === 0 ? (
        <p className="bd-clear">
          Nothing flagged — {view.types.length} liability
          {view.types.length === 1 ? " type" : " types"} checked.
        </p>
      ) : (
        <table className="bd-liability">
          <thead>
            <tr>
              <th>Liability</th><th>Count</th><th>Severity</th>
              <th>Positions</th><th>Details</th>
            </tr>
          </thead>
          <tbody>
            {view.flagged.map((t) => (
              <tr key={t.type}>
                <th scope="row">{t.type}</th>
                <td>{t.count ?? "—"}</td>
                <td>{t.severity ?? "—"}</td>
                <td>{t.positions || "—"}</td>
                <td className="bd-liability-detail">{t.details || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {view.flagged.length > 0 && view.flagged.length < view.types.length && (
        <p className="bd-clear">
          The other {view.types.length - view.flagged.length} types are clear.
        </p>
      )}
    </>
  );
}

/** The 21 *_fraction columns as one profile, most abundant residue first. */
function Composition({ metrics }: { metrics: RawMetrics }) {
  const view = compositionView(metrics);
  if (!view) return <p className="bd-none">Nothing recorded.</p>;
  // Scaled to the most abundant residue rather than to 100%, so the shape of
  // the profile is visible instead of twenty near-empty bars.
  const peak = view.residues.reduce((m, r) => Math.max(m, r.fraction), 0) || 1;
  return (
    <>
      {view.residues.length > 0 && (
        <ul className="bd-aa">
          {view.residues.map((r) => (
            <li key={r.aa}>
              <span className="bd-aa-letter">{r.aa}</span>
              <span className="bd-aa-track">
                <span className="bd-aa-bar"
                      style={{ width: `${(r.fraction / peak) * 100}%` }} />
              </span>
              <span className="bd-aa-pct">{(r.fraction * 100).toFixed(1)}%</span>
            </li>
          ))}
        </ul>
      )}
      {view.other.length > 0 && (
        <dl className="bd-grid">
          {view.other.map((e) => (
            <div className="bd-row" key={e.label}>
              <dt>{e.label}</dt>
              <dd>{e.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

/** One verdict plus the tests behind it, failures first. */
function Filters({ metrics }: { metrics: RawMetrics }) {
  const view = filterView(metrics);
  if (!view) return <p className="bd-none">Nothing recorded.</p>;
  return (
    <>
      <p className="bd-filter-verdict">
        {view.overall == null ? (
          "No overall verdict recorded."
        ) : (
          <span className={view.overall ? "bd-good" : "bd-bad"}>
            {view.overall ? "Passed every filter" : "Did not pass"}
          </span>
        )}
        {view.passedCount != null && (
          <span className="bd-note"> {view.passedCount} tests passed</span>
        )}
      </p>
      {view.tests.length > 0 && (
        <ul className="bd-chips">
          {view.tests.map((t) => (
            <li key={t.label}
                className={t.passed == null ? "bd-chip-unknown"
                           : t.passed ? "bd-chip-pass" : "bd-chip-fail"}>
              <span aria-hidden="true">
                {t.passed == null ? "?" : t.passed ? "\u2713" : "\u2717"}
              </span>
              {t.label}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * What the pipeline measured.
 *
 * The six metrics BinderBase records for every design regardless of the tool
 * that produced it come first -- the promoted columns, which are the ones with
 * units, thresholds and a definition in the About glossary. Calling them the
 * ones that matter would be a claim about the science rather than a
 * description of the section; what is true of them is that they are the
 * comparable ones.
 *
 * Everything else -- 254 columns for a BoltzGen run -- goes under a
 * disclosure, grouped, because it was previously one flat list of raw column
 * names in CSV order and nothing in it could be found.
 */
function BinderDetails({ binder }: { binder: Binder }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const headline = headlineMetrics(binder);
  const { groups, total } = groupMetrics(binder.metrics, showAll);

  return (
    <div className="bd">
      <div className="cif-modal-meta-title">STANDARD METRICS</div>
      <dl className="bd-headline">
        {headline.map((m) => (
          <div className="bd-metric" key={m.label}>
            <dt>{m.label}</dt>
            <dd>
              <span className={`bd-value${m.verdict ? ` bd-${m.verdict}` : ""}`}>
                {m.value ?? "—"}
              </span>
              {m.note && <span className="bd-note">{m.note}</span>}
            </dd>
          </div>
        ))}
      </dl>

      {total > 0 && (
        <div className="bd-all">
          <button
            type="button"
            className="bd-disclosure"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="bd-caret">{open ? "▾" : "▸"}</span>
            All metrics
            <span className="bd-count">
              {total} column{total === 1 ? "" : "s"}
            </span>
          </button>
          {open && (
            <>
              <label className="bd-toggle">
                <input
                  type="checkbox"
                  checked={showAll}
                  onChange={(e) => setShowAll(e.target.checked)}
                />
                {/* Blank and nan are hidden always; zero and false only where
                    the key is a count or a flag, so a measured zero -- no
                    hydrogen bonds across the interface, say -- still shows. */}
                Show every column as the pipeline recorded it
              </label>
              {groups.map((g) => (
                <section className="bd-group" key={g.id}>
                  <h4 className="bd-group-title">
                    {g.title}
                    <span className="bd-group-n">
                      {g.total} column{g.total === 1 ? "" : "s"}
                    </span>
                  </h4>
                  {/* Raw mode bypasses every custom view: the toggle's job is
                      to show the columns exactly as the pipeline wrote them. */}
                  {!showAll && g.id === "liabilities" ? (
                    <Liabilities metrics={binder.metrics} />
                  ) : !showAll && g.id === "composition" ? (
                    <Composition metrics={binder.metrics} />
                  ) : !showAll && g.id === "filters" ? (
                    <Filters metrics={binder.metrics} />
                  ) : (
                    <MetricGrid entries={g.entries} quiet={g.secondary} />
                  )}
                </section>
              ))}
            </>
          )}
        </div>
      )}
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

/** Export endpoints sit beside the JSON ones and take the same query params. */
function exportUrl(runId: number, file: string, query: string): string {
  return `/api/runs/${runId}/${file}?${query}`;
}

export default function BindersTable({
  runId,
  epitope = [],
  masked = [],
}: {
  runId: number;
  epitope?: [number, number][];
  masked?: [number, number][];
}) {
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

  // Page and page_size are deliberately absent: an export is the whole
  // selection, not the slice on screen.
  const exportQuery = new URLSearchParams({
    sort: sortKey,
    sort_dir: sortDir,
    status: statusFilter,
  }).toString();

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
        {/* The export carries the status filter and the sort currently applied,
            because the server builds both from the same queryset the table was
            paged from -- a download that came back in a different order than
            the screen it was clicked from would be a bug. */}
        <ExportMenu
          disabled={total === 0}
          items={[
            {
              href: exportUrl(runId, "binders.csv", exportQuery),
              label: "CSV",
              hint: `${total.toLocaleString()} rows · scoring columns`,
            },
            {
              href: exportUrl(runId, "binders.csv", `${exportQuery}&metrics=full`),
              label: "CSV with all metrics",
              hint: "adds the full pipeline metric set",
            },
            {
              href: exportUrl(runId, "binders.fasta", exportQuery),
              label: "FASTA",
              hint: "sequences, scores in the defline",
            },
            {
              href: exportUrl(runId, "binders.fasta", `${exportQuery}&limit=100`),
              label: "FASTA · top 100",
              hint: "leading 100 in the current sort",
            },
            {
              href: `/api/runs/${runId}/meta.json`,
              label: "meta.json",
              hint: "provenance: container, config, hardware",
            },
          ]}
        />
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
          onClose={() => setSelectedBinder(null)}
          epitope={epitope}
          masked={masked}
        />
      )}
    </>
  );
}
