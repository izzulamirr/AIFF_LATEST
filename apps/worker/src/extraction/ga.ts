import Anthropic from "@anthropic-ai/sdk";
import {
  LOCATE_GA_SECTIONS_TOOL,
  GA_SHEET_TOOL,
  buildSystemPrompt,
  buildNumberedText,
  sliceText,
  type PageRange,
} from "@easy/extraction-schemas";
import { callTool, callWithRetry } from "./claudeClient";
import type { DocTypeExtractor, TagDraft } from "./types";

interface LocateGaResult {
  sheets: Array<{ drawing_number: string; pages: PageRange }>;
}

interface GaSheetResult {
  pipe_routing: Array<{ line_number: string; size?: string; route_description?: string }>;
  supports?: Array<{ support_tag: string; support_type?: string; line_number?: string }>;
}

const SYSTEM_PROMPT = buildSystemPrompt("General Arrangement (GA) drawing");

export const extractGaDocument: DocTypeExtractor = async (pages, apiKey, onProgress) => {
  const client = new Anthropic({ apiKey });
  const pageList = pages.map((p) => ({ pageNumber: p.pageNumber, pageText: p.pageText }));
  const fullText = buildNumberedText(pageList);

  const locate = await callWithRetry(() =>
    callTool<LocateGaResult>(client, {
      tool: LOCATE_GA_SECTIONS_TOOL,
      systemPrompt: SYSTEM_PROMPT,
      userText: `${fullText}\n\nIdentify each GA sheet's page range via the locate_ga_sheets tool call.`,
      maxTokens: 8000,
      useThinking: true,
    })
  );

  if (!locate.sheets || locate.sheets.length === 0) {
    throw new Error("locate_ga_sheets found no sheets in this document.");
  }
  onProgress?.({ phase: "locate", current: 1, total: 1 });

  const allSheets: Array<{ drawing_number: string; result: GaSheetResult }> = [];
  for (let i = 0; i < locate.sheets.length; i++) {
    const sheet = locate.sheets[i];
    const sheetText = sliceText(pageList, sheet.pages);
    const result = await callWithRetry(() =>
      callTool<GaSheetResult>(client, {
        tool: GA_SHEET_TOOL,
        systemPrompt: SYSTEM_PROMPT,
        userText: `${sheetText}\n\nThis is GA sheet "${sheet.drawing_number}". Extract its pipe routing and support rows via the record_ga_sheet tool call.`,
        maxTokens: 16000,
        useThinking: true,
      })
    );
    allSheets.push({ drawing_number: sheet.drawing_number, result });
    onProgress?.({ phase: "sheet", current: i + 1, total: locate.sheets.length, detail: sheet.drawing_number });
  }

  const tags: TagDraft[] = [];
  for (const { drawing_number, result } of allSheets) {
    for (const route of result.pipe_routing ?? []) {
      tags.push({
        tagType: "line",
        tagNumber: route.line_number,
        attributes: { drawing_number, size: route.size, route_description: route.route_description },
      });
    }
    for (const support of result.supports ?? []) {
      tags.push({
        tagType: "support",
        tagNumber: support.support_tag,
        attributes: { drawing_number, support_type: support.support_type, line_number: support.line_number },
      });
    }
  }

  return { rawJson: { sheets: allSheets }, tags };
};
