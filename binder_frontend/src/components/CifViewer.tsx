import { useEffect, useRef } from "react";
import { Viewer } from "molstar/lib/apps/viewer/app";
import "molstar/build/viewer/molstar.css";

interface Props {
  cifPath: string;
  label: string;
}

export default function CifViewer({ cifPath, label }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    let viewer: Viewer | null = null;

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
    }).then((v) => {
      if (disposed) { v.dispose(); return; }
      viewer = v;
      return v.loadStructureFromUrl(`/media/${cifPath}`, "mmcif", false);
    });

    return () => {
      disposed = true;
      viewer?.dispose();
    };
  }, [cifPath]);

  return (
    <div className="cif-viewer-wrap">
      <div className="cif-viewer-label">{label}</div>
      <div ref={containerRef} className="cif-viewer-canvas" />
    </div>
  );
}
