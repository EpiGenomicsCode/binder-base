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

### Directory naming

Run directories must be placed under `MEDIA_ROOT/runs/` and named with the pattern:

```
<UNIPROT_ID>-<ALGORITHM_VERSION>-<YYYYMMDD>
```

| Part | Description | Example |
|------|-------------|---------|
| `UNIPROT_ID` | UniProt accession (uppercase alphanumeric) | `P12345` |
| `ALGORITHM_VERSION` | Algorithm name and version (letters, digits, underscores, hyphens) | `rfdesign_v2` |
| `YYYYMMDD` | Run date | `20260330` |

Full example: `P12345-rfdesign_v2-20260330`

### Required directory structure

```
MEDIA_ROOT/runs/
  P12345-rfdesign_v2-20260330/
    *.cif                        # original target structure (one file)
    final_ranked_designs/
      *.csv                      # ranked binder designs (one file)
      **/rank001_*.cif           # per-design CIF files
```

The per-design CIF files must follow the naming pattern rank{final_rank:03d}_{file_name}, where final_rank and file_name are specified in metadata CSV file.

The CSV must contain at minimum a `sequence` column. Supported columns and their mapping to database fields:

| CSV column | DB field |
|---|---|
| `sequence` | `binder_sequence` |
| `final_rank` | `final_rank` |
| `quality_score` | `quality_score` |
| `design_to_target_iptm` | `design_to_target_iptm` |
| `pass_filters (TRUE or FALSE)` | `status (success or failed)` |
| `pass_*_filter` | `failure_reason (filters it failed to pass)` |

Any additional columns are stored in the `metrics` JSON field.

### Running the import command

From `binder_backend/`:

```bash
python manage.py import_run
```

The command scans `MEDIA_ROOT/runs/`, skips directories already in the database or that don't match the naming pattern, and for each new run:

1. Looks up or creates the `Protein` record via the UniProt REST API.
2. Creates a `BinderRun` record.
3. Bulk-creates `Binder` records from the CSV.

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
