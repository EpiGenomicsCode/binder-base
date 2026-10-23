#!/usr/bin/env bash
# BinderBase production deploy.
#
# The README's update procedure is `git pull && npm run build && migrate &&
# restart`. That is fine until a migration touches a populated table or a build
# fails halfway, at which point there is no backup, no rollback, and no check
# that the site still works. This script adds those four things and otherwise
# does the same steps in the same order.
#
#   ./binderbase_deploy.sh v1.2.0            stage a release
#   ./binderbase_deploy.sh --dry-run v1.2.0  show the migration plan, change nothing
#   ./binderbase_deploy.sh --rollback        restore the previous release + database
#   ./binderbase_deploy.sh --verify          health-check a running instance
#
# This script does NOT restart the application. The service account it runs as
# deliberately has no sudo, and granting it any -- even scoped to one unit --
# would weaken that boundary for a step performed every few weeks. The script
# stages everything and hands off one command to an administrator.
#
# INSTALL IT OUTSIDE THE REPO. It is versioned here, but it must RUN from
# somewhere the deploy does not touch -- /opt/binder/binderbase_deploy.sh. A
# script living inside the tree it checks out gets swapped mid-execution by its
# own `git checkout`, and bash reads scripts incrementally, so the result is an
# arbitrary failure partway through a deploy. Install or update it with:
#     git show origin/main:misc/deploy/binderbase_deploy.sh > /opt/binder/binderbase_deploy.sh
#     chmod +x /opt/binder/binderbase_deploy.sh
#
set -euo pipefail

REPO=${BINDERBASE_REPO:-/opt/binder/binder-base}
VENV=${BINDERBASE_VENV:-/opt/binder/venv}
BACKUPS=${BINDERBASE_BACKUPS:-/opt/binder/backups}
SERVICE=${BINDERBASE_SERVICE:-gunicorn}   # named for the handoff message only
HEALTH_URL=${BINDERBASE_HEALTH_URL:-http://127.0.0.1:8000/api/stats}
# DB_NAME/DB_USER are NOT defaulted here; load_db_settings reads them from
# Django. See the comment there.

DRY_RUN=0; ROLLBACK=0; VERIFY=0; REF=""
for a in "$@"; do
  case "$a" in
    --dry-run)  DRY_RUN=1 ;;
    --rollback) ROLLBACK=1 ;;
    --verify)   VERIFY=1 ;;
    -*) echo "unknown flag: $a"; exit 2 ;;
    *)  REF="$a" ;;
  esac
done

ts()  { date +%Y%m%d-%H%M%S; }
handoff() {
  cat <<BANNER

  ============================================================
   $1
   An administrator must now run, as root:

       systemctl restart $SERVICE
       curl -s $HEALTH_URL

   Then confirm with:  $0 --verify
  ============================================================

BANNER
}
say() { echo "[$(date +%H:%M:%S)] $*"; }
die() { echo "[FATAL] $*" >&2; exit 1; }

# Ask Django where the database is, rather than keeping a second copy of the
# connection details here. An earlier version defaulted to user "binder" and
# database "binderbase"; the real user is different, so pg_dump failed password
# authentication and the deploy stopped before it had done anything. A default
# that is wrong on the only machine this runs on is worse than no default.
#
# Runs in a subshell so activating the venv does not leak into this one.
# Explicit BINDERBASE_DB / BINDERBASE_DB_USER still win, for dumping or
# restoring against a scratch database.
load_db_settings() {
  local out
  if ! out=$(
        cd "$REPO/binder_backend" &&
        # shellcheck disable=SC1091
        . "$VENV/bin/activate" &&
        python -c '
import os, shlex, django
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "binder_backend.settings")
django.setup()
from django.conf import settings
d = settings.DATABASES["default"]
for k, v in (("DB_NAME", d["NAME"]), ("DB_USER", d["USER"]),
             ("DB_PASS", d.get("PASSWORD") or ""),
             ("DB_HOST", d.get("HOST") or ""),
             ("DB_PORT", str(d.get("PORT") or ""))):
    print("%s=%s" % (k, shlex.quote(str(v))))
'
      ); then
    die "could not read the database settings from Django at $REPO/binder_backend.
        Override by hand if needed:  export BINDERBASE_DB_USER=... PGPASSWORD=..."
  fi
  eval "$out"

  DB_NAME=${BINDERBASE_DB:-$DB_NAME}
  DB_USER=${BINDERBASE_DB_USER:-$DB_USER}
  # Separate `if`s, not `&&` chains: under `set -e` a chain whose first test
  # fails would take the whole script down.
  if [ -n "$DB_PASS" ] && [ -z "${PGPASSWORD:-}" ]; then export PGPASSWORD="$DB_PASS"; fi
  if [ -n "$DB_HOST" ] && [ -z "${PGHOST:-}" ]; then export PGHOST="$DB_HOST"; fi
  if [ -n "$DB_PORT" ] && [ -z "${PGPORT:-}" ]; then export PGPORT="$DB_PORT"; fi
  say "database: $DB_NAME as $DB_USER${PGHOST:+ at $PGHOST}"
}

