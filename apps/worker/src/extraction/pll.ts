import Anthropic from "@anthropic-ai/sdk";
import { LOCATE_PLL_SECTIONS_TOOL, PLL_TABLE_TOOL, buildSystemPrompt, buildNumberedText, sliceText, type PageRange } from "@easy/extraction-schemas";
import { normalizeSlope } from "@easy/shared";
import { callTool, callWithRetry } from "./claudeClient";
import type { DocTypeExtractor, TagDraft } from "./types";

interface LocatePllResult {
  line_table_pages: PageRange;
}

interface PllLineRow {
  line_number: string;
  fluid_code?: string;
  size?: string;
  spec_class?: string;
  insulation_code?: string;
  insulation_thickness?: string;
  from_location?: string;
  to_location?: string;
  design_pressure?: string;
  design_pressure_min?: string;
  design_temperature?: string;
  design_temperature_min?: string;
  operating_pressure?: string;
  operating_temperature?: string;
  test_pressure?: string;
  test_medium?: string;
  service?: string;
  heat_trace?: string;
  hold?: string;
  ndt_percent?: string;
  pwht?: string;
  paint_system?: string;
  corrosion_allowance?: string;
  slope?: string;
  pid_no?: string;
}

interface PllTableResult {
  lines: PllLineRow[];
}

const SYSTEM_PROMPT = buildSystemPrompt("Process Line List (PLL)");

// Spreadsheet cells holding two values (a line running to two destinations,
// a line shown on two P&IDs) arrive with embedded newlines, which are
// unreadable in the findings table and in stored JSON. Collapse them to
// " / " -- the same separator the tool schema asks Claude to use, applied
// defensively here so the stored data is consistent regardless.
export function normalizeCellValue(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const joined = value
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" / ");
  return joined || undefined;
}

function normalizeRow(row: PllLineRow): PllLineRow {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === "string" ? normalizeCellValue(value) : value;
  }
  return out as unknown as PllLineRow;
}

// PLLs are genuine tables with a real text layer (PDF) or come straight from
// a spreadsheet (CSV/XLSX, see pipeline.ts) -- same text-first
// locate -> extract shape as hmb.ts.
export const extractPllDocument: DocTypeExtractor = async (pages, apiKey, onProgress) => {
  const client = new Anthropic({ apiKey });
  const pageList = pages.map((p) => ({ pageNumber: p.pageNumber, pageText: p.pageText }));
  const fullText = buildNumberedText(pageList);

  const locate = await callWithRetry(() =>
    callTool<LocatePllResult>(client, {
      tool: LOCATE_PLL_SECTIONS_TOOL,
      systemPrompt: SYSTEM_PROMPT,
      userText: `${fullText}\n\nIdentify the line list table's page range via the locate_pll_sections tool call.`,
      maxTokens: 4000,
      useThinking: true,
    })
  );
  onProgress?.({ phase: "locate", current: 1, total: 1 });

  const tableText = sliceText(pageList, locate.line_table_pages) || fullText;
  const result = await callWithRetry(() =>
    callTool<PllTableResult>(client, {
      tool: PLL_TABLE_TOOL,
      systemPrompt: SYSTEM_PROMPT,
      userText:
        `${tableText}\n\nExtract every line list row via the record_pll_table tool call. ` +
        `Read each column's unit from its header and append it to the value (e.g. a "Design Temperature (°C)" cell of 310 becomes "310 °C"; ` +
        `a "Nominal Size (mm)" cell of 200 becomes "200 mm"; a "Hydrotest Pressure (barg)" cell of 225 becomes "225 barg"). ` +
        `Where a column is split into Minimum/Maximum sub-columns, put the maximum in the main field (e.g. design_temperature) and the minimum in the _min field. ` +
        `Where one cell holds more than one value, join them with " / " -- never a line break.`,
      maxTokens: 32000,
      useThinking: true,
    })
  );
  onProgress?.({ phase: "line_table", current: 1, total: 1 });

  const rows = (result.lines ?? []).map(normalizeRow);
  const tags: TagDraft[] = rows.map((line) => ({
    tagType: "line",
    tagNumber: line.line_number,
    attributes: {
      fluid_code: line.fluid_code,
      size: line.size,
      spec_class: line.spec_class,
      insulation_code: line.insulation_code,
      insulation_thickness: line.insulation_thickness,
      from_location: line.from_location,
      to_location: line.to_location,
      design_pressure: line.design_pressure,
      design_pressure_min: line.design_pressure_min,
      design_temperature: line.design_temperature,
      design_temperature_min: line.design_temperature_min,
      operating_pressure: line.operating_pressure,
      operating_temperature: line.operating_temperature,
      test_pressure: line.test_pressure,
      test_medium: line.test_medium,
      service: line.service,
      heat_trace: line.heat_trace,
      hold: line.hold,
      ndt_percent: line.ndt_percent,
      pwht: line.pwht,
      paint_system: line.paint_system,
      corrosion_allowance: line.corrosion_allowance,
      slope: normalizeSlope(line.slope),
      pid_no: line.pid_no,
    },
  }));

  return { rawJson: { lines: rows }, tags };
};
