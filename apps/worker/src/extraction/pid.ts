import Anthropic from "@anthropic-ai/sdk";
import { eq, and, inArray, desc } from "drizzle-orm";
import { documents, extractedTags } from "@easy/db";
import {
  LOCATE_PID_SECTIONS_TOOL,
  PID_SHEET_TOOL,
  PID_LEGEND_TOOL,
  buildSystemPrompt,
  buildNumberedText,
  sliceText,
  type PageRange,
} from "@easy/extraction-schemas";
import { normalizeSlope } from "@easy/shared";
import { callTool, callWithRetry } from "./claudeClient";
import { renderPdfPages, renderPdfPageTiles } from "../pdfImages";
import type { DocTypeExtractor, ExtractionContext, TagDraft } from "./types";

interface LocatePidResult {
  sheets: Array<{ sheet_number: string; drawing_title?: string; sheet_type?: "process" | "legend"; pages: PageRange }>;
}

interface PidSheetResult {
  lines: Array<{
    line_number: string;
    size?: string;
    spec_class?: string;
    service?: string;
    from_equipment?: string;
    to_equipment?: string;
    slope?: string;
    continues_on?: string;
  }>;
  valves?: Array<{
    tag_number?: string;
    valve_type?: string;
    line_number?: string;
    size?: string;
    spec_class?: string;
    quantity?: string;
  }>;
  fittings?: Array<{
    fitting_type: string;
    line_number?: string;
    size?: string;
    spec_class?: string;
    spec_break_to?: string;
    quantity?: string;
  }>;
  instruments?: Array<{
    tag_number: string;
    instrument_type?: string;
    line_or_equipment_ref?: string;
    parent_valve?: string;
    parent_instrument?: string;
  }>;
}

interface PidLegendResult {
  items: Array<{ symbol: string; meaning: string; category?: string; applies_to?: string; implied_components?: string }>;
}

const SYSTEM_PROMPT = buildSystemPrompt("P&ID (Piping & Instrumentation Diagram)");

function pageRangeToNumbers(range: PageRange): number[] {
  const numbers: number[] = [];
  for (let n = range.start; n <= range.end; n++) numbers.push(n);
  return numbers;
}

// A project is meant to hold ONE legend. If it holds more (a re-upload, a
// duplicate left behind by a failed run), merging them produces a single
// dictionary containing two definitions of the same symbol, and the model is
// silently asked to reconcile them. The newest legend document wins instead.
async function scopeToNewestLegendDocument<T extends { documentId: string }>(
  db: NonNullable<ExtractionContext>["db"],
  legendTags: T[]
): Promise<T[]> {
  const documentIds = [...new Set(legendTags.map((t) => t.documentId))];
  if (documentIds.length <= 1) return legendTags;

  const [newest] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(inArray(documents.id, documentIds))
    .orderBy(desc(documents.uploadedAt))
    .limit(1);
  if (!newest) return legendTags;

  console.warn(
    `[pid] project has ${documentIds.length} legend documents -- using only the newest (${newest.id}) so one project's legend is not merged with another copy`
  );
  return legendTags.filter((t) => t.documentId === newest.id);
}

