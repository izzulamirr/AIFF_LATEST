import { parseNpsInches, repairInvertedSizeRange } from "@easy/shared";
import type { SpecCategory } from "./verifySpecCrossCheck";

// Mirrors apps/worker/src/extraction/specSheet.ts's own band-overlap and
// notes-legend checks (validateBandCoverage/validateNotesCoverage), but
// runs entirely on data already sitting in extracted_tags.attributes -- no
// Claude call. Two differences from the worker's version, both forced by
// what survives storage:
//  - Overlap is checked by NUMERIC size-range intersection, not shared
//    printed column labels -- expandBands (specSheet.ts) already collapsed
//    each row down to just size_min/size_max, discarding the original
//    `columns` label list a stored row came from.
//  - Gap/full-coverage is NOT re-checked here. The worker's version compares
//    a class's pipe bands against a MASTER COLUMN LIST derived from those
//    bands' own original printed headers -- e.g. a class whose header row
//    genuinely reads "...4, 6, 8..." has no gap at 5" (NPS sizing skips 5"
//    by convention almost everywhere), but a class that actually dropped a
//    real column would. That header list isn't stored, so there's no
//    reliable way from size data alone to tell "5" is legitimately never
//    printed" apart from "a real column went missing" -- re-checking gaps
//    here would either miss real ones or false-flag the routine 4"->6" skip
//    on every single class. Only a fresh read of the source page can tell
//    those apart, which is a different (AI-calling) recheck than this one.
export interface RevalidatedClass {
  attrs: Record<string, unknown>;
  issueCount: number;
  repairedSizeCount: number;
}

const CATEGORIES: SpecCategory[] = ["pipes", "fittings", "flanges", "valves"];

// Which sub-group a row belongs to for both sorting and overlap-checking --
// pipes are one size-graduated run (no sub-type), fittings/flanges/valves
// each hold several distinct component families that legitimately share
// overlapping size ranges (an Elbow and a Cap can both cover 2"-4" without
// conflict), so overlap only makes sense checked WITHIN a family.
function typeGroupKey(category: SpecCategory, row: Record<string, unknown>): string {
  if (category === "flanges") return `${String(row.flange_type ?? "")}|${String(row.class ?? "")}`;
  if (category === "fittings") return String(row.fitting_type ?? "");
  if (category === "valves") return String(row.valve_type ?? "");
  return "";
}

// Groups by type (preserving each group's first-seen order -- the page's
// own top-to-bottom type ordering, e.g. Flange before Threaded Reducing
// Flange before Blind Flange, is real information, not noise to alphabetize
// away) then sorts each group by parsed NPS size ascending. A row whose
// size can't be parsed at all (e.g. a Gasket/Stud Bolt row with no size
// columns) sorts after every sized row in its own group.
function sortCategoryRows<T extends Record<string, unknown>>(category: SpecCategory, rows: T[]): T[] {
  const groupOrder: string[] = [];
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = typeGroupKey(category, row);
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
      groupOrder.push(key);
    }
    group.push(row);
  }
  const sizeKey = (row: T) => parseNpsInches(row.size_min) ?? Number.POSITIVE_INFINITY;
  return groupOrder.flatMap((key) => groups.get(key)!.slice().sort((a, b) => sizeKey(a) - sizeKey(b)));
}

// Repairs a dash-punctuated mixed fraction ("1-1/2", meant as one-and-a-half
// inches) that got stored as an inverted range (size_min="1", size_max=
// "1/2") -- see repairInvertedSizeRange's own comment (packages/shared/src/
// pipeSize.ts) for why this happens and why it's safe to recover
// deterministically. Runs on every already-extracted row so a class
// affected by this before the extraction-time fix existed self-heals the
// next time someone hits Recheck, without needing a fresh (paid, API-key-
// requiring) extraction pass.
function repairRowSizes<T extends Record<string, unknown>>(row: T): { row: T; repaired: boolean } {
  const { size_min, size_max } = repairInvertedSizeRange(row.size_min, row.size_max);
  if (size_min === row.size_min && size_max === row.size_max) return { row, repaired: false };
  return { row: { ...row, size_min, size_max }, repaired: true };
}

function rowSpan(row: Record<string, unknown>): { min: number; max: number } | null {
  const min = parseNpsInches(row.size_min);
  const max = parseNpsInches(row.size_max);
  if (min == null || max == null) return null;
  return { min, max };
}

