"""Tests for the import_run management command.

Place at binder_backend/binderbase/tests.py (replaces the stub) and run:

    python manage.py test binderbase

Every network call is patched out, so these run offline and deterministically.

Each test here corresponds to a failure that actually occurred during BinderBase
integration, not to a hypothetical. The names say which.
"""
import csv
import os
import shutil
import tempfile
from unittest import mock

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, override_settings

from binderbase.models import Binder, BinderRun, Protein

# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

UNIPROT = "P53396"
RUN_NAME = f"{UNIPROT}-ACLY_HPA022953-20261021"

# A BoltzGen all_designs_metrics.csv names the sequence column "designed_sequence".
# It has no column called "sequence" -- that one only appears in
# final_designs_metrics_<N>.csv, which the pipeline prunes. This is the exact
# shape that imported zero binders while reporting success.
BOLTZGEN_COLUMNS = [
    "id", "final_rank", "designed_sequence", "num_design",
    "design_to_target_iptm", "min_interaction_pae", "quality_score",
    "bb_target_aligned_rmsd_design", "designfolding-bb_rmsd",
    "pass_filters", "file_name",
]

FAKE_ALPHAFOLD = {
    "sequence": "MSAKAISEQTGKELLYKFICTTSAIQNRFKYARVTPDTDWARLLQDHPWLLSQNLVVKPDQLIKRRGKLG",
    "length": 69,
    "gene_name": "ACLY",
    "protein_name": "ATP-citrate synthase",
    "organism": "Homo sapiens",
    "cif_url": "https://example.invalid/model.cif",
    "pae_doc_url": "https://example.invalid/pae.json",
}


