import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { getProtein, getRunBinder, getRunSummary } from "../api/client";
import type { Binder, BinderRun, ProteinDetail, RunSummary } from "../types";
import BindersTable, { BinderModal } from "../components/BindersTable";
import RunTargetStructure from "../components/RunTargetStructure";
import RunVerdict from "../components/RunVerdict";
import { EnrichmentChart, HistogramChart } from "../components/RunCharts";
import { RunMetadata, RunStepsList, configSummary } from "../components/RunConfig";
import usePageMeta, { count, geneWithAccession } from "../utils/pageMeta";
import { buildResidueMap, parseRanges } from "../utils/residueMap";

/**
 * A run's own page.
 *
 * Previously a run existed only as a panel inside ProteinDetail selected by
 * `?run=<id>`, so it had no URL to link or cite -- awkward for a repository
 * whose argument is that the data is findable. The order here is what a reader
 * needs rather than what the pipeline produced: did it work, what was the
 * target, what do the distributions look like, is the filter doing anything,
 * then the designs, then how it was configured.
 */

const HIST_META: Record<string, { title: string; unit?: string; mark?: number }> = {
  design_to_target_iptm: { title: "Design-to-target ipTM" },
  min_interaction_pae: { title: "Min interaction PAE", unit: "Å" },
  bb_target_aligned_rmsd_design: { title: "Placement RMSD", unit: "Å", mark: 2.0 },
  designfolding_bb_rmsd: { title: "Monomer self-consistency RMSD", unit: "Å", mark: 2.0 },
};

// Order the histograms deliberately: the two that decide whether a design is
// real come first.
const HIST_ORDER = [
  "bb_target_aligned_rmsd_design",
  "designfolding_bb_rmsd",
  "design_to_target_iptm",
  "min_interaction_pae",
];

