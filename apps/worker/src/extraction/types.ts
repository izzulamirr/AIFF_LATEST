import type { DocType, TagType } from "@easy/shared";
import type { createDb } from "@easy/db";
import type { ExtractedPage } from "../pdfText";

type Db = ReturnType<typeof createDb>;

// Lets an extractor look up other documents already extracted in the same
// project -- e.g. the P&ID extractor consults the project's uploaded
// legend/symbols sheet (if any) so valve/instrument symbols are read per
// that project's own definitions rather than generic assumptions.
export interface ExtractionContext {
  db: Db;
  projectId: string;
}

export interface ExtractionProgress {
  phase: string;
  current: number;
  total: number;
  detail?: string;
}

export type OnProgress = (evt: ExtractionProgress) => void;

// One row destined for extracted_tags -- the shape-agnostic cross-document
// join surface (see architecture plan section on correlation).
export interface TagDraft {
  tagType: TagType;
  tagNumber: string;
  sourcePage?: number | null;
  attributes: Record<string, unknown>;
}

export interface DocumentExtractionResult {
  rawJson: unknown; // full-fidelity extraction, stored in extraction_results
  tags: TagDraft[]; // flattened for extracted_tags
}

export interface DocTypeExtractor {
  // pdfBuffer lets an extractor render page images for Claude's vision input
  // when the document's text layer is insufficient (see pdfImages.ts) --
  // used by ISO and P&ID's extractors, other extractors ignore it.
  // context is only used by P&ID's extractor so far (project legend lookup).
  (pages: ExtractedPage[], apiKey: string, onProgress?: OnProgress, pdfBuffer?: Buffer, context?: ExtractionContext): Promise<DocumentExtractionResult>;
}

export type ExtractorRegistry = Record<DocType, DocTypeExtractor>;
