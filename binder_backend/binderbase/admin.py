from django.contrib import admin
from .models import *

@admin.register(Protein)
class ProteinAdmin(admin.ModelAdmin):
    list_display = ('uniprot_id', 'gene_name', 'protein_name', 'organism', 'length')
    list_filter = ('organism',)


class BinderInline(admin.TabularInline):
    model = Binder   


@admin.register(BinderRun)
class BinderRunAdmin(admin.ModelAdmin):
    list_display = ('protein', 'algorithm_version', 'run_datetime', 'hardware', 'description')
    list_filter = ('protein', 'algorithm_version', 'hardware')

    inlines = [BinderInline, ]