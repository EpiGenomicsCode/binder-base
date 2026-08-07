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
    algorithm_version = models.CharField(max_length=255, null=True, blank=True)
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
        # algorithm_version and run_datetime are optional — meta.json may omit them.
        parts = [
            self.protein.uniprot_id,
            self.algorithm_version,
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
        ]
