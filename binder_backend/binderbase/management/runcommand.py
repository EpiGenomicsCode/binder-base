"""Shared skeleton for commands that update BinderRun rows in place.

Three commands now select a set of runs, work out what should change, report
it as a change log, and either write it or not depending on --dry-run. They
had that skeleton copied between them, which is how import_meta_json and the
constraints backfill ended up with subtly different ideas of what "skipped"
counts as.

Subclasses implement :meth:`derive` and get the selection flags, the change
log, --dry-run and the summary for free.

This covers run-level work only -- hundreds of rows, one save each. It is
deliberately not the shape for binder-level work: backfill_metrics touches
hundreds of thousands of rows and needs batching and bulk_update, which this
would only get in the way of.
"""
import os

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from binderbase.models import BinderRun


def format_value(value):
    """Short, readable rendering of a field value for the change log."""
    if value is None:
        return "None"
    text = str(value)
    return f"{text[:57]}..." if len(text) > 60 else text


class Change:
    """One proposed modification, so the log and the write cannot disagree.

    `field` is either an attribute on the run or, with `in_metadata`, a key
    inside its metadata dict.
    """

    __slots__ = ("field", "value", "in_metadata", "note")

    def __init__(self, field, value, in_metadata=False, note=None):
        self.field = field
        self.value = value
        self.in_metadata = in_metadata
        self.note = note

    def describe(self, run):
        if self.in_metadata:
            before = (run.metadata or {}).get(self.field)
        else:
            before = getattr(run, self.field, None)
        shown = self.note if self.note is not None else format_value(self.value)
        return f"{self.field}  {format_value(before)} -> {shown}"


class RunUpdateCommand(BaseCommand):
    """Select runs, derive changes, report them, write them unless --dry-run."""

    #: Set False for commands that should not offer --force.
    supports_force = True

    def add_arguments(self, parser):
        parser.add_argument(
            "--run", default=None,
            help="Only the run whose directory has this basename "
                 "(e.g. P12345-tal1_screen-20260501).")
        parser.add_argument(
            "--algorithm", default=None,
            help="Only runs whose algorithm matches this exactly.")
        parser.add_argument(
            "--protein", default=None,
            help="Only runs against this UniProt ID.")
        parser.add_argument(
            "--since", default=None,
            help="Only runs with a run_datetime on or after this ISO date.")
        parser.add_argument(
            "--dry-run", action="store_true",
            help="Report what would change without writing to the database.")
        if self.supports_force:
            parser.add_argument(
                "--force", action="store_true",
                help="Overwrite values that are already recorded. Off by "
                     "default so a run with real provenance is never clobbered.")
        self.add_extra_arguments(parser)

    def add_extra_arguments(self, parser):
        """Subclass hook for flags beyond the shared selection set."""

    # -- selection -----------------------------------------------------------

    def select_runs(self, options):
        runs = BinderRun.objects.select_related("protein").order_by("id")
        if options.get("algorithm"):
            runs = runs.filter(algorithm=options["algorithm"])
        if options.get("protein"):
            runs = runs.filter(protein__uniprot_id__iexact=options["protein"])
        if options.get("since"):
            runs = runs.filter(run_datetime__gte=options["since"])
        runs = list(runs)
        if options.get("run"):
            wanted = options["run"].rstrip("/")
            runs = [r for r in runs
                    if r.run_dir and os.path.basename(r.run_dir) == wanted]
        if not runs:
            # An empty selection is nearly always a mistyped filter, and
            # reporting success for it is how a backfill silently does nothing.
            raise CommandError("No runs matched.")
        return runs

    @staticmethod
    def label_for(run):
        return os.path.basename(run.run_dir) if run.run_dir else f"run #{run.pk}"

    @staticmethod
    def media_path(relative):
        return os.path.join(settings.MEDIA_ROOT, str(relative))

    # -- the hook ------------------------------------------------------------

    def derive(self, run, options):
        """-> an iterable of :class:`Change`, or raise :class:`Skip`.

        Returning nothing means the run is already correct, which is counted
        as unchanged rather than as work done.
        """
        raise NotImplementedError

    # -- driver --------------------------------------------------------------

    def handle(self, *args, **options):
        dry_run = options.get("dry_run")
        runs = self.select_runs(options)

        if dry_run:
            self.stdout.write(self.style.NOTICE("[dry run] no changes written\n"))

        updated = unchanged = failed = 0

        for run in runs:
            label = self.label_for(run)
            try:
                changes = list(self.derive(run, options) or [])
            except Skip as skip:
                if skip.is_error:
                    self.stdout.write(self.style.ERROR(f"{label}: {skip} - skipped"))
                    failed += 1
                else:
                    if str(skip):
                        self.stdout.write(f"{label}: {skip}")
                    unchanged += 1
                continue

            changes = [c for c in changes if self._is_real(run, c)]
            if not changes:
                unchanged += 1
                continue

            self.stdout.write(self.style.SUCCESS(label))
            for change in changes:
                self.stdout.write(f"  {change.describe(run)}")

            if not dry_run:
                self.apply(run, changes)
            updated += 1

        verb = "would update" if dry_run else "updated"
        self.stdout.write(self.style.SUCCESS(
            f"\nDone. {verb}: {updated}  unchanged: {unchanged}  failed: {failed}"))
        self.report_extra(updated, unchanged, failed)

    @staticmethod
    def _is_real(run, change):
        if change.in_metadata:
            return (run.metadata or {}).get(change.field) != change.value
        return getattr(run, change.field, None) != change.value

    @staticmethod
    def apply(run, changes):
        metadata = dict(run.metadata or {})
        touched_metadata = False
        for change in changes:
            if change.in_metadata:
                metadata[change.field] = change.value
                touched_metadata = True
            else:
                setattr(run, change.field, change.value)
        if touched_metadata:
            run.metadata = metadata
        run.save()

    def report_extra(self, updated, unchanged, failed):
        """Subclass hook for counters beyond the shared three."""


class Skip(Exception):
    """Raised by :meth:`derive` to leave a run alone, with a reason.

    `is_error` separates "this run is fine as it is" from "this run is broken";
    the two land in different counters, so a clean report is distinguishable
    from one where half the files were missing.
    """

    def __init__(self, reason="", is_error=False):
        super().__init__(reason)
        self.is_error = is_error
