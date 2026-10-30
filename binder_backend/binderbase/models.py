from django.contrib.auth.models import User
from django.db import models

class Protein(models.Model):
    uniprot_id = models.CharField(max_length=255, unique=True, null=True, blank=True)
    gene_name = models.CharField(max_length=255, null=True, blank=True)
    protein_name = models.CharField(max_length=255, null=True, blank=True)
    sequence = models.TextField()
    length = models.PositiveBigIntegerField(null=True, blank=True)
    organism = models.CharField(max_length=255, null=True, blank=True)
    biological_function = models.TextField(null=True, blank=True)
    cif_path = models.FileField(null=True, blank=True, max_length=1024, verbose_name="AlphaFold CIF path")
    pae_json_path = models.FileField(null=True, blank=True, max_length=1024, verbose_name="PAE JSON path")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.uniprot_id
    

class BinderRun(models.Model):
    protein = models.ForeignKey(Protein, on_delete=models.CASCADE)
    # Citable accession, "Q02763-R001": the target's UniProt ID and the run's
    # ordinal against that target.
    #
    # ASSIGNED, not computed. A number derived from ordering would renumber
    # every later run of a protein whenever an earlier one is deleted, so a
    # published "Q02763-R002" would silently come to mean a different run.
    # Assigned once at import and never reused, like any accession.
    #
    # Nullable because a run whose protein has no UniProt ID has nothing to
    # build one from; the API falls back to the primary key for those.
    run_code = models.CharField(
        max_length=64, unique=True, null=True, blank=True,
        verbose_name="Run accession",
        help_text="Stable public identifier, e.g. Q02763-R001. Never reused.")
    algorithm = models.CharField(max_length=255, null=True, blank=True)
    description = models.TextField(null=True, blank=True)
    run_datetime = models.DateTimeField(null=True, blank=True)
    hardware = models.CharField(max_length=255, null=True, blank=True)
    notes = models.TextField(null=True, blank=True)
    run_dir = models.CharField(max_length=1024, unique=True, null=True, blank=True)
    cif_path = models.FileField(null=True, blank=True, max_length=1024, verbose_name="CIF path")
    target_sequence = models.TextField(null=True, blank=True)
    steps_config = models.JSONField(null=True, blank=True, default=dict)
    metadata = models.JSONField(null=True, blank=True)
    user = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        # algorithm and run_datetime are optional — meta.json may omit them.
        parts = [
            self.protein.uniprot_id,
            self.algorithm,
            self.run_datetime.strftime("%Y-%m-%d %H:%M:%S") if self.run_datetime else None,
        ]
        return " - ".join(p for p in parts if p) or f"Run #{self.pk}"
    
    class Meta:
        ordering = ["-run_datetime", ]


class Binder(models.Model):
    run = models.ForeignKey(BinderRun, on_delete=models.CASCADE)
    binder_sequence = models.TextField()
    binder_length = models.PositiveBigIntegerField(null=True, blank=True)
    status = models.CharField(max_length=255, null=True, blank=True)
    failure_reason = models.TextField(null=True, blank=True)
    final_rank = models.PositiveBigIntegerField(null=True, blank=True)
    quality_score = models.FloatField(null=True, blank=True)
    design_to_target_iptm = models.FloatField(null=True, blank=True)

    # --- metrics promoted out of the `metrics` JSON blob ---------------------
    # `metrics` keeps all ~245 columns, but a JSONField cannot be filtered or
    # sorted efficiently, so the handful of fields people actually query are
    # mirrored into real columns. The JSON stays authoritative and complete;
    # these are a queryable projection of it, populated on import and by the
    # backfill_metrics command.
    #
    # All nullable, deliberately: BinderBase ingests runs from any design tool
    # (`algorithm` is free-form), so a run from something other than BoltzGen
    # simply will not have these keys. Absence is normal, not an error.
    min_interaction_pae = models.FloatField(null=True, blank=True)
    bb_target_aligned_rmsd_design = models.FloatField(
        null=True, blank=True,
        help_text="Binder displacement after refolding, target-aligned. The placement metric.")
    bb_rmsd_design = models.FloatField(null=True, blank=True)
    designfolding_bb_rmsd = models.FloatField(
        null=True, blank=True,
        help_text="Monomer self-consistency. Source key is 'designfolding-bb_rmsd'.")
    complex_plddt = models.FloatField(null=True, blank=True)
    design_ptm = models.FloatField(null=True, blank=True)
    pass_filters = models.BooleanField(null=True, blank=True)

    metrics = models.JSONField(null=True, blank=True, default=dict) 
    cif_path = models.FileField(null=True, blank=True, max_length=1024, verbose_name="CIF path")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["run", "final_rank", ]
        indexes = [
            # Backs the default ordering of the per-run binder listing, which
            # pages through runs holding thousands of designs.
            models.Index(fields=["run", "final_rank"], name="binder_run_rank_idx"),
            # The promoted metric columns, indexed for sorting and filtering
            # across runs. These must stay in step with migration 0013: they
            # were created there but never declared here, so the autodetector
            # treated them as indexes the model no longer wants and offered to
            # drop all five on the next unrelated makemigrations.
            models.Index(fields=["bb_target_aligned_rmsd_design"],
                         name="binder_placement_rmsd_idx"),
            models.Index(fields=["designfolding_bb_rmsd"],
                         name="binder_mono_rmsd_idx"),
            models.Index(fields=["min_interaction_pae"],
                         name="binder_interaction_pae_idx"),
            # The cross-proteome query people will actually run is "good
            # confidence AND good interface", so index that pair as well as the
            # columns alone.
            models.Index(fields=["design_to_target_iptm", "min_interaction_pae"],
                         name="binder_iptm_pae_idx"),
            models.Index(fields=["pass_filters"], name="binder_pass_filters_idx"),
        ]
