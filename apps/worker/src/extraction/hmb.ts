import Anthropic from "@anthropic-ai/sdk";
import { LOCATE_HMB_SECTIONS_TOOL, HMB_STREAM_TABLE_TOOL, buildSystemPrompt, buildNumberedText, sliceText, type PageRange } from "@easy/extraction-schemas";
import { callTool, callWithRetry } from "./claudeClient";
import type { DocTypeExtractor, TagDraft } from "./types";

interface LocateHmbResult {
  stream_table_pages: PageRange;
}

interface HmbStreamTableResult {
  streams: Array<{
    stream_number: string;
    line_number?: string;
    flow_rate?: string;
    temperature?: string;
    pressure?: string;
    phase?: string;
    composition?: string;
  }>;
}

const SYSTEM_PROMPT = buildSystemPrompt("Heat & Mass Balance (H&MB)");

export const extractHmbDocument: DocTypeExtractor = async (pages, apiKey, onProgress) => {
  const client = new Anthropic({ apiKey });
  const pageList = pages.map((p) => ({ pageNumber: p.pageNumber, pageText: p.pageText }));
  const fullText = buildNumberedText(pageList);

  const locate = await callWithRetry(() =>
    callTool<LocateHmbResult>(client, {
      tool: LOCATE_HMB_SECTIONS_TOOL,
      systemPrompt: SYSTEM_PROMPT,
      userText: `${fullText}\n\nIdentify the stream table's page range via the locate_hmb_sections tool call.`,
      maxTokens: 4000,
      useThinking: true,
    })
  );
  onProgress?.({ phase: "locate", current: 1, total: 1 });

  const tableText = sliceText(pageList, locate.stream_table_pages) || fullText;
  const result = await callWithRetry(() =>
    callTool<HmbStreamTableResult>(client, {
      tool: HMB_STREAM_TABLE_TOOL,
      systemPrompt: SYSTEM_PROMPT,
      userText: `${tableText}\n\nExtract the stream table rows via the record_hmb_stream_table tool call.`,
      maxTokens: 16000,
      useThinking: true,
    })
  );
  onProgress?.({ phase: "stream_table", current: 1, total: 1 });

  const tags: TagDraft[] = (result.streams ?? []).map((stream) => ({
    tagType: "stream",
    tagNumber: stream.stream_number,
    attributes: {
      line_number: stream.line_number,
      flow_rate: stream.flow_rate,
      temperature: stream.temperature,
      pressure: stream.pressure,
      phase: stream.phase,
      composition: stream.composition,
    },
  }));

  return { rawJson: result, tags };
};
