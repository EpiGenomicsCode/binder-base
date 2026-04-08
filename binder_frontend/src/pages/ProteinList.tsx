import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getProteins } from "../api/client";
import type { Protein } from "../types";

export default function ProteinList() {
  const [proteins, setProteins] = useState<Protein[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getProteins()
      .then(setProteins)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="status">Loading...</p>;
  if (error) return <p className="status error">Failed to load proteins: {error}</p>;

  return (
    <div>
      <h1>Proteins</h1>
      {proteins.length === 0 ? (
        <p className="status">No proteins found.</p>
      ) : (
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
            {proteins.map((p) => (
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
      )}
    </div>
  );
}
