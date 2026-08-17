// Spec (material class) breaks on an isometric: a single drawing can carry
// two piping classes, marked by "MATL <class>" callouts either side of a
// joint. Each BOM item is then governed by its own class, not the title
// block's -- see verifyIso.ts gates 4 and 7.

// ASME B16.5 / B16.47 pressure class ratings, in the order used to decide
// which of two classes is "higher" at a break.
const RATING_ORDER = [150, 300, 400, 600, 900, 1500, 2500];

// Pulls the pressure class from free text: "FLANGE WN ASME B16.5 150# RF" ->
// 150, "GASKET, SPIRAL WD, 300#" -> 300, "150RF-FA" -> 150. Returns null
// when the text carries no rating (plain pipe, butt-weld fittings), which is
// the signal that an item cannot be placed by rating alone.
export function parsePressureRating(text: string | undefined | null): number | null {
  if (!text) return null;
  const upper = String(text).toUpperCase();
  // "150#", "300 #", "150LB", "150 LBS", "CL150", "CLASS 300", "150RF"
  const match = upper.match(/(?:\bCL(?:ASS)?\s*)?(\d{3,4})\s*(?:#|LBS?\b|RF\b|CLASS\b)/) ?? upper.match(/\b(\d{3,4})\s*#/);
  if (!match) return null;
  const value = Number(match[1]);
  return RATING_ORDER.includes(value) ? value : null;
}

// The higher of two ratings. At a spec break every component belongs to its
// own side -- the two mating flanges and the bolts each stay with their own
// class -- so this is used only for the gasket, the single part sandwiched
// between the flanges, which is rate-matched to the higher class.
export function higherRating(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

export interface SpecBreakEntry {
  spec_class: string;
  location_note?: string;
  /** Pressure class of this spec, when known (from its own code/spec sheet). */
  rating?: number | null;
}

// Some components are rated above their line's class by their own standard,
// so their rating says nothing about which side of a break they sit on:
//  - ASME B16.36 orifice flanges start at 300#, so a 150# line's orifice
//    assembly is flanged (and gasketed) in 300#. Confirmed on a real drawing
//    whose 150#-only sheets carry a "FLANGE ORIFICE WN 300# RF B16.36".
// Rows like these must be placed by position, never by rating.
const RATING_NOT_INDICATIVE = /orifice/i;

export function ratingIndicatesClass(itemText: string): boolean {
  return !RATING_NOT_INDICATIVE.test(itemText);
}

// Fallback placement of a BOM row by its rating signature, used only when the
// drawing itself didn't tell us the side. Position on the drawing is the real
// basis (see item_spec_class in the ISO extraction schema): a spec break is a
// point along the run, so which side a part sits on is a geometric fact, and
// plain pipe / weldolets / butt-weld elbows carry no rating at all.
// Deliberately conservative -- returns null rather than guessing, since
// placing an item on the wrong side is worse than leaving it unplaced.
export function assignItemSpec(
  itemText: string,
  specs: SpecBreakEntry[]
): { spec_class: string; basis: "rating" } | null {
  if (specs.length < 2) return null; // single-class drawing: the line's class already governs
  if (!ratingIndicatesClass(itemText)) return null; // e.g. B16.36 orifice flange
  const rating = parsePressureRating(itemText);
  if (rating == null) return null;
  const matches = specs.filter((s) => s.rating != null && s.rating === rating);
  if (matches.length !== 1) return null; // ambiguous or unknown class ratings
  return { spec_class: matches[0].spec_class, basis: "rating" };
}
