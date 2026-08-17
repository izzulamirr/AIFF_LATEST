// Converts an .xlsx workbook into per-sheet text "pages" for the text-based
// extractors (PLL/H&MB/spec) -- each worksheet becomes one page of
// tab-separated rows, so Claude sees the same tabular text it would get
// from a CSV export of that sheet.
import ExcelJS from "exceljs";
import type { ExtractedPage } from "./pdfText";

export async function extractXlsxPages(buffer: Buffer): Promise<ExtractedPage[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const pages: ExtractedPage[] = [];
  // Sequential numbering, NOT ExcelJS's sheetId -- workbook-internal sheet
  // ids can repeat or skip (sheets deleted/copied in Excel), which violated
  // document_pages' (document_id, page_number) unique constraint on a real
  // upload.
  workbook.eachSheet((sheet) => {
    const rows: string[] = [`[Worksheet: ${sheet.name}]`];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        cells.push(cell.text ?? "");
      });
      rows.push(cells.join("\t"));
    });
    pages.push({ pageNumber: pages.length + 1, pageText: rows.join("\n").trim() || null });
  });
  return pages;
}
