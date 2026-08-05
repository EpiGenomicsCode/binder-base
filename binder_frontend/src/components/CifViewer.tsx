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
import "molstar/build/viewer/molstar.css";

/**
 * How to color the structure, and which legend to show:
 *  - "confidence": AlphaFold pLDDT bands (B-factor = pLDDT).
 *  - "hotspot":    binary hotspot encoding (B-factor > 0 = hotspot residue).
 *  - "none":       Mol* default coloring, no legend.
 */
export type CifColoring = "confidence" | "hotspot" | "none";

interface Props {
  cifPath: string;
  label: string;
  /** Coloring theme + legend. Default "confidence". */
  coloring?: CifColoring;
  /** Residue number (1-based, label_seq_id) to highlight in the 3D view, or null. */
  highlightResidue?: number | null;
  /** Called with the residue number under the cursor in the 3D view (or null). */
  onHoverResidue?: (resno: number | null) => void;
  /**
   * For multi-chain structures, restrict hover-linking to the chain whose residue
   * count matches this value (e.g. the binder chain in a target+binder complex).
   * Omit for single-chain structures.
   */
  seqChainLength?: number | null;
}

// AlphaFold model-confidence (pLDDT) bands and colors.
// https://alphafold.ebi.ac.uk — matches the "plddt-confidence" Mol* color theme.
const CONFIDENCE_LEGEND = [
  { color: "#0053D6", label: "Very high (pLDDT > 90)" },
  { color: "#65CBF3", label: "Confident (90 > pLDDT > 70)" },
  { color: "#FFDB13", label: "Low (70 > pLDDT > 50)" },
  { color: "#FF7D45", label: "Very low (pLDDT < 50)" },
];

// Design-target structures carry the hotspot selection in the B-factor column
// (score * 100 for hotspot residues, 0 for everything else) rather than pLDDT,
// so they get their own two-color theme instead of the confidence bands.
const HOTSPOT_COLOR = 0x0053d6;
const NON_HOTSPOT_COLOR = 0x65cbf3;
const HOTSPOT_THEME_NAME = "hotspot-bfactor";

const HOTSPOT_LEGEND = [
  { color: "#0053D6", label: "Hotspot residue" },
  { color: "#65CBF3", label: "Non-hotspot" },
];

const LEGENDS: Record<CifColoring, { title: string; items: typeof CONFIDENCE_LEGEND } | null> = {
  confidence: { title: "Model Confidence", items: CONFIDENCE_LEGEND },
  hotspot: { title: "Hotspot Residues", items: HOTSPOT_LEGEND },
  none: null,
};

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
        const b = StructureProperties.atom.B_iso_or_equiv(location);
        if (b > 0) return Color(HOTSPOT_COLOR);
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
}: Props) {
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
      await v.loadStructureFromUrl(`/media/${cifPath}`, "mmcif", false);
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
            return StructureProperties.atom.B_iso_or_equiv(loc) > 0
              ? "Hotspot residue"
              : "Non-hotspot";
          },
        });
      }

      const structure =
        plugin.managers.structure.hierarchy.current.structures[0]?.cell.obj?.data ?? null;
      structureRef.current = structure;
      chainAsymRef.current =
        structure && seqChainLength ? findChainAsymId(structure, seqChainLength) : null;

      // Apply the theme the legend describes, so the two always agree.
      if (coloring !== "none") {
        const themeName = coloring === "hotspot" ? HOTSPOT_THEME_NAME : "plddt-confidence";
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
                resno = StructureProperties.residue.label_seq_id(loc);
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
  }, [cifPath, coloring, seqChainLength]);

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
              Q.struct.atomProperty.macromolecular.label_seq_id(),
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
