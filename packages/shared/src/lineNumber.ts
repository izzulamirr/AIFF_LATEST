// Decodes the segment convention used in piping line numbers / ISO file
// names, e.g. "350-HV-1S3F-A100-HC-NT":
//   350   size (mm)
//   HV    service / fluid code
//   1S3F  piping class
//   A100  unique number
//   HC    insulation code
//   NT    heat trace (NT = no trace, ET = electric trace)
// Only applies when the first segment is purely numeric (a size in mm) --
// other conventions (e.g. C344's "12PGL03-2\"-150JY11-C25", which leads
// with unit+fluid+sequence) don't fit this pattern and return null rather
// than a wrong guess.

export interface DecodedLineNumber {
  size: string; // with unit, e.g. "350 mm"
  sizeMm: number;
  service: string;
  spec_class: string;
  unique_no: string;
  insulation_code?: string;
  heat_trace?: string;
}

export function decodeLineNumber(lineNumber: string): DecodedLineNumber | null {
  const segments = lineNumber
    .trim()
    .split("-")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length < 4) return null;
  if (!/^\d+$/.test(segments[0])) return null;
  const [size, service, specClass, uniqueNo, insulation, heatTrace] = segments;
  return {
    size: `${size} mm`,
    sizeMm: Number(size),
    service,
    spec_class: specClass,
    unique_no: uniqueNo,
    insulation_code: insulation,
    heat_trace: heatTrace,
  };
}

// Placeholder-aware blank check: unfilled title-block cells are often
// printed as "XX.XX" / "XX" on issued-for-review drawings -- those are
// no-data markers, not values.
function blankish(value: unknown): boolean {
  if (value == null) return true;
  const s = String(value).trim();
  if (!s) return true;
  const up = s.toUpperCase();
  if (["NA", "N/A", "NIL", "NIL.", "-"].includes(up)) return true;
  const firstToken = up.split(/\s+/)[0];
  return /^X+([.,]X+)?$/.test(firstToken);
}

// Fills ISO line attributes from the decoded line number wherever the title
// block left them blank (or placeholder), and normalizes a bare numeric
// size to "N mm" when it agrees with the decoded size. Title-block values
// that conflict with the decode are left alone -- gate 1's decode check
// flags those instead of silently overwriting.
export function enrichIsoLineAttrs(lineNumber: string, attrs: Record<string, unknown>): Record<string, unknown> {
  const decoded = decodeLineNumber(lineNumber);
  if (!decoded) return attrs;
  const out: Record<string, unknown> = { ...attrs };

  const size = out.size == null ? "" : String(out.size).trim();
  if (blankish(size)) out.size = decoded.size;
  else if (/^\d+(\.\d+)?$/.test(size) && Number(size) === decoded.sizeMm) out.size = `${size} mm`;

  for (const key of ["service", "spec_class", "unique_no", "heat_trace"] as const) {
    if (blankish(out[key]) && decoded[key] != null) out[key] = decoded[key];
  }
  // The ISO title block's insulation field is stored as insul_spec (its
  // "INSUL/SPEC" column), which is what the PLL's insulation_code compares
  // against.
  if (blankish(out.insul_spec) && decoded.insulation_code != null) out.insul_spec = decoded.insulation_code;
  return out;
}
