import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getStats } from "../api/client";
import usePageMeta, { count as fmtCount } from "../utils/pageMeta";
import type { Stats } from "../types";

/**
 * What the numbers on the rest of the site mean.
 *
 * Every run page and the runs index lead with "Placed", "Monomer", "Passed",
 * "Best ipTM" and "Best RMSD", and until this page existed none of them was
 * defined anywhere a visitor could reach. A reader who cannot tell a placement
 * rate from a pass rate cannot read the leaderboard at all, so the glossary is
 * the substance here and the introduction is the preamble.
 */

/** Matches DEFAULT_PLACEMENT_A / DEFAULT_MONOMER_A in binderbase/api.py. */
const PLACEMENT_A = 2.0;
const MONOMER_A = 2.0;

interface Metric {
  term: string;
  column: string;
  body: React.ReactNode;
}

const METRICS: Metric[] = [
  {
    term: "Placed",
    column: "bb_target_aligned_rmsd_design",
    body: (
      <>
        The fraction of a run's designs that stay on the epitope when the
        complex is folded again from sequence alone. The design is refolded,
        the <em>target</em> is superposed on the original, and the binder's
        backbone displacement is measured where it lands. Under{" "}
        <strong>{PLACEMENT_A} Å</strong> counts as placed.
        <p className="about-note">
          This is the metric that matters most, and the hardest to pass. A
          design is proposed with its binder already against the epitope;
          placement asks whether anything about the sequence actually puts it
          there. Aligning on the target rather than the binder is what makes it
          a question about position instead of shape — a binder that folds
          perfectly on the opposite face of the protein scores badly here, and
          should.
        </p>
      </>
    ),
  },
  {
    term: "Monomer",
    column: "designfolding_bb_rmsd",
    body: (
      <>
        The fraction of designs whose binder folds to the intended shape{" "}
        <em>on its own</em>, with no target present, within{" "}
        <strong>{MONOMER_A} Å</strong> backbone RMSD. Self-consistency.
        <p className="about-note">
          Independent of placement, and the two come apart often enough to be
          worth watching separately: a run can fold 74% of its binders
          correctly and place none of them. That pattern means the designer is
          producing real proteins that bind somewhere other than where it was
          asked.
        </p>
      </>
    ),
  },
  {
    term: "Passed",
    column: "pass_filters",
    body: (
      <>
        The fraction of designs that satisfied every filter the design pipeline
        applied — its own verdict, recorded as given.
        <p className="about-note">
          Not comparable across methods. Each pipeline sets its own thresholds,
          so a 100% pass rate means "this tool approved of its own output", not
          that the designs are better than another run's. Read it next to
          placement, never instead of it.
        </p>
      </>
    ),
  },
  {
    term: "ipTM",
    column: "design_to_target_iptm",
    body: (
      <>
        Interface predicted TM-score: the folding model's own confidence in the
        <em> interface</em> between binder and target, from 0 to 1. Higher is
        better. Distinct from pTM, which scores the whole complex and is easy
        to inflate with a well-folded target.
      </>
    ),
  },
  {
    term: "Interaction PAE",
    column: "min_interaction_pae",
    body: (
      <>
        The lowest predicted aligned error, in ångströms, across residue pairs
        that span the interface — how confident the model is about where the
        two chains sit relative to each other. Lower is better. An ipTM that
        looks good alongside a poor interaction PAE usually means a plausible
        interface in the wrong place.
      </>
    ),
  },
  {
    term: "pLDDT",
    column: "complex_plddt",
    body: (
      <>
        Per-residue confidence in the local structure, 0–100. It is what the
        blue-to-orange colouring in the structure viewers shows. High pLDDT on
        a binder means the model is sure of that fold; it says nothing about
        whether the fold binds anything.
      </>
    ),
  },
  {
    term: "Quality score",
    column: "quality_score",
    body: (
      <>
        The design pipeline's own ranking score, which is what the binder table
        sorts by before you change it. Like the pass flag, it is internal to a
        method — a rank-1 design is that run's best by its own reckoning, not
        a claim against any other run.
      </>
    ),
  },
  {
    term: "Epitope",
    column: 'metadata["Hotspot residues"]',
    body: (
      <>
        The residues the designer was told to bind, in the target structure's
        own numbering — <code>675..678,700..709,728..733</code>. Usually
        discontiguous, because a binding patch is a surface footprint rather
        than a stretch of sequence.
        <p className="about-note">
          These are <em>not</em> always UniProt positions. A target is a crop
          of its protein, and whether the crop keeps the parent's numbering
          depends on the tool that made it — across the runs recorded here
          most do not. Each run stores where its crop sits in the UniProt
          sequence, which is what lets the PAE panel mark the epitope in the
          right place; a run without that mapping shows an unmarked PAE
          rather than a guess.
        </p>
      </>
    ),
  },
];

