"""Tests for the import_run management command.

Place at binder_backend/binderbase/tests.py (replaces the stub) and run:

    python manage.py test binderbase

Every network call is patched out, so these run offline and deterministically.

Each test here corresponds to a failure that actually occurred during BinderBase
integration, not to a hypothetical. The names say which.
"""
import csv
import io
import json
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

    # -- contract with the frontend -----------------------------------------

    def test_summary_payload_shape_is_the_frontend_contract(self):
        """The RunSummary interface in binder_frontend/src/types/index.ts is
        written against these exact keys.

        A rename here does not break the build on either side -- the frontend
        reads JSON, so a missing key arrives as undefined and the run page
        quietly renders blanks. Pinning the shape here is what turns that into
        a failing test instead of an empty panel nobody notices.
        """
        d = self._summary()
        self.assertEqual(
            set(d),
            {"run_id", "protein", "target", "counts", "rates", "best",
             "histograms", "enrichment", "provenance"})
        self.assertEqual(set(d["protein"]), {"id", "uniprot_id", "gene_name"})
        self.assertEqual(set(d["target"]),
                         {"epitope", "crop_length", "structure_source", "masked_faces"})
        self.assertEqual(set(d["counts"]),
                         {"designs", "passed_filters", "placement_hits",
                          "monomer_consistent"})
        self.assertEqual(set(d["rates"]),
                         {"pass", "placement", "monomer",
                          "placement_threshold", "monomer_threshold"})
        self.assertEqual(set(d["best"]),
                         {"binder_id", "final_rank", "quality_score",
                          "design_to_target_iptm", "min_interaction_pae",
                          "bb_target_aligned_rmsd_design", "designfolding_bb_rmsd"})
        self.assertEqual(set(d["enrichment"]), {"base_rate", "curve"})
        self.assertEqual(set(d["enrichment"]["curve"][0]), {"k", "hit_rate", "fold"})

    def test_summary_histogram_keys_match_the_run_page_charts(self):
        """RunDetail.tsx renders exactly these four, keyed by name.

        Note the underscore in designfolding_bb_rmsd: the metric is spelled
        'designfolding-bb_rmsd' in the pipeline CSV, and the hyphen is not a
        legal identifier, so the promoted column and this payload use an
        underscore. A chart keyed off the CSV spelling would render nothing.
        """
        h = self._summary()["histograms"]
        self.assertEqual(
            set(h),
            {"design_to_target_iptm", "min_interaction_pae",
             "bb_target_aligned_rmsd_design", "designfolding_bb_rmsd"})
        for name, hist in h.items():
            self.assertEqual(set(hist),
                             {"edges", "counts", "n", "underflow", "overflow"},
                             f"histogram {name}")
            self.assertEqual(len(hist["edges"]), len(hist["counts"]) + 1)


