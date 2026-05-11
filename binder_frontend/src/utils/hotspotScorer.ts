import type { ParsedResidue, ScoredResidue, ClusterGroup } from "../types";

const NEIGHBOR_RADIUS = 8.0; // Å, Cα–Cα
export const CLUSTER_RADIUS = 12.0; // Å, for spatial clustering bonus
const PLDDT_IDR_THRESHOLD = 70; // AlphaFold: below this = likely IDR
const DEFAULT_THRESHOLD = 0.60; // raised from 0.55

export interface FormulaWeights {
  exposure: number;
  rigidity: number;
  loop: number;
}

export const DEFAULT_WEIGHTS: FormulaWeights = { exposure: 0.4, rigidity: 0.3, loop: 0.3 };
export const DEFAULT_CLUSTER_WEIGHT = 0.2;

function dist(a: ParsedResidue, b: ParsedResidue): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function scoreHotspots(
  residues: ParsedResidue[],
  isAlphaFold: boolean,
  threshold = DEFAULT_THRESHOLD,
  weights: FormulaWeights = DEFAULT_WEIGHTS,
  clusterWeight = DEFAULT_CLUSTER_WEIGHT
): ScoredResidue[] {
  if (residues.length === 0) return [];

  // Heavy step: neighbor density (O(n²)), runs once on upload.
  // Single merged loop computes both 8 Å neighbor counts (exposure) and 12 Å cluster counts.
  const counts = new Array<number>(residues.length).fill(0);
  const clusterCounts = new Array<number>(residues.length).fill(0);
  for (let i = 0; i < residues.length; i++) {
    for (let j = i + 1; j < residues.length; j++) {
      const d = dist(residues[i], residues[j]);
      if (d < NEIGHBOR_RADIUS) { counts[i]++; counts[j]++; }
      if (d < CLUSTER_RADIUS)  { clusterCounts[i]++; clusterCounts[j]++; }
    }
  }
  const maxCount = Math.max(...counts) || 1;
  const maxClusterCount = Math.max(...clusterCounts) || 1;

  const bFactors = residues.map((r) => r.bFactor);
  const bMin = Math.min(...bFactors);
  const bRange = (Math.max(...bFactors) - bMin) || 1;

  const wSum = weights.exposure + weights.rigidity + weights.loop || 1;
  const wE = weights.exposure / wSum;
  const wR = weights.rigidity / wSum;
  const wL = weights.loop / wSum;

  return residues.map((r, i) => {
    const exposureScore = 1 - counts[i] / maxCount;
    const isLoop = r.secStruct === "C";
    const rawClusterDensity = clusterCounts[i] / maxClusterCount;

    let isLikelyDisordered: boolean;
    let rigidityScore: number;
    let normalizedB: number;

    if (isAlphaFold) {
      normalizedB = r.bFactor / 100;
      isLikelyDisordered = r.bFactor < PLDDT_IDR_THRESHOLD;
      rigidityScore = normalizedB;
    } else {
      normalizedB = (r.bFactor - bMin) / bRange;
      isLikelyDisordered = normalizedB > 0.90;
      rigidityScore = 1 - normalizedB;
    }

    const individualScore = wE * exposureScore + wR * rigidityScore + wL * (isLoop ? 1 : 0);
    const hotspotScore = isLikelyDisordered
      ? 0
      : Math.round(
          ((1 - clusterWeight) * individualScore + clusterWeight * rawClusterDensity) * 1000
        ) / 1000;

    return {
      ...r,
      neighborCount: counts[i],
      exposureScore: Math.round(exposureScore * 1000) / 1000,
      normalizedB: Math.round(normalizedB * 1000) / 1000,
      rigidityScore: Math.round(rigidityScore * 1000) / 1000,
      rawClusterDensity: Math.round(rawClusterDensity * 1000) / 1000,
      hotspotScore,
      isHotspot: !isLikelyDisordered && hotspotScore > threshold,
      isLikelyDisordered,
    };
  });
}