def _write_run(root, name=RUN_NAME, n_designs=5, sequence_column="designed_sequence",
               with_meta=True, with_cifs=True, n_rows=None):
    """Build a minimal but structurally faithful run directory."""
    run = os.path.join(root, "runs", name)
    designs = os.path.join(run, "final_ranked_designs", f"final_{n_designs}_designs")
    os.makedirs(designs, exist_ok=True)
    os.makedirs(os.path.join(run, "config"), exist_ok=True)

    cols = [sequence_column if c == "designed_sequence" else c for c in BOLTZGEN_COLUMNS]
    rows = n_designs if n_rows is None else n_rows
    csv_path = os.path.join(run, "final_ranked_designs", "all_designs_metrics.csv")
    with open(csv_path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        for i in range(1, rows + 1):
            fname = f"{name.split('-')[1]}_{i:03d}.cif"
            w.writerow({
                "id": f"design_{i}",
                "final_rank": i,
                sequence_column: "AAAAGLAAGRALLPAGLAAGAEG"[: 10 + i],
                "num_design": i,
                "design_to_target_iptm": round(0.9 - i * 0.05, 4),
                "min_interaction_pae": round(3.0 + i, 3),
                "quality_score": round(1.0 - i * 0.1, 3),
                "bb_target_aligned_rmsd_design": round(1.0 + i, 3),
                "designfolding-bb_rmsd": round(0.8 + i * 0.1, 3),
                "pass_filters": "True" if i <= 2 else "False",
                "file_name": fname,
            })
            if with_cifs:
                with open(os.path.join(designs, f"rank{i:03d}_{fname}"), "w") as cf:
                    cf.write("data_test\n#\n")

    with open(os.path.join(run, "steps.yaml"), "w") as fh:
        fh.write("steps:\n- name: folding\n  config_file: config/folding.yaml\n")
    with open(os.path.join(run, "config", "folding.yaml"), "w") as fh:
        fh.write("seed: 42\nsampling_steps: 16\n")
    with open(os.path.join(run, f"{name}.cif"), "w") as fh:
        fh.write("data_target\n#\n")
    if with_meta:
        with open(os.path.join(run, "meta.json"), "w") as fh:
            fh.write(
                '{"UniProt ID": "%s", "Run date": "2026-10-21",'
                ' "Algorithm": "BlitzGen 1.0.0", "Hardware": "A100",'
                ' "Hotspot residues": "764-861", "Triage bio score": 2.15}' % UNIPROT
            )
    return run


class ImportRunTestCase(TestCase):
    def setUp(self):
        self.media = tempfile.mkdtemp(prefix="binderbase-test-")
        self.addCleanup(shutil.rmtree, self.media, ignore_errors=True)

        # No network in tests. _download_file is patched to write a stub so the
        # FileField paths are still exercised.
        def fake_download(url, dest):
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "w") as fh:
                fh.write("stub")

        patches = [
            mock.patch("binderbase.management.commands.import_run._fetch_alphafold",
                       return_value=dict(FAKE_ALPHAFOLD)),
            mock.patch("binderbase.management.commands.import_run._fetch_biological_function",
                       return_value="Catalyses the cleavage of citrate."),
            mock.patch("binderbase.management.commands.import_run._download_file",
                       side_effect=fake_download),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def _import(self):
        with override_settings(MEDIA_ROOT=self.media):
            call_command("import_run", verbosity=0)

    # -- the regression that motivated this file ----------------------------

    def test_boltzgen_designed_sequence_column_imports_binders(self):
        """all_designs_metrics.csv names the column 'designed_sequence'.

        Before CSV_COLUMN_MAP knew that name, every row failed the
        binder_sequence check and the run imported with binders=0 while
        reporting success.
        """
        _write_run(self.media, n_designs=5)
        self._import()
        self.assertEqual(Binder.objects.count(), 5)
        self.assertEqual(Binder.objects.exclude(binder_sequence="").count(), 5)

    def test_zero_binders_from_populated_csv_is_an_error(self):
        """A CSV with rows but no mappable sequence column must fail loudly.

        Silence here produces a populated database containing no designs.
        """
        _write_run(self.media, n_designs=5, sequence_column="peptide_seq")
        with self.assertRaises(CommandError) as ctx:
            self._import()
        msg = str(ctx.exception)
        self.assertIn("0 binders", msg)
        self.assertIn("binder_sequence", msg)

    # -- core behaviour ------------------------------------------------------

    def test_protein_run_and_metrics_are_populated(self):
        _write_run(self.media, n_designs=3)
        self._import()

        protein = Protein.objects.get(uniprot_id=UNIPROT)
        self.assertEqual(protein.gene_name, "ACLY")
        self.assertTrue(protein.cif_path)

        run = BinderRun.objects.get()
        self.assertEqual(run.algorithm, "BlitzGen 1.0.0")
        self.assertIn("steps", run.steps_config)
        # unmapped meta.json keys must survive into metadata
        self.assertEqual(run.metadata.get("Hotspot residues"), "764-861")

        top = Binder.objects.order_by("final_rank").first()
        self.assertEqual(top.final_rank, 1)
        self.assertAlmostEqual(top.design_to_target_iptm, 0.85, places=4)
        # unmapped CSV columns must survive into metrics
        self.assertIn("bb_target_aligned_rmsd_design", top.metrics)
        self.assertTrue(top.cif_path, "rank-matched CIF should resolve")

    def test_pass_filters_drives_status(self):
        _write_run(self.media, n_designs=5)
        self._import()
        self.assertEqual(Binder.objects.filter(status="success").count(), 2)
        self.assertEqual(Binder.objects.filter(status="failed").count(), 3)

    # -- operational properties ---------------------------------------------

    def test_reimport_is_idempotent(self):
        _write_run(self.media, n_designs=4)
        self._import()
        self._import()
        self.assertEqual(BinderRun.objects.count(), 1)
        self.assertEqual(Binder.objects.count(), 4)

    def test_run_dir_without_date_suffix_is_skipped(self):
        """import_run requires <UNIPROT>-<label>-<YYYYMMDD> and hard-skips anything
        else. A campaign script that omits the date produces runs that silently
        never import."""
        _write_run(self.media, name=f"{UNIPROT}-ACLY_HPA022953")
        self._import()
        self.assertEqual(BinderRun.objects.count(), 0)

    def test_run_without_meta_json_is_skipped(self):
        _write_run(self.media, with_meta=False)
        self._import()
        self.assertEqual(BinderRun.objects.count(), 0)

    def test_binder_without_matching_cif_still_imports(self):
        """Missing structures must not cost us the metrics row."""
        _write_run(self.media, n_designs=3, with_cifs=False)
        self._import()
        self.assertEqual(Binder.objects.count(), 3)
        self.assertEqual(Binder.objects.exclude(cif_path="").count(), 0)
