import type { SheetItem } from "./parseSheetPage";
import { parseNpsInches } from "@easy/shared";

// Re-exported so existing importers (e.g. the document page's display sort)
// don't need to know this now lives in the shared package -- apps/worker's
// branch-table resolution uses the same function directly from @easy/shared.
export { parseNpsInches };

// Cross-checks a company Excel item-list row (see parseSheetPage.ts)
// against a client spec_sheet document's extracted class detail
// (extracted_tags rows with tagType "spec_class", attributes shaped by
// SPEC_CLASS_DETAIL_TOOL: pipes/fittings/flanges/valves arrays keyed by
// size_min/size_max/material/...).
//
// The verdict is driven ENTIRELY by structured fields -- component type
// (Excel's GTYPE) and size (Size P1/P2, converted DN mm -> NPS inches) --
// never by comparing the Excel row's own Material/Description text against
// the client spec's. The admin's item list is built FROM the client PDF in
// the first place, so the real question this answers is "does this admin
// row correspond to a requirement that actually exists in the client
// spec's list," not "does the admin's free-text wording resemble the
// client's free-text wording." That text comparison was tried first and
// repeatedly produced false failures that had nothing to do with an actual
// spec discrepancy -- a blank Material cell (the admin's own export
// convention, not a real gap), a Description field that names the
// component and standard but never the grade, a valve's terminology
// differing in wording while meaning the same thing. None of that reflects
// whether the item is really in the client's list. The client's own
// descriptive text/size are still looked up and returned on every result
// (see CrossCheckResult.clientDescription/clientSize) purely for
// side-by-side display, so a human can still eyeball it -- the app just no
// longer bases Match/Review/Wrong-spec on that comparison.

export type CrossCheckStatus = "match" | "mismatch" | "not_found" | "class_not_found" | "size_unrecognized" | "out_of_scope" | "no_client_data";

export interface CrossCheckResult {
  status: CrossCheckStatus;
  label: string;
  note: string | null;
  // The client spec's own matched row, as descriptive text -- for a
  // side-by-side display next to the Excel row's own Description/Material
  // columns. Named "description" rather than "material" because a client
  // fitting/flange row's `material` field is usually a full combined string
  // (grade + construction + governing standard, e.g. "A234 GR WPB, SMLS, BW
  // ASME B16.9") -- content-wise closer to what the admin's own Description
  // column holds than to the admin's narrower Material column (just grade +
  // schedule). Prefers the class detail's own `description` field when the
  // source page actually prints one separately (see specSheet.ts's prompt),
  // falling back to `material` when it doesn't -- which is the common case.
  // Populated whenever a specific client row (or Branch Table cell) was
  // actually found and compared against. Left null when there was nothing
  // to compare against at all (out of scope, class not found, no client
  // data, wrong spec).
  clientDescription?: string | null;
  clientSize?: string | null;
}

// A row's size as one display string -- "8" when min===max (a single
// column, or an extraction that duplicated a combined label into both
// fields), "8–24" otherwise, "-" when neither is set (e.g. a Gasket/Stud
// Bolt row that isn't size-indexed at all). Exported so both the class
// detail tables and the cross-check's side-by-side "Client Size" column
// render a client spec row's size identically.
export function sizeRangeLabel(row: Record<string, unknown>): string {
  const min = row.size_min;
  const max = row.size_max;
  if (min != null && max != null) return min === max ? String(min) : `${min}–${max}`;
  if (min != null || max != null) return String(min ?? max);
  return "-";
}

// A client spec PDF's own class-code label can print a trailing "1" that
// isn't part of the actual class name -- confirmed on this project's AC03N
// spec: the PDF's title block reads "AC03N1", but every admin item-list row
// (and direct confirmation) agrees the real class is "AC03N", no trailing
// digit. Only strips it from that exact shape (letters, then digits, then a
// single trailing letter, then a lone "1") so a code that's supposed to end
// in a digit (there aren't any in this project, but nothing here should
// assume that stays true) is never touched.
export function normalizeSpecClassCode(raw: string): string {
  const code = raw.trim().toUpperCase();
  const spurious = /^([A-Z]+\d+[A-Z])1$/.exec(code);
  return spurious ? spurious[1] : code;
}

// Nominal pipe size (DN, mm) -> NPS (inches) per ASME B36.10/B16 standard
// designations. This is a lookup, not a unit conversion -- DN50 is
// nominally 2", not 50/25.4=1.97" -- so non-standard sizes must fail the
// lookup rather than be computed.
// Exported (not just the lookup functions below) so the UI can render this
// table itself as a plain NPS<->DN reference legend, using the exact same
// canonical mapping every size comparison in this app already goes through.
export const DN_TO_NPS_INCHES: Record<number, number> = {
  6: 0.125, 8: 0.25, 10: 0.375, // 1/8", 1/4", 3/8" -- below the 1/2" this table previously started at
  15: 0.5, 20: 0.75, 25: 1, 32: 1.25, 40: 1.5, 50: 2, 65: 2.5, 80: 3, 90: 3.5, 100: 4,
  115: 4.5, // 4 1/2" -- was missing entirely, not just an extension of the small-bore range
  125: 5, 150: 6, 200: 8, 250: 10, 300: 12, 350: 14, 400: 16, 450: 18, 500: 20, 550: 22,
  600: 24, 650: 26, 700: 28, 750: 30, 800: 32, 850: 34, 900: 36, 950: 38, 1000: 40,
  1050: 42, 1100: 44, 1150: 46, 1200: 48,
};

// Exported so the item list's mm/inch size toggle can convert an admin
// Excel row's Size P1-P3 (DN, mm) the same way crossCheckItem itself does --
// same lookup-not-arithmetic reasoning as the module comment above.
export function dnToNpsInches(mmValue: string): number | null {
  const mm = Number(mmValue);
  if (!Number.isFinite(mm)) return null;
  return DN_TO_NPS_INCHES[Math.round(mm)] ?? null;
}

