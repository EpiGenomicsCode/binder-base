import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getRunSummary } from "../api/client";
import type { BinderRun, RunSummary } from "../types";
import { RunVerdictLine } from "./RunVerdict";
import { runLabel } from "./RunConfig";

/** `metadata` is typed `unknown`; narrow once here rather than inline in JSX. */
function epitopeOf(run: BinderRun): string | null {
  const m: unknown = run.metadata;
  if (m === null || typeof m !== "object" || Array.isArray(m)) return null;
  const v = (m as Record<string, unknown>)["Hotspot residues"];
  return v == null || v === "" ? null : String(v);
}

/**
 * One run, as it appears on the protein page: enough to decide whether to open
 * it, and a link to the run page for everything else.
 *
 * The verdict needs an aggregate the protein payload does not carry, so each
 * card fetches its own summary. That is one request per run, which is fine at
 * the scale this sees -- the pilot produces a single run per protein -- and the
 * card renders immediately without it, so a slow or failed summary costs the
 * verdict line and nothing else.
 */
export default function RunCard({ run }: { run: BinderRun }) {
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    getRunSummary(run.id, undefined, ac.signal)
      .then(setSummary)
      .catch(() => {
        if (!ac.signal.aborted) setFailed(true);
      });
    return () => ac.abort();
  }, [run.id]);

  return (
    <Link to={`/runs/${run.id}`} className="run-card">
      <div className="run-card-main">
        <div className="run-card-title">{runLabel(run)}</div>
        <div className="run-card-sub">
          {summary ? (
            <RunVerdictLine summary={summary} />
          ) : failed ? (
            <span className="run-card-muted">summary unavailable</span>
          ) : (
            <span className="run-card-muted">loading…</span>
          )}
          {epitopeOf(run) && (
            <>
              <span className="verdict-sep">·</span>
              <span className="run-card-muted">epitope {epitopeOf(run)}</span>
            </>
          )}
        </div>
      </div>
      <div className="run-card-right">
        <span className="run-card-count">{run.binder_count.toLocaleString()}</span>
        <span className="run-card-count-label">designs</span>
      </div>
    </Link>
  );
}
