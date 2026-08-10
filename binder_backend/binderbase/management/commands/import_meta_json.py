import os

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from binderbase.models import BinderRun

from .import_run import (
    RUN_DIR_PATTERN,
    _dir_name_mismatches,
    _parse_metadata,
    get_or_create_protein,
)


# BinderRun columns owned by meta.json. A key missing from the file clears its
# column, so the database always mirrors the current contents of the file.
META_OWNED_FIELDS = (
    "run_datetime",
    "algorithm",
    "hardware",
    "description",
    "notes",
)


def _format(value):
    """Short, readable rendering of a field value for the change log."""
    if value is None:
        return "None"
    text = str(value)
    return f"{text[:57]}..." if len(text) > 60 else text


class Command(BaseCommand):
    help = (
        "Re-read meta.json for runs that are already in the database and overwrite "
        "their fields with the current contents of the file. "
        "Pass a run folder name (e.g. P12345-tal1_screen-20260501) to update just "
        "that run; with no argument every run with a run_dir is re-scanned. "
        "This is a full resync, not a merge: a field whose key is absent from "
        "meta.json is set back to null. Use --dry-run to preview the changes. "
        "Unlike import_run, this command never creates or deletes runs and never "
        "touches binders."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "run_folder",
            nargs="?",
            default=None,
            help="Name of a single run directory under MEDIA_ROOT/runs/. "
                 "Omit to re-scan every run in the database.",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would change without writing to the database.",
        )

    def handle(self, *args, **options):
        run_folder = options["run_folder"]
        dry_run = options["dry_run"]

        runs = BinderRun.objects.select_related("protein").exclude(run_dir__isnull=True)
        if run_folder:
            # run_dir is stored relative to MEDIA_ROOT, so match on its last segment.
            run_folder = run_folder.rstrip("/")
            runs = [r for r in runs if os.path.basename(r.run_dir) == run_folder]
            if not runs:
                raise CommandError(
                    f"No imported run found for directory: {run_folder}"
                )
        else:
            runs = list(runs)
            if not runs:
                raise CommandError("No runs with a run_dir found in the database.")

        if dry_run:
            self.stdout.write(self.style.NOTICE("[dry run] no changes written\n"))

        updated = unchanged = failed = 0

        for run in runs:
            label = os.path.basename(run.run_dir)
            run_dir = os.path.join(settings.MEDIA_ROOT, run.run_dir)

            if not os.path.isdir(run_dir):
                self.stdout.write(self.style.ERROR(
                    f"{label}: run directory is missing ({run_dir}) - skipped"
                ))
                failed += 1
                continue

            meta_fields, metadata = _parse_metadata(run_dir)
            # A missing or broken file is a problem to fix, not an instruction to
            # clear every column, so the run is left exactly as it is.
            if meta_fields is None:
                self.stdout.write(self.style.ERROR(
                    f"{label}: meta.json is missing, unparseable, or not a JSON "
                    f"object - skipped, nothing changed"
                ))
                failed += 1
                continue

            uniprot_id = meta_fields.pop("uniprot_id")
            if not uniprot_id:
                self.stdout.write(self.style.ERROR(
                    f'{label}: meta.json has no usable "UniProt ID" - skipped, '
                    f"nothing changed"
                ))
                failed += 1
                continue

            changes = []

            # Protein reassignment. meta.json wins, but it moves the run to a
            # different protein's detail page, so it is always announced.
            current = run.protein.uniprot_id or ""
            if current.upper() != uniprot_id.upper():
                self.stdout.write(self.style.WARNING(
                    f'{label}: "UniProt ID" in meta.json ({uniprot_id}) differs from '
                    f"the run's protein ({current or 'none'}) - reassigning"
                ))
                if dry_run:
                    changes.append(f"protein  {current or 'none'} -> {uniprot_id}")
                else:
                    protein, created = get_or_create_protein(uniprot_id)
                    if created:
                        self.stdout.write(
                            f"  created Protein {uniprot_id} ({protein.protein_name})"
                        )
                    changes.append(f"protein  {current or 'none'} -> {uniprot_id}")
                    run.protein = protein

            for field in META_OWNED_FIELDS:
                new = meta_fields[field]
                if getattr(run, field) != new:
                    changes.append(
                        f"{field}  {_format(getattr(run, field))} -> {_format(new)}"
                    )
                    setattr(run, field, new)

            new_metadata = metadata or None
            if run.metadata != new_metadata:
                changes.append(
                    f"metadata  {_format(run.metadata)} -> {_format(new_metadata)}"
                )
                run.metadata = new_metadata

            # Same advisory cross-check import_run performs, so a folder renamed
            # after import still gets flagged here.
            name_match = RUN_DIR_PATTERN.match(label)
            if name_match:
                for problem in _dir_name_mismatches(
                    name_match, uniprot_id, meta_fields["run_datetime"]
                ):
                    self.stdout.write(self.style.WARNING(
                        f"{label}: directory name disagrees with meta.json ({problem})"
                    ))

            if not changes:
                unchanged += 1
                continue

            self.stdout.write(self.style.SUCCESS(label))
            for change in changes:
                self.stdout.write(f"  {change}")
            if not dry_run:
                run.save()
            updated += 1

        verb = "would update" if dry_run else "updated"
        self.stdout.write(self.style.SUCCESS(
            f"\nDone. {verb}: {updated}  unchanged: {unchanged}  failed: {failed}"
        ))
