# Deterministic ordering for BinderRun.
#
# run_datetime is date-only at midnight: 697 runs carry just 16 distinct values
# and 421 share 2026-11-03. Ordering on it alone left nearly every row tied, and
# a tied ORDER BY returns whatever the query plan emits -- so a protein page
# could list its runs in a different order on two consecutive reloads. CASQ2's
# R003 and R004 are both 2026-11-03 and could swap.
#
# run_code is unique, populated on every run, and zero-padded (<ACC>-R001), so
# lexicographic order is run order within a protein. id is the backstop if
# run_code is ever null.
#
# State-only: AlterModelOptions changes no schema and takes no locks.
from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("binderbase", "0014_binderrun_run_code"),
    ]

    operations = [
        migrations.AlterModelOptions(
            name="binderrun",
            options={"ordering": ["-run_datetime", "-run_code", "-id"]},
        ),
    ]
