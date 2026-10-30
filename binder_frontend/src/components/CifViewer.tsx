import { useEffect, useRef } from "react";
import { Viewer } from "molstar/lib/apps/viewer/app";
import {
  Structure,
  StructureElement,
  StructureProperties,
  StructureSelection,
} from "molstar/lib/mol-model/structure";
import { Script } from "molstar/lib/mol-script/script";
import { Color } from "molstar/lib/mol-util/color";
import { MAQualityAssessment } from "molstar/lib/extensions/model-archive/quality-assessment/behavior";
import type { Loci } from "molstar/lib/mol-model/loci";
import type { Location } from "molstar/lib/mol-model/location";
import { isolateChainByLength } from "../utils/cifChain";
import { classifyHotspotB } from "../utils/hotspotBfactor";
import "molstar/build/viewer/molstar.css";

/**
 * How to color the structure, and which legend to show:
 *  - "confidence": AlphaFold pLDDT bands (B-factor = pLDDT).
 *  - "hotspot":    design constraints from the B-factor column: hotspot,
 *                  masked (a face created by cropping), or unconstrained.
 *  - "epitope":    the same constraints on a target+binder COMPLEX, driven by
 *                  residue number rather than B-factor -- a complex reuses its
 *                  B column for pLDDT, so the spec is not in the file. The
 *                  ranges come from the run's metadata and land directly on
 *                  the target chain, which keeps the protein's own numbering.
 *  - "none":       Mol* default coloring, no legend.
 */
export type CifColoring = "confidence" | "hotspot" | "epitope" | "none";

interface Props {
  cifPath: string;
  label: string;
  /** Coloring theme + legend. Default "confidence". */
  coloring?: CifColoring;
  /**
   * Residue to highlight in the 3D view, as the structure's own auth_seq_id,
   * or null.
   *
   * auth_seq_id and not label_seq_id, which would be the obvious way to get a
   * position within the chain: it is one in most files, but 4 of the 69
   * production targets -- both TEK runs and TAL1 -- set label_seq_id equal to
   * auth_seq_id instead, so it means different things in different files.
   * auth_seq_id is also what this component's own epitope theme colours by,
   * so reading hovers out of label_seq_id made the two disagree.
   */
  highlightResidue?: number | null;
  /** Called with the auth_seq_id under the cursor in the 3D view (or null). */
  onHoverResidue?: (resno: number | null) => void;
  /**
   * For multi-chain structures, restrict hover-linking to the chain whose residue
   * count matches this value (e.g. the binder chain in a target+binder complex).
   * Omit for single-chain structures.
   */
  seqChainLength?: number | null;
  /**
   * Show only the chain this many residues long, discarding the rest before the
   * file is parsed. Used to draw the binder by itself out of a target+binder
   * complex, which is the only structure a pruned run keeps for a binder.
   * Omit to show the file as it is.
   */
  isolateChainLength?: number | null;
  /**
   * For coloring="epitope": the residues the design was asked to bind, in the
   * TARGET's own numbering. BoltzGen crops with res_reindex=False, so a
   * complex's target chain keeps the full protein's numbers and these need no
   * offset. Empty means there is nothing to show and the mode is a no-op.
   */
  epitopeRanges?: [number, number][];
  /** Crop faces, same numbering. Shown grey, so a design sitting on an
   *  artefact of the crop rather than on real surface is visible. */
  maskedRanges?: [number, number][];
}

// AlphaFold model-confidence (pLDDT) bands and colors.
// https://alphafold.ebi.ac.uk — matches the "plddt-confidence" Mol* color theme.
//
// Designed structures carry pLDDT twice: as `_ma_qa_metric_local.metric_value`
// on the usual 0-100 scale, and as B_iso_or_equiv on a 0-1 scale. The Mol*
// theme reads the quality-assessment property and only falls back to B-factor
// when none exists, so it reads the 0-100 values and these bands are correct.
const CONFIDENCE_LEGEND = [
  { color: "#0053D6", label: "Very high (pLDDT > 90)" },
  { color: "#65CBF3", label: "Confident (90 > pLDDT > 70)" },
  { color: "#FFDB13", label: "Low (70 > pLDDT > 50)" },
  { color: "#FF7D45", label: "Very low (pLDDT < 50)" },
];