// Fast path for threshold slider — does not recompute scores.
export function reapplyThreshold(residues: ScoredResidue[], threshold: number): ScoredResidue[] {
  return residues.map((r) => ({
    ...r,
    isHotspot: !r.isLikelyDisordered && r.hotspotScore > threshold,
  }));
}

// Fast path for weight/cluster changes — O(n), uses stored sub-scores.
export function rescoreWithWeights(
  residues: ScoredResidue[],
  weights: FormulaWeights,
  clusterWeight: number,
  threshold: number
): ScoredResidue[] {
  const wSum = weights.exposure + weights.rigidity + weights.loop || 1;
  const wE = weights.exposure / wSum;
  const wR = weights.rigidity / wSum;
  const wL = weights.loop / wSum;

  return residues.map((r) => {
    if (r.isLikelyDisordered) return r;
    const isLoop = r.secStruct === "C";
    const individualScore = wE * r.exposureScore + wR * r.rigidityScore + wL * (isLoop ? 1 : 0);
    const hotspotScore = Math.round(
      ((1 - clusterWeight) * individualScore + clusterWeight * r.rawClusterDensity) * 1000
    ) / 1000;
    return { ...r, hotspotScore, isHotspot: hotspotScore > threshold };
  });
}

// BFS connected-components on the effective hotspot set within CLUSTER_RADIUS.
// Clusters are ordered by size desc (largest first); singletons at the end.
export function computeClusters(
  residues: ScoredResidue[],
  overrides: Record<string, boolean>
): ClusterGroup[] {
  const hotspots = residues.filter((r) => {
    if (r.isLikelyDisordered) return false;
    const k = `${r.chainId}:${r.resNum}`;
    return k in overrides ? overrides[k] : r.isHotspot;
  });

  if (hotspots.length === 0) return [];

  const n = hotspots.length;
  const visited = new Array<boolean>(n).fill(false);
  const rawGroups: ScoredResidue[][] = [];

  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    const group: ScoredResidue[] = [];
    const queue = [i];
    visited[i] = true;
    while (queue.length > 0) {
      const cur = queue.shift()!;
      group.push(hotspots[cur]);
      for (let j = 0; j < n; j++) {
        if (!visited[j] && dist(hotspots[cur], hotspots[j]) < CLUSTER_RADIUS) {
          visited[j] = true;
          queue.push(j);
        }
      }
    }
    rawGroups.push(group);
  }

  const clusterAvg = (rs: ScoredResidue[]) =>
    rs.reduce((s, r) => s + r.hotspotScore, 0) / (rs.length || 1);

  rawGroups.sort((a, b) => b.length - a.length || clusterAvg(b) - clusterAvg(a));

  return rawGroups.map((members, i) => ({
    clusterId: i + 1,
    residues: [...members].sort((a, b) => b.hotspotScore - a.hotspotScore),
    avgScore: Math.round(clusterAvg(members) * 1000) / 1000,
    isSingleton: members.length === 1,
  }));
}

export { DEFAULT_THRESHOLD as HOTSPOT_THRESHOLD };

// Helper: find contiguous runs in a sorted array of integers
function getContiguousRuns(sortedNums: number[]): [number, number][] {
  const runs: [number, number][] = [];
  if (sortedNums.length === 0) return runs;
  let start = sortedNums[0];
  let prev = sortedNums[0];
  for (let i = 1; i < sortedNums.length; i++) {
    if (sortedNums[i] !== prev + 1) {
      runs.push([start, prev]);
      start = sortedNums[i];
    }
    prev = sortedNums[i];
  }
  runs.push([start, prev]);
  return runs;
}

