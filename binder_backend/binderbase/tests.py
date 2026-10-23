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


class _RunFixtureMixin:
    """setUp shared by the import and promoted-column suites.

    A mixin rather than a base TestCase: subclassing a TestCase re-runs every
    one of its tests in the subclass, which double-reports failures.
    """

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


class ImportRunTestCase(_RunFixtureMixin, TestCase):

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


# ---------------------------------------------------------------------------
# promoted metric columns
# ---------------------------------------------------------------------------

from io import StringIO                                        # noqa: E402
from django.core.management import call_command as _call        # noqa: E402
from binderbase.metrics import promoted, to_bool, to_float      # noqa: E402


class MetricCastTestCase(TestCase):
    """Everything in `metrics` arrives as a string from csv.DictReader, so the
    casts are the whole correctness surface of the promoted columns."""

    def test_floats_parse_from_strings(self):
        self.assertEqual(to_float("6.92571"), 6.92571)
        self.assertEqual(to_float("-0.5"), -0.5)
        self.assertEqual(to_float(3.0), 3.0)

    def test_non_finite_and_blank_become_null(self):
        # These appear in real pipeline output. Left uncast they would break
        # ordering and comparison on the column.
        for v in ("", None, "nan", "NaN", "inf", "-inf", "n/a", "None"):
            self.assertIsNone(to_float(v), f"{v!r} should cast to None")

    def test_bools_parse_from_csv_text(self):
        for v in ("True", "true", "1", True):
            self.assertIs(to_bool(v), True, f"{v!r}")
        for v in ("False", "false", "0", False):
            self.assertIs(to_bool(v), False, f"{v!r}")
        self.assertIsNone(to_bool("maybe"))
        self.assertIsNone(to_bool(None))

    def test_hyphenated_key_maps_to_identifier(self):
        """'designfolding-bb_rmsd' is not a legal Python name; the mapping must
        be explicit or the column silently stays null."""
        out = promoted({"designfolding-bb_rmsd": "1.25"})
        self.assertEqual(out["designfolding_bb_rmsd"], 1.25)

    def test_absent_keys_are_null_not_an_error(self):
        """BinderBase ingests runs from any design tool, so a run that is not
        from BoltzGen simply will not carry these keys."""
        out = promoted({"something_else": "1"})
        self.assertTrue(all(v is None for v in out.values()))


class PromotedColumnTestCase(_RunFixtureMixin, TestCase):
    """Reuses the import fixture; asserts the columns mirror the JSON."""

    def test_import_populates_columns_without_backfill(self):
        _write_run(self.media, n_designs=5)
        self._import()
        self.assertEqual(
            Binder.objects.filter(bb_target_aligned_rmsd_design__isnull=False).count(), 5,
            "import_run must populate promoted columns, not leave them for a backfill")

    def test_columns_match_the_json_they_mirror(self):
        _write_run(self.media, n_designs=4)
        self._import()
        for b in Binder.objects.all():
            self.assertEqual(b.bb_target_aligned_rmsd_design,
                             float(b.metrics["bb_target_aligned_rmsd_design"]))
            self.assertEqual(b.designfolding_bb_rmsd,
                             float(b.metrics["designfolding-bb_rmsd"]))
            self.assertEqual(b.pass_filters,
                             b.metrics["pass_filters"].strip().lower() == "true")

    def test_columns_are_queryable(self):
        """The point of the exercise: filtering without scanning JSON."""
        _write_run(self.media, n_designs=5)
        self._import()
        # fixture writes bb_target_aligned_rmsd_design = 1.0 + i for i in 1..5
        self.assertEqual(Binder.objects.filter(
            bb_target_aligned_rmsd_design__lt=3.5).count(), 2)
        self.assertEqual(Binder.objects.filter(pass_filters=True).count(), 2)

    def test_backfill_repairs_rows_with_null_columns(self):
        _write_run(self.media, n_designs=5)
        self._import()
        Binder.objects.update(**{f: None for f in
                                 ("min_interaction_pae", "bb_target_aligned_rmsd_design",
                                  "designfolding_bb_rmsd", "pass_filters")})
        self.assertEqual(
            Binder.objects.filter(bb_target_aligned_rmsd_design__isnull=False).count(), 0)
        _call("backfill_metrics", stdout=StringIO())
        self.assertEqual(
            Binder.objects.filter(bb_target_aligned_rmsd_design__isnull=False).count(), 5)

    def test_backfill_is_idempotent(self):
        _write_run(self.media, n_designs=3)
        self._import()
        out = StringIO()
        _call("backfill_metrics", stdout=out)
        self.assertIn("nothing to backfill", out.getvalue())

    def test_scan_reports_coverage_without_writing(self):
        _write_run(self.media, n_designs=3)
        self._import()
        Binder.objects.update(bb_target_aligned_rmsd_design=None)
        out = StringIO()
        _call("backfill_metrics", "--scan", stdout=out)
        self.assertIn("100.0%", out.getvalue())
        # --scan must not repair anything
        self.assertEqual(
            Binder.objects.filter(bb_target_aligned_rmsd_design__isnull=False).count(), 0)


# ---------------------------------------------------------------------------
# run summary endpoint
# ---------------------------------------------------------------------------

from django.test import Client                                  # noqa: E402


