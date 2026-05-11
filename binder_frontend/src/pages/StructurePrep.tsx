import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ScoredResidue, ClusterGroup } from "../types";
import { parseStructure, detectStructureFormat } from "../utils/structureParser";
import {
  scoreHotspots,
  reapplyThreshold,
  rescoreWithWeights,
  computeClusters,
  generatePreviewPDB,
  generateAnnotatedPDB,
  generateBoltzGenYAML,
  HOTSPOT_THRESHOLD,
  DEFAULT_WEIGHTS,
  DEFAULT_CLUSTER_WEIGHT,
} from "../utils/hotspotScorer";
import type { FormulaWeights } from "../utils/hotspotScorer";
import HotspotViewer from "../components/HotspotViewer";

type WizardStep = "upload" | "prepare" | "export";
type SortKey = "score" | "bfactor" | "exposure" | "resnum" | "chain";

// ── Helpers ───────────────────────────────────────────────────────────────────

function secStructLabel(ss: "H" | "E" | "C"): string {
  if (ss === "H") return "Helix";
  if (ss === "E") return "Strand";
  return "Loop/Coil";
}

function secStructClass(ss: "H" | "E" | "C"): string {
  if (ss === "H") return "sp-ss-helix";
  if (ss === "E") return "sp-ss-strand";
  return "sp-ss-loop";
}

function residueKey(r: ScoredResidue): string {
  return `${r.chainId}:${r.resNum}`;
}

function pct(n: number): string {
  return (n * 100).toFixed(0) + "%";
}

// ── Methodology panel ─────────────────────────────────────────────────────────