# --- verify -----------------------------------------------------------------
if [ "$VERIFY" = 1 ]; then
  for i in $(seq 1 15); do
    if OUT=$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null); then
      say "health check passed: $OUT"
      cd "$REPO" && say "serving $(git describe --tags --always)"
      exit 0
    fi
    sleep 2
  done
  die "health check FAILED after 30s against $HEALTH_URL"
fi

# --- rollback ---------------------------------------------------------------
if [ "$ROLLBACK" = 1 ]; then
  PREV=$(cat "$BACKUPS/PREVIOUS_REF" 2>/dev/null) || die "no PREVIOUS_REF; nothing to roll back to"
  DUMP=$(ls -t "$BACKUPS"/db-*.sql.gz 2>/dev/null | head -1) || die "no database dump found"
  load_db_settings
  say "rolling back code to $PREV and database to $(basename "$DUMP")"
  read -rp "This DISCARDS everything written since that dump. Type the ref to confirm: " c
  [ "$c" = "$PREV" ] || die "confirmation did not match"
  cd "$REPO" && git checkout --quiet "$PREV"
  gunzip -c "$DUMP" | psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1
  ( cd "$REPO/binder_frontend" && npm ci --silent && npm run build --silent )
  say "code and database restored to $PREV"
  handoff "ROLLBACK STAGED -- not live until the service is restarted."
  exit 0
fi

[ -n "$REF" ] || die "give a git tag or commit. Deploying a moving branch means you cannot say what is running."
[ -d "$REPO/.git" ] || die "no git repo at $REPO"
mkdir -p "$BACKUPS"

cd "$REPO"
CURRENT=$(git rev-parse --short HEAD)
say "current: $CURRENT   target: $REF"

git fetch --tags --quiet
git rev-parse --verify --quiet "$REF^{commit}" >/dev/null || die "ref not found: $REF"

# --- 1. database backup BEFORE anything -------------------------------------
# Taken first and verified. A migration that half-applies to a table with
# millions of rows is not something to discover without a dump in hand.
if [ "$DRY_RUN" = 0 ]; then
  load_db_settings
  DUMP="$BACKUPS/db-$(ts).sql.gz"
  say "dumping database -> $DUMP"
  pg_dump -U "$DB_USER" -d "$DB_NAME" | gzip > "$DUMP"
  gunzip -t "$DUMP" || die "dump is corrupt; refusing to deploy"
  SIZE=$(stat -c%s "$DUMP")
  [ "$SIZE" -gt 10000 ] || die "dump is only ${SIZE}B; refusing to deploy"
  say "dump ok (${SIZE} bytes)"
  echo "$CURRENT" > "$BACKUPS/PREVIOUS_REF"
fi

# --- 2. check out the target ------------------------------------------------
if [ "$DRY_RUN" = 0 ]; then
  git checkout --quiet "$REF"
  say "checked out $REF ($(git rev-parse --short HEAD))"
else
  say "[dry-run] would check out $REF"
fi

# --- 3. migration plan ------------------------------------------------------
# Always shown. Promoting metrics columns on a multi-million-row Binder table
# rewrites it and holds a lock -- that is a maintenance window, not a restart.
cd "$REPO/binder_backend"
# shellcheck disable=SC1091
source "$VENV/bin/activate"
say "pending migrations:"
python manage.py migrate --plan 2>&1 | sed 's/^/    /'
if [ "$DRY_RUN" = 1 ]; then
  say "[dry-run] stopping here. Nothing changed."
  exit 0
fi
PENDING=$(python manage.py migrate --plan 2>/dev/null | grep -c "^\[ \]" || true)
if [ "${PENDING:-0}" -gt 0 ]; then
  say "$PENDING migration(s) will run against the live database."
  read -rp "Reviewed the plan above? [yes/NO] " c
  [ "$c" = "yes" ] || die "aborted before migrating"
fi

# --- 4. build the frontend out of place -------------------------------------
# Building in place leaves the site serving a half-written dist/ while npm
# works. Build beside it, swap only on success.
say "building frontend"
cd "$REPO/binder_frontend"
npm ci --silent
rm -rf dist.new
npm run build --silent -- --outDir dist.new || die "frontend build failed; site untouched"
[ -f dist.new/index.html ] || die "build produced no index.html; site untouched"
rm -rf dist.old && [ -d dist ] && mv dist dist.old
mv dist.new dist
say "frontend swapped (previous build kept as dist.old)"

# --- 5. backend -------------------------------------------------------------
cd "$REPO/binder_backend"
pip install -q -r requirements.txt
python manage.py migrate --no-input
python manage.py collectstatic --no-input --verbosity 0

# --- 6. hand off ------------------------------------------------------------
# No restart here: see the header. Note what IS already live, so the admin knows
# how urgent the restart is.
#   * frontend  -- live now, nginx serves dist/ directly
#   * schema    -- live now if migrations ran
#   * mgmt cmds -- live now, each invocation is a fresh process
#   * API/model code in the workers -- NOT live until restart
say "staged $REF ($(git -C "$REPO" rev-parse --short HEAD))"
if [ "${PENDING:-0}" -gt 0 ]; then
  say "NOTE: $PENDING migration(s) applied. The running workers are on older code"
  say "      against a newer schema until the restart happens -- do it promptly."
fi
handoff "DEPLOY STAGED -- frontend and schema are live, workers are not."
exit 0
