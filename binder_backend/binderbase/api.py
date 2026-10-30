import csv
import io
import re
from datetime import datetime
from ninja import NinjaAPI, Schema
from django.db.models import Count, F, Min, Max, Q
from django.http import JsonResponse, StreamingHttpResponse
from django.shortcuts import get_object_or_404
from .models import Protein, BinderRun, Binder

api = NinjaAPI()

# 2 A is the conventional designability cut-off in de novo binder work, not a
# property of the data, so every endpoint that applies it takes it as a query
# parameter. Defined here rather than beside the summary endpoint because the
# runs index applies the same two defaults, and a run's rate on the index must
# mean what the same run's rate means on its own page.
DEFAULT_PLACEMENT_A = 2.0
DEFAULT_MONOMER_A = 2.0


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

    # Rolled up across every run against this protein. The target list
    # previously answered "what proteins exist", which nobody needs to ask of
    # a design database; these are what make it answer "which targets worked".
    run_count: int = 0
    designs: int = 0
    placement_hits: int = 0
    placement_rate: float = 0.0
    best_iptm: float | None = None
    best_placement: float | None = None

    @staticmethod
    def resolve_cif_path(obj):
        return obj.cif_path.name if obj.cif_path else None

    @staticmethod
    def resolve_placement_rate(obj):
        return _rate(getattr(obj, "placement_hits", 0) or 0,
                     getattr(obj, "designs", 0) or 0)

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
    run_code: str | None
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


def _rate(hits, total):
    """Module level, not a schema method: pydantic owns the class namespace and
    treats a leading underscore there as a private attribute."""
    return round(hits / total, 4) if total else 0.0


class RunListSchema(Schema):
    """One row of the runs index: who the target was, and did it work.

    Every count here comes from an annotation on the list query, not from a
    per-run aggregate -- the index exists to compare runs, so computing it one
    run at a time would be the N+1 the page is meant to replace.
    """
    id: int
    protein_id: int
    run_code: str | None
    uniprot_id: str | None
    gene_name: str | None
    algorithm: str | None
    run_datetime: datetime | None
    epitope: str | None
    epitope_residues: int | None
    designs: int
    placement_hits: int
    monomer_consistent: int
    passed_filters: int
    placement_rate: float
    monomer_rate: float
    pass_rate: float
    best_iptm: float | None
    best_placement: float | None

    @staticmethod
    def resolve_uniprot_id(obj):
        return obj.protein.uniprot_id

    @staticmethod
    def resolve_gene_name(obj):
        return obj.protein.gene_name

    @staticmethod
    def resolve_epitope(obj):
        # metadata is free-form JSON from whatever importer wrote the run, so
        # this is not guaranteed to be a string. The index renders every run at
        # once, which means one row of the wrong type would 500 the whole page
        # rather than blank one cell.
        v = (obj.metadata or {}).get("Hotspot residues")
        return None if v is None else str(v)

    @staticmethod
    def resolve_epitope_residues(obj):
        # make_meta_json writes this straight out of the triage TSV, so it
        # arrives as a string. Runs predating select_patch.py have no patch at
        # all, which is absence rather than zero.
        raw = (obj.metadata or {}).get("Binding patch residues")
        try:
            return int(raw)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def resolve_placement_rate(obj):
        return _rate(obj.placement_hits, obj.designs)

    @staticmethod
    def resolve_monomer_rate(obj):
        return _rate(obj.monomer_consistent, obj.designs)

    @staticmethod
    def resolve_pass_rate(obj):
        return _rate(obj.passed_filters, obj.designs)


class RunIndexSchema(Schema):
    items: list[RunListSchema]
    total: int
    # Echoed back because the rates above are only meaningful against them, and
    # the caller may have overridden either.
    placement_threshold: float
    monomer_threshold: float


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


