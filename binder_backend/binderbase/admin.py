from django.contrib import admin
from .models import *

@admin.register(Protein)
class ProteinAdmin(admin.ModelAdmin):
    list_display = ('uniprot_id', 'gene_name', 'protein_name', 'organism', 'length')
    list_filter = ('organism',)
    readonly_fields = ('cif_path', 'pae_json_path', 'biological_function')


@admin.register(BinderRun)
class BinderRunAdmin(admin.ModelAdmin):
    list_display = ('protein', 'algorithm', 'run_datetime', 'hardware', 'description', 'run_dir', 'user')
    list_filter = ('protein', 'algorithm', 'hardware', 'user')


@admin.register(Binder)
class BinderAdmin(admin.ModelAdmin):
    list_display = ('run', 'binder_length', 'final_rank', 'quality_score', 'design_to_target_iptm', 'status')
    list_filter = ('run',)


