// Parses a document_pages.pageText value produced by
// apps/worker/src/spreadsheetText.ts (a "[Worksheet: <name>]" header line
// followed by tab-separated rows) back into structured cells, so a page can
// render an XLSX upload's tabular content without needing a Claude call.

export interface ParsedSheetPage {
  worksheetName: string | null;
  headers: string[];
  rows: string[][];
}

export function parseTabSeparatedPage(pageText: string | null): ParsedSheetPage | null {
  if (!pageText) return null;
  const lines = pageText.split("\n");

  const worksheetMatch = lines[0]?.match(/^\[Worksheet: (.*)\]$/);
  const start = worksheetMatch ? 1 : 0;
  const worksheetName = worksheetMatch ? worksheetMatch[1] : null;

  const dataLines = lines.slice(start).filter((l) => l.length > 0);
  if (dataLines.length < 2) return null;

  const headers = dataLines[0].split("\t");
  const rows = dataLines.slice(1).map((l) => l.split("\t"));
  return { worksheetName, headers, rows };
}

export function findColumnIndex(headers: string[], substr: string): number {
  const needle = substr.toLowerCase();
  return headers.findIndex((h) => h.toLowerCase().includes(needle));
}

// Every non-blank column NOT already captured by a named SheetItem field,
// kept in the sheet's own column order (not re-sorted) -- that order is
// already the source's own logical grouping (geometry params, then port/size
// params, then material/admin params), so it's preserved rather than
// alphabetized.
function extraAttributes(headers: string[], row: string[], usedIndices: Set<number>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  headers.forEach((header, i) => {
    if (usedIndices.has(i)) return;
    const value = row[i];
    if (value) out.push([header, value]);
  });
  return out;
}

// One row of an item-list-style catalogue export (SPREF / SPEC OF SPCO /
// GTYPE OF CATREF / Catalogue reference / detailing text / material text /
// Size P1-P3) -- the shape confirmed against a real company export. Column
// order is looked up by header name, not fixed index, so a re-ordered or
// re-named export doesn't silently misparse.
export interface SheetItem {
  reference: string;
  type: string;
  specCode: string;
  catalogueRef: string;
  description: string;
  material: string;
  sizeP1: string;
  sizeP2: string;
  sizeP3: string;
  // Every other non-blank column on this row that isn't one of the fields
  // above, in the sheet's own column order -- e.g. for a catalogue export,
  // EndType_S-ALL / FlangeStd_S-ALL / PressureClass_S-ALL / Manufacturer /
  // PartStatus etc., which the named fields above don't have room for.
  attributes: Array<[string, string]>;
}

// Admin item lists carry the real spec text across TWO separate columns --
// RTEXT/"detailing text" (description) and XTEXT/"material text" (material)
// -- neither of which alone is the full spec line (e.g. "PIPE BE EFW, 100%
// RT, ASME B36.10" vs "A672 GR C65, CL12, 100%RT NACE MR0175/ISO 15156, SCH
// 20"). Shared by every page that displays an admin item's own text (as
// opposed to the client spec row it matched against), so they can't drift
// apart on how that combination is formatted.
export function combineAdminText(item: SheetItem): string {
  const desc = item.description.trim();
  const material = item.material.trim();
  if (desc && material) return `${desc},${material}`;
  return desc || material || "(no description)";
}

export function extractSheetItems(pageText: string | null): SheetItem[] {
  const parsed = parseTabSeparatedPage(pageText);
  if (!parsed) return [];

  if (findColumnIndex(parsed.headers, "gtype") !== -1 && findColumnIndex(parsed.headers, "catalogue") !== -1) {
    return extractItemListShape(parsed);
  }
  if (findColumnIndex(parsed.headers, "itemcode") !== -1 && findColumnIndex(parsed.headers, "material") !== -1) {
    return extractCatalogueShape(parsed);
  }
  return []; // not a shape this parser recognizes
}

