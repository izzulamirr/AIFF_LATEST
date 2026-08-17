// Cross-document tag normalization, used by both apps/worker (correlation
// during extraction) and apps/web (on-demand ISO verification) -- see
// apps/worker/src/correlate.ts and apps/web/src/lib/verifyIso.ts.

export function normalizeTagNumber(raw: string, stripPattern?: RegExp): string {
  const stripped = stripPattern ? raw.replace(stripPattern, "") : raw;
  return stripped.trim().toUpperCase();
}

// Default strip pattern: collapse hyphens/spaces so "L-1024" / "L 1024" /
// "L1024" normalize to the same key. Override per-organization later if a
// client's numbering convention needs something more specific.
export const DEFAULT_STRIP_PATTERN = /[-\s]/g;

// Slope is written many ways on drawings and line lists -- "1:100",
// "1 IN 100", "1/100", or embedded in a note like "SLOPE 1:100 TOWARDS
// V-101". Pull out the ratio and canonicalize to "1:100" so an ISO
// annotation and a PLL column entry compare as equal. When no ratio is
// present (e.g. "FREE DRAINING", "SELF-DRAINING"), the trimmed original is
// returned so it still compares as plain text.
export function normalizeSlope(raw: string | undefined | null): string | undefined {
  if (raw == null) return undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  const ratio = text.match(/(\d+(?:\.\d+)?)\s*(?::|\/|\bin\b)\s*(\d+(?:\.\d+)?)/i);
  if (ratio) return `${ratio[1]}:${ratio[2]}`;
  return text;
}
