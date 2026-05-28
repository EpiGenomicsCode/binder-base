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
| **BinderRun** | Protein, algorithm version, run date, hardware, description, run dir, user | Protein, algorithm version, hardware, user |
| **Binder** | Run, length, rank, quality score, ipTM, status | Run |

---


## Run Directory Convention & Import Command

The `import_run` command scans `MEDIA_ROOT/runs/` for run directories not yet in the
database and imports each one. This section documents exactly how a run directory is
read so you can lay one out correctly.

### Directory naming

Each run directory lives directly under `MEDIA_ROOT/runs/` and is named:

```
<UNIPROT_ID>-<ALGORITHM_VERSION>-<YYYYMMDD>
```

The name is parsed with the regex `^([A-Z0-9]+)-(.+)-(\d{8})$`, which determines the
three fields as follows:

| Part | How it's determined | Example |
|------|---------------------|---------|
| `UNIPROT_ID` | The leading run of **uppercase letters/digits** up to the first hyphen. No lowercase, no hyphens. | `P12345` |
| `ALGORITHM_VERSION` | Everything **between** the UniProt ID and the trailing date. It *may itself contain hyphens* — the date is anchored to the end, so only the last 8 digits are treated as the date and the first token as the UniProt ID. | `rfdesign_v2`, `af3-finetune-v2` |
| `YYYYMMDD` | The trailing **8 digits**, parsed as a calendar date (`%Y%m%d`). | `20260330` |

Full example: `P12345-rfdesign_v2-20260330` → UniProt `P12345`, algorithm `rfdesign_v2`, date 2026-03-30.

### Required directory structure

```
MEDIA_ROOT/runs/
  P12345-rfdesign_v2-20260330/
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

**`final_ranked_designs/` (required).** Must exist, or the directory is skipped (see
below). The **first** `*.csv` in this folder is read as the binder table; per-design CIF
files are located by globbing `rank*_<file_name>` recursively and matching the filename
`rank{final_rank}_{file_name}` (the rank may be zero-padded to any width, e.g.
`rank1_`, `rank01_`, `rank001_`).

**Per-design CIF filename** must start with `rank`, followed by optional leading zeros,
followed by rank number, underscore, and then the exact filename.


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
- Its name **does not match** the `<UNIPROT_ID>-<ALGORITHM_VERSION>-<YYYYMMDD>` pattern.
- It has **no `final_ranked_designs/` folder**.

Non-directory entries under `runs/` are ignored. A run with no root `.cif` or no CSV is
*not* skipped — it imports with the corresponding fields left empty.

### Running the import command

From `binder_backend/`:

```bash
python manage.py import_run
```

For each new run directory the command:

1. **Resolves the `Protein`** by UniProt ID. If it already exists it is reused; otherwise
   the AlphaFold API (sequence, gene name, organism, structure CIF, PAE JSON) and UniProt
   API (biological function) are queried, the CIF and PAE JSON are downloaded to
   `MEDIA_ROOT/proteins/{uniprot_id}/`, and the `Protein` is created.
2. **Creates a `BinderRun`** (algorithm/version, date, target CIF path, target sequence,
   `steps_config`).
3. **Bulk-creates `Binder` records** from the CSV, linking each to its per-design CIF.

A summary line reports the number of runs imported and skipped.

---

## API Endpoints

All endpoints are mounted at `/api/`. Interactive docs (OpenAPI/Swagger UI) are available at `/api/docs`.

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
| `algorithm_version` | string | Algorithm name and version |
| `description` | string | Optional description |
| `run_datetime` | datetime | Date/time of the run |
| `hardware` | string | Hardware used |
| `notes` | string | Free-text notes |
| `run_dir` | string | Relative path to run directory under `MEDIA_ROOT` |
| `cif_path` | string | Relative path to the target structure CIF file |
| `user` | string | Username who imported the run |
| `binders` | array | List of `Binder` objects (see below) |

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
