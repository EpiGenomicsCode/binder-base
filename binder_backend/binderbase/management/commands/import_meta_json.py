"""Re-read meta.json for runs already in the database and resync their fields.

A full resync, not a merge: a field whose key is absent from meta.json is set
back to null, so the database always mirrors the current contents of the file.
That is the opposite policy from backfill_run_metadata, which only ever fills
gaps -- both are on RunUpdateCommand, and the difference between them is the
derive method, which is where it should be.

Never creates or deletes runs, and never touches binders.
"""
import os

from binderbase.management.runcommand import Change, RunUpdateCommand, Skip
from binderbase.models import Protein

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


class Command(RunUpdateCommand):
    # meta.json is authoritative by definition here, so there is nothing for a
    # --force to override.
    supports_force = False

    help = (
        "Re-read meta.json for runs that are already in the database and "
        "overwrite their fields with the current contents of the file. "
        "Pass a run folder name (e.g. P12345-tal1_screen-20260501) to update "
        "just that run; with no argument every run with a run_dir is "
        "re-scanned. This is a full resync, not a merge: a field whose key is "
        "absent from meta.json is set back to null. Use --dry-run to preview. "
        "Unlike import_run, this never creates or deletes runs and never "
        "touches binders."
    )

    def add_extra_arguments(self, parser):
        # Kept as a positional for the CLI this command already had; it means
        # the same thing as the inherited --run.
        parser.add_argument(
            "run_folder", nargs="?", default=None,
            help="Name of a single run directory under MEDIA_ROOT/runs/. "
                 "Omit to re-scan every run in the database.")

    def handle(self, *args, **options):
        if options.get("run_folder") and not options.get("run"):
            options["run"] = options["run_folder"]
        super().handle(*args, **options)

    def derive(self, run, options):
        if not run.run_dir:
            raise Skip()
        label = self.label_for(run)
        run_dir = self.media_path(run.run_dir)
        if not os.path.isdir(run_dir):
            raise Skip(f"run directory is missing ({run_dir})", is_error=True)

        meta_fields, metadata = _parse_metadata(run_dir)
        # A missing or broken file is a problem to fix, not an instruction to
        # clear every column, so the run is left exactly as it is.
        if meta_fields is None:
            raise Skip("meta.json is missing, unparseable, or not a JSON object",
                       is_error=True)

        uniprot_id = meta_fields.pop("uniprot_id")
        if not uniprot_id:
            raise Skip('meta.json has no usable "UniProt ID"', is_error=True)

        yield from self._protein_change(run, label, uniprot_id, options)

        for field in META_OWNED_FIELDS:
            yield Change(field, meta_fields[field])

        # metadata is replaced rather than merged, which is the resync
        # semantic: a key deleted from the file is deleted from the database.
        yield Change("metadata", metadata or None)

        # Same advisory cross-check import_run performs, so a folder renamed
        # after import still gets flagged here.
        name_match = RUN_DIR_PATTERN.match(label)
        if name_match:
            for problem in _dir_name_mismatches(
                name_match, uniprot_id, meta_fields["run_datetime"]
            ):
                self.stdout.write(self.style.WARNING(
                    f"{label}: directory name disagrees with meta.json ({problem})"))

    def _protein_change(self, run, label, uniprot_id, options):
        """meta.json wins, but reassignment moves the run to another protein's
        detail page, so it is always announced."""
        current = run.protein.uniprot_id or ""
        if current.upper() == uniprot_id.upper():
            return

        self.stdout.write(self.style.WARNING(
            f'{label}: "UniProt ID" in meta.json ({uniprot_id}) differs from '
            f"the run's protein ({current or 'none'}) - reassigning"))

        protein = Protein.objects.filter(uniprot_id__iexact=uniprot_id).first()
        if protein is None:
            if options.get("dry_run"):
                # get_or_create_protein fetches from AlphaFold, which a dry run
                # has no business doing.
                self.stdout.write(
                    f"  would create Protein {uniprot_id} (not fetched in a dry run)")
                return
            protein, created = get_or_create_protein(uniprot_id)
            if created:
                self.stdout.write(
                    f"  created Protein {uniprot_id} ({protein.protein_name})")
        yield Change("protein", protein)