const COLOURS = [
  { hex: "#FFE119", name: "Yellow", body: "Epitope — the patch the design was asked to bind." },
  { hex: "#9A9A9A", name: "Grey", body: "Masked — a face created by cropping the target out of a full model. Not real protein surface, so a design that binds one has bound an artefact of the crop." },
  { hex: "#6A3D9A", name: "Purple", body: "Unconstrained — real surface the design was neither pointed at nor steered away from." },
];

export default function About() {
  const [stats, setStats] = useState<Stats | null>(null);

  usePageMeta({
    title: "About",
    description:
      "What Binder Base records for each protein binder design run: how " +
      "placement, self-consistency and interface confidence are measured, " +
      "and how to cite a run.",
  });

  useEffect(() => {
    // Counts rather than prose, so the page cannot go stale against the
    // database it is describing.
    getStats().then(setStats).catch(() => setStats(null));
  }, []);

  return (
    <div className="hero hero-page">
      <h1 className="hero-title">About</h1>
      <div className="about-body">
        <p className="about-section-body">
          Binder Base is an open record of computational protein binder design
          runs. Each target is identified by its UniProt ID and carries one or
          more design runs against it; each run stores every design it
          produced, with the structure, the scores and the configuration that
          made it.
        </p>
        <p className="about-section-body">
          Failures are kept alongside successes, deliberately. A run where
          nothing placed is a result about the target and the method, and it is
          not recoverable from a database that stores only what worked.
        </p>

        {stats && (
          <div className="about-stats">
            {[
              [stats.protein_count, "targets"],
              [stats.run_count, "runs"],
              [stats.binder_count, "designs"],
              [stats.success_count, "passing designs"],
            ].map(([value, label]) => (
              <div className="about-stat" key={label as string}>
                <span className="about-stat-value">
                  {fmtCount(value as number)}
                </span>
                <span className="about-stat-label">{label as string}</span>
              </div>
            ))}
          </div>
        )}

        <h2 className="about-heading">What the numbers mean</h2>
        <p className="about-section-body">
          Every rate on a run page is the fraction of that run's designs
          meeting a threshold, shown with the raw count beneath it — a 50% rate
          over two designs is not a good run, and the count is there so it
          cannot read like one.
        </p>

        <dl className="about-glossary">
          {METRICS.map((m) => (
            <div className="about-term" key={m.term}>
              <dt>
                {m.term}
                <code className="about-term-col">{m.column}</code>
              </dt>
              <dd>{m.body}</dd>
            </div>
          ))}
        </dl>

        <h2 className="about-heading">Colours in the structure viewers</h2>
        <p className="about-section-body">
          A run's target structure carries its design constraints in the
          B-factor column, which is what the <em>Design constraints</em>{" "}
          colouring shows:
        </p>
        <ul className="about-colours">
          {COLOURS.map((c) => (
            <li key={c.hex}>
              <span className="about-swatch" style={{ background: c.hex }} />
              <span>
                <strong>{c.name}</strong> — {c.body}
              </span>
            </li>
          ))}
        </ul>
        <p className="about-section-body">
          Binder structures are coloured by model confidence (pLDDT) instead,
          blue for high and orange for low — the same scale AlphaFold uses.
        </p>

        <h2 className="about-heading">Citing a run</h2>
        <p className="about-section-body">
          Every run has a stable accession: the target's UniProt ID and the
          run's ordinal against that target, as in{" "}
          <code>Q02763-R001</code>. Accessions are assigned once and never
          reused, so one always names the same run — if a run is removed its
          accession is retired rather than handed on. Cite a run as{" "}
          <em>Binder Base, run Q02763-R001</em>, and a specific design by its
          rank within that run.
        </p>

        <h2 className="about-heading">Reproducibility</h2>
        <p className="about-section-body">
          Runs record the container, the resolved configuration and its hash,
          the model checkpoint and the random seed, all visible under{" "}
          <em>Steps &amp; Configuration</em> on a run page. That is enough to
          re-execute a run on matched hardware.
        </p>
        <p className="about-section-body">
          It is <strong>not</strong> enough to reproduce it bitwise, and no
          campaign here claims otherwise. GPU kernel nondeterminism is
          amplified by the diffusion trajectory — identical seeded runs have
          diverged by up to ~31 Å in individual coordinates — and across GPU
          architectures only statistical equivalence is expected. Rates over a
          thousand designs are reproducible; any single design is not.
        </p>

        <h2 className="about-heading">Getting the data</h2>
        <p className="about-section-body">
          Every table has an export beside it: a run's designs as CSV or FASTA,
          its provenance as <code>meta.json</code>, and the whole leaderboard
          as <Link to="/runs">one CSV</Link>. Each row carries its run
          accession and the path to the design's structure, so a hundred
          exports concatenate into something still self-describing. The same
          endpoints are documented at{" "}
          <a href="/api/docs" target="_blank" rel="noreferrer">/api/docs</a>.
        </p>
        <p className="about-section-body">
          Structures are not bundled: a full campaign is over a terabyte of
          CIF files, which is a file-transfer problem rather than a web
          response. The <code>cif_path</code> column in every export is what a
          fetch script needs.
        </p>
      </div>
    </div>
  );
}