class RunIndexTestCase(TestCase):
    """GET /api/runs -- the leaderboard that makes a campaign comparable.

    Two runs with deliberately different shapes: one where the designs placed,
    one where none did. A single-run fixture cannot catch the aggregate leaking
    across the GROUP BY, which is the mistake this endpoint is most exposed to.
    """

    def setUp(self):
        self.good_p = Protein.objects.create(
            uniprot_id="P15692", gene_name="VEGFA", sequence="MKV", length=3)
        self.bad_p = Protein.objects.create(
            uniprot_id="P53396", gene_name="ACLY", sequence="MKV", length=3)

        # 10 designs, 4 placed, 6 monomer-consistent, 2 passed.
        self.good = BinderRun.objects.create(
            protein=self.good_p, algorithm="BlitzGen 1.0.0",
            run_dir="runs/P15692-VEGFA_HPA069116-20261029",
            metadata={"Hotspot residues": "239..258",
                      "Binding patch residues": "20"})
        for i in range(1, 11):
            Binder.objects.create(
                run=self.good, binder_sequence="A" * 20, final_rank=i,
                design_to_target_iptm=0.90 - i * 0.01,
                bb_target_aligned_rmsd_design=(1.0 if i <= 4 else 20.0),
                designfolding_bb_rmsd=(0.5 if i <= 6 else 9.0),
                pass_filters=(i <= 2))

        # 5 designs, none placed, none passed. No patch in metadata: this is a
        # run from before select_patch.py, declaring the whole span.
        self.bad = BinderRun.objects.create(
            protein=self.bad_p, algorithm="BlitzGen 1.0.0",
            run_dir="runs/P53396-ACLY_HPA022953-20261021",
            metadata={"Hotspot residues": "764-861"})
        for i in range(1, 6):
            Binder.objects.create(
                run=self.bad, binder_sequence="A" * 20, final_rank=i,
                design_to_target_iptm=0.3,
                bb_target_aligned_rmsd_design=30.0,
                designfolding_bb_rmsd=12.0,
                pass_filters=False)

    def _index(self, **params):
        resp = Client().get("/api/runs", params)
        self.assertEqual(resp.status_code, 200)
        d = resp.json()
        return d, {r["id"]: r for r in d["items"]}

    def test_counts_are_per_run_not_pooled(self):
        """The failure this endpoint invites: one run's binders counted into
        another's row, or every row showing the global total."""
        d, by_id = self._index()
        self.assertEqual(d["total"], 2)
        self.assertEqual(by_id[self.good.id]["designs"], 10)
        self.assertEqual(by_id[self.bad.id]["designs"], 5)
        self.assertEqual(by_id[self.good.id]["placement_hits"], 4)
        self.assertEqual(by_id[self.bad.id]["placement_hits"], 0)
        self.assertEqual(by_id[self.good.id]["monomer_consistent"], 6)
        self.assertEqual(by_id[self.good.id]["passed_filters"], 2)

    def test_rates_divide_by_the_run_s_own_designs(self):
        _, by_id = self._index()
        g = by_id[self.good.id]
        self.assertAlmostEqual(g["placement_rate"], 0.4)
        self.assertAlmostEqual(g["monomer_rate"], 0.6)
        self.assertAlmostEqual(g["pass_rate"], 0.2)
        self.assertAlmostEqual(by_id[self.bad.id]["placement_rate"], 0.0)

    def test_best_placement_is_a_minimum_not_a_maximum(self):
        """Placement is an RMSD. Taking Max here would rank every run by its
        worst design while calling it the best."""
        _, by_id = self._index()
        self.assertAlmostEqual(by_id[self.good.id]["best_placement"], 1.0)
        self.assertAlmostEqual(by_id[self.good.id]["best_iptm"], 0.89)

    def test_thresholds_are_query_parameters(self):
        d, by_id = self._index(placement_threshold=25.0)
        self.assertEqual(by_id[self.good.id]["placement_hits"], 10)
        self.assertEqual(by_id[self.bad.id]["placement_hits"], 0)
        self.assertEqual(d["placement_threshold"], 25.0)

    def test_epitope_comes_from_metadata_in_both_formats(self):
        _, by_id = self._index()
        self.assertEqual(by_id[self.good.id]["epitope"], "239..258")
        self.assertEqual(by_id[self.good.id]["epitope_residues"], 20)
        # Pre-patch run: a span, and no residue count to report.
        self.assertEqual(by_id[self.bad.id]["epitope"], "764-861")
        self.assertIsNone(by_id[self.bad.id]["epitope_residues"])

    def test_run_with_no_binders_does_not_divide_by_zero(self):
        BinderRun.objects.create(
            protein=self.bad_p, run_dir="runs/empty-20261029", metadata={})
        d, _ = self._index()
        empty = next(r for r in d["items"] if r["designs"] == 0)
        self.assertEqual(empty["placement_rate"], 0.0)
        self.assertIsNone(empty["best_placement"])

    def test_run_without_metadata_does_not_error(self):
        BinderRun.objects.create(
            protein=self.bad_p, run_dir="runs/nometa-20261029", metadata=None)
        d, _ = self._index()
        self.assertEqual(d["total"], 3)

    def test_index_payload_shape_is_the_frontend_contract(self):
        """RunListRow in binder_frontend/src/types/index.ts is written against
        these keys. A rename arrives on the client as undefined, so the table
        renders blank columns rather than failing -- pin it here instead."""
        d, _ = self._index()
        self.assertEqual(set(d),
                         {"items", "total", "placement_threshold", "monomer_threshold"})
        self.assertEqual(
            set(d["items"][0]),
            {"id", "protein_id", "uniprot_id", "gene_name", "algorithm",
             "run_datetime", "epitope", "epitope_residues", "designs",
             "placement_hits", "monomer_consistent", "passed_filters",
             "placement_rate", "monomer_rate", "pass_rate",
             "best_iptm", "best_placement"})

    def test_index_matches_the_summary_for_the_same_run(self):
        """Two endpoints computing the same four counts by different routes --
        one grouped annotation, one per-run aggregate. They must not drift."""
        _, by_id = self._index()
        row = by_id[self.good.id]
        s = Client().get(f"/api/runs/{self.good.id}/summary").json()
        self.assertEqual(row["designs"], s["counts"]["designs"])
        self.assertEqual(row["placement_hits"], s["counts"]["placement_hits"])
        self.assertEqual(row["monomer_consistent"], s["counts"]["monomer_consistent"])
        self.assertEqual(row["passed_filters"], s["counts"]["passed_filters"])
        self.assertAlmostEqual(row["placement_rate"], s["rates"]["placement"])


