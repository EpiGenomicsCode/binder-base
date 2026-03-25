# binder-base

## Purpose
Django backend for tracking protein binder design experiments. Stores target proteins, algorithm run configurations, and the resulting binder sequences with status/failure metadata.

## Tech Stack
- **Python / Django 6.0.3** — web framework
- **Django Ninja** — REST API layer (auto-generates OpenAPI docs)
- **PostgreSQL** — database (via psycopg2)
- **django-environ** — env var configuration from `.env`
- **django-cleanup** — auto-deletes orphaned media files
- **gunicorn** — production WSGI server

## Project Structure
```
binder_backend/
  binder_backend/        # Django project config (settings, root urls, wsgi/asgi, .env)
  binderbase/            # Main app: models, API, admin, migrations
requirements.txt
```

- `binder_backend/binder_backend/settings.py` — all config; reads from `.env` via django-environ
- `binder_backend/binderbase/models.py` — data models (Protein, BinderRun, Binder)
- `binder_backend/binderbase/api.py` — Django Ninja API endpoints
- `binder_backend/binderbase/admin.py` — Django admin registration and configuration
- `binder_backend/binderbase/urls.py` — mounts Ninja API at `/api/`

## Essential Commands

All commands run from `binder_backend/` directory.

```bash
# Install dependencies
pip install -r requirements.txt

# Apply migrations
python manage.py migrate

# Run development server
python manage.py runserver

# Create migrations after model changes
python manage.py makemigrations

# Run tests
python manage.py test binderbase

# Collect static files
python manage.py collectstatic
```

## Environment Setup
Copy `.env` template variables from `binder_backend/binder_backend/.env`. Required vars: `SECRET_KEY`, `MEDIA_ROOT`, `DATABASE_ENGINE`, `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_HOST`, `DATABASE_PORT`, `CSRF_TRUSTED_ORIGINS`.

The `.env` file must be placed at `binder_backend/binder_backend/.env` (where `settings.py` calls `environ.Env.read_env()`).

## Additional Documentation
- [.claude/docs/architectural_patterns.md](.claude/docs/architectural_patterns.md) — model relationships, API design, admin patterns, env config conventions
