from django.db import models

class protein(models.Model):
    uniprot_id = models.CharField(max_length=255, unique=True, null=True, blank=True)
    gene_name = models.CharField(max_length=255, null=True, blank=True)
    protein_name = models.CharField(max_length=255, null=True, blank=True)
    sequence = models.TextField()
    length = models.PositiveBigIntegerField(null=True, blank=True)
    organism = models.CharField(max_length=255, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.uniprot_id
    

class run(models.Model):
    name = models.CharField(max_length=255)
    algorithm_version = models.CharField(max_length=255, null=True, blank=True)
    description = models.TextField(null=True, blank=True)
    run_datetime = models.DateTimeField(auto_now_add=True)
    hardware = models.CharField(max_length=255, null=True, blank=True)
    notes = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.name
    

class binder(models.Model):
    protein = models.ForeignKey(protein, on_delete=models.CASCADE)
    run = models.ForeignKey(run, on_delete=models.CASCADE)
    binder_sequence = models.TextField()
    binder_length = models.PositiveBigIntegerField(null=True, blank=True)
    status = models.CharField(max_length=255, null=True, blank=True)
    failure_reason = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
