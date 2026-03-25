from datetime import datetime
from ninja import NinjaAPI, Schema
from django.shortcuts import get_object_or_404
from .models import Protein

api = NinjaAPI()


class ProteinListSchema(Schema):
    id: int
    uniprot_id: str | None
    gene_name: str | None
    protein_name: str | None
    organism: str | None
    length: int | None


class BinderSchema(Schema):
    id: int
    binder_sequence: str
    binder_length: int | None
    status: str | None
    failure_reason: str | None


class BinderRunSchema(Schema):
    id: int
    algorithm_version: str | None
    description: str | None
    run_datetime: datetime
    hardware: str | None
    notes: str | None
    binders: list[BinderSchema]

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


@api.get("/proteins", response=list[ProteinListSchema])
def list_proteins(request):
    return Protein.objects.all()


@api.get("/proteins/{id}", response=ProteinDetailSchema)
def get_protein(request, id: int):
    return get_object_or_404(
        Protein.objects.prefetch_related("binderrun_set__binder_set"), pk=id
    )