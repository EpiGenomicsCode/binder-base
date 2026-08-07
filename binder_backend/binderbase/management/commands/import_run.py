import csv
import glob as glob_module
import json
import os
import re
import urllib.request
from datetime import datetime

import yaml

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from binderbase.models import Binder, BinderRun, Protein


# Run directories are named <UNIPROT_ID>-<RUN_LABEL>-<YYYYMMDD>. The name is only
# validated as a housekeeping convention — every imported value comes from meta.json.
RUN_DIR_PATTERN = re.compile(r"^[A-Z0-9]+-.+-\d{8}$")

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


CONFIG_PATH_KEYS = {"config", "config_file", "config_path"}


def _load_config_file(file_path):
    """Load a referenced config file (YAML or JSON). Returns None if invalid."""
    ext = os.path.splitext(file_path)[1].lower()
    try:
        with open(file_path) as f:
            if ext in (".yaml", ".yml"):
                return yaml.safe_load(f)
            if ext == ".json":
                return json.load(f)
    except (OSError, yaml.YAMLError, json.JSONDecodeError):
        return None
    return None


def _inline_config_files(node, run_dir):
    """Walk the parsed steps.yaml tree and replace config-path strings
    with the parsed contents of the referenced file (resolved relative to
    run_dir).
    """
    if isinstance(node, dict):
        for key in list(node.keys()):
            val = node[key]
            if key in CONFIG_PATH_KEYS and isinstance(val, str):
                file_path = os.path.join(run_dir, val)
                if os.path.isfile(file_path):
                    parsed = _load_config_file(file_path)
                    if parsed is not None:
                        node[key] = parsed
                        # Skip recursing into the freshly-loaded content.
                        continue
            _inline_config_files(val, run_dir)
    elif isinstance(node, list):
        for item in node:
            _inline_config_files(item, run_dir)


def _parse_steps_config(run_dir):
    """Load steps.yaml and inline any referenced config files.
    Returns None if steps.yaml is missing/invalid.
    """
    steps_path = os.path.join(run_dir, "steps.yaml")
    if not os.path.isfile(steps_path):
        return None
    try:
        with open(steps_path) as f:
            data = yaml.safe_load(f)
    except (OSError, yaml.YAMLError):
        return None
    if data is None:
        return None
    _inline_config_files(data, run_dir)
    return data


# meta.json keys lifted out into BinderRun columns; everything else is kept as-is
# in the run's `metadata`. Keys are matched case- and whitespace-insensitively so
# hand-written files are forgiving ("UniProt ID", "uniprot_id", "UNIPROT  ID").
META_UNIPROT_KEY = "uniprot id"
META_RUN_DATE_KEY = "run date"
META_ALGORITHM_KEY = "algorithm"

# Unambiguous date formats only — no day-first/month-first guessing.
RUN_DATE_FORMATS = ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d")


def _normalize_meta_key(key):
    return re.sub(r"[\s_-]+", " ", str(key)).strip().lower()


def _parse_run_date(value):
    """Parse a meta.json "Run date" value. Returns None if unrecognized."""
    if isinstance(value, int) and not isinstance(value, bool):
        value = str(value)  # unquoted 20260501
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        pass
    for fmt in RUN_DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def _clean_str(value):
    """Coerce a scalar meta.json value to a trimmed string. None if not scalar."""
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    return str(value).strip() or None