// Generate a BoltzGen YAML input template.
// binding_types: per selected chain, min..max of effective hotspot residue numbers.
// structure_groups: AlphaFold only — contiguous IDR runs get visibility: 0.
export function generateBoltzGenYAML(
  residues: ScoredResidue[],
  selectedChains: Set<string>,
  overrides: Record<string, boolean>,
  fileName: string,
  isAlphaFold: boolean
): string {
  const chainOrder = [...selectedChains].sort();
  const lines: string[] = [];

  lines.push("entities:");
  lines.push("  - protein:");
  lines.push("      id: B");
  lines.push("      sequence: 50..80          # adjust designed binder length");
  lines.push("  - file:");
  lines.push(`      path: ${fileName}`);
  lines.push("      include:");
  for (const chain of chainOrder) {
    lines.push(`        - chain: { id: ${chain} }`);
  }

  if (isAlphaFold) {
    const hasIDR = residues.some((r) => selectedChains.has(r.chainId) && r.isLikelyDisordered);
    if (hasIDR) {
      lines.push("      structure_groups:");
      for (const chain of chainOrder) {
        lines.push(`        - group: { visibility: 1, id: ${chain} }`);
        const idrNums = residues
          .filter((r) => r.chainId === chain && r.isLikelyDisordered)
          .map((r) => r.resNum)
          .sort((a, b) => a - b);
        for (const [start, end] of getContiguousRuns(idrNums)) {
          const range = start === end ? `${start}` : `${start}..${end}`;
          lines.push(`        - group: { visibility: 0, id: ${chain}, res_index: ${range} }`);
        }
      }
    }
  }

  lines.push("      binding_types:");
  let hasAnyBinding = false;
  for (const chain of chainOrder) {
    const hotspots = residues.filter((r) => {
      if (r.chainId !== chain) return false;
      const k = `${r.chainId}:${r.resNum}`;
      return k in overrides ? overrides[k] : r.isHotspot;
    });
    if (hotspots.length === 0) continue;
    hasAnyBinding = true;
    const resNums = hotspots.map((r) => r.resNum).sort((a, b) => a - b);
    const minRes = resNums[0];
    const maxRes = resNums[resNums.length - 1];
    const range = minRes === maxRes ? `${minRes}` : `${minRes}..${maxRes}`;
    lines.push(`        - chain: { id: ${chain}, binding: ${range} }`);
  }
  if (!hasAnyBinding) {
    lines.push("        []  # no hotspot residues — refine selections before using");
  }

  return lines.join("\n");
}

// Generate a Cα-only PDB with hotspot scores encoded in the B-factor column.
// Used for the 3D viewer (not for export) — all chains included.
// B-factor encoding:
//   Hotspot:     hotspotScore × 100  (orange/red in Molstar uncertainty theme)
//   Non-hotspot: hotspotScore × 40   (blue/teal — still shows gradient)
//   IDR:         0                   (darkest blue)
export function generatePreviewPDB(
  scoredResidues: ScoredResidue[],
  overrides: Record<string, boolean>
): string {
  const lines = ["REMARK   1 Hotspot preview — B-factor = hotspot score encoding"];
  let serial = 1;

  for (const r of scoredResidues) {
    const overrideKey = `${r.chainId}:${r.resNum}`;
    const effectiveHotspot = overrideKey in overrides ? overrides[overrideKey] : r.isHotspot;
    const bVal = r.isLikelyDisordered
      ? 0
      : effectiveHotspot
      ? Math.round(r.hotspotScore * 100)
      : Math.round(r.hotspotScore * 40);

    const resName = r.resName.padEnd(3).slice(0, 3);
    const chain = r.chainId.slice(0, 1);
    const resNumStr = String(r.resNum).padStart(4);
    const insCode = r.insertionCode || " ";
    const xStr = r.x.toFixed(3).padStart(8);
    const yStr = r.y.toFixed(3).padStart(8);
    const zStr = r.z.toFixed(3).padStart(8);
    const bStr = bVal.toFixed(2).padStart(6);
    const serialStr = String(serial++).padStart(5);

    lines.push(
      `ATOM  ${serialStr}  CA  ${resName} ${chain}${resNumStr}${insCode}   ${xStr}${yStr}${zStr}  1.00${bStr}           C  `
    );
  }
  lines.push("END");
  return lines.join("\n");
}