// The reverse direction, for display: a decimal NPS value (e.g. 1.5) back
// into this project's own fraction notation (e.g. "1 1/2", matching how
// parseNpsInches reads it and how every other size cell in this app already
// shows it). Standard NPS sizes are always eighths or simpler, so reducing
// to eighths and simplifying the fraction covers every size this table's
// own DN_TO_NPS_INCHES lookup can produce.
export function formatNpsInches(value: number): string {
  const whole = Math.floor(value + 1e-9);
  const eighths = Math.round((value - whole) * 8);
  if (eighths === 0) return String(whole);
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(eighths, 8);
  const fraction = `${eighths / divisor}/${8 / divisor}`;
  return whole > 0 ? `${whole} ${fraction}` : fraction;
}

export type SpecCategory = "pipes" | "fittings" | "flanges" | "valves";

export interface CategoryHint {
  category: SpecCategory;
  typeHint?: string; // matched case-insensitively against fitting_type/flange_type/valve_type
  // A substring that, if present in the row's own type label, DISQUALIFIES
  // an otherwise-matching typeHint -- needed because this domain's naming
  // genuinely overlaps two DIFFERENT real components. Confirmed on a real
  // document: a "Tee (Reduced)" row is a TEE (a reducing tee), not a
  // Reducer, but "Reduced" and "Reducer" share the stem "reduc", so the
  // Reducer admin type's own typeHint ("reduc") wrongly pulled every Tee
  // (Reduced) admin line into the Tee row's admin matches too. Same root
  // cause affects "flange" matching inside "Blind flange"/"Orifice
  // Flanges", and "blind" matching inside "Spectacle blind" (a distinct
  // component from a blind flange) -- see CATEGORY_BY_GTYPE below.
  excludeHints?: string[];
  // Some admin GTYPE codes are shared across MULTIPLE distinct client row
  // types, distinguished only by a keyword in the admin item's OWN
  // description/material text, not by a separate GTYPE -- confirmed on a
  // real document: GTYPE "FLAN" covers both a plain Flange (nothing
  // distinguishing) and an Orifice Flange ("FLANGE ORIFICE WN..."), and
  // GTYPE "PCOM" covers both a Spectacle blind ("SPECTACLE BLIND...") and a
  // Spade & Spacer ("SPADE & SPACER..."). Without this, an item like
  // "FLANGE ORIFICE WN 300# RF" either wrongly matches the plain Flange row
  // (if excludeHints doesn't rule it out) or matches NOTHING at all (once
  // excludeHints correctly rules out the plain Flange row, since there was
  // never a positive path TO the Orifice Flanges row to begin with) --
  // checked in order, the first entry whose `contains` appears in the item's
  // own text overrides this hint's typeHint/excludeHints for that one item;
  // an item matching none of them keeps this hint's own defaults unchanged.
  subHints?: Array<{ contains: string; typeHint: string; excludeHints?: string[] }>;
  // Tees and O'lets are branch connections -- the correct material for one
  // depends on BOTH the run size (Excel's Size P1) and the branch size
  // (Size P2), not size alone. A class's fittings table only stores one
  // coarse size range per fitting family, which can't tell a 24"x2" weldolet
  // from a 24"x10" one apart -- only the class's own resolved Branch Table
  // (see specSheet.ts's resolveBranchTable) can. Flagged here so
  // crossCheckItem knows to check the exact (header, branch) cell for these
  // types instead of (or before falling back to) the generic size-range check.
  branchGoverned?: boolean;
  // Some admin GTYPEs carry no usable size at all -- confirmed on a real
  // export where every Stud Bolt row's own Size column is blank (unlike
  // Gasket, whose Size column genuinely holds the flange size it fits,
  // e.g. "400" for a 16" flange's gasket). Requiring a parsed size for
  // those would silently drop every one of them the same way treating the
  // whole GTYPE as out-of-scope did before -- with this set, an item with
  // no parseable size still matches by type(+class), just without size
  // narrowing, rather than being invisible.
  sizeOptional?: boolean;
}

// True when a client row's own type label both matches the hint's required
// keyword AND avoids every one of its exclusions -- factored out so
// crossCheckItem and groupAdminItemsByClassRow can never drift into
// checking typeHint without also checking excludeHints (see CategoryHint's
// own comment for why skipping the exclusion check silently re-admits a
// cross-type false match).
export function rowMatchesTypeHint(row: Record<string, unknown>, hint: CategoryHint): boolean {
  if (!hint.typeHint) return true;
  const label = rowTypeLabel(row).toLowerCase();
  if (!label.includes(hint.typeHint)) return false;
  return !hint.excludeHints?.some((ex) => label.includes(ex));
}

// Resolves a GTYPE's static hint down to the SPECIFIC sub-type an individual
// admin item actually names in its own text (see CategoryHint.subHints) --
// e.g. an admin item whose description says "FLANGE ORIFICE WN..." resolves
// FLAN's default typeHint "flange" to "orifice" instead, for just that item.
// An item matching no sub-hint keeps the GTYPE's own defaults unchanged.
// Picks whichever keyword appears EARLIEST IN THE TEXT, not earliest in the
// subHints array -- confirmed on a real document where a genuine Check valve
// is described as "CHECK VALVE, BALL LIFT TYPE..." (a check valve whose
// internal mechanism is a ball lift). That text contains BOTH "check" and
// "ball", and array-order .find() always picked VALV's "ball" sub-hint
// (listed before "check"), silently misrouting every small Check valve
// admin line onto the client's Ball row instead. A real component's own
// type name is always the LEADING noun of its description ("CHECK VALVE...",
// "BALL VALVE..."), with any secondary mechanism/trim wording following it,
// so earliest-in-text is the correct tiebreak, not declaration order.
function resolveHint(item: SheetItem, hint: CategoryHint): CategoryHint {
  if (!hint.subHints) return hint;
  const text = `${item.description} ${item.material}`.toLowerCase();
  let sub: NonNullable<CategoryHint["subHints"]>[number] | undefined;
  let bestIndex = Infinity;
  for (const candidate of hint.subHints) {
    const index = text.indexOf(candidate.contains);
    if (index !== -1 && index < bestIndex) {
      bestIndex = index;
      sub = candidate;
    }
  }
  return sub ? { category: hint.category, typeHint: sub.typeHint, excludeHints: sub.excludeHints, branchGoverned: hint.branchGoverned, sizeOptional: hint.sizeOptional } : hint;
}

