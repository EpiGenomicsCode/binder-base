from datetime import datetime
from ninja import NinjaAPI, Schema
from django.db.models import Count, F, Min, Max, Q
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
    # Promoted out of `metrics` so they can be filtered and sorted. The JSON
    # still carries all ~245 columns; these are the queryable subset.
    min_interaction_pae: float | None
    bb_target_aligned_rmsd_design: float | None
    bb_rmsd_design: float | None
    designfolding_bb_rmsd: float | None
    complex_plddt: float | None
    design_ptm: float | None
    pass_filters: bool | None
    metrics: dict | None
    cif_path: str | None

    @staticmethod
    def resolve_cif_path(obj):
        return obj.cif_path.name if obj.cif_path else None


class BinderRunSchema(Schema):
    id: int
    algorithm: str | None
    description: str | None
    run_datetime: datetime | None
    hardware: str | None
    notes: str | None
    run_dir: str | None
    cif_path: str | None
    target_sequence: str | None
    steps_config: dict | list | None
    metadata: dict | list | None
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


class HistogramSchema(Schema):
    edges: list[float]
    counts: list[int]
    n: int
    # Values outside [edges[0], edges[-1]] are clamped into the end bins, so
    # without these the UI would label a bar "38-40" when it means ">=38".
    # Render the end bins as open-ended when either is non-zero.
    underflow: int
    overflow: int


class RunSummarySchema(Schema):
    run_id: int
    protein: dict
    target: dict
    counts: dict
    rates: dict
    best: dict | None
    histograms: dict[str, HistogramSchema]
    enrichment: dict
    provenance: dict


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
    # Promoted metric columns. These are indexed, so sorting on them does not
    # scan; the same keys inside `metrics` JSON could not be sorted at all.
    "placement_rmsd": "bb_target_aligned_rmsd_design",
    "monomer_rmsd": "designfolding_bb_rmsd",
    "interaction_pae": "min_interaction_pae",
    "plddt": "complex_plddt",
    "ptm": "design_ptm",
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

# --- run summary ------------------------------------------------------------
# Aggregated server-side. A run holds thousands of binders and the page needs
# distributions, not rows; shipping every row to the client to build a
# histogram would defeat the point. Every field below is a promoted column, so
# these are indexed scans rather than JSON extraction.

SUMMARY_HISTOGRAMS = {
    "design_to_target_iptm": (0.0, 1.0, 20),
    "min_interaction_pae": (0.0, 30.0, 20),
    "bb_target_aligned_rmsd_design": (0.0, 40.0, 20),
    "designfolding_bb_rmsd": (0.0, 20.0, 20),
}

# 2 A is the conventional designability cut-off in de novo binder work, not a
# property of the data, so both thresholds are query parameters.
DEFAULT_PLACEMENT_A = 2.0
DEFAULT_MONOMER_A = 2.0

ENRICHMENT_K = (10, 30, 50, 100, 200)


def _histogram(values, lo, hi, bins):
    """Plain-Python binning over a values_list.

    Deliberately not width_bucket/SQL: that is Postgres-specific and this has to
    work on SQLite for the tests. One indexed column read per histogram is cheap
    enough at run scale.
    """
    width = (hi - lo) / bins
    counts = [0] * bins
    n = under = over = 0
    for v in values:
        if v is None:
            continue
        n += 1
        idx = int((v - lo) / width)
        if idx < 0:
            under += 1
            idx = 0
        elif idx >= bins:
            over += 1
            idx = bins - 1
        counts[idx] += 1
    return {"edges": [round(lo + i * width, 4) for i in range(bins + 1)],
            "counts": counts, "n": n, "underflow": under, "overflow": over}