function MethodologyPanel({ isAlphaFold, open, onToggle, weights, clusterWeight }: {
  isAlphaFold: boolean;
  open: boolean;
  onToggle: () => void;
  weights: FormulaWeights;
  clusterWeight: number;
}) {
  const wSum = weights.exposure + weights.rigidity + weights.loop || 1;
  const indScale = 1 - clusterWeight;
  const expPct = Math.round((weights.exposure / wSum) * indScale * 100);
  const rigPct = Math.round((weights.rigidity / wSum) * indScale * 100);
  const loopPct = Math.round((weights.loop / wSum) * indScale * 100);
  const clusterPct = Math.round(clusterWeight * 100);

  return (
    <div className="sp-methodology">
      <button className="sp-methodology-toggle" onClick={onToggle}>
        How are hotspots identified?
        <span className={`sp-methodology-toggle-arrow ${open ? "open" : ""}`}>▾</span>
      </button>
      {open && (
        <div className="sp-methodology-body">
          <div className="sp-methodology-factor">
            <strong>Surface exposure ({expPct}%)</strong>
            Counts Cα atoms within 8 Å of each residue. Fewer neighbors means the residue
            is more surface-exposed and accessible to a binder.
          </div>
          <div className="sp-methodology-factor">
            <strong>Structural order ({rigPct}%)</strong>
            {isAlphaFold
              ? "This is an AlphaFold structure, so the pLDDT confidence score is used. High pLDDT (>70) indicates well-structured regions with reliable geometry for binder engagement."
              : "This is an experimental structure, so B-factor is used. Low B-factor indicates rigid, ordered residues that provide reliable binding geometry."}
          </div>
          <div className="sp-methodology-factor">
            <strong>Secondary structure ({loopPct}%)</strong>
            Loops and coils are statistically more surface-accessible than helices or
            β-strands, and are geometrically more flexible for binder engagement.
          </div>
          <div className="sp-methodology-factor">
            <strong>Spatial clustering ({clusterPct}%)</strong>
            Residues with many surface neighbors within 12 Å score higher — isolated
            hotspot candidates are down-weighted relative to dense surface patches, which
            are better binder targets.
          </div>
          {isAlphaFold && (
            <div className="sp-methodology-idr-note">
              <strong>IDR filter:</strong> Residues with pLDDT &lt; 70 are marked as likely
              intrinsically disordered (IDR) and excluded regardless of other scores.
              Disordered regions are poor targets for binder design because they lack a
              stable conformation.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Structure badge ───────────────────────────────────────────────────────────

function StructureBadge({ isAlphaFold }: { isAlphaFold: boolean }) {
  if (isAlphaFold) {
    return (
      <span className="sp-alphafold-badge">
        AlphaFold — pLDDT used for structural order
      </span>
    );
  }
  return (
    <span className="sp-experimental-badge">
      Experimental — B-factor used for structural order
    </span>
  );
}

// ── Score histogram ───────────────────────────────────────────────────────────

function ScoreHistogram({ residues, threshold }: { residues: ScoredResidue[]; threshold: number }) {
  const bins = 10;
  const counts = new Array<number>(bins).fill(0);
  for (const r of residues) {
    if (r.isLikelyDisordered) continue;
    const bin = Math.min(bins - 1, Math.floor(r.hotspotScore * bins));
    counts[bin]++;
  }
  const maxCount = Math.max(...counts) || 1;
  return (
    <div className="sp-histogram" title="Score distribution — teal bars exceed threshold">
      <div className="sp-histogram-bars">
        {counts.map((count, i) => {
          const binStart = i / bins;
          return (
            <div
              key={i}
              className={`sp-histogram-bar${binStart >= threshold ? " sp-histogram-bar-hot" : ""}`}
              style={{ height: `${Math.max(2, Math.round((count / maxCount) * 32))}px` }}
              title={`${(binStart * 100).toFixed(0)}–${((i + 1) / bins * 100).toFixed(0)}: ${count}`}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── Copy button ───────────────────────────────────────────────────────────────

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <button className="sp-copy-btn" onClick={handleCopy}>
      {copied ? "✓ Copied!" : label}
    </button>
  );
}

// ── Threshold slider ──────────────────────────────────────────────────────────

function ThresholdSlider({
  value,
  onChange,
  hotspotCount,
  residues,
}: {
  value: number;
  onChange: (v: number) => void;
  hotspotCount: number;
  residues?: ScoredResidue[];
}) {
  const MIN = 0.40;
  const MAX = 0.85;
  const pctFilled = ((value - MIN) / (MAX - MIN)) * 100;

  return (
    <div className="sp-threshold-row">
      <div className="sp-threshold-header">
        <span>Hotspot threshold</span>
        <span className="sp-threshold-count">{hotspotCount} hotspots</span>
      </div>
      {residues && <ScoreHistogram residues={residues} threshold={value} />}
      <input
        type="range"
        className="sp-threshold-slider"
        min={MIN}
        max={MAX}
        step={0.01}
        value={value}
        style={{ "--pct": `${pctFilled}%` } as React.CSSProperties}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <div className="sp-threshold-labels">
        <span>More ({MIN})</span>
        <span>score &gt; {value.toFixed(2)}</span>
        <span>Fewer ({MAX})</span>
      </div>
    </div>
  );
}

// ── Formula weights panel ─────────────────────────────────────────────────────

function FormulaWeightsPanel({
  weights,
  onChange,
  clusterWeight,
  onClusterWeightChange,
}: {
  weights: FormulaWeights;
  onChange: (w: FormulaWeights) => void;
  clusterWeight: number;
  onClusterWeightChange: (v: number) => void;
}) {
  const wSum = weights.exposure + weights.rigidity + weights.loop || 1;
  const expPct = Math.round((weights.exposure / wSum) * 100);
  const rigPct = Math.round((weights.rigidity / wSum) * 100);
  const loopPct = 100 - expPct - rigPct;

  return (
    <div className="sp-formula-panel">
      <div className="sp-sidebar-label">Score formula</div>
      <div className="sp-formula-row">
        <span className="sp-formula-label">Exposure</span>
        <span className="sp-formula-pct">{expPct}%</span>
        <input
          type="range"
          className="sp-formula-slider"
          min={0} max={1} step={0.05}
          value={weights.exposure}
          onChange={(e) => onChange({ ...weights, exposure: parseFloat(e.target.value) })}
        />
      </div>
      <div className="sp-formula-row">
        <span className="sp-formula-label">Rigidity</span>
        <span className="sp-formula-pct">{rigPct}%</span>
        <input
          type="range"
          className="sp-formula-slider"
          min={0} max={1} step={0.05}
          value={weights.rigidity}
          onChange={(e) => onChange({ ...weights, rigidity: parseFloat(e.target.value) })}
        />
      </div>
      <div className="sp-formula-row">
        <span className="sp-formula-label">Loop bias</span>
        <span className="sp-formula-pct">{loopPct}%</span>
        <input
          type="range"
          className="sp-formula-slider"
          min={0} max={1} step={0.05}
          value={weights.loop}
          onChange={(e) => onChange({ ...weights, loop: parseFloat(e.target.value) })}
        />
      </div>
      <div className="sp-formula-separator" />
      <div className="sp-formula-row">
        <span className="sp-formula-label">Clustering</span>
        <span className="sp-formula-pct">{Math.round(clusterWeight * 100)}%</span>
        <input
          type="range"
          className="sp-formula-slider"
          min={0} max={1} step={0.05}
          value={clusterWeight}
          onChange={(e) => onClusterWeightChange(parseFloat(e.target.value))}
        />
      </div>
      <div className="sp-formula-hint">Formula weights normalized · Clustering = spatial density bonus</div>
    </div>
  );
}

// ── Residue table ─────────────────────────────────────────────────────────────

interface ResidueTableProps {
  residues: ScoredResidue[];
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (key: SortKey) => void;
  showHotspotsOnly: boolean;
  onToggleHotspotsOnly: () => void;
  chainFilter: string;
  onChainFilter: (chain: string) => void;
  chains: string[];
  overrides: Record<string, boolean>;
  onToggleOverride?: (key: string, current: boolean) => void;
  showClusterView: boolean;
  clusterGroups?: ClusterGroup[];
  onToggleCluster?: (keys: string[], include: boolean) => void;
}

function ResidueTable({
  residues, sortKey, sortDir, onSort,
  showHotspotsOnly, onToggleHotspotsOnly,
  chainFilter, onChainFilter, chains,
  overrides, onToggleOverride,
  showClusterView, clusterGroups, onToggleCluster,
}: ResidueTableProps) {
  function sortIcon(key: SortKey) {
    if (sortKey !== key) return <span className="sort-icon">↕</span>;
    return <span className="sort-icon">{sortDir === "asc" ? "↑" : "↓"}</span>;
  }

  const displayed = useMemo(() => {
    let list = residues;
    if (chainFilter !== "all") list = list.filter((r) => r.chainId === chainFilter);
    if (showHotspotsOnly) {
      list = list.filter((r) => {
        const k = residueKey(r);
        return k in overrides ? overrides[k] : r.isHotspot;
      });
    }
    return [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "score") cmp = a.hotspotScore - b.hotspotScore;
      else if (sortKey === "bfactor") cmp = a.bFactor - b.bFactor;
      else if (sortKey === "exposure") cmp = a.exposureScore - b.exposureScore;
      else if (sortKey === "resnum") cmp = a.resNum - b.resNum;
      else if (sortKey === "chain")
        cmp = a.chainId.localeCompare(b.chainId) || a.resNum - b.resNum;
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [residues, chainFilter, showHotspotsOnly, sortKey, sortDir, overrides]);

  function renderResidueRow(r: ScoredResidue) {
    const k = residueKey(r);
    const effectiveHotspot = k in overrides ? overrides[k] : r.isHotspot;
    const isOverridden = k in overrides;
    return (
      <tr
        key={k}
        className={
          r.isLikelyDisordered
            ? "sp-row-idr"
            : effectiveHotspot
            ? "sp-row-hotspot"
            : ""
        }
      >
        <td>{r.chainId}</td>
        <td>{r.resNum}{r.insertionCode}</td>
        <td>{r.resName}</td>
        <td>
          <span className={`sp-ss-pill ${secStructClass(r.secStruct)}`}>
            {secStructLabel(r.secStruct)}
          </span>
        </td>
        <td>{pct(r.exposureScore)}</td>
        <td>{r.bFactor.toFixed(1)}</td>
        <td>
          {r.isLikelyDisordered ? (
            <span className="sp-score-val" style={{ color: "var(--gray-text)" }}>—</span>
          ) : (
            <div className="sp-score-cell">
              <div className="sp-score-bar" style={{ width: pct(r.hotspotScore) }} />
              <span className="sp-score-val">{r.hotspotScore.toFixed(2)}</span>
            </div>
          )}
        </td>
        <td>
          {r.isLikelyDisordered ? null : (
            <span
              className={`sp-hotspot-badge ${effectiveHotspot ? "sp-hotspot-yes" : "sp-hotspot-no"}`}
            >
              {effectiveHotspot ? "Yes" : "No"}
              {isOverridden ? " *" : ""}
            </span>
          )}
        </td>
        <td>
          {r.isLikelyDisordered && (
            <span className="sp-idr-badge">IDR</span>
          )}
        </td>
        <td>
          {!r.isLikelyDisordered && (
            <button
              className={`sp-override-toggle ${isOverridden ? "sp-override-active" : ""}`}
              onClick={() => onToggleOverride?.(k, effectiveHotspot)}
              title={isOverridden ? "Remove override" : "Override hotspot assignment"}
            >
              {isOverridden ? "Reset" : effectiveHotspot ? "Exclude" : "Include"}
            </button>
          )}
        </td>
      </tr>
    );
  }

  const clusterCount = clusterGroups ? clusterGroups.filter((cg) => !cg.isSingleton).length : 0;
  const totalClusterResidues = clusterGroups
    ? clusterGroups.reduce((n, cg) => n + cg.residues.length, 0)
    : 0;

  return (
    <div className="sp-residue-table-wrap">
      <div className="sp-table-filters">
        {!showClusterView && (
          <select
            value={chainFilter}
            onChange={(e) => onChainFilter(e.target.value)}
            className="sp-chain-select"
          >
            <option value="all">All chains</option>
            {chains.map((c) => (
              <option key={c} value={c}>Chain {c}</option>
            ))}
          </select>
        )}
        {!showClusterView && (
          <label className="sp-hotspot-filter-label">
            <input type="checkbox" checked={showHotspotsOnly} onChange={onToggleHotspotsOnly} />
            Hotspots only
          </label>
        )}
        {showClusterView && clusterGroups && (
          <span className="sp-cluster-summary-text">
            {clusterCount} cluster{clusterCount !== 1 ? "s" : ""} · {totalClusterResidues} hotspot residues · sorted by size
          </span>
        )}
        {!showClusterView && (
          <span className="sp-table-count">{displayed.length} residues</span>
        )}
      </div>
      <div className="sp-table-scroll">
        <table className="sp-residue-table">
          <thead>
            <tr>
              {showClusterView ? (
                <>
                  <th className="sp-th-dim">Chain</th>
                  <th className="sp-th-dim">Res#</th>
                  <th className="sp-th-dim">Name</th>
                  <th className="sp-th-dim">2° Struct</th>
                  <th className="sp-th-dim">Exposure</th>
                  <th className="sp-th-dim">B/pLDDT</th>
                  <th className="sp-th-dim">Score</th>
                  <th className="sp-th-dim">Hotspot</th>
                  <th className="sp-th-dim">Disorder</th>
                  <th className="sp-th-dim">Override</th>
                </>
              ) : (
                <>
                  <th onClick={() => onSort("chain")} className="sp-th-sortable">Chain {sortIcon("chain")}</th>
                  <th onClick={() => onSort("resnum")} className="sp-th-sortable">Res# {sortIcon("resnum")}</th>
                  <th>Name</th>
                  <th>2° Struct</th>
                  <th onClick={() => onSort("exposure")} className="sp-th-sortable">Exposure {sortIcon("exposure")}</th>
                  <th onClick={() => onSort("bfactor")} className="sp-th-sortable">B/pLDDT {sortIcon("bfactor")}</th>
                  <th onClick={() => onSort("score")} className="sp-th-sortable">Score {sortIcon("score")}</th>
                  <th>Hotspot</th>
                  <th>Disorder</th>
                  <th>Override</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {showClusterView && clusterGroups ? (
              <>
                {clusterGroups.map((cg) => {
                  const allKeys = cg.residues.map((r) => residueKey(r));
                  return (
                    <React.Fragment key={`cluster-${cg.clusterId}`}>
                      <tr className={`sp-cluster-header${cg.isSingleton ? " sp-cluster-singleton" : ""}`}>
                        <td colSpan={10} className="sp-cluster-header-cell">
                          <span className="sp-cluster-label">
                            {cg.isSingleton ? "Isolated" : `Cluster ${cg.clusterId}`}
                            <span className="sp-cluster-meta">
                              {" · "}{cg.residues.length} residue{cg.residues.length !== 1 ? "s" : ""}
                              {" · "}avg {cg.avgScore.toFixed(2)}
                            </span>
                          </span>
                          <div className="sp-cluster-actions">
                            <button
                              className="sp-cluster-btn sp-cluster-btn-include"
                              onClick={() => onToggleCluster?.(allKeys, true)}
                            >
                              Include all
                            </button>
                            <button
                              className="sp-cluster-btn sp-cluster-btn-exclude"
                              onClick={() => onToggleCluster?.(allKeys, false)}
                            >
                              Exclude all
                            </button>
                          </div>
                        </td>
                      </tr>
                      {cg.residues.map((r) => renderResidueRow(r))}
                    </React.Fragment>
                  );
                })}
                {clusterGroups.length === 0 && (
                  <tr>
                    <td colSpan={10} className="sp-table-empty">
                      No hotspots to cluster.
                    </td>
                  </tr>
                )}
              </>
            ) : (
              <>
                {displayed.map((r) => renderResidueRow(r))}
                {displayed.length === 0 && (
                  <tr>
                    <td colSpan={10} className="sp-table-empty">
                      No residues match the current filter.
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Wizard step indicator ─────────────────────────────────────────────────────

const STEPS: { key: WizardStep; label: string }[] = [
  { key: "upload", label: "Upload" },
  { key: "prepare", label: "Prepare" },
  { key: "export", label: "Export" },
];

function WizardSteps({ current, onNavigate }: {
  current: WizardStep;
  onNavigate?: (step: WizardStep) => void;
}) {
  const order: WizardStep[] = ["upload", "prepare", "export"];
  const currentIdx = order.indexOf(current);
  return (
    <div className="sp-wizard-steps">
      {STEPS.map(({ key, label }, i) => {
        const isDone = i < currentIdx;
        const isClickable = isDone && onNavigate && key !== "upload";
        const cls =
          isDone ? "sp-wizard-step done" :
          i === currentIdx ? "sp-wizard-step active" :
          "sp-wizard-step";
        return (
          <div key={key} className={cls}>
            <div
              className={`sp-wizard-step-bubble${isClickable ? " sp-wizard-step-bubble-nav" : ""}`}
              onClick={isClickable ? () => onNavigate(key) : undefined}
              role={isClickable ? "button" : undefined}
              tabIndex={isClickable ? 0 : undefined}
              onKeyDown={isClickable ? (e) => { if (e.key === "Enter" || e.key === " ") onNavigate(key); } : undefined}
            >
              {isDone ? "✓" : i + 1}
            </div>
            <span className="sp-wizard-step-label">{label}</span>
            {i < STEPS.length - 1 && <div className="sp-wizard-step-line" />}
          </div>
        );
      })}
    </div>
  );
}

// ── UploadStep ────────────────────────────────────────────────────────────────

interface UploadStepProps {
  onDone: (
    fileUrl: string,
    format: "mmcif" | "pdb",
    fileName: string,
    fileText: string,
    residues: ScoredResidue[],
    chains: string[],
    isAlphaFold: boolean
  ) => void;
  threshold: number;
  weights: FormulaWeights;
  clusterWeight: number;
}

function UploadStep({ onDone, threshold, weights, clusterWeight }: UploadStepProps) {
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function processFile(file: File) {
    const format = detectStructureFormat(file.name);
    if (!format) {
      setError("Unsupported file type. Please upload a .cif, .mmcif, or .pdb file.");
      return;
    }
    setLoading(true);
    setError(null);

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      try {
        const parsed = parseStructure(text, format);
        if (parsed.residues.length === 0)
          throw new Error("No ATOM residues found in file.");
        const scored = scoreHotspots(parsed.residues, parsed.isAlphaFold, threshold, weights, clusterWeight);
        const fileUrl = URL.createObjectURL(file);
        onDone(fileUrl, format, file.name, text, scored, parsed.chains, parsed.isAlphaFold);
      } catch (err) {
        setError((err as Error).message || "Failed to parse structure file.");
        setLoading(false);
      }
    };
    reader.onerror = () => {
      setError("Failed to read file.");
      setLoading(false);
    };
    reader.readAsText(file);
  }

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }

  return (
    <div className="sp-upload-step">
      <div className="sp-intro-card">
        <strong>Prepare a target protein for binder design:</strong>
        <ul>
          <li>Identify likely hotspot residues on the protein surface</li>
          <li>Select which chains to include and refine hotspot assignments</li>
          <li>Download an annotated PDB for use with RFdiffusion, BindCraft, or BoltzGen</li>
        </ul>
      </div>
      <div
        className={`sp-upload-zone ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".cif,.mmcif,.pdb"
          style={{ display: "none" }}
          onChange={onFileInput}
        />
        {loading ? (
          <div className="sp-upload-loading">
            <div className="sp-spinner" />
            <span>Parsing and scoring structure…</span>
          </div>
        ) : (
          <>
            <div className="sp-upload-icon">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="16 16 12 12 8 16" />
                <line x1="12" y1="12" x2="12" y2="21" />
                <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
              </svg>
            </div>
            <div className="sp-upload-hint">
              Drag &amp; drop a <strong>.cif</strong>, <strong>.mmcif</strong>, or{" "}
              <strong>.pdb</strong> file here, or click to browse
            </div>
            <div className="sp-upload-subhint">
              AlphaFold and experimental PDB structures both supported
            </div>
          </>
        )}
      </div>
      {error && <div className="sp-error">{error}</div>}
    </div>
  );
}

// ── PrepareStep ───────────────────────────────────────────────────────────────

interface PrepareStepProps {
  annotatedUrl: string;
  fileName: string;
  residues: ScoredResidue[];
  chains: string[];
  isAlphaFold: boolean;
  selectedChains: Set<string>;
  onChainToggle: (chain: string) => void;
  overrides: Record<string, boolean>;
  onToggleOverride: (key: string, current: boolean) => void;
  onClearOverrides: () => void;
  onToggleCluster: (keys: string[], include: boolean) => void;
  threshold: number;
  onThresholdChange: (v: number) => void;
  weights: FormulaWeights;
  onWeightsChange: (w: FormulaWeights) => void;
  clusterWeight: number;
  onClusterWeightChange: (v: number) => void;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (key: SortKey) => void;
  showHotspotsOnly: boolean;
  onToggleHotspotsOnly: () => void;
  chainFilter: string;
  onChainFilter: (c: string) => void;
  methodologyOpen: boolean;
  onToggleMethodology: () => void;
  onReset: () => void;
  onNext: () => void;
}

function PrepareStep({
  annotatedUrl, fileName, residues, chains, isAlphaFold,
  selectedChains, onChainToggle,
  overrides, onToggleOverride, onClearOverrides, onToggleCluster,
  threshold, onThresholdChange,
  weights, onWeightsChange,
  clusterWeight, onClusterWeightChange,
  sortKey, sortDir, onSort,
  showHotspotsOnly, onToggleHotspotsOnly,
  chainFilter, onChainFilter,
  methodologyOpen, onToggleMethodology,
  onReset, onNext,
}: PrepareStepProps) {
  const [showClusterView, setShowClusterView] = useState(false);

  const effectiveHotspotCount = residues.filter((r) => {
    const k = residueKey(r);
    return k in overrides ? overrides[k] : r.isHotspot;
  }).length;
  const idrCount = residues.filter((r) => r.isLikelyDisordered).length;
  const overrideCount = Object.keys(overrides).length;
  const canProceed = effectiveHotspotCount > 0 && selectedChains.size > 0;

  const clusterGroups = useMemo(
    () => showClusterView ? computeClusters(residues, overrides) : undefined,
    [residues, overrides, showClusterView]
  );

  const clusterMap = useMemo<Map<string, number> | undefined>(() => {
    if (!showClusterView || !clusterGroups) return undefined;
    const m = new Map<string, number>();
    for (const cg of clusterGroups) {
      for (const r of cg.residues) {
        m.set(residueKey(r), cg.clusterId);
      }
    }
    return m;
  }, [showClusterView, clusterGroups]);

  const chainResCount = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of residues) m[r.chainId] = (m[r.chainId] ?? 0) + 1;
    return m;
  }, [residues]);

  return (
    <div className="sp-prepare-step">
      <div className="sp-step-header">
        <div>
          <h2 className="sp-step-title">
            Prepare structure
            <StructureBadge isAlphaFold={isAlphaFold} />
          </h2>
          <p className="sp-step-desc">
            {fileName} — {residues.length} residues, {chains.length} chain(s).{" "}
            <strong>{effectiveHotspotCount}</strong> predicted hotspot{effectiveHotspotCount !== 1 ? "s" : ""} at
            score &gt; {threshold.toFixed(2)}.
            {idrCount > 0 && (
              <> <span className="sp-idr-count">{idrCount} IDR residues excluded.</span></>
            )}
          </p>
        </div>
        <div className="sp-step-header-actions">
          <button className="sp-btn-ghost" onClick={onReset} title="Load a different file">
            ↺ New file
          </button>
          <button
            className="sp-btn-primary"
            onClick={onNext}
            disabled={!canProceed}
          >
            Export →
          </button>
        </div>
      </div>

      {effectiveHotspotCount === 0 && (
        <p className="sp-warn">No hotspots at this threshold — lower the slider or adjust scoring parameters.</p>
      )}
      {effectiveHotspotCount > 0 && selectedChains.size === 0 && (
        <p className="sp-warn">Select at least one chain to export.</p>
      )}

      <MethodologyPanel
        isAlphaFold={isAlphaFold}
        open={methodologyOpen}
        onToggle={onToggleMethodology}
        weights={weights}
        clusterWeight={clusterWeight}
      />

      {overrideCount > 0 && (
        <div className="sp-refine-summary">
          <span className="sp-summary-stat">
            <strong>{effectiveHotspotCount}</strong> hotspot residues
          </span>
          <span className="sp-summary-dot">·</span>
          <span className="sp-summary-stat">
            <strong>{selectedChains.size}</strong> chain{selectedChains.size !== 1 ? "s" : ""} selected
          </span>
          <span className="sp-summary-dot">·</span>
          <span className="sp-summary-overrides">
            {overrideCount} manual override{overrideCount !== 1 ? "s" : ""}
          </span>
          <button className="sp-clear-overrides-btn" onClick={onClearOverrides}>
            Clear overrides
          </button>
        </div>
      )}

      <div className="sp-prepare-layout">
        <div className="sp-viewer-pane">
          <HotspotViewer
            fileUrl={annotatedUrl}
            format="pdb"
            label={showClusterView ? "Cluster view (each color = one spatial cluster)" : "Hotspot scores (orange/red = hotspot, blue = non-hotspot)"}
            clusterMap={clusterMap}
          />
        </div>
        <div className="sp-sidebar">
          <div className="sp-sidebar-section">
            <ThresholdSlider
              value={threshold}
              onChange={onThresholdChange}
              hotspotCount={effectiveHotspotCount}
              residues={residues}
            />
          </div>
          <div className="sp-sidebar-section">
            <FormulaWeightsPanel
              weights={weights}
              onChange={onWeightsChange}
              clusterWeight={clusterWeight}
              onClusterWeightChange={onClusterWeightChange}
            />
          </div>
          <div className="sp-sidebar-section">
            <div className="sp-sidebar-label">Chains to export</div>
            <div className="sp-chain-selector">
              {chains.map((c) => (
                <label key={c} className="sp-chain-checkbox-row">
                  <input
                    type="checkbox"
                    checked={selectedChains.has(c)}
                    onChange={() => onChainToggle(c)}
                  />
                  Chain {c} ({chainResCount[c] ?? 0} res)
                </label>
              ))}
            </div>
          </div>
          <div className="sp-sidebar-section">
            <div className="sp-sidebar-label">Color key</div>
            {showClusterView && clusterGroups ? (
              <div className="sp-legend">
                {clusterGroups.map((cg) => {
                  const PALETTE = ["#e6194b","#4363d8","#3cb44b","#f58231","#911eb4","#42d4f4","#f032e6","#a9a9a9"];
                  const color = PALETTE[(cg.clusterId - 1) % PALETTE.length];
                  return (
                    <div key={cg.clusterId} className="sp-legend-row">
                      <span className="sp-legend-swatch" style={{ background: color }} />
                      {cg.isSingleton ? "Isolated" : `Cluster ${cg.clusterId}`}
                      <span className="sp-cluster-meta"> · {cg.residues.length} res</span>
                    </div>
                  );
                })}
                <div className="sp-legend-row">
                  <span className="sp-legend-swatch" style={{ background: "#d0d0d0" }} />
                  Non-hotspot
                </div>
              </div>
            ) : (
              <div className="sp-legend">
                <div className="sp-legend-row">
                  <span className="sp-legend-swatch" style={{ background: "#bf2222" }} />
                  Hotspot (high score)
                </div>
                <div className="sp-legend-row">
                  <span className="sp-legend-swatch" style={{ background: "#adbff3" }} />
                  Surface (lower score)
                </div>
                <div className="sp-legend-row">
                  <span className="sp-legend-swatch" style={{ background: "#3361e1" }} />
                  Buried / IDR (score = 0)
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="sp-table-view-toggle">
        <label className="sp-hotspot-filter-label">
          <input
            type="checkbox"
            checked={showClusterView}
            onChange={() => setShowClusterView((v) => !v)}
          />
          Group by spatial cluster
        </label>
      </div>

      <ResidueTable
        residues={residues}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
        showHotspotsOnly={showHotspotsOnly}
        onToggleHotspotsOnly={onToggleHotspotsOnly}
        chainFilter={chainFilter}
        onChainFilter={onChainFilter}
        chains={chains}
        overrides={overrides}
        onToggleOverride={onToggleOverride}
        showClusterView={showClusterView}
        clusterGroups={clusterGroups}
        onToggleCluster={onToggleCluster}
      />
    </div>
  );
}

// ── ExportStep ────────────────────────────────────────────────────────────────

interface ExportStepProps {
  fileText: string;
  fileFormat: "mmcif" | "pdb";
  fileName: string;
  residues: ScoredResidue[];
  selectedChains: Set<string>;
  overrides: Record<string, boolean>;
  threshold: number;
  isAlphaFold: boolean;
  onBack: () => void;
  onReset: () => void;
}

function ExportStep({
  fileText, fileFormat, fileName,
  residues, selectedChains, overrides, threshold,
  isAlphaFold,
  onBack, onReset,
}: ExportStepProps) {
  const [downloaded, setDownloaded] = useState(false);

  const effectiveHotspots = residues.filter((r) => {
    if (!selectedChains.has(r.chainId)) return false;
    const k = residueKey(r);
    return k in overrides ? overrides[k] : r.isHotspot;
  });

  const keptResidues = residues.filter((r) => selectedChains.has(r.chainId));

  const rfDiffusionString = `[${effectiveHotspots.map((r) => `${r.chainId}${r.resNum}`).join(",")}]`;

  const boltzGenYAML = generateBoltzGenYAML(
    residues, selectedChains, overrides, fileName, isAlphaFold
  );

  const hotspotsByChain = useMemo(() => {
    const m: Record<string, number[]> = {};
    for (const r of effectiveHotspots) {
      if (!m[r.chainId]) m[r.chainId] = [];
      m[r.chainId].push(r.resNum);
    }
    return m;
  }, [effectiveHotspots]);

  function handleDownload() {
    const pdbText = generateAnnotatedPDB(
      fileText, fileFormat, residues, selectedChains, overrides, threshold
    );
    const blob = new Blob([pdbText], { type: "chemical/x-pdb" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const baseName = fileName.replace(/\.(cif|mmcif|pdb)$/i, "");
    a.href = url;
    a.download = `${baseName}_annotated.pdb`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setDownloaded(true);
  }

  const boltzRows = boltzGenYAML.split("\n").length;

  return (
    <div className="sp-export-step">
      <div className="sp-step-header">
        <div>
          <h2 className="sp-step-title">Export annotated structure</h2>
          <p className="sp-step-desc">
            Download a cleaned PDB with hotspot scores encoded in the B-factor column
            (score × 100). Use the snippets below to configure RFdiffusion or BoltzGen.
          </p>
        </div>
        <button className="sp-btn-secondary" onClick={onBack}>← Back</button>
      </div>

      <div className="sp-export-summary">
        <div className="sp-export-stat">
          <div className="sp-export-stat-value">{keptResidues.length}</div>
          <div className="sp-export-stat-label">Residues kept</div>
        </div>
        <div className="sp-export-stat">
          <div className="sp-export-stat-value">{effectiveHotspots.length}</div>
          <div className="sp-export-stat-label">Hotspot residues</div>
        </div>
        <div className="sp-export-stat">
          <div className="sp-export-stat-value">{selectedChains.size}</div>
          <div className="sp-export-stat-label">Chain{selectedChains.size !== 1 ? "s" : ""}</div>
        </div>
        <div className="sp-export-stat">
          <div className="sp-export-stat-value">{Object.keys(overrides).length}</div>
          <div className="sp-export-stat-label">Overrides</div>
        </div>
      </div>

      <div className="sp-export-copy-section">
        <div className="sp-export-copy-header">
          <span>RFdiffusion <code>contigmap.hotspot_res</code></span>
          <CopyButton text={rfDiffusionString} />
        </div>
        <textarea
          className="sp-copy-textarea"
          readOnly
          rows={2}
          value={rfDiffusionString}
          onClick={(e) => (e.target as HTMLTextAreaElement).select()}
        />
      </div>

      <div className="sp-export-copy-section">
        <div className="sp-export-copy-header">
          <span>BoltzGen YAML</span>
          <CopyButton text={boltzGenYAML} label="Copy YAML" />
        </div>
        <textarea
          className="sp-copy-textarea sp-copy-textarea-yaml"
          readOnly
          rows={Math.min(boltzRows + 1, 18)}
          value={boltzGenYAML}
          onClick={(e) => (e.target as HTMLTextAreaElement).select()}
          spellCheck={false}
        />
      </div>

      {effectiveHotspots.length > 0 && (
        <details className="sp-hotspot-details">
          <summary className="sp-hotspot-details-summary">
            View {effectiveHotspots.length} hotspot residue{effectiveHotspots.length !== 1 ? "s" : ""} by chain
          </summary>
          <div className="sp-hotspot-details-body">
            {Object.entries(hotspotsByChain).sort(([a], [b]) => a.localeCompare(b)).map(([chain, nums]) => (
              <div key={chain} className="sp-hotspot-chain-group">
                <span className="sp-hotspot-chain-label">Chain {chain}:</span>
                <span className="sp-hotspot-chain-residues">{nums.sort((a, b) => a - b).join(", ")}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      <div className="sp-export-actions">
        <button className="sp-download-btn" onClick={handleDownload}>
          ↓ Download annotated PDB
        </button>
        {downloaded && (
          <div className="sp-download-success">
            File downloaded. Open in PyMOL, UCSF ChimeraX, or use directly with
            RFdiffusion / BindCraft / BoltzGen.
          </div>
        )}
      </div>

      <div className="sp-export-notes">
        <strong>B-factor encoding:</strong> Hotspot residues have B-factor = hotspot_score × 100
        (range ~{Math.round(threshold * 100)}–100). Non-hotspot and IDR residues have B-factor = 0.
      </div>

      <button className="sp-start-over-btn" onClick={onReset}>
        Start over with a new structure
      </button>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function StructurePrep() {
  const [step, setStep] = useState<WizardStep>("upload");
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [fileFormat, setFileFormat] = useState<"mmcif" | "pdb" | null>(null);
  const [fileName, setFileName] = useState("");
  const [fileText, setFileText] = useState("");
  const [residues, setResidues] = useState<ScoredResidue[]>([]);
  const [chains, setChains] = useState<string[]>([]);
  const [selectedChains, setSelectedChains] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [isAlphaFold, setIsAlphaFold] = useState(false);
  const [threshold, setThreshold] = useState(HOTSPOT_THRESHOLD);
  const [weights, setWeights] = useState<FormulaWeights>(DEFAULT_WEIGHTS);
  const [clusterWeight, setClusterWeight] = useState(DEFAULT_CLUSTER_WEIGHT);
  const [methodologyOpen, setMethodologyOpen] = useState(false);

  const [annotatedUrl, setAnnotatedUrl] = useState<string | null>(null);
  const prevAnnotatedUrlRef = useRef<string | null>(null);

  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [showHotspotsOnly, setShowHotspotsOnly] = useState(false);
  const [chainFilter, setChainFilter] = useState("all");

  const prevFileUrl = useRef<string | null>(null);

  function refreshAnnotatedUrl(scored: ScoredResidue[], ovr: Record<string, boolean>) {
    const pdb = generatePreviewPDB(scored, ovr);
    const blob = new Blob([pdb], { type: "chemical/x-pdb" });
    const url = URL.createObjectURL(blob);
    if (prevAnnotatedUrlRef.current) URL.revokeObjectURL(prevAnnotatedUrlRef.current);
    prevAnnotatedUrlRef.current = url;
    setAnnotatedUrl(url);
  }

  function handleUploadDone(
    url: string,
    fmt: "mmcif" | "pdb",
    name: string,
    text: string,
    scored: ScoredResidue[],
    parsedChains: string[],
    alphaFold: boolean
  ) {
    setFileUrl(url);
    setFileFormat(fmt);
    setFileName(name);
    setFileText(text);
    setResidues(scored);
    setChains(parsedChains);
    setSelectedChains(new Set(parsedChains));
    setOverrides({});
    setIsAlphaFold(alphaFold);
    setChainFilter("all");
    refreshAnnotatedUrl(scored, {});
    setStep("prepare");
  }

  function handleReset() {
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    if (prevAnnotatedUrlRef.current) URL.revokeObjectURL(prevAnnotatedUrlRef.current);
    prevAnnotatedUrlRef.current = null;
    setFileUrl(null);
    setAnnotatedUrl(null);
    setFileFormat(null);
    setFileName("");
    setFileText("");
    setResidues([]);
    setChains([]);
    setSelectedChains(new Set());
    setOverrides({});
    setIsAlphaFold(false);
    setThreshold(HOTSPOT_THRESHOLD);
    setWeights(DEFAULT_WEIGHTS);
    setClusterWeight(DEFAULT_CLUSTER_WEIGHT);
    setChainFilter("all");
    setStep("upload");
  }

  function handleChainToggle(chain: string) {
    setSelectedChains((prev) => {
      const next = new Set(prev);
      if (next.has(chain)) next.delete(chain);
      else next.add(chain);
      return next;
    });
  }

  function handleThresholdChange(value: number) {
    setThreshold(value);
    const updated = reapplyThreshold(residues, value);
    setResidues(updated);
    refreshAnnotatedUrl(updated, overrides);
  }

  function handleWeightsChange(newWeights: FormulaWeights) {
    setWeights(newWeights);
    const updated = rescoreWithWeights(residues, newWeights, clusterWeight, threshold);
    setResidues(updated);
    refreshAnnotatedUrl(updated, overrides);
  }

  function handleClusterWeightChange(value: number) {
    setClusterWeight(value);
    const updated = rescoreWithWeights(residues, weights, value, threshold);
    setResidues(updated);
    refreshAnnotatedUrl(updated, overrides);
  }

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("desc"); }
  }

  const handleToggleOverride = useCallback(
    (key: string, currentValue: boolean) => {
      setOverrides((prev) => {
        const next = { ...prev };
        const original = residues.find((r) => residueKey(r) === key);
        if (key in prev) {
          delete next[key];
        } else {
          next[key] = !currentValue;
        }
        if (original && key in next && next[key] === original.isHotspot) {
          delete next[key];
        }
        refreshAnnotatedUrl(residues, next);
        return next;
      });
    },
    [residues]
  );

  function handleClearOverrides() {
    setOverrides({});
    refreshAnnotatedUrl(residues, {});
  }

  function handleToggleCluster(keys: string[], include: boolean) {
    setOverrides((prev) => {
      const next = { ...prev };
      for (const key of keys) {
        const original = residues.find((r) => residueKey(r) === key);
        if (include) {
          if (original?.isHotspot) delete next[key];
          else next[key] = true;
        } else {
          if (original && !original.isHotspot) delete next[key];
          else next[key] = false;
        }
      }
      refreshAnnotatedUrl(residues, next);
      return next;
    });
  }

  useEffect(() => {
    prevFileUrl.current = fileUrl;
    return () => {
      if (prevFileUrl.current) URL.revokeObjectURL(prevFileUrl.current);
    };
  }, [fileUrl]);

  return (
    <div className="sp-page">
      <div className="sp-page-header">
        <h1 className="sp-page-title">Structure Prep</h1>
        <p className="sp-page-subtitle">
          Prepare a target structure for binder design — identify surface hotspots,
          exclude disordered regions, and export an annotated PDB.
        </p>
      </div>

      <WizardSteps current={step} onNavigate={setStep} />

      <div className="sp-step-content">
        {step === "upload" && (
          <UploadStep
            onDone={handleUploadDone}
            threshold={threshold}
            weights={weights}
            clusterWeight={clusterWeight}
          />
        )}
        {step === "prepare" && annotatedUrl && (
          <PrepareStep
            annotatedUrl={annotatedUrl}
            fileName={fileName}
            residues={residues}
            chains={chains}
            isAlphaFold={isAlphaFold}
            selectedChains={selectedChains}
            onChainToggle={handleChainToggle}
            overrides={overrides}
            onToggleOverride={handleToggleOverride}
            onClearOverrides={handleClearOverrides}
            onToggleCluster={handleToggleCluster}
            threshold={threshold}
            onThresholdChange={handleThresholdChange}
            weights={weights}
            onWeightsChange={handleWeightsChange}
            clusterWeight={clusterWeight}
            onClusterWeightChange={handleClusterWeightChange}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            showHotspotsOnly={showHotspotsOnly}
            onToggleHotspotsOnly={() => setShowHotspotsOnly((v) => !v)}
            chainFilter={chainFilter}
            onChainFilter={setChainFilter}
            methodologyOpen={methodologyOpen}
            onToggleMethodology={() => setMethodologyOpen((v) => !v)}
            onReset={handleReset}
            onNext={() => setStep("export")}
          />
        )}
        {step === "export" && fileFormat && (
          <ExportStep
            fileText={fileText}
            fileFormat={fileFormat}
            fileName={fileName}
            residues={residues}
            selectedChains={selectedChains}
            overrides={overrides}
            threshold={threshold}
            isAlphaFold={isAlphaFold}
            onBack={() => setStep("prepare")}
            onReset={handleReset}
          />
        )}
      </div>
    </div>
  );
}