// Which client-spec bucket (and, for fittings/flanges, which type keyword)
// each Excel component-type code should be checked against -- see the
// piping-scope discussion this table encodes: several Excel types are
// legitimately governed by other project documents, not this spec.
const CATEGORY_BY_GTYPE: Record<string, CategoryHint | null> = {
  TUBE: { category: "pipes" },
  ELBO: { category: "fittings", typeHint: "elbow" },
  TEE: {
    category: "fittings",
    typeHint: "tee",
    branchGoverned: true,
    // "reduced" (not "reduc") for the same reason REDU below uses "reducer"
    // -- "reduced" is NOT a substring of "reducer", so this sub-hint still
    // can't leak into a "Reducer (Concentric/Eccentric)" row even though
    // both ultimately share the "reduc" stem. Confirmed on a real document:
    // without this, an admin line's own "EQUAL TEE"/"REDUCING TEE" wording
    // was never checked, so every Tee admin line (straight or reducing)
    // landed under BOTH the Tee (Straight) and Tee (Reduced) client rows.
    subHints: [
      { contains: "reducing", typeHint: "reduced" },
      { contains: "equal", typeHint: "straight" },
    ],
  },
  // "reducer", not "reduc" -- "reduc" alone also matches "Tee (Reduced)"'s
  // own label (see CategoryHint's comment).
  REDU: { category: "fittings", typeHint: "reducer" },
  // "olet", not the bare "let" -- still matches "O'let (Weldolet)" (via
  // "Weldolet"), just narrower than a 3-letter substring needs to be.
  OLET: { category: "fittings", typeHint: "olet", branchGoverned: true }, // "o'let" / "weldolet" / "sockolet"
  CAP: { category: "fittings", typeHint: "cap" },
  FLAN: {
    category: "flanges",
    typeHint: "flange",
    excludeHints: ["blind", "orifice"],
    subHints: [{ contains: "orifice", typeHint: "orifice" }],
  },
  FBLI: { category: "flanges", typeHint: "blind", excludeHints: ["spectacle"] },
  PCOM: {
    category: "flanges",
    typeHint: "spectacle",
    subHints: [
      { contains: "spade", typeHint: "spade" },
      { contains: "spacer", typeHint: "spade" },
    ],
  },
  // Every admin valve line shares the SAME GTYPE "VALV" regardless of body
  // type -- confirmed on a real document where this had no typeHint at all,
  // so a "Ball" client row's admin matches showed every valve type at once
  // (gate/globe/ball/check/butterfly all mixed together, 28 lines under one
  // row). Sub-routed by the admin item's own description text, the same
  // way FLAN/PCOM route Orifice/Spade & Spacer -- the client's own
  // valve_type values confirmed on a real class ("Gate", "Globe", "Ball",
  // "Check", "Butterfly").
  VALV: {
    category: "valves",
    subHints: [
      { contains: "ball", typeHint: "ball" },
      { contains: "gate", typeHint: "gate" },
      { contains: "globe", typeHint: "globe" },
      { contains: "check", typeHint: "check" },
      { contains: "butterfly", typeHint: "butterfly" },
    ],
  },
  // Both used to be null (out of scope) on the assumption that gasket/stud
  // bolt spec only ever lives embedded in a flange row's own gasket_type/
  // stud_bolts field, never as its own row -- confirmed stale on a real
  // document, where the client's own flanges array has dedicated "Gasket"
  // and "Stud Bolt/Hvy-Hex Nuts" rows with their own size ranges, and the
  // admin's own GASK rows carry real flange-indexed sizes (e.g. "400" for a
  // 16" flange's gasket) that line up with them directly.
  GASK: { category: "flanges", typeHint: "gasket" },
  // sizeOptional: confirmed on a real export where every BOLT row's own
  // Size column is blank (unlike GASK's) -- there's nothing to narrow by
  // size, so this matches by type(+class) alone rather than being dropped
  // the same way the old out-of-scope treatment silently was.
  BOLT: { category: "flanges", typeHint: "bolt", sizeOptional: true },
  ATTA: null,
  WELD: null,
  FTUB: null,
  INST: null,
  BEND: null,
};

const OUT_OF_SCOPE_NOTES: Record<string, string> = {
  ATTA: "Pipe support attachments are governed by the support standard/drawing, not the piping material spec.",
  WELD: "Field weld markers are a fabrication marker, not a material spec line.",
  FTUB: "Threaded nipples aren't itemized separately in this client spec.",
  INST: "Instrument valves are governed by the instrument index/P&ID, not the piping class spec.",
  BEND: "Zero-length bends are a drafting convenience, not a material spec line.",
};

export function rowSizeRangeContains(row: Record<string, unknown>, npsInches: number): boolean {
  const min = parseNpsInches(row.size_min);
  const max = parseNpsInches(row.size_max);
  if (min == null || max == null) return false;
  return npsInches >= min - 1e-9 && npsInches <= max + 1e-9;
}

export function rowTypeLabel(row: Record<string, unknown>): string {
  return String(row.fitting_type ?? row.flange_type ?? row.valve_type ?? "");
}

// A BW fitting's wall thickness follows the mating PIPE's own schedule at
// that exact size by piping convention, so it genuinely varies across a
// fitting's size range even where its own material band doesn't -- but
// showing a fitting's own computed per-size schedule number (looked up from
// the class's pipe rows) forced the merge below to split every fitting type
// into one row per pipe schedule tier, which made a class with six pipe
// schedule bands read as a wall of near-duplicate rows. A static reference
// label keeps the table grouped by what actually distinguishes a fitting
// row -- its own material/description -- while still pointing a reader at
// the right place for the real number.
const FITTING_CLASS_RATING_LABEL = "Refer to Pipe Schedule";

export interface ClassRowFields {
  type: string;
  endType: string;
  // Pipes carry their own schedule; flanges/valves carry their own ASME
  // pressure class (an unrelated concept -- flange class 300 is a rating,
  // not a wall-thickness schedule), so those stay as their own printed
  // `class` field. Fittings carry neither field in this app's extraction
  // schema, hence FITTING_CLASS_RATING_LABEL above.
  classRating: string;
  description: string;
}

