// Plain-text extraction from an uploaded engineering document PDF, page by
// page. Same approach proven in AIFF's electron/pdfText.js: pdfjs-dist's
// legacy Node build, tolerant of a page whose text layer fails (a scanned
// image page, or a corrupt page) rather than aborting the whole document.
import { readFile } from "node:fs/promises";
// Must come before the pdf.js require -- see pdfPolyfills.ts.
import "./pdfPolyfills";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

export interface ExtractedPage {
  pageNumber: number;
  pageText: string | null;
}

export async function extractPdfPages(filePathOrBuffer: string | Buffer): Promise<ExtractedPage[]> {
  const data = Buffer.isBuffer(filePathOrBuffer) ? new Uint8Array(filePathOrBuffer) : new Uint8Array(await readFile(filePathOrBuffer));
  const pdf = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;

  const pages: ExtractedPage[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    try {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item: { str?: string }) => item.str ?? "").join(" ").trim();
      pages.push({ pageNumber, pageText: pageText || null });
    } catch (err) {
      // A single corrupt/scanned-image-only page shouldn't abort capture for
      // the rest of the document -- P&IDs/PFDs in particular may mix
      // vector-text sheets with the occasional scanned cover sheet.
      pages.push({ pageNumber, pageText: null });
    }
  }
  return pages;
}
