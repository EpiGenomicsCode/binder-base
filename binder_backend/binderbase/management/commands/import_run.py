import csv
import glob as glob_module
import json
import os
import re
import urllib.request
from datetime import datetime

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from binderbase.models import Binder, BinderRun, Protein


RUN_DIR_PATTERN = re.compile(
    r"^(?P<uniprot>[A-Z0-9]+)-(?P<algorithm>.+)-(?P<date>\d{8})$"
)

ALPHAFOLD_API = "https://alphafold.ebi.ac.uk/api/prediction/{}"
UNIPROT_API = "https://rest.uniprot.org/uniprotkb/{}.json"

# Maps CSV column names (lowercase) to Binder model field names
CSV_COLUMN_MAP = {
    "sequence": "binder_sequence",
    "final_rank": "final_rank",
    "quality_score": "quality_score",
    "design_to_target_iptm": "design_to_target_iptm",
}


def _fetch_alphafold(uniprot_id):
    url = ALPHAFOLD_API.format(uniprot_id)
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read())
    except Exception as exc:
        raise CommandError(f"AlphaFold lookup failed for {uniprot_id}: {exc}")

    entry = data[0]
    sequence = entry.get("sequence", "")
    return {
        "sequence": sequence,
        "length": len(sequence),
        "gene_name": entry.get("gene"),
        "protein_name": entry.get("uniprotDescription"),
        "organism": entry.get("organismScientificName"),
        "cif_url": entry.get("cifUrl"),
        "pae_doc_url": entry.get("paeDocUrl"),
    }


def _fetch_biological_function(uniprot_id):
    url = UNIPROT_API.format(uniprot_id)
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read())
        for comment in data.get("comments", []):
            if comment.get("commentType") == "FUNCTION":
                texts = comment.get("texts", [])
                if texts:
                    return texts[0].get("value")
    except Exception:
        pass
    return None


def _download_file(url, dest_path):
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    with urllib.request.urlopen(url, timeout=30) as resp:
        with open(dest_path, "wb") as f:
            f.write(resp.read())