// The exact display fields the Class Detail page's table cells show for one
// class row -- factored out from the page so mergeAdjacentClassRows below
// can group rows by "would render identically" without duplicating (and
// risking drifting from) the page's own per-cell logic.
export function classRowFields(category: SpecCategory, row: Record<string, unknown>): ClassRowFields {
  return {
    type: category === "pipes" ? "Pipe" : rowTypeLabel(row) || "-",
    endType: String(row.end_type ?? "").trim() || "-",
    classRating:
      category === "pipes"
        ? String(row.schedule ?? "").trim() || "-"
        : category === "fittings"
          ? FITTING_CLASS_RATING_LABEL
          : String(row.class ?? "").trim() || "-",
    description: String(row.description ?? row.material ?? "").trim() || "-",
  };
}

// Lightweight token extraction for the admin cross-check's PER-FIELD
// comparison table (Size/Schedule/End Type/Standard) -- a purely visual aid
// for a human reviewer, NOT a new input to crossCheckItem's own Match/Review
// verdict (see this file's top module comment for why free-text comparison
// was already tried and dropped as a verdict driver: it produced false
// failures unrelated to real spec discrepancies). The real admin item-list
// export this project actually uses (SPREF/GTYPE shape, see
// parseSheetPage.ts) has no separate Schedule/EndType/Standard columns at
// all, only free-text Description/Material -- so those tokens have to be
// pulled out of that text here to be worth showing at all. A side with no
// extractable token, or a client field that's itself a placeholder/blank,
// verdicts "unknown" (neutral, never a false red "differs") -- only two
// SUCCESSFULLY extracted tokens that actively disagree counts as "differs".
const END_TYPE_PATTERN = /\b(BW|SW|WN|THRD|THD|LJ|SO|PE|BE|TE|FE|RF)\b/gi;
const STANDARD_PATTERNS = [/\bB\s?\d{1,3}\.\d{1,3}(?:\.\d+)?\b/gi, /\bAPI\s?\d{3,4}[A-Z]?\b/gi, /\bMSS[- ]?SP[- ]?\d+\b/gi];
const SCHEDULE_PATTERN = /\bSCH(?:EDULE)?\.?\s?(\d+S?|XXS|XS|STD)\b/i;
const CLASS_RATING_PATTERN = /\bCLASS\.?\s?(\d{2,4})\b|\b(\d{2,4})\s?#/i;
// The ASTM/ASME base material designation -- "A106", "A672", "A105N",
// "B564"... one or two letters then digits then an optional trailing
// letter. Deliberately narrower than a full material-text comparison (which
// this project already tried and dropped as a verdict driver, see this
// section's own module comment): this only pulls out the base spec number
// itself, not the grade/trim wording around it, so "A106 Gr.B, SMLS" and
// "A106 Gr B SMLS ASME B36.10" both extract to the same "A106" token and
// agree, while a genuinely different base material ("A106" vs "A672") still
// disagrees. Confirmed worth adding on a real document: an admin pipe item
// listed EFW/A672 material at a size the client spec's own row still calls
// SMLS/A106 for, a real base-material disagreement the Size/Schedule/End
// Type/Standard fields alone had no way to surface.
const MATERIAL_GRADE_PATTERN = /\b[AB]\s?\d{3}[A-Z]?\b/gi;

function extractTokens(text: string, pattern: RegExp): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(pattern)) out.add(m[0].toUpperCase().replace(/\s+/g, ""));
  return out;
}

// RF is a FACING code, not a connection code -- only falls back to it when
// nothing else in END_TYPE_PATTERN matched, so a facing-only mention (e.g.
// "Class 150 RF") doesn't mask a real connection code sitting elsewhere in
// the same string, but still gives SOME answer if that's genuinely all
// that's printed.
function extractEndType(text: string): string | null {
  const tokens = [...extractTokens(text, END_TYPE_PATTERN)];
  return tokens.find((t) => t !== "RF") ?? tokens[0] ?? null;
}

function extractStandards(text: string): Set<string> {
  const out = new Set<string>();
  for (const pattern of STANDARD_PATTERNS) for (const t of extractTokens(text, pattern)) out.add(t);
  return out;
}

function extractMaterialGrades(text: string): Set<string> {
  return extractTokens(text, MATERIAL_GRADE_PATTERN);
}

function extractSchedule(text: string): string | null {
  return SCHEDULE_PATTERN.exec(text)?.[1]?.toUpperCase() ?? null;
}

function extractClassRating(text: string): string | null {
  const m = CLASS_RATING_PATTERN.exec(text);
  return m ? (m[1] ?? m[2]) : null;
}

// A flange/valve row's OWN pressure class (row.class, e.g. "150"/"300") is a
// real, distinguishing field that type+size alone can't stand in for -- this
// project's own "Flange" row prints once for Class 150 and again for Class
// 300 WN RF, same type, same size range, different class. Without checking
// it, every Flange admin line lands on BOTH rows regardless of its own
// 150#/300# rating -- confirmed on a real document. Only excludes when BOTH
// sides have a confidently extracted class (the row's own field, and a
// rating pulled from the admin item's free text via the same
// extractClassRating used for the per-field comparison table) that actively
// disagree; a row or admin text with no extractable class stays a
// candidate rather than being excluded on missing information.
function rowMatchesClassRating(row: Record<string, unknown>, adminText: string): boolean {
  const rowClass = String(row.class ?? "").trim();
  if (!rowClass) return true;
  const adminClass = extractClassRating(adminText);
  if (!adminClass) return true;
  return adminClass === rowClass;
}

export type FieldVerdict = "match" | "differs" | "unknown";

export interface AdminFieldComparison {
  field: string;
  adminValue: string;
  clientValue: string;
  verdict: FieldVerdict;
}

