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

  const filtered = useMemo(
    () => (query.trim() ? proteins.filter((p) => matches(p, query.trim())) : proteins),
    [proteins, query]
  );

  return (
    <div>
      <div className="list-header">
        <Link to="/" className="back-link-inline">← Home</Link>
        <h2 className="list-title">All Proteins</h2>
        <ProteinSearchBar value={query} onChange={handleQueryChange} compact />
      </div>

      {loading ? (
        <p className="status">Loading…</p>
      ) : error ? (
        <p className="status error">Failed to load proteins: {error}</p>
      ) : filtered.length === 0 ? (
        <p className="status">No proteins found{query ? ` for "${query}"` : ""}.</p>
      ) : (
        <>
          {query && (
            <p className="search-result-count">
              {filtered.length} result{filtered.length !== 1 ? "s" : ""} for &ldquo;{query}&rdquo;
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
  );
}
