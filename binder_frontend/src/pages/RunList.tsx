import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { getRuns } from "../api/client";
import ExportMenu from "../components/ExportMenu";
import usePageMeta, { count as fmtCount } from "../utils/pageMeta";
import type { RunIndex, RunListRow } from "../types";

/**
 * Every run, side by side.
 *
 * Runs previously had no index at all: `/runs/:id` existed but nothing listed
 * them, so the only route to a run was through the protein it targeted. That
 * is workable for one run and useless for a hundred, which is what a campaign
 * produces -- and comparing runs is the question a campaign is run to answer.
 *
 * Sorted by placement rate rather than by date, because the page is a
 * leaderboard first and a log second. Rate rather than count so that runs with
 * different design budgets stay comparable; the count is shown beside it so a
 * 1/2 run cannot masquerade as a good one.
 *
 * Sorting and paging are client-side on purpose. The endpoint is unpaged (its
 * aggregate visits every binder regardless of the slice returned), so the rows
 * are already here and a round-trip per column click would buy nothing.
 */

type SortKey =
  | "gene" | "uniprot" | "epitope" | "designs" | "placement"
  | "monomer" | "pass" | "iptm" | "best_placement" | "date";
type SortDir = "asc" | "desc";

const PAGE_SIZES = [25, 50, 100] as const;
type PageSize = typeof PAGE_SIZES[number];

