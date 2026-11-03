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
                columns[col_name] = _convert_column(column, numeric.get(col_name))
            out_block[cat_name] = pdbx.BinaryCIFCategory(columns)
        bcif[block_name] = out_block

    pdbx.compress(bcif).write(dest)
    written = pdbx.BinaryCIFFile.read(dest)

    _verify_masks(cif, written)

    before = pdbx.get_structure(cif, model=1)
    after = pdbx.get_structure(written, model=1)
    if before.array_length() != after.array_length():
        raise ValueError(
            f"atom count changed: {before.array_length()} -> {after.array_length()}"
        )
    delta = float(np.abs(before.coord - after.coord).max())
    if delta > tolerance:
        raise ValueError(f"coordinate delta {delta:.6f} A exceeds {tolerance} A")
    return delta


def _convert_column(column, dtype):
    """One CIF column -> one BinaryCIF column, mask and all.

    THE MASK IS THE POINT. mmCIF spells "not applicable" and "unknown" as the
    literal tokens `.` and `?` in the value position. BinaryCIF does not: the
    values carry a placeholder and a parallel mask array says which rows are
    absent (0 present, 1 inapplicable, 2 missing).

    Writing the characters through as data makes every such cell a PRESENT
    string whose value happens to be "?" -- which is not a null, it is a
    one-character answer. That shipped in v1.9.0 and broke pLDDT colouring for
    every converted design: Mol* builds its residue index from atom_site, where
    pdbx_PDB_ins_code had become the string "?" rather than an absent value, so
    quality-assessment's findResidueLabel -- which looks up with no ins code --
    missed every residue. With no per-residue metric the pLDDT theme falls back
    to B_iso_or_equiv, and BoltzGen writes pLDDT there on a 0-1 scale, so the
    whole complex rendered in the "very low" band.

    Nothing about that was visible in the coordinates, which is why the
    round-trip check did not catch it. _verify_masks now does.
    """
    mask = column.mask.array if column.mask is not None else None
    # masked_value replaces the `.`/`?` tokens with a neutral placeholder, which
    # is what lets a numeric column stay numeric even when some rows are absent.
    # The mask is what carries the meaning; the placeholder is never read.
    try:
        array = (column.as_array(dtype, masked_value=0) if dtype
                 else column.as_array(str, masked_value=""))
    except (ValueError, TypeError):
        # A column expected to be numeric that holds something else entirely.
        # Keep it as text rather than lose it.
        array = column.as_array(str, masked_value="")
    return pdbx.BinaryCIFColumn(
        pdbx.BinaryCIFData(array),
        pdbx.BinaryCIFData(mask) if mask is not None else None,
    )


def _verify_masks(cif, bcif):
    """Raise unless every column's null mask survived the conversion.

    Checked against the file that was actually written, not against the object
    in memory, so an encoding that cannot round-trip a mask is caught here
    rather than in a viewer months later.
    """
    for block_name, block in cif.items():
        out_block = bcif[block_name]
        for cat_name, category in block.items():
            out_cat = out_block[cat_name]
            for col_name, column in category.items():
                want = column.mask.array if column.mask is not None else None
                got_col = out_cat[col_name]
                got = got_col.mask.array if got_col.mask is not None else None
                if want is None and got is None:
                    continue
                if want is None or got is None or not np.array_equal(want, got):
                    raise ValueError(
                        f"null mask lost for {cat_name}.{col_name}: "
                        f"{'absent' if want is None else want[:4].tolist()} -> "
                        f"{'absent' if got is None else got[:4].tolist()}"
                    )


# The two tokens mmCIF uses in the value position to mean "no value", and the
# mask codes BinaryCIF carries them as.
NULL_TOKENS = {".": 1, "?": 2}   # MaskValue.INAPPLICABLE, MaskValue.MISSING


def repair(path):
    """Rebuild the null masks of a .bcif written before the mask bug was fixed.

    Returns the number of columns repaired; 0 means the file was already
    correct and nothing was rewritten.

    Re-converting from the .cif is strictly better and the caller should prefer
    it. This exists because the text file may already have been deleted, and
    the information is still recoverable: the broken converter wrote the `.`
    and `?` tokens through as ordinary string values, so what was lost is the
    DISTINCTION between a null and a literal, not the content. Every masked
    column in such a file is a string column holding those tokens.

    That is also the one assumption here. A column whose genuine value is the
    single character "." or "?" would be wrongly masked -- mmCIF reserves both
    tokens in the value position, so this cannot happen in a conformant file,
    but it is the reason this is a repair for a known defect and not a general
    cleaning pass.
    """
    bcif = pdbx.BinaryCIFFile.read(path)
    repaired = 0

    for _block_name, block in bcif.items():
        for _cat_name, category in block.items():
            columns = {}
            changed = False
            for col_name, column in category.items():
                array = column.data.array
                if column.mask is None and array.dtype.kind in "US":
                    mask = np.zeros(len(array), dtype=np.uint8)
                    for token, code in NULL_TOKENS.items():
                        mask[array == token] = code
                    if mask.any():
                        array = np.where(mask != 0, "", array)
                        columns[col_name] = pdbx.BinaryCIFColumn(
                            pdbx.BinaryCIFData(array), pdbx.BinaryCIFData(mask))
                        changed = True
                        repaired += 1
                        continue
                columns[col_name] = column
            if changed:
                block[_cat_name] = pdbx.BinaryCIFCategory(columns)

    if repaired:
        pdbx.compress(bcif).write(path)
    return repaired


def _design_files(run_dir, suffix):
    """Absolute paths under ``run_dir`` ending in ``suffix``, run root excluded.

    The run root holds the target structure, which stays text; everything below
    it is a design. The exclusion is structural rather than a list of names, so
    it cannot fall out of date. See the module docstring.
    """
    run_dir = os.path.normpath(run_dir)
    for dirpath, _dirnames, filenames in os.walk(run_dir):
        if os.path.normpath(dirpath) == run_dir:
            continue
        for name in sorted(filenames):
            if name.endswith(suffix):
                yield os.path.join(dirpath, name)


def design_cifs(run_dir):
    """Text design structures under ``run_dir``, waiting to be converted.

    ``.cif`` with the dot, which is what keeps this from also matching
    ``.bcif``: the suffix needs a literal dot before "cif" and a .bcif has a
    "b" there. The same distinction the nginx location relies on.
    """
    return _design_files(run_dir, ".cif")


def design_bcifs(run_dir):
    """Converted design structures under ``run_dir``."""
    return _design_files(run_dir, ".bcif")
