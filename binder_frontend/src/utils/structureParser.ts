import type { ParsedResidue, ParsedStructure } from "../types";

// Secondary structure range from HELIX/SHEET/struct_conf records
interface SecStructRange {
  chainId: string;
  startResNum: number;
  endResNum: number;
  type: "H" | "E";
}

function detectFormat(text: string): "mmcif" | "pdb" {
  const firstLine = text.trimStart().slice(0, 80);
  if (firstLine.startsWith("data_")) return "mmcif";
  if (/^(ATOM|HETATM|HEADER|REMARK|MODEL|SEQRES|CRYST)/.test(firstLine)) return "pdb";
  // Scan first few lines
  for (const line of text.split("\n").slice(0, 20)) {
    const t = line.trim();
    if (t.startsWith("data_")) return "mmcif";
    if (/^(ATOM|HETATM|HEADER)/.test(t)) return "pdb";
  }
  throw new Error("Cannot detect file format. Expected a .cif or .pdb file.");
}

// ── mmCIF parser ─────────────────────────────────────────────────────────────

function detectAlphaFoldMmcif(text: string): boolean {
  return /(_ma_target_ref_db_details|AF-[A-Z0-9]+-F\d+|alphafold)/i.test(text.slice(0, 3000));
}

function parseMmcif(text: string): ParsedStructure {
  const secRanges = parseMmcifSecStruct(text);
  const residues = parseMmcifAtomSite(text, secRanges);
  const chains = [...new Set(residues.map((r) => r.chainId))];
  return { format: "mmcif", chains, residues, isAlphaFold: detectAlphaFoldMmcif(text) };
}

