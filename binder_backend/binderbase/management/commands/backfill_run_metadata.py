"""Re-derive a run's metadata from the artefacts it was imported with.

    python manage.py backfill_run_metadata --source constraints --dry-run
    python manage.py backfill_run_metadata --source constraints
    python manage.py backfill_run_metadata --source patch-size

A source is a named derivation: given a run, work out what some metadata key
should be, and say so. Adding one is a class with a `derive` method and an
entry in SOURCES -- not a new command -- because the alternative is what this
replaces, a command per question.

Existing values are kept unless --force, so every source is safe to run across
every run, including the ones with real provenance.
"""
import os

from binderbase import accessions, structure
from binderbase.management.runcommand import Change, RunUpdateCommand, Skip
from binderbase.models import BinderRun

# Metadata keys, named exactly as make_meta_json writes them: RunListSchema and
# the run page read them back by these names.
KEY_HOTSPOT = "Hotspot residues"
KEY_MASKED = "Masked cut faces"
KEY_PATCH_N = "Binding patch residues"
KEY_SOURCE = "Hotspot source"
KEY_RESIDUES = "Target residues"
KEY_OFFSET = "Residue offset"

RECOVERED_NOTE = (
    "Recovered from the target structure's B_iso_or_equiv column, which carries "
    "BoltzGen's per-residue binding spec (binding_type_id * 80). Run predates "
    "the formalised meta.json, so this is reconstructed rather than recorded."
)


class Source:
    """One named derivation."""

    name = ""
    help = ""

    def derive(self, run, options):
        raise NotImplementedError

    def order_runs(self, runs):
        """Hook for a source whose result depends on the order runs are
        visited. Only run-code does; everything else is order-independent and
        gets the selection as it comes."""
        return runs


def _target_constraints(run):
    """Read the run's target structure, or Skip saying why it could not be."""
    if not run.cif_path:
        raise Skip("no target structure on the run", is_error=True)
    path = RunUpdateCommand.media_path(run.cif_path)
    if not os.path.isfile(path):
        raise Skip(f"target structure missing ({path})", is_error=True)
    try:
        return structure.constraints_from_cif(path)
    except (OSError, ValueError) as exc:
        raise Skip(f"could not read target structure ({exc})", is_error=True)


class ConstraintsSource(Source):
    """The epitope and crop faces, read back out of the target structure.

    Runs imported before meta.json was formalised carry no epitope, so the runs
    index shows a blank cell and the PAE band and hotspot legend have nothing
    to draw. The information was never lost -- it is what paints the structure
    purple and yellow -- so it can be read back.
    """

    name = "constraints"
    help = "epitope and masked crop faces, from the target CIF B-factor column"

    def derive(self, run, options):
        found = _target_constraints(run)
        if not found[structure.HOTSPOT]:
            raise Skip(f"no constrained residues in the B-factor column "
                       f"({found['total']} residues, all unconstrained)")

        if found[structure.HOTSPOT] and len(found[structure.HOTSPOT]) == found["total"]:
            # Every residue binding means the run declares no epitope to place
            # against. Recovering one from it would manufacture it. check_runs
            # is where that gets reported.
            raise Skip(f"every one of the {found['total']} target residues is "
                       f"marked binding; no epitope to recover")

        existing = (run.metadata or {}).get(KEY_HOTSPOT)
        if existing and not options.get("force"):
            # The recorded value wins -- but a run can have an epitope and
            # still be missing its size, so defer to the patch-size source
            # rather than skipping outright.
            yield from PatchSizeSource().derive(run, options)
            return

        yield Change(KEY_HOTSPOT, structure.to_ranges(found[structure.HOTSPOT]),
                     in_metadata=True)
        yield Change(KEY_PATCH_N, len(found[structure.HOTSPOT]), in_metadata=True)
        yield Change(KEY_SOURCE, RECOVERED_NOTE, in_metadata=True,
                     note="(provenance note)")
        if found[structure.MASKED]:
            yield Change(KEY_MASKED, structure.to_ranges(found[structure.MASKED]),
                         in_metadata=True)


class PatchSizeSource(Source):
    """How many residues the recorded epitope covers.

    Whole-PrEST runs record "Hotspot residues" but no size, which is why half
    the runs index shows a blank residue count. The size is derivable from the
    epitope string itself, so this never needs the structure.
    """

    name = "patch-size"
    help = "residue count of an already-recorded epitope"

    def derive(self, run, options):
        metadata = run.metadata or {}
        epitope = metadata.get(KEY_HOTSPOT)
        if not epitope:
            raise Skip()
        if metadata.get(KEY_PATCH_N) is not None and not options.get("force"):
            raise Skip()
        residues = structure.parse_ranges(epitope)
        if not residues:
            raise Skip(f'epitope "{epitope}" has no parseable residue ranges')
        yield Change(KEY_PATCH_N, len(residues), in_metadata=True,
                     note=f'{len(residues)} (size of the recorded "{epitope}")')


