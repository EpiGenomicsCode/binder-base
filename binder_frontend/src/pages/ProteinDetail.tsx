import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getProtein } from "../api/client";
import type { ProteinDetail } from "../types";

export default function ProteinDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [protein, setProtein] = useState<ProteinDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    getProtein(Number(id))
      .then(setProtein)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <p className="status">Loading...</p>;
  if (error === "404") return <p className="status error">Protein not found.</p>;
  if (error) return <p className="status error">Failed to load protein: {error}</p>;
  if (!protein) return null;

  return (
    <div>
      <p><Link to="/">← All Proteins</Link></p>

      <h1>{protein.uniprot_id ?? `Protein #${protein.id}`}</h1>

      <section className="detail-card">
        <dl>
          <dt>Gene</dt><dd>{protein.gene_name ?? "—"}</dd>
          <dt>Protein Name</dt><dd>{protein.protein_name ?? "—"}</dd>
          <dt>Organism</dt><dd>{protein.organism ?? "—"}</dd>
          <dt>Length</dt><dd>{protein.length != null ? `${protein.length} aa` : "—"}</dd>
          <dt>Sequence</dt><dd className="sequence">{protein.sequence}</dd>
        </dl>
      </section>

      <h2>Binder Runs ({protein.runs.length})</h2>

      {protein.runs.length === 0 ? (
        <p className="status">No binder runs yet.</p>
      ) : (
        protein.runs.map((run) => (
          <section key={run.id} className="run-card">
            <h3>
              Run #{run.id}
              {run.algorithm_version && ` — ${run.algorithm_version}`}
            </h3>
            <dl>
              <dt>Date</dt><dd>{new Date(run.run_datetime).toLocaleString()}</dd>
              {run.hardware && <><dt>Hardware</dt><dd>{run.hardware}</dd></>}
              {run.description && <><dt>Description</dt><dd>{run.description}</dd></>}
              {run.notes && <><dt>Notes</dt><dd>{run.notes}</dd></>}
            </dl>

            <h4>Binders ({run.binders.length})</h4>
            {run.binders.length === 0 ? (
              <p className="status">No binders.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Length (aa)</th>
                    <th>Status</th>
                    <th>Sequence</th>
                    <th>Failure Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {run.binders.map((b) => (
                    <tr key={b.id}>
                      <td>{b.id}</td>
                      <td>{b.binder_length ?? "—"}</td>
                      <td>{b.status ?? "—"}</td>
                      <td className="sequence">{b.binder_sequence}</td>
                      <td>{b.failure_reason ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))
      )}
    </div>
  );
}