// Shape 1: a company item-list export -- SPREF / SPEC OF SPCO / GTYPE OF
// CATREF / Catalogue reference / detailing text / material text / Size
// P1-P3, one flat sheet listing every component of every type.
function extractItemListShape(parsed: ParsedSheetPage): SheetItem[] {
  const typeIdx = findColumnIndex(parsed.headers, "gtype");
  const catalogueIdx = findColumnIndex(parsed.headers, "catalogue");
  const refIdx = findColumnIndex(parsed.headers, "spref");
  const specIdx = findColumnIndex(parsed.headers, "spec of");
  const descIdx = findColumnIndex(parsed.headers, "detailing text");
  const materialIdx = findColumnIndex(parsed.headers, "material text");
  const p1Idx = findColumnIndex(parsed.headers, "size p1");
  const p2Idx = findColumnIndex(parsed.headers, "size p2");
  const p3Idx = findColumnIndex(parsed.headers, "size p3");
  const usedIndices = new Set([typeIdx, catalogueIdx, refIdx, specIdx, descIdx, materialIdx, p1Idx, p2Idx, p3Idx].filter((i) => i !== -1));

  const items: SheetItem[] = [];
  for (const row of parsed.rows) {
    const type = row[typeIdx] ?? "";
    if (!type) continue;
    items.push({
      reference: refIdx !== -1 ? row[refIdx] ?? "" : "",
      type,
      specCode: specIdx !== -1 ? row[specIdx] ?? "" : "",
      catalogueRef: row[catalogueIdx] ?? "",
      description: descIdx !== -1 ? row[descIdx] ?? "" : "",
      material: materialIdx !== -1 ? row[materialIdx] ?? "" : "",
      sizeP1: p1Idx !== -1 ? row[p1Idx] ?? "" : "",
      sizeP2: p2Idx !== -1 ? row[p2Idx] ?? "" : "",
      sizeP3: p3Idx !== -1 ? row[p3Idx] ?? "" : "",
      attributes: extraAttributes(parsed.headers, row, usedIndices),
    });
  }
  return items;
}

// Shape 2: an AVEVA/SmartPlant "PnP" piping component catalogue export --
// one worksheet per component type (the worksheet name IS the type, e.g.
// "BALL VALVE"), columns include ItemCode / Material / ShortDescription /
// NominalDiameter_S-ALL / CatalogPartId. This is a parts library, not a
// project piping material spec -- it has no class_code or size-range
// concept, so specCode is left blank.
function extractCatalogueShape(parsed: ParsedSheetPage): SheetItem[] {
  const itemCodeIdx = findColumnIndex(parsed.headers, "itemcode");
  // ItemCode is only populated on some rows (e.g. one "family" row) --
  // confirmed on a real sheet ("PIPE NIPPLE, LONG TYPE") where 9 of 10 real
  // size-variant rows had a blank ItemCode but a real "Sizes" value (the
  // per-size label column, e.g. `1/4"`, `1 1/2"`). Sizes is the reliable
  // per-row identifier for these parametric catalogue sheets, so it's used
  // both as the inclusion filter and as a fallback reference/size.
  const sizesIdx = findColumnIndex(parsed.headers, "sizes");
  const catalogIdx = findColumnIndex(parsed.headers, "catalogpartid");
  const materialIdx = findColumnIndex(parsed.headers, "material");
  const descIdx = findColumnIndex(parsed.headers, "shortdescription");
  const nominalIdx = findColumnIndex(parsed.headers, "nominaldiameter");
  const type = parsed.worksheetName ?? "UNKNOWN";
  const usedIndices = new Set([itemCodeIdx, sizesIdx, catalogIdx, materialIdx, descIdx, nominalIdx].filter((i) => i !== -1));

  const items: SheetItem[] = [];
  for (const row of parsed.rows) {
    const itemCode = itemCodeIdx !== -1 ? row[itemCodeIdx] ?? "" : "";
    const sizesLabel = sizesIdx !== -1 ? row[sizesIdx] ?? "" : "";
    if (!itemCode && !sizesLabel) continue; // no identifying data on this row at all
    items.push({
      reference: itemCode || sizesLabel,
      type,
      specCode: "",
      catalogueRef: catalogIdx !== -1 ? row[catalogIdx] ?? "" : "",
      description: descIdx !== -1 ? row[descIdx] ?? "" : "",
      material: materialIdx !== -1 ? row[materialIdx] ?? "" : "",
      sizeP1: (nominalIdx !== -1 ? row[nominalIdx] : "") || sizesLabel,
      sizeP2: "",
      sizeP3: "",
      attributes: extraAttributes(parsed.headers, row, usedIndices),
    });
  }
  return items;
}
