import { useState } from "react";

export function statusClass(status: string | null): string {
  if (!status) return "s-unknown";
  const s = status.toLowerCase();
  if (s === "success") return "s-success";
  if (s === "failed" || s === "failure") return "s-failed";
  if (s === "passed") return "s-passed";
  return "s-unknown";
}


function formatSequence(seq: string): { lineNum: number; blocks: string[] }[] {
  const lines: { lineNum: number; blocks: string[] }[] = [];
  for (let i = 0; i < seq.length; i += 60) {
    const chunk = seq.slice(i, i + 60);
    const blocks: string[] = [];
    for (let j = 0; j < chunk.length; j += 10) {
      blocks.push(chunk.slice(j, j + 10));
    }
    lines.push({ lineNum: i + 1, blocks });
  }
  return lines;
}

// Sequence rendered as per-residue spans, hover-linked to a structure viewer:
// hovering a residue reports its number, and the residue matching `hoverResno`
// is highlighted. Residue number is 1-based (== label_seq_id for full models).
export function LinkedSequenceBlock({
  seq,
  hoverResno,
  onHover,
  className = "pd-seq-block",
}: {
  seq: string;
  hoverResno: number | null;
  onHover: (resno: number | null) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      {formatSequence(seq).map(({ lineNum, blocks }) => (
        <div key={lineNum} className="seq-line">
          <span className="seq-num">{lineNum}</span>
          <span className="seq-blocks">
            {blocks.map((block, bi) => (
              <span key={bi}>
                {block.split("").map((aa, ci) => {
                  const resno = lineNum + bi * 10 + ci;
                  return (
                    <span
                      key={ci}
                      className={`seq-res${hoverResno === resno ? " seq-res-hover" : ""}`}
                      onMouseEnter={() => onHover(resno)}
                      onMouseLeave={() => onHover(null)}
                    >
                      {aa}
                    </span>
                  );
                })}
                {bi < blocks.length - 1 ? " " : ""}
              </span>
            ))}
          </span>
          <span className="seq-end">{Math.min(lineNum + 59, seq.length)}</span>
        </div>
      ))}
    </div>
  );
}

// Protein sequence block + AlphaFold structure viewer, hover-linked: hovering a
// residue in either highlights it in the other. Kept as its own component so
