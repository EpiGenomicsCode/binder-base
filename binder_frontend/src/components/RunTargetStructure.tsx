import { useState } from "react";
import type { BinderRun } from "../types";
import type { ResidueMap } from "../utils/residueMap";
import CifViewer from "./CifViewer";
import PaeViewer from "./PaeViewer";
import { LinkedSequenceBlock } from "./SequenceBlock";

// Run's target structure viewer + target sequence, hover-linked the same way.
/**
 * Three panels, three numberings, and `residueMap` is what converts between
 * them. The structure speaks auth_seq_id, the sequence block speaks its own
 * 1..N position, and `paeJsonPath` is the parent protein's PAE, not a per-run
 * file, so the matrix is indexed over the whole UniProt sequence.
 *
 * This used to assume all three were one system, on the grounds that BoltzGen
 * crops with res_reindex=False and so preserves the parent's numbering. The
 * crops mostly do not: 62 of 69 production targets are renumbered. Without a
 * map the panels are left uncoupled rather than coupled wrongly -- an epitope
 * band on the wrong residues is a confident false statement, and a missing one
 * is not.
 */
export default function RunTargetStructure({
  run,
  paeJsonPath = null,
  epitope = [],
  residueMap = null,
}: {
  run: BinderRun;
  paeJsonPath?: string | null;
  /** Segments, not one span: a footprint patch is usually discontiguous.
   *  Written in the structure's own auth numbering, as the metadata records it. */
  epitope?: [number, number][];
  /** Converts between the panels' numberings, or null if the run has none. */
  residueMap?: ResidueMap | null;
}) {
  const [copied, setCopied] = useState(false);
  // Held in auth_seq_id, the structure's own numbering: it is the frame the
  // epitope ranges are written in and the only one every target file agrees
  // on. The other two panels convert on the way in and out.
  const [hoverAuth, setHoverAuth] = useState<number | null>(null);
  // Used only when there is no map: the sequence block still highlights the
  // letter under the cursor, it just cannot say which residue that is to
  // anything else. Guessing would be the old bug in miniature.
  const [hoverPos, setHoverPos] = useState<number | null>(null);

  function copy() {
    if (!run.target_sequence) return;
    navigator.clipboard.writeText(run.target_sequence).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const seqHover = residueMap ? residueMap.authToPosition(hoverAuth) : hoverPos;
  const paeLinked = residueMap?.hasProteinFrame ?? false;

  return (
    <div className="run-target-section">
      <div className="run-section-title">DESIGN TARGET PROTEIN STRUCTURE</div>
      <div className={`run-target-body${paeJsonPath ? " has-pae" : ""}`}>
        {paeJsonPath && (
          <div className="run-target-pae">
            <PaeViewer
              paeJsonPath={paeJsonPath}
              highlightResidue={residueMap?.authToProtein(hoverAuth) ?? null}
              onHoverResidue={
                paeLinked
                  ? (resno) => setHoverAuth(residueMap!.proteinToAuth(resno))
                  : undefined
              }
              highlightRanges={residueMap?.shiftRanges(epitope) ?? []}
            />
            {!paeLinked && (
              <p className="pae-unmapped">
                Shown over the full UniProt sequence. This run's target crop
                could not be placed in it, so the epitope is not marked and
                hovering is not linked to the panels beside it.
              </p>
            )}
          </div>
        )}
        <div className="run-target-cif">
          {run.cif_path ? (
            <CifViewer
              cifPath={run.cif_path}
              label="TARGET STRUCTURE"
              coloring="hotspot"
              highlightResidue={hoverAuth}
              onHoverResidue={setHoverAuth}
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
                hoverResno={seqHover}
                onHover={
                  residueMap
                    ? (pos) => setHoverAuth(residueMap.positionToAuth(pos))
                    : setHoverPos
                }
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