export default function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const runId = Number(id);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const binderParam = searchParams.get("binder");
  const requestedBinderId = Number(binderParam);
  const binderId = Number.isSafeInteger(requestedBinderId) && requestedBinderId > 0
    ? requestedBinderId : null;
  const [selection, setSelection] = useState<{ runId: number; binderId: number; binder: Binder | null } | null>(null);
  const selected = selection?.runId === runId && selection.binderId === binderId ? selection : null;
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [protein, setProtein] = useState<ProteinDetail | null>(null);
  const [run, setRun] = useState<BinderRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!Number.isFinite(runId)) {
      setError("Not a valid run id.");
      setLoading(false);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    setError(null);

    getRunSummary(runId, undefined, ac.signal)
      .then((s) => {
        setSummary(s);
        // The summary carries aggregates, not the run's own fields (cif_path,
        // steps_config, target_sequence), so fetch the parent protein for them.
        return getProtein(s.protein.id, ac.signal).then((p) => {
          setProtein(p);
          setRun(p.runs.find((r) => r.id === runId) ?? null);
        });
      })
      .then(() => setLoading(false))
      .catch((e) => {
        if (ac.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Failed to load run.");
        setLoading(false);
      });

    return () => ac.abort();
  }, [runId]);

  useEffect(() => {
    if (!Number.isFinite(runId) || binderId === null || selected) return;
    const ac = new AbortController();
    getRunBinder(runId, binderId, ac.signal)
      .then((binder) => {
        if (!ac.signal.aborted) setSelection({ runId, binderId, binder });
      })
      .catch(() => {
        if (!ac.signal.aborted) setSelection({ runId, binderId, binder: null });
      });
    return () => ac.abort();
  }, [runId, binderId, selected]);

  /**
   * The `?binder=` entry this page pushed, as "<runId>:<binderId>", or null.
   *
   * Opening a design pushes, so Back closes the modal instead of walking off
   * the run page. Closing then has to unwind that entry rather than push a
   * second one, or Back would land on a URL identical to the one on screen and
   * appear to do nothing.
   *
   * It cannot simply always go back, because a design can also be opened by
   * arriving at `?binder=` directly -- which is the whole point of the hero
   * links. Nothing was pushed in that case, so Back belongs to wherever the
   * visitor came from, and closing has to drop the parameter in place. Holding
   * the id rather than a flag keeps the two apart even if the run changes
   * under the same mounted page.
   */
  const pushedEntryRef = useRef<string | null>(null);

  function selectBinder(binder: Binder | null) {
    if (binder) {
      setSelection({ runId, binderId: binder.id, binder });
      pushedEntryRef.current = `${runId}:${binder.id}`;
      setSearchParams((params) => {
        const next = new URLSearchParams(params);
        next.set("binder", String(binder.id));
        return next;
      });
      return;
    }

    if (pushedEntryRef.current === `${runId}:${binderId}`) {
      pushedEntryRef.current = null;
      // Pops our own entry: the URL loses ?binder, so the modal closes with it.
      navigate(-1);
      return;
    }

    setSelection(null);
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      next.delete("binder");
      return next;
    }, { replace: true });
  }

  // Before the early returns, so the hook count does not change with load state.
  // This is the page most likely to be cited or pasted into a thread, so the
  // description carries the three things that identify a run: what it targeted,
  // where on the target, and whether the designs landed there.
  usePageMeta({
    title: summary
      ? `${geneWithAccession(summary.protein.gene_name, summary.protein.uniprot_id,
                     `Protein #${summary.protein.id}`)} design run #${summary.run_id}`
      : "Design run",
    description: summary
      ? [
          `${count(summary.counts.designs)} de novo binders designed against `,
          geneWithAccession(summary.protein.gene_name, summary.protein.uniprot_id, "target"),
          summary.target.epitope ? ` epitope ${summary.target.epitope}` : "",
          `. ${count(summary.counts.placement_hits)} placed under `,
          `${summary.rates.placement_threshold} Å `,
          `(${(summary.rates.placement * 100).toFixed(1)}%), `,
          `${count(summary.counts.passed_filters)} passed filters.`,
          // "BlitzGen 1.0.0 (BoltzGen design + Blitz K16 folding)" is 51 chars
          // of which the parenthetical is the half a search result would drop
          // anyway. Keeping the version alone holds the whole description
          // inside the ~155 characters Google renders.
          run?.algorithm ? ` ${run.algorithm.split(" (")[0]}.` : "",
        ].join("")
      : null,
  });

  if (loading) return <div className="status">Loading run…</div>;
  if (error || !summary) {
    return (
      <div className="status">
        {error ?? "Run not found."}
        <div><Link to="/proteins">Back to proteins</Link></div>
      </div>
    );
  }

  const { protein: p, target } = summary;
  const geneLabel = p.gene_name || p.uniprot_id;

  return (
    <div className="pd-page run-page">
      <div className="pd-header">
        <div className="pd-breadcrumb">
          <Link to="/proteins">Targets</Link>
          <span className="crumb-sep">/</span>
          <Link to={`/proteins/${p.id}`}>{geneLabel}</Link>
          <span className="crumb-sep">/</span>
          <span>{run?.run_code ?? `Run #${summary.run_id}`}</span>
        </div>
        <h1 className="pd-title">
          {geneLabel} <span className="pd-uniprot">{p.uniprot_id}</span>
          {/* The citable identifier, beside the human-readable subject. The
              heading says what was targeted; this says which run. */}
          {run?.run_code && <span className="pd-run-code">{run.run_code}</span>}
        </h1>
        <div className="run-target-meta">
          {target.epitope && <span>Epitope <strong>{target.epitope}</strong></span>}
          {target.crop_length != null && <span>Crop {target.crop_length} aa</span>}
          {target.structure_source && <span>{target.structure_source}</span>}
          {target.masked_faces && <span>Masked faces {target.masked_faces}</span>}
        </div>
      </div>

      {binderParam !== null && (binderId === null || (selected && !selected.binder)) && (
        <p className="status error" role="status">Could not open this binder in the run.</p>
      )}
      {binderId !== null && !selected && (
        <p className="status" role="status">Loading binder…</p>
      )}

      {/* 1. Did it work */}
      <RunVerdict summary={summary} />

      {summary.best && (
        <div className="run-best">
          <span className="run-best-label">Best by quality score</span>
          <span>rank {summary.best.final_rank ?? "—"}</span>
          <span>ipTM {fmt(summary.best.design_to_target_iptm)}</span>
          <span>iPAE {fmt(summary.best.min_interaction_pae)} Å</span>
          <span>placement {fmt(summary.best.bb_target_aligned_rmsd_design)} Å</span>
          <span>monomer {fmt(summary.best.designfolding_bb_rmsd)} Å</span>
        </div>
      )}

      {/* 2. Target and epitope */}
      {run && (
        <RunTargetStructure
          run={run}
          paeJsonPath={protein?.pae_json_path ?? null}
          epitope={parseRanges(target.epitope)}
          residueMap={buildResidueMap(target.residues, target.residue_offset)}
        />
      )}

      {/* 3. Distributions. A run with one lucky design and a broadly good run
          have the same maximum, so the shape is the point. */}
      <div className="run-section-title">Distributions</div>
      <div className="chart-grid">
        {HIST_ORDER.filter((k) => summary.histograms[k]).map((k) => {
          const m = HIST_META[k] ?? { title: k };
          return (
            <HistogramChart
              key={k}
              title={m.title}
              unit={m.unit}
              hist={summary.histograms[k]}
              markAt={m.mark}
              markLabel={m.mark ? `${m.mark} Å` : undefined}
            />
          );
        })}
        {/* 4. Is the filter doing anything */}
        <EnrichmentChart
          curve={summary.enrichment.curve}
          baseRate={summary.enrichment.base_rate}
        />
      </div>

      {/* 5. The designs */}
      <div className="run-section-title">Binders</div>
      <BindersTable runId={summary.run_id} onSelectBinder={selectBinder} />
      {selected?.binder && (
        <BinderModal
          key={selected.binder.id}
          binder={selected.binder}
          onClose={() => selectBinder(null)}
          epitope={parseRanges(target.epitope)}
          masked={parseRanges(target.masked_faces)}
          histograms={summary.histograms}
        />
      )}

      {/* 6. Provenance, collapsed */}
      {run && (
        <details className="run-config-section">
          <summary className="run-section-title">
            Steps &amp; Configuration
            <span className="run-config-hint">{configSummary(run)}</span>
          </summary>
          <dl className="run-config-dl">
            {run.algorithm && <><dt>Algorithm</dt><dd>{run.algorithm}</dd></>}
            {run.run_datetime && <><dt>Run date</dt><dd>{new Date(run.run_datetime).toLocaleString()}</dd></>}
            {run.hardware && <><dt>Hardware</dt><dd>{run.hardware}</dd></>}
            {run.description && <><dt>Description</dt><dd>{run.description}</dd></>}
            <RunMetadata metadata={run.metadata} />
            {run.notes && <><dt>Notes</dt><dd>{run.notes}</dd></>}
          </dl>
          <RunStepsList stepsConfig={run.steps_config} />
        </details>
      )}

      {protein && (
        <div className="run-footer-link">
          <Link to={`/proteins/${p.id}`}>← All runs for {geneLabel}</Link>
        </div>
      )}
    </div>
  );
}

function fmt(v: number | null | undefined): string {
  return v == null ? "—" : v.toFixed(3);
}