@api.get("/runs/{run_id}/summary", response=RunSummarySchema)
def get_run_summary(request, run_id: int,
                    placement_threshold: float = DEFAULT_PLACEMENT_A,
                    monomer_threshold: float = DEFAULT_MONOMER_A):
    run = get_object_or_404(BinderRun.objects.select_related("protein"), pk=run_id)
    qs = run.binder_set.all()

    agg = qs.aggregate(
        designs=Count("id"),
        passed=Count("id", filter=Q(pass_filters=True)),
        placement_hits=Count("id", filter=Q(
            bb_target_aligned_rmsd_design__lt=placement_threshold)),
        monomer_ok=Count("id", filter=Q(
            designfolding_bb_rmsd__lt=monomer_threshold)),
        best_iptm=Max("design_to_target_iptm"),
        best_placement=Min("bb_target_aligned_rmsd_design"),
        best_pae=Min("min_interaction_pae"),
    )
    n = agg["designs"] or 0
    rate = lambda x: round(x / n, 4) if n else 0.0

    best = None
    top = qs.order_by(F("quality_score").desc(nulls_last=True), "final_rank").first()
    if top:
        best = {
            "binder_id": top.id, "final_rank": top.final_rank,
            "quality_score": top.quality_score,
            "design_to_target_iptm": top.design_to_target_iptm,
            "min_interaction_pae": top.min_interaction_pae,
            "bb_target_aligned_rmsd_design": top.bb_target_aligned_rmsd_design,
            "designfolding_bb_rmsd": top.designfolding_bb_rmsd,
        }

    histograms = {}
    for field, (lo, hi, bins) in SUMMARY_HISTOGRAMS.items():
        histograms[field] = _histogram(
            qs.values_list(field, flat=True), lo, hi, bins)

    # Enrichment: hit rate inside the top k by the pipeline's own composite
    # score, against the run's base rate. This is the clearest single statement
    # that the filter is doing something -- on a validated-epitope control it
    # ran 6-50x at k=10.
    base = agg["placement_hits"] / n if n else 0.0
    ranked = list(
        qs.exclude(bb_target_aligned_rmsd_design__isnull=True)
          .order_by(F("quality_score").desc(nulls_last=True), "final_rank")
          .values_list("bb_target_aligned_rmsd_design", flat=True)[:max(ENRICHMENT_K)]
    )
    curve = []
    for k in ENRICHMENT_K:
        if k > len(ranked):
            break
        hits = sum(1 for v in ranked[:k] if v < placement_threshold)
        curve.append({"k": k, "hit_rate": round(hits / k, 4),
                      "fold": round((hits / k) / base, 2) if base else None})

    meta = run.metadata or {}
    return {
        "run_id": run.id,
        "protein": {"id": run.protein_id,
                    "uniprot_id": run.protein.uniprot_id,
                    "gene_name": run.protein.gene_name},
        "target": {"epitope": meta.get("Hotspot residues"),
                   "crop_length": meta.get("Crop length"),
                   "structure_source": meta.get("Target structure source"),
                   "masked_faces": meta.get("Masked cut faces")},
        "counts": {"designs": n, "passed_filters": agg["passed"],
                   "placement_hits": agg["placement_hits"],
                   "monomer_consistent": agg["monomer_ok"]},
        "rates": {"pass": rate(agg["passed"]),
                  "placement": rate(agg["placement_hits"]),
                  "monomer": rate(agg["monomer_ok"]),
                  "placement_threshold": placement_threshold,
                  "monomer_threshold": monomer_threshold},
        "best": best,
        "histograms": histograms,
        "enrichment": {"base_rate": round(base, 4), "curve": curve},
        "provenance": {
            "algorithm": run.algorithm, "hardware": run.hardware,
            "run_datetime": run.run_datetime.isoformat() if run.run_datetime else None,
            "container": meta.get("Container"),
            "container_fingerprint": meta.get("Container fingerprint"),
            "folding_checkpoint": meta.get("Folding checkpoint"),
            "resolved_config_hash": meta.get("Resolved config hash"),
            "sampler": meta.get("Sampler parameters"),
            "reproducibility": meta.get("Reproducibility"),
        },
    }
