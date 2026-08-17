// Cross-document correlation: normalizes tag numbers so the same
// real-world line/equipment/instrument can be matched across structurally
// different document types (P&ID, H&MB, PFD, spec sheet), per the
// architecture plan's section 3.2.
//
// Phase 1 keeps this deliberately simple (exact match on a normalized
// string) -- near-miss/fuzzy matching is intentionally NOT auto-joined; it
// should surface as a separate "possible match, needs confirmation" finding
// once Phase 2's rule engine exists, rather than risk a silent false join.

// normalizeTagNumber/DEFAULT_STRIP_PATTERN moved to @easy/shared so
// apps/web's on-demand ISO verification can reuse the same normalization
// without duplicating it -- re-exported here so existing imports from
// "./correlate" keep working.
export { normalizeTagNumber, DEFAULT_STRIP_PATTERN } from "@easy/shared";

export interface CorrelatableTag {
  id: number;
  documentId: string;
  docType: string;
  tagType: string;
  tagNumber: string;
  tagNumberNormalized: string;
  attributes: Record<string, unknown>;
}

export interface MatchedGroup {
  tagNumberNormalized: string;
  tags: CorrelatableTag[];
}

// Groups tags by normalized tag number across doc types within a project.
// A group with tags from >1 distinct docType is a genuine cross-document
// match candidate; a group with only 1 tag is unmatched (nothing to
// cross-check yet, not itself a finding).
export function groupByNormalizedTag(tags: CorrelatableTag[]): MatchedGroup[] {
  const byKey = new Map<string, CorrelatableTag[]>();
  for (const tag of tags) {
    const existing = byKey.get(tag.tagNumberNormalized);
    if (existing) existing.push(tag);
    else byKey.set(tag.tagNumberNormalized, [tag]);
  }
  return Array.from(byKey.entries()).map(([tagNumberNormalized, groupTags]) => ({ tagNumberNormalized, tags: groupTags }));
}
