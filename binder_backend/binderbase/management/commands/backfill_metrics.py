"""Populate the promoted metric columns from the existing `metrics` JSON.

    python manage.py backfill_metrics --scan      # report only, touch nothing
    python manage.py backfill_metrics             # backfill rows not yet done
    python manage.py backfill_metrics --all       # recompute every row

Deliberately a management command rather than a RunPython inside the schema
migration. A data migration over hundreds of thousands of rows holds a
transaction open for its whole duration, and if it fails halfway the schema
migration is left half-applied. This runs in batches, each committed
separately, and can be re-run or interrupted safely.

Install at binderbase/management/commands/backfill_metrics.py
"""
from django.core.management.base import BaseCommand
from django.db import transaction

from binderbase.metrics import (
    ALL_FIELDS, BOOL_FIELDS, FLOAT_FIELDS, promoted, to_bool, to_float,
)
from binderbase.models import Binder

FIELD_MAP = FLOAT_FIELDS


class Command(BaseCommand):
    help = "Populate promoted metric columns from the metrics JSON blob."

    def add_arguments(self, parser):
        parser.add_argument("--scan", action="store_true",
                            help="report key coverage and uncastable values; change nothing")
        parser.add_argument("--all", action="store_true",
                            help="recompute every row, not just rows never backfilled")
        parser.add_argument("--batch-size", type=int, default=5000)

    # -- scan ---------------------------------------------------------------

    def _scan(self):
        """Look before migrating. BinderBase ingests runs from any design tool,
        so a missing key is normal; an uncastable value is not."""
        total = Binder.objects.count()
        if not total:
            self.stdout.write("no binders")
            return
        present = {f: 0 for f in ALL_FIELDS}
        unparsable = {f: {} for f in present}

        for metrics in Binder.objects.values_list("metrics", flat=True).iterator(chunk_size=5000):
            m = metrics or {}
            for field, key in FIELD_MAP.items():
                if key in m:
                    present[field] += 1
                    if to_float(m[key]) is None and m[key] not in (None, ""):
                        d = unparsable[field]
                        d[repr(m[key])] = d.get(repr(m[key]), 0) + 1
            for field, key in BOOL_FIELDS.items():
                if key in m:
                    present[field] += 1
                    if to_bool(m[key]) is None:
                        d = unparsable[field]
                        d[repr(m[key])] = d.get(repr(m[key]), 0) + 1

        self.stdout.write(f"binders: {total}\n")
        self.stdout.write(f"{'column':34s}{'present':>10}{'coverage':>10}")
        for field in present:
            n = present[field]
            self.stdout.write(f"  {field:32s}{n:>10}{100 * n / total:>9.1f}%")
        bad = {f: v for f, v in unparsable.items() if v}
        if bad:
            self.stdout.write(self.style.WARNING("\nvalues that will become NULL:"))
            for f, counts in bad.items():
                for val, n in sorted(counts.items(), key=lambda x: -x[1])[:5]:
                    self.stdout.write(f"  {f}: {val} x{n}")
        else:
            self.stdout.write("\nno uncastable values")

    # -- backfill -----------------------------------------------------------

    def handle(self, *args, **opts):
        if opts["scan"]:
            return self._scan()

        qs = Binder.objects.all()
        if not opts["all"]:
            # Rows never backfilled. Using one promoted column as the marker is
            # imperfect -- a run genuinely lacking it stays null and is revisited
            # on each run -- but it is cheap and never wrong, only wasteful.
            qs = qs.filter(min_interaction_pae__isnull=True)

        total = qs.count()
        if not total:
            self.stdout.write("nothing to backfill")
            return
        self.stdout.write(f"backfilling {total} binders (batch {opts['batch_size']})")

        fields = ALL_FIELDS
        done = changed = 0
        batch = []
        # .iterator() avoids pulling every row into memory at once.
        for b in qs.only("id", "metrics", *fields).iterator(chunk_size=opts["batch_size"]):
            dirty = False
            for field, v in promoted(b.metrics).items():
                if getattr(b, field) != v:
                    setattr(b, field, v)
                    dirty = True
            if dirty:
                batch.append(b)
            done += 1

            if len(batch) >= opts["batch_size"]:
                with transaction.atomic():
                    Binder.objects.bulk_update(batch, fields, batch_size=opts["batch_size"])
                changed += len(batch)
                batch = []
                self.stdout.write(f"  {done}/{total} scanned, {changed} updated")

        if batch:
            with transaction.atomic():
                Binder.objects.bulk_update(batch, fields, batch_size=opts["batch_size"])
            changed += len(batch)

        self.stdout.write(self.style.SUCCESS(f"done: {done} scanned, {changed} updated"))
