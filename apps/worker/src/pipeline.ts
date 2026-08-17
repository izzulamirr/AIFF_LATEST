// Orchestrates one document's extraction end to end: download from Storage,
// extract page text, run the doc-type-specific Claude extractor, persist
// extraction_results + extracted_tags, and keep extraction_jobs updated with
// live progress (polled by apps/web, same onProgress-callback style as
// AIFF's electron/specExtraction.js).
import { eq } from "drizzle-orm";
import type { createDb } from "@easy/db";
import { documents, documentPages, extractionJobs, extractionResults, extractedTags } from "@easy/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DocType } from "@easy/shared";
import { extractPdfPages } from "./pdfText";
import { extractXlsxPages } from "./spreadsheetText";
import { EXTRACTORS } from "./extraction";
import { normalizeTagNumber } from "./correlate";

type Db = ReturnType<typeof createDb>;

const STORAGE_BUCKET = "documents";

export async function runExtractionJob(db: Db, storage: SupabaseClient, jobId: string, documentId: string, apiKey: string) {
  await db.update(extractionJobs).set({ status: "running", startedAt: new Date() }).where(eq(extractionJobs.id, jobId));

  try {
    const [document] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
    if (!document) throw new Error(`Document ${documentId} not found`);

    const { data: fileData, error: downloadError } = await storage.storage.from(STORAGE_BUCKET).download(document.storagePath);
    if (downloadError || !fileData) throw new Error(`Failed to download ${document.storagePath}: ${downloadError?.message}`);

    const buffer = Buffer.from(await fileData.arrayBuffer());

    // CSVs/XLSXs (e.g. a line list exported from Excel) skip PDF parsing
    // entirely -- a CSV becomes one text "page", an XLSX one page per
    // worksheet -- which the text-based extractors (PLL/H&MB/spec) consume
    // as-is.
    const lowerName = document.fileName.toLowerCase();
    const isCsv = lowerName.endsWith(".csv");
    const isXlsx = lowerName.endsWith(".xlsx");
    const pages = isCsv
      ? [{ pageNumber: 1, pageText: buffer.toString("utf8") }]
      : isXlsx
        ? await extractXlsxPages(buffer)
        : await extractPdfPages(buffer);

    // Re-runs (job retries, re-uploads after a failure) must replace any
    // rows left behind by an earlier attempt, or the unique constraints
    // below reject the whole run.
    await db.delete(documentPages).where(eq(documentPages.documentId, documentId));
    await db.delete(extractedTags).where(eq(extractedTags.documentId, documentId));

    // Persist page text (mirrors AIFF's spec_training_document_pages capture)
    if (pages.length > 0) {
      await db.insert(documentPages).values(
        pages.map((p) => ({ documentId, pageNumber: p.pageNumber, pageText: p.pageText }))
      );
    }
    await db.update(documents).set({ pageCount: pages.length }).where(eq(documents.id, documentId));

    const extractor = EXTRACTORS[document.docType as DocType];
    if (!extractor) throw new Error(`No extractor registered for doc type "${document.docType}"`);

    const result = await extractor(
      pages,
      apiKey,
      async (evt) => {
        await db
          .update(extractionJobs)
          .set({ progressPhase: evt.phase, progressCurrent: evt.current, progressTotal: evt.total })
          .where(eq(extractionJobs.id, jobId));
      },
      // Page-image rendering (used by the ISO and P&ID extractors) only
      // makes sense for PDFs -- a CSV/XLSX buffer would crash pdfjs.
      isCsv || isXlsx ? undefined : buffer,
      { db, projectId: document.projectId }
    );

    await db.insert(extractionResults).values({
      documentId,
      extractionJobId: jobId,
      schemaVersion: `${document.docType}.v1`,
      rawJson: result.rawJson as object,
    });

    if (result.tags.length > 0) {
      await db.insert(extractedTags).values(
        result.tags.map((tag) => ({
          projectId: document.projectId,
          documentId,
          docType: document.docType,
          tagType: tag.tagType,
          tagNumber: tag.tagNumber,
          tagNumberNormalized: normalizeTagNumber(tag.tagNumber),
          sourcePage: tag.sourcePage ?? null,
          attributes: tag.attributes as object,
        }))
      );
    }

    await db.update(extractionJobs).set({ status: "succeeded", finishedAt: new Date() }).where(eq(extractionJobs.id, jobId));
  } catch (err) {
    await db
      .update(extractionJobs)
      .set({ status: "failed", finishedAt: new Date(), errorMessage: err instanceof Error ? err.message : String(err) })
      .where(eq(extractionJobs.id, jobId));
    throw err;
  }
}
