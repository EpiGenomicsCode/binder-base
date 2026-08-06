from datetime import datetime
from ninja import NinjaAPI, Schema
from django.db.models import Count, F
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
    target_sequence: str | None
    steps_config: dict | list | None
    user: str | None
    # Binders are not inlined here — a protein with several runs of a few
    # thousand designs each made this response tens of MB. The page fetches
    # one page of binders for the selected run from /runs/{id}/binders.
    binder_count: int

    @staticmethod
    def resolve_cif_path(obj):
        return obj.cif_path.name if obj.cif_path else None

    @staticmethod
    def resolve_user(obj):
        return obj.user.username if obj.user else None

    @staticmethod
    def resolve_binder_count(obj):
        count = getattr(obj, "binder_count", None)
        return count if count is not None else obj.binder_set.count()


class ProteinDetailSchema(ProteinListSchema):
    sequence: str
    created_at: datetime
    updated_at: datetime
    runs: list[BinderRunSchema]

    @staticmethod
    def resolve_runs(obj):
        return (
            obj.binderrun_set.select_related("user")
            .annotate(binder_count=Count("binder"))
            .all()
        )


class BinderPageSchema(Schema):
    items: list[BinderSchema]
    total: int
    metric_keys: list[str]


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
    return get_object_or_404(Protein, pk=id)


# Sort keys accepted by the binders endpoint, mapped to model fields.
BINDER_SORT_FIELDS = {
    "rank": "final_rank",
    "quality": "quality_score",
    "iptm": "design_to_target_iptm",
    "length": "binder_length",
    "status": "status",
}

MAX_BINDER_PAGE_SIZE = 200

# The optional metric columns come from the union of keys across a run's
# binders. Scanning every row's JSON for that is what we are trying to avoid,
# so sample the leading rows instead — binders within a run come from the same
# pipeline and carry the same keys. Failed designs may have empty metrics,
# hence a sample larger than one page.
METRIC_KEY_SAMPLE = 200
METRIC_KEYS_HIDDEN = {"id", "file_name"}


@api.get("/runs/{run_id}/binders", response=BinderPageSchema)
def list_run_binders(
    request,
    run_id: int,
    page: int = 1,
    page_size: int = 20,
    sort: str = "rank",
    sort_dir: str = "asc",
    status: str = "all",
):
    run = get_object_or_404(BinderRun, pk=run_id)

    qs = run.binder_set.all()
    if status != "all":
        qs = qs.filter(status__iexact=status)

    field = F(BINDER_SORT_FIELDS.get(sort, "final_rank"))
    # Missing values sort last in both directions so blanks never lead the table.
    ordering = field.desc(nulls_last=True) if sort_dir == "desc" else field.asc(nulls_last=True)
    qs = qs.order_by(ordering, "id")

    total = qs.count()
    page = max(1, page)
    page_size = min(max(1, page_size), MAX_BINDER_PAGE_SIZE)
    start = (page - 1) * page_size
    items = list(qs[start : start + page_size])

    metric_keys = set()
    # metrics=None would match JSON null rather than SQL NULL, hence __isnull.
    sample = run.binder_set.exclude(metrics__isnull=True).values_list("metrics", flat=True)
    for metrics in sample[:METRIC_KEY_SAMPLE]:
        if isinstance(metrics, dict):
            metric_keys.update(metrics)

    return {
        "items": items,
        "total": total,
        "metric_keys": sorted(metric_keys - METRIC_KEYS_HIDDEN),
    }