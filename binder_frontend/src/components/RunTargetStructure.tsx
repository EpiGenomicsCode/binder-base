import { useState } from "react";
import type { BinderRun } from "../types";
import CifViewer from "./CifViewer";
import PaeViewer from "./PaeViewer";
import { LinkedSequenceBlock } from "./SequenceBlock";

// Run's target structure viewer + target sequence, hover-linked the same way.
/**
 * `paeJsonPath` is the parent protein's PAE, not a per-run file, and that is
 * correct: BoltzGen crops with res_reindex=False, so the cropped target keeps
 * the full protein's residue numbering and the two share a coordinate system.
 * Hover linking across all three panels works for the same reason.
 */
export default function RunTargetStructure({
  run,
  paeJsonPath = null,
  epitope = null,
}: {
  run: BinderRun;
  paeJsonPath?: string | null;
  epitope?: [number, number] | null;
}) {
  const [copied, setCopied] = useState(false);
  const [hoverResno, setHoverResno] = useState<number | null>(null);

  function copy() {
    if (!run.target_sequence) return;
    navigator.clipboard.writeText(run.target_sequence).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="run-target-section">
      <div className="run-section-title">DESIGN TARGET PROTEIN STRUCTURE</div>
      <div className={`run-target-body${paeJsonPath ? " has-pae" : ""}`}>
        {paeJsonPath && (
          <div className="run-target-pae">
            <PaeViewer
              paeJsonPath={paeJsonPath}
              highlightResidue={hoverResno}
              onHoverResidue={setHoverResno}
              highlightRange={epitope}
            />
          </div>
        )}
        <div className="run-target-cif">
          {run.cif_path ? (
            <CifViewer
              cifPath={run.cif_path}
              label="TARGET STRUCTURE"
              coloring="hotspot"
              highlightResidue={hoverResno}
              onHoverResidue={setHoverResno}
            />
          ) : (
            <p className="cif-modal-empty">No structure available.</p>
          )}
        </div>
        <div className="run-target-seq">
          {run.target_sequence ? (
            <>
              <div className="pd-seq-header">
                <span className="pd-chain-label">TARGET SEQUENCE</span>
                <button className="pill-btn pd-copy-btn" onClick={copy}>
                  {copied ? "Copied!" : "Copy sequence"}
                </button>
              </div>
              <LinkedSequenceBlock
                seq={run.target_sequence}
                hoverResno={hoverResno}
                onHover={setHoverResno}
              />
            </>
          ) : (
            <p className="status" style={{ padding: "1rem 1.25rem" }}>
              No sequence available.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