class RunCodeSource(Source):
    """The run's public accession, for runs imported before it existed.

    Ordered by run_datetime so the existing corpus numbers chronologically:
    Q02763-R001 is the earlier TEK run and -R002 the later one. After this
    pass, codes come from import_run and ordering never enters into it again
    -- which is the point. An accession that could be recomputed is not one.
    """

    name = "run-code"
    help = "stable public accession, e.g. Q02763-R001"

    def derive(self, run, options):
        if run.run_code and not options.get("force"):
            raise Skip()
        uniprot_id = run.protein.uniprot_id
        if not uniprot_id:
            raise Skip("protein has no UniProt ID to build an accession from")
        code = accessions.next_run_code(BinderRun, uniprot_id, exclude_pk=run.pk)
        if not code:
            raise Skip("could not build an accession")
        yield Change("run_code", code)

    def order_runs(self, runs):
        # Chronological, with undated runs last and the primary key breaking
        # ties, so a re-run over the same corpus assigns the same codes.
        return sorted(
            runs, key=lambda r: (r.run_datetime is None, r.run_datetime, r.pk))


class ResidueMapSource(Source):
    """How the target structure's numbering lines up with everything else.

    Records two things, which fail separately:

    "Target residues" is the crop's own auth_seq_id numbering in order, so the
    nth residue of target_sequence is the nth number here. It is what lets the
    structure viewer and the sequence block agree, and it cannot be taken from
    label_seq_id instead: 65 of 69 production targets number that 1..N and the
    other 4 set it equal to auth_seq_id, so it means different things in
    different files.

    "Residue offset" places the crop in the parent protein, uniprot = auth +
    offset. The run page draws the protein's full-length PAE beside the crop,
    and before this existed it indexed the two as though they shared a
    numbering. 62 of 69 targets are renumbered by the crop, so the epitope
    band landed on arbitrary residues and hovering lit up an unrelated row.
    Measured from the structure rather than assumed, because the assumption is
    what was wrong.
    """

    name = "residue-map"
    help = "the target structure's numbering, and where the crop sits in the protein"

    def derive(self, run, options):
        metadata = run.metadata or {}
        force = options.get("force")
        if (metadata.get(KEY_RESIDUES)
                and metadata.get(KEY_OFFSET) is not None and not force):
            raise Skip()
        if not run.cif_path:
            raise Skip("no target structure on the run", is_error=True)
        path = RunUpdateCommand.media_path(run.cif_path)
        if not os.path.isfile(path):
            raise Skip(f"target structure missing ({path})", is_error=True)
        full = run.protein.sequence or ""
        try:
            mapping = structure.residue_mapping(path, full)
        except (OSError, ValueError) as exc:
            raise Skip(f"could not read target structure ({exc})", is_error=True)
        if mapping is None:
            raise Skip("target structure holds no residues", is_error=True)

        residues, offset = mapping["residues"], mapping["offset"]
        # Collected rather than yielded, because the command lists the whole
        # derivation before writing any of it: a Skip raised part-way through
        # a generator discards what it already produced, which would lose the
        # numbering of exactly those runs that fail to align.
        changes = []
        if not metadata.get(KEY_RESIDUES) or force:
            span = structure.to_ranges(residues)
            note = f"{len(residues)} residues numbered {span}"
            if offset is None:
                # The structure and the sequence stay linked; only the PAE
                # panel goes unmarked, which is the right outcome -- a wrong
                # map would draw a confident band on residues the design never
                # saw. Said on the change itself so it appears in --dry-run.
                note += f" -- but {self._unaligned(run, full)}"
            changes.append(Change(KEY_RESIDUES, span, in_metadata=True,
                                  note=note))
        if offset is not None and (metadata.get(KEY_OFFSET) is None or force):
            changes.append(Change(
                KEY_OFFSET, offset, in_metadata=True,
                note=f"{offset:+d} (uniprot = auth {offset:+d})"))

        if not changes:
            # Numbering already recorded, and the crop is still unplaceable.
            raise Skip(self._unaligned(run, full))
        return changes

    @staticmethod
    def _unaligned(run, full):
        return (f"crop does not align unambiguously to "
                f"{run.protein.uniprot_id or 'the protein'} ({len(full)} aa); "
                f"PAE stays unmarked")


SOURCES = {s.name: s
           for s in (ConstraintsSource(), PatchSizeSource(), RunCodeSource(),
                     ResidueMapSource())}


class Command(RunUpdateCommand):
    help = (
        "Re-derive run metadata from the artefacts the run was imported with. "
        "Sources: " + ", ".join(f"{n} ({s.help})" for n, s in SOURCES.items()) +
        ". Existing values are kept unless --force, so this is safe to run "
        "across every run. Use --dry-run to preview."
    )

    def add_extra_arguments(self, parser):
        parser.add_argument(
            "--source", required=True, choices=sorted(SOURCES),
            help="Which derivation to run.")

    def select_runs(self, options):
        runs = super().select_runs(options)
        return SOURCES[options["source"]].order_runs(runs)

    def derive(self, run, options):
        return SOURCES[options["source"]].derive(run, options)
