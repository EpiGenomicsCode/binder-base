"""Bulk-edit a field across a selected set of runs, keeping the old value.

    python manage.py relabel_runs --algorithm F1model_v6_trimmed \\
        --set algorithm "BoltzGen v1.0" --keep-as "Model checkpoint" --dry-run

BinderBase's `algorithm` is free text written by whatever produced the run, so
one method arrives under several spellings -- there are already four in the
database, and the Method column shows each as a distinct method. Fixing that
is a recurring edit, not a one-off, which is why it is a command rather than a
flag on a backfill.

--keep-as exists because the value being replaced is often not wrong, just
misfiled: `F1model_v6_trimmed` is a checkpoint name, not a method, and it is
the only record of which weights produced those designs. Discarding it to
tidy a label would lose provenance to gain presentation.
"""
from binderbase.management.runcommand import Change, RunUpdateCommand, Skip

#: Fields safe to rewrite in bulk. Deliberately not open-ended: `run_dir` is
#: unique and anchors the importer, `protein` moves a run to another page, and
#: the metric columns belong to the importer.
EDITABLE = ("algorithm", "description", "notes", "hardware")


class Command(RunUpdateCommand):
    help = (
        "Set a field to the same value across every selected run, optionally "
        "preserving the previous value in the run's metadata. Editable fields: "
        + ", ".join(EDITABLE) + ". Use --dry-run to preview."
    )

    def add_extra_arguments(self, parser):
        parser.add_argument(
            "--set", nargs=2, metavar=("FIELD", "VALUE"), required=True,
            help="Field to set and the value to set it to.")
        parser.add_argument(
            "--keep-as", default=None, metavar="KEY",
            help="Store the previous value under this metadata key rather "
                 "than discarding it. An existing key is never overwritten.")

    def derive(self, run, options):
        field, value = options["set"]
        if field not in EDITABLE:
            # Raised per run rather than up front so the message names the
            # field the user actually typed.
            raise Skip(f"{field} is not an editable field "
                       f"(choose from {', '.join(EDITABLE)})", is_error=True)

        current = getattr(run, field)
        if current == value:
            raise Skip()

        keep_as = options.get("keep_as")
        if keep_as and current and not (run.metadata or {}).get(keep_as):
            yield Change(keep_as, current, in_metadata=True)
        yield Change(field, value)
