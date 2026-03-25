# binder-base

## Purpose
Django backend for tracking protein binder design experiments. Stores target proteins, algorithm run configurations, and the resulting binder sequences with status/failure metadata.

## Tech Stack

**Backend**
- **Python / Django 6.0.3** — web framework
- **Django Ninja** — REST API layer (auto-generates OpenAPI docs at `/api/docs`)
- **PostgreSQL** — database (via psycopg2)
- **django-environ** — env var configuration from `.env`
- **django-cleanup** — auto-deletes orphaned media files
- **gunicorn** — production WSGI server

**Frontend**
- **React 18 + Vite + TypeScript** — SPA in `binder_frontend/`
- **react-router-dom** — client-side routing

## Project Structure
```
binder_backend/
  binder_backend/        # Django project config (settings, root urls, wsgi/asgi, .env)
  binderbase/            # Main app: models, API, admin, migrations
binder_frontend/
  src/
    api/client.ts        # typed fetch helpers (getProteins, getProtein)
    types/index.ts       # TS interfaces mirroring API schemas
    pages/               # ProteinList, ProteinDetail
  vite.config.ts         # dev proxy: /api → localhost:8000
requirements.txt
```

- `binder_backend/binder_backend/settings.py` — all config; reads from `.env` via django-environ
- `binder_backend/binderbase/models.py` — data models (Protein, BinderRun, Binder)
- `binder_backend/binderbase/api.py` — Django Ninja API endpoints
- `binder_backend/binderbase/admin.py` — Django admin registration and configuration
- `binder_backend/binderbase/urls.py` — mounts Ninja API at `/api/`

## Essential Commands

**Backend** (run from `binder_backend/`):
```bash
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver
python manage.py makemigrations
python manage.py test binderbase
```

**Frontend** (run from `binder_frontend/`):
```bash
npm install
npm run dev      # dev server at localhost:5173
npm run build    # production build to dist/
```

## Environment Setup
Copy `.env` template variables from `binder_backend/binder_backend/.env`. Required vars: `SECRET_KEY`, `MEDIA_ROOT`, `DATABASE_ENGINE`, `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_HOST`, `DATABASE_PORT`, `CSRF_TRUSTED_ORIGINS`.

The `.env` file must be placed at `binder_backend/binder_backend/.env` (where `settings.py` calls `environ.Env.read_env()`).

During frontend development, Vite proxies `/api` to `http://localhost:8000` — no CORS config needed locally.

## Additional Documentation
- [.claude/docs/architectural_patterns.md](.claude/docs/architectural_patterns.md) — model relationships, API design, admin patterns, env config conventions
