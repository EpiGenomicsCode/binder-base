"""Stable public identifiers for runs.

A run needs a name a person can cite, put in a figure legend and paste into a
search box. It had none: the runs index showed the target's gene name, which
is not an identifier at all -- one protein carries several runs, so "TEK"
named two different rows at once and will name more as the campaign lands.

The form is ``<UniProt ID>-R<ordinal>``: ``Q02763-R001``. The accession says
what was targeted, which is the first thing anyone wants to know, and the
ordinal distinguishes runs against that target in the order they were
recorded.

ASSIGNED, NOT COMPUTED. This is the whole design decision. An ordinal derived
from sorting runs at read time would renumber every later run of a protein as
soon as an earlier one is deleted, so a "Q02763-R002" printed in a paper would
come to mean a different run than it did. Codes are assigned once at import,
stored, unique, and never reused -- the same contract as a GenBank or PDB
accession.

Deliberately not built from the HPA PrEST antibody ID. That is campaign
metadata: it exists only for HPA-derived runs, it has nothing to say about a
run from any other source, and BinderBase ingests runs from any design tool.
An identifier that only some runs can have is not an identifier.
"""
import re

#: Three digits: no target is planned to carry a thousand runs in the full
#: 2320-protein campaign, and the format widens past 999 rather than wrapping,
#: so codes stay text-sortable up to that point and stay correct after it.
ORDINAL_DIGITS = 3

RUN_CODE_RE = re.compile(r"^(?P<accession>[A-Za-z0-9_.\-]+)-R(?P<ordinal>\d+)$")


def format_run_code(uniprot_id, ordinal):
    """``("Q02763", 1)`` -> ``"Q02763-R001"``.

    Returns None when there is no accession to build from: a protein without a
    UniProt ID has nothing to anchor the code to, and a made-up one would be
    worse than none.
    """
    if not uniprot_id or ordinal is None or ordinal < 1:
        return None
    return f"{uniprot_id}-R{ordinal:0{ORDINAL_DIGITS}d}"


def parse_run_code(code):
    """``"Q02763-R001"`` -> ``("Q02763", 1)``, or None if it is not one."""
    if not code:
        return None
    match = RUN_CODE_RE.match(str(code).strip())
    if not match:
        return None
    return match.group("accession"), int(match.group("ordinal"))


def next_ordinal(existing_codes):
    """Highest ordinal already used, plus one.

    Takes the maximum rather than the count so that deleting a run never makes
    the next import reuse its code. A gap in the sequence is correct and means
    exactly what it looks like: a run that was recorded and later removed.
    """
    highest = 0
    for code in existing_codes:
        parsed = parse_run_code(code)
        if parsed and parsed[1] > highest:
            highest = parsed[1]
    return highest + 1


def next_run_code(model, uniprot_id, exclude_pk=None):
    """The code the next run against this target should carry. Does not save.

    One small query per run, which is what makes two runs imported in the same
    pass unable to collide: each sees the previous one's stored code.
    """
    if not uniprot_id:
        return None
    siblings = (model.objects
                .filter(protein__uniprot_id__iexact=uniprot_id)
                .exclude(run_code__isnull=True))
    if exclude_pk is not None:
        siblings = siblings.exclude(pk=exclude_pk)
    return format_run_code(
        uniprot_id, next_ordinal(siblings.values_list("run_code", flat=True)))
