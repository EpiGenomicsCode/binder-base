import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { getProteins } from "../api/client";
import type { Protein } from "../types";
import ProteinSearchBar from "../components/ProteinSearchBar";
import usePageMeta, { count } from "../utils/pageMeta";

type SortKey =
  | "uniprot" | "name" | "gene" | "organism" | "length"
  | "runs" | "designs" | "placement" | "best_placement";
type SortDir = "asc" | "desc";

/** Matches the runs leaderboard, so a target reads the same on both pages. */
function toneFor(rate: number): string {
  if (rate >= 0.05) return "v-good";
  if (rate > 0) return "v-some";
  return "v-none";
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/** Nulls last in both directions, so empty columns never lead the table. */
function cmpNum(a: number | null, b: number | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
}

const PAGE_SIZES = [20, 50, 100] as const;
type PageSize = typeof PAGE_SIZES[number];

function matches(p: Protein, q: string): boolean {
  const lq = q.toLowerCase();
  return (
    (p.uniprot_id ?? "").toLowerCase().includes(lq) ||
    (p.gene_name ?? "").toLowerCase().includes(lq) ||
    (p.protein_name ?? "").toLowerCase().includes(lq) ||
    (p.organism ?? "").toLowerCase().includes(lq)
  );
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <span className="sort-icon inactive">↕</span>;
  return <span className="sort-icon active">{dir === "asc" ? "↑" : "↓"}</span>;
}

export default function ProteinList() {
  const [proteins, setProteins] = useState<Protein[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const [selectedOrganisms, setSelectedOrganisms] = useState<Set<string>>(new Set());
  const [minLength, setMinLength] = useState("");
  const [maxLength, setMaxLength] = useState("");
  const [minRuns, setMinRuns] = useState("");
  const [onlyProductive, setOnlyProductive] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("uniprot");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(20);

  useEffect(() => {
    getProteins()
      .then(setProteins)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Sync the search box when the ?q= param changes externally (e.g. navbar search
  // while already on this page). Keep the user's raw text if it only differs by
  // surrounding whitespace, so typing isn't disrupted.
  const qParam = searchParams.get("q") ?? "";
  useEffect(() => {
    setQuery((prev) => (prev.trim() === qParam ? prev : qParam));
  }, [qParam]);

  function handleQueryChange(q: string) {
    setQuery(q);
    setPage(1);
    if (q.trim()) {
      setSearchParams({ q: q.trim() }, { replace: true });
    } else {
      setSearchParams({}, { replace: true });
    }
  }

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
    setPage(1);
  }

  function toggleOrganism(org: string) {
    setSelectedOrganisms((prev: Set<string>) => {
      const next = new Set(prev);
      next.has(org) ? next.delete(org) : next.add(org);
      return next;
    });
    setPage(1);
  }

  const organisms = useMemo(
    () => Array.from(new Set(proteins.map((p) => p.organism ?? "Unknown"))).sort(),
    [proteins]
  );

  const lengthRange = useMemo(() => {
    if (proteins.length === 0) return { min: 0, max: 0 };
    const lengths = proteins.map((p) => p.length ?? 0);
    return { min: Math.min(...lengths), max: Math.max(...lengths) };
  }, [proteins]);

  const filtered = useMemo(() => {
    const min = minLength !== "" ? Number(minLength) : null;
    const max = maxLength !== "" ? Number(maxLength) : null;
    const runsMin = minRuns !== "" ? Number(minRuns) : null;
    const results = proteins.filter((p) => {
      if (query.trim() && !matches(p, query.trim())) return false;
      if (selectedOrganisms.size > 0 && !selectedOrganisms.has(p.organism ?? "Unknown")) return false;
      if (min !== null && (p.length ?? 0) < min) return false;
      if (max !== null && (p.length ?? 0) > max) return false;
      if (runsMin !== null && p.run_count < runsMin) return false;
      // The question the page exists to answer: did anything bind here.
      if (onlyProductive && p.placement_hits === 0) return false;
      return true;
    });

    return [...results].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "length") {
        cmp = (a.length ?? 0) - (b.length ?? 0);
      } else if (sortKey === "runs") {
        cmp = a.run_count - b.run_count;
      } else if (sortKey === "designs") {
        cmp = a.designs - b.designs;
      } else if (sortKey === "placement") {
        cmp = a.placement_rate - b.placement_rate;
      } else if (sortKey === "best_placement") {
        cmp = cmpNum(a.best_placement, b.best_placement);
      } else if (sortKey === "gene") {
        cmp = (a.gene_name ?? "").toLowerCase().localeCompare((b.gene_name ?? "").toLowerCase());
      } else if (sortKey === "organism") {
        cmp = (a.organism ?? "").toLowerCase().localeCompare((b.organism ?? "").toLowerCase());
      } else if (sortKey === "uniprot") {
        cmp = (a.uniprot_id ?? "").toLowerCase().localeCompare((b.uniprot_id ?? "").toLowerCase());
      } else {
        const nameA = (a.protein_name ?? a.uniprot_id ?? "").toLowerCase();
        const nameB = (b.protein_name ?? b.uniprot_id ?? "").toLowerCase();
        cmp = nameA.localeCompare(nameB);
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [proteins, query, selectedOrganisms, minLength, maxLength, minRuns,
      onlyProductive, sortKey, sortDir]);

  const hasFilters = selectedOrganisms.size > 0 || minLength !== "" ||
    maxLength !== "" || minRuns !== "" || onlyProductive;

  // The search term is in the title so a tab full of searches stays legible,
  // but not in the canonical: every permutation of ?q= is this one page.
  const trimmedQuery = query.trim();
  usePageMeta({
    title: trimmedQuery ? `"${trimmedQuery}" — target search` : "Targets",
    description: trimmedQuery
      ? `${count(filtered.length)} target protein${filtered.length === 1 ? "" : "s"} ` +
        `matching "${trimmedQuery}" in Binder Base.`
      : `Browse ${count(proteins.length)} target proteins with de novo binder ` +
        `design runs, ranked by how many designs placed on the epitope.`,
    canonicalPath: "/proteins",
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visible = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  function clearFilters() {
    setSelectedOrganisms(new Set());
    setMinLength("");
    setMaxLength("");
    setMinRuns("");
    setOnlyProductive(false);
    setPage(1);
  }

  return (
    <div>
      <div className="list-header">
        {/* "Targets" throughout, matching the nav: these are the proteins
            binders are designed against, and the word distinguishes the page
            from /runs without needing a paragraph to explain it. */}
        <h2 className="list-title">Targets</h2>
        <ProteinSearchBar value={query} onChange={handleQueryChange} compact />
      </div>
      <p className="list-subtitle">
        One row per target protein, with every run against it rolled up. For
        the runs themselves — method, epitope and per-run rates — see{" "}
        <Link to="/runs">Design Runs</Link>.
      </p>

      <div className="list-body row g-4">
        {/* ── Sidebar ── */}
        <aside className="filter-sidebar col-12 col-lg-3">
          <div className="filter-sidebar-header">
            <span className="filter-sidebar-title">Filters</span>
            {hasFilters && (
              <button className="filter-clear-btn" onClick={clearFilters}>Clear</button>
            )}
          </div>

          {/* A filter offering one choice filters nothing -- every protein in
              the database is Homo sapiens today -- so it is shown only once
              there is something to choose between. The organism is still
              searchable and still on the detail page. */}
          {organisms.length > 1 && (
            <div className="filter-section">
              <div className="filter-section-label">Organism</div>
              {organisms.map((org) => (
                <label key={org} className="filter-checkbox-row">
                  <input
                    type="checkbox"
                    checked={selectedOrganisms.has(org)}
                    onChange={() => toggleOrganism(org)}
                  />
                  <span className="filter-checkbox-label">{org}</span>
                </label>
              ))}
            </div>
          )}

          {/* Results filters first: "which targets worked" is the question
              people come with, and protein length is not it. */}
          <div className="filter-section">
            <div className="filter-section-label">Results</div>
            <label className="filter-checkbox-row">
              <input
                type="checkbox"
                checked={onlyProductive}
                onChange={(e) => { setOnlyProductive(e.target.checked); setPage(1); }}
              />
              <span className="filter-checkbox-label">
                Has a placed design
              </span>
            </label>
            <div className="filter-range-row filter-runs-row">
              <span className="filter-range-sep">Runs &ge;</span>
              <input
                className="filter-range-input"
                type="number"
                placeholder="0"
                value={minRuns}
                min={0}
                onChange={(e) => { setMinRuns(e.target.value); setPage(1); }}
              />
            </div>
          </div>

          <div className="filter-section">
            <div className="filter-section-label">Length (aa)</div>
            {lengthRange.min !== lengthRange.max && (
              <p className="filter-range-hint">{lengthRange.min} – {lengthRange.max}</p>
            )}
            <div className="filter-range-row">
              <input
                className="filter-range-input"
                type="number"
                placeholder="Min"
                value={minLength}
                min={0}
                onChange={(e) => { setMinLength(e.target.value); setPage(1); }}
              />
              <span className="filter-range-sep">–</span>
              <input
                className="filter-range-input"
                type="number"
                placeholder="Max"
                value={maxLength}
                min={0}
                onChange={(e) => { setMaxLength(e.target.value); setPage(1); }}
              />
            </div>
          </div>
        </aside>

        {/* ── Results ── */}
        <div className="list-results col-12 col-lg-9">
          {loading ? (
            <p className="status">Loading…</p>
          ) : error ? (
            <p className="status error">Failed to load proteins: {error}</p>
          ) : filtered.length === 0 ? (
            <p className="status">No proteins found.</p>
          ) : (
            <>
              {(query || hasFilters) && (
                <p className="search-result-count">
                  {filtered.length} result{filtered.length !== 1 ? "s" : ""}
                  {query ? <> for &ldquo;{query}&rdquo;</> : ""}
                </p>
              )}
              <table>
                <thead>
                  <tr>
                    <th className="th-sortable" onClick={() => handleSort("uniprot")}>
                      UniProt ID <SortIcon active={sortKey === "uniprot"} dir={sortDir} />
                    </th>
                    <th className="th-sortable" onClick={() => handleSort("gene")}>
                      Gene <SortIcon active={sortKey === "gene"} dir={sortDir} />
                    </th>
                    <th className="th-sortable" onClick={() => handleSort("name")}>
                      Protein Name <SortIcon active={sortKey === "name"} dir={sortDir} />
                    </th>
                    {organisms.length > 1 && (
                      <th className="th-sortable" onClick={() => handleSort("organism")}>
                        Organism <SortIcon active={sortKey === "organism"} dir={sortDir} />
                      </th>
                    )}
                    <th className="th-sortable" onClick={() => handleSort("length")}>
                      Length (aa) <SortIcon active={sortKey === "length"} dir={sortDir} />
                    </th>
                    <th className="th-sortable th-num" onClick={() => handleSort("runs")}
                        title="Design runs against this target">
                      Runs <SortIcon active={sortKey === "runs"} dir={sortDir} />
                    </th>
                    <th className="th-sortable th-num" onClick={() => handleSort("designs")}
                        title="Designs produced across every run">
                      Designs <SortIcon active={sortKey === "designs"} dir={sortDir} />
                    </th>
                    <th className="th-sortable th-num" onClick={() => handleSort("placement")}
                        title="Designs that refolded onto the epitope, pooled across runs">
                      Placed <SortIcon active={sortKey === "placement"} dir={sortDir} />
                    </th>
                    <th className="th-sortable th-num" onClick={() => handleSort("best_placement")}
                        title="Closest placement achieved on this target; lower is better">
                      Best RMSD <SortIcon active={sortKey === "best_placement"} dir={sortDir} />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((p) => (
                    <tr key={p.id}>
                      <td><Link to={`/proteins/${p.id}`}>{p.uniprot_id ?? "—"}</Link></td>
                      <td>{p.gene_name ?? "—"}</td>
                      <td>{p.protein_name ?? "—"}</td>
                      {organisms.length > 1 && <td>{p.organism ?? "—"}</td>}
                      <td>{p.length ?? "—"}</td>
                      <td className="td-num">
                        {p.run_count > 0
                          ? <Link to={`/runs?q=${encodeURIComponent(p.uniprot_id ?? "")}`}>
                              {p.run_count}
                            </Link>
                          : "—"}
                      </td>
                      <td className="td-num">
                        {p.designs > 0 ? p.designs.toLocaleString() : "—"}
                      </td>
                      <td className="td-num">
                        {p.designs > 0 ? (
                          <>
                            <span className={toneFor(p.placement_rate)}>
                              {pct(p.placement_rate)}
                            </span>
                            <span className="runs-sub">
                              {p.placement_hits.toLocaleString()}
                            </span>
                          </>
                        ) : "—"}
                      </td>
                      <td className="td-num">
                        {p.best_placement != null
                          ? p.best_placement.toFixed(2)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

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
      </div>
    </div>
  );
}
