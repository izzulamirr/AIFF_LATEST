import type { SheetItem } from "./parseSheetPage";
import { normalizeNominalSize, normalizeSpecClass } from "./verifyIso";
import { rowMatchesTypeHint, rowSizeRangeContains, normalizeSpecClassCode, sizeRangeLabel, DN_TO_NPS_INCHES, groupAdminItemsByClassRow, type SpecCategory, type CategoryHint } from "./verifySpecCrossCheck";

// Cross-checks an ISO drawing's own Bill of Material against the SAME
// client spec_class data (and, where available, the SAME admin-confirmed
// rows) the Admin cross-check already resolves -- "does what's actually
// being fabricated per the isometric trace back to material this class's
// spec (and, ideally, the client's own admin item list) actually covers."
// Reuses verifySpecCrossCheck.ts's CategoryHint/rowMatchesTypeHint directly
// rather than re-solving the exact same "Tee (Reduced) vs Reducer",
// "Spectacle blind vs Blind flange", "Orifice Flanges vs plain Flange"
// collisions a second time -- see that file's own CategoryHint comment for
// why a naive substring match isn't safe here.

// A BOM's own `component_type` column is NOT a fixed enum across documents
// -- confirmed against two real ISO exports of the same drawing set: one
// uses broad buckets ("FITTINGS", "FLANGES", "VALVES / IN-LINE ITEMS"),
// the other uses granular per-part values ("ELBOW", "FLANGE", "BOLT SET"),
// and a third wraps EVERY row (pipe, elbow, flange alike) in a generic
// "FABRICATION ITEM"/"ERECTION ITEM" label that carries no type information
// at all. So classification reads the row's own DESCRIPTION text (the one
// field that's reliably specific), the same way admin item classification
// reads free text rather than trusting a loosely-enumerated type column.
// Order matters: more specific patterns are listed before the generic ones
// they'd otherwise be swallowed by (e.g. "reducing tee" before bare "tee",
// "control valve" before bare "valve").
const OUT_OF_SCOPE_PATTERNS: RegExp[] = [
  /\bcontrol\s*valve\b|\binstrument\b/i, // checked before the generic \bvalve\b rule below
  /\bgasket\b/i,
  // "stud bolt"/"bolt set" specifically, NOT a bare \bbolt\b -- confirmed on
  // a real BOM where a Blind Flange's own description ("...BOLT HOLES TO
  // MATCH ANSI B16.5") mentions "bolt" only in passing, describing the
  // flange's own bolt-circle spec, not a fastener line item. Every real
  // stud-bolt BOM line seen consistently leads with "STUD BOLT" or "BOLT
  // SET", so this stays just as specific without the false positive.
  /\bstud\s*bolt\b|\bbolt\s*set\b/i,
  /\bpipe\s*support\b|\bsupport\b/i,
  /\breinforcement\b/i,
  /\bexpansion\s*joint\b/i,
  /\bstrainer\b/i,
];

interface BomClassification {
  category: SpecCategory;
  hint: CategoryHint;
}