def protein_index_queryset(placement_threshold=None):
    """Every protein with its runs rolled up, in one query.

    The counts come off a single protein -> run -> binder join. `runs` needs
    distinct=True because that join fans out to one row per BINDER, so without
    it a protein's run count would be multiplied by its design count; the
    design-level counts need no distinct, since each binder appears once.
    """
    threshold = (DEFAULT_PLACEMENT_A if placement_threshold is None
                 else placement_threshold)
    return Protein.objects.annotate(
        run_count=Count("binderrun", distinct=True),
        designs=Count("binderrun__binder"),
        placement_hits=Count("binderrun__binder", filter=Q(
            binderrun__binder__bb_target_aligned_rmsd_design__lt=threshold)),
        best_iptm=Max("binderrun__binder__design_to_target_iptm"),
        # An RMSD: "best" is the minimum.
        best_placement=Min("binderrun__binder__bb_target_aligned_rmsd_design"),
    ).order_by("uniprot_id", "id")


@api.get("/proteins", response=list[ProteinListSchema])
def list_proteins(request, placement_threshold: float = DEFAULT_PLACEMENT_A):
    """Unpaged, like the runs index and for the same reason: the aggregate
    visits every binder whatever slice is returned, so paging would cut
    transfer without cutting work."""
    return protein_index_queryset(placement_threshold)


@api.get("/proteins/{id}", response=ProteinDetailSchema)
def get_protein(request, id: int):
    return get_object_or_404(Protein, pk=id)


# --- runs index -------------------------------------------------------------
# Runs were reachable only through their protein, so a campaign of a hundred
# runs had no page that put them side by side. This is that page's data.
#
# NOT PAGED, deliberately. Paging would cut the response size but not the work:
# the grouped aggregate below has to visit every binder row whatever slice is
# returned, so the scan -- not the transfer -- is what costs. One row per run is
# small (2320 runs is a few hundred KB, well under a tenth of that gzipped), and
# shipping all of them lets the table re-sort without a round-trip, which is the
# whole point of a leaderboard.
#
# If this does get slow, the fix is denormalising the four counts onto BinderRun
# at import time, not paging. That needs a migration and a backfill, so it is
# left as a deliberate next step rather than guessed at here.


def run_index_queryset(placement_threshold, monomer_threshold):
    """Every run with its four counts, grouped in one query.

    Shared by the index endpoint and its CSV export so the downloaded
    leaderboard is the leaderboard, computed the same way.
    """
    return (
        BinderRun.objects.select_related("protein")
        .annotate(
            designs=Count("binder"),
            placement_hits=Count("binder", filter=Q(
                binder__bb_target_aligned_rmsd_design__lt=placement_threshold)),
            monomer_consistent=Count("binder", filter=Q(
                binder__designfolding_bb_rmsd__lt=monomer_threshold)),
            passed_filters=Count("binder", filter=Q(binder__pass_filters=True)),
            best_iptm=Max("binder__design_to_target_iptm"),
            # Placement is an RMSD, so "best" is the minimum, not the maximum.
            best_placement=Min("binder__bb_target_aligned_rmsd_design"),
        )
        # BinderRun.Meta orders by -run_datetime, which is null for imported
        # runs that carried no date. Order by id as well so the sequence is
        # total and the client's own sort starts from something stable.
        .order_by("-run_datetime", "-id")
    )


@api.get("/runs", response=RunIndexSchema)
def list_runs(request,
              placement_threshold: float = DEFAULT_PLACEMENT_A,
              monomer_threshold: float = DEFAULT_MONOMER_A):
    items = list(run_index_queryset(placement_threshold, monomer_threshold))
    return {
        "items": items,
        "total": len(items),
        "placement_threshold": placement_threshold,
        "monomer_threshold": monomer_threshold,
    }


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


def binder_queryset(run, status="all", sort="rank", sort_dir="asc"):
    """The run's binders, filtered and ordered.

    Shared by the paged listing and the exports so a download cannot come back
    in a different order, or with a different subset, than the table the user
    was looking at when they clicked it.
    """
    qs = run.binder_set.all()
    if status != "all":
        qs = qs.filter(status__iexact=status)

    field = F(BINDER_SORT_FIELDS.get(sort, "final_rank"))
    # Missing values sort last in both directions so blanks never lead the table.
    ordering = field.desc(nulls_last=True) if sort_dir == "desc" else field.asc(nulls_last=True)
    # id breaks ties so the order is total: without it, paging through a run
    # whose designs share a rank can repeat or skip rows between pages.
    return qs.order_by(ordering, "id")


