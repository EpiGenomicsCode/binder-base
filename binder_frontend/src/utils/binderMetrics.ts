/**
 * Making a design pipeline's 254-column output readable.
 *
 * A binder's `metrics` is whatever the pipeline's CSV had, in the order it had
 * it. For a BoltzGen run that is 254 columns, of which roughly half are blank
 * or zero for any given design, and it was rendered as one flat key/value list
 * under raw column names. That is not a volume problem so much as a kind
 * problem: six different sorts of thing are flattened into one shape.
 *
 *   88  liability_*      a table -- ~10 liability types x 9 sub-fields each
 *   28  "x<1.5", "y>80"  flags derived from values already on screen
 *   21  *_fraction       an amino-acid composition profile
 *   10  pass_*           the filter verdict, i.e. one answer and which test failed
 *    6  neg_*            negated copies, the pipeline's own sort keys
 *    6  rank_*           ranking internals
 *
 * So this module does two things: it names the handful of metrics that decide
 * whether a design is any good, and it sorts the rest into groups. It does not
 * try to be a schema. Keys are matched by pattern because the set of columns
 * is a property of whatever tool produced the run, and BinderBase ingests runs
 * from any of them -- an unrecognised key lands in "Other" rather than being
 * dropped.
 */
import type { Binder } from "../types";

/** Matches DEFAULT_PLACEMENT_A / DEFAULT_MONOMER_A in binderbase/api.py. */
export const PLACEMENT_A = 2.0;
export const MONOMER_A = 2.0;

/**
 * pLDDT on the 0-100 scale the About glossary and the viewers both use.
 *
 * BoltzGen writes `complex_plddt` as a fraction -- across ~29,000 production
 * designs it spans 0.58 to 0.84 -- so showing it as stored puts the one number
 * a reader might recognise on the wrong scale by a factor of 100. Rescaled
 * only when it cannot already be a percentage, since another pipeline may well
 * write 0-100 and a true pLDDT of 1 would be meaningless either way.
 */
export function plddtPercent(v: number | null | undefined): number | null {
  if (v == null) return null;
  return v <= 1 ? v * 100 : v;
}

export interface Headline {
  label: string;
  /** Formatted value, or null when the run did not record it. */
  value: string | null;
  /** Short gloss: the unit, the threshold, what good looks like. */
  note?: string;
  /** Whether it clears the threshold, where there is one. */
  verdict?: "good" | "bad";
}

function fixed(v: number | null | undefined, places: number): string | null {
  return v == null ? null : v.toFixed(places);
}

/**
 * The six numbers that answer "is this design any good", in that order.
 *
 * All of them come from promoted columns rather than the raw blob, so they are
 * typed, consistently rounded, and present even for a run whose CSV named them
 * differently. Placement leads because it is the metric that matters most and
 * the hardest to pass -- see the About glossary, which defines every term here.
 */
export function headlineMetrics(b: Binder): Headline[] {
  const placement = b.bb_target_aligned_rmsd_design;
  const monomer = b.designfolding_bb_rmsd;
  const plddt = plddtPercent(b.complex_plddt);
  return [
    {
      label: "Placement",
      value: fixed(placement, 2),
      note: `Å, target-aligned · under ${PLACEMENT_A} is placed`,
      verdict: placement == null ? undefined
        : placement < PLACEMENT_A ? "good" : "bad",
    },
    {
      label: "Monomer",
      value: fixed(monomer, 2),
      note: `Å, folded alone · under ${MONOMER_A} is self-consistent`,
      verdict: monomer == null ? undefined
        : monomer < MONOMER_A ? "good" : "bad",
    },
    {
      label: "Interface ipTM",
      value: fixed(b.design_to_target_iptm, 3),
      note: "0–1 · higher is better",
    },
    {
      label: "Interaction PAE",
      value: fixed(b.min_interaction_pae, 2),
      note: "Å, across the interface · lower is better",
    },
    {
      label: "pLDDT",
      value: fixed(plddt, 1),
      note: "0–100 · local confidence, not binding",
    },
    {
      label: "Filters",
      value: b.pass_filters == null ? null : b.pass_filters ? "passed" : "failed",
      note: "the pipeline's own verdict · not comparable across methods",
      verdict: b.pass_filters == null ? undefined
        : b.pass_filters ? "good" : "bad",
    },
  ];
}

// --- the rest of the blob ---------------------------------------------------

const BLANK = new Set(["", "nan", "none", "null", "na", "[]", "{}", "-"]);

function isBlank(v: unknown): boolean {
  return v == null || BLANK.has(String(v).trim().toLowerCase());
}

/**
 * Keys where zero or false means "nothing to report" rather than a measurement.
 *
 * The distinction is load-bearing. `liability_MetOx_count = 0` is an absence
 * and hiding it loses nothing; `plip_hbonds_refolded = 0` is a result -- the
 * design makes no hydrogen bonds across its interface -- and hiding it would
 * turn a bad design into a quiet one. 26 such measured zeros survive this test
 * on a typical design, which is the point of having it.
 */
