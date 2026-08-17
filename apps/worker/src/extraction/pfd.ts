import Anthropic from "@anthropic-ai/sdk";
import { LOCATE_PFD_SECTIONS_TOOL, PFD_SHEET_TOOL, buildSystemPrompt, buildNumberedText, sliceText, type PageRange } from "@easy/extraction-schemas";
import { callTool, callWithRetry } from "./claudeClient";
import type { DocTypeExtractor, TagDraft } from "./types";

interface LocatePfdResult {
  sheets: Array<{ sheet_number: string; process_area?: string; pages: PageRange }>;
}

interface PfdSheetResult {
  equipment: Array<{ tag_number: string; equipment_type?: string; description?: string }>;
  streams?: Array<{ stream_number: string; design_temp?: string; design_pressure?: string }>;
}

const SYSTEM_PROMPT = buildSystemPrompt("PFD (Process Flow Diagram)");

export const extractPfdDocument: DocTypeExtractor = async (pages, apiKey, onProgress) => {
  const client = new Anthropic({ apiKey });
  const pageList = pages.map((p) => ({ pageNumber: p.pageNumber, pageText: p.pageText }));
  const fullText = buildNumberedText(pageList);

  const locate = await callWithRetry(() =>
    callTool<LocatePfdResult>(client, {
      tool: LOCATE_PFD_SECTIONS_TOOL,
      systemPrompt: SYSTEM_PROMPT,
      userText: `${fullText}\n\nIdentify each PFD sheet's page range via the locate_pfd_sheets tool call.`,
      maxTokens: 8000,
      useThinking: true,
    })
  );

  if (!locate.sheets || locate.sheets.length === 0) {
    throw new Error("locate_pfd_sheets found no sheets in this document.");
  }
  onProgress?.({ phase: "locate", current: 1, total: 1 });

  const allSheets: Array<{ sheet_number: string; result: PfdSheetResult }> = [];
  for (let i = 0; i < locate.sheets.length; i++) {
    const sheet = locate.sheets[i];
    const sheetText = sliceText(pageList, sheet.pages);
    const result = await callWithRetry(() =>
      callTool<PfdSheetResult>(client, {
        tool: PFD_SHEET_TOOL,
        systemPrompt: SYSTEM_PROMPT,
        userText: `${sheetText}\n\nThis is PFD sheet "${sheet.sheet_number}". Extract its equipment/streams via the record_pfd_sheet tool call.`,
        maxTokens: 16000,
        useThinking: true,
      })
    );
    allSheets.push({ sheet_number: sheet.sheet_number, result });
    onProgress?.({ phase: "sheet", current: i + 1, total: locate.sheets.length, detail: sheet.sheet_number });
  }

  const tags: TagDraft[] = [];
  for (const { sheet_number, result } of allSheets) {
    for (const equipment of result.equipment ?? []) {
      tags.push({ tagType: "equipment", tagNumber: equipment.tag_number, attributes: { sheet_number, equipment_type: equipment.equipment_type, description: equipment.description } });
    }
    for (const stream of result.streams ?? []) {
      tags.push({ tagType: "stream", tagNumber: stream.stream_number, attributes: { sheet_number, design_temp: stream.design_temp, design_pressure: stream.design_pressure } });
    }
  }

  return { rawJson: { sheets: allSheets }, tags };
};
