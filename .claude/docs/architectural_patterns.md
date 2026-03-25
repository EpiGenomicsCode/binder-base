# Architectural Patterns

## Data Model: Cascading FK Hierarchy
`Protein` → `BinderRun` → `Binder` — all foreign keys use `on_delete=CASCADE`.
- `models.py:3` — Protein is the root entity (identified by UniProt ID)
- `models.py:17` — BinderRun links a protein to one algorithm run (tracks version, hardware, datetime)
- `models.py:31` — Binder is a single output sequence from a run (with status and optional failure_reason)

Deleting a Protein cascades to all its runs and their binders. Design around this — no soft deletes.

## Timestamps on All Models
Every model has `created_at = DateTimeField(auto_now_add=True)` and `updated_at = DateTimeField(auto_now=True)`. See `models.py:10-11`, `models.py:24-25`, `models.py:37-38`. Add these to any new model.

## API via Django Ninja (not views.py)
`api.py` holds all REST endpoints using a single `NinjaAPI()` instance. `views.py` is intentionally empty — do not add Django template views there. The API is mounted at `/api/` in `binderbase/urls.py:5`.

New endpoints go in `api.py` as decorated functions on the `api` object. Django Ninja auto-generates OpenAPI docs at `/api/docs`.

## Environment Config Pattern
`settings.py` uses `django-environ` (`env = environ.Env(...)` then `environ.Env.read_env()`) to load all secrets and environment-specific values from `.env`. No hardcoded credentials anywhere in settings. See `settings.py:17-22`.

The `.env` file lives alongside `settings.py` at `binder_backend/binder_backend/.env`. This is non-standard Django placement but matches where `read_env()` is called without a path argument.

## Admin: Wildcard Import + Explicit Registration
`admin.py` uses `from .models import *` then individually registers each model with `@admin.register(ModelClass)`. See `admin.py:2-4`. Inline models (e.g. `BinderInline` at `admin.py:10`) are attached to parent admin classes to allow editing child records in context.

Admin is currently the primary UI for data management. The `list_display` and `list_filter` fields on each `ModelAdmin` are the main data navigation interface.

## URL Routing: Two-Level Include
Root `urls.py` includes `binderbase.urls` at `''`, and `binderbase/urls.py` mounts the Ninja API at `api/`. Adding a new app: include its URLs in `binder_backend/urls.py`, then define sub-routing within that app's own `urls.py`.

## Frontend: Typed API Client Layer
`binder_frontend/src/api/client.ts` is the single integration point between React and Django Ninja. It exports typed async functions (`getProteins`, `getProtein`) that wrap `fetch` and throw on non-OK responses. Pages never call `fetch` directly.

`binder_frontend/src/types/index.ts` mirrors the Ninja response schemas as TypeScript interfaces (`Protein`, `ProteinDetail`, `BinderRun`, `Binder`). When adding or changing API fields, update both the Ninja schema in `api.py` and the corresponding TS interface.

## Frontend: Vite Dev Proxy
`binder_frontend/vite.config.ts` proxies all `/api/*` requests to `http://localhost:8000` during development. This means the frontend and backend can run on different ports locally without any CORS configuration on Django. For production deployment, serve both under the same origin or add `django-cors-headers`.
