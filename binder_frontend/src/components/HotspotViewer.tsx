import { useEffect, useRef } from "react";
import { Viewer } from "molstar/lib/apps/viewer/app";
import { StructureElement, StructureProperties } from "molstar/lib/mol-model/structure";
import { Color } from "molstar/lib/mol-util/color";
import type { Location } from "molstar/lib/mol-model/location";
import "molstar/build/viewer/molstar.css";

// Qualitative palette — 8 visually distinct colours for up to 8 spatial clusters.
// Values are packed 0xRRGGBB integers as expected by Mol*'s Color() factory.
const CLUSTER_PALETTE = [
  0xe6194b, // red
  0x4363d8, // blue
  0x3cb44b, // green
  0xf58231, // orange
  0x911eb4, // purple
  0x42d4f4, // cyan
  0xf032e6, // magenta
  0xa9a9a9, // silver (for 8th+ cluster — unlikely but safe fallback)
];
const NON_HOTSPOT_GRAY = 0xd0d0d0; // light gray for non-cluster residues in cluster view
const CLUSTER_THEME_NAME = "cluster-palette";

interface Props {
  fileUrl: string;
  format: "mmcif" | "pdb";
  label: string;
  clusterMap?: Map<string, number>; // residueKey → clusterId; undefined = use score theme
}

const VIEWER_OPTIONS = {
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
  viewportBackgroundColor: "#f8f8f8",
};

function makeClusterColorThemeProvider(clusterMapRef: React.MutableRefObject<Map<string, number> | undefined>) {
  return {
    name: CLUSTER_THEME_NAME,
    label: "Cluster Palette",
    category: "Custom",
    isApplicable: () => true,
    defaultValues: {},
    getParams: () => ({}),
    factory: (_ctx: any, _props: any) => ({
      granularity: "group",
      color: (location: Location) => {
        if (StructureElement.Location.is(location)) {
          const chainId = StructureProperties.chain.auth_asym_id(location);
          const resNum = StructureProperties.residue.auth_seq_id(location);
          const clusterId = clusterMapRef.current?.get(`${chainId}:${resNum}`);
          if (clusterId !== undefined) {
            return Color(CLUSTER_PALETTE[(clusterId - 1) % CLUSTER_PALETTE.length]);
          }
        }
        return Color(NON_HOTSPOT_GRAY);
      },
      props: {},
    }),
  };
}

export default function HotspotViewer({ fileUrl, format, label, clusterMap }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Mutable refs readable by async callbacks and the theme factory closure
  const pluginRef = useRef<any>(null);
  const clusterMapRef = useRef<Map<string, number> | undefined>(clusterMap);

  // Keep in sync on every render so the theme factory always has the latest map
  clusterMapRef.current = clusterMap;

  async function applyCurrentTheme() {
    const plugin = pluginRef.current;
    if (!plugin) return;
    try {
      const structures = plugin.managers.structure.hierarchy.current.structures;
      if (structures.length === 0) return;
      const components = structures.flatMap((s: any) => s.components);
      const colorName = clusterMapRef.current ? CLUSTER_THEME_NAME : "uncertainty";
      await plugin.managers.structure.component.updateRepresentationsTheme(components, {
        color: colorName as any,
      });
    } catch (err) {
      console.warn("[HotspotViewer] applyCurrentTheme failed:", err);
    }
  }

  useEffect(() => {
    if (!containerRef.current) return;

    const mountNode = document.createElement("div");
    mountNode.style.cssText = "position:absolute;inset:0";
    containerRef.current.appendChild(mountNode);

    let active = true;
    let viewer: Viewer | null = null;

    const timer = window.setTimeout(async () => {
      if (!active || !containerRef.current) return;
      try {
        const v = await Viewer.create(mountNode, VIEWER_OPTIONS);
        if (!active) { v.dispose(); return; }
        viewer = v;

        // Register the cluster palette as a named colour theme.
        // The factory closure reads from clusterMapRef so it always uses the
        // latest mapping without needing to be re-registered on every update.
        const plugin = v.plugin;
        const registry = (plugin as any).representation.structure.themes.colorThemeRegistry;
        // Use has() when available, fall back to checking get() result
        const alreadyRegistered =
          typeof registry.has === "function"
            ? registry.has(CLUSTER_THEME_NAME)
            : !!registry.get(CLUSTER_THEME_NAME);
        if (!alreadyRegistered) {
          registry.add(makeClusterColorThemeProvider(clusterMapRef));
        }

        pluginRef.current = plugin;

        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        if (!active) return;

        await v.loadStructureFromUrl(fileUrl, format, false);
        if (!active) return;

        await applyCurrentTheme();
      } catch (err) {
        console.warn("[HotspotViewer] init/load error:", err);
      }
    }, 0);

    return () => {
      active = false;
      pluginRef.current = null;
      window.clearTimeout(timer);
      viewer?.dispose();
      mountNode.remove();
    };
  }, [fileUrl, format]);

  // When clusterMap changes (cluster view toggled), re-apply theme to the
  // already-loaded structure without destroying and recreating the viewer.
  useEffect(() => {
    applyCurrentTheme();
  }, [clusterMap]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="cif-viewer-wrap">
      <div className="cif-viewer-label">{label}</div>
      <div ref={containerRef} className="cif-viewer-canvas" />
    </div>
  );
}
