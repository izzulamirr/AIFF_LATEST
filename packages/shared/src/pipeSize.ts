// NPS (nominal pipe size) string parsing, used by both apps/worker (branch
// table -> fittings size-range resolution during extraction) and apps/web
// (spec cross-check, display sort) -- see apps/worker/src/extraction/specSheet.ts
// and apps/web/src/lib/verifySpecCrossCheck.ts.

// Parses an NPS size string into decimal inches -- plain "36", decimal
// "1.5", the branch-table's dot-fraction "1.1/2", or a catalogue export's
// space-fraction "1 1/2"" -- all four notations have shown up in real
// documents in this project.
export function parseNpsInches(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/"/g, "").trim();
  if (!s) return null;
  const dotMixed = s.match(/^(\d+)\.(\d+)\/(\d+)$/);
  if (dotMixed) return Number(dotMixed[1]) + Number(dotMixed[2]) / Number(dotMixed[3]);
  const spaceMixed = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (spaceMixed) return Number(spaceMixed[1]) + Number(spaceMixed[2]) / Number(spaceMixed[3]);
  const frac = s.match(/^(\d+)\/(\d+)$/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const num = Number(s);
  return Number.isFinite(num) ? num : null;
}

// Recovers a size_min/size_max pair that a dash-punctuated mixed fraction
// (e.g. "1-1/2", meant as one-and-a-half inches) got mis-split into (e.g.
// size_min="1", size_max="1/2") -- confirmed on a real document (BC70N)
// where the model wrote this size as "1-1/2" for its Fittings/Flanges bands
// but correctly used the space form ("1 1/2") for the exact same size on
// that page's own Pipe bands, so the inconsistency is in what gets typed,
// not a fixed rule this can be prevented from ever happening again. A
// genuine size RANGE only ever ascends left-to-right (min <= max) -- no
// real range descends -- so whenever parsing the two sides the OTHER way
// produces min > max, the pair was never a range at all, just a
// mis-punctuated single size; rejoin the two halves with a space and use
// that as both bounds. Anything else (a genuine ascending range, or a pair
// that doesn't parse as NPS at all) passes through unchanged. Shared so
// both the worker's extraction-time expandBands (apps/worker/src/
// extraction/specSheet.ts) and the web app's no-Claude-call revalidation
// (apps/web/src/lib/revalidateSpecClass.ts) apply the exact same repair,
// the latter for data that was already extracted and stored before this
// fix existed.
export function repairInvertedSizeRange(sizeMin: unknown, sizeMax: unknown): { size_min: unknown; size_max: unknown } {
  const min = parseNpsInches(sizeMin);
  const max = parseNpsInches(sizeMax);
  if (min != null && max != null && min > max && typeof sizeMin === "string" && typeof sizeMax === "string") {
    const single = `${sizeMin.trim()} ${sizeMax.trim()}`;
    return { size_min: single, size_max: single };
  }
  return { size_min: sizeMin, size_max: sizeMax };
}