def run_metric_keys(run):
    """Union of `metrics` keys, sampled rather than scanned.

    Binders within a run come from the same pipeline and carry the same keys,
    so the leading rows are representative. Failed designs may have empty
    metrics, hence a sample larger than one page.
    """
    metric_keys = set()
    # metrics=None would match JSON null rather than SQL NULL, hence __isnull.
    sample = run.binder_set.exclude(metrics__isnull=True).values_list("metrics", flat=True)
    for metrics in sample[:METRIC_KEY_SAMPLE]:
        if isinstance(metrics, dict):
            metric_keys.update(metrics)
    return sorted(metric_keys - METRIC_KEYS_HIDDEN)


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
    qs = binder_queryset(run, status, sort, sort_dir)

    total = qs.count()
    page = max(1, page)
    page_size = min(max(1, page_size), MAX_BINDER_PAGE_SIZE)
    start = (page - 1) * page_size
    items = list(qs[start : start + page_size])

    return {
        "items": items,
        "total": total,
        "metric_keys": run_metric_keys(run),
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
                   "masked_faces": meta.get("Masked cut faces"),
                   # How the target structure's numbering lines up with
                   # everything else on the run page. `residues` is the crop's
                   # own auth_seq_id numbering in order, so the nth residue of
                   # target_sequence is the nth number here -- it is what links
                   # the structure viewer to the sequence block, and it is also
                   # the frame `epitope` and `masked_faces` are written in.
                   # `residue_offset` places the crop in the parent protein
                   # (uniprot = auth + offset), which the PAE panel needs
                   # because it shows the protein's full-length matrix. Null
                   # when the crop could not be placed, and the panel then
                   # draws no band rather than a wrong one.
                   "residues": meta.get("Target residues"),
                   "residue_offset": meta.get("Residue offset")},
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


# --- exports ----------------------------------------------------------------
# A repository whose argument is that the data is citable has to let people take
# the data. Every export below streams: a run holds thousands of designs and the
# campaign holds thousands of runs, so building the body in memory first would
# put the largest response on the heap exactly when it is least affordable.
#
# Each export reuses binder_queryset(), so a download reflects the same filter
# and the same order as the table the user clicked it from. The CSVs carry run
# and protein identity on every row, so concatenating a hundred of them stays
# self-describing.
#
# NOT here: bulk structure download. A pruned run is 0.5-0.7 GB of CIFs and the
# full campaign is ~1.1-1.6 TB, which is a file-transfer problem rather than a
# web-response one. The CSV carries cif_path per design instead, which is what a
# fetch script needs.

# Identity first, then the promoted metric columns in the order the run page
# reads them. Stable: a consumer can rely on this header, and `metrics=full`
# only ever appends.
BINDER_EXPORT_COLUMNS = [
    "binder_id", "run_id", "run_code", "uniprot_id", "gene_name", "final_rank", "status",
    "pass_filters", "binder_length", "binder_sequence", "quality_score",
    "design_to_target_iptm", "min_interaction_pae",
    "bb_target_aligned_rmsd_design", "bb_rmsd_design", "designfolding_bb_rmsd",
    "complex_plddt", "design_ptm", "failure_reason", "cif_path",
]

_SLUG_RE = re.compile(r"[^A-Za-z0-9_.-]+")


def _slug(*parts):
    """Filename-safe slug.

    Everything here reaches a Content-Disposition header, and gene names and
    descriptions are free text from whatever wrote the run, so this strips
    rather than trusts -- a newline in a header is a response-splitting bug,
    not a cosmetic one.
    """
    # Leading dots stripped as well as underscores: "." is kept inside a part so
    # a threshold reads "placement2.0A", but a part that is only dots would
    # otherwise put ".." in a filename.
    out = [_SLUG_RE.sub("_", str(p)).strip("_.") for p in parts if p]
    return "-".join(p for p in out if p) or "export"


def _attach(response, filename):
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    # Nothing here is user-specific, but these are generated per request and a
    # stale binder table is worse than a second query.
    response["Cache-Control"] = "no-store"
    return response