// Compares ONE admin item's free text against the client row it's already
// been grouped under (see groupAdminItemsByClassRow). Size is a genuine
// numeric check against the row's own bounds (not just a restatement of
// group membership) -- it will normally agree with the grouping (which
// already filtered on the same rowSizeRangeContains logic), so a red Size
// badge here is itself a signal something upstream disagrees, worth
// surfacing rather than hiding behind an unconditional "match". Schedule/
// End Type are compared against the client row's own structured field;
// Standard has no dedicated client field, so it's extracted from the
// client's own description text with the SAME pattern used on the admin
// side, then compared as sets (any overlap counts as a match) rather than
// requiring one single token to agree, since a row can legitimately
// reference more than one standard. Material is the same idea, comparing
// only the ASTM/ASME base material designation (see MATERIAL_GRADE_PATTERN's
// own comment for why that's narrow enough to avoid reintroducing the
// false-failure problem full free-text comparison caused -- this is a
// per-field REVIEWER AID like the rest of this array, not a new input to
// crossCheckItem's own Match/Review verdict.
export function compareAdminItemToClientRow(
  item: SheetItem,
  category: SpecCategory,
  client: MergedClassRow,
  adminSize: { mm: string; inch: string }
): AdminFieldComparison[] {
  const adminText = `${item.description} ${item.material}`;

  const clientRating = client.classRating.trim();
  const isPlaceholderRating = !clientRating || clientRating === "-" || clientRating === FITTING_CLASS_RATING_LABEL;
  const adminRating = category === "pipes" ? extractSchedule(adminText) : extractClassRating(adminText);
  const normalizeRating = (s: string) => s.toUpperCase().replace(/^0+(?=\d)/, "");

  const clientEndType = client.endType.trim();
  const adminEndType = extractEndType(adminText);

  const adminStandards = extractStandards(adminText);
  const clientStandards = extractStandards(client.description);

  const adminMaterialGrades = extractMaterialGrades(adminText);
  const clientMaterialGrades = extractMaterialGrades(client.description);

  const adminInches = dnToNpsInches(item.sizeP1);
  const hasClientRange = client.sizeMinInches != null && client.sizeMaxInches != null;

  return [
    {
      field: "Size",
      adminValue: adminSize.inch ? `${adminSize.inch}" (${adminSize.mm})` : adminSize.mm || "-",
      clientValue: hasClientRange ? client.size : "-",
      verdict:
        adminInches == null || !hasClientRange
          ? "unknown"
          : adminInches >= client.sizeMinInches! - 1e-9 && adminInches <= client.sizeMaxInches! + 1e-9
            ? "match"
            : "differs",
    },
    {
      field: "Material",
      adminValue: [...adminMaterialGrades].join(", ") || "-",
      clientValue: [...clientMaterialGrades].join(", ") || "-",
      verdict:
        adminMaterialGrades.size === 0 || clientMaterialGrades.size === 0
          ? "unknown"
          : [...adminMaterialGrades].some((g) => clientMaterialGrades.has(g))
            ? "match"
            : "differs",
    },
    {
      field: "Schedule / Class",
      adminValue: adminRating ?? "-",
      clientValue: isPlaceholderRating ? "-" : clientRating,
      verdict: !adminRating || isPlaceholderRating ? "unknown" : normalizeRating(adminRating) === normalizeRating(clientRating) ? "match" : "differs",
    },
    {
      field: "End Type",
      adminValue: adminEndType ?? "-",
      clientValue: clientEndType === "-" ? "-" : clientEndType,
      verdict: !adminEndType || clientEndType === "-" ? "unknown" : adminEndType === clientEndType.toUpperCase() ? "match" : "differs",
    },
    {
      field: "Standard",
      adminValue: [...adminStandards].join(", ") || "-",
      clientValue: [...clientStandards].join(", ") || "-",
      verdict: adminStandards.size === 0 || clientStandards.size === 0 ? "unknown" : [...adminStandards].some((s) => clientStandards.has(s)) ? "match" : "differs",
    },
  ];
}

export interface MergedClassRow extends ClassRowFields {
  size: string;
  // Numeric NPS bounds behind the `size` display string -- kept alongside
  // it (rather than re-parsed from it later) so a genuine per-admin-item
  // size check has real bounds to compare against instead of the display
  // string's fraction/en-dash formatting. Null when the row isn't
  // size-indexed at all (e.g. a Gasket/Stud Bolt row with no size_min).
  sizeMinInches: number | null;
  sizeMaxInches: number | null;
  // Indices into the category's own source array (e.g. classAttrs.pipes)
  // this displayed band was collapsed from -- lets the caller union each
  // source row's own admin matches (from groupAdminItemsByClassRow, which
  // is keyed by those same per-row indices) into one match list per band.
  rowIndices: number[];
}

// A class's pipes/fittings/flanges/valves rows come out of expandBands
// (apps/worker/src/extraction/specSheet.ts) as one row PER PRINTED SIZE
// COLUMN, not one row per merged band -- correct for admin cross-checking
// (which needs to test one exact NPS size at a time) but far too granular to
// read as a table (a single "1/2-1 1/2, 80S, UNS N08825" band prints as four
// separate, identical-looking rows). This re-collapses adjacent rows that
// would render IDENTICALLY (same type/end type/class rating/description --
// the exact fields classRowFields renders) back into one band spanning from
// the first row's size_min to the last row's size_max, same convention
// sizeRangeLabel already uses elsewhere. Only ADJACENT rows are merged --
// this assumes the source array is already in left-to-right printed size
// order, true by construction (expandBands walks each band's columns in
// printed order, and bands themselves are extracted top-to-bottom/in
// printed reading order) -- so two non-adjacent rows that happen to share
// the same fields (e.g. a repeated schedule further down the table) are
// deliberately kept as separate bands rather than merged across a gap.
export function mergeAdjacentClassRows(category: SpecCategory, rows: Array<Record<string, unknown>>): MergedClassRow[] {
  const merged: Array<{ fields: ClassRowFields; rowIndices: number[] }> = [];

  for (let i = 0; i < rows.length; i++) {
    const fields = classRowFields(category, rows[i]);
    const prev = merged[merged.length - 1];
    const sameAsPrev = prev && prev.fields.type === fields.type && prev.fields.endType === fields.endType && prev.fields.classRating === fields.classRating && prev.fields.description === fields.description;
    if (sameAsPrev) {
      prev.rowIndices.push(i);
    } else {
      merged.push({ fields, rowIndices: [i] });
    }
  }

  return merged.map(({ fields, rowIndices }) => {
    const first = rows[rowIndices[0]];
    const last = rows[rowIndices[rowIndices.length - 1]];
    const size = sizeRangeLabel({ size_min: first.size_min, size_max: last.size_max });
    return { ...fields, size, sizeMinInches: parseNpsInches(first.size_min), sizeMaxInches: parseNpsInches(last.size_max), rowIndices };
  });
}

