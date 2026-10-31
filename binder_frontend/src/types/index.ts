export interface Stats {
  protein_count: number;
  run_count: number;
  binder_count: number;
  success_count: number;
}

export interface Protein {
  id: number;
  uniprot_id: string | null;
  gene_name: string | null;
  protein_name: string | null;
  organism: string | null;
  length: number | null;
  biological_function: string | null;
  cif_path: string | null;
  pae_json_path: string | null;

  // Rolled up across every run against this target. Pinned by
  // ProteinRollupTestCase.test_payload_shape_is_the_frontend_contract.
  run_count: number;
  designs: number;
  placement_hits: number;
  placement_rate: number;
  best_iptm: number | null;
  /** An RMSD, so lower is better. */
  best_placement: number | null;
}

export interface Binder {
  id: number;
  binder_sequence: string;
  binder_length: number | null;
  status: string | null;
  failure_reason: string | null;
  final_rank: number | null;
  quality_score: number | null;
  design_to_target_iptm: number | null;
  // Promoted out of `metrics` on the backend so they can be filtered and
  // sorted. BinderSchema has served all of these since the columns existed;
  // only three were declared here, so the run page had been reaching into the
  // raw blob for numbers it was already being handed typed.
  min_interaction_pae: number | null;
  bb_target_aligned_rmsd_design: number | null;
  bb_rmsd_design: number | null;
  designfolding_bb_rmsd: number | null;
  complex_plddt: number | null;
  design_ptm: number | null;
  pass_filters: boolean | null;
  metrics: Record<string, unknown> | null;
  cif_path: string | null;
}

export interface BinderRun {
  id: number;
  /** Public accession, "Q02763-R001". Null when the protein has no UniProt ID. */
  run_code: string | null;
  algorithm: string | null;
  description: string | null;
  run_datetime: string | null;
  hardware: string | null;
  notes: string | null;
  cif_path: string | null;
  target_sequence: string | null;
  steps_config: unknown;
  metadata: unknown;
  binder_count: number;
}

// --- runs index (GET /api/runs) --------------------------------------------
// One row per run, with the four counts already aggregated server-side. Keys
// are pinned by RunIndexTestCase.test_index_payload_shape_is_the_frontend_contract.

export interface RunListRow {
  id: number;
  protein_id: number;
  /** Public accession, "Q02763-R001". Null when the protein has no UniProt ID. */
  run_code: string | null;
  uniprot_id: string | null;
  gene_name: string | null;
  algorithm: string | null;
  run_datetime: string | null;
  epitope: string | null;
  /** Size of the declared binding patch; null for runs predating select_patch. */
  epitope_residues: number | null;
  designs: number;
  placement_hits: number;
  monomer_consistent: number;
  passed_filters: number;
  placement_rate: number;
  monomer_rate: number;
  pass_rate: number;
  best_iptm: number | null;
  /** An RMSD, so lower is better. */
  best_placement: number | null;
}

export interface RunIndex {
  items: RunListRow[];
  total: number;
  placement_threshold: number;
  monomer_threshold: number;
}

/** One page of a run's binders, plus the metric columns available for the run. */
export interface BinderPage {
  items: Binder[];
  total: number;
  metric_keys: string[];
}

export interface ProteinDetail extends Protein {
  sequence: string;
  created_at: string;
  updated_at: string;
  runs: BinderRun[];
}

export interface ParsedResidue {
  chainId: string;
  resNum: number;
  insertionCode: string;
  resName: string;
  x: number;
  y: number;
  z: number;
  bFactor: number;
  secStruct: "H" | "E" | "C";
}

export interface ClusterGroup {
  clusterId: number;
  residues: ScoredResidue[];
  avgScore: number;
  isSingleton: boolean;
}

export interface ScoredResidue extends ParsedResidue {
  neighborCount: number;
  exposureScore: number;
  normalizedB: number;
  rigidityScore: number;
  hydrophobicityScore: number;
  chargeScore: number;
  rawClusterDensity: number;
  hotspotScore: number;
  isHotspot: boolean;
  isLikelyDisordered: boolean;
}

export interface ParsedStructure {
  format: "mmcif" | "pdb";
  chains: string[];
  residues: ParsedResidue[];
  isAlphaFold: boolean;
}

// --- run summary (GET /api/runs/{id}/summary) ------------------------------
// Server-side aggregate. A run holds thousands of binders, so the page asks
// for distributions rather than rows.

export interface Histogram {
  edges: number[];      // bins + 1 edges
  counts: number[];
  n: number;            // non-null values binned
  underflow: number;
  overflow: number;     // values past the last edge, clamped into it
}

export interface EnrichmentPoint {
  k: number;
  hit_rate: number;
  fold: number | null;  // null when the run's base rate is 0
}

export interface RunSummary {
  run_id: number;
  protein: { id: number; uniprot_id: string; gene_name: string | null };
  target: {
    epitope: string | null;
    crop_length: number | null;
    structure_source: string | null;
    masked_faces: string | null;
    /**
     * Where the crop sits in the parent protein, as UniProt residue numbers in
     * the crop's own order -- so the nth residue of `target_sequence` is the
     * nth number here. Null for a run whose crop could not be placed.
     */
    residues: string | null;
    /** `uniprot = auth + offset`, for the auth-numbered ranges above. */
    residue_offset: number | null;
  };
  counts: {
    designs: number;
    passed_filters: number;
    placement_hits: number;
    monomer_consistent: number;
  };
  rates: {
    pass: number;
    placement: number;
    monomer: number;
    placement_threshold: number;
    monomer_threshold: number;
  };
  best: {
    binder_id: number;
    final_rank: number | null;
    quality_score: number | null;
    design_to_target_iptm: number | null;
    min_interaction_pae: number | null;
    bb_target_aligned_rmsd_design: number | null;
    designfolding_bb_rmsd: number | null;
  } | null;
  histograms: Record<string, Histogram>;
  enrichment: { base_rate: number; curve: EnrichmentPoint[] };
  provenance: Record<string, unknown>;
}