class Command(BaseCommand):
    help = (
        "Import new binder design run directories into BinderRun database."
        "It searches under the folder MEDIA_ROOT/runs for run directories whose path is not in the database yet."
        "The run directories must be named with the pattern: <protein_uniprot>-<algorithm_version>-<run_date>, e.g. P12345-myalgorithm_v1-20260330."
        "Each run directory should contain a steps.yaml file, a config folder with the yaml configuration files, a CIF file for the original structure, "
        "and a folder final_ranked_designs that contains a csv file and a folder of CIF files. "
        "The command will create a BinderRun record and associate it with the specified Protein (by UniProt ID). "
        "If the Protein does not exist, it will query the UniProt database and populate the protein entry."
    )

    # TODO: import additional metadata from the steps.yaml (or another file), e.g. hardware, notes, etc.

    def handle(self, *args, **options):
        runs_root = os.path.join(settings.MEDIA_ROOT, "runs")
        if not os.path.isdir(runs_root):
            raise CommandError(f"Runs directory does not exist: {runs_root}")

        existing_run_dirs = set(BinderRun.objects.values_list("run_dir", flat=True))

        # concatenate each existing run dir with MEDIA_ROOT to get the full path for comparison
        existing_run_dirs = set(os.path.join(settings.MEDIA_ROOT, rd) for rd in existing_run_dirs)

        imported = 0
        skipped = 0

        for entry in os.scandir(runs_root):
            if not entry.is_dir():
                continue

            run_dir = entry.path
            run_dir_rel = os.path.relpath(run_dir, settings.MEDIA_ROOT)

            # Check if this run_dir is already in the database (compare full paths)
            if run_dir in existing_run_dirs:
                self.stdout.write(f"Skipping (already imported): {entry.name}")
                skipped += 1
                continue

            # Skip directories that do not match the expected naming pattern
            match = RUN_DIR_PATTERN.match(entry.name)
            if not match:
                self.stdout.write(self.style.WARNING(
                    f"Skipping (name does not match pattern): {entry.name}"
                ))
                skipped += 1
                continue

            uniprot_id = match.group("uniprot")
            algorithm_version = match.group("algorithm")
            run_datetime = datetime.strptime(match.group("date"), "%Y%m%d")

            # Check for required final designs
            designs_dir = os.path.join(run_dir, "final_ranked_designs")
            if not os.path.isdir(designs_dir):
                self.stdout.write(self.style.WARNING(
                    f"Skipping (no final_ranked_designs folder): {entry.name}"
                ))
                skipped += 1
                continue

            # Find CIF file for the original structure in the run root
            root_cif_files = glob_module.glob(os.path.join(run_dir, "*.cif"))
            run_cif_rel = (
                os.path.relpath(root_cif_files[0], settings.MEDIA_ROOT)
                if root_cif_files
                else None
            )

            # Get or create Protein
            try:
                protein = Protein.objects.get(uniprot_id=uniprot_id)
                self.stdout.write(f"Found Protein: {uniprot_id}")
            except Protein.DoesNotExist:
                self.stdout.write(f"Fetching AlphaFold data for: {uniprot_id} ...")
                alphafold_data = _fetch_alphafold(uniprot_id)
                biological_function = _fetch_biological_function(uniprot_id)

                proteins_dir = os.path.join(settings.MEDIA_ROOT, "proteins", uniprot_id)
                cif_rel = pae_rel = None

                if alphafold_data.get("cif_url"):
                    cif_dest = os.path.join(proteins_dir, "model.cif")
                    _download_file(alphafold_data["cif_url"], cif_dest)
                    cif_rel = os.path.relpath(cif_dest, settings.MEDIA_ROOT)

                if alphafold_data.get("pae_doc_url"):
                    pae_dest = os.path.join(proteins_dir, "pae.json")
                    _download_file(alphafold_data["pae_doc_url"], pae_dest)
                    pae_rel = os.path.relpath(pae_dest, settings.MEDIA_ROOT)

                protein = Protein.objects.create(
                    uniprot_id=uniprot_id,
                    sequence=alphafold_data["sequence"],
                    length=alphafold_data["length"],
                    gene_name=alphafold_data["gene_name"],
                    protein_name=alphafold_data["protein_name"],
                    organism=alphafold_data["organism"],
                    biological_function=biological_function,
                    cif_path=cif_rel,
                    pae_json_path=pae_rel,
                )
                self.stdout.write(
                    f"Created Protein: {uniprot_id} ({protein.protein_name})"
                )

            run = BinderRun.objects.create(
                protein=protein,
                algorithm_version=algorithm_version,
                run_datetime=run_datetime,
                run_dir=run_dir_rel,
                cif_path=run_cif_rel,
            )

            csv_files = glob_module.glob(os.path.join(designs_dir, "*.csv"))
            binder_count = 0
            if csv_files:
                binder_count = self._import_binders(run, designs_dir, csv_files[0])

            self.stdout.write(self.style.SUCCESS(
                f"Imported: {entry.name}  BinderRun id={run.id}  binders={binder_count}"
            ))
            imported += 1

        self.stdout.write(self.style.SUCCESS(
            f"\nDone. Imported: {imported}  Skipped: {skipped}"
        ))

    def _import_binders(self, run, designs_dir, csv_path):
        binders = []

        with open(csv_path, newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                fields = {"run": run}
                extra_metrics = {}

                for col, val in row.items():
                    model_field = CSV_COLUMN_MAP.get(col.strip().lower())
                    val = val.strip() if val else None
                    if model_field:
                        fields[model_field] = val or None
                    else:
                        extra_metrics[col] = val

                if "binder_sequence" not in fields or not fields["binder_sequence"]:
                    continue

                fields.setdefault("binder_length", len(fields["binder_sequence"]))

                for int_field in ("final_rank", "binder_length"):
                    if fields.get(int_field) is not None:
                        try:
                            fields[int_field] = int(fields[int_field])
                        except (ValueError, TypeError):
                            fields[int_field] = None

                for float_field in ("quality_score", "design_to_target_iptm"):
                    if fields.get(float_field) is not None:
                        try:
                            fields[float_field] = float(fields[float_field])
                        except (ValueError, TypeError):
                            fields[float_field] = None

                # Infer status from "pass_filters" column if it exists
                pass_filters = next(
                    (v for k, v in row.items() if k.strip().lower() == "pass_filters"),
                    None,
                )
                if pass_filters is not None:
                    if pass_filters.strip().lower() == "true":
                        fields["status"] = "success"
                    else:
                        fields["status"] = "failed"
                        failed_filters = [
                            re.sub(r"^pass_", "", k.strip(), flags=re.IGNORECASE)
                            for k, v in row.items()
                            if re.match(r"pass_.+_filter$", k.strip().lower())
                            and (v or "").strip().lower() == "false"
                        ]
                        if failed_filters:
                            fields["failure_reason"] = "failed to pass " + ", ".join(failed_filters)

                if extra_metrics:
                    fields["metrics"] = extra_metrics

                # Find matching CIF file in designs_dir by rank and file_name
                rank = fields.get("final_rank")

                file_name = next(
                    (v for k, v in extra_metrics.items() if k.strip().lower() == "file_name"),
                    None,
                )

                if rank is not None and file_name:
                    cif_name = f"rank{rank:03d}_{file_name}"

                    cif_matches = glob_module.glob(
                        os.path.join(designs_dir, "**", cif_name),
                        recursive=True,
                    )
                    if cif_matches:
                        fields["cif_path"] = os.path.relpath(
                            cif_matches[0], settings.MEDIA_ROOT
                        )

                binders.append(Binder(**fields))
        
        Binder.objects.bulk_create(binders)
        return len(binders)