// Internal-COMPONENT-material/construction terms excluded from cross-check
// COMPARISON specifically (the stored description/material text keeps
// every word -- nothing is lost from the extraction). Scoped narrowly to
// the same category "SS316L Trim" and "Bolted Bonnet" belong to -- a
// <material-or-construction> descriptor attached to a specific INTERNAL
// COMPONENT NAME (trim, ball, disc, wedge, seat, bonnet, cover) -- not a
// broader net over stem design, operator type, or standard references,
// which are a different category and still drive the match/mismatch
// verdict. Per this class's own Note b ("For Valve Material Summary refer
// Appendix 4"), this specific category of detail is meant to live in a
// separate document from this table, so it's out of scope for this
// comparison by the source document's own design.
//
// Kept (primary identifying spec, still drives match/mismatch):
//   valve/fitting/flange pattern (Gate, Full Bore, Solid Wedge, Swing...),
//   body material grade (A105N, A216 WCB...), end connection (SW/BW/
//   Flanged-RF), stem design (OS&Y), operator type, governing standards,
//   class/size (already separate fields).
const IGNORED_FOR_MATCHING = [
  // Trim / wetted-internals material (ball, disc, wedge, seat material --
  // not the body material)
  /\bSS\s?\d{3}L?\s*(Trim|Ball|Disc|Wedge|Seat(\s*ring)?)?\b/gi,
  /\b13\s?CR\b/gi,
  /\bStellite\s?\d*\b/gi,
  /\bHF\b/g,
  /\bHard[- ]?fac(ed|ing)\b/gi,
  /\bRPTFE(\s*seat)?\b/gi,
  // Bonnet / cover construction
  /\b(Bolted|Welded|Pressure[- ]?seal)\s*(Bonnet|Cover)\b/gi,
];

