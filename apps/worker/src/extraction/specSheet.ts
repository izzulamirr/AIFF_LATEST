import Anthropic from "@anthropic-ai/sdk";
import {
  LOCATE_SPEC_SECTIONS_TOOL,
  SPEC_CLASS_INDEX_TOOL,
  SPEC_CLASS_DETAIL_TOOL,
  SPEC_BRANCH_TABLES_TOOL,
  buildSystemPrompt,
  buildNumberedText,
  sliceText,
  type PageRange,
} from "@easy/extraction-schemas";
import { callTool, callWithRetry } from "./claudeClient";
import type { DocTypeExtractor, TagDraft } from "./types";
import { normalizeSpecClassCode } from "../verifySpecCrossCheck";

// Direct generalization of AIFF's electron/specExtraction.js pipeline
// (locate -> class index -> per-class detail -> branch tables -> merge).
// Unlike P&ID/PFD, spec sheets don't carry physical tag numbers -- they
// define per-class-size-range rules. Each class_code becomes a
// tagType: "spec_class" row so rule evaluation can join a P&ID/PFD line's
// spec_class field against this class's rules (see types.ts's TagType doc
// comment).

interface LocateSpecResult {
  class_index_pages?: PageRange;
  classes: Array<{ class_code: string; detail_pages: PageRange }>;
  branch_table_pages?: PageRange;
}

interface SpecClassIndexResult {
  classes: Array<Record<string, unknown> & { class_code: string }>;
}

interface SpecClassDetailResult {
  pipes?: Array<Record<string, unknown>>;
  fittings?: Array<Record<string, unknown>>;
  flanges?: Array<Record<string, unknown>>;
  valves?: Array<Record<string, unknown>>;
}

interface SpecBranchTablesResult {
  branch_tables: Array<Record<string, unknown>>;
}

const SYSTEM_PROMPT = buildSystemPrompt("Piping Material Specification");

export const extractSpecSheetDocument: DocTypeExtractor = async (pages, apiKey, onProgress) => {
  const client = new Anthropic({ apiKey });
  const pageList = pages.map((p) => ({ pageNumber: p.pageNumber, pageText: p.pageText }));
  const fullText = buildNumberedText(pageList);

  const locate = await callWithRetry(() =>
    callTool<LocateSpecResult>(client, {
      tool: LOCATE_SPEC_SECTIONS_TOOL,
      systemPrompt: SYSTEM_PROMPT,
      userText: `${fullText}\n\nIdentify the section page ranges via the locate_spec_sections tool call.`,
      maxTokens: 8000,
      useThinking: true,
    })
  );

  if (!locate.classes || locate.classes.length === 0) {
    throw new Error("locate_spec_sections found no classes in this document.");
  }
  onProgress?.({ phase: "locate", current: 1, total: 1 });

  const classIndexText = locate.class_index_pages ? sliceText(pageList, locate.class_index_pages) : fullText;
  const classIndex = await callWithRetry(() =>
    callTool<SpecClassIndexResult>(client, {
      tool: SPEC_CLASS_INDEX_TOOL,
      systemPrompt: SYSTEM_PROMPT,
      userText: `${classIndexText}\n\nExtract the Piping Class Index rows via the record_class_index tool call.`,
      maxTokens: 16000,
      useThinking: true,
    })
  );
  onProgress?.({ phase: "class_index", current: 1, total: 1 });

  const detailByClass = new Map<string, SpecClassDetailResult>();
  for (let i = 0; i < locate.classes.length; i++) {
    const cls = locate.classes[i];
    const detailText = sliceText(pageList, cls.detail_pages);
    const detail = await callWithRetry(() =>
      callTool<SpecClassDetailResult>(client, {
        tool: SPEC_CLASS_DETAIL_TOOL,
        systemPrompt: SYSTEM_PROMPT,
        userText: `${detailText}\n\nThis is the detailed datasheet for piping class "${cls.class_code}". Extract its pipe/fitting/flange/valve rows via the record_class_detail tool call.`,
        maxTokens: 16000,
        useThinking: true,
      })
    );
    detailByClass.set(normalizeSpecClassCode(cls.class_code), detail);
    onProgress?.({ phase: "class_detail", current: i + 1, total: locate.classes.length, detail: cls.class_code });
  }

  let branchTables: Array<Record<string, unknown>> = [];
  if (locate.branch_table_pages) {
    const branchText = sliceText(pageList, locate.branch_table_pages);
    const branchResult = await callWithRetry(() =>
      callTool<SpecBranchTablesResult>(client, {
        tool: SPEC_BRANCH_TABLES_TOOL,
        systemPrompt: SYSTEM_PROMPT,
        userText: `${branchText}\n\nExtract the branch table matrix rows via the record_branch_tables tool call.`,
        maxTokens: 16000,
        useThinking: true,
      })
    );
    branchTables = branchResult.branch_tables ?? [];
  }
  onProgress?.({ phase: "branch_tables", current: 1, total: 1 });

  const tags: TagDraft[] = classIndex.classes.map((cls) => {
    const detail = detailByClass.get(normalizeSpecClassCode(cls.class_code));
    return {
      tagType: "spec_class",
      tagNumber: cls.class_code,
      attributes: {
        ...cls,
        pipes: detail?.pipes ?? [],
        fittings: detail?.fittings ?? [],
        flanges: detail?.flanges ?? [],
        valves: detail?.valves ?? [],
      },
    };
  });

  return {
    rawJson: { classes: classIndex.classes, detail: Object.fromEntries(detailByClass), branch_tables: branchTables },
    tags,
  };
};
