import { useEffect, useRef } from "react";
import { Viewer } from "molstar/lib/apps/viewer/app";
import "molstar/build/viewer/molstar.css";

interface Props {
  fileUrl: string;
  format: "mmcif" | "pdb";
  label: string;
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

export default function HotspotViewer({ fileUrl, format, label }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Create a fresh child div for each viewer instance so that each call to
    // Viewer.create() — which internally calls createRoot(mountNode) — always
    // gets a virgin DOM node. Molstar never unmounts its React root on dispose(),
    // so reusing the same node would call createRoot() on it twice and trigger
    // a React warning. Removing the node in cleanup orphans the old root cleanly.
    const mountNode = document.createElement("div");
    mountNode.style.cssText = "position:absolute;inset:0";
    containerRef.current.appendChild(mountNode);

    let active = true;
    let viewer: Viewer | null = null;

    // setTimeout(0) defers Viewer.create() past React StrictMode's synchronous
    // cleanup/remount cycle. In development, StrictMode intentionally runs
    // mount → cleanup → mount. The cleanup calls clearTimeout before the
    // deferred callback fires, so only the second (real) mount ever reaches
    // Viewer.create(). Without this, two Viewer instances initialise on the
    // same container concurrently, corrupting the WebGL context.
    //
    // Each fileUrl change destroys and recreates the viewer so Molstar always
    // has exactly one structure loaded. (loadStructureFromUrl adds to the state
    // tree rather than replacing, so reuse would accumulate structures.)
    const timer = window.setTimeout(async () => {
      if (!active || !containerRef.current) return;
      try {
        const v = await Viewer.create(mountNode, VIEWER_OPTIONS);
        if (!active) { v.dispose(); return; }
        viewer = v;

        // Yield one animation frame so the browser has sized the WebGL canvas
        // before Molstar tries to render into it.  Without this, a freshly-
        // mounted viewer gets a 0×0 canvas (data arrives via blob URL before
        // the first paint), producing a blank viewport.  Server URLs (CifViewer)
        // don't need this because the network latency provides a natural gap.
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        if (!active) return;

        await v.loadStructureFromUrl(fileUrl, format, false);
        if (!active) return;

        // Apply B-factor (uncertainty) colour theme to show hotspot scores.
        const plugin = v.plugin;
        const structures = plugin.managers.structure.hierarchy.current.structures;
        if (structures.length > 0) {
          const components = structures.flatMap((s) => s.components);
          await plugin.managers.structure.component.updateRepresentationsTheme(components, {
            color: "uncertainty" as any,
          });
        }
      } catch {
        // Silently ignore init/load errors (disposed viewer, WebGL unavailable, etc.)
      }
    }, 0);

    return () => {
      active = false;
      window.clearTimeout(timer);
      viewer?.dispose();
      mountNode.remove();
    };
  }, [fileUrl, format]);

  return (
    <div className="cif-viewer-wrap">
      <div className="cif-viewer-label">{label}</div>
      <div ref={containerRef} className="cif-viewer-canvas" />
    </div>
  );
}
