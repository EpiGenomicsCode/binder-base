/**
 * Read the design constraints a target structure carries in its B-factor column.
 *
 * Design targets reuse `B_iso_or_equiv` to record what the designer told
 * BoltzGen about each residue, rather than any temperature factor or pLDDT.
 * Two producers write that column, and both are in service:
 *
 *   Campaign targets carry `binding_type_id * 80`, from BoltzGen's spec parser
 *   (`const.binding_types`: UNSPECIFIED=0, BINDING=1, NOT_BINDING=2). An
 *   epitope residue reads 80 and a masked residue reads 160. Measured on
 *   O14681-EI24, whose B column holds 0, 80 and 160 and nothing else: 80 falls
 *   on the epitope the spec declares binding (15..71) and 160 on the eight
 *   three-residue stubs it declares not_binding.
 *
 *   Structure Prep targets carry `hotspot_score * 100`, and the score is in
 *   [0,1], so they top out at exactly 100 and never reach the masked band.
 *
 * Masked residues sit on the faces created by proximity-cropping the target out
 * of a full AlphaFold model. They are not real protein surface, so a design
 * that binds one has bound an artefact of the crop. Telling them apart from
 * genuine hotspots is the whole reason this is three states and not two: a
 * `> 0` test calls both of them hotspots, and because the masked residues are
 * the cut edges, that paints the rim of the structure as though it were the
 * epitope.
 */

export type HotspotState = "hotspot" | "masked" | "unconstrained";

/**
 * Lower bound of the masked band.
 *
 * 120 separates the two encodings cleanly: it sits above the 100 a Structure
 * Prep target can reach at most, and below the 160 a campaign target uses for
 * NOT_BINDING. Classifying against it rather than against `> 0` therefore
 * cannot reclassify any structure prepared before the campaign existed.
 */
export const MASKED_B_MIN = 120;

/**
 * Classify one B-factor value.
 *
 * Shared by the color theme and the hover tooltip so the two cannot disagree
 * about where the boundaries are.
 */
export function classifyHotspotB(b: number): HotspotState {
  if (!Number.isFinite(b) || b <= 0) return "unconstrained";
  return b >= MASKED_B_MIN ? "masked" : "hotspot";
}
