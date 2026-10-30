"""Reading facts back out of a run's target structure.

A design target's CIF carries more than coordinates. BoltzGen reuses
`B_iso_or_equiv` to record the binding spec it was given -- which residues are
the epitope, and which are artefacts of cropping the target out of a full
AlphaFold model -- and `_entity_poly` carries the target sequence.

This module is the one place that knows those encodings. It has no Django
dependency so that importers, management commands, the API and tests can all
use it without differing about what a B-factor of 80 means.

The classification here is the same one
binder_frontend/src/utils/hotspotBfactor.ts applies when it paints the
structure yellow, grey and purple. If the two ever disagree, the viewer and
the database describe different epitopes for the same run.
"""
import re

#: Lower bound of the masked band.
#:
#: Two producers write the B-factor column. Campaign targets carry
#: ``binding_type_id * 80`` from BoltzGen's spec parser (UNSPECIFIED=0,
#: BINDING=1, NOT_BINDING=2), so an epitope residue reads 80 and a masked one
#: 160. Structure Prep targets carry ``hotspot_score * 100`` with the score in
#: [0, 1], so they top out at exactly 100 and never reach the masked band.
#: 120 separates the two cleanly and cannot reclassify anything prepared before
#: the campaign existed.
MASKED_B_MIN = 120.0

HOTSPOT = "hotspot"
MASKED = "masked"
UNCONSTRAINED = "unconstrained"


def classify_b(b):
    """One B-factor value -> HOTSPOT, MASKED or UNCONSTRAINED.

    Masked residues sit on the faces created by cropping, so they are not real
    protein surface and a design that binds one has bound an artefact. Telling
    them from genuine hotspots is why this is three states and not two: a
    ``> 0`` test calls both hotspots and paints the rim of the structure as
    though it were the epitope.
    """
    if not isinstance(b, (int, float)) or b != b or b <= 0:  # NaN fails b != b
        return UNCONSTRAINED
    return MASKED if b >= MASKED_B_MIN else HOTSPOT


def residue_b_factors(path):
    """Read a CIF's atom_site loop -> ``{auth_seq_id: b}``, one value per residue.

    Prefers the CA atom and otherwise keeps the largest B in the residue. The
    two agree on every file seen so far, because BoltzGen writes one value to
    every atom of a residue, but a residue with no CA would otherwise vanish
    from the map and silently shrink the epitope.

    Columns are read by their position within the declared loop rather than
    from a fixed layout, since the column order is not guaranteed.
    """
    columns = []
    in_loop = False
    out = {}
    with open(path) as handle:
        for line in handle:
            stripped = line.strip()
            if stripped.startswith("_atom_site."):
                columns.append(stripped.split(".", 1)[1])
                in_loop = True
                continue
            if not in_loop:
                continue
            if stripped.startswith(("_", "loop_", "#")) or not stripped:
                # End of the atom_site loop. Anything past it belongs to a
                # different category, so stop rather than mis-parse it.
                if out:
                    break
                continue
            fields = stripped.split()
            if len(fields) < len(columns) or fields[0] not in ("ATOM", "HETATM"):
                continue
            record = dict(zip(columns, fields))
            try:
                resi = int(record["auth_seq_id"])
                b = float(record["B_iso_or_equiv"])
            except (KeyError, ValueError):
                continue
            if record.get("label_atom_id") == "CA" or resi not in out:
                out[resi] = b
            else:
                out[resi] = max(out[resi], b)
    return out


def constraints_from_cif(path):
    """-> ``{"hotspot": [...], "masked": [...], "total": n}`` of residue numbers."""
    b_values = residue_b_factors(path)
    groups = {HOTSPOT: [], MASKED: [], UNCONSTRAINED: []}
    for resi, b in b_values.items():
        groups[classify_b(b)].append(resi)
    return {
        HOTSPOT: sorted(groups[HOTSPOT]),
        MASKED: sorted(groups[MASKED]),
        "total": len(b_values),
    }


