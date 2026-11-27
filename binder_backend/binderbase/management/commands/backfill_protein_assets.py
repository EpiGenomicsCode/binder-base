"""Re-fetch the AlphaFold assets and UniProt function text a protein is missing.

    python manage.py backfill_protein_assets --dry-run
    python manage.py backfill_protein_assets
    python manage.py backfill_protein_assets --uniprot O00115 --uniprot P36776
    python manage.py backfill_protein_assets --what cif,pae --delay 2

WHY THIS EXISTS

get_or_create_protein downloads the predicted structure and the PAE document
once, when a protein is first seen, and deliberately swallows a failed asset
download so that one bad fetch cannot abort an otherwise good run import
(import_run.py, "a failed asset download must not abort an otherwise good
run"). That is the right call during an import. The cost is that the failure
leaves no trace except a null column, and nothing ever retries it.

The CCR campaign import made that concrete: 9 of 1,562 proteins came out with
no cif_path and 12 with no pae_json_path. They were transient resolver
failures, not missing models -- O00115 is the proof, having lost its CIF and
kept its PAE from the same host moments apart. A protein with no structure
still renders, because ProteinDetail gates the whole panel on
`cif_path || pae_json_path`; a protein missing BOTH loses the panel silently.

WHAT COUNTS AS MISSING

A column that is empty, and also a column that points at a file which is no
longer on disk. The second is the one a human would never think to look for:
the page renders a viewer that fetches a 404.

Where the column is empty but the file IS present -- a download that landed
and then failed to record itself -- the row is repointed with no network call
at all.

ON --dry-run AND THE NETWORK

A dry run writes nothing and downloads nothing, but it DOES make one metadata
request per protein, because the question worth answering before committing is
not "what is null" (the database already says that) but "is this actually
recoverable". A protein with no AlphaFold model at all needs a different
answer than one that lost a download, and only the API distinguishes them.

A NOTE ON --what function

_fetch_biological_function returns None both when the lookup fails and when
UniProt simply has no FUNCTION comment for the accession, and the two are not
distinguishable from the outside. So a protein genuinely lacking an annotation
is re-attempted on every run. That costs one request and is reported as
"no function recorded upstream" rather than as a failure.
"""
import os
import time

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from binderbase.management.commands.import_run import (
    _download_file, _fetch_alphafold, _fetch_biological_function,
)
from binderbase.models import Protein

#: field name -> (filename under proteins/<uniprot>/, key in the AlphaFold payload)
ASSETS = {
    "cif": ("cif_path", "model.cif", "cif_url"),
    "pae": ("pae_json_path", "pae.json", "pae_doc_url"),
}
CHOICES = list(ASSETS) + ["function"]


def media_path(relative):
    return os.path.join(settings.MEDIA_ROOT, relative)