def _csv_stream(header, rows):
    """Yield CSV text incrementally from an iterable of row lists.

    csv.writer needs a file-like sink, so it writes into a StringIO that is
    drained and truncated after every row rather than growing for the length of
    the run. Using csv.writer rather than ",".join is what makes a sequence,
    failure reason or description containing a comma or quote survive.
    """
    buf = io.StringIO()
    writer = csv.writer(buf)

    def drain():
        value = buf.getvalue()
        buf.seek(0)
        buf.truncate(0)
        return value

    writer.writerow(header)
    yield drain()
    for row in rows:
        writer.writerow(row)
        yield drain()


def _binder_export_rows(run, qs, metric_keys):
    uniprot = run.protein.uniprot_id or ""
    gene = run.protein.gene_name or ""
    for b in qs.iterator(chunk_size=500):
        row = [
            b.id, run.id, run.run_code or "", uniprot, gene,
            b.final_rank, b.status,
            b.pass_filters, b.binder_length, b.binder_sequence, b.quality_score,
            b.design_to_target_iptm, b.min_interaction_pae,
            b.bb_target_aligned_rmsd_design, b.bb_rmsd_design,
            b.designfolding_bb_rmsd, b.complex_plddt, b.design_ptm,
            b.failure_reason, b.cif_path.name if b.cif_path else "",
        ]
        if metric_keys:
            metrics = b.metrics if isinstance(b.metrics, dict) else {}
            row.extend(metrics.get(k, "") for k in metric_keys)
        yield row


@api.get("/runs/{run_id}/binders.csv", include_in_schema=True)
def export_run_binders_csv(
    request,
    run_id: int,
    sort: str = "rank",
    sort_dir: str = "asc",
    status: str = "all",
    metrics: str = "promoted",
):
    """Every binder in the run as CSV.

    Unpaged on purpose -- an export that returned one page of twenty would be
    the thing it exists to replace.

    `metrics=full` appends the ~245 pipeline columns from the metrics JSON.
    Those keys are sampled rather than scanned (see run_metric_keys), so a run
    whose later designs carry keys the leading ones do not would lose them;
    `metrics=promoted`, the default, is the stable subset that is also indexed.
    """
    run = get_object_or_404(BinderRun.objects.select_related("protein"), pk=run_id)
    qs = binder_queryset(run, status, sort, sort_dir)
    metric_keys = run_metric_keys(run) if metrics == "full" else []

    response = StreamingHttpResponse(
        _csv_stream(BINDER_EXPORT_COLUMNS + metric_keys,
                    _binder_export_rows(run, qs, metric_keys)),
        content_type="text/csv; charset=utf-8",
    )
    name = _slug(run.protein.uniprot_id, run.protein.gene_name, f"run{run.id}", "binders")
    return _attach(response, f"{name}.csv")


def _fasta_stream(run, qs, wrap=60):
    """FASTA with the scoring metrics in the defline.

    A bare sequence file loses the only thing that distinguishes one design
    from another, and these go straight into alignment and clustering tools
    where the header is all that survives. key=value after the identifier is
    the convention those tools tolerate -- they split the defline on the first
    space and keep the rest as a free-text description.
    """
    uniprot = run.protein.uniprot_id or ""
    gene = run.protein.gene_name or ""
    for b in qs.iterator(chunk_size=500):
        fields = [f"run={run.id}"]
        if uniprot:
            fields.append(f"uniprot={uniprot}")
        if gene:
            fields.append(f"gene={gene}")
        if b.final_rank is not None:
            fields.append(f"rank={b.final_rank}")
        seq = b.binder_sequence or ""
        fields.append(f"len={b.binder_length if b.binder_length is not None else len(seq)}")
        for key, value, digits in (
            ("iptm", b.design_to_target_iptm, 4),
            ("ipae", b.min_interaction_pae, 3),
            ("placement_rmsd", b.bb_target_aligned_rmsd_design, 3),
            ("monomer_rmsd", b.designfolding_bb_rmsd, 3),
        ):
            if value is not None:
                fields.append(f"{key}={round(value, digits)}")
        if b.pass_filters is not None:
            fields.append(f"pass={'yes' if b.pass_filters else 'no'}")
        # The identifier is the one token that must stay unique and parseable,
        # so it is built from ids rather than from anything free-text.
        yield f">binder{b.id}|run{run.id} {' '.join(fields)}\n"
        for i in range(0, len(seq), wrap):
            yield seq[i:i + wrap] + "\n"


