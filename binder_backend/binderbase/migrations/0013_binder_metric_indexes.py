"""Indexes for the promoted metric columns.

Separate from 0012 (which only adds nullable columns -- a fast, metadata-only
operation) because building indexes is the slow part and needs different
handling.

On PostgreSQL these are built CONCURRENTLY. A plain CREATE INDEX takes an
ACCESS EXCLUSIVE lock for its duration, so on a large Binder table every write
blocks, including any import running at the time. CONCURRENTLY trades a slower
build for not blocking, and cannot run inside a transaction -- hence
atomic = False.

django.contrib.postgres.operations.AddIndexConcurrently would be the obvious
choice, but it is Postgres-only and importing it requires psycopg2, which makes
the migration unrunnable on SQLite and therefore untestable without a Postgres
service. The small wrapper below asks the backend instead.
"""
from django.db import migrations, models


class AddIndexMaybeConcurrently(migrations.AddIndex):
    """CONCURRENTLY on PostgreSQL, a plain index everywhere else."""

    atomic = False

    def database_forwards(self, app_label, schema_editor, from_state, to_state):
        model = to_state.apps.get_model(app_label, self.model_name)
        if not self.allow_migrate_model(schema_editor.connection.alias, model):
            return
        if schema_editor.connection.vendor == "postgresql":
            schema_editor.add_index(model, self.index, concurrently=True)
        else:
            schema_editor.add_index(model, self.index)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [("binderbase", "0012_binder_bb_rmsd_design_and_more")]

    operations = [
        AddIndexMaybeConcurrently(
            model_name="binder",
            index=models.Index(fields=["bb_target_aligned_rmsd_design"],
                               name="binder_placement_rmsd_idx"),
        ),
        AddIndexMaybeConcurrently(
            model_name="binder",
            index=models.Index(fields=["designfolding_bb_rmsd"],
                               name="binder_mono_rmsd_idx"),
        ),
        AddIndexMaybeConcurrently(
            model_name="binder",
            index=models.Index(fields=["min_interaction_pae"],
                               name="binder_interaction_pae_idx"),
        ),
        # The cross-proteome query people will actually run is "good confidence
        # AND good interface", so index that pair as well as the columns alone.
        AddIndexMaybeConcurrently(
            model_name="binder",
            index=models.Index(fields=["design_to_target_iptm", "min_interaction_pae"],
                               name="binder_iptm_pae_idx"),
        ),
        AddIndexMaybeConcurrently(
            model_name="binder",
            index=models.Index(fields=["pass_filters"], name="binder_pass_filters_idx"),
        ),
    ]
