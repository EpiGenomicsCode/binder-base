import type { Stats } from "../types";

/**
 * The four site-wide counts from /api/stats, named once.
 *
 * Home and About render the same four numbers off the same response and used
 * to label them differently -- "Proteins / Design Runs / Binders / Successful"
 * on one, "targets / runs / designs / passing designs" on the other. Four
 * numbers under eight names reads as eight facts, and a visitor has no way to
 * tell that "Binders" and "designs" are the same column of the same table.
 *
 * The wording follows the navbar, which is what a visitor meets first: the
 * tabs are Targets and Runs, so these are targets and runs everywhere else
 * too. Both pages uppercase the label in CSS, so the casing here never shows.
 */
export const STAT_FIELDS: ReadonlyArray<{ key: keyof Stats; label: string }> = [
  { key: "protein_count", label: "targets" },
  { key: "run_count", label: "runs" },
  { key: "binder_count", label: "designs" },
  // Binder.status == "success", i.e. designs that passed the filters BoltzGen
  // applied during the run. Not a claim that anything was validated at the
  // bench -- "Successful" on the landing page read like one.
  { key: "success_count", label: "passing designs" },
];
