import { Fragment } from "react";
import type { RunSummary } from "../types";

/**
 * The first thing on a run page: did it work?
 *
 * A run with 0/200 placed and one with 20/489 placed must be distinguishable at
 * a glance, which the binder table alone does not do -- it is sorted by the
 * pipeline's own score, so every run leads with its best design regardless of
 * whether that design is any good.
 */

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/** Deliberately coarse. These are orientation, not a claim about the designs. */
function toneFor(rate: number): string {
  if (rate >= 0.05) return "v-good";
  if (rate > 0) return "v-some";
  return "v-none";
}

export default function RunVerdict({ summary }: { summary: RunSummary }) {
  const { counts, rates } = summary;
  const items = [
    {
      key: "designs",
      label: "designs",
      value: counts.designs.toLocaleString(),
      sub: null as string | null,
      tone: "v-plain",
    },
    {
      key: "placement",
      label: `placed < ${rates.placement_threshold} Å`,
      value: counts.placement_hits.toLocaleString(),
      sub: pct(rates.placement),
      tone: toneFor(rates.placement),
    },
    {
      key: "monomer",
      label: `monomer-consistent < ${rates.monomer_threshold} Å`,
      value: counts.monomer_consistent.toLocaleString(),
      sub: pct(rates.monomer),
      tone: toneFor(rates.monomer),
    },
    {
      key: "passed",
      label: "passed filters",
      value: counts.passed_filters.toLocaleString(),
      sub: pct(rates.pass),
      tone: toneFor(rates.pass),
    },
  ];

  return (
    <div className="run-verdict">
      {items.map((it) => (
        <div key={it.key} className={`verdict-item ${it.tone}`}>
          <div className="verdict-value">
            {it.value}
            {it.sub && <span className="verdict-pct">{it.sub}</span>}
          </div>
          <div className="verdict-label">{it.label}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * Compact one-liner for the protein page's run list.
 *
 * All three rates carry a denominator and a percentage. The counts alone are
 * not comparable between runs -- a campaign mixes runs of 100 and 500 designs
 * -- and the percentages alone hide how thin the evidence is, which is the
 * same reason the run page shows both.
 *
 * Placement and pass are both here because they disagree. Across the 2,323
 * runs published at the time of writing they correlate at only r = +0.61, and
 * 15.1% split outright: 6.9% land on the epitope and fail the filters, 8.2%
 * pass cleanly somewhere else entirely. A line carrying one of them calls
 * those runs by the wrong name.
 *
 * The labels spell the measurement out rather than using the short names the
 * glossary and the leaderboard columns carry ("Placed", "Monomer", "Passed").
 * A column heading sits in a grid of related columns under a sortable header
 * with a tooltip; this line is standalone, so the word has to do the work on
 * its own. Both say "as designed" because both compare against the design --
 * which is the reference point a bare "placed" leaves out.
 *
 * Positioned and folds sit together: one asks where the binder ends up, the
 * other what shape it reaches, and the parallel is what makes the pair legible
 * as two questions about the same designs. The filter verdict comes last --
 * it is the pipeline grading its own output, and the glossary is explicit that
 * it is not comparable across methods.
 *
 * Monomer-consistency is deliberately not tone-coloured. toneFor's 5% cut is
 * calibrated for placement and pass, whose medians are 3% and 4%; the monomer
 * median is 59%, so colouring it would paint nearly every run green and drain
 * the colour of meaning where it is earned. It is also the one metric that
 * moves AGAINST placement (r = -0.28), so reading it as more-is-better would
 * be actively misleading.
 */
export function RunVerdictLine({ summary }: { summary: RunSummary }) {
  const { counts, rates } = summary;
  const n = counts.designs;
  const items = [
    {
      key: "placed",
      label: "positioned as designed",
      value: counts.placement_hits,
      rate: rates.placement,
      tone: toneFor(rates.placement),
      title: `Designs that hold their designed pose when the complex is refolded from sequence: the target is superposed and the binder's backbone displacement measured, under ${rates.placement_threshold} Å`,
    },
    {
      key: "monomer",
      label: "folds as designed",
      value: counts.monomer_consistent,
      rate: rates.monomer,
      tone: "v-plain",
      title: `Designs whose binder reaches its intended shape folded on its own, with no target present, within ${rates.monomer_threshold} Å backbone RMSD`,
    },
    {
      key: "passed",
      label: "passed filters",
      value: counts.passed_filters,
      rate: rates.pass,
      tone: toneFor(rates.pass),
      title: "Designs that satisfied every filter the design pipeline applied -- its own verdict, not comparable across methods",
    },
  ];

  return (
    <span className="verdict-line">
      {items.map((it, i) => (
        <Fragment key={it.key}>
          {i > 0 && <span className="verdict-sep">·</span>}
          <span className={it.tone} title={it.title}>
            {it.value.toLocaleString()}/{n.toLocaleString()} {it.label}{" "}
            <span className="verdict-pct">{pct(it.rate)}</span>
          </span>
        </Fragment>
      ))}
    </span>
  );
}