def _parse_metadata(run_dir):
    """Load meta.json from the run root.

    Returns ``(fields, metadata)``: `fields` holds the values lifted into BinderRun
    columns, `metadata` is every remaining key. Returns ``(None, None)`` when
    meta.json is missing, unparseable, or not a JSON object — the run cannot be
    identified without it.
    """
    meta_path = os.path.join(run_dir, "meta.json")
    if not os.path.isfile(meta_path):
        return None, None
    try:
        with open(meta_path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None, None
    if not isinstance(data, dict):
        return None, None

    # A recognized key whose value cannot be used falls through to `metadata`
    # rather than being dropped, so nothing in meta.json is ever lost.
    consumers = {
        META_UNIPROT_KEY: ("uniprot_id", _clean_str),
        META_RUN_DATE_KEY: ("run_datetime", _parse_run_date),
        META_ALGORITHM_KEY: ("algorithm_version", _clean_str),
    }

    fields = {name: None for name, _ in consumers.values()}
    metadata = {}
    for key, val in data.items():
        field, parse = consumers.get(_normalize_meta_key(key), (None, None))
        parsed = parse(val) if field else None
        if parsed is None:
            metadata[key] = val
        else:
            fields[field] = parsed
    return fields, metadata


def _parse_cif_sequence(cif_path):
    """Extract target sequence from a BinderRun CIF file (_entity_poly section)."""
    try:
        with open(cif_path) as f:
            text = f.read()
    except OSError:
        return None

    for key in [
        "_entity_poly.pdbx_seq_one_letter_code_can",
        "_entity_poly.pdbx_seq_one_letter_code",
    ]:
        # Semicolon-delimited multi-line value (non-loop format)
        m = re.search(re.escape(key) + r"\s*\n;([\s\S]*?)\n;", text, re.IGNORECASE)
        if m:
            seq = re.sub(r"\s+", "", m.group(1)).upper()
            if seq:
                return seq

        # Single-line key-value (non-loop format) — use [ \t]+ to avoid crossing newlines
        m = re.search(r"^" + re.escape(key) + r"[ \t]+(\S+)", text, re.IGNORECASE | re.MULTILINE)
        if m and m.group(1) not in (".", "?") and not m.group(1).startswith("_"):
            seq = m.group(1).strip("'\"").upper()
            if seq:
                return seq

        # Loop format: key appears as a column definition line
        lines = text.split("\n")
        key_lower = key.lower()
        for key_idx, line in enumerate(lines):
            if line.strip().lower() != key_lower:
                continue
            # Count preceding consecutive _field lines to determine column index
            col_idx = 0
            back = key_idx - 1
            while back >= 0 and lines[back].strip().startswith("_"):
                col_idx += 1
                back -= 1
            # Skip to the first data row
            data_idx = key_idx + 1
            while data_idx < len(lines) and lines[data_idx].strip().startswith("_"):
                data_idx += 1
            while data_idx < len(lines) and not lines[data_idx].strip():
                data_idx += 1
            if data_idx >= len(lines):
                continue
            tokens = lines[data_idx].strip().split()
            if col_idx < len(tokens):
                seq = tokens[col_idx].upper()
                if seq and seq not in (".", "?"):
                    return seq

    return None


class Command(BaseCommand):
    help = (
        "Import new binder design run directories into BinderRun database."
        "It searches under the folder MEDIA_ROOT/runs for run directories whose path is not in the database yet."
        "The run directories must be named with the pattern: <UNIPROT_ID>-<RUN_LABEL>-<YYYYMMDD>, e.g. P12345-tal1_screen-20260330. "
        "The name is validated but nothing is read from it. "
        "Each run directory must contain a meta.json file in its root, which supplies the run's "
        "\"UniProt ID\" (required), \"Run date\" and \"Algorithm\"; every other key in that file is stored in the run's metadata field. "
        "Each run directory should also contain a steps.yaml file, a config folder with the yaml configuration files, a CIF file for the original structure, "
        "and a folder final_ranked_designs that contains a csv file and a folder of CIF files. "
        "The command will create a BinderRun record and associate it with the specified Protein (by UniProt ID). "
        "If the Protein does not exist, it will query the UniProt database and populate the protein entry."
    )
    
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
            if not RUN_DIR_PATTERN.match(entry.name):
                self.stdout.write(self.style.WARNING(
                    f"Skipping (name does not match pattern): {entry.name}"
                ))
                skipped += 1
                continue

            # Check for required final designs
            designs_dir = os.path.join(run_dir, "final_ranked_designs")
            if not os.path.isdir(designs_dir):
                self.stdout.write(self.style.WARNING(
                    f"Skipping (no final_ranked_designs folder): {entry.name}"
                ))
                skipped += 1
                continue

            # meta.json is the sole source of the run's identity — nothing is
            # inferred from the directory name.
            meta_fields, metadata = _parse_metadata(run_dir)
            if meta_fields is None:
                self.stdout.write(self.style.WARNING(
                    f"Skipping (missing or invalid meta.json): {entry.name}"
                ))
                skipped += 1
                continue

            uniprot_id = meta_fields["uniprot_id"]
            if not uniprot_id:
                self.stdout.write(self.style.WARNING(
                    f'Skipping (meta.json has no "UniProt ID"): {entry.name}'
                ))
                skipped += 1
                continue

            algorithm_version = meta_fields["algorithm_version"]
            run_datetime = meta_fields["run_datetime"]
            if run_datetime is None:
                self.stdout.write(self.style.WARNING(
                    f'No usable "Run date" in meta.json, importing without one: {entry.name}'
                ))

            # Find CIF file for the original structure in the run root
            root_cif_files = glob_module.glob(os.path.join(run_dir, "*.cif"))
            run_cif_rel = (
                os.path.relpath(root_cif_files[0], settings.MEDIA_ROOT)
                if root_cif_files
                else None
            )
            target_sequence = _parse_cif_sequence(root_cif_files[0]) if root_cif_files else None

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

            steps_config = _parse_steps_config(run_dir)

            run = BinderRun.objects.create(
                protein=protein,
                algorithm_version=algorithm_version,
                run_datetime=run_datetime,
                run_dir=run_dir_rel,
                cif_path=run_cif_rel,
                target_sequence=target_sequence,
                steps_config=steps_config,
                metadata=metadata or None,
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
                    # Rank in the CIF filename may use any width (e.g.
                    # rank1_, rank01_, rank001_), so glob a wildcard and
                    # filter to the exact numeric rank.
                    rank_re = re.compile(
                        rf"^rank0*{int(rank)}_{re.escape(file_name)}$"
                    )
                    cif_matches = [
                        p
                        for p in glob_module.glob(
                            os.path.join(designs_dir, "**", f"rank*_{file_name}"),
                            recursive=True,
                        )
                        if rank_re.match(os.path.basename(p))
                    ]
                    if cif_matches:
                        fields["cif_path"] = os.path.relpath(
                            cif_matches[0], settings.MEDIA_ROOT
                        )

                binders.append(Binder(**fields))
        
        Binder.objects.bulk_create(binders)
        return len(binders)
