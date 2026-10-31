/**
 * Translating between the residue numberings a run page shows at once.
 *
 * A run's target is a crop of its protein, and the page puts three things on
 * screen that number it differently:
 *
 *   target sequence block   1..N over the residues present in the crop
 *   the structure           auth_seq_id, whatever the crop was written with
 *   the PAE matrix          1..L over the WHOLE UniProt sequence
 *
 * The epitope and masked ranges are written in auth_seq_id, so that is the
 * frame everything here converts through. It is also the only frame every file
 * agrees on: label_seq_id would be the obvious way to get a crop position out
 * of the structure, and it is one in 65 of 69 production targets, but the
 * other 4 -- both TEK runs and TAL1 -- set it equal to auth_seq_id instead.
 *
 * BoltzGen crops without reindexing, which made auth and UniProt numbering
 * look like the same thing. They are the same thing for 7 of 69 targets. For
 * the rest the crop is renumbered, so a PAE band drawn at the epitope's auth
 * numbers lands on unrelated residues -- TAL1's bHLH domain is at 181..250 in
 * UniProt and 6..75 in its own file, and the band was drawn over the protein's
 * N-terminus.
 */

/**
 * `"142,145..146,148..154"` -> `[[142,142],[145,146],[148,154]]`.
 *
 * Segments rather than one span: a binding patch is a surface footprint, and
 * 65 of the 100 pilot targets have two or more. Collapsing them to lo..hi
 * would claim the gaps as epitope. Unparseable segments are skipped rather
 * than throwing, matching `structure.parse_ranges` on the backend -- this is
 * free-form metadata and one bad segment should not cost the rest.
 */
export function parseRanges(v: string | null | undefined): [number, number][] {
  if (!v) return [];
  const out: [number, number][] = [];
  for (const part of v.split(",")) {
    const m = /^\s*(\d+)\s*(?:(?:\.\.|[-–])\s*(\d+)\s*)?$/.exec(part);
    if (!m) continue;
    const lo = Number(m[1]);
    const hi = m[2] == null ? lo : Number(m[2]);
    out.push(lo <= hi ? [lo, hi] : [hi, lo]);
  }
  return out;
}

/** Flattens the ranges to the individual residue numbers, ascending. */
export function expandRanges(v: string | null | undefined): number[] {
  const out: number[] = [];
  for (const [lo, hi] of parseRanges(v)) {
    for (let r = lo; r <= hi; r++) out.push(r);
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

export interface ResidueMap {
  /** Whether the crop could be placed in the protein, i.e. whether the PAE
   *  panel can be indexed at all. */
  readonly hasProteinFrame: boolean;
  /** Position in `target_sequence` (1-based) -> the structure's auth_seq_id. */
  positionToAuth(pos: number | null | undefined): number | null;
  /** auth_seq_id -> position in `target_sequence` (1-based). */
  authToPosition(auth: number | null | undefined): number | null;
  /** auth_seq_id -> UniProt residue number, the PAE matrix's own numbering. */
  authToProtein(auth: number | null | undefined): number | null;
  /** UniProt residue number -> auth_seq_id, or null if outside the crop. */
  proteinToAuth(protein: number | null | undefined): number | null;
  /** auth-numbered ranges (the epitope as stored) -> UniProt-numbered ranges. */
  shiftRanges(ranges: [number, number][]): [number, number][];
}

/**
 * Build a map from what the API reports under `summary.target`.
 *
 * Returns null when the run records no numbering at all -- one imported before
 * this existed, or one whose structure could not be read. Callers must treat
 * that as "these panels cannot be cross-indexed" rather than falling back to
 * the old assumption, which is the bug this replaces.
 *
 * A map with `hasProteinFrame === false` still links the structure to the
 * sequence; it is only the PAE, drawn in UniProt coordinates, that it cannot
 * place.
 */
export function buildResidueMap(
  residues: string | null | undefined,
  offset: number | null | undefined,
): ResidueMap | null {
  const auth = expandRanges(residues);
  if (!auth.length) return null;

  const position = new Map<number, number>();
  auth.forEach((resi, i) => position.set(resi, i + 1));
  const hasProteinFrame = offset != null;
  const shift = offset ?? 0;

  return {
    hasProteinFrame,
    positionToAuth(pos) {
      if (pos == null || pos < 1 || pos > auth.length) return null;
      return auth[pos - 1];
    },
    authToPosition(resi) {
      if (resi == null) return null;
      return position.get(resi) ?? null;
    },
    authToProtein(resi) {
      if (resi == null || !hasProteinFrame) return null;
      // Only residues the crop contains: a number that is not in the structure
      // has no business lighting up a row of the matrix.
      return position.has(resi) ? resi + shift : null;
    },
    proteinToAuth(protein) {
      if (protein == null || !hasProteinFrame) return null;
      const resi = protein - shift;
      return position.has(resi) ? resi : null;
    },
    shiftRanges(ranges) {
      if (!hasProteinFrame) return [];
      if (!shift) return ranges;
      return ranges.map(([lo, hi]) => [lo + shift, hi + shift]);
    },
  };
}
