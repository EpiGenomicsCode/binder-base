"""Convert already-imported runs' design structures to BinaryCIF.

    python manage.py backfill_bcif --dry-run          # report, touch nothing
    python manage.py backfill_bcif --run P05108-CYP11A1_HPA016436-20261102
    python manage.py backfill_bcif                    # every run
    python manage.py backfill_bcif --keep-text        # convert but keep the .cif

Campaign runs produced from blitzgen_osg.sh v1.0.2 onwards arrive already
converted, on the worker node, before the tarball is even built. This is for
everything imported before that -- the ~100 runs already in the database.

NOT a RunUpdateCommand. That skeleton is for run-level field updates, one save
per run; this does file I/O and then rewrites Binder.cif_path for every design
in the run, which is the binder-level shape backfill_metrics uses. It borrows
the selection flags so the two families of command are driven the same way.

ORDERING, WHICH IS THE WHOLE SAFETY ARGUMENT
    convert -> verify -> update the database -> delete the text file.

    Interrupted anywhere, the result is still consistent and re-running
    finishes the job:

      after convert, before the DB write   both files on disk, rows point at
                                           the .cif, which still exists
      after the DB write, before delete    both files on disk, rows point at
                                           the .bcif, which also exists

    The order that would lose data -- delete first, write the database second
    -- is the obvious one, which is why this says so out loud.
"""
import os

from django.core.management.base import BaseCommand, CommandError
from django.conf import settings
from django.db import transaction

from binderbase import bcif
from binderbase.models import Binder, BinderRun


class Command(BaseCommand):
    help = "Convert imported runs' design CIFs to BinaryCIF and repoint Binder.cif_path."

    def add_arguments(self, parser):
        parser.add_argument(
            "--run", default=None,
            help="Only the run whose directory has this basename "
                 "(e.g. P12345-tal1_screen-20260501).")
        parser.add_argument(
            "--protein", default=None,
            help="Only runs against this UniProt ID.")
        parser.add_argument(
            "--since", default=None,
            help="Only runs with a run_datetime on or after this ISO date.")
        parser.add_argument(
            "--dry-run", action="store_true",
            help="Report what would be converted without writing anything.")
        parser.add_argument(
            "--keep-text", action="store_true",
            help="Write the .bcif and repoint the database, but leave the .cif "
                 "in place. Halves the saving; useful for a first pass you want "
                 "to be able to eyeball before committing to.")
        parser.add_argument(
            "--batch-size", type=int, default=5000,
            help="Rows per bulk_update (default: %(default)s).")
        parser.add_argument(
            "--tolerance", type=float, default=bcif.DEFAULT_TOLERANCE,
            help="Max permitted coordinate delta in angstrom (default: %(default)s).")

    # -- selection -----------------------------------------------------------

    def select_runs(self, options):
        runs = BinderRun.objects.select_related("protein").order_by("id")
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

    # -- driver --------------------------------------------------------------

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        runs = self.select_runs(options)

        if dry_run:
            self.stdout.write(self.style.NOTICE("[dry run] nothing written\n"))

        converted = repointed = skipped = failed = 0
        bytes_before = bytes_after = 0
        worst = 0.0

        for run in runs:
            label = os.path.basename(run.run_dir) if run.run_dir else f"run #{run.pk}"

            if not run.run_dir:
                self.stdout.write(f"{label}: no run_dir recorded")
                skipped += 1
                continue
            run_dir = os.path.join(settings.MEDIA_ROOT, str(run.run_dir))
            if not os.path.isdir(run_dir):
                self.stdout.write(self.style.ERROR(
                    f"{label}: run directory missing ({run_dir}) - skipped"))
                failed += 1
                continue

            pending = list(bcif.design_cifs(run_dir))
            if not pending:
                # Either already converted or a run with no design structures.
                # Still repoint below: a previous interrupted pass may have
                # left the files converted and the rows pointing at the text.
                pass

            n_ok = n_bad = 0
            for src in pending:
                dest = bcif.bcif_path_for(src)
                if os.path.exists(dest):
                    continue
                size = os.path.getsize(src)
                if dry_run:
                    n_ok += 1
                    bytes_before += size
                    continue
                try:
                    worst = max(worst, bcif.convert(src, dest, options["tolerance"]))
                except Exception as exc:                       # noqa: BLE001
                    # One unconvertible file must not cost the run. The text
                    # file is still there and still valid; say so and move on.
                    self.stdout.write(self.style.WARNING(
                        f"  keeping text CIF, conversion failed ({exc}): "
                        f"{os.path.relpath(src, run_dir)}"))
                    if os.path.exists(dest):
                        os.remove(dest)
                    n_bad += 1
                    continue
                bytes_before += size
                bytes_after += os.path.getsize(dest)
                n_ok += 1

            moved = 0 if dry_run else self._repoint(run, options["batch_size"])
            if dry_run:
                moved = self._would_repoint(run)

            if n_ok or moved or n_bad:
                self.stdout.write(self.style.SUCCESS(label))
                if n_ok:
                    self.stdout.write(f"  {n_ok} design structure(s) converted")
                if moved:
                    self.stdout.write(f"  {moved} binder row(s) repointed")
                if n_bad:
                    self.stdout.write(f"  {n_bad} left as text")
            else:
                skipped += 1

            converted += n_ok
            repointed += moved
            failed += n_bad

            # Only now, with the database pointing at the .bcif, is the text
            # file redundant. See the module docstring.
            if not dry_run and not options["keep_text"]:
                for src in pending:
                    if os.path.exists(bcif.bcif_path_for(src)) and os.path.exists(src):
                        os.remove(src)

        verb = "would convert" if dry_run else "converted"
        self.stdout.write(self.style.SUCCESS(
            f"\nDone. {verb}: {converted}  rows repointed: {repointed}  "
            f"runs unchanged: {skipped}  failed: {failed}"))
        if bytes_after:
            self.stdout.write(
                f"{bytes_before / 1e6:.1f} MB -> {bytes_after / 1e6:.1f} MB "
                f"({bytes_before / bytes_after:.2f}x), max coord delta {worst:.6f} A")

    # -- the database side ---------------------------------------------------

    def _pairs(self, run):
        """(binder, new_relative_path) for every row whose .bcif now exists.

        Keyed on what is on disk rather than on what this pass converted, so an
        interrupted run finishes cleanly on the next invocation instead of
        leaving rows pointing at a file that has been replaced.
        """
        for binder in Binder.objects.filter(run=run).only("id", "cif_path").iterator():
            current = str(binder.cif_path or "")
            if not current.endswith(".cif"):
                continue
            new_rel = bcif.bcif_path_for(current)
            if os.path.exists(os.path.join(settings.MEDIA_ROOT, new_rel)):
                yield binder, new_rel

    def _would_repoint(self, run):
        return sum(1 for _ in self._pairs(run))

    def _repoint(self, run, batch_size):
        batch, moved = [], 0
        for binder, new_rel in self._pairs(run):
            binder.cif_path = new_rel
            batch.append(binder)
            if len(batch) >= batch_size:
                with transaction.atomic():
                    Binder.objects.bulk_update(batch, ["cif_path"], batch_size=batch_size)
                moved += len(batch)
                batch = []
        if batch:
            with transaction.atomic():
                Binder.objects.bulk_update(batch, ["cif_path"], batch_size=batch_size)
            moved += len(batch)
        return moved
