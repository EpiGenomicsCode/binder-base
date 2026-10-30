import csv
import glob as glob_module
import json
import logging
import os
import re
import urllib.request
from datetime import datetime

import yaml

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from binderbase import accessions, structure
from binderbase.metrics import promoted
from binderbase.models import Binder, BinderRun, Protein

logger = logging.getLogger(__name__)


# Run directories are named <UNIPROT_ID>-<RUN_LABEL>-<YYYYMMDD>. Every imported value
# comes from meta.json; the captured parts are only cross-checked against it so a
# stale or copy-pasted directory name gets noticed.
RUN_DIR_PATTERN = re.compile(
    r"^(?P<uniprot>[A-Z0-9]+)-(?P<label>.+)-(?P<date>\d{8})$"
)

ALPHAFOLD_API = "https://alphafold.ebi.ac.uk/api/prediction/{}"
UNIPROT_API = "https://rest.uniprot.org/uniprotkb/{}.json"

# Maps CSV column names (lowercase) to Binder model field names
CSV_COLUMN_MAP = {
    "sequence": "binder_sequence",
    # BoltzGen names this column "designed_sequence"; without this entry every
    # row fails the "binder_sequence" check below and the run imports 0 binders
    # while still reporting success.
    "designed_sequence": "binder_sequence",
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
# in the run's `metadata`. Keys are compared with separators and case stripped, so
# hand-written files are forgiving ("UniProt ID", "uniprot_id", "UNIPROT-ID").
META_UNIPROT_KEY = "uniprotid"
META_RUN_DATE_KEY = "rundate"
META_ALGORITHM_KEY = "algorithm"
META_HARDWARE_KEY = "hardware"
META_DESCRIPTION_KEY = "description"
META_NOTES_KEY = "notes"

# Unambiguous date formats only — no day-first/month-first guessing.
RUN_DATE_FORMATS = ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d")


def _normalize_meta_key(key):
    return re.sub(r"[\s_-]+", "", str(key)).lower()


def _make_aware(parsed):
    """Attach the current time zone to a naive datetime when USE_TZ is on.

    Most accepted formats carry no offset, and storing those naive triggers a
    RuntimeWarning from DateTimeField and an ambiguous value in the database.
    A string that already specified an offset is left as it is.
    """
    if settings.USE_TZ and timezone.is_naive(parsed):
        return timezone.make_aware(parsed)
    return parsed


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
        return _make_aware(datetime.fromisoformat(text))
    except ValueError:
        pass
    for fmt in RUN_DATE_FORMATS:
        try:
            return _make_aware(datetime.strptime(text, fmt))
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
        META_ALGORITHM_KEY: ("algorithm", _clean_str),
        META_HARDWARE_KEY: ("hardware", _clean_str),
        META_DESCRIPTION_KEY: ("description", _clean_str),
        META_NOTES_KEY: ("notes", _clean_str),
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


def _dir_name_mismatches(match, uniprot_id, run_datetime):
    """Cross-check the directory name against what meta.json supplied.

    Nothing here changes what is imported — meta.json always wins. Returns a list
    of human-readable descriptions, empty when the two agree or when meta.json had
    no value to compare against.
    """
    problems = []

    dir_uniprot = match.group("uniprot")
    # UniProt accessions are canonically uppercase, so case alone is not a mismatch.
    if uniprot_id and dir_uniprot.upper() != uniprot_id.upper():
        problems.append(f'UniProt ID "{dir_uniprot}" vs meta.json "{uniprot_id}"')

    dir_date_text = match.group("date")
    try:
        dir_date = datetime.strptime(dir_date_text, "%Y%m%d").date()
    except ValueError:
        # 8 digits that aren't a real calendar date, e.g. 20261345.
        problems.append(f'date "{dir_date_text}" is not a valid date')
    else:
        if run_datetime is not None and dir_date != run_datetime.date():
            problems.append(
                f'date "{dir_date_text}" vs meta.json "{run_datetime:%Y%m%d}"'
            )

    return problems


def get_or_create_protein(uniprot_id):
    """Look up a Protein by UniProt ID, creating it from AlphaFold/UniProt if new.

    Returns ``(protein, created)``. Creating one downloads the predicted structure
    and PAE files, so this hits the network only on a miss. Shared with the
    import_meta_json command.
    """
    try:
        return Protein.objects.get(uniprot_id=uniprot_id), False
    except Protein.DoesNotExist:
        pass

    alphafold_data = _fetch_alphafold(uniprot_id)
    biological_function = _fetch_biological_function(uniprot_id)

    proteins_dir = os.path.join(settings.MEDIA_ROOT, "proteins", uniprot_id)
    cif_rel = pae_rel = None

    # alphafold.ebi.ac.uk/files/ refuses requests from some networks even when the
    # API responds, so a failed asset download must not abort an otherwise good run.
    if alphafold_data.get("cif_url"):
        cif_dest = os.path.join(proteins_dir, "model.cif")
        try:
            _download_file(alphafold_data["cif_url"], cif_dest)
            cif_rel = os.path.relpath(cif_dest, settings.MEDIA_ROOT)
        except Exception as exc:  # noqa: BLE001
            logger.warning("CIF download failed for %s: %s", uniprot_id, exc)

    if alphafold_data.get("pae_doc_url"):
        pae_dest = os.path.join(proteins_dir, "pae.json")
        try:
            _download_file(alphafold_data["pae_doc_url"], pae_dest)
            pae_rel = os.path.relpath(pae_dest, settings.MEDIA_ROOT)
        except Exception as exc:  # noqa: BLE001
            logger.warning("PAE download failed for %s: %s", uniprot_id, exc)

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
    return protein, True


# Moved to binderbase.structure, which is also where the B-factor constraint
# reading lives: both parse the same file, and keeping one CIF reader means
# the importer and the backfill cannot disagree about what it says.
_parse_cif_sequence = structure.sequence_from_cif


# Metadata keys, named as make_meta_json writes them. The API reads them back
# by these names, so they are not free to drift.
KEY_HOTSPOT = "Hotspot residues"
KEY_MASKED = "Masked cut faces"
KEY_PATCH_N = "Binding patch residues"
KEY_SOURCE = "Hotspot source"

RECOVERED_NOTE = (
    "Recovered from the target structure's B_iso_or_equiv column during import, "
    "because meta.json did not record it."
)


def _fill_constraints_from_structure(metadata, cif_path):
    """Add the epitope to `metadata` if the file has one and meta.json did not.

    Only ever fills gaps: a value from meta.json is authoritative and is left
    exactly as written. A target with no unconstrained residue declares no
    epitope, so nothing is inferred from it -- check_runs reports that case.
    """
    if metadata.get(KEY_HOTSPOT):
        return
    try:
        found = structure.constraints_from_cif(cif_path)
    except (OSError, ValueError):
        return
    hotspot = found[structure.HOTSPOT]
    if not hotspot or len(hotspot) == found["total"]:
        return
    metadata[KEY_HOTSPOT] = structure.to_ranges(hotspot)
    metadata.setdefault(KEY_PATCH_N, len(hotspot))
    metadata.setdefault(KEY_SOURCE, RECOVERED_NOTE)
    if found[structure.MASKED]:
        metadata.setdefault(KEY_MASKED, structure.to_ranges(found[structure.MASKED]))


class Command(BaseCommand):
    help = (
        "Import new binder design run directories into BinderRun database."
        "It searches under the folder MEDIA_ROOT/runs for run directories whose path is not in the database yet."
        "The run directories must be named with the pattern: <UNIPROT_ID>-<RUN_LABEL>-<YYYYMMDD>, e.g. P12345-tal1_screen-20260330. "
        "Nothing is imported from the name, but its UniProt ID and date are cross-checked "
        "against meta.json and a warning is logged if they disagree. "
        "Each run directory must contain a meta.json file in its root, which supplies the run's "
        "\"UniProt ID\" (required), \"Run date\", \"Algorithm\", \"Hardware\", \"Description\" and \"Notes\"; "
        "every other key in that file is stored in the run's metadata field. "
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
            name_match = RUN_DIR_PATTERN.match(entry.name)
            if not name_match:
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

            # Popped off: it resolves the Protein rather than being a run column,
            # which leaves meta_fields keyed exactly by BinderRun field name.
            uniprot_id = meta_fields.pop("uniprot_id")
            if not uniprot_id:
                self.stdout.write(self.style.WARNING(
                    f'Skipping (meta.json has no "UniProt ID"): {entry.name}'
                ))
                skipped += 1
                continue

            if meta_fields["run_datetime"] is None:
                self.stdout.write(self.style.WARNING(
                    f'No usable "Run date" in meta.json, importing without one: {entry.name}'
                ))

            # Advisory only — meta.json is authoritative, the run still imports.
            for problem in _dir_name_mismatches(
                name_match, uniprot_id, meta_fields["run_datetime"]
            ):
                self.stdout.write(self.style.WARNING(
                    f"Directory name disagrees with meta.json ({problem}): {entry.name}"
                ))

            # Find CIF file for the original structure in the run root
            root_cif_files = glob_module.glob(os.path.join(run_dir, "*.cif"))
            run_cif_rel = (
                os.path.relpath(root_cif_files[0], settings.MEDIA_ROOT)
                if root_cif_files
                else None
            )
            target_sequence = _parse_cif_sequence(root_cif_files[0]) if root_cif_files else None
            # The structure carries the binding spec in its B-factor column,
            # so a run whose meta.json omits the epitope still gets one. This
            # is why the 66 pre-meta.json runs needed a backfill at all: the
            # file was open right here and nothing read it.
            if root_cif_files:
                _fill_constraints_from_structure(metadata, root_cif_files[0])

            if not Protein.objects.filter(uniprot_id=uniprot_id).exists():
                self.stdout.write(f"Fetching AlphaFold data for: {uniprot_id} ...")
            protein, created = get_or_create_protein(uniprot_id)
            if created:
                self.stdout.write(
                    f"Created Protein: {uniprot_id} ({protein.protein_name})"
                )
            else:
                self.stdout.write(f"Found Protein: {uniprot_id}")

            steps_config = _parse_steps_config(run_dir)

            run = BinderRun.objects.create(
                protein=protein,
                # Assigned here and never again. Computed from the codes
                # already stored, so two runs imported in the same pass see
                # each other and a deleted run's code is not handed out twice.
                run_code=accessions.next_run_code(BinderRun, uniprot_id),
                run_dir=run_dir_rel,
                cif_path=run_cif_rel,
                target_sequence=target_sequence,
                steps_config=steps_config,
                metadata=metadata or None,
                # algorithm, run_datetime, hardware, description, notes
                **meta_fields,
            )

            # A BoltzGen run writes both all_designs_metrics.csv (every design) and
            # final_designs_metrics_30.csv (the selected subset). Picking glob()[0]
            # chose between them by filesystem order, so the number of binders
            # imported varied run to run. Prefer the full table explicitly.
            csv_files = sorted(glob_module.glob(os.path.join(designs_dir, "*.csv")))
            preferred = [p for p in csv_files
                         if os.path.basename(p) == "all_designs_metrics.csv"]
            chosen = (preferred or csv_files or [None])[0]
            binder_count = 0
            if chosen:
                if len(csv_files) > 1:
                    self.stdout.write(
                        f"  multiple CSVs present, importing {os.path.basename(chosen)}"
                    )
                binder_count = self._import_binders(run, designs_dir, chosen)

            # A CSV with rows but no importable binders is a schema mismatch, not
            # an empty run -- most likely the sequence column is named something
            # CSV_COLUMN_MAP does not know. Reporting success here hides it: the
            # run imports a Protein and a BinderRun with zero Binders and logs
            # "Imported ... binders=0". Across a campaign that silently produces a
            # populated database with no designs in it.
            if chosen and binder_count == 0:
                with open(chosen, newline="") as fh:
                    reader = csv.DictReader(fh)
                    cols = reader.fieldnames or []
                    n_rows = sum(1 for _ in reader)
                if n_rows > 0:
                    mapped = sorted(set(CSV_COLUMN_MAP) & {c.strip().lower() for c in cols})
                    raise CommandError(
                        f"{entry.name}: {os.path.basename(chosen)} has {n_rows} rows but "
                        f"0 binders were imported. No column maps to binder_sequence. "
                        f"Columns recognised: {mapped or 'none'}. "
                        f"Add the sequence column to CSV_COLUMN_MAP "
                        f"(BoltzGen writes 'designed_sequence')."
                    )

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
                    # Mirror the queryable subset into real columns now, so a
                    # freshly imported run needs no backfill pass. Same helper
                    # the backfill uses, so the two cannot drift apart.
                    fields.update(promoted(extra_metrics))

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