function parseMmcifSecStruct(text: string): SecStructRange[] {
  const ranges: SecStructRange[] = [];
  // Find _struct_conf loop
  const confMatch = text.match(
    /loop_\s+((?:_struct_conf\.\S+\s+)+)([\s\S]+?)(?=loop_|^#|\Z)/m
  );
  if (!confMatch) return ranges;

  const fieldBlock = confMatch[1];
  const dataBlock = confMatch[2];
  const fields = [...fieldBlock.matchAll(/_struct_conf\.(\S+)/g)].map((m) =>
    m[1].toLowerCase()
  );
  const typeIdx = fields.indexOf("conf_type_id");
  const chainStartIdx = fields.indexOf("beg_auth_asym_id");
  const resStartIdx = fields.indexOf("beg_auth_seq_id");
  const chainEndIdx = fields.indexOf("end_auth_asym_id");
  const resEndIdx = fields.indexOf("end_auth_seq_id");

  if (typeIdx < 0 || resStartIdx < 0 || resEndIdx < 0) return ranges;

  const rows = tokenizeMmcifLoop(dataBlock, fields.length);
  for (const row of rows) {
    const rawType = row[typeIdx];
    const type: "H" | "E" | null =
      rawType.startsWith("HELX") ? "H" : rawType.startsWith("STRND") ? "E" : null;
    if (!type) continue;
    const chainId = chainStartIdx >= 0 ? row[chainStartIdx] : row[chainEndIdx] ?? "A";
    const startRes = parseInt(row[resStartIdx], 10);
    const endRes = parseInt(row[resEndIdx], 10);
    if (!isNaN(startRes) && !isNaN(endRes))
      ranges.push({ chainId, startResNum: startRes, endResNum: endRes, type });
  }
  return ranges;
}

function parseMmcifAtomSite(
  text: string,
  secRanges: SecStructRange[]
): ParsedResidue[] {
  // Find _atom_site loop
  const loopMatch = text.match(
    /loop_\s+((?:_atom_site\.\S+\s+)+)([\s\S]+?)(?=\nloop_|\n#|\ndata_|$)/
  );
  if (!loopMatch) throw new Error("No _atom_site loop found in mmCIF file.");

  const fieldBlock = loopMatch[1];
  const dataBlock = loopMatch[2];
  const fields = [...fieldBlock.matchAll(/_atom_site\.(\S+)/g)].map((m) =>
    m[1].toLowerCase()
  );

  const idx = (name: string) => fields.indexOf(name);
  const groupIdx = idx("group_pdb");
  const atomIdx = idx("label_atom_id");
  const resNameIdx = idx("label_comp_id");
  const chainIdx = idx("auth_asym_id") >= 0 ? idx("auth_asym_id") : idx("label_asym_id");
  const resNumIdx = idx("auth_seq_id") >= 0 ? idx("auth_seq_id") : idx("label_seq_id");
  const insCodeIdx = idx("pdbx_pdb_ins_code");
  const xIdx = idx("cartn_x");
  const yIdx = idx("cartn_y");
  const zIdx = idx("cartn_z");
  const bIdx = idx("b_iso_or_equiv");
  const modelIdx = idx("pdbx_pdb_model_num");

  if (resNameIdx < 0 || chainIdx < 0 || resNumIdx < 0 || xIdx < 0 || bIdx < 0)
    throw new Error("Required _atom_site fields missing from mmCIF.");

  const rows = tokenizeMmcifLoop(dataBlock, fields.length);
  const seen = new Set<string>();
  const residues: ParsedResidue[] = [];

  for (const row of rows) {
    // Only model 1 for multi-model structures
    if (modelIdx >= 0 && row[modelIdx] !== "1" && row[modelIdx] !== ".") continue;
    // Only ATOM records (skip HETATM)
    if (groupIdx >= 0 && row[groupIdx] !== "ATOM") continue;
    // Only CA atoms
    if (atomIdx >= 0 && row[atomIdx] !== "CA") continue;

    const chainId = row[chainIdx] ?? "A";
    const rawResNum = row[resNumIdx] ?? "0";
    const resNum = parseInt(rawResNum, 10);
    if (isNaN(resNum)) continue;
    const insCode = insCodeIdx >= 0 && row[insCodeIdx] !== "." ? row[insCodeIdx] : "";
    const key = `${chainId}:${resNum}:${insCode}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const resName = (row[resNameIdx] ?? "UNK").toUpperCase();
    const x = parseFloat(row[xIdx] ?? "0");
    const y = parseFloat(row[yIdx] ?? "0");
    const z = parseFloat(row[zIdx] ?? "0");
    const bFactor = parseFloat(row[bIdx] ?? "0");

    residues.push({
      chainId,
      resNum,
      insertionCode: insCode,
      resName,
      x,
      y,
      z,
      bFactor: isNaN(bFactor) ? 0 : bFactor,
      secStruct: getSecStruct(chainId, resNum, secRanges),
    });
  }
  return residues;
}

// Tokenize a mmCIF loop data block into rows of `nFields` tokens each.
// Handles quoted strings, semicolon multi-line values, and whitespace-delimited tokens.
function tokenizeMmcifLoop(data: string, nFields: number): string[][] {
  const tokens: string[] = [];
  let i = 0;
  while (i < data.length) {
    // skip whitespace
    while (i < data.length && /\s/.test(data[i])) i++;
    if (i >= data.length) break;

    // Multi-line value: starts with \n;
    if (data[i] === ";") {
      const end = data.indexOf("\n;", i + 1);
      tokens.push(end < 0 ? data.slice(i + 1) : data.slice(i + 1, end).trim());
      i = end < 0 ? data.length : end + 2;
      continue;
    }
    // Quoted string
    if (data[i] === '"' || data[i] === "'") {
      const q = data[i];
      const start = i + 1;
      i++;
      while (i < data.length && data[i] !== q) i++;
      tokens.push(data.slice(start, i));
      i++;
      continue;
    }
    // Regular token — ends at whitespace
    const start = i;
    while (i < data.length && !/\s/.test(data[i])) i++;
    const tok = data.slice(start, i);
    // Stop at loop_ or # (end of this loop's data)
    if (tok === "loop_" || tok === "#") break;
    tokens.push(tok);
  }

  const rows: string[][] = [];
  for (let j = 0; j < tokens.length; j += nFields) {
    rows.push(tokens.slice(j, j + nFields));
  }
  return rows;
}

// ── PDB parser ───────────────────────────────────────────────────────────────

function parsePdb(text: string): ParsedStructure {
  const lines = text.split("\n");
  const secRanges = parsePdbSecStruct(lines);
  const residues = parsePdbAtoms(lines, secRanges);
  const chains = [...new Set(residues.map((r) => r.chainId))];
  const isAlphaFold = lines.some((l) => /^(TITLE|REMARK)\s.*alphafold/i.test(l));
  return { format: "pdb", chains, residues, isAlphaFold };
}

function parsePdbSecStruct(lines: string[]): SecStructRange[] {
  const ranges: SecStructRange[] = [];
  for (const line of lines) {
    if (line.startsWith("HELIX")) {
      const chainId = line[19]?.trim() || "A";
      const start = parseInt(line.slice(21, 25).trim(), 10);
      const end = parseInt(line.slice(33, 37).trim(), 10);
      if (!isNaN(start) && !isNaN(end))
        ranges.push({ chainId, startResNum: start, endResNum: end, type: "H" });
    } else if (line.startsWith("SHEET")) {
      const chainId = line[21]?.trim() || "A";
      const start = parseInt(line.slice(22, 26).trim(), 10);
      const end = parseInt(line.slice(33, 37).trim(), 10);
      if (!isNaN(start) && !isNaN(end))
        ranges.push({ chainId, startResNum: start, endResNum: end, type: "E" });
    }
  }
  return ranges;
}

function parsePdbAtoms(lines: string[], secRanges: SecStructRange[]): ParsedResidue[] {
  const seen = new Set<string>();
  const residues: ParsedResidue[] = [];
  let currentModel = 1;

  for (const line of lines) {
    if (line.startsWith("MODEL")) {
      currentModel = parseInt(line.slice(6).trim(), 10) || 1;
      if (currentModel > 1) break; // only model 1
    }
    if (!line.startsWith("ATOM  ") && !line.startsWith("ATOM ")) continue;

    const atomName = line.slice(12, 16).trim();
    if (atomName !== "CA") continue;

    const resName = line.slice(17, 20).trim().toUpperCase();
    const chainId = line[21]?.trim() || "A";
    const resNum = parseInt(line.slice(22, 26).trim(), 10);
    if (isNaN(resNum)) continue;
    const insCode = line[26]?.trim() ?? "";
    const key = `${chainId}:${resNum}:${insCode}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const x = parseFloat(line.slice(30, 38).trim());
    const y = parseFloat(line.slice(38, 46).trim());
    const z = parseFloat(line.slice(46, 54).trim());
    const bFactor = parseFloat(line.slice(60, 66).trim());

    residues.push({
      chainId,
      resNum,
      insertionCode: insCode,
      resName,
      x: isNaN(x) ? 0 : x,
      y: isNaN(y) ? 0 : y,
      z: isNaN(z) ? 0 : z,
      bFactor: isNaN(bFactor) ? 0 : bFactor,
      secStruct: getSecStruct(chainId, resNum, secRanges),
    });
  }
  return residues;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function getSecStruct(
  chainId: string,
  resNum: number,
  ranges: SecStructRange[]
): "H" | "E" | "C" {
  for (const r of ranges) {
    if (r.chainId === chainId && resNum >= r.startResNum && resNum <= r.endResNum)
      return r.type;
  }
  return "C";
}

// ── Public API ────────────────────────────────────────────────────────────────

export function parseStructure(text: string, hintFormat?: "mmcif" | "pdb"): ParsedStructure {
  const fmt = hintFormat ?? detectFormat(text);
  if (fmt === "mmcif") return parseMmcif(text);
  return parsePdb(text);
}

export function detectStructureFormat(filename: string): "mmcif" | "pdb" | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".cif") || lower.endsWith(".mmcif")) return "mmcif";
  if (lower.endsWith(".pdb")) return "pdb";
  return null;
}