class Command(BaseCommand):
    help = "Re-fetch AlphaFold structure/PAE files and UniProt function text for proteins missing them."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true",
                            help="report what would be fetched; download nothing, write nothing")
        parser.add_argument("--uniprot", action="append", metavar="ID",
                            help="limit to this accession; repeatable")
        parser.add_argument("--what", default=",".join(CHOICES),
                            help=f"comma-separated subset of {CHOICES} (default: all)")
        parser.add_argument("--delay", type=float, default=1.0,
                            help="seconds to wait between proteins (default: 1.0). The gaps "
                                 "being repaired came from hammering the resolver during a "
                                 "2,000-run import; do not set this to 0 for a large batch.")
        parser.add_argument("--limit", type=int, help="stop after N proteins")
        parser.add_argument("--force", action="store_true",
                            help="re-fetch even where the column is already populated")

    def handle(self, *args, **options):
        wanted = [w.strip() for w in options["what"].split(",") if w.strip()]
        unknown = [w for w in wanted if w not in CHOICES]
        if unknown:
            raise CommandError(f"--what: unknown {unknown}; choose from {CHOICES}")

        dry = options["dry_run"]
        force = options["force"]
        delay = max(0.0, options["delay"])

        proteins = Protein.objects.exclude(uniprot_id="").exclude(uniprot_id=None)
        if options["uniprot"]:
            proteins = proteins.filter(uniprot_id__in=options["uniprot"])
        proteins = proteins.order_by("uniprot_id")

        todo = []
        for protein in proteins:
            gaps = self._gaps(protein, wanted, force)
            if gaps:
                todo.append((protein, gaps))
        if options["limit"]:
            todo = todo[: options["limit"]]

        if not todo:
            self.stdout.write(self.style.SUCCESS("Nothing missing. No requests made."))
            return

        self.stdout.write(
            f"{len(todo)} protein(s) with gaps in {wanted}"
            + (" -- DRY RUN, nothing will be written" if dry else "")
        )

        fixed = failed = unavailable = repointed = 0
        for index, (protein, gaps) in enumerate(todo):
            if index and delay:
                time.sleep(delay)
            label = f"{protein.uniprot_id} ({protein.gene_name or '?'})"

            # Repoint first: a file already on disk needs no request at all, and
            # doing this before the lookup keeps those proteins off the network.
            for kind in [g for g in gaps if g in ASSETS]:
                field, filename, _ = ASSETS[kind]
                dest = os.path.join(settings.MEDIA_ROOT, "proteins", protein.uniprot_id, filename)
                if os.path.isfile(dest) and not getattr(protein, field):
                    rel = os.path.relpath(dest, settings.MEDIA_ROOT)
                    self.stdout.write(f"  {label}: {field} <- {rel} (file already on disk)")
                    if not dry:
                        setattr(protein, field, rel)
                        protein.save(update_fields=[field])
                    gaps.remove(kind)
                    repointed += 1

            if not gaps:
                continue

            asset_gaps = [g for g in gaps if g in ASSETS]
            data = None
            if asset_gaps:
                try:
                    data = _fetch_alphafold(protein.uniprot_id)
                except CommandError as exc:
                    self.stdout.write(self.style.WARNING(f"  {label}: lookup failed -- {exc}"))
                    failed += 1
                    continue

            got = []
            for kind in asset_gaps:
                field, filename, url_key = ASSETS[kind]
                url = (data or {}).get(url_key)
                if not url:
                    self.stdout.write(f"  {label}: no {kind} offered by AlphaFold for this accession")
                    unavailable += 1
                    continue
                if dry:
                    got.append(f"{kind} available")
                    continue
                dest = os.path.join(settings.MEDIA_ROOT, "proteins", protein.uniprot_id, filename)
                try:
                    _download_file(url, dest)
                except Exception as exc:  # noqa: BLE001 -- one bad download must not stop the batch
                    self.stdout.write(self.style.WARNING(f"  {label}: {kind} download failed -- {exc}"))
                    failed += 1
                    continue
                setattr(protein, field, os.path.relpath(dest, settings.MEDIA_ROOT))
                got.append(f"{kind} {os.path.getsize(dest)}B")

            if "function" in gaps:
                text = _fetch_biological_function(protein.uniprot_id)
                if text:
                    got.append(f"function {len(text)} chars")
                    if not dry:
                        protein.biological_function = text
                else:
                    self.stdout.write(f"  {label}: no function recorded upstream")
                    unavailable += 1

            if not got:
                continue
            self.stdout.write(
                ("  would fetch " if dry else "  fetched ") + f"{label}: {', '.join(got)}"
            )
            if not dry:
                # Saving the whole row rather than update_fields: which columns
                # changed varies per protein, and the alternative is assembling
                # that list in two places and letting them disagree.
                protein.save()
            fixed += 1

        verb = "would fix" if dry else "fixed"
        self.stdout.write(self.style.SUCCESS(
            f"\nDone. {verb}: {fixed}  repointed: {repointed}  "
            f"unavailable upstream: {unavailable}  failed: {failed}"
        ))
        if dry:
            self.stdout.write("Re-run without --dry-run to download and save.")

    def _gaps(self, protein, wanted, force):
        """Which of `wanted` this protein is missing, as a fresh list."""
        gaps = []
        for kind in wanted:
            if kind == "function":
                if force or not protein.biological_function:
                    gaps.append(kind)
                continue
            field, _, _ = ASSETS[kind]
            value = getattr(protein, field)
            # A column pointing at a file that is gone is as missing as a null
            # one -- more so, since the page renders a viewer that 404s.
            if force or not value or not os.path.isfile(media_path(value.name)):
                gaps.append(kind)
        return gaps