function isCountOrFlag(key: string): boolean {
  return (
    key.startsWith("pass_") ||
    key.startsWith("liability_") ||
    key.includes("<") ||
    key.includes(">") ||
    key.endsWith("_count") ||
    key.includes("_num_") ||
    key === "has_x"
  );
}

function isZero(v: unknown): boolean {
  const s = String(v).trim().toLowerCase();
  if (s === "false") return true;
  const n = Number(s);
  return Number.isFinite(n) && n === 0;
}

/** The default filter: blanks always, zeros only where zero means absence. */
export function isUninformative(key: string, v: unknown): boolean {
  if (isBlank(v)) return true;
  return isCountOrFlag(key) && isZero(v);
}

export interface MetricGroup {
  id: string;
  title: string;
  /** Collapsed by default: present for completeness, not for reading. */
  secondary?: boolean;
  entries: { key: string; label: string; value: string }[];
}

interface Rule {
  id: string;
  title: string;
  secondary?: boolean;
  match: (key: string) => boolean;
}

const CONFIDENCE = /(iptm|ptm|plddt|pae|ipsae|pde)/i;
const GEOMETRY = /rmsd|designability/i;
const INTERFACE = /plip|sasa|hydrophobic_patch/i;
const COMPOSITION = /_fraction$|hydrophobicity|^(loop|helix|sheet)$|tokens/i;

// Order is display order, and first match wins -- so the specific groups are
// listed before the patterns that would also catch them. "Pipeline internals"
// deliberately sits last and collapsed: neg_* and rank_* exist so the pipeline
// can sort, and the three copies of the sequence are already shown above.
const RULES: Rule[] = [
  { id: "liabilities", title: "Liabilities", match: (k) => k.startsWith("liability_") },
  { id: "filters", title: "Filters", match: (k) => k.startsWith("pass_") || k === "num_filters_passed" },
  {
    id: "thresholds", title: "Threshold flags", secondary: true,
    match: (k) => k.includes("<") || k.includes(">"),
  },
  {
    id: "internals", title: "Pipeline internals", secondary: true,
    match: (k) =>
      k.startsWith("neg_") || k.startsWith("rank_") ||
      ["max_rank", "secondary_rank", "num_design", "id", "file_name",
       "sequence", "designed_sequence", "designed_chain_sequence"].includes(k),
  },
  { id: "confidence", title: "Confidence", match: (k) => CONFIDENCE.test(k) },
  { id: "geometry", title: "Geometry", match: (k) => GEOMETRY.test(k) },
  { id: "interface", title: "Interface", match: (k) => INTERFACE.test(k) },
  { id: "composition", title: "Composition", match: (k) => COMPOSITION.test(k) },
  { id: "other", title: "Other", match: () => true },
];

/** `designfolding-bb_rmsd` -> `Designfolding bb rmsd`, keeping the real key visible. */
function humanise(key: string): string {
  const text = key.replace(/[_-]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Numbers to a consistent width; booleans as words; everything else as given. */
function formatValue(v: unknown): string {
  const s = String(v).trim();
  const lower = s.toLowerCase();
  if (lower === "true") return "yes";
  if (lower === "false") return "no";
  const n = Number(s);
  if (s !== "" && Number.isFinite(n) && /^-?\d*\.?\d+(e-?\d+)?$/i.test(s)) {
    if (Number.isInteger(n)) return String(n);
    // Trailing zeros removed so a column of 5dp strings stops looking like
    // more precision than the pipeline meant.
    return String(Number(n.toFixed(4)));
  }
  return s;
}

/**
 * Sort the raw metrics into display groups.
 *
 * `showAll` is the escape hatch: with it false, blanks and absent-meaning
 * zeros are dropped and the counts reported alongside, so nothing disappears
 * silently.
 */
export function groupMetrics(
  metrics: Record<string, unknown> | null | undefined,
  showAll: boolean,
): { groups: MetricGroup[]; shown: number; total: number } {
  const byId = new Map<string, MetricGroup>();
  for (const rule of RULES) {
    byId.set(rule.id, { id: rule.id, title: rule.title, secondary: rule.secondary, entries: [] });
  }

  let total = 0;
  let shown = 0;
  for (const [key, value] of Object.entries(metrics ?? {})) {
    total += 1;
    if (!showAll && isUninformative(key, value)) continue;
    shown += 1;
    const rule = RULES.find((r) => r.match(key))!;
    byId.get(rule.id)!.entries.push({
      key, label: humanise(key), value: formatValue(value),
    });
  }

  for (const group of byId.values()) {
    group.entries.sort((a, b) => a.key.localeCompare(b.key));
  }
  return {
    groups: RULES.map((r) => byId.get(r.id)!).filter((g) => g.entries.length > 0),
    shown,
    total,
  };
}
