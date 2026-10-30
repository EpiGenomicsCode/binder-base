"""Report runs whose data is suspect, and optionally record why.

    python manage.py check_runs                    # report everything
    python manage.py check_runs --check crop       # one check
    python manage.py check_runs --record           # write Data quality notes

A check answers "is this run's data trustworthy", which is a different
question from "is this run's metadata complete" and belongs in a different
command. Adding one is a class with a `problem` method and an entry in CHECKS.

Nothing here deletes or hides a run. BinderBase records failures alongside
successes, so a run whose target crop collapsed is evidence that the crop can
collapse; removing it would destroy that while making the aggregates look
better. --record writes a note saying why the numbers are not comparable, and
leaves everything else alone.
"""
import os

from binderbase import structure
from binderbase.management.runcommand import Change, RunUpdateCommand, Skip

KEY_QUALITY = "Data quality"
KEY_HOTSPOT = "Hotspot residues"

#: Targets smaller than this are treated as a failed crop rather than a small
#: protein. The smallest genuine target seen is 52 residues; the failures are
#: 4, 5 and 12.
MIN_TARGET_RESIDUES = 20


class Check:
    name = ""
    help = ""

    def problem(self, run):
        """-> a sentence describing what is wrong, or None."""
        raise NotImplementedError


def _target_constraints(run):
    if not run.cif_path:
        return None
    path = RunUpdateCommand.media_path(run.cif_path)
    if not os.path.isfile(path):
        return None
    try:
        return structure.constraints_from_cif(path)
    except (OSError, ValueError):
        return None


class CollapsedCropCheck(Check):
    """A target cropped down to a handful of residues.

    Found on three production runs: RPLQ, PPKCP and RKPPPPPLLSPP, cropped out
    of proteins of 136, 110 and 127 residues. All three report a 100% pass
    rate, because passing filters against a pentapeptide is trivial -- which
    is what makes them worth flagging rather than leaving to look like wins.
    """

    name = "crop"
    help = "target structure collapsed to a handful of residues"

    def problem(self, run):
        found = _target_constraints(run)
        if not found or found["total"] >= MIN_TARGET_RESIDUES:
            return None
        total = found["total"]
        seq = run.target_sequence or ""
        shown = f" ({seq})" if seq and len(seq) <= 15 else ""
        of_what = (f" of a {run.protein.length}-residue protein"
                   if run.protein.length else "")
        return (f"Target structure is {total} residues{shown}{of_what}; the "
                f"crop collapsed. The placement and pass rates are not "
                f"comparable with other runs.")


class FullyConstrainedCheck(Check):
    """Every residue marked binding, so the run declares no epitope."""

    name = "no-epitope"
    help = "every target residue marked binding"

    def problem(self, run):
        found = _target_constraints(run)
        if not found or not found["total"]:
            return None
        if len(found[structure.HOTSPOT]) != found["total"]:
            return None
        return (f"Every one of the {found['total']} target residues is marked "
                f"binding, so the run declares no epitope to place against "
                f"and its placement rate measures something different.")


class EpitopeOutsideProteinCheck(Check):
    """An epitope numbered beyond the end of the protein it targets.

    Cropped targets keep the full protein's numbering (BoltzGen crops with
    res_reindex=False), so an epitope residue past the protein length means
    the run is attached to the wrong protein or the numbering was reindexed
    somewhere it should not have been.
    """

    name = "epitope-range"
    help = "epitope residues numbered past the end of the protein"

    def problem(self, run):
        epitope = (run.metadata or {}).get(KEY_HOTSPOT)
        length = run.protein.length
        if not epitope or not length:
            return None
        residues = structure.parse_ranges(epitope)
        outside = [r for r in residues if r > length or r < 1]
        if not outside:
            return None
        return (f'Epitope "{epitope}" includes residue '
                f"{outside[0]}, outside the {length}-residue "
                f"{run.protein.uniprot_id or 'target'}. The run may be "
                f"attached to the wrong protein.")


class NoBindersCheck(Check):
    """A run that imported but produced nothing."""

    name = "empty"
    help = "run has no binders"

    def problem(self, run):
        if run.binder_set.exists():
            return None
        return ("Run has no binders. It either produced none or its designs "
                "failed to import.")


class SequenceMismatchCheck(Check):
    """target_sequence disagreeing with the structure it came from."""

    name = "sequence"
    help = "target_sequence length disagrees with the target structure"

    def problem(self, run):
        found = _target_constraints(run)
        if not found or not run.target_sequence:
            return None
        if found["total"] == len(run.target_sequence):
            return None
        return (f"target_sequence is {len(run.target_sequence)} residues but "
                f"the target structure has {found['total']}. Hover-linking "
                f"between the sequence and the structure will be misaligned.")


CHECKS = {c.name: c for c in (
    CollapsedCropCheck(), FullyConstrainedCheck(), EpitopeOutsideProteinCheck(),
    NoBindersCheck(), SequenceMismatchCheck(),
)}


class Command(RunUpdateCommand):
    supports_force = False

    help = (
        "Report runs whose data is suspect. Checks: "
        + "; ".join(f"{n} ({c.help})" for n, c in CHECKS.items()) +
        ". Reports only unless --record, which writes the findings into each "
        "run's metadata. Never deletes or hides anything."
    )

    def add_extra_arguments(self, parser):
        parser.add_argument(
            "--check", action="append", choices=sorted(CHECKS), default=None,
            help="Run only this check. Repeatable. Default: all of them.")
        parser.add_argument(
            "--record", action="store_true",
            help=f'Write the findings to metadata["{KEY_QUALITY}"]. Without '
                 f"it the command only reports.")

    def handle(self, *args, **options):
        self.flagged = 0
        # Without --record nothing should be written even by accident, so the
        # driver is put into dry-run mode rather than trusted to have no
        # changes to apply.
        if not options.get("record"):
            options["dry_run"] = True
        super().handle(*args, **options)

    def derive(self, run, options):
        names = options.get("check") or sorted(CHECKS)
        problems = [p for p in (CHECKS[n].problem(run) for n in names) if p]
        if not problems:
            raise Skip()
        self.flagged += 1
        note = " ".join(problems)
        if not options.get("record"):
            # Report it here, because with dry_run forced on there is no write
            # for the driver's change log to describe.
            self.stdout.write(self.style.WARNING(self.label_for(run)))
            self.stdout.write(f"  {note}")
            raise Skip()
        yield Change(KEY_QUALITY, note, in_metadata=True)

    def report_extra(self, updated, unchanged, failed):
        self.stdout.write(f"runs with problems: {self.flagged}")