function rowLabel(category: SpecCategory, row: Record<string, unknown>): string {
  const size = row.size_min === row.size_max ? String(row.size_min ?? "?") : `${row.size_min ?? "?"}-${row.size_max ?? "?"}`;
  const material = String(row.description ?? row.material ?? "").trim();
  const type = category === "pipes" ? "Pipe" : typeGroupKey(category, row) || category;
  return `${type} ${size}${material ? ` (${material})` : ""}`;
}

// Two SORTED rows in the same type group whose numeric NPS ranges intersect
// -- always a real problem regardless of domain convention (unlike a gap,
// there's no legitimate reason the same size should carry two different
// bands), so this is safe to re-check without the original column list.
function findOverlaps(category: SpecCategory, sortedRows: Array<Record<string, unknown>>): string[] {
  const issues: string[] = [];
  let prevKey: string | null = null;
  let prev: { row: Record<string, unknown>; span: { min: number; max: number } } | null = null;

  for (const row of sortedRows) {
    const key = typeGroupKey(category, row);
    const span = rowSpan(row);
    if (key !== prevKey) {
      prevKey = key;
      prev = span ? { row, span } : null;
      continue;
    }
    if (span && prev && span.min <= prev.span.max + 1e-9) {
      issues.push(`${rowLabel(category, prev.row)} overlaps ${rowLabel(category, row)} -- exactly one band should claim a given size.`);
    }
    if (span) prev = { row, span };
  }
  return issues;
}

// Same marker<->legend cross-check as the worker's validateNotesCoverage,
// re-run here since it needs nothing lost in storage -- every row's own
// `notes` field and the class's `notes_legend` are both still fully intact.
function collectNotesIssues(attrs: Record<string, unknown>): string[] {
  const notesLegend = (attrs.notes_legend as Array<{ letter: string; text: string }> | undefined) ?? [];
  const legendLetters = new Set(notesLegend.map((n) => n.letter.trim().toLowerCase()));
  const referenced = new Set<string>();
  const issues: string[] = [];

  for (const category of CATEGORIES) {
    const rows = (attrs[category] as Array<Record<string, unknown>> | undefined) ?? [];
    for (const row of rows) {
      const raw = String(row.notes ?? "").trim();
      if (!raw) continue;
      const letters = [...raw.matchAll(/note[s]?[\s-]*([a-z])\b/gi)].map((m) => m[1].toLowerCase());
      for (const letter of letters) {
        referenced.add(letter);
        if (!legendLetters.has(letter)) {
          issues.push(`${category}: notes "${raw}" references note "${letter}", which has no matching notes_legend entry -- genuine document gap or a missed legend row.`);
        }
      }
    }
  }
  for (const entry of notesLegend) {
    const letter = entry.letter.trim().toLowerCase();
    if (letter && !referenced.has(letter)) {
      issues.push(`notes_legend entry "${entry.letter}" ("${entry.text}") isn't referenced by any row's notes field -- check whether a row's marker was missed.`);
    }
  }
  return issues;
}

// Re-sorts every category into true ascending NPS order (within its own
// type group) and recomputes band_validation_issues/notes_validation_issues
// from that corrected data -- see the module comment for why gap-checking
// isn't part of this. Pure function: takes a class tag's current
// `attributes`, returns the replacement to write back.
export function revalidateSpecClassAttributes(attrs: Record<string, unknown>): RevalidatedClass {
  const next: Record<string, unknown> = { ...attrs };
  const overlapIssues: string[] = [];
  let repairedSizeCount = 0;

  for (const category of CATEGORIES) {
    const rows = (attrs[category] as Array<Record<string, unknown>> | undefined) ?? [];
    if (rows.length === 0) continue;
    const repairedRows = rows.map((row) => {
      const { row: fixed, repaired } = repairRowSizes(row);
      if (repaired) repairedSizeCount++;
      return fixed;
    });
    const sorted = sortCategoryRows(category, repairedRows);
    next[category] = sorted;
    // Valves routinely offer several distinct, legitimately co-existing
    // designs at the very same nominal size (e.g. Full Bore vs Reduced Bore
    // Ball, Lever- vs Gear-operated) -- confirmed on a real class where
    // this produced dozens of false "overlap" flags between two
    // perfectly valid valve options. specSheet.ts's own overlap check
    // (validateBandCoverage) never ran on valves for exactly this reason,
    // only pipes/fittings/flanges, so this recheck doesn't either.
    if (category === "valves") continue;
    overlapIssues.push(...findOverlaps(category, sorted));
  }

  const notesIssues = collectNotesIssues(next);
  next.band_validation_issues = overlapIssues;
  next.notes_validation_issues = notesIssues;

  return { attrs: next, issueCount: overlapIssues.length + notesIssues.length, repairedSizeCount };
}
