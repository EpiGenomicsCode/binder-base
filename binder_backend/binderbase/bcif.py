"""Converting a run's design structures from mmCIF text to BinaryCIF.

BinaryCIF is the same data model as mmCIF, serialised with MessagePack and
per-column codecs: fixed-point on coordinates, delta on the monotonic columns,
run-length on the repetitive ones. It is what RCSB serves for performance and
what Mol* reads natively, so the viewer gains rather than loses. Measured on
production design CIFs of 918-2,149 atoms:

    text .cif                 202,980 B   1.00x
      + gzip -1                70,388 B   2.88x
    .bcif                      47,407 B   4.28x
      + gzip -1                22,027 B   9.21x

WHAT IS NOT CONVERTED
    The target structure in the run root stays text. It is one file out of
    ~2,000 and far under 1% of a run's bytes, but it is the one this backend
    actually parses: :mod:`binderbase.structure` recovers the epitope/mask
    classification from its B-factor column and the target sequence from
    _entity_poly, with a dependency-free regex parser. Converting it would
    force a binary parser into that module to save nothing.

    So the split falls on the dependency boundary: designs are for the viewer
    and are binary, the target is for the backend and stays text. That is also
    why :func:`design_cifs` skips the run root rather than taking a list of
    exclusions -- the rule is structural, not a list that can fall out of date.

RELATIONSHIP TO osg_pilot/cif_to_bcif.py
    The campaign wrapper converts on the worker node, before the run is ever
    packed, so the small bytes are what cross the network. That script cannot
    import this module: it ships to an OSPool sandbox that has biotite and no
    Django. This module cannot import that script either, for the same reason
    in reverse. The conversion body is therefore duplicated between them and
    has to be changed in both -- the same constraint that already keeps two
    copies of make_meta_json.py.

    If they ever disagree, this one is authoritative for what the database
    expects to find on disk.
"""
import os

import numpy as np
import biotite.structure.io.pdbx as pdbx

#: Default tolerance for the round-trip check, in angstrom.
#:
#: BinaryCIF stores coordinates as fixed-point integers; at the default factor
#: of 1000 that is a 0.001 A grid, which is the precision mmCIF's three decimal
#: places already carry. Measured worst case on production files is 5e-5 A, so
#: this is two orders of magnitude of headroom and still catches a real
#: corruption.
DEFAULT_TOLERANCE = 1e-3

# mmCIF is untyped -- every column read back from text is an array of strings,
# and the encoder can then only reach for its string codecs. Naming the numeric
# columns is what lets compress() put FixedPoint + Delta + IntegerPacking on the
# coordinates, and it is the whole difference between 1.66x and 4.28x.
ATOM_SITE_NUMERIC = {
    "Cartn_x": np.float32,
    "Cartn_y": np.float32,
    "Cartn_z": np.float32,
    "occupancy": np.float32,
    "B_iso_or_equiv": np.float32,
    "id": np.int32,
    "label_seq_id": np.int32,
    "auth_seq_id": np.int32,
    "label_entity_id": np.int32,
    "pdbx_PDB_model_num": np.int32,
}

# ma_qa_metric_local.metric_value is the per-residue pLDDT that Mol*'s
# MAQualityAssessment extension paints the structure with. Numeric for the same
# reason, and it benefits from the same encoding.
NUMERIC_BY_CATEGORY = {
    "atom_site": ATOM_SITE_NUMERIC,
    "ma_qa_metric_local": {"metric_value": np.float32, "label_seq_id": np.int32},
}


def bcif_path_for(cif_path):
    """``.../rank1_x.cif`` -> ``.../rank1_x.bcif``."""
    return cif_path[: -len(".cif")] + ".bcif" if cif_path.endswith(".cif") else cif_path


def convert(src, dest, tolerance=DEFAULT_TOLERANCE):
    """Write ``src`` as BinaryCIF at ``dest``; return the max coordinate delta.

    Raises ValueError if the round trip loses atoms or moves them further than
    ``tolerance``. The caller is expected to verify before deleting anything:
    a conversion that silently dropped coordinates would be discovered months
    later, in the viewer, with no text file left to compare against.
    """
    cif = pdbx.CIFFile.read(src)

    bcif = pdbx.BinaryCIFFile()
    for block_name, block in cif.items():
        out_block = pdbx.BinaryCIFBlock()
        for cat_name, category in block.items():
            numeric = NUMERIC_BY_CATEGORY.get(cat_name, {})
            columns = {}
            for col_name, column in category.items():
                dtype = numeric.get(col_name)
                try:
                    array = column.as_array(dtype) if dtype else column.as_array()
                except (ValueError, TypeError):
                    # A column we expected to be numeric that holds '?' or '.'
                    # for some rows. Keep it as text rather than lose it.
                    array = column.as_array()
                columns[col_name] = pdbx.BinaryCIFData(array)
            out_block[cat_name] = pdbx.BinaryCIFCategory(columns)
        bcif[block_name] = out_block

    pdbx.compress(bcif).write(dest)

    before = pdbx.get_structure(cif, model=1)
    after = pdbx.get_structure(pdbx.BinaryCIFFile.read(dest), model=1)
    if before.array_length() != after.array_length():
        raise ValueError(
            f"atom count changed: {before.array_length()} -> {after.array_length()}"
        )
    delta = float(np.abs(before.coord - after.coord).max())
    if delta > tolerance:
        raise ValueError(f"coordinate delta {delta:.6f} A exceeds {tolerance} A")
    return delta


def design_cifs(run_dir):
    """Absolute paths of the .cif files under ``run_dir`` that should convert.

    Everything below the run root; the target structure sitting in the root
    itself is left alone. See the module docstring.
    """
    run_dir = os.path.normpath(run_dir)
    for dirpath, _dirnames, filenames in os.walk(run_dir):
        if os.path.normpath(dirpath) == run_dir:
            continue
        for name in sorted(filenames):
            if name.endswith(".cif"):
                yield os.path.join(dirpath, name)