// Exported so the document page's display can show the same cleaned text,
// not just use it internally for comparison -- the underlying stored
// extraction keeps the full original description/material untouched
// either way, only what's rendered on the page changes.
export function stripSecondaryDetails(text: string): string {
  let out = text;
  for (const pattern of IGNORED_FOR_MATCHING) out = out.replace(pattern, " ");
  // Tidy up the punctuation/whitespace holes left behind so the display
  // doesn't show "A105N Body, ,  , OS&Y" -- collapse runs of whitespace,
  // drop now-empty comma segments, and trim stray leading/trailing commas.
  return out
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(", ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Checks a branch-governed Excel row (Tee/O'let) against the client class's
// exact (header, branch) Branch Table cell rather than a generic size range
// -- existence of the cell (and whether the client spec itself managed to
// resolve it) is the whole verdict; no material/description text comparison.
// Returns null when the class has no resolved Branch Table at all (e.g. its
// document had no Appendix or predates this feature) -- the caller falls
// back to the generic fittings size-range check in that case, same as before.
function checkBranchTable(clientClass: Record<string, unknown>, headerInches: number, branchInches: number, specLabel: string): CrossCheckResult | null {
  const resolvedBranches = (clientClass.resolved_branches as Array<Record<string, unknown>> | undefined) ?? [];
  if (resolvedBranches.length === 0) return null;

  const branchCell = resolvedBranches.find((r) => {
    const h = parseNpsInches(r.header_size);
    const b = parseNpsInches(r.branch_size);
    return h != null && b != null && Math.abs(h - headerInches) < 1e-6 && Math.abs(b - branchInches) < 1e-6;
  });

  // A branch cell has no size RANGE (it's one exact header x branch point,
  // not a size_min/size_max row) -- shown as "header x branch" so the
  // side-by-side Client Size column still means something for these rows.
  const clientSize = `${headerInches}" x ${branchInches}"`;

  if (!branchCell) {
    return {
      status: "not_found",
      label: "Wrong spec",
      note: `Branch Table has no cell for header ${headerInches}" x branch ${branchInches}" in client class "${specLabel}" -- this size/branch combination isn't in the client spec's list.`,
      clientSize,
    };
  }

  const cellMaterial = branchCell.material as string | null;
  if (!cellMaterial) {
    return {
      status: "no_client_data",
      label: "No client data",
      note: `Branch Table cell (header ${headerInches}" x branch ${branchInches}") exists but is itself unresolved in the client spec: ${String(branchCell.notes ?? "no matching fittings row")} -- a client-spec extraction gap, not an admin discrepancy.`,
      clientSize,
    };
  }

  const branchCode = String(branchCell.code ?? "?");
  return {
    status: "match",
    label: "Match",
    note: `Found in client spec's Branch Table (header ${headerInches}" x branch ${branchInches}", code ${branchCode}).`,
    clientDescription: cellMaterial,
    clientSize,
  };
}

export function crossCheckItem(item: SheetItem, clientClassesByCode: Map<string, Record<string, unknown>>): CrossCheckResult {
  const hint = CATEGORY_BY_GTYPE[item.type] ?? null;
  if (!hint) {
    return { status: "out_of_scope", label: "Not itemized in client spec", note: OUT_OF_SCOPE_NOTES[item.type] ?? null };
  }
  const effectiveHint = resolveHint(item, hint);

  const specCode = item.specCode.trim().toUpperCase();
  const clientClass = specCode ? clientClassesByCode.get(specCode) : clientClassesByCode.values().next().value;
  if (!clientClass) {
    return { status: "class_not_found", label: "Class not in client spec", note: `Client spec has no class "${item.specCode || "(blank)"}".` };
  }

  const npsInches = dnToNpsInches(item.sizeP1);
  if (npsInches == null && !effectiveHint.sizeOptional) {
    return { status: "size_unrecognized", label: "Size not recognized", note: `"${item.sizeP1}" mm is not a standard NPS size.` };
  }

  // Tee/O'let rows: Size P1 is the run/header size, Size P2 is the branch
  // size (standard AVEVA/SmartPlant catalogue convention) -- check the
  // client class's own resolved Branch Table at that exact cell before
  // falling back to the generic size-range check below, since that's the
  // only way to tell a 24"x2" weldolet from a 24"x10" one apart.
  if (hint.branchGoverned && item.sizeP2 && npsInches != null) {
    const branchInches = dnToNpsInches(item.sizeP2);
    if (branchInches != null) {
      const branchResult = checkBranchTable(clientClass, npsInches, branchInches, specCode || String(clientClass.class_code ?? ""));
      if (branchResult) return branchResult;
    }
  }

  const rows = (clientClass[hint.category] as Array<Record<string, unknown>> | undefined) ?? [];
  if (rows.length === 0) {
    // Distinct from "not_found" below: the client spec's class-detail
    // extraction has nothing at all in this category (e.g. its detail page
    // extracted as unreadable text and returned an empty array) -- that's a
    // data-availability problem, not evidence the Excel row is wrong.
    return { status: "no_client_data", label: "No client data", note: `Client spec class "${specCode || String(clientClass.class_code ?? "")}" has no ${hint.category} extracted at all -- re-run its extraction, not an Excel discrepancy.` };
  }

  const adminText = `${item.description} ${item.material}`;
  // Type is checked FIRST, against every row regardless of its class
  // rating -- see groupAdminItemsByClassRow's matching comment (same fix,
  // same real document) for why class-rating can only ever disambiguate
  // between same-type rows, never exclude the type's own row and broaden
  // into an unrelated one.
  const typeMatches = rows.filter((r) => rowMatchesTypeHint(r, effectiveHint));
  // No usable size at all (sizeOptional GTYPEs only, e.g. Stud Bolt -- see
  // CategoryHint's own comment) -- every type match stands as-is, since
  // there's nothing to narrow by.
  const inRange = npsInches == null ? typeMatches : typeMatches.filter((r) => rowSizeRangeContains(r, npsInches));

  if (inRange.length === 0) {
    // A row of THIS exact type was found (typeMatches non-empty) -- it just
    // doesn't cover this size. Broadening past type here would silently
    // attach the item to some OTHER, unrelated component -- confirmed on a
    // real document where a 12"-24" Blind Flange admin line, whose own
    // "Blind flange" client row correctly stops at 10" (larger blinds go
    // through a different mechanism), fell back to whatever ELSE happened
    // to cover that size -- Gasket and Stud Bolt, both general
    // whole-class material notes with no real per-item correspondence. The
    // right answer when the item's own type row exists but doesn't reach
    // this size is "not in the client spec at this size", not a guess at a
    // different type. Broadening past type at all is skipped for
    // branch-governed types (Tee/O'let) too, for the same reason: their
    // real coverage is intentionally narrower than the full size grid
    // (larger branch connections resolve through the class's own Branch
    // Table instead, see checkBranchTable above) -- confirmed separately
    // on a 10" Weldolet admin line that wrongly attached to the class's
    // unrelated Elbow row.
    if (typeMatches.length > 0) {
      return {
        status: "not_found",
        label: "Wrong spec",
        note: `The client's own ${hint.category} row matching "${item.type}" doesn't cover ${npsInches}" NPS -- this item isn't in the client spec's list at this size.`,
      };
    }
    const anyInRange =
      effectiveHint.branchGoverned || npsInches == null ? [] : rows.filter((r) => rowMatchesClassRating(r, adminText) && rowSizeRangeContains(r, npsInches));
    if (anyInRange.length === 0) {
      return {
        status: "not_found",
        label: "Wrong spec",
        note: effectiveHint.branchGoverned
          ? `This is a branch-governed type (Tee/O'let) -- no ${hint.category} row covers ${npsInches}" NPS at its own type, and the class's Branch Table didn't resolve this header/branch combination either. Check it directly against the class's own Branch Table rather than a generic fittings row.`
          : `No ${hint.category} row in client class "${specCode || String(clientClass.class_code ?? "")}" covers ${npsInches}" NPS -- this item isn't in the client spec's list at this size.`,
      };
    }
    // No row of this type was found under ANY label at all (typeMatches was
    // empty) -- size genuinely exists in the client spec, just not tagged
    // with a matching type keyword. Still a structural ambiguity worth a
    // human look, not a text-comparison result.
    const closest = anyInRange[0];
    return {
      status: "mismatch",
      label: "Review",
      note: `Size is in range, but no row's type matches "${item.type}" -- check manually.`,
      clientDescription: String(closest.description ?? closest.material ?? "") || null,
      clientSize: sizeRangeLabel(closest),
    };
  }

  // The verdict from here is purely "this type+size exists in the client
  // spec's list" -- clientDescription/clientSize are looked up and returned
  // for side-by-side reference only, they never drive the status. See the
  // module comment for why material/description text comparison was
  // dropped as the determinant. Class rating (when more than one same-type,
  // same-size row exists) only picks WHICH of them clientDescription/
  // clientSize reference -- same disambiguate-don't-exclude reasoning as
  // groupAdminItemsByClassRow, so a row whose own class field happens to be
  // mis-extracted still resolves to "match" via the class-agreeing row when
  // one exists, or the first type+size row otherwise. Prefers the class
  // detail's own explicit `description` field (only present when the
  // source page actually prints one separately) over `material`, since
  // `material` is usually the richer, more description-like field in
  // practice.
  const classDisambiguated = inRange.filter((r) => rowMatchesClassRating(r, adminText));
  const match = classDisambiguated.length > 0 ? classDisambiguated[0] : inRange[0];
  return {
    status: "match",
    label: "Match",
    note: `Found in client spec's ${hint.category} list at this size.`,
    clientDescription: String(match.description ?? match.material ?? "") || null,
    clientSize: sizeRangeLabel(match),
  };
}

// Inverse of crossCheckItem's own direction: given one client spec class's
// already-extracted attributes and the full list of admin item-list rows,
// groups every admin row against each of the class's own pipes/fittings/
// flanges/valves rows it could plausibly belong to -- keyed "{category}:
// {rowIndex}" so the Class Detail page can look up "which admin lines
// relate to THIS row" with a single map lookup per rendered row, instead of
// re-scanning the whole admin list per row. Mirrors crossCheckItem's own
// two-step matching (type-hint-filtered rows in size range, broadened to
// any row in range if that comes up empty) so the two views never disagree
// about what "matches" means -- except an admin item is attached to EVERY
// candidate row here, not just crossCheckItem's single best one, since the
// question this answers is "what could this row be substantiated by", not
// "what is the one verdict for this admin row".
//
// Branch-governed items (Tee/O'let) are grouped by this same generic
// type+size rule, not resolved against the class's own Branch Table cell
// the way checkBranchTable does -- good enough for "which admin lines
// relate to this row" without duplicating that join here.
// One category's worth of unmatched-by-size admin lines, grouped further by
// the CLIENT's own type label (e.g. "Spectacle blind" vs "Gasket") -- see
// AdminClassClassification.unmatchedBySize for why this grouping exists.
export interface UnmatchedBySizeGroup {
  category: SpecCategory;
  typeLabel: string;
  items: SheetItem[];
}

export interface AdminClassClassification {
  groups: Map<string, SheetItem[]>;
  // Admin items whose type genuinely exists as a row in this class/category
  // (typeMatches non-empty) but whose OWN size doesn't fall inside ANY of
  // that type's declared size bands -- e.g. a class whose Check valve rows
  // only run 1/2"-36" but an admin item lists a 48" Check valve. These never
  // get added to `groups` (there's no correct band to attach them to -- see
  // that loop's own "never broaden past type" comment), so without this they
  // were previously invisible everywhere. Grouped by the CLIENT row's own
  // type label (rowTypeLabel of the first type-matching row), not just by
  // category -- confirmed on a real class where lumping a whole category
  // together mixed unrelated types (Spectacle blind AND Gasket) into one
  // undifferentiated block under a misleading single heading. Keyed by
  // "{category}:{typeLabel}" so the Class Detail page can render one section
  // per real type instead of one per category.
  unmatchedBySize: Map<string, UnmatchedBySizeGroup>;
}

function classifyAdminItemsForClass(classCode: string, classAttrs: Record<string, unknown>, adminItems: SheetItem[]): AdminClassClassification {
  const groups = new Map<string, SheetItem[]>();
  const unmatchedBySize = new Map<string, UnmatchedBySizeGroup>();
  const normalizedClass = normalizeSpecClassCode(classCode);

  const add = (key: string, item: SheetItem) => {
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  };
  const addUnmatched = (category: SpecCategory, typeLabel: string, item: SheetItem) => {
    const key = `${category}:${typeLabel}`;
    const group = unmatchedBySize.get(key);
    if (group) group.items.push(item);
    else unmatchedBySize.set(key, { category, typeLabel, items: [item] });
  };

  for (const item of adminItems) {
    const hint = CATEGORY_BY_GTYPE[item.type];
    if (!hint) continue;
    const effectiveHint = resolveHint(item, hint);
    const specCode = item.specCode.trim().toUpperCase();
    if (specCode && normalizeSpecClassCode(specCode) !== normalizedClass) continue;

    const npsInches = dnToNpsInches(item.sizeP1);
    if (npsInches == null && !effectiveHint.sizeOptional) continue;

    const rows = (classAttrs[hint.category] as Array<Record<string, unknown>> | undefined) ?? [];
    const indexed = rows.map((row, index) => ({ row, index }));
    const adminText = `${item.description} ${item.material}`;
    // Type is checked FIRST, against every row regardless of its class
    // rating -- class rating is only ever a disambiguator BETWEEN rows that
    // already agree on type (+size), never a reason to exclude the type's
    // own row and fall through to an unrelated type. Confirmed on a real
    // document where a Gasket row's own `class` field was mis-extracted
    // ("150" instead of blank/"300"): filtering by class rating FIRST (the
    // old order) dropped that Gasket row out of contention entirely, made
    // typeMatches look empty, and broadened straight into the class-300
    // Flange row (which does share the admin item's own extracted "300#")
    // -- a Gasket admin line ending up listed as a Flange row's own match.
    const typeMatches = indexed.filter(({ row }) => rowMatchesTypeHint(row, effectiveHint));
    // No usable size at all (sizeOptional GTYPEs only) -- every type match
    // stands as-is, since there's nothing to narrow by.
    const typeSizeMatches = npsInches == null ? typeMatches : typeMatches.filter(({ row }) => rowSizeRangeContains(row, npsInches));
    // Class rating only NARROWS this set (to pick between e.g. a Class 150
    // Flange row and a Class 300 Flange row covering the same size) -- if
    // applying it would eliminate every remaining candidate (the mis-
    // extracted-class-field case above), keep the full type+size set
    // instead of discarding it; the disagreement still shows up as a red
    // "differs" in that row's own Schedule/Class field comparison, which is
    // the correct place to surface it, not silent exclusion or misrouting.
    const classDisambiguated = typeSizeMatches.filter(({ row }) => rowMatchesClassRating(row, adminText));
    const inRange = classDisambiguated.length > 0 ? classDisambiguated : typeSizeMatches;
    // Never broaden past type when a row of THIS exact type was found but
    // doesn't cover this size (typeMatches non-empty) -- confirmed on a
    // real document where a 12"-24" Blind Flange admin line, whose own
    // "Blind flange" row correctly stops at 10", fell back to whatever else
    // covered that size (Gasket, Stud Bolt -- general whole-class material
    // notes with no real per-item correspondence) instead of correctly
    // reporting "not in the client spec at this size". Same reasoning
    // covers branch-governed types (Tee/O'let), whose real coverage is
    // intentionally narrower than the full grid (see crossCheckItem's
    // matching comment for the Weldolet/Elbow case this was first found on).
    const candidates =
      inRange.length > 0 || npsInches == null
        ? inRange
        : typeMatches.length > 0 || effectiveHint.branchGoverned
          ? []
          : indexed.filter(({ row }) => rowMatchesClassRating(row, adminText) && rowSizeRangeContains(row, npsInches));

    if (candidates.length > 0) {
      for (const { index } of candidates) add(`${hint.category}:${index}`, item);
    } else if (typeMatches.length > 0 && npsInches != null) {
      const typeLabel = rowTypeLabel(typeMatches[0].row).trim() || "Other";
      addUnmatched(hint.category, typeLabel, item);
    }
  }

  return { groups, unmatchedBySize };
}

export function groupAdminItemsByClassRow(classCode: string, classAttrs: Record<string, unknown>, adminItems: SheetItem[]): Map<string, SheetItem[]> {
  return classifyAdminItemsForClass(classCode, classAttrs, adminItems).groups;
}

// Exported separately from groupAdminItemsByClassRow (which only the BOM
// cross-check needs) so the Class Detail page can also surface items that
// matched nowhere -- see AdminClassClassification.unmatchedBySize. Returned
// as an array (not the internal Map) since the page only ever needs to
// filter by category and render each group -- an array is simplest for that.
export function findAdminItemsUnmatchedBySize(classCode: string, classAttrs: Record<string, unknown>, adminItems: SheetItem[]): UnmatchedBySizeGroup[] {
  return [...classifyAdminItemsForClass(classCode, classAttrs, adminItems).unmatchedBySize.values()];
}
