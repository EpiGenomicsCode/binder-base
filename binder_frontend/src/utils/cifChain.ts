/**
 * Isolate a single chain out of an mmCIF complex, as text.
 *
 * A binder's only surviving structure is the target+binder complex: the
 * campaign's prune step deletes `intermediate_designs_inverse_folded/`, which
 * is where BoltzGen wrote the binder-only refolds. Showing the binder by itself
 * therefore means filtering the complex before Mol* parses it.
 *
 * Filtering the text rather than hiding chains in the loaded structure buys two
 * things: Mol*'s automatic camera framing centres on the binder instead of
 * staying zoomed out to the whole complex, and the viewer holds only the atoms
 * it draws. These files run a few thousand atoms, so the parse is cheap.
 *
 * Only `_atom_site` data rows are touched. Other categories are copied through
 * verbatim, including `_ma_qa_metric_local` (keyed by label_asym_id and
 * label_seq_id, so the dropped chain's rows are simply never looked up) and
 * `_entity_poly`. Mol* builds its structure from `_atom_site`, so records left
 * describing the removed chain are inert.
 *
 * `structureParser.ts` also reads `_atom_site`, but it parses into residues;
 * this rewrites the file and so has to preserve lines verbatim.
 */

/** Byte-identical rewrite is the goal, so rows are kept as their original lines. */
interface AtomSiteLoop {
  /** Loop header tags, lowercased, in column order. */
  tags: string[];
  /** Index of the first data line. */
  first: number;
  /** Index one past the last data line. */
  end: number;
}

/**
 * Split one mmCIF line into tokens, honouring quoted values.
 *
 * A quote closes a value only when whitespace or end-of-line follows it. That
 * is what lets mmCIF carry an apostrophe inside a quoted token such as `C1'`,
 * and a naive "scan to the next quote" split would truncate those.
 */
function tokenizeLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let value = "";
      while (j < line.length) {
        const next = line[j + 1];
        if (line[j] === c && (next === undefined || next === " " || next === "\t" || next === "\r")) break;
        value += line[j];
        j++;
      }
      out.push(value);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] !== " " && line[j] !== "\t" && line[j] !== "\r") j++;
    out.push(line.slice(i, j));
    i = j;
  }
  return out;
}

/**
 * Locate the `_atom_site` loop.
 *
 * Data rows end at the next `#`, blank line, `loop_`, `data_`, or tag line.
 * A semicolon-delimited multi-line value would defeat that, but `_atom_site`
 * holds only short scalars, so none occur in practice.
 */
function findAtomSiteLoop(lines: string[]): AtomSiteLoop | null {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "loop_") continue;

    const tags: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j].trimStart().startsWith("_")) {
      tags.push(lines[j].trim().split(/\s+/)[0].toLowerCase());
      j++;
    }
    if (tags.length === 0 || !tags[0].startsWith("_atom_site.")) continue;

    let k = j;
    while (k < lines.length) {
      const t = lines[k].trim();
      if (t === "" || t === "#" || t === "loop_" || t.startsWith("_") || t.startsWith("data_")) break;
      k++;
    }
    return { tags, first: j, end: k };
  }
  return null;
}

/**
 * Residue count per `label_asym_id`.
 *
 * Counts distinct `label_seq_id` values rather than atoms, and skips rows whose
 * seq id is absent (`.` or `?`) — ligands, ions and waters, which carry no
 * polymer numbering and would otherwise inflate a chain's apparent length.
 */
export function chainResidueCounts(cif: string): Map<string, number> {
  const lines = cif.split("\n");
  const loop = findAtomSiteLoop(lines);
  const counts = new Map<string, number>();
  if (!loop) return counts;

  const asymIdx = loop.tags.indexOf("_atom_site.label_asym_id");
  const seqIdx = loop.tags.indexOf("_atom_site.label_seq_id");
  if (asymIdx < 0 || seqIdx < 0) return counts;

  const residues = new Map<string, Set<string>>();
  for (let i = loop.first; i < loop.end; i++) {
    const fields = tokenizeLine(lines[i]);
    if (fields.length < loop.tags.length) continue;
    const seq = fields[seqIdx];
    if (seq === "." || seq === "?") continue;
    const asym = fields[asymIdx];
    let set = residues.get(asym);
    if (!set) {
      set = new Set();
      residues.set(asym, set);
    }
    set.add(seq);
  }
  for (const [asym, set] of residues) counts.set(asym, set.size);
  return counts;
}

/**
 * Pick the chain whose residue count matches `length`, else the closest.
 *
 * An exact match is the normal case — the binder's length is known from its
 * sequence. The nearest-match fallback covers a complex whose binder chain has
 * unresolved residues, where being one or two short should still select the
 * binder rather than give up and show the target.
 *
 * Ties go to the first chain in iteration order, which is file order.
 */
export function pickChainByLength(
  counts: Map<string, number>,
  length: number
): string | null {
  let best: string | null = null;
  let bestDiff = Infinity;
  for (const [asym, n] of counts) {
    if (n === length) return asym;
    const diff = Math.abs(n - length);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = asym;
    }
  }
  return best;
}

/**
 * Drop every `_atom_site` row that is not on `asymId`.
 *
 * Returns the input unchanged when there is no `_atom_site` loop, no
 * `label_asym_id` column, or when filtering would leave no atoms at all —
 * showing the whole complex beats showing an empty viewport.
 */
export function isolateChain(cif: string, asymId: string): string {
  const lines = cif.split("\n");
  const loop = findAtomSiteLoop(lines);
  if (!loop) return cif;

  const asymIdx = loop.tags.indexOf("_atom_site.label_asym_id");
  if (asymIdx < 0) return cif;

  const kept: string[] = [];
  for (let i = loop.first; i < loop.end; i++) {
    const fields = tokenizeLine(lines[i]);
    // A short row is malformed rather than foreign; keep it and let Mol* judge.
    if (fields.length >= loop.tags.length && fields[asymIdx] !== asymId) continue;
    kept.push(lines[i]);
  }
  if (kept.length === 0) return cif;

  return [...lines.slice(0, loop.first), ...kept, ...lines.slice(loop.end)].join("\n");
}

/**
 * Reduce a complex to the chain `length` residues long.
 *
 * The convenience entry point: counts chains, picks one, filters. Falls back to
 * the unfiltered text whenever no chain can be identified.
 */
export function isolateChainByLength(cif: string, length: number): string {
  const asym = pickChainByLength(chainResidueCounts(cif), length);
  return asym ? isolateChain(cif, asym) : cif;
}
