import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getProteins } from "../api/client";
import type { Protein } from "../types";

const EXAMPLES = ["Q9H9E1", "ANKRA2", "Homo sapiens", "Ankyrin"];

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
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getProteins()
      .then(setProteins)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(
    () => (query.trim() ? proteins.filter((p) => matches(p, query.trim())) : proteins),
    [proteins, query]
  );

  return (
    <div>
      {/* ── Hero search ── */}
      <div className="hero">
        <h1 className="hero-title">Protein Binder Design Database</h1>
        <p className="hero-sub">
          Search proteins by UniProt ID, gene name, organism, or protein name.
        </p>
        <div className="hero-search-wrap">
          <input
            ref={inputRef}
            className="hero-search-input"
            type="search"
            placeholder="Search proteins…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        <div className="hero-examples">
          <span className="hero-examples-label">Try:</span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              className="hero-example-chip"
              onClick={() => {
                setQuery(ex);
                inputRef.current?.focus();
              }}
            >
              {ex}
            </button>
          ))}
        </div>
      </div>

      {/* ── Results ── */}
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
                  <td>
                    <Link to={`/proteins/${p.id}`}>{p.uniprot_id ?? "—"}</Link>
                  </td>
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