export const extractPidDocument: DocTypeExtractor = async (pages, apiKey, onProgress, pdfBuffer, context) => {
  const client = new Anthropic({ apiKey });
  const pageList = pages.map((p) => ({ pageNumber: p.pageNumber, pageText: p.pageText }));
  const fullText = buildNumberedText(pageList);

  // Valve/instrument TYPE is conveyed by symbol shape, not text, so every
  // sheet is read from a rendered image, not text alone (confirmed
  // necessary the same way the ISO title block was: symbol-to-meaning
  // association doesn't survive plain text extraction). Rendered before the
  // locate call so it, too, reads the title block visually -- a text-only
  // locate misread a connector box's "0011" as the drawing number on a real
  // sheet whose title block says "...PID-0010".
  const allPageNumbers = pages.map((p) => p.pageNumber);
  const renderedPages = pdfBuffer ? await renderPdfPages(pdfBuffer, allPageNumbers) : [];
  const imageByPage = new Map(renderedPages.map((r) => [r.pageNumber, r.pngBase64]));
  const tilesByPage = pdfBuffer ? await renderPdfPageTiles(pdfBuffer, allPageNumbers) : [];

  const locate = await callWithRetry(() =>
    callTool<LocatePidResult>(client, {
      tool: LOCATE_PID_SECTIONS_TOOL,
      systemPrompt: SYSTEM_PROMPT,
      userText: `${fullText}\n\nThe attached page image(s) are the actual drawings. Identify each P&ID sheet's page range and type via the locate_pid_sheets tool call. Read each sheet_number from the TITLE BLOCK in the bottom-right corner of its page image -- never from an off-page connector box or a reference in the notes.`,
      maxTokens: 8000,
      useThinking: true,
      images: renderedPages.map((r) => r.pngBase64),
    })
  );

  if (!locate.sheets || locate.sheets.length === 0) {
    throw new Error("locate_pid_sheets found no sheets in this document.");
  }
  onProgress?.({ phase: "locate", current: 1, total: 1 });

  // If this project already has a legend/symbols sheet extracted (from any
  // P&ID document, not just this one), give Claude that project's own
  // symbol definitions so a project that customizes symbols is read
  // correctly instead of by generic assumption.
  let legendContext = "";
  if (context) {
    const allLegendTags = await context.db
      .select()
      .from(extractedTags)
      // Not filtered by docType: a project's legend may come from an inline
      // legend sheet within a "pid" document, or from the dedicated
      // "pid_legend" upload -- either way it's the same tagType. Always
      // scoped to THIS project: a legend is a project's own symbol
      // dictionary, and one project's symbols must never define another's.
      .where(and(eq(extractedTags.projectId, context.projectId), eq(extractedTags.tagType, "legend_item")));
    const legendTags = await scopeToNewestLegendDocument(context.db, allLegendTags);
    if (legendTags.length > 0) {
      // Grouped by category so the model can consult the right table (valve
      // symbols vs instrument letters vs line notation...) instead of
      // scanning one flat 300-line dump.
      const byCategory = new Map<string, string[]>();
      for (const t of legendTags) {
        const attrs = t.attributes as Record<string, unknown>;
        const category = typeof attrs.category === "string" && attrs.category ? attrs.category : "general";
        // The shape is the whole point for symbol families that share a name
        // pattern: gate/ball/globe are one bowtie differing only by the centre
        // marking, so a name-only context gives nothing to discriminate with.
        let line = `${t.tagNumber} = ${attrs.meaning}`;
        if (typeof attrs.symbol_shape === "string" && attrs.symbol_shape) {
          line += ` [drawn as: ${attrs.symbol_shape}]`;
        }
        if (typeof attrs.implied_components === "string" && attrs.implied_components) {
          line += ` [applies to: ${attrs.applies_to ?? "?"}; implies on ISO: ${attrs.implied_components}]`;
        }
        const list = byCategory.get(category) ?? [];
        list.push(line);
        byCategory.set(category, list);
      }
      const sections = [...byCategory.entries()].map(([category, lines]) => `### ${category}\n${lines.join("\n")}`);
      legendContext = `\n\nThis project's P&ID legend defines the following symbols/abbreviations, grouped by category -- use these definitions, not generic assumptions, when identifying valve_type/instrument_type, decoding line numbers, and reading equipment shapes:\n\n${sections.join("\n\n")}`;
    }
  }

  const allSheets: Array<{ sheet_number: string; result: PidSheetResult }> = [];
  const legendSheets: Array<{ sheet_number: string; result: PidLegendResult }> = [];

  for (let i = 0; i < locate.sheets.length; i++) {
    const sheet = locate.sheets[i];
    const sheetText = sliceText(pageList, sheet.pages);
    const sheetPageNumbers = pageRangeToNumbers(sheet.pages);
    const sheetImages = sheetPageNumbers.map((n) => imageByPage.get(n)).filter((img): img is string => Boolean(img));
    // Process sheets go out as the whole sheet PLUS overlapping tiles: the
    // full view carries the layout and how lines connect, the tiles carry
    // enough resolution to read a valve's centre marking (see
    // renderPdfPageTiles). Legend sheets stay whole-sheet -- their symbols are
    // drawn large in a table and were already read correctly.
    const sheetTiles = tilesByPage.filter((t) => sheetPageNumbers.includes(t.pageNumber));

    if (sheet.sheet_type === "legend") {
      const result = await callWithRetry(() =>
        callTool<PidLegendResult>(client, {
          tool: PID_LEGEND_TOOL,
          systemPrompt: SYSTEM_PROMPT,
          userText:
            `${sheetText}\n\nThis is legend/symbols sheet "${sheet.sheet_number}". The attached page image is the actual sheet -- read each symbol and its meaning directly from the image.\n\n` +
            `Sweep the WHOLE sheet systematically: go column by column, table by table, top to bottom, and record EVERY row of EVERY table until the end -- line notation, tag format decoders and their letter tables, pipe identification sub-tables, abbreviations, valve and in-line symbols, safety devices, primary elements, instrument bubbles, the instrument identification letter table (as "INSTRUMENT LETTER A"..."INSTRUMENT LETTER Z"), tag prefix numbers, equipment shapes, typicals (with applies_to/implied_components), and numbered NOTES. Use the schema's category vocabulary exactly; completeness matters more than brevity.\n\n` +
            `Extract every definition via the record_pid_legend tool call.`,
          maxTokens: 32000,
          useThinking: true,
          images: sheetImages,
        })
      );
      legendSheets.push({ sheet_number: sheet.sheet_number, result });
    } else {
      const result = await callWithRetry(() =>
        callTool<PidSheetResult>(client, {
          tool: PID_SHEET_TOOL,
          systemPrompt: SYSTEM_PROMPT,
          userText:
            `${sheetText}\n\nThis is P&ID sheet "${sheet.sheet_number}". The FIRST attached image is the whole sheet -- use it for layout and for tracing where each line runs. ` +
            `The REMAINING ${sheetTiles.length} images are overlapping close-up tiles of that same sheet, in reading order (row 1 left to right, then row 2), each covering about a ${sheetTiles[0]?.cols ?? 3}x${sheetTiles[0]?.rows ?? 2} slice of it at far higher resolution. ` +
            `Symbol detail is only legible in the TILES: decide every valve type, fitting and spec-break marker from them, and use the whole-sheet image only to work out what connects to what. Adjacent tiles OVERLAP, so a symbol appearing in two tiles is ONE symbol -- do not count it twice.${legendContext}\n\n` +
            `For each line, trace it across the sheet from end to end. Record from/to as equipment TAGS (prefer "V-A100" over a display name like "CONTACTOR A"); where the line enters or leaves via an off-page connector (two-way "FROM / TO" arrow box), record the far-side equipment tag from the connector label, and put the connector's target drawing/sheet reference in continues_on. Record any printed slope annotation (e.g. "1:100").\n\n` +
            `Trace each line to its ACTUAL TERMINUS and record everything up to it -- do not stop at the first valve station or at the point the line stops being labelled. A run ends at an equipment nozzle, an off-page connector, or a tie-in arrow into another header; the last few symbols before that tie-in are the ones most often missed. CHECK VALVES in particular are easy to overlook: they are drawn as a small arrow/zigzag in the pipe rather than a bowtie, frequently carry no tag, often sit in pairs (a "dissimilar type" pair called out by a note) immediately before the tie-in, and they ARE valves -- record every one.\n\n` +
            `VALVE TYPE is decided by the CENTRE of the symbol, not by its outline. Gate, ball and globe valves are all the same bowtie/hourglass and differ ONLY by what sits in the middle: gate = nothing in the centre, ball = an OPEN (unfilled) circle in the centre, globe = a SOLID FILLED circle in the centre. Zoom in on each valve and decide from that centre marking; do not default to "gate valve" for every bowtie. A run of large-bore isolation valves that all show an open circle is a run of BALL valves. Check the legend's "drawn as" description for any symbol you are unsure of.\n\n` +
            `VALVES -- walk each line symbol by symbol and record EVERY valve drawn on it, not only the tagged ones. Most valves on a P&ID are small untagged hand valves: block/isolation valves at equipment nozzles and either side of control valves and instruments, drain valves off the bottom of the run, vent valves off the top, sample points, bypasses, double block and bleed pairs. Record an untagged valve with tag_number left blank and valve_type set from its symbol shape ("gate valve", "ball valve", ...) -- never skip it and never invent a tag for it. ` +
            `For every valve give size and spec_class as well as quantity. SPEC BREAKS: a run's material class is NOT constant, and the LINE NUMBER USUALLY DOES NOT CHANGE where it changes -- the break is drawn as a small marker on the pipe labelled with the class either side ("AC03N | AC70N", "AC70N-N | BC70N-N"). Walk each run from its start and carry a "current class": begin with the class in the line number, and every time you cross a break marker switch to the class printed on its far side. A valve or fitting downstream of an "AC03N | AC70N" marker is AC70N even though the line number still reads ...-AC03N-N, and a run can cross several breaks (including ones on a different sheet). Record every break marker itself under fittings with both classes.\n\n` +
            `BATTERY LIMITS behave the OPPOSITE way to spec breaks and are easy to confuse with them. A battery limit / unit boundary is drawn as a dashed boundary labelled with the unit either side ("B/L UNIT-210 | UNIT-214", "LIMIT OF SUPPLY"), and the line IS renumbered across it: the unit field changes and the service/sequence part usually changes with it, so 8"-22-210-01-CRD-0003-AC03N-N continues as 8"-22-214-01-CRD-0002-AC03N-N. Record the two segments as two separate lines, and file every valve and fitting under the number printed on ITS OWN side of the boundary. Valves sitting just past the boundary are the ones most often misfiled back onto the upstream unit's number, so check which side of the dashed boundary each symbol is drawn on before assigning its line number.\n\n` +
            `Control valves (PCV/TCV/LCV/FCV/XV...) go under valves as the primary device. Accessories drawn mounted on a valve's actuator -- positioner ZC, position indicator ZI, position transmitter ZIT, limit switches ZSO/ZSC, solenoid XY, attached handswitch HS -- go under instruments with parent_valve set to that valve's tag, so the whole assembly is grouped under its primary valve. ` +
            `Likewise, group whole instrument loops under one primary via parent_instrument: follow the signal chain from the primary element and set parent_instrument on EVERY instrument in the loop, all pointing at the one primary (never chained to each other). The thermowell TW is ALWAYS the primary when present (TW-A111 primary; TT-A111, TI-A111, TIC-A111 all get parent_instrument "TW-A111"); with no TW the field transmitter is the primary and its indicators/controllers point at it.\n\n` +
            `Also record inline fitting symbols drawn on each line (flange pairs incl. nozzle mating flanges, blind/spectacle flanges and blanked stubs, reducers, expansion joints/bellows -- including tagged ones like EJ-A101 -- strainers, removable spools) under fittings with the line number they sit on. Classify valve-vs-fitting per the legend's categories: only symbols in the legend's VALVE category are valves; expansion joints and other in-line symbols are fittings even when tagged.\n\n` +
            `Extract its lines/valves/fittings/instruments via the record_pid_sheet tool call.`,
          maxTokens: 16000,
          useThinking: true,
          images: [...sheetImages, ...sheetTiles.map((t) => t.pngBase64)],
        })
      );
      allSheets.push({ sheet_number: sheet.sheet_number, result });
    }
    onProgress?.({ phase: "sheet", current: i + 1, total: locate.sheets.length, detail: sheet.sheet_number });
  }

  const tags: TagDraft[] = [];
  for (const { sheet_number, result } of allSheets) {
    for (const line of result.lines ?? []) {
      tags.push({
        tagType: "line",
        tagNumber: line.line_number,
        attributes: {
          sheet_number,
          size: line.size,
          spec_class: line.spec_class,
          service: line.service,
          from_equipment: line.from_equipment,
          to_equipment: line.to_equipment,
          slope: normalizeSlope(line.slope),
          continues_on: line.continues_on,
        },
      });
    }
    for (const valve of result.valves ?? []) {
      // Untagged hand valves (isolation, drain, vent) are the majority of
      // valves on a real P&ID and have no tag to key on, so they are keyed by
      // symbol type the same way fittings are. Dropping them -- which a
      // required tag_number used to force -- silently undercounts the line.
      const untagged = !valve.tag_number || !valve.tag_number.trim();
      const key = untagged ? valve.valve_type?.trim() || "valve" : valve.tag_number!.trim();
      tags.push({
        tagType: "valve",
        tagNumber: key,
        attributes: {
          sheet_number,
          valve_type: valve.valve_type,
          line_number: valve.line_number,
          size: valve.size,
          spec_class: valve.spec_class,
          quantity: valve.quantity,
          untagged: untagged || undefined,
        },
      });
    }
    for (const fitting of result.fittings ?? []) {
      tags.push({
        tagType: "fitting",
        tagNumber: fitting.fitting_type,
        attributes: {
          sheet_number,
          fitting_type: fitting.fitting_type,
          line_number: fitting.line_number,
          size: fitting.size,
          spec_class: fitting.spec_class,
          spec_break_to: fitting.spec_break_to,
          quantity: fitting.quantity,
        },
      });
    }
    for (const instrument of result.instruments ?? []) {
      tags.push({
        tagType: "instrument",
        tagNumber: instrument.tag_number,
        attributes: {
          sheet_number,
          instrument_type: instrument.instrument_type,
          line_or_equipment_ref: instrument.line_or_equipment_ref,
          parent_valve: instrument.parent_valve,
          parent_instrument: instrument.parent_instrument,
        },
      });
    }
  }
  for (const { sheet_number, result } of legendSheets) {
    for (const item of result.items ?? []) {
      tags.push({
        tagType: "legend_item",
        tagNumber: item.symbol,
        attributes: {
          sheet_number,
          meaning: item.meaning,
          category: item.category,
          applies_to: item.applies_to,
          implied_components: item.implied_components,
        },
      });
    }
  }

  return {
    rawJson: { sheets: allSheets, legends: legendSheets },
    tags,
  };
};