class RunSummaryTestCase(TestCase):
    """Built on synthetic binders so the arithmetic is checkable by hand.

    The real ACLY run has zero placement hits, which cannot exercise the
    enrichment path at all.
    """

    def setUp(self):
        self.protein = Protein.objects.create(
            uniprot_id="P12345", gene_name="TESTG", sequence="MKV", length=3)
        self.run = BinderRun.objects.create(
            protein=self.protein, algorithm="BlitzGen 1.0.0", hardware="A100",
            run_dir="runs/P12345-TESTG_HPA1-20261023",
            metadata={"Hotspot residues": "10-40", "Crop length": 120,
                      "Container": "blitzgen.sif"})
        # 20 binders, quality_score descending with rank.
        # Placement: ranks 1-5 and 11 are hits (<2.0); 6 hits in 20 overall.
        #   base rate   = 6/20  = 0.30
        #   top-10 rate = 5/10  = 0.50   -> fold 1.67
        hits = {1, 2, 3, 4, 5, 11}
        for i in range(1, 21):
            Binder.objects.create(
                run=self.run, binder_sequence="A" * (10 + i), binder_length=10 + i,
                final_rank=i, quality_score=1.0 - i * 0.01,
                design_to_target_iptm=0.9 - i * 0.02,
                min_interaction_pae=3.0 + i,
                bb_target_aligned_rmsd_design=(1.0 if i in hits else 25.0),
                designfolding_bb_rmsd=(0.9 if i <= 12 else 9.0),
                pass_filters=(i <= 4),
                metrics={"note": "synthetic"},
            )

    def _summary(self, **params):
        resp = Client().get(f"/api/runs/{self.run.id}/summary", params)
        self.assertEqual(resp.status_code, 200)
        return resp.json()

    def test_counts_and_rates(self):
        d = self._summary()
        self.assertEqual(d["counts"], {
            "designs": 20, "passed_filters": 4,
            "placement_hits": 6, "monomer_consistent": 12})
        self.assertAlmostEqual(d["rates"]["placement"], 0.30)
        self.assertAlmostEqual(d["rates"]["monomer"], 0.60)

    def test_enrichment_against_base_rate(self):
        d = self._summary()
        self.assertAlmostEqual(d["enrichment"]["base_rate"], 0.30)
        k10 = next(c for c in d["enrichment"]["curve"] if c["k"] == 10)
        self.assertAlmostEqual(k10["hit_rate"], 0.50)
        self.assertAlmostEqual(k10["fold"], 1.67, places=2)

    def test_enrichment_skips_k_larger_than_the_run(self):
        """20 binders must not produce a k=30 point computed over 20."""
        ks = [c["k"] for c in self._summary()["enrichment"]["curve"]]
        self.assertEqual(ks, [10])

    def test_thresholds_are_query_parameters(self):
        """2 A is a convention, not a property of the data."""
        d = self._summary(placement_threshold=30.0)
        self.assertEqual(d["counts"]["placement_hits"], 20)
        self.assertEqual(d["rates"]["placement_threshold"], 30.0)

    def test_histogram_reports_overflow_separately(self):
        """Clamped outliers must be distinguishable, or the end bar lies.

        The real ACLY run has 56 of 65 in its top placement bin sitting beyond
        the 40 A ceiling, so without this the UI renders "38-40" for what is
        actually ">=38, including values at 100".
        """
        # placement histogram spans 0-40; put one design well past the ceiling
        Binder.objects.create(
            run=self.run, binder_sequence="A" * 30, final_rank=99,
            quality_score=0.0, bb_target_aligned_rmsd_design=100.0, metrics={})
        h = self._summary()["histograms"]["bb_target_aligned_rmsd_design"]
        self.assertEqual(h["n"], 21)
        self.assertEqual(sum(h["counts"]), 21, "clamped values still counted in a bin")
        self.assertEqual(h["overflow"], 1, "but reported separately so the bar is honest")
        self.assertEqual(h["underflow"], 0)

    def test_best_is_the_top_ranked_design(self):
        d = self._summary()
        self.assertEqual(d["best"]["final_rank"], 1)
        self.assertAlmostEqual(d["best"]["bb_target_aligned_rmsd_design"], 1.0)

    def test_target_and_provenance_come_from_metadata(self):
        d = self._summary()
        self.assertEqual(d["target"]["epitope"], "10-40")
        self.assertEqual(d["provenance"]["container"], "blitzgen.sif")
        self.assertEqual(d["provenance"]["algorithm"], "BlitzGen 1.0.0")

    def test_empty_run_does_not_divide_by_zero(self):
        empty = BinderRun.objects.create(
            protein=self.protein, run_dir="runs/P12345-EMPTY-20261023", metadata={})
        d = Client().get(f"/api/runs/{empty.id}/summary").json()
        self.assertEqual(d["counts"]["designs"], 0)
        self.assertEqual(d["rates"]["placement"], 0.0)
        self.assertIsNone(d["best"])
        self.assertEqual(d["enrichment"]["curve"], [])

    def test_run_without_metadata_does_not_error(self):
        bare = BinderRun.objects.create(
            protein=self.protein, run_dir="runs/P12345-BARE-20261023", metadata=None)
        d = Client().get(f"/api/runs/{bare.id}/summary").json()
        self.assertIsNone(d["target"]["epitope"])

    def test_unknown_run_is_404(self):
        self.assertEqual(Client().get("/api/runs/999999/summary").status_code, 404)