@api.get("/runs/{run_id}/binders.fasta", include_in_schema=True)
def export_run_binders_fasta(
    request,
    run_id: int,
    sort: str = "rank",
    sort_dir: str = "asc",
    status: str = "all",
    limit: int = 0,
):
    """The run's binder sequences as FASTA.

    `limit` takes the leading N in the current sort, which with the default
    sort is the top N by pipeline rank -- the usual ask, since nobody orders
    1000 designs into a synthesis run.
    """
    run = get_object_or_404(BinderRun.objects.select_related("protein"), pk=run_id)
    qs = binder_queryset(run, status, sort, sort_dir)
    suffix = "binders"
    if limit > 0:
        qs = qs[:limit]
        suffix = f"top{limit}"

    response = StreamingHttpResponse(
        _fasta_stream(run, qs),
        content_type="text/x-fasta; charset=utf-8",
    )
    name = _slug(run.protein.uniprot_id, run.protein.gene_name, f"run{run.id}", suffix)
    return _attach(response, f"{name}.fasta")


@api.get("/runs/{run_id}/meta.json", include_in_schema=True)
def export_run_meta(request, run_id: int):
    """The run's provenance record, as a file.

    This is what make_meta_json wrote next to the run, round-tripped back out:
    container and checkpoint fingerprints, resolved config hash, sampler
    parameters, the epitope and the per-attempt hardware log. It is the half of
    a citation that the design metrics are not.
    """
    run = get_object_or_404(BinderRun.objects.select_related("protein"), pk=run_id)
    # safe=False because BinderRun.metadata is a JSONField: make_meta_json
    # writes an object, but the model permits a list and JsonResponse refuses a
    # non-dict without it.
    response = JsonResponse(run.metadata if run.metadata is not None else {},
                            safe=False, json_dumps_params={"indent": 2})
    name = _slug(run.protein.uniprot_id, run.protein.gene_name, f"run{run.id}", "meta")
    return _attach(response, f"{name}.json")


RUN_INDEX_EXPORT_COLUMNS = [
    "run_id", "run_code", "uniprot_id", "gene_name", "algorithm", "run_datetime",
    "epitope", "epitope_residues", "designs", "placement_hits",
    "monomer_consistent", "passed_filters", "placement_rate", "monomer_rate",
    "pass_rate", "best_iptm", "best_placement",
]


@api.get("/runs.csv", include_in_schema=True)
def export_runs_csv(request,
                    placement_threshold: float = DEFAULT_PLACEMENT_A,
                    monomer_threshold: float = DEFAULT_MONOMER_A):
    """The runs index as CSV -- one row per run, campaign-wide.

    The thresholds are part of what the rate columns mean, so they go in the
    filename rather than being left for the reader to assume.
    """
    runs = run_index_queryset(placement_threshold, monomer_threshold)

    def rows():
        for r in runs.iterator(chunk_size=200):
            yield [
                r.id, r.run_code or "",
                r.protein.uniprot_id or "", r.protein.gene_name or "",
                r.algorithm or "",
                r.run_datetime.isoformat() if r.run_datetime else "",
                RunListSchema.resolve_epitope(r) or "",
                RunListSchema.resolve_epitope_residues(r),
                r.designs, r.placement_hits, r.monomer_consistent,
                r.passed_filters,
                _rate(r.placement_hits, r.designs),
                _rate(r.monomer_consistent, r.designs),
                _rate(r.passed_filters, r.designs),
                r.best_iptm, r.best_placement,
            ]

    response = StreamingHttpResponse(
        _csv_stream(RUN_INDEX_EXPORT_COLUMNS, rows()),
        content_type="text/csv; charset=utf-8",
    )
    name = _slug("binderbase-runs", f"placement{placement_threshold}A",
                 f"monomer{monomer_threshold}A")
    return _attach(response, f"{name}.csv")
