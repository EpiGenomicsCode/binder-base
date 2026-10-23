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

/** Compact one-liner for the protein page's run list. */
export function RunVerdictLine({ summary }: { summary: RunSummary }) {
  const { counts, rates } = summary;
  return (
    <span className="verdict-line">
      <span className={toneFor(rates.placement)}>
        {counts.placement_hits}/{counts.designs} placed
      </span>
      <span className="verdict-sep">·</span>
      <span className={toneFor(rates.pass)}>{counts.passed_filters} passed</span>
    </span>
  );
}
