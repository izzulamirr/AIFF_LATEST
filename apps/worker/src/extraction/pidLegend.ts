import Anthropic from "@anthropic-ai/sdk";
import { LOCATE_PID_LEGEND_SECTIONS_TOOL, PID_LEGEND_TOOL, buildSystemPrompt, buildNumberedText, sliceText, type PageRange } from "@easy/extraction-schemas";
import { callTool, callWithRetry } from "./claudeClient";
import { renderPdfPages } from "../pdfImages";
import type { DocTypeExtractor, TagDraft } from "./types";

interface LocatePidResult {
  sheets: Array<{ sheet_number?: string; drawing_title?: string; pages: PageRange }>;
}

interface PidLegendResult {
  items: Array<{ symbol: string; meaning: string; symbol_shape?: string; category?: string; applies_to?: string; implied_components?: string }>;
}

const SYSTEM_PROMPT = buildSystemPrompt("P&ID legend/symbols sheet");

function pageRangeToNumbers(range: PageRange): number[] {
  const numbers: number[] = [];
  for (let n = range.start; n <= range.end; n++) numbers.push(n);
  return numbers;
}

// A dedicated document type for standalone P&ID legend/symbols files (see
// apps/web's separate "Upload P&ID Legend" form) -- unlike pid.ts, every
// sheet here is treated as a legend sheet, no process/legend classification
// needed. Some projects spread the legend across many sheets (a real
// example referenced 19), so this still locates individual sheets first.
export const extractPidLegendDocument: DocTypeExtractor = async (pages, apiKey, onProgress, pdfBuffer) => {
  const client = new Anthropic({ apiKey });
  const pageList = pages.map((p) => ({ pageNumber: p.pageNumber, pageText: p.pageText }));
  const fullText = buildNumberedText(pageList);

  const allPageNumbers = pages.map((p) => p.pageNumber);
  const renderedPages = pdfBuffer ? await renderPdfPages(pdfBuffer, allPageNumbers) : [];
  const imageByPage = new Map(renderedPages.map((r) => [r.pageNumber, r.pngBase64]));

  // Images go to the locate call, not just the per-sheet calls: a CAD legend
  // PDF has no usable text layer, so a text-only locate is shown a blank
  // document and reports no sheets at all. pid.ts learned the same lesson.
  const locate = await callWithRetry(() =>
    callTool<LocatePidResult>(client, {
      tool: LOCATE_PID_LEGEND_SECTIONS_TOOL,
      systemPrompt: SYSTEM_PROMPT,
      userText: `${fullText}\n\nThe attached page image(s) are the actual sheets -- this document's text layer may be empty, so read them from the images. Every page here belongs to the legend. Identify each legend/symbols sheet's page range via the locate_pid_legend_sheets tool call.`,
      maxTokens: 8000,
      useThinking: true,
      images: renderedPages.map((r) => r.pngBase64),
    })
  );

  // Every page of a document uploaded AS a legend is a legend sheet, so a
  // locate that still comes back empty is a locate failure, not a document
  // without legend content -- fall back to one sheet per page rather than
  // discarding a document we know the type of.
  const locatedSheets =
    locate.sheets && locate.sheets.length > 0
      ? locate.sheets
      : allPageNumbers.map((n) => ({ sheet_number: `PAGE ${n}`, pages: { start: n, end: n } as PageRange }));
  onProgress?.({ phase: "locate", current: 1, total: 1 });

  const allSheets: Array<{ sheet_number: string; result: PidLegendResult }> = [];
  for (let i = 0; i < locatedSheets.length; i++) {
    const sheet = locatedSheets[i];
    const sheetNumber = sheet.sheet_number?.trim() || `PAGE ${sheet.pages.start}`;
    const sheetText = sliceText(pageList, sheet.pages);
    const sheetImages = pageRangeToNumbers(sheet.pages)
      .map((n) => imageByPage.get(n))
      .filter((img): img is string => Boolean(img));
    const result = await callWithRetry(() =>
      callTool<PidLegendResult>(client, {
        tool: PID_LEGEND_TOOL,
        systemPrompt: SYSTEM_PROMPT,
        userText:
          `${sheetText}\n\nThis is legend/symbols sheet "${sheetNumber}". The attached page image is the actual sheet -- read each symbol and its meaning directly from the image.\n\n` +
          `Sweep the WHOLE sheet systematically: go column by column, table by table, top to bottom, and record EVERY row of EVERY table until the end -- line notation, equipment tag identification format decoders and their letter tables, pipe identification code decoder and ALL its sub-tables (service codes, class flange ratings, piping materials, corrosion allowance, valve end connections, tracing/insulation), abbreviations, valve symbols, in-line symbols, safety devices, primary elements, instrument bubble/mounting symbols, the instrument identification letter table (record as "INSTRUMENT LETTER A" ... "INSTRUMENT LETTER Z", capturing both the first-letter variable meaning and the succeeding-letter function meaning), tag prefix numbers, equipment shapes, "P&ID REPRESENTATION vs DETAILS" typicals (with applies_to and implied_components), and the numbered NOTES. ` +
          `For EVERY symbol also fill symbol_shape with a literal description of the glyph -- gate, ball and globe valves are all a bowtie and differ only by the centre marking (empty / open circle / solid filled circle), so a name without a shape cannot tell them apart later. ` +
          `Use the category vocabulary from the tool schema exactly. A sheet like this holds 100-300 items -- completeness matters more than brevity; do not stop early.\n\n` +
          `Extract every definition via the record_pid_legend tool call.`,
        maxTokens: 32000,
        useThinking: true,
        images: sheetImages,
      })
    );
    allSheets.push({ sheet_number: sheetNumber, result });
    onProgress?.({ phase: "sheet", current: i + 1, total: locatedSheets.length, detail: sheetNumber });
  }

  const tags: TagDraft[] = [];
  for (const { sheet_number, result } of allSheets) {
    for (const item of result.items ?? []) {
      tags.push({
        tagType: "legend_item",
        tagNumber: item.symbol,
        attributes: {
          sheet_number,
          meaning: item.meaning,
          symbol_shape: item.symbol_shape,
          category: item.category,
          applies_to: item.applies_to,
          implied_components: item.implied_components,
        },
      });
    }
  }

  return { rawJson: { sheets: allSheets }, tags };
};