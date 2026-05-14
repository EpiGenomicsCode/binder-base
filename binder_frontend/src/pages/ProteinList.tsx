import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { getProteins } from "../api/client";
import type { Protein } from "../types";
import ProteinSearchBar from "../components/ProteinSearchBar";

type SortKey = "uniprot" | "name" | "gene" | "organism" | "length";
type SortDir = "asc" | "desc";

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
    const results = proteins.filter((p) => {
      if (query.trim() && !matches(p, query.trim())) return false;
      if (selectedOrganisms.size > 0 && !selectedOrganisms.has(p.organism ?? "Unknown")) return false;
      if (min !== null && (p.length ?? 0) < min) return false;
      if (max !== null && (p.length ?? 0) > max) return false;
      return true;
    });

    return [...results].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "length") {
        cmp = (a.length ?? 0) - (b.length ?? 0);
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
  }, [proteins, query, selectedOrganisms, minLength, maxLength, sortKey, sortDir]);

  const hasFilters = selectedOrganisms.size > 0 || minLength !== "" || maxLength !== "";

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visible = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  function clearFilters() {
    setSelectedOrganisms(new Set());
    setMinLength("");
    setMaxLength("");
    setPage(1);
  }

  return (
    <div>
      <div className="list-header">
        <h2 className="list-title">All Proteins</h2>
        <ProteinSearchBar value={query} onChange={handleQueryChange} compact />
      </div>

      <div className="list-body">
        {/* ── Sidebar ── */}
        <aside className="filter-sidebar">
          <div className="filter-sidebar-header">
            <span className="filter-sidebar-title">Filters</span>
            {hasFilters && (
              <button className="filter-clear-btn" onClick={clearFilters}>Clear</button>
            )}
          </div>

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
        <div className="list-results">
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
                    <th className="th-sortable" onClick={() => handleSort("organism")}>
                      Organism <SortIcon active={sortKey === "organism"} dir={sortDir} />
                    </th>
                    <th className="th-sortable" onClick={() => handleSort("length")}>
                      Length (aa) <SortIcon active={sortKey === "length"} dir={sortDir} />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((p) => (
                    <tr key={p.id}>
                      <td><Link to={`/proteins/${p.id}`}>{p.uniprot_id ?? "—"}</Link></td>
                      <td>{p.gene_name ?? "—"}</td>
                      <td>{p.protein_name ?? "—"}</td>
                      <td>{p.organism ?? "—"}</td>
                      <td>{p.length ?? "—"}</td>
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