// Design-target structures carry the design constraints in the B-factor column
// rather than pLDDT, so they get their own theme instead of the confidence
// bands. There are three states, not two.
const HOTSPOT_COLOR = 0xffe119; // yellow
const MASKED_COLOR = 0x9a9a9a; // grey
const NON_HOTSPOT_COLOR = 0x6a3d9a; // deep purple
// The binder, in the complex view. Cyan from the same distinct-colour palette
// the three above come from: the opposite hue to the epitope's yellow, and
// far enough from the purple in LIGHTNESS (L* 78 vs 35) to stay separable
// under deuteranopia, where both would otherwise shift towards blue.
const BINDER_COLOR = 0x42d4f4; // cyan
const HOTSPOT_THEME_NAME = "hotspot-bfactor";
const EPITOPE_THEME_NAME = "epitope-residues";

const HOTSPOT_LEGEND = [
  { color: "#FFE119", label: "Hotspot — bind here" },
  { color: "#9A9A9A", label: "Masked — crop face" },
  { color: "#6A3D9A", label: "Unconstrained" },
];

const EPITOPE_LEGEND = [
  { color: "#42D4F4", label: "Binder" },
  { color: "#FFE119", label: "Epitope — target here" },
  { color: "#9A9A9A", label: "Masked — crop face" },
  { color: "#6A3D9A", label: "Target surface" },
];

const LEGENDS: Record<CifColoring, { title: string; items: typeof CONFIDENCE_LEGEND } | null> = {
  confidence: { title: "Model confidence (pLDDT)", items: CONFIDENCE_LEGEND },
  hotspot: { title: "Design constraints", items: HOTSPOT_LEGEND },
  epitope: { title: "Did it hit the epitope?", items: EPITOPE_LEGEND },
  none: null,
};

/** Flatten [[675,678],[700,709]] into a Set for O(1) membership per atom. */
function residueSet(ranges: [number, number][]): Set<number> {
  const out = new Set<number>();
  for (const [lo, hi] of ranges) {
    for (let r = lo; r <= hi; r++) out.add(r);
  }
  return out;
}

const HOTSPOT_THEME_PROVIDER = {
  name: HOTSPOT_THEME_NAME,
  label: "Hotspot (B-factor)",
  category: "Custom",
  isApplicable: () => true,
  defaultValues: {},
  getParams: () => ({}),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  factory: (_ctx: any, _props: any) => ({
    granularity: "group",
    color: (location: Location) => {
      if (StructureElement.Location.is(location)) {
        const state = classifyHotspotB(StructureProperties.atom.B_iso_or_equiv(location));
        if (state === "masked") return Color(MASKED_COLOR);
        if (state === "hotspot") return Color(HOTSPOT_COLOR);
      }
      return Color(NON_HOTSPOT_COLOR);
    },
    props: {},
  }),
};

// Find the chain (label_asym_id) whose residue count best matches `length` —
// used to pick the binder chain out of a target+binder complex.
function findChainAsymId(structure: Structure, length: number): string | null {
  const residuesByChain = new Map<string, Set<number>>();
  const loc = StructureElement.Location.create(structure);
  for (const unit of structure.units) {
    loc.unit = unit;
    const { elements } = unit;
    for (let i = 0; i < elements.length; i++) {
      loc.element = elements[i];
      const asym = StructureProperties.chain.label_asym_id(loc);
      const seqId = StructureProperties.residue.label_seq_id(loc);
      let set = residuesByChain.get(asym);
      if (!set) { set = new Set(); residuesByChain.set(asym, set); }
      set.add(seqId);
    }
  }
  let best: string | null = null;
  let bestDiff = Infinity;
  for (const [asym, set] of residuesByChain) {
    if (set.size === length) return asym;
    const diff = Math.abs(set.size - length);
    if (diff < bestDiff) { bestDiff = diff; best = asym; }
  }
  return best;
}

