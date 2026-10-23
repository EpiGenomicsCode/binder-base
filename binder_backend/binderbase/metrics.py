"""Projection of the `metrics` JSON blob onto real model columns.

Single source of truth, shared by import_run (populates on ingest) and
backfill_metrics (populates existing rows). If these two disagreed about how a
value casts, the columns would silently diverge from the JSON they mirror, so
the mapping and the casts live here and nowhere else.
"""

# model field -> key in the metrics JSON. The hyphen in 'designfolding-bb_rmsd'
# is not a legal Python identifier, which is why the mapping is explicit.
FLOAT_FIELDS = {
    "min_interaction_pae": "min_interaction_pae",
    "bb_target_aligned_rmsd_design": "bb_target_aligned_rmsd_design",
    "bb_rmsd_design": "bb_rmsd_design",
    "designfolding_bb_rmsd": "designfolding-bb_rmsd",
    "complex_plddt": "complex_plddt",
    "design_ptm": "design_ptm",
}
BOOL_FIELDS = {"pass_filters": "pass_filters"}
ALL_FIELDS = list(FLOAT_FIELDS) + list(BOOL_FIELDS)

_TRUEY = {"true", "1", "yes", "t"}
_FALSEY = {"false", "0", "no", "f"}


def to_float(value):
    """None for anything that is not a finite number.

    import_run stores whatever csv.DictReader produced, so every value arrives
    as a string. Blanks, 'nan' and 'inf' all occur in real pipeline output and
    must not reach the column, where they would break ordering and comparison.
    """
    if value is None or value == "":
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return f


def to_bool(value):
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    s = str(value).strip().lower()
    if s in _TRUEY:
        return True
    if s in _FALSEY:
        return False
    return None


def promoted(metrics):
    """metrics dict -> {model_field: cast value}.

    A missing key yields None rather than an error: BinderBase ingests runs from
    any design tool, so a run from something other than BoltzGen simply will not
    carry these keys. Absence is normal.
    """
    m = metrics or {}
    out = {f: to_float(m.get(k)) for f, k in FLOAT_FIELDS.items()}
    out.update({f: to_bool(m.get(k)) for f, k in BOOL_FIELDS.items()})
    return out
