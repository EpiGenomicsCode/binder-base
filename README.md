# Binder Base

Django + React application for tracking protein binder design experiments.

---

## Table of Contents

1. [Development Quick Start](#development-quick-start)
2. [Admin Dashboard](#admin-dashboard)
3. [Run Directory Convention & Import Command](#run-directory-convention--import-command)
4. [API Endpoints](#api-endpoints)
5. [Production Deployment](#production-deployment)

---

## Development Quick Start

### Prerequisites

- Python 3.11+
- Node.js 18+
- PostgreSQL

### Backend

```bash
cd binder_backend

# Install dependencies
pip install -r requirements.txt

# Configure environment
cp binder_backend/.env.example binder_backend/.env
# Edit .env — set SECRET_KEY, DATABASE_*, MEDIA_ROOT, CSRF_TRUSTED_ORIGINS

# Apply migrations and run
python manage.py migrate
python manage.py runserver
```


### Frontend

```bash
cd binder_frontend

npm install
npm run dev   # dev server at http://localhost:5173
```

The home page is served at http://localhost:5173.

---

## Admin Dashboard

The Django admin interface is available at http://127.0.0.1:8000/admin. Log in with a superuser account (create one with `python manage.py createsuperuser`).

The following models are registered:

| Model | List columns | Filters |
|---|---|---|
| **Protein** | UniProt ID, gene name, protein name, organism, length | Organism |
| **BinderRun** | Protein, algorithm, run date, hardware, description, run dir, user | Protein, algorithm, hardware, user |
| **Binder** | Run, length, rank, quality score, ipTM, status | Run |

---


## Run Directory Convention & Import Command

The `import_run` command scans `MEDIA_ROOT/runs/` for run directories not yet in the
database and imports each one. This section documents exactly how a run directory is
read so you can lay one out correctly.

### Directory naming

Each run directory lives directly under `MEDIA_ROOT/runs/` and is named:

```
<UNIPROT_ID>-<RUN_LABEL>-<YYYYMMDD>
```

| Part | Meaning | Example |
|------|---------|---------|
| `UNIPROT_ID` | Leading run of **uppercase letters/digits**. No lowercase, no hyphens. | `P12345` |
| `RUN_LABEL` | Free-form label for the run. *May itself contain hyphens* — the date is anchored to the end of the name. | `tal1_screen` |
| `YYYYMMDD` | Trailing **8 digits**. | `20260501` |

The directory name is validated against `^([A-Z0-9]+)-(.+)-(\d{8})$` and skips 
directories that don't match. If the UniProt ID or run date is different between 
the run directory name and the meta.json file (see below), a warning will be 
logged during importation. However, the importation will proceed with every
imported value coming from `meta.json`. 

### Required directory structure

```
MEDIA_ROOT/runs/
  P12345-tal1_screen-20260501/
    meta.json                    # REQUIRED — run identity + metadata (see below)
    *.cif                        # target structure — exactly one .cif in the run root
    steps.yaml                   # optional pipeline config (see below)
    config/                      # optional configs referenced from steps.yaml
    final_ranked_designs/        # REQUIRED
      *.csv                      # binder table — first *.csv in this folder is used
      */rank001_<file_name>      # per-design CIF files, matched by rank + filename
```

**Target structure CIF (run root).** The importer globs `*.cif` in the run directory
root and uses it as the run's target structure, parsing the target sequence from its
`_entity_poly` record. Keep **exactly one** `.cif` here:
- **None** → the run still imports, but with no target structure and no target sequence.
- **More than one** → the *first match in glob order* is used (order is not guaranteed),
  so the chosen file is effectively arbitrary. Always keep a single copy.

**`steps.yaml` (optional).** If present and valid, it is stored as the run's
`steps_config`. Any nested `config` / `config_file` / `config_path` string values are
replaced inline with the parsed contents of the referenced file (YAML or JSON),
resolved relative to the run directory — this is what the `config/` folder is for. A
missing or unparseable `steps.yaml` is stored as null and does not stop the import.

**`meta.json` (required).** A JSON file in the run root that supplies the run's
identity. Six keys are lifted into database columns; **every other key** is stored in
the run's `metadata` field.

| Key | DB field | Required | Accepted values |
|---|---|---|---|
| `UniProt ID` | resolves/creates the `Protein` | **Yes** | Any non-empty string |
| `Run date` | `run_datetime` | No | `YYYY-MM-DD`, `YYYY/MM/DD`, `YYYYMMDD`, or a full ISO 8601 timestamp |
| `Algorithm` | `algorithm` | No | Any scalar (strings, numbers) |
| `Hardware` | `hardware` | No | Any scalar (strings, numbers) |
| `Description` | `description` | No | Any scalar (strings, numbers) |
| `Notes` | `notes` | No | Any scalar (strings, numbers) |

```json
{
  "UniProt ID": "P12345",
  "Run date": "2026-05-01",
  "Algorithm": "XXX v1.0",
  "Hardware": "1x A100 80GB",
  "Description": "TAL1-E2 binder screen",
  "Notes": "rerun of the April batch with relaxed filters",
  "Domain": "TAL1-E2",
  "Hotspot residues": "31, 33, 38, 54, 58, 61, 63, 67, 68"
}
```

Here `Domain` and `Hotspot residues` become the run's `metadata`.

Key matching **ignores case and any spaces, underscores or hyphens**, so `UniProt ID`,
`uniprot_id` and `UNIPROT-ID` are equivalent. Matching is on the whole key, so
near-misses like `Hardware config` or `Run dates` are *not* absorbed — they stay in
`metadata`.

If a recognized key's value can't be used — an unparseable `Run date`, an object where a
scalar `Algorithm` was expected — the column is left null and the **raw entry falls
through to `metadata`**, so nothing in the file is ever silently lost.

> Note: `import_run` skips run directories it has already imported, so editing a
> `meta.json` afterwards will **not** update the corresponding run.

**`final_ranked_designs/` (required).** Must exist, or the directory is skipped (see
below). The **first** `*.csv` in this folder is read as the binder table; per-design CIF
files are located by globbing `rank*_<file_name>` recursively and matching the filename
`rank{final_rank}_{file_name}` (the rank may be zero-padded to any width, e.g.
`rank1_`, `rank01_`, `rank001_`).


### The designs CSV

The CSV must contain at minimum a `sequence` column (rows without it are skipped).
Recognized columns and their mapping to database fields:

| CSV column | DB field |
|---|---|
| `sequence` | `binder_sequence` (its length → `binder_length`) |
| `final_rank` | `final_rank` |
| `quality_score` | `quality_score` |
| `design_to_target_iptm` | `design_to_target_iptm` |
| `pass_filters` (`TRUE`/`FALSE`) | `status` (`success` / `failed`) |
| `pass_*_filter` (`FALSE`) | contributes to `failure_reason` (which filters failed) |
| `file_name` | used (with `final_rank`) to locate the per-design CIF |

Any additional columns are stored in the `metrics` JSON field.

### When directories are skipped

A directory is skipped (logged, and the command continues to the next one) when:

- It is **already imported** — its path matches an existing `BinderRun.run_dir`.
- Its name **does not match** the `<UNIPROT_ID>-<RUN_LABEL>-<YYYYMMDD>` pattern.
- It has **no `final_ranked_designs/` folder**.
- Its `meta.json` is **missing, unparseable, or not a JSON object**.
- Its `meta.json` has **no usable `UniProt ID`** — without it the `Protein` can't be resolved.

`BinderRun.run_dir` also carries a **database-level unique constraint**, so a duplicate
run cannot be created even if the in-memory check is bypassed. Two consequences:

**Renaming a run directory makes it import again** under the new path, producing a
  second `BinderRun` (and a second set of `Binder` rows) while the original row keeps
  pointing at a path that no longer exists. Renaming is not a supported way to re-import.

### Running the import command

From `binder_backend/`:

```bash
python manage.py import_run
```

For each new run directory the command:

1. **Reads `meta.json`**, taking `UniProt ID`, `Run date`, `Algorithm`, `Hardware`,
   `Description` and `Notes` from it and keeping the remaining keys as the run's
   `metadata`, then **cross-checks** the UniProt ID and date against the directory name. Note that if a discrepancy is detected, only a warning will be logged, and the import process will continue.
2. **Resolves the `Protein`** by that UniProt ID. If it already exists it is reused; otherwise
   the AlphaFold API (sequence, gene name, organism, structure CIF, PAE JSON) and UniProt
   API (biological function) are queried, the CIF and PAE JSON are downloaded to
   `MEDIA_ROOT/proteins/{uniprot_id}/`, and the `Protein` is created.
3. **Creates a `BinderRun`** (algorithm, date, target CIF path, target sequence,
   `steps_config`, `metadata`).
4. **Bulk-creates `Binder` records** from the CSV, linking each to its per-design CIF.

A summary line reports the number of runs imported and skipped.

---

## API Endpoints

All endpoints are mounted at `/api/`. Interactive docs (OpenAPI/Swagger UI) are available at `/api/docs`.

### `GET /api/stats`

Returns database-wide totals, for dashboard summary tiles.

**Response:**

| Field | Type | Description |
|---|---|---|
| `protein_count` | int | Total proteins |
| `run_count` | int | Total binder runs |
| `binder_count` | int | Total binders across all runs |
| `success_count` | int | Binders with `status` exactly `success` |

---

### `GET /api/proteins`

Returns a list of all proteins.

**Response** — array of:

| Field | Type | Description |
|---|---|---|
| `id` | int | Database ID |
| `uniprot_id` | string | UniProt accession |
| `gene_name` | string | Gene name |
| `protein_name` | string | Full protein name |
| `organism` | string | Scientific organism name |
| `length` | int | Sequence length (aa) |
| `biological_function` | string | Biological function description (from UniProt) |
| `cif_path` | string | Relative path to the AlphaFold predicted structure CIF file |
| `pae_json_path` | string | Relative path to the AlphaFold PAE JSON file |

---

### `GET /api/proteins/{id}`

Returns full detail for a single protein, including all binder runs and their ranked designs.

**Response:**

| Field | Type | Description |
|---|---|---|
| `id` | int | Database ID |
| `uniprot_id` | string | UniProt accession |
| `gene_name` | string | Gene name |
| `protein_name` | string | Full protein name |
| `organism` | string | Scientific organism name |
| `length` | int | Sequence length (aa) |
| `biological_function` | string | Biological function description (from UniProt) |
| `cif_path` | string | Relative path to the AlphaFold predicted structure CIF file |
| `pae_json_path` | string | Relative path to the AlphaFold PAE JSON file |
| `sequence` | string | Full amino acid sequence |
| `created_at` | datetime | Record creation timestamp |
| `updated_at` | datetime | Last update timestamp |
| `runs` | array | List of `BinderRun` objects (see below) |

**`BinderRun` object:**

| Field | Type | Description |
|---|---|---|
| `id` | int | Database ID |
| `algorithm` | string | Algorithm name and version, from the `Algorithm` key of `meta.json` |
| `description` | string | Optional description, from the `Description` key of `meta.json` |
| `run_datetime` | datetime \| null | Date/time of the run, from the `Run date` key of `meta.json`. Null when that key is absent or unparseable |
| `hardware` | string | Hardware used, from the `Hardware` key of `meta.json` |
| `notes` | string | Free-text notes, from the `Notes` key of `meta.json` |
| `run_dir` | string | Relative path to run directory under `MEDIA_ROOT` |
| `cif_path` | string | Relative path to the target structure CIF file |
| `target_sequence` | string | Target sequence parsed from the run's CIF file |
| `steps_config` | object \| array | Parsed `steps.yaml`, with referenced config files inlined |
| `metadata` | object | Remaining keys of `meta.json`, after the six lifted keys are taken out (null if none) |
| `user` | string | Username who imported the run |
| `binder_count` | int | Number of binders in the run |

Binders are **not** inlined in this response — a protein with several runs of a few
thousand designs each made it tens of MB. Fetch them a page at a time from
`GET /api/runs/{run_id}/binders` instead.

---

### `GET /api/runs/{run_id}/binders`

Returns one page of a run's binders.

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `page` | int | `1` | 1-based page number |
| `page_size` | int | `20` | Results per page (capped at 200) |
| `sort` | string | `rank` | One of `rank`, `quality`, `iptm`, `length`, `status` |
| `sort_dir` | string | `asc` | `asc` or `desc`; missing values always sort last |
| `status` | string | `all` | `all`, or a status to filter by (case-insensitive) |

**Response:**

| Field | Type | Description |
|---|---|---|
| `items` | array | List of `Binder` objects (see below) |
| `total` | int | Total binders matching the filter, across all pages |
| `metric_keys` | array | Metric column names available for this run |

`metric_keys` is sampled from the leading rows of the run rather than scanned across
every row, since binders within a run come from the same pipeline and carry the same
keys.

**`Binder` object:**

| Field | Type | Description |
|---|---|---|
| `id` | int | Database ID |
| `binder_sequence` | string | Amino acid sequence of the designed binder |
| `binder_length` | int | Sequence length (aa) |
| `status` | string | Design status (e.g. `passed`, `failed`) |
| `failure_reason` | string | Reason for failure if applicable |
| `final_rank` | int | Rank among designs in the run |
| `quality_score` | float | Overall quality score |
| `design_to_target_iptm` | float | ipTM score for binder–target interface |
| `metrics` | object | Unmapped CSV columns, kept as-is |
| `cif_path` | string | Relative path to the binder's CIF structure file |

---


## Production Deployment

The production stack is **nginx → gunicorn → Django** with a separately served React build.

Assumed install path: `/opt/binder/binder-base/`

### 1. Build the frontend

```bash
cd binder_frontend
npm install
npm run build   # outputs to binder_frontend/dist/
```

### 2. Configure the backend environment

Create `binder_backend/binder_backend/.env`:

```ini
SECRET_KEY=<strong-random-key>
DEBUG=False
MEDIA_ROOT=/opt/binder/files/
DATABASE_ENGINE=django.db.backends.postgresql
DATABASE_NAME=binderbase
DATABASE_USER=<db-user>
DATABASE_PASSWORD=<db-password>
DATABASE_HOST=localhost
DATABASE_PORT=5432
CSRF_TRUSTED_ORIGINS=https://your-domain.example.com
DEFAULT_FROM_EMAIL=noreply@your-domain.example.com
```

### 3. Collect static files and migrate

```bash
cd binder_backend
pip install -r requirements.txt
python manage.py migrate
python manage.py collectstatic --no-input
```

### 4. Run gunicorn

```bash
cd binder_backend
gunicorn binder_backend.wsgi:application \
    --bind 127.0.0.1:8000 \
    --workers 4
```

Use a systemd service or supervisor to keep gunicorn running.

### 5. Configure nginx

Copy `nginx.conf` from the repo root to `/etc/nginx/sites-available/binderbase` (adjust `server_name`), then enable it:

```bash
ln -s /etc/nginx/sites-available/binderbase /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
```

The config serves:
- `/` — React SPA from `binder_frontend/dist/`
- `/api/`, `/admin/` — proxied to gunicorn on port 8000
- `/media/` — files from `MEDIA_ROOT` (`/opt/binder/files/`)
- `/static/` — Django admin static files from `binder_backend/static/`

### 6. Create a superuser

```bash
cd binder_backend
python manage.py createsuperuser
```

Django admin is at `https://your-domain.example.com/admin/`.

### 7. Deploying an update

To ship new code to a running deployment, pull the changes, rebuild the frontend, apply backend changes, and restart gunicorn. Run from the repo root (`/opt/binder/binder-base/`):

```bash
git pull

# Frontend — reinstall deps and rebuild the SPA
cd binder_frontend
npm install
npm run build

# Backend — update dependencies, apply database schema migrations and collect static files if needed
cd ../binder_backend
source ../../venv/bin/activate
pip install -r requirements.txt
python manage.py migrate
python manage.py collectstatic --no-input

# Restart the app server (adjust to your service name)
sudo systemctl restart gunicorn
```

nginx serves the new `binder_frontend/dist/` build and static files directly, so no nginx reload is needed unless you changed `nginx.conf`.