/** Matches RunVerdict's bands, so a run reads the same colour on both pages. */
function toneFor(rate: number): string {
  if (rate >= 0.05) return "v-good";
  if (rate > 0) return "v-some";
  return "v-none";
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function num(v: number | null, digits = 3): string {
  return v == null ? "—" : v.toFixed(digits);
}

/** Nulls last in both directions, so blank columns never lead the table. */
function cmpNum(a: number | null, b: number | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
}

function cmpStr(a: string | null, b: string | null): number {
  return (a ?? "").toLowerCase().localeCompare((b ?? "").toLowerCase());
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <span className="sort-icon inactive">↕</span>;
  return <span className="sort-icon active">{dir === "asc" ? "↑" : "↓"}</span>;
}

interface Column {
  key: SortKey;
  label: string;
  numeric: boolean;
  /** Descending first for rates and scores: the interesting end is the top. */
  descFirst: boolean;
}

const COLUMNS: Column[] = [
  { key: "gene", label: "Gene", numeric: false, descFirst: false },
  { key: "uniprot", label: "UniProt", numeric: false, descFirst: false },
  { key: "epitope", label: "Epitope", numeric: false, descFirst: false },
  { key: "designs", label: "Designs", numeric: true, descFirst: true },
  { key: "placement", label: "Placed", numeric: true, descFirst: true },
  { key: "monomer", label: "Monomer", numeric: true, descFirst: true },
  { key: "pass", label: "Passed", numeric: true, descFirst: true },
  { key: "iptm", label: "Best ipTM", numeric: true, descFirst: true },
  { key: "best_placement", label: "Best RMSD", numeric: true, descFirst: false },
  { key: "date", label: "Run date", numeric: false, descFirst: true },
];

function compare(a: RunListRow, b: RunListRow, key: SortKey): number {
  switch (key) {
    case "gene": return cmpStr(a.gene_name, b.gene_name);
    case "uniprot": return cmpStr(a.uniprot_id, b.uniprot_id);
    case "epitope": return cmpNum(a.epitope_residues, b.epitope_residues);
    case "designs": return a.designs - b.designs;
    case "placement": return a.placement_rate - b.placement_rate;
    case "monomer": return a.monomer_rate - b.monomer_rate;
    case "pass": return a.pass_rate - b.pass_rate;
    case "iptm": return cmpNum(a.best_iptm, b.best_iptm);
    case "best_placement": return cmpNum(a.best_placement, b.best_placement);
    case "date":
      return cmpNum(
        a.run_datetime ? Date.parse(a.run_datetime) : null,
        b.run_datetime ? Date.parse(b.run_datetime) : null
      );
  }
}

function matches(r: RunListRow, q: string): boolean {
  const lq = q.toLowerCase();
  return (
    (r.gene_name ?? "").toLowerCase().includes(lq) ||
    (r.uniprot_id ?? "").toLowerCase().includes(lq) ||
    (r.epitope ?? "").toLowerCase().includes(lq) ||
    (r.algorithm ?? "").toLowerCase().includes(lq)
  );
}

export default function RunList() {
  const [data, setData] = useState<RunIndex | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const [onlyProductive, setOnlyProductive] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("placement");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(25);

  useEffect(() => {
    const ac = new AbortController();
    getRuns(undefined, ac.signal)
      .then((d) => { setData(d); setLoading(false); })
      .catch((e: Error) => {
        if (ac.signal.aborted) return;
        setError(e.message);
        setLoading(false);
      });
    return () => ac.abort();
  }, []);

  const qParam = searchParams.get("q") ?? "";
  useEffect(() => {
    setQuery((prev) => (prev.trim() === qParam ? prev : qParam));
  }, [qParam]);

  function handleQueryChange(q: string) {
    setQuery(q);
    setPage(1);
    setSearchParams(q.trim() ? { q: q.trim() } : {}, { replace: true });
  }

  function handleSort(col: Column) {
    if (sortKey === col.key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(col.key);
      setSortDir(col.descFirst ? "desc" : "asc");
    }
    setPage(1);
  }

  const rows = data?.items ?? [];

  const filtered = useMemo(() => {
    const q = query.trim();
    const out = rows.filter((r) => {
      if (q && !matches(r, q)) return false;
      if (onlyProductive && r.placement_hits === 0) return false;
      return true;
    });
    // id as the final tie-break so equal rows -- and with placement rate 0
    // there are many -- hold a stable order between re-sorts.
    return [...out].sort((a, b) => {
      const c = compare(a, b, sortKey);
      if (c !== 0) return sortDir === "asc" ? c : -c;
      return a.id - b.id;
    });
  }, [rows, query, onlyProductive, sortKey, sortDir]);

  // Campaign-level totals, over what is currently filtered: the one place the
  // whole campaign is summarised rather than one run at a time. Pooled, not a
  // mean of per-run rates, so a run with 10 designs does not weigh the same as
  // one with 1000.
  const totals = useMemo(() => {
    const designs = filtered.reduce((s, r) => s + r.designs, 0);
    const placed = filtered.reduce((s, r) => s + r.placement_hits, 0);
    const productive = filtered.filter((r) => r.placement_hits > 0).length;
    return { designs, placed, productive };
  }, [filtered]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visible = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  // Above the early returns, and canonicalised without ?q= for the same reason
  // the protein list is.
  usePageMeta({
    title: "Design runs",
    description:
      `All ${fmtCount(rows.length)} de novo binder design runs in Binder Base, ` +
      `ranked by the fraction of designs that placed on the target epitope.`,
    canonicalPath: "/runs",
  });

  if (loading) return <p className="status">Loading runs…</p>;
  if (error) return <p className="status error">Failed to load runs: {error}</p>;
  if (rows.length === 0) {
    return (
      <div className="status">
        No runs have been imported yet.
        <div><Link to="/proteins">Browse proteins</Link></div>
      </div>
    );
  }

  return (
    <div className="runs-page">
      <div className="list-header">
        <h2 className="list-title">Design Runs</h2>
        <form className="run-search-form" onSubmit={(e) => e.preventDefault()}>
          <input
            className="navbar-search-input"
            type="search"
            placeholder="Filter by gene, UniProt, epitope…"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
          />
        </form>
      </div>

      <div className="runs-totals">
        <div className="runs-total-item">
          <span className="runs-total-value">{filtered.length.toLocaleString()}</span>
          <span className="runs-total-label">runs</span>
        </div>
        <div className="runs-total-item">
          <span className="runs-total-value">{totals.designs.toLocaleString()}</span>
          <span className="runs-total-label">designs</span>
        </div>
        <div className="runs-total-item">
          <span className={`runs-total-value ${toneFor(totals.designs ? totals.placed / totals.designs : 0)}`}>
            {totals.placed.toLocaleString()}
          </span>
          <span className="runs-total-label">
            placed &lt; {data?.placement_threshold ?? 2} Å
            {totals.designs > 0 && ` · ${pct(totals.placed / totals.designs)}`}
          </span>
        </div>
        <div className="runs-total-item">
          <span className={`runs-total-value ${toneFor(filtered.length ? totals.productive / filtered.length : 0)}`}>
            {totals.productive.toLocaleString()}
          </span>
          {/* The number that decides whether a campaign worked: not how many
              designs placed, but how many targets produced any that did. */}
          <span className="runs-total-label">targets with a hit</span>
        </div>
      </div>

      <div className="runs-filter-bar">
        <label className="runs-toggle">
          <input
            type="checkbox"
            checked={onlyProductive}
            onChange={(e) => { setOnlyProductive(e.target.checked); setPage(1); }}
          />
          <span>Only runs with at least one placed design</span>
        </label>
        {(query || onlyProductive) && (
          <span className="runs-filter-count">
            {filtered.length} of {rows.length} runs
          </span>
        )}
        {/* Every run, not the filtered view: the filters here are client-side
            and the endpoint has no way to be told about them, so offering a
            "filtered" download would quietly return something else. */}
        <ExportMenu
          label="Export all"
          items={[{
            href: "/api/runs.csv",
            label: "CSV",
            hint: `all ${rows.length.toLocaleString()} runs, one row each`,
          }]}
        />
      </div>

      {filtered.length === 0 ? (
        <p className="status">No runs match this filter.</p>
      ) : (
        <>
          <div className="binder-table-wrap">
            <table className="runs-table">
              <thead>
                <tr>
                  {COLUMNS.map((col) => {
                    const active = sortKey === col.key;
                    return (
                      <th
                        key={col.key}
                        className={`th-sortable${col.numeric ? " th-num" : ""}`}
                        aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                      >
                        {/* A button rather than onClick on the th: the header
                            is a control, and only a focusable element puts it
                            on the keyboard path. */}
                        <button
                          type="button"
                          className="th-sort-btn"
                          onClick={() => handleSort(col)}
                        >
                          {col.label} <SortIcon active={active} dir={sortDir} />
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/runs/${r.id}`} className="runs-gene-link">
                        {r.gene_name ?? r.uniprot_id ?? `Run #${r.id}`}
                      </Link>
                    </td>
                    <td>
                      <Link to={`/proteins/${r.protein_id}`} className="runs-uniprot">
                        {r.uniprot_id ?? "—"}
                      </Link>
                    </td>
                    {/* A patch is often many segments -- "142,145..146,148..154,
                        159..161" is a real value -- so the range is clamped to
                        one line with the full string on hover, and the residue
                        count underneath carries the size at a glance. */}
                    <td className="runs-epitope" title={r.epitope ?? undefined}>
                      <span className="runs-epitope-range">{r.epitope ?? "—"}</span>
                      {r.epitope_residues != null && (
                        <span className="runs-epitope-n">{r.epitope_residues} aa</span>
                      )}
                    </td>
                    <td className="td-num">{r.designs.toLocaleString()}</td>
                    <td className="td-num">
                      <span className={toneFor(r.placement_rate)}>{pct(r.placement_rate)}</span>
                      <span className="runs-sub">{r.placement_hits.toLocaleString()}</span>
                    </td>
                    <td className="td-num">
                      <span className={toneFor(r.monomer_rate)}>{pct(r.monomer_rate)}</span>
                      <span className="runs-sub">{r.monomer_consistent.toLocaleString()}</span>
                    </td>
                    <td className="td-num">
                      <span className={toneFor(r.pass_rate)}>{pct(r.pass_rate)}</span>
                      <span className="runs-sub">{r.passed_filters.toLocaleString()}</span>
                    </td>
                    <td className="td-num">{num(r.best_iptm)}</td>
                    <td className="td-num">{num(r.best_placement, 2)}</td>
                    <td className="runs-date">
                      {r.run_datetime
                        ? new Date(r.run_datetime).toLocaleDateString()
                        : "—"}
                    </td>
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
                  onClick={() => setPage((p) => p - 1)}
                  disabled={safePage === 1}
                >
                  ← Prev
                </button>
                <span className="binder-page-info">
                  Page {safePage} of {totalPages}
                </span>
                <button
                  className="binder-page-btn"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={safePage === totalPages}
                >
                  Next →
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
