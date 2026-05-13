import os

from django.conf import settings
from django.core.management.base import BaseCommand

from binderbase.models import BinderRun
from binderbase.management.commands.import_run import _parse_cif_sequence


class Command(BaseCommand):
    help = "Backfill target_sequence for BinderRuns where it is empty by parsing their CIF file."

    def handle(self, *args, **options):
        runs = BinderRun.objects.filter(target_sequence__isnull=True)

        updated = 0
        skipped = 0
        failed = 0

        for run in runs:
            if not run.cif_path:
                self.stdout.write(f"Skipping BinderRun id={run.id}: no CIF path")
                skipped += 1
                continue

            cif_full_path = os.path.join(settings.MEDIA_ROOT, run.cif_path.name)
            seq = _parse_cif_sequence(cif_full_path)
            if seq:
                run.target_sequence = seq
                run.save(update_fields=["target_sequence"])
                self.stdout.write(f"Updated BinderRun id={run.id}: {len(seq)} aa")
                updated += 1
            else:
                self.stdout.write(self.style.WARNING(
                    f"Could not parse sequence for BinderRun id={run.id} (cif: {run.cif_path})"
                ))
                failed += 1

        self.stdout.write(self.style.SUCCESS(
            f"\nDone. Updated: {updated}  Skipped (no cif): {skipped}  Failed to parse: {failed}"
        ))
