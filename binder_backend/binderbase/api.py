from datetime import datetime
from ninja import NinjaAPI, Schema
from django.shortcuts import get_object_or_404
from .models import Protein, BinderRun, Binder

api = NinjaAPI()


class ProteinListSchema(Schema):
    id: int
    uniprot_id: str | None
    gene_name: str | None
    protein_name: str | None
    organism: str | None
    length: int | None
    biological_function: str | None
    cif_path: str | None
    pae_json_path: str | None

    @staticmethod
    def resolve_cif_path(obj):
        return obj.cif_path.name if obj.cif_path else None

    @staticmethod
    def resolve_pae_json_path(obj):
        return obj.pae_json_path.name if obj.pae_json_path else None


class BinderSchema(Schema):
    id: int
    binder_sequence: str
    binder_length: int | None
    status: str | None
    failure_reason: str | None
    final_rank: int | None
    quality_score: float | None
    design_to_target_iptm: float | None
    metrics: dict | None
    cif_path: str | None

    @staticmethod
    def resolve_cif_path(obj):
        return obj.cif_path.name if obj.cif_path else None


class BinderRunSchema(Schema):
    id: int
    algorithm_version: str | None
    description: str | None
    run_datetime: datetime
    hardware: str | None
    notes: str | None
    run_dir: str | None
    cif_path: str | None
    user: str | None
    binders: list[BinderSchema]

    @staticmethod
    def resolve_cif_path(obj):
        return obj.cif_path.name if obj.cif_path else None

    @staticmethod
    def resolve_user(obj):
        return obj.user.username if obj.user else None

    @staticmethod
    def resolve_binders(obj):
        return obj.binder_set.all()


class ProteinDetailSchema(ProteinListSchema):
    sequence: str
    created_at: datetime
    updated_at: datetime
    runs: list[BinderRunSchema]

    @staticmethod
    def resolve_runs(obj):
        return obj.binderrun_set.prefetch_related("binder_set").all()


class StatsSchema(Schema):
    protein_count: int
    run_count: int
    binder_count: int
    success_count: int


@api.get("/stats", response=StatsSchema)
def get_stats(request):
    return {
        "protein_count": Protein.objects.count(),
        "run_count": BinderRun.objects.count(),
        "binder_count": Binder.objects.count(),
        "success_count": Binder.objects.filter(status="success").count(),
    }


@api.get("/proteins", response=list[ProteinListSchema])
def list_proteins(request):
    return Protein.objects.all()


@api.get("/proteins/{id}", response=ProteinDetailSchema)
def get_protein(request, id: int):
    return get_object_or_404(
        Protein.objects.prefetch_related("binderrun_set__binder_set"), pk=id
    )