def to_ranges(numbers):
    """``[1, 2, 3, 7]`` -> ``"1..3,7"``.

    The range syntax ``select_patch.py`` writes and the run page's
    ``parseEpitope`` reads: ``..`` between the ends of a run, ``,`` between
    segments, a bare number for a singleton.
    """
    numbers = sorted(set(numbers))
    parts = []
    i = 0
    while i < len(numbers):
        j = i
        while j + 1 < len(numbers) and numbers[j + 1] == numbers[j] + 1:
            j += 1
        parts.append(str(numbers[i]) if i == j else f"{numbers[i]}..{numbers[j]}")
        i = j + 1
    return ",".join(parts)


# ``..`` is the current syntax; a bare hyphen and an en dash are what runs
# predating select_patch.py used, and both still sit in the database.
_RANGE_RE = re.compile(r"^\s*(\d+)\s*(?:(?:\.\.|[-–])\s*(\d+)\s*)?$")


def parse_ranges(text):
    """``"1..3,7"`` -> ``[1, 2, 3, 7]``. The inverse of :func:`to_ranges`.

    Mirrors the frontend's ``parseEpitope``: unparseable segments are skipped
    rather than raising, because this runs over free-form metadata written by
    whatever importer produced the run, and one bad segment should not cost
    the rest of the epitope.
    """
    if not text:
        return []
    out = []
    for part in str(text).split(","):
        match = _RANGE_RE.match(part)
        if not match:
            continue
        lo = int(match.group(1))
        hi = lo if match.group(2) is None else int(match.group(2))
        if lo > hi:
            lo, hi = hi, lo
        out.extend(range(lo, hi + 1))
    return sorted(set(out))


def sequence_from_cif(path):
    """Extract the target sequence from a CIF's ``_entity_poly`` section.

    Moved verbatim out of the import_run command, which needs it and is no
    longer the only caller. Handles the three shapes the field appears in:
    a semicolon-delimited block, a single-line value, and a loop column.
    """
    try:
        with open(path) as handle:
            text = handle.read()
    except OSError:
        return None

    for key in [
        "_entity_poly.pdbx_seq_one_letter_code_can",
        "_entity_poly.pdbx_seq_one_letter_code",
    ]:
        # Semicolon-delimited multi-line value (non-loop format)
        m = re.search(re.escape(key) + r"\s*\n;([\s\S]*?)\n;", text, re.IGNORECASE)
        if m:
            seq = re.sub(r"\s+", "", m.group(1)).upper()
            if seq:
                return seq

        # Single-line key-value (non-loop format) -- [ \t]+ so it cannot cross
        # a newline into the next record.
        m = re.search(r"^" + re.escape(key) + r"[ \t]+(\S+)", text,
                      re.IGNORECASE | re.MULTILINE)
        if m and m.group(1) not in (".", "?") and not m.group(1).startswith("_"):
            seq = m.group(1).strip("'\"").upper()
            if seq:
                return seq

        # Loop format: the key appears as a column definition line.
        lines = text.split("\n")
        key_lower = key.lower()
        for key_idx, line in enumerate(lines):
            if line.strip().lower() != key_lower:
                continue
            # Count preceding consecutive _field lines for the column index.
            col_idx = 0
            back = key_idx - 1
            while back >= 0 and lines[back].strip().startswith("_"):
                col_idx += 1
                back -= 1
            data_idx = key_idx + 1
            while data_idx < len(lines) and lines[data_idx].strip().startswith("_"):
                data_idx += 1
            while data_idx < len(lines) and not lines[data_idx].strip():
                data_idx += 1
            if data_idx >= len(lines):
                continue
            tokens = lines[data_idx].strip().split()
            if col_idx < len(tokens):
                seq = tokens[col_idx].upper()
                if seq and seq not in (".", "?"):
                    return seq

    return None