// Generate an annotated PDB file for download.
// Reads all ATOM lines from the original text, replaces B-factors, filters to selectedChains.
export function generateAnnotatedPDB(
  fileText: string,
  fileFormat: "mmcif" | "pdb",
  scoredResidues: ScoredResidue[],
  selectedChains: Set<string>,
  overrides: Record<string, boolean>,
  threshold: number = DEFAULT_THRESHOLD
): string {
  const scoreMap = new Map<string, number>();
  for (const r of scoredResidues) {
    const key = `${r.chainId}:${r.resNum}:${r.insertionCode}`;
    const overrideKey = `${r.chainId}:${r.resNum}`;
    let isHotspot = r.isHotspot;
    if (overrideKey in overrides) isHotspot = overrides[overrideKey];
    scoreMap.set(key, isHotspot ? Math.round(r.hotspotScore * 100) : 0);
  }

  const hotspotCount = [...scoreMap.values()].filter((v) => v > 0).length;
  const remarks = [
    `REMARK   1 Generated by Binder Base Structure Prep Tool`,
    `REMARK   2 Hotspot threshold: ${threshold}`,
    `REMARK   3 Hotspot residues: ${hotspotCount}`,
    `REMARK   4 Selected chains: ${[...selectedChains].join(", ")}`,
    `REMARK   5 B-factor column = hotspot_score * 100 (0 = non-hotspot or IDR)`,
    `REMARK   6 Date: ${new Date().toISOString().split("T")[0]}`,
  ].join("\n");

  if (fileFormat === "pdb") {
    return buildAnnotatedPdbFromPdb(fileText, selectedChains, scoreMap, remarks);
  }
  return buildAnnotatedPdbFromMmcif(fileText, selectedChains, scoreMap, remarks, scoredResidues);
}

function buildAnnotatedPdbFromPdb(
  text: string,
  selectedChains: Set<string>,
  scoreMap: Map<string, number>,
  remarks: string
): string {
  const outputLines: string[] = [remarks];
  let currentModel = 1;

  for (const line of text.split("\n")) {
    if (line.startsWith("MODEL")) {
      currentModel = parseInt(line.slice(6).trim(), 10) || 1;
      if (currentModel > 1) break;
    }
    if (!line.startsWith("ATOM  ") && !line.startsWith("ATOM ") && !line.startsWith("HETATM")) {
      if (!line.startsWith("REMARK") && !line.startsWith("END")) outputLines.push(line);
      continue;
    }
    if (line.startsWith("HETATM")) continue;

    const chainId = line[21]?.trim() ?? "";
    if (!selectedChains.has(chainId)) continue;

    const resNum = parseInt(line.slice(22, 26).trim(), 10);
    const insCode = line[26]?.trim() ?? "";
    const key = `${chainId}:${resNum}:${insCode}`;
    const bScore = scoreMap.get(key) ?? 0;

    const bStr = bScore.toFixed(2).padStart(6);
    const newLine = line.slice(0, 60) + bStr + line.slice(66);
    outputLines.push(newLine);
  }
  outputLines.push("END");
  return outputLines.join("\n");
}

function buildAnnotatedPdbFromMmcif(
  _text: string,
  selectedChains: Set<string>,
  scoreMap: Map<string, number>,
  remarks: string,
  scoredResidues: ScoredResidue[]
): string {
  const outputLines: string[] = [remarks];
  let serial = 1;

  for (const r of scoredResidues) {
    if (!selectedChains.has(r.chainId)) continue;
    const key = `${r.chainId}:${r.resNum}:${r.insertionCode}`;
    const bScore = scoreMap.get(key) ?? 0;

    const resName = r.resName.padEnd(3).slice(0, 3);
    const chain = r.chainId.slice(0, 1);
    const resNumStr = String(r.resNum).padStart(4);
    const insCode = r.insertionCode || " ";
    const xStr = r.x.toFixed(3).padStart(8);
    const yStr = r.y.toFixed(3).padStart(8);
    const zStr = r.z.toFixed(3).padStart(8);
    const bStr = bScore.toFixed(2).padStart(6);
    const serialStr = String(serial++).padStart(5);

    outputLines.push(
      `ATOM  ${serialStr}  CA  ${resName} ${chain}${resNumStr}${insCode}   ${xStr}${yStr}${zStr}  1.00${bStr}           C  `
    );
  }
  outputLines.push("END");
  return outputLines.join("\n");
}
