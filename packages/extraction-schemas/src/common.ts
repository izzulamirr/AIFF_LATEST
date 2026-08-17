// Shared building blocks for the per-document-type extraction schemas.
// Generalizes electron/specExtraction.js's proven locate -> per-section
// extract -> merge pipeline (built for AIFF's spec sheets) to P&ID/H&MB/PFD.
import type Anthropic from "@anthropic-ai/sdk";

export type ClaudeTool = Anthropic.Tool;

export const PAGE_RANGE_SCHEMA = {
  type: "object" as const,
  properties: {
    start: { type: "integer" as const },
    end: { type: "integer" as const },
  },
  required: ["start", "end"],
};

export interface PageRange {
  start: number;
  end: number;
}

// Same system prompt shape as AIFF's SYSTEM_PROMPT, generalized across
// document types instead of being spec-sheet-specific.
export function buildSystemPrompt(docTypeLabel: string) {
  return (
    `You are extracting structured data from a ${docTypeLabel} document for an engineering QA tool. ` +
    "Layouts vary between documents and authoring tools. Read the provided text carefully and call the " +
    "requested tool exactly once with as complete and accurate a structured extraction as possible. Use the " +
    "exact tag numbers and values as printed in the document. Leave a field null if the document does not " +
    "specify it -- never invent data."
  );
}

// Marker convention used when building page-numbered text from
// apps/worker's pdfText.ts, matching AIFF's `=== Page N ===` convention so
// the locate step's page numbers are unambiguous.
export function buildNumberedText(pages: Array<{ pageNumber: number; pageText: string | null }>): string {
  return pages.map((p) => `=== Page ${p.pageNumber} ===\n${p.pageText ?? ""}`).join("\n\n");
}

export function sliceText(pages: Array<{ pageNumber: number; pageText: string | null }>, range: PageRange | null | undefined): string {
  if (!range) return "";
  return pages
    .filter((p) => p.pageNumber >= range.start && p.pageNumber <= range.end)
    .map((p) => `=== Page ${p.pageNumber} ===\n${p.pageText ?? ""}`)
    .join("\n\n");
}
