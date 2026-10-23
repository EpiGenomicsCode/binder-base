# BinderBase deployment workflow

Production is nginx → gunicorn → Django at `/opt/binder/binder-base/`, media in
`/opt/binder/files/`, PostgreSQL `binderbase`. There is no CI, no staging, and no
test suite in the repo.

The README's §7 update procedure (`git pull && npm run build && migrate &&
restart`) works until a migration touches a populated table or a build fails
halfway. Then there is no backup, no rollback, and no check that the site still
serves. `binderbase_deploy.sh` adds those four things and changes nothing else.

---

## Install the script outside the repo

It is versioned here, but it must *run* from a path the deploy does not touch:

```bash
git show origin/main:misc/deploy/binderbase_deploy.sh > /opt/binder/binderbase_deploy.sh
chmod +x /opt/binder/binderbase_deploy.sh
```

Running it from inside the checkout is not a style preference. The script does
`git checkout "$REF"` on the very tree it lives in, and bash reads a script
incrementally rather than all at once, so the file changes under the running
interpreter and the deploy fails at an arbitrary point. Re-run the two commands
above after any release that changes the script.

---

## Code deployment

```bash
./binderbase_deploy.sh --dry-run v1.2.0   # show the migration plan, change nothing
./binderbase_deploy.sh v1.2.0             # stage the release
#   -> then, as an administrator:  systemctl restart gunicorn
./binderbase_deploy.sh --verify           # confirm it came back
./binderbase_deploy.sh --rollback         # restore previous code + database
```

### The restart is deliberately manual

The script never restarts the service. The account it runs as (`binder`) has no
sudo **by design**, and granting it any -- even a sudoers line scoped to one unit
-- would weaken that boundary permanently for a step taken every few weeks.

So the script stages everything and hands off one command. What that means in
practice, because it decides how urgent the restart is:

| | live immediately? |
|---|---|
| frontend build | **yes** -- nginx serves `dist/` directly |
| database schema | **yes**, if migrations ran |
| management commands (`import_run`) | **yes** -- each invocation is a fresh process |
| API / model code in the workers | **no** -- not until restart |

A release that only changes a management command (such as v1.1.0) is therefore
fully live without the restart. A release with migrations leaves old workers
running against a new schema, which is the case to restart promptly.

What it does beyond the README:

1. **Requires a tag or commit, not a branch.** `git pull` on `main` means you
   cannot say afterwards what is running, which makes "did the deploy break it?"
   unanswerable.
2. **Dumps the database first and verifies the dump** — `gunzip -t`, plus a size
   floor. Refuses to deploy if the dump is corrupt or suspiciously small. A
   migration that half-applies to a multi-million-row table is not something to
   meet without a dump in hand.
3. **Prints the migration plan and requires confirmation.** Always shown, even
   when nothing is pending.
4. **Builds the frontend out of place** (`dist.new`, swapped on success). Building
   in place serves a half-written `dist/` to users for the duration of `npm run
   build`, and leaves the site broken if the build fails.
5. **Hands off rather than restarting**, and reports what is already live so the
   urgency is explicit. `--verify` runs the health check once an administrator
   has restarted, so a worker that comes back 500 is still caught by the person
   doing the deploy rather than by a visitor.

### Rollback honesty

`--rollback` restores code **and** the pre-deploy dump, which **discards every
write since the deploy** — including any runs imported in between. It prompts for
the ref to confirm.

Code-only rollback is not offered, because it is usually wrong: if a migration
applied, the old code may not understand the new schema. Reversing a migration is
a case-by-case decision, not something to automate.

---

## Data imports are not deployments

`import_run` is a management command. Importing pilot output does **not** require
deploying code, and should not be bundled with one — a failed import and a failed
deploy want different responses.

```bash
cd /opt/binder/binder-base/binder_backend
source /opt/binder/venv/bin/activate
python manage.py import_run        # reads MEDIA_ROOT/runs/
```

### Two properties to know first

**It is idempotent.** Run directories already present in `BinderRun.run_dir` are
skipped. Re-running is safe.

**That idempotency has a sharp edge.** A run imported *badly* — say 0 binders from
a schema mismatch — will be **skipped** on re-import, not corrected. To fix one:

```python
BinderRun.objects.filter(run_dir__contains="P53396-ACLY").delete()  # cascades to Binders
```

then re-import. Check before a bulk import, not after:

```bash
python manage.py shell -c "
from binderbase.models import BinderRun
bad = [r.run_dir for r in BinderRun.objects.all() if r.binder_set.count() == 0]
print(f'runs with zero binders: {len(bad)}'); [print(' ', d) for d in bad[:10]]"
```

With the patch applied this cannot happen silently any more — `import_run` now
raises when a CSV has rows but yields no binders — but older rows may predate it.

### Importing the pilot

1. Stage pruned run directories under `MEDIA_ROOT/runs/` as
   `<UNIPROT>-<GENE>_<HPAID>` (the campaign script names them this way).
2. Import **one run first** and check it: binder count matches the CSV row count,
   `metadata` has ~30 keys, `cif_path` resolves.
3. Then the rest. 100 runs × 1,000 designs is ~100k `Binder` rows, a few minutes.
4. Back up afterwards — the import is the expensive part to redo, not the code.

---

## The migration that needs a maintenance window

Promoting metrics out of `Binder.metrics` JSON into indexed columns (upgrade
Tier 1) is **not** a routine deploy. On a table with millions of rows, adding
populated columns rewrites the table and holds a lock for the duration.

Plan it as:

1. Restore the latest dump into a scratch database.
2. Run the migration there and **time it**. That number decides whether it is a
   restart or an overnight window.
3. Add columns `NULL` first, backfill in batches outside the migration, then add
   the index with `CREATE INDEX CONCURRENTLY` (Django: `AddIndexConcurrently`,
   with `atomic = False` on the migration).
4. Deploy during low traffic, with the dump verified.

Do this **before** the full 2,320-target campaign, while the table is ~100k rows
instead of 2.3M. The cost of this migration grows with the data, so the cheapest
time to run it is now.

---

## What is still missing, in priority order

1. **No tests.** The repo has none, so nothing catches a regression before it
   reaches production. The `import_run` path is the obvious first target: a
   fixture run directory and an assertion on binder count would have caught the
   `designed_sequence` bug.
2. **No staging.** The dry-run flag and a scratch-database migration test cover
   the dangerous part, but not a full rehearsal.
3. **No CI.** Once tests exist, run them on PRs. Deployment can stay manual —
   this is one server, and a script with backups and a health check is
   proportionate.
