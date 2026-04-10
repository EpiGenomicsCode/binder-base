import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { getProteins } from "../api/client";
import type { Protein } from "../types";
import ProteinSearchBar from "../components/ProteinSearchBar";

function matches(p: Protein, q: string): boolean {
  const lq = q.toLowerCase();
  return (
    (p.uniprot_id ?? "").toLowerCase().includes(lq) ||
    (p.gene_name ?? "").toLowerCase().includes(lq) ||
    (p.protein_name ?? "").toLowerCase().includes(lq) ||
    (p.organism ?? "").toLowerCase().includes(lq)
  );
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

  useEffect(() => {
    getProteins()
      .then(setProteins)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  function handleQueryChange(q: string) {
    setQuery(q);
    if (q.trim()) {
      setSearchParams({ q: q.trim() }, { replace: true });
    } else {
      setSearchParams({}, { replace: true });
    }
  }

  function toggleOrganism(org: string) {
    setSelectedOrganisms((prev) => {
      const next = new Set(prev);
      next.has(org) ? next.delete(org) : next.add(org);
      return next;
    });
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
    return proteins.filter((p) => {
      if (query.trim() && !matches(p, query.trim())) return false;
      if (selectedOrganisms.size > 0 && !selectedOrganisms.has(p.organism ?? "Unknown")) return false;
      if (min !== null && (p.length ?? 0) < min) return false;
      if (max !== null && (p.length ?? 0) > max) return false;
      return true;
    });
  }, [proteins, query, selectedOrganisms, minLength, maxLength]);

  const hasFilters = selectedOrganisms.size > 0 || minLength !== "" || maxLength !== "";

  function clearFilters() {
    setSelectedOrganisms(new Set());
    setMinLength("");
    setMaxLength("");
  }

  return (
    <div>
      <div className="list-header">
        <Link to="/" className="back-link-inline">← Home</Link>
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
                onChange={(e) => setMinLength(e.target.value)}
              />
              <span className="filter-range-sep">–</span>
              <input
                className="filter-range-input"
                type="number"
                placeholder="Max"
                value={maxLength}
                min={0}
                onChange={(e) => setMaxLength(e.target.value)}
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
                    <th>UniProt ID</th>
                    <th>Gene</th>
                    <th>Protein Name</th>
                    <th>Organism</th>
                    <th>Length (aa)</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p) => (
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}