class ExportTestCase(TestCase):
    """CSV / FASTA / meta.json downloads.

    All of these stream, so the body arrives as `streaming_content` and
    `response.content` raises -- reading them through a helper keeps that from
    being rediscovered per test.
    """

    def setUp(self):
        self.protein = Protein.objects.create(
            uniprot_id="P15692", gene_name="VEGFA", sequence="MKV", length=3)
        self.run = BinderRun.objects.create(
            protein=self.protein, algorithm="BlitzGen 1.0.0",
            run_dir="runs/P15692-VEGFA_HPA069116-20261029",
            metadata={"Hotspot residues": "239..258",
                      "Binding patch residues": "20",
                      "Container": "blitzgen.sif"})
        for i in range(1, 6):
            Binder.objects.create(
                run=self.run,
                binder_sequence="ACDEFGHIKL" * (6 + i),   # 60-110 aa, > one wrap
                binder_length=10 * (6 + i),
                final_rank=i,
                status="success" if i <= 2 else "failure",
                quality_score=1.0 - i * 0.1,
                design_to_target_iptm=0.9 - i * 0.05,
                min_interaction_pae=2.0 + i,
                bb_target_aligned_rmsd_design=(1.0 if i <= 2 else 20.0),
                designfolding_bb_rmsd=0.8,
                complex_plddt=85.0,
                pass_filters=(i <= 2),
                metrics={"id": 1, "file_name": "x.cif", "extra_metric": i * 10},
            )

    def _body(self, url, **params):
        resp = Client().get(url, params)
        self.assertEqual(resp.status_code, 200)
        return resp, b"".join(resp.streaming_content).decode()

    def _csv(self, url, **params):
        resp, text = self._body(url, **params)
        return resp, list(csv.reader(io.StringIO(text)))

    # -- binders.csv ---------------------------------------------------------

    def test_csv_exports_every_binder_not_one_page(self):
        """The default listing pages at 20. An export that inherited that would
        be the thing it exists to replace."""
        _, rows = self._csv(f"/api/runs/{self.run.id}/binders.csv")
        self.assertEqual(len(rows), 6)          # header + 5
        self.assertEqual(rows[0][0], "binder_id")

    def test_csv_header_is_the_stable_contract(self):
        _, rows = self._csv(f"/api/runs/{self.run.id}/binders.csv")
        self.assertEqual(rows[0], [
            "binder_id", "run_id", "uniprot_id", "gene_name", "final_rank",
            "status", "pass_filters", "binder_length", "binder_sequence",
            "quality_score", "design_to_target_iptm", "min_interaction_pae",
            "bb_target_aligned_rmsd_design", "bb_rmsd_design",
            "designfolding_bb_rmsd", "complex_plddt", "design_ptm",
            "failure_reason", "cif_path"])

    def test_csv_carries_run_and_protein_identity_on_every_row(self):
        """So concatenating a hundred run exports stays self-describing."""
        _, rows = self._csv(f"/api/runs/{self.run.id}/binders.csv")
        for row in rows[1:]:
            self.assertEqual(row[1], str(self.run.id))
            self.assertEqual(row[2], "P15692")
            self.assertEqual(row[3], "VEGFA")

    def test_csv_respects_the_status_filter(self):
        _, rows = self._csv(f"/api/runs/{self.run.id}/binders.csv", status="success")
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(r[5] == "success" for r in rows[1:]))

    def test_csv_respects_the_sort_the_table_was_showing(self):
        """A download that came back in a different order than the table the
        user clicked it from is a bug, not a detail."""
        _, rows = self._csv(f"/api/runs/{self.run.id}/binders.csv",
                            sort="rank", sort_dir="desc")
        self.assertEqual([r[4] for r in rows[1:]], ["5", "4", "3", "2", "1"])

    def test_csv_quotes_a_field_containing_a_comma(self):
        """csv.writer rather than ','.join: a failure reason is free text."""
        Binder.objects.create(
            run=self.run, binder_sequence="AAA", final_rank=99,
            failure_reason='clash, severe; "overlap"')
        _, rows = self._csv(f"/api/runs/{self.run.id}/binders.csv")
        row = next(r for r in rows[1:] if r[4] == "99")
        self.assertEqual(row[17], 'clash, severe; "overlap"')

    def test_csv_promoted_columns_omit_the_metrics_json(self):
        _, rows = self._csv(f"/api/runs/{self.run.id}/binders.csv")
        self.assertNotIn("extra_metric", rows[0])

    def test_csv_metrics_full_appends_the_pipeline_columns(self):
        _, rows = self._csv(f"/api/runs/{self.run.id}/binders.csv", metrics="full")
        self.assertIn("extra_metric", rows[0])
        # id and file_name are hidden everywhere else; the export must not
        # reintroduce them.
        self.assertNotIn("file_name", rows[0])
        col = rows[0].index("extra_metric")
        self.assertEqual(rows[1][col], "10")

    def test_csv_filename_names_the_target(self):
        resp, _ = self._csv(f"/api/runs/{self.run.id}/binders.csv")
        self.assertEqual(
            resp["Content-Disposition"],
            f'attachment; filename="P15692-VEGFA-run{self.run.id}-binders.csv"')

    def test_csv_unknown_run_is_404(self):
        self.assertEqual(
            Client().get("/api/runs/999999/binders.csv").status_code, 404)

    # -- binders.fasta -------------------------------------------------------

    def test_fasta_has_one_record_per_binder(self):
        _, text = self._body(f"/api/runs/{self.run.id}/binders.fasta")
        self.assertEqual(text.count(">"), 5)

    def test_fasta_defline_carries_the_scoring_metrics(self):
        """A bare sequence file loses the only thing telling two designs
        apart, and the defline is all that survives most alignment tools."""
        _, text = self._body(f"/api/runs/{self.run.id}/binders.fasta")
        first = text.splitlines()[0]
        self.assertTrue(first.startswith(">binder"))
        self.assertIn(f"run={self.run.id}", first)
        self.assertIn("uniprot=P15692", first)
        self.assertIn("gene=VEGFA", first)
        self.assertIn("rank=1", first)
        self.assertIn("iptm=0.85", first)
        self.assertIn("pass=yes", first)

    def test_fasta_identifier_is_unique_per_binder(self):
        _, text = self._body(f"/api/runs/{self.run.id}/binders.fasta")
        ids = [ln.split()[0] for ln in text.splitlines() if ln.startswith(">")]
        self.assertEqual(len(ids), len(set(ids)))

    def test_fasta_wraps_sequences(self):
        _, text = self._body(f"/api/runs/{self.run.id}/binders.fasta")
        seq_lines = [ln for ln in text.splitlines() if ln and not ln.startswith(">")]
        self.assertTrue(seq_lines)
        self.assertTrue(all(len(ln) <= 60 for ln in seq_lines))

    def test_fasta_sequences_round_trip_unchanged(self):
        """Wrapping must not drop or duplicate residues."""
        _, text = self._body(f"/api/runs/{self.run.id}/binders.fasta")
        joined, current = {}, None
        for ln in text.splitlines():
            if ln.startswith(">"):
                current = ln.split("|")[0][7:]
                joined[current] = ""
            elif current:
                joined[current] += ln
        for b in self.run.binder_set.all():
            self.assertEqual(joined[str(b.id)], b.binder_sequence)

    def test_fasta_limit_takes_the_leading_n_in_sort_order(self):
        _, text = self._body(f"/api/runs/{self.run.id}/binders.fasta", limit=2)
        self.assertEqual(text.count(">"), 2)
        self.assertIn("rank=1", text)
        self.assertNotIn("rank=3", text)

    def test_fasta_limit_names_itself_in_the_filename(self):
        resp, _ = self._body(f"/api/runs/{self.run.id}/binders.fasta", limit=2)
        self.assertIn("top2.fasta", resp["Content-Disposition"])

    # -- meta.json -----------------------------------------------------------

    def test_meta_json_returns_the_provenance_record(self):
        resp = Client().get(f"/api/runs/{self.run.id}/meta.json")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(json.loads(resp.content)["Container"], "blitzgen.sif")
        self.assertIn("attachment", resp["Content-Disposition"])

    def test_meta_json_without_metadata_is_an_empty_object(self):
        bare = BinderRun.objects.create(
            protein=self.protein, run_dir="runs/bare-20261029", metadata=None)
        resp = Client().get(f"/api/runs/{bare.id}/meta.json")
        self.assertEqual(json.loads(resp.content), {})

    # -- runs.csv ------------------------------------------------------------

    def test_runs_csv_has_one_row_per_run(self):
        BinderRun.objects.create(
            protein=self.protein, run_dir="runs/second-20261029", metadata={})
        _, rows = self._csv("/api/runs.csv")
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0][0], "run_id")

    def test_runs_csv_matches_the_index_endpoint(self):
        """Same leaderboard, two renderings. They must not drift."""
        _, rows = self._csv("/api/runs.csv")
        index = Client().get("/api/runs").json()["items"][0]
        row = dict(zip(rows[0], rows[1]))
        self.assertEqual(int(row["designs"]), index["designs"])
        self.assertEqual(int(row["placement_hits"]), index["placement_hits"])
        self.assertAlmostEqual(float(row["placement_rate"]), index["placement_rate"])
        self.assertEqual(row["epitope"], index["epitope"])

    def test_runs_csv_thresholds_reach_both_the_rates_and_the_filename(self):
        resp, rows = self._csv("/api/runs.csv", placement_threshold=25.0)
        row = dict(zip(rows[0], rows[1]))
        self.assertEqual(int(row["placement_hits"]), 5)
        self.assertIn("placement25.0A", resp["Content-Disposition"])

    # -- header safety -------------------------------------------------------

    def test_filename_cannot_inject_a_response_header(self):
        """gene_name is free text from whatever wrote the run, and it lands in
        Content-Disposition. A newline there is response splitting."""
        self.protein.gene_name = 'ev"il\r\nX-Injected: 1'
        self.protein.save()
        resp, _ = self._csv(f"/api/runs/{self.run.id}/binders.csv")
        disposition = resp["Content-Disposition"]
        self.assertNotIn("\n", disposition)
        self.assertNotIn("\r", disposition)
        self.assertNotIn('ev"il', disposition)
        self.assertIsNone(resp.get("X-Injected"))