const BOM_CLASSIFICATION_RULES: Array<{ match: RegExp; classify: BomClassification }> = [
  // Fittings -- most-specific Tee wording first (see CategoryHint's own
  // comment on why "reduced" is used, not "reduc": it can't leak into
  // "Reducer (Concentric/Eccentric)" the way the bare stem would).
  { match: /\breducing\s*tee\b|\btee\s*\(?\s*red/i, classify: { category: "fittings", hint: { category: "fittings", typeHint: "reduced" } } },
  { match: /\bequal\s*tee\b/i, classify: { category: "fittings", hint: { category: "fittings", typeHint: "straight" } } },
  { match: /\btee\b/i, classify: { category: "fittings", hint: { category: "fittings", typeHint: "tee" } } },
  { match: /\bweldolet\b|\bo'?let\b|\bsockolet\b/i, classify: { category: "fittings", hint: { category: "fittings", typeHint: "olet" } } },
  // "redu" alone (not just the full word "reducer") -- confirmed on a real
  // BOM using the abbreviated form "REDU CONC"/"REDU ECC", the same
  // shorthand the admin item-list's own GTYPE code uses. Safe from the same
  // "Tee (Reduced)" collision CategoryHint warns about because the tee
  // rules above are checked first in this same loop and already intercept
  // "reducing tee"/"tee (red..." before this rule ever sees them.
  { match: /\breducer\b|\bredu\b/i, classify: { category: "fittings", hint: { category: "fittings", typeHint: "reducer" } } },
  { match: /\belbow\b/i, classify: { category: "fittings", hint: { category: "fittings", typeHint: "elbow" } } },
  { match: /\bcap\b/i, classify: { category: "fittings", hint: { category: "fittings", typeHint: "cap" } } },
  // Flanges -- spectacle/spade/orifice checked before plain "flange" for
  // the same reason (all three contain, or sit next to, that word).
  { match: /\bspectacle\b/i, classify: { category: "flanges", hint: { category: "flanges", typeHint: "spectacle" } } },
  { match: /\bspade\b|\bspacer\b/i, classify: { category: "flanges", hint: { category: "flanges", typeHint: "spade" } } },
  { match: /\borifice\b/i, classify: { category: "flanges", hint: { category: "flanges", typeHint: "orifice" } } },
  { match: /\bblind\s*flange\b|\bflange,?\s*blind\b/i, classify: { category: "flanges", hint: { category: "flanges", typeHint: "blind", excludeHints: ["spectacle"] } } },
  { match: /\bflange\b/i, classify: { category: "flanges", hint: { category: "flanges", typeHint: "flange", excludeHints: ["blind", "orifice"] } } },
  // Valves -- sub-typed by the BOM item's own description, same fix (and
  // same real-document bug) as the admin GTYPE table's VALV entry
  // (verifySpecCrossCheck.ts's CATEGORY_BY_GTYPE): with no typeHint, EVERY
  // valve row covering the item's size was a candidate regardless of type,
  // and inRange[0] silently picked whichever one happened to sit first in
  // the client class's own array order -- confirmed on a real BOM where an
  // 8" Ball valve item matched the class's Gate valve row instead (Gate is
  // listed before Ball in that class's own valves array), showing a Gate
  // description and a wall of unrelated Gate admin lines under a Ball BOM
  // item. Specific patterns must come before the generic \bvalve\b fallback
  // below, same ordering reason as Tee/Reducer and the Flange family above.
  { match: /\bball\s*valve\b/i, classify: { category: "valves", hint: { category: "valves", typeHint: "ball" } } },
  { match: /\bgate\s*valve\b/i, classify: { category: "valves", hint: { category: "valves", typeHint: "gate" } } },
  { match: /\bglobe\s*valve\b/i, classify: { category: "valves", hint: { category: "valves", typeHint: "globe" } } },
  { match: /\bcheck\s*valve\b/i, classify: { category: "valves", hint: { category: "valves", typeHint: "check" } } },
  { match: /\bbutterfly\s*valve\b/i, classify: { category: "valves", hint: { category: "valves", typeHint: "butterfly" } } },
  // Fallback for a valve type this app doesn't have a keyword for yet (e.g.
  // plug, needle) -- matches any row, same as before this fix, rather than
  // being silently dropped as out-of-scope.
  { match: /\bvalve\b/i, classify: { category: "valves", hint: { category: "valves" } } },
  { match: /\bpipe\b/i, classify: { category: "pipes", hint: { category: "pipes" } } },
];

export function classifyBomItem(item: Record<string, unknown>): BomClassification | null {
  const text = `${item.component_type ?? ""} ${item.description ?? ""}`;
  if (OUT_OF_SCOPE_PATTERNS.some((p) => p.test(text))) return null;
  for (const rule of BOM_CLASSIFICATION_RULES) {
    if (rule.match.test(text)) return rule.classify;
  }
  return null;
}

// A BOM's own size column mixes bare mm ("200"), inch-marked ("1\""), and a
// run x branch pair for O'lets/reducing tees ("200 x 80", "2\"X1\"") --
// normalizeNominalSize (verifyIso.ts) already parses all of this down to a
// DN, taking the first (run) size for a pair, the same convention this
// class's own O'let/reducing-tee rows are indexed by.
function bomSizeToInches(size: unknown): number | null {
  if (size == null) return null;
  const dn = normalizeNominalSize(size);
  if (dn == null) return null;
  return DN_TO_NPS_INCHES[dn] ?? null;
}

// Same composition verifyIso.ts's own line/spec-class matching needs:
// normalizeSpecClass strips an ISO-specific suffix ("AC03N-N" -> "AC03N"),
// normalizeSpecClassCode strips a spec-sheet-specific one (a spurious
// trailing "1" some title blocks print, "AC03N1" -> "AC03N") -- a BOM
// item's item_spec_class can in principle carry either quirk, so both run
// regardless of which one actually applies.
export function normalizeBomSpecClass(raw: string): string {
  return normalizeSpecClassCode(normalizeSpecClass(raw) ?? raw.trim().toUpperCase());
}

// Mirrors documents/[docId]/page.tsx's own bomBySpec fallback exactly (see
// that file) -- kept here as one shared implementation instead of a second
// copy that could silently drift from it.
export function resolveBomItemSpecClass(itemAttrs: Record<string, unknown>, lineAttrs: Record<string, unknown>): string {
  const itemClass = itemAttrs.item_spec_class;
  if (typeof itemClass === "string" && itemClass.trim()) return itemClass.trim();
  const breaks = Array.isArray(lineAttrs.spec_breaks) ? lineAttrs.spec_breaks : [];
  const lineClass = typeof lineAttrs.spec_class === "string" ? lineAttrs.spec_class : "";
  if (breaks.length < 2 && lineClass) return lineClass;
  return "Unassigned";
}

export type BomCrossCheckStatus = "match" | "not_found" | "size_unrecognized" | "out_of_scope" | "class_not_found" | "no_client_data";

export interface BomCrossCheckResult {
  status: BomCrossCheckStatus;
  label: string;
  note: string | null;
  clientDescription?: string | null;
  clientSize?: string | null;
  // Which row in clientClass[category] this resolved to -- lets the caller
  // cross-reference groupAdminItemsByClassRow's own "{category}:{index}"
  // keys to answer "was this ALSO confirmed by the admin's own item list"
  // without this function needing to know anything about admin data at all
  // (the same separation crossCheckItem/compareAdminItemToClientRow keep).
  matchedCategory?: SpecCategory;
  matchedRowIndex?: number;
}

export function crossCheckBomItem(item: Record<string, unknown>, clientClass: Record<string, unknown> | undefined): BomCrossCheckResult {
  const classification = classifyBomItem(item);
  if (!classification) {
    return {
      status: "out_of_scope",
      label: "Not itemized in client spec",
      note: "This BOM item's component type isn't tracked in the piping material spec as its own row (e.g. gasket, bolt, support, instrument/control valve).",
    };
  }
  if (!clientClass) {
    return {
      status: "class_not_found",
      label: "Class not in client spec",
      note: `No client spec_sheet extraction found for class "${String(item.item_spec_class ?? item.spec_class ?? "(blank)")}" -- upload/extract that class's spec sheet to cross-check this item.`,
    };
  }

  const inches = bomSizeToInches(item.size);
  if (inches == null) {
    return { status: "size_unrecognized", label: "Size not recognized", note: `"${String(item.size ?? "")}" isn't a standard NPS/DN size.` };
  }

  const rows = (clientClass[classification.category] as Array<Record<string, unknown>> | undefined) ?? [];
  if (rows.length === 0) {
    return {
      status: "no_client_data",
      label: "No client data",
      note: `Client spec class has no ${classification.category} extracted at all -- re-run its extraction, not a BOM discrepancy.`,
    };
  }

  const indexed = rows.map((row, index) => ({ row, index }));
  const typeMatches = indexed.filter(({ row }) => rowMatchesTypeHint(row, classification.hint));
  const inRange = typeMatches.filter(({ row }) => rowSizeRangeContains(row, inches));

  if (inRange.length === 0) {
    return {
      status: "not_found",
      label: "Not in client spec",
      note: `No ${classification.category} row covers ${inches}" NPS at this item's own type -- this BOM item isn't in the client spec's list at this size.`,
    };
  }

  const match = inRange[0];
  return {
    status: "match",
    label: "Match",
    note: `Found in client spec's ${classification.category} list at this size.`,
    clientDescription: String(match.row.description ?? match.row.material ?? "") || null,
    clientSize: sizeRangeLabel(match.row),
    matchedCategory: classification.category,
    matchedRowIndex: match.index,
  };
}

export type ValveClientStatus = "match" | "not_found" | "size_unrecognized" | "no_client_data";

export interface ValveClientResult {
  status: ValveClientStatus;
  clientDescription: string | null;
  // null when no admin data was resolved for this class at all (distinct
  // from false, which means the class's own client row is real but no
  // admin item list actually confirms it) -- same distinction the rest of
  // this app's admin cross-check already draws.
  adminConfirmed: boolean | null;
}

// Companion to crossCheckBomItem, scoped to valves specifically -- unlike
// pipes/fittings/flanges, a valve row is never sub-classified by type
// keyword anywhere in this app (the admin GTYPE table's own VALV entry has
// no typeHint, see verifySpecCrossCheck.ts's CATEGORY_BY_GTYPE), so a plain
// DN -> NPS -> rowSizeRangeContains check is the whole answer; no
// classification step is needed the way pipes/fittings/flanges require.
// Used for the ISO page's "Valve match: ISO vs P&ID" table, which already
// has its own DN per row (see ValveMatchRow.dn) from pairing ISO against
// P&ID -- this is the SAME size, reused a second time to also check it
// against the client spec + admin list, not re-derived.
export function resolveValveClientStatus(dn: number | null, clientClass: Record<string, unknown> | undefined, adminGroups: Map<string, SheetItem[]> | undefined): ValveClientResult {
  const inches = dn == null ? null : (DN_TO_NPS_INCHES[dn] ?? null);
  if (inches == null) return { status: "size_unrecognized", clientDescription: null, adminConfirmed: null };
  if (!clientClass) return { status: "no_client_data", clientDescription: null, adminConfirmed: null };

  const rows = (clientClass.valves as Array<Record<string, unknown>> | undefined) ?? [];
  const index = rows.findIndex((row) => rowSizeRangeContains(row, inches));
  if (index === -1) return { status: "not_found", clientDescription: null, adminConfirmed: null };

  const row = rows[index];
  const adminConfirmed = adminGroups ? (adminGroups.get(`valves:${index}`)?.length ?? 0) > 0 : null;
  return { status: "match", clientDescription: String(row.description ?? row.material ?? "") || null, adminConfirmed };
}

export interface ClientAndAdminData {
  clientClassByNorm: Map<string, Record<string, unknown>>;
  adminGroupsByNorm: Map<string, Map<string, SheetItem[]>>;
}

// Resolves, for a SET of normalized class codes, (a) each one's own client
// spec_class data and (b) its admin-confirmed rows -- shared by every page
// that cross-checks ISO/BOM data against multiple spec classes at once (the
// ISO document page's Valve Match table, and the ISO verify page), so this
// exact resolution logic -- including the duplicate-tag tie-break below --
// only has to be gotten right once. Pure/synchronous: callers do their own
// DB fetching (this project has no single shared query shape across pages
// that fetch from different scopes) and pass the already-fetched rows in.
export function resolveClientAndAdminData(
  specClassTags: Array<{ tagNumber: string; attributes: unknown }>,
  adminItems: SheetItem[],
  neededSpecs: Set<string>
): ClientAndAdminData {
  // More than one document can hold a spec_class tag for the SAME
  // normalized class code -- confirmed on a real project where a class has
  // both a real PDF-sourced extraction (pipes/fittings/flanges/valves all
  // populated) AND a broken .xlsx-sourced one (every array empty, a known
  // separate extraction bug). Postgres gives no row-order guarantee, so
  // "first one seen wins" is non-deterministic; picking the tag with the
  // MOST total rows across all four categories is deterministic regardless
  // of query order, and always prefers real data over an empty duplicate.
  const richness = (attrs: Record<string, unknown>) =>
    (["pipes", "fittings", "flanges", "valves"] as const).reduce((n, k) => n + (Array.isArray(attrs[k]) ? (attrs[k] as unknown[]).length : 0), 0);

  const clientClassByNorm = new Map<string, Record<string, unknown>>();
  for (const t of specClassTags) {
    const norm = normalizeSpecClassCode(t.tagNumber);
    if (!neededSpecs.has(norm)) continue;
    const attrs = t.attributes as Record<string, unknown>;
    const existing = clientClassByNorm.get(norm);
    if (!existing || richness(attrs) > richness(existing)) clientClassByNorm.set(norm, attrs);
  }

  const adminGroupsByNorm = new Map<string, Map<string, SheetItem[]>>();
  if (adminItems.length > 0) {
    for (const norm of neededSpecs) {
      const clientClass = clientClassByNorm.get(norm);
      if (clientClass) adminGroupsByNorm.set(norm, groupAdminItemsByClassRow(norm, clientClass, adminItems));
    }
  }

  return { clientClassByNorm, adminGroupsByNorm };
}