export default function CifViewer({
  cifPath,
  label,
  coloring = "confidence",
  highlightResidue = null,
  onHoverResidue,
  seqChainLength = null,
  isolateChainLength = null,
  epitopeRanges = [],
  maskedRanges = [],
}: Props) {
  // Serialised so the effect compares VALUES, not array identity: the parent
  // passes a fresh literal on every render, which as a dependency would tear
  // down and rebuild the Mol* viewer each time.
  const epitopeKey = JSON.stringify(epitopeRanges);
  const maskedKey = JSON.stringify(maskedRanges);

  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const structureRef = useRef<Structure | null>(null);
  // label_asym_id of the chain the linked sequence maps to (null = whole structure).
  const chainAsymRef = useRef<string | null>(null);
  // Keep the latest callback without re-subscribing the Mol* hover behavior.
  const onHoverRef = useRef(onHoverResidue);
  onHoverRef.current = onHoverResidue;

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;

    Viewer.create(containerRef.current, {
      layoutIsExpanded: false,
      layoutShowControls: false,
      layoutShowRemoteState: false,
      layoutShowSequence: false,
      layoutShowLog: false,
      layoutShowLeftPanel: false,
      collapseLeftPanel: true,
      viewportShowExpand: false,
      viewportShowSelectionMode: false,
      viewportShowAnimation: false,
      viewportShowSettings: false,
      viewportShowScreenshotControls: false,
      viewportBackgroundColor: "#ffffff",
    }).then(async (v) => {
      if (disposed) { v.dispose(); return; }
      viewerRef.current = v;

      // Isolating a chain means rewriting the file, so it has to be fetched
      // rather than handed to Mol* as a URL. The browser serves the second
      // viewer of the same complex from cache, so this costs no extra transfer.
      // Any failure falls back to loading the file whole: a complex in the
      // binder panel is wrong but still informative, an empty panel is not.
      let loaded = false;
      if (isolateChainLength) {
        try {
          const res = await fetch(`/media/${cifPath}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const text = await res.text();
          if (disposed) return;
          await v.loadStructureFromData(isolateChainByLength(text, isolateChainLength), "mmcif");
          loaded = true;
        } catch {
          loaded = false;
        }
      }
      if (!loaded) await v.loadStructureFromUrl(`/media/${cifPath}`, "mmcif", false);
      if (disposed) return;

      const { plugin } = v;

      // Register the hotspot theme before the first theme update uses it.
      if (coloring === "hotspot") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const registry = (plugin as any).representation.structure.themes.colorThemeRegistry;
        const registered =
          typeof registry.has === "function"
            ? registry.has(HOTSPOT_THEME_NAME)
            : !!registry.get(HOTSPOT_THEME_NAME);
        if (!registered) registry.add(HOTSPOT_THEME_PROVIDER);

        // These files reuse the ma_qa_metric pLDDT field to flag hotspots, so
        // Mol*'s built-in tooltip would report a meaningless "pLDDT (Confident)".
        // Suppress it and report hotspot status instead.
        await plugin.state.updateBehavior(MAQualityAssessment, (p) => {
          p.showTooltip = false;
        });
        plugin.managers.lociLabels.addProvider({
          label: (loci: Loci) => {
            if (!StructureElement.Loci.is(loci) || StructureElement.Loci.isEmpty(loci)) return;
            const loc = StructureElement.Loci.getFirstLocation(loci);
            if (!loc) return;
            const state = classifyHotspotB(StructureProperties.atom.B_iso_or_equiv(loc));
            if (state === "masked") return "Masked — face created by cropping";
            return state === "hotspot" ? "Hotspot residue" : "Unconstrained";
          },
        });
      }

      const structure =
        plugin.managers.structure.hierarchy.current.structures[0]?.cell.obj?.data ?? null;
      structureRef.current = structure;
      chainAsymRef.current =
        structure && seqChainLength ? findChainAsymId(structure, seqChainLength) : null;

      // The epitope theme has to be built AFTER the structure loads, because
      // it needs to know which chain is the binder. Registered on this
      // viewer's own plugin, so the two panels of one modal can hold
      // different epitopes without colliding -- each CifViewer creates its own
      // Viewer and therefore its own theme registry.
      if (coloring === "epitope" && structure) {
        const epitope = residueSet(epitopeRanges);
        const masked = residueSet(maskedRanges);
        // seqChainLength is the binder's length, which is how the complex's
        // two chains are told apart everywhere else in this component.
        const binderAsym = seqChainLength
          ? findChainAsymId(structure, seqChainLength)
          : null;

        const stateAt = (loc: StructureElement.Location) => {
          if (binderAsym &&
              StructureProperties.chain.label_asym_id(loc) === binderAsym) {
            return "binder" as const;
          }
          const resi = StructureProperties.residue.auth_seq_id(loc);
          if (epitope.has(resi)) return "epitope" as const;
          if (masked.has(resi)) return "masked" as const;
          return "target" as const;
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const registry = (plugin as any).representation.structure.themes.colorThemeRegistry;
        registry.add({
          name: EPITOPE_THEME_NAME,
          label: "Epitope (residue number)",
          category: "Custom",
          isApplicable: () => true,
          defaultValues: {},
          getParams: () => ({}),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          factory: (_ctx: any, _props: any) => ({
            granularity: "group",
            color: (location: Location) => {
              if (!StructureElement.Location.is(location)) {
                return Color(NON_HOTSPOT_COLOR);
              }
              switch (stateAt(location)) {
                case "binder": return Color(BINDER_COLOR);
                case "epitope": return Color(HOTSPOT_COLOR);
                case "masked": return Color(MASKED_COLOR);
                default: return Color(NON_HOTSPOT_COLOR);
              }
            },
            props: {},
          }),
        });

        // The complex reuses ma_qa_metric for pLDDT, which is true here but
        // not what this view is about, so the tooltip answers the question the
        // colouring is asking instead.
        await plugin.state.updateBehavior(MAQualityAssessment, (pp) => {
          pp.showTooltip = false;
        });
        plugin.managers.lociLabels.addProvider({
          label: (loci: Loci) => {
            if (!StructureElement.Loci.is(loci) || StructureElement.Loci.isEmpty(loci)) return;
            const loc = StructureElement.Loci.getFirstLocation(loci);
            if (!loc) return;
            switch (stateAt(loc)) {
              case "binder": return "Binder";
              case "epitope":
                return `Epitope residue ${StructureProperties.residue.auth_seq_id(loc)}`;
              case "masked": return "Masked — face created by cropping";
              default:
                return `Target residue ${StructureProperties.residue.auth_seq_id(loc)}`;
            }
          },
        });
      }

      // Apply the theme the legend describes, so the two always agree.
      if (coloring !== "none") {
        const themeName =
          coloring === "hotspot" ? HOTSPOT_THEME_NAME
          : coloring === "epitope" ? EPITOPE_THEME_NAME
          : "plddt-confidence";
        try {
          for (const s of plugin.managers.structure.hierarchy.current.structures) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const themeParams = { color: themeName } as any;
            await plugin.managers.structure.component.updateRepresentationsTheme(
              s.components,
              themeParams
            );
          }
        } catch {
          // Non-AlphaFold structure or theme unavailable; keep default coloring.
        }
      }

      // Report the residue under the cursor so a linked sequence can highlight it.
      plugin.behaviors.interaction.hover.subscribe(({ current }) => {
        const cb = onHoverRef.current;
        if (!cb) return;
        let resno: number | null = null;
        try {
          const loci = current?.loci;
          if (loci && StructureElement.Loci.is(loci) && !StructureElement.Loci.isEmpty(loci)) {
            const loc = StructureElement.Loci.getFirstLocation(loci);
            if (loc) {
              const chain = chainAsymRef.current;
              if (!chain || StructureProperties.chain.label_asym_id(loc) === chain) {
                resno = StructureProperties.residue.auth_seq_id(loc);
              }
            }
          }
        } catch {
          resno = null;
        }
        cb(resno);
      });
    });

    return () => {
      disposed = true;
      viewerRef.current?.dispose();
      viewerRef.current = null;
      structureRef.current = null;
      chainAsymRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cifPath, coloring, seqChainLength, isolateChainLength, epitopeKey, maskedKey]);

  // Highlight a residue in the 3D view when the linked sequence is hovered.
  useEffect(() => {
    const v = viewerRef.current;
    const structure = structureRef.current;
    if (!v || !structure) return;
    const { plugin } = v;
    try {
      if (highlightResidue == null) {
        plugin.managers.interactivity.lociHighlights.clearHighlights();
        return;
      }
      const chain = chainAsymRef.current;
      const sel = Script.getStructureSelection(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (Q: any) => {
          const tests: Record<string, unknown> = {
            "residue-test": Q.core.rel.eq([
              Q.struct.atomProperty.macromolecular.auth_seq_id(),
              highlightResidue,
            ]),
          };
          if (chain) {
            tests["chain-test"] = Q.core.rel.eq([
              Q.struct.atomProperty.macromolecular.label_asym_id(),
              chain,
            ]);
          }
          return Q.struct.generator.atomGroups(tests);
        },
        structure
      );
      const loci = StructureSelection.toLociWithSourceUnits(sel);
      plugin.managers.interactivity.lociHighlights.highlightOnly({ loci });
    } catch {
      // Highlighting unavailable; ignore.
    }
  }, [highlightResidue]);

  const legend = LEGENDS[coloring];

  return (
    <div className="cif-viewer-wrap">
      <div className="cif-viewer-label">{label}</div>
      <div ref={containerRef} className="cif-viewer-canvas" />
      {legend && (
        <div className="cif-viewer-legend">
          <span className="cif-legend-title">{legend.title}</span>
          {legend.items.map((c) => (
            <span key={c.label} className="cif-legend-item">
              <span className="cif-legend-swatch" style={{ background: c.color }} />
              {c.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
