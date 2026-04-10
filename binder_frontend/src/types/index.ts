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
  cif_path: string | null;
}

export interface BinderRun {
  id: number;
  algorithm_version: string | null;
  description: string | null;
  run_datetime: string;
  hardware: string | null;
  notes: string | null;
  cif_path: string | null;
  binders: Binder[];
}

export interface ProteinDetail extends Protein {
  sequence: string;
  created_at: string;
  updated_at: string;
  runs: BinderRun[];
}
