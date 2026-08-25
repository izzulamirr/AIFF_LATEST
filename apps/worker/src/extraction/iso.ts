import Anthropic from "@anthropic-ai/sdk";
import {
  LOCATE_ISO_SECTIONS_TOOL,
  ISO_SHEET_TOOL,
  ISO_SPOOL_WELDS_TOOL,
  ISO_ROUTE_DIMENSIONS_TOOL,
  buildSystemPrompt,
  buildNumberedText,
  sliceText,
  type PageRange,
} from "@easy/extraction-schemas";
import { enrichIsoLineAttrs, normalizeSlope, assignItemSpec, parsePressureRating } from "@easy/shared";
import { callTool, callWithRetry } from "./claudeClient";
import { renderPdfPages, renderPdfPageTiles } from "../pdfImages";
import { extractPageTextPositions, extractPageVectorSegments, type TextPosition, type VectorSegment } from "../pdfVectorGeometry";
import { classifyPageShapes, computeBoundedGroups, computeWeldSpoolCorrections } from "../pdfShapeClassification";
import { normalizeCellValue } from "./pll";
import { computeIsoQualityFlags } from "./isoQualityChecks";
import { computeContainerFit, normalizeSpoolNo } from "./containerFit";
import type { DocTypeExtractor, TagDraft } from "./types";

interface LocateIsoResult {
  sheets: Array<{ drawing_number: string; sheet?: string; pages: PageRange }>;
}

interface IsoSheetResult {
  document_number?: string;
  drawing_number?: string;
  line_number: string;
  size?: string;
  spec_class?: string;
  service?: string;
  from_location?: string;
  to_location?: string;
  slope?: string;
  scale?: string;
  sheet?: string;
  revision?: string;
  owner_pid_no?: string;
  pid_no?: string;
  owner_ga_dwg_no?: string;
  ga_dwg_no?: string;
  design_pressure?: string;
  design_temperature?: string;
  operating_pressure?: string;
  operating_temperature?: string;
  hydrotest_pressure?: string;
  hydrotest_temperature?: string;
  painting_system?: string;
  radiograph?: string;
  test_type?: string;
  insul_spec?: string;
  insul_thickness_mm?: string;
  spec_breaks?: Array<{ spec_class: string; location_note?: string; rating?: string }>;
  bom_items: Array<{
    item_no: string;
    description: string;
    component_type?: string;
    size?: string;
    quantity?: string;
    material?: string;
    item_code?: string;
    item_spec_class?: string;
    item_spec_basis?: string;
  }>;
  spools?: Array<{
    spool_no: string;
    boundary_note?: string;
  }>;
  route_points?: Array<{
    spool_no?: string;
    easting_mm: string;
    northing_mm: string;
    elevation_mm: string;
    location_note?: string;
  }>;
  welds?: Array<{
    weld_tag?: string;
    spool_no?: string;
    weld_type: string;
    weld_list_id?: string;
    size?: string;
    location_note?: string;
  }>;
  weld_list?: Array<{
    id?: string;
    nd?: string;
    type?: string;
    category?: string;
  }>;
  dimensions?: Array<{
    value_mm: string;
    axis?: string;
    from_ref?: string;
    to_ref?: string;
    spool_no?: string;
  }>;
  cut_pieces?: Array<{
    piece_no?: string;
    cut_length_mm: string;
    size?: string;
    remarks?: string;
    end1?: string;
    end2?: string;
    from_ref?: string;
    to_ref?: string;
    spool_no?: string;
  }>;
}

// Results of the two calls that replaced the original single
// "spool tracking" call (see ISO_SPOOL_WELDS_TOOL's own comment for why) --
// merged into one IsoSpoolTrackingResult-shaped object after both complete
// for a sheet (see the per-sheet loop below), so every downstream consumer
// (fit computation, tag creation) is unchanged by the split. Each tool's
// own fields are schema-required (an empty array is fine; a missing key is
// not), so they're non-optional here too.
interface IsoSpoolWeldsResult {
  spools: NonNullable<IsoSheetResult["spools"]>;
  welds: NonNullable<IsoSheetResult["welds"]>;
  weld_list: NonNullable<IsoSheetResult["weld_list"]>;
}
interface IsoRouteDimensionsResult {
  route_points: NonNullable<IsoSheetResult["route_points"]>;
  dimensions: NonNullable<IsoSheetResult["dimensions"]>;
  cut_pieces: NonNullable<IsoSheetResult["cut_pieces"]>;
}
type IsoSpoolTrackingResult = IsoSpoolWeldsResult & IsoRouteDimensionsResult;

const SYSTEM_PROMPT = buildSystemPrompt("piping isometric drawing");

function pageRangeToNumbers(range: PageRange): number[] {
  const numbers: number[] = [];
  for (let n = range.start; n <= range.end; n++) numbers.push(n);
  return numbers;
}

// The tool schema declares these fields as arrays, but that's a strong hint
// to the model, not an API-enforced constraint (see callTool's own comment
// on this) -- a malformed response (e.g. a single object instead of a
// one-element array) passes the "field is present" check fine and only
// blows up later on a bare .map()/.forEach()/for-of, crashing the whole
// extraction with an opaque "X.map is not a function" (confirmed on a real
// run: spec_breaks came back as something other than an array). Route every
// array-shaped field from the model through this instead of `?? []` so one
// malformed field degrades to "treat as empty" rather than failing the
// entire sheet.
function asArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

// Isometric drawings are graphics-heavy CAD exports -- the title block,
// line callouts, and BOM table are usually vector art with little or no
// real text layer (confirmed on a real upload: plain text extraction
// yielded only a footer watermark, nothing else). Page images are sent to
// Claude alongside whatever text does exist, rather than relying on text
// extraction alone like the other document types.
export const extractIsoDocument: DocTypeExtractor = async (pages, apiKey, onProgress, pdfBuffer) => {
  const client = new Anthropic({ apiKey });
  const pageList = pages.map((p) => ({ pageNumber: p.pageNumber, pageText: p.pageText }));
  const fullText = buildNumberedText(pageList);

  const allPageNumbers = pages.map((p) => p.pageNumber);
  const renderedPages = pdfBuffer ? await renderPdfPages(pdfBuffer, allPageNumbers) : [];
  const imageByPage = new Map(renderedPages.map((r) => [r.pageNumber, r.pngBase64]));
  // The API downsamples any image to ~1568px on its long edge before the
  // model sees it -- a full ISO sheet at that size makes an SW/FW diamond
  // marker or a printed E/N/EL coordinate only a few pixels tall, illegible
  // regardless of render scale (see pdfImages.ts's own comment). Same fix
  // already used for P&ID valve symbols (pid.ts): send the whole sheet for
  // layout/connectivity PLUS overlapping close-up tiles at far higher
  // effective resolution for the spool-tracking call specifically, since
  // that's the one reading tiny weld tags and coordinate text.
  const tilesByPage = pdfBuffer ? await renderPdfPageTiles(pdfBuffer, allPageNumbers) : [];

  // Deterministic weld/spool cross-check and correction, layered on top of
  // Claude's own read below -- confirmed this session (against a real,
  // vector-CAD-exported ISO) that a weld's diamond symbol, its leader line,
  // and the real pipe centerline are all literal, computable vector
  // geometry in this kind of PDF, not something that has to be visually
  // re-derived. Zero extra API cost. Only ever CORRECTS spool_no when a
  // weld's own FW-bounded group has a unanimous, independently-clean
  // consensus to merge into (see computeWeldSpoolCorrections's own
  // comment) -- it never invents a new spool number, so a genuine
  // valve/flange split (not yet classified -- see pdfShapeClassification.ts's
  // own `unclassified` catalog) still surfaces as a flag for a human, not a
  // guess. Gracefully finds nothing and changes nothing on a scanned/
  // non-vector PDF (extractPageVectorSegments/text simply return sparse or
  // empty results for a page with no real vector content), and a failure
  // here must never fail the extraction itself -- it's a quality layer on
  // top of Claude's read, not a dependency of it.
  let geometryTexts: TextPosition[] = [];
  let geometrySegments: VectorSegment[] = [];
  if (pdfBuffer) {
    try {
      geometryTexts = await extractPageTextPositions(pdfBuffer, allPageNumbers);
      geometrySegments = await extractPageVectorSegments(pdfBuffer, allPageNumbers);
    } catch (err) {
      console.error("[iso] geometric weld/spool cross-check failed to extract vector data, skipping:", err);
    }
  }

  const locate = await callWithRetry(() =>
    callTool<LocateIsoResult>(client, {
      tool: LOCATE_ISO_SECTIONS_TOOL,
      systemPrompt: SYSTEM_PROMPT,
      userText:
        `${fullText}\n\nThe attached page image(s) are the actual drawing content -- use them as the primary source, the text above (if any) is often just a footer/watermark. ` +
        `Identify every isometric SHEET via the locate_iso_sheets tool call: one entry per sheet, each with its own single-page range. ` +
        `Sheets of a multi-sheet drawing repeat the same drawing number and differ only by the title block's "SHEET n OF m" -- read that field on each page and return a separate entry per page, never one entry spanning them.`,
      maxTokens: 8000,
      useThinking: true,
      images: renderedPages.map((r) => r.pngBase64),
    }),
    0
  );

  if (!locate.sheets || locate.sheets.length === 0) {
    throw new Error("locate_iso_sheets found no drawings in this document.");
  }

  // Guard: sheets of a multi-sheet drawing share one drawing number and
  // differ only by "SHEET n OF m", so locate can collapse them into a single
  // multi-page entry -- which then extracts only the first sheet's BOM and
  // silently loses the rest (seen on a real 3-sheet drawing: 11 of 45 rows).
  // Any entry spanning several pages is split into one entry per page, so
  // every sheet is always read on its own.
  const locatedSheets = locate.sheets.flatMap((sheet) => {
    const numbers = pageRangeToNumbers(sheet.pages).filter((n) => imageByPage.has(n) || pageList.some((p) => p.pageNumber === n));
    if (numbers.length <= 1) return [sheet];
    return numbers.map((n) => ({ ...sheet, pages: { start: n, end: n } as PageRange }));
  });
  onProgress?.({ phase: "locate", current: 1, total: 1 });

  const allSheets: Array<{ drawing_number: string; pageNumber: number; result: IsoSheetResult }> = [];
  for (let i = 0; i < locatedSheets.length; i++) {
    const sheet = locatedSheets[i];
    const sheetText = sliceText(pageList, sheet.pages);
    const sheetPageNumbers = pageRangeToNumbers(sheet.pages);
    const sheetImages = sheetPageNumbers.map((n) => imageByPage.get(n)).filter((img): img is string => Boolean(img));
    const sheetTiles = tilesByPage.filter((t) => sheetPageNumbers.includes(t.pageNumber));
    const sheetResult = await callWithRetry(() =>
      callTool<IsoSheetResult>(client, {
        tool: ISO_SHEET_TOOL,
        systemPrompt: SYSTEM_PROMPT,
        userText:
          `${sheetText}\n\nThis is isometric drawing "${sheet.drawing_number}"${sheet.sheet ? `, sheet ${sheet.sheet}` : ""} -- page ${sheet.pages.start} of the document. The attached page image is THIS sheet only, so extract only the title block and BOM printed on it -- ` +
          `read the title block and Bill of Material table directly from the image(s); the text above (if any) is often just a footer/watermark, not the real content. ` +
          `Extract the full title block (document number, drawing number, line number, size, spec, service, scale, sheet, revision, owner P&ID no., P&ID no., ` +
          `owner GA drawing no., GA drawing no., any slope annotation, design/operating/hydrotest pressure and temperature, painting system, radiograph, test type, insulation spec, insulation thickness) ` +
          `and Bill of Material rows via the record_iso_sheet tool call. ` +
          `For from_location/to_location: trace the drawn pipe run itself from one end to the other -- the start is the callout where the piping begins ` +
          `(equipment/nozzle connection, tie-in flag, or a "CONT'D FROM ..." continuation box) and the end is the callout where it terminates ` +
          `("CONT'D ON ...", equipment/nozzle, or tie-in). These callouts sit at the ends of the drawn pipeline, not in the title block. ` +
          `Read each unit from its column header and append it to the value (e.g. under a "PRESS. kPag" header the value 5 becomes "5 kPag"; under "TEMP. °C" the value 90 becomes "90 °C"; ` +
          `"INSUL/THK(MM)" of 25 becomes "25 mm"). Leave non-numeric placeholders such as NA, NIL. or AMB. exactly as printed. ` +
          `Where one field holds more than one value, join them with " / " -- never a line break.\n\n` +
          `SPEC BREAKS: check the drawing for "MATL <class>" callout boxes -- a pair of them either side of a joint marks a material/spec break, and the continuation line number may carry a different class too. Record every class present under spec_breaks (including the title-block class) with its pressure class in rating. ` +
          `Then set item_spec_class on EVERY BOM row: a spec break is a point on the run, so each item sits on one definite side. ` +
          `Place un-rated rows (plain pipe, weldolets, butt-weld elbows/tees/reducers) by POSITION -- follow the row's item-number balloons to where they sit on the drawn run and decide whether that point is upstream or downstream of the "MATL" callouts. A repeated item code split across two rows is the giveaway that one row is each side (e.g. pipe 28.1M on the long upstream run vs pipe 1.5M on the short stub past the break; 7 elbows upstream vs 1 downstream) -- place each row by where its balloons actually are, and record item_spec_basis "position". ` +
          `Place rated rows AWAY FROM THE BREAK JOINT by their own rating (item_spec_basis "rating"): a "150# RF" flange, gasket, "150RF" bolt or 150# valve is the 150# class, a "300# RF" one or an alloy-overlay valve is the 300# class. ` +
          `CRITICAL: rating does NOT identify the side AT the break joint, because that joint is rate-matched to the HIGHER class -- the mating flange on the lower-rated side, the joint gasket and its bolts are all made to the higher rating so they bolt together, yet the flange still BELONGS to the lower class because the break is at the joint face, after it. On a 150#/300# break a 300# flange sitting upstream of the MATL callout is a 150#-class item rate-matched up, NOT a 300#-class item. Place break-joint hardware by POSITION, basis "position (rate-matched to the higher class)". ` +
          `Never place by rating where the rating comes from the component's own standard either: ASME B16.36 orifice flanges and their gaskets start at 300#, so a 150# line's orifice assembly is 300# with no break involved -- place those by position. ` +
          `A sheet with no "MATL" callouts has no break on it: set item_spec_class to the title-block class for every row on that sheet, basis "sheet has no spec break".`,
        maxTokens: 32000,
        useThinking: true,
        images: sheetImages,
      }),
      0
    );

    // Separate calls, separate token budgets -- confirmed on a real run
    // that packing a full BOM AND spools AND a welds array running into the
    // dozens AND route_points AND dimensions into ONE response ran out of
    // room even at max_tokens=64000, with welds specifically coming back
    // near-empty on sheets where the BOM alone was already large. Further
    // split into TWO calls (spools+welds, then route_points+dimensions)
    // after the combined tool's own schema grew to ~9,000 tokens of rules
    // across this session's accuracy fixes, and a real extraction dropped
    // ALL FOUR arrays on both the original attempt and its retry -- see
    // ISO_SPOOL_WELDS_TOOL's own comment. The second call is given the
    // first call's own spools/welds results as reference text, so dimension
    // placement can reference ALREADY-SETTLED weld-to-spool assignments
    // instead of re-deriving spool boundaries independently.
    const sheetImageArgs = { images: [...sheetImages, ...sheetTiles.map((t) => t.pngBase64)] };
    const tileExplanation =
      `This is isometric drawing "${sheet.drawing_number}"${sheet.sheet ? `, sheet ${sheet.sheet}` : ""} -- page ${sheet.pages.start} of the document. The FIRST attached image is the whole sheet -- use it to trace the route and see how everything connects. ` +
      `The REMAINING ${sheetTiles.length} images are overlapping close-up tiles of that same sheet, in reading order (row 1 left to right, then row 2), each covering about a ${sheetTiles[0]?.cols ?? 3}x${sheetTiles[0]?.rows ?? 2} slice of it at far higher resolution than the whole-sheet image. ` +
      `Weld tag numbers (SW/FW + digits), E/N/EL coordinate callouts, and printed dimension values are frequently ONLY legible in the tiles -- the whole-sheet image compresses them to a few pixels. Read every weld tag, coordinate, and dimension from the tiles; use the whole-sheet image only to work out spool boundaries and how the route connects. Adjacent tiles OVERLAP, so a mark appearing in two tiles is ONE mark -- do not record it twice. `;

    const spoolWeldsResult = await callWithRetry(async () => {
      const r = await callTool<IsoSpoolWeldsResult>(client, {
        tool: ISO_SPOOL_WELDS_TOOL,
        systemPrompt: SYSTEM_PROMPT,
        userText:
          `${sheetText}\n\n${tileExplanation}` +
          `Read the pipe spools and welds printed on THIS sheet via the record_iso_spool_welds tool call -- completeness here (especially the welds array) matters as much as the BOM does.`,
        maxTokens: 48000,
        useThinking: true,
        ...sheetImageArgs,
      });
      // required in the schema is a strong hint to the model, not an
      // API-enforced constraint (this tool isn't strict-mode) -- confirm
      // the arrays actually came back AS ARRAYS rather than trusting the
      // schema alone (confirmed on a real run: a 3-spool fabrication sheet
      // came back with spools as a bare object under output-token
      // pressure). Fails the sheet outright on a miss rather than
      // retrying -- a retry re-sends the full image/tile payload and pays
      // for it again, and this can happen on every sheet of a document.
      const missing = (["spools", "welds", "weld_list"] as const).filter((k) => !Array.isArray(r[k]));
      if (missing.length > 0) {
        throw new Error(`record_iso_spool_welds for ${sheet.drawing_number} sheet ${sheet.sheet ?? "?"} is missing required array field(s): ${missing.join(", ")}`);
      }
      return r;
    }, 0);

    // Reference text for the second call -- see ISO_ROUTE_DIMENSIONS_TOOL's
    // own comment for why it must use this rather than re-deriving spool
    // boundaries itself.
    const spoolsRefText = spoolWeldsResult.spools.map((s) => `spool ${s.spool_no}: ${s.boundary_note ?? "(no boundary note)"}`).join("\n") || "(none)";
    const weldsRefText =
      spoolWeldsResult.welds
        .map((w) => `${w.weld_tag ?? "(untagged)"} -> spool ${w.spool_no ?? "(unassigned)"}${w.location_note ? ` -- ${w.location_note}` : ""}`)
        .join("\n") || "(none)";

    const routeDimResult = await callWithRetry(async () => {
      const r = await callTool<IsoRouteDimensionsResult>(client, {
        tool: ISO_ROUTE_DIMENSIONS_TOOL,
        systemPrompt: SYSTEM_PROMPT,
        userText:
          `${sheetText}\n\n${tileExplanation}` +
          `This sheet's spools and welds were ALREADY determined by a separate call -- use this as reference, do not re-derive spool boundaries independently:\n\nSPOOLS:\n${spoolsRefText}\n\nWELDS:\n${weldsRefText}\n\n` +
          `Read the route-point coordinates and dimensions printed on THIS sheet via the record_iso_route_dimensions tool call -- completeness here matters as much as the BOM does.`,
        maxTokens: 48000,
        useThinking: true,
        ...sheetImageArgs,
      });
      // Same array-shape check as record_iso_spool_welds above, not just
      // presence -- see that call's own comment for the real case that
      // motivated this.
      const missing = (["route_points", "dimensions", "cut_pieces"] as const).filter((k) => !Array.isArray(r[k]));
      if (missing.length > 0) {
        throw new Error(`record_iso_route_dimensions for ${sheet.drawing_number} sheet ${sheet.sheet ?? "?"} is missing required array field(s): ${missing.join(", ")}`);
      }
      return r;
    }, 0);

    const spoolResult: IsoSpoolTrackingResult = { ...spoolWeldsResult, ...routeDimResult };

    const result: IsoSheetResult = { ...sheetResult, ...spoolResult };
    allSheets.push({ drawing_number: sheet.drawing_number, pageNumber: sheet.pages.start, result });
    onProgress?.({ phase: "sheet", current: i + 1, total: locatedSheets.length, detail: `${sheet.drawing_number}${sheet.sheet ? ` sheet ${sheet.sheet}` : ""}` });
  }

  // Spool shipping-fit validation -- see computeContainerFit's own comment
  // for the full method (coordinate spread vs. per-axis dimension sums, and
  // why same-endpoint dimensions get deduplicated rather than summed).
  const fitRoutePoints = allSheets.flatMap(({ result }) =>
    asArray(result.route_points)
      .map((p) => {
        const spoolNo = p.spool_no?.trim();
        const e = Number(p.easting_mm);
        const northing = Number(p.northing_mm);
        const el = Number(String(p.elevation_mm ?? "").replace(/^\+/, ""));
        if (!spoolNo || !Number.isFinite(e) || !Number.isFinite(northing) || !Number.isFinite(el)) return null;
        return { spoolNo, e, n: northing, el };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)
  );
  const fitDimensions = allSheets.flatMap(({ result }) =>
    asArray(result.dimensions).map((d) => ({ spoolNo: d.spool_no ?? null, axis: d.axis, valueMm: d.value_mm, fromRef: d.from_ref ?? null, toRef: d.to_ref ?? null }))
  );
  const fitWelds = allSheets.flatMap(({ result }) => asArray(result.welds).map((w) => ({ tagNumber: w.weld_tag ?? "", locationNote: w.location_note ?? null })));
  const fitBySpool = computeContainerFit(fitRoutePoints, fitDimensions, fitWelds);

  const tags: TagDraft[] = [];
  const n = normalizeCellValue; // collapse any embedded newlines to " / "
  for (const { drawing_number, pageNumber, result } of allSheets) {
    // Classes present on this sheet, with their pressure class where known --
    // the basis for placing each BOM item when the drawing has a spec break.
    const specsWithRatings = asArray(result.spec_breaks).map((b) => ({
      spec_class: b.spec_class,
      location_note: b.location_note,
      rating: parsePressureRating(b.rating) ?? (b.rating ? Number(String(b.rating).replace(/\D/g, "")) || null : null),
    }));

    if (result.line_number) {
      const lineNumber = n(result.line_number) ?? result.line_number;
      tags.push({
        tagType: "line",
        tagNumber: lineNumber,
        // The sheet this row was read from -- a multi-sheet drawing's BOM is
        // per sheet, and a spec break can apply to one sheet only, so the
        // page is what ties a row to its sheet (see the BOM-by-spec view).
        sourcePage: pageNumber,
        // enrichIsoLineAttrs decodes the line-number convention
        // (size-service-class-unique-insulation-heattrace) and fills any
        // field the title block left blank or as an "XX.XX" placeholder.
        attributes: enrichIsoLineAttrs(lineNumber, {
          drawing_number: n(result.drawing_number) ?? drawing_number,
          document_number: n(result.document_number),
          size: n(result.size),
          spec_class: n(result.spec_class),
          service: n(result.service),
          from_location: n(result.from_location),
          to_location: n(result.to_location),
          slope: normalizeSlope(n(result.slope)),
          scale: n(result.scale),
          sheet: n(result.sheet),
          revision: n(result.revision),
          owner_pid_no: n(result.owner_pid_no),
          pid_no: n(result.pid_no),
          owner_ga_dwg_no: n(result.owner_ga_dwg_no),
          ga_dwg_no: n(result.ga_dwg_no),
          design_pressure: n(result.design_pressure),
          design_temperature: n(result.design_temperature),
          operating_pressure: n(result.operating_pressure),
          operating_temperature: n(result.operating_temperature),
          hydrotest_pressure: n(result.hydrotest_pressure),
          hydrotest_temperature: n(result.hydrotest_temperature),
          painting_system: n(result.painting_system),
          radiograph: n(result.radiograph),
          test_type: n(result.test_type),
          insul_spec: n(result.insul_spec),
          insul_thickness_mm: n(result.insul_thickness_mm),
          // Every class present on the drawing (a spec break means the line
          // carries two) -- gate 4/7 validate each BOM item against its own
          // class rather than the title block's.
          spec_breaks: specsWithRatings,
        }),
      });
    }
    for (const item of asArray(result.bom_items)) {
      tags.push({
        tagType: "bom_item",
        tagNumber: item.item_no,
        sourcePage: pageNumber,
        attributes: {
          drawing_number,
          line_number: result.line_number,
          description: item.description,
          component_type: item.component_type,
          size: item.size,
          quantity: item.quantity,
          material: item.material,
          item_code: item.item_code,
          // The class governing THIS item on a spec-break drawing. Falls back
          // to a deterministic rating match (150# -> the 150# class, 300# ->
          // the 300# class) when the extraction left it blank; stays blank for
          // items with no rating signature rather than guessing a side.
          item_spec_class:
            n(item.item_spec_class) ??
            assignItemSpec(`${item.description ?? ""} ${item.item_code ?? ""}`, specsWithRatings)?.spec_class,
          // How the class was decided, so a reviewer can audit it: the
          // extraction reports its own basis (position/rating/rate-matched),
          // and the deterministic rating fallback labels itself.
          item_spec_basis:
            n(item.item_spec_basis) ??
            (n(item.item_spec_class)
              ? undefined
              : assignItemSpec(`${item.description ?? ""} ${item.item_code ?? ""}`, specsWithRatings)
                ? "rating"
                : undefined),
          // The line's own spec class (e.g. "150JY11") -- item_code (e.g.
          // "P9610-C") is what should be looked up within that class's
          // pipes/fittings/flanges/valves, not compared as if it were a
          // class code itself (see verifyIso.ts).
          spec_class: result.spec_class,
        },
      });
    }

    const weldTagNumbers = asArray(result.welds).map((w, i) => n(w.weld_tag) ?? `W${pageNumber}-${i + 1}`);
    const dimensionTagNumbers = asArray(result.dimensions).map((_d, i) => `DIM${pageNumber}-${i + 1}`);
    const cutPieceTagNumbers = asArray(result.cut_pieces).map((p, i) => n(p.piece_no) ?? `CUT${pageNumber}-${i + 1}`);

    // Geometric weld/spool cross-check + correction, layered on Claude's own
    // read above -- see geometryTexts/geometrySegments's own comment for
    // what this can and can't determine, and computeWeldSpoolCorrections's
    // own comment for exactly which case it's safe to auto-fix vs. only
    // flag. A failure or an empty result here (a scanned/non-vector PDF)
    // must never break extraction -- it's a quality layer on Claude's
    // output, not a dependency of it. Runs BEFORE the text-based
    // deterministic cross-checks below (a deliberate reordering -- it used
    // to run after) so computeIsoQualityFlags sees each weld's
    // GEOMETRICALLY-CORRECTED spool_no, not Claude's raw pre-correction
    // read -- the dimension-vs-weld and spool boundary-note checks below
    // both key off weld spool_no, so checking against stale data meant a
    // dimension could pass a consistency check against a weld number that
    // was already known to be wrong.
    let weldCorrectionByTag = new Map<string, { newSpoolNo: string; oldSpoolNo: string }>();
    let weldHardFlagByTag = new Map<string, string>();
    let weldGroupFlagByTag = new Map<string, string>();
    let weldTypeByGeometricTag = new Map<string, "shop weld" | "field weld" | "unknown">();
    if (geometryTexts.length > 0 || geometrySegments.length > 0) {
      try {
        const geometryShapes = classifyPageShapes(pageNumber, geometrySegments, geometryTexts);
        const boundedGroups = computeBoundedGroups(geometryShapes);
        const rawSpoolByTag = new Map(asArray(result.welds).map((w, i) => [weldTagNumbers[i].toUpperCase(), n(w.spool_no) ?? undefined]));
        const corrections = computeWeldSpoolCorrections(geometryShapes, boundedGroups, rawSpoolByTag);
        weldCorrectionByTag = corrections.correctionByTag;
        weldHardFlagByTag = corrections.hardFlagByTag;
        weldGroupFlagByTag = corrections.groupFlagByTag;
        weldTypeByGeometricTag = new Map(geometryShapes.welds.map((w) => [w.tagNumber, w.weldType]));
      } catch (err) {
        console.error(`[iso] geometric weld/spool cross-check failed for page ${pageNumber}, skipping:`, err);
      }
    }

    // Deterministic cross-checks below run against the model's OWN already-
    // extracted output -- no second API call, no re-examining the image,
    // zero extra token cost. Cheaper than a review pass because they only
    // catch what's checkable from the data alone (internal contradictions,
    // mismatched cross-references, missing sequence numbers); anything that
    // actually requires re-reading the drawing (e.g. confirming which side
    // of a valve a weld is really on) still needs a human or a real re-check.
    // Shared with recheckIsoQualityFlags (isoQualityChecks.ts) so the exact
    // same logic can be re-run against data already sitting in the database
    // -- no new extraction -- if these checks are ever updated after the
    // fact (see that function's own comment for why that matters).
    const { spoolFlags, dimensionFlags, weldListFlags } = computeIsoQualityFlags(
      asArray(result.spools)
        .map((s) => ({ tagNumber: n(s.spool_no) ?? "", boundaryNote: n(s.boundary_note) ?? null }))
        .filter((s) => s.tagNumber),
      asArray(result.welds).map((w, i) => {
        const upperTag = weldTagNumbers[i].toUpperCase();
        return {
          tagNumber: weldTagNumbers[i],
          spoolNo: weldCorrectionByTag.get(upperTag)?.newSpoolNo ?? n(w.spool_no) ?? null,
          weldType: n(w.weld_type) ?? null,
          weldListId: n(w.weld_list_id) ?? null,
          size: n(w.size) ?? null,
        };
      }),
      asArray(result.dimensions).map((d, i) => ({
        tagNumber: dimensionTagNumbers[i],
        spoolNo: n(d.spool_no) ?? null,
        fromRef: n(d.from_ref) ?? null,
        toRef: n(d.to_ref) ?? null,
      })),
      asArray(result.weld_list).map((r) => ({ id: n(r.id) ?? "", nd: n(r.nd) ?? null, type: n(r.type) ?? null })).filter((r) => r.id)
    );

    for (const spool of asArray(result.spools)) {
      const spoolNo = n(spool.spool_no);
      if (!spoolNo) continue;
      const fit = fitBySpool.get(normalizeSpoolNo(spoolNo));
      tags.push({
        tagType: "spool",
        tagNumber: spoolNo,
        sourcePage: pageNumber,
        attributes: {
          drawing_number,
          line_number: result.line_number,
          boundary_note: n(spool.boundary_note),
          // Each axis is max(coordinate extent, deduplicated dimension sum)
          // WITHIN that same axis -- see computeContainerFit's own comment
          // for why the two signals are only ever combined per axis, never
          // across axes. null when neither coordinate callouts nor axis-
          // tagged dimensions were found for this spool at all (not enough
          // data to size it).
          bounding_box_mm: fit ? [fit.boundingBoxMm.E, fit.boundingBoxMm.N, fit.boundingBoxMm.EL] : null,
          // The single largest per-axis dimension total, for reference/audit
          // -- not itself a spool dimension (that's bounding_box_mm), just
          // shows the biggest run-length signal that went into computing it.
          summed_length_mm: fit?.summedLengthMm ?? null,
          shipping_container: fit?.container ?? null,
          // Which axis to lay along the container's length/width/height for
          // the best (max-min-clearance) fit -- null when oversized.
          container_orientation: fit?.orientation ?? null,
          boundary_flag: spoolFlags.get(spoolNo) ?? null,
        },
      });
    }

    // Prefer the weld's own printed tag (SW01, FW02 -- shop and field welds
    // are numbered in two separate sequences that both restart at 01, so the
    // prefix is kept rather than normalized away). Falls back to a per-sheet
    // sequence number only for the rare mark with no printed tag at all.
    asArray(result.welds).forEach((weld, i) => {
      const tagNumber = weldTagNumbers[i];
      const upperTag = tagNumber.toUpperCase();
      const correction = weldCorrectionByTag.get(upperTag);
      // weld_type is directly readable off the tag prefix itself (SW ->
      // shop weld, FW -> field weld) whenever geometry found a matching
      // symbol -- no ambiguity, no vision needed, so it overrides Claude's
      // own read of the legend symbol on the rare occasion they disagree.
      const geometricWeldType = weldTypeByGeometricTag.get(upperTag);
      tags.push({
        tagType: "weld",
        tagNumber,
        sourcePage: pageNumber,
        attributes: {
          drawing_number,
          line_number: result.line_number,
          spool_no: correction?.newSpoolNo ?? n(weld.spool_no),
          spool_no_corrected_from: correction?.oldSpoolNo ?? null,
          weld_type: geometricWeldType && geometricWeldType !== "unknown" ? geometricWeldType : n(weld.weld_type),
          size: n(weld.size),
          weld_list_id: n(weld.weld_list_id),
          location_note: n(weld.location_note),
          geometry_flag: weldHardFlagByTag.get(upperTag) ?? null,
          geometry_group_flag: weldGroupFlagByTag.get(upperTag) ?? null,
          weld_list_flag: weldListFlags.get(tagNumber) ?? null,
        },
      });
    });

    // This sheet's own printed WELD LIST table, captured verbatim so a
    // weld's own weld_list_id citation can be cross-checked against what
    // that row actually says (see weld_list_flag above), not just trusted.
    asArray(result.weld_list).forEach((row, i) => {
      const rowId = n(row.id) ?? `WLR${pageNumber}-${i + 1}`;
      tags.push({
        tagType: "weld_list_row",
        tagNumber: rowId,
        sourcePage: pageNumber,
        attributes: {
          drawing_number,
          line_number: result.line_number,
          nd: n(row.nd),
          type: n(row.type),
          category: n(row.category),
        },
      });
    });

    // Audit trail for the spool sizing computation above -- stored as their
    // own tags (not just used transiently) so a wrong bounding_box_mm/
    // summed_length_mm can be traced back to the exact points/dimensions
    // that produced it, instead of having to be inferred after the fact.
    asArray(result.route_points).forEach((p, i) => {
      tags.push({
        tagType: "route_point",
        tagNumber: `RP${pageNumber}-${i + 1}`,
        sourcePage: pageNumber,
        attributes: {
          drawing_number,
          line_number: result.line_number,
          spool_no: n(p.spool_no),
          easting_mm: n(p.easting_mm),
          northing_mm: n(p.northing_mm),
          elevation_mm: n(p.elevation_mm),
          location_note: n(p.location_note),
        },
      });
    });
    asArray(result.dimensions).forEach((d, i) => {
      const tagNumber = dimensionTagNumbers[i];
      tags.push({
        tagType: "dimension",
        tagNumber,
        sourcePage: pageNumber,
        attributes: {
          drawing_number,
          line_number: result.line_number,
          spool_no: n(d.spool_no),
          value_mm: n(d.value_mm),
          axis: n(d.axis),
          from_ref: n(d.from_ref),
          to_ref: n(d.to_ref),
          spool_flag: dimensionFlags.get(tagNumber) ?? null,
        },
      });
    });

    // Fabrication/cut sheet's own CUT PIPE LENGTH table, if this sheet has
    // one -- the raw pipe stock a spool is built FROM, not the same thing as
    // a route dimension (which measures the assembled spool). spool_no is
    // frequently blank (see the schema field's own comment) since this
    // table is usually printed once for the whole sheet, not per spool.
    asArray(result.cut_pieces).forEach((p, i) => {
      tags.push({
        tagType: "cut_piece",
        tagNumber: cutPieceTagNumbers[i],
        sourcePage: pageNumber,
        attributes: {
          drawing_number,
          line_number: result.line_number,
          spool_no: n(p.spool_no),
          cut_length_mm: n(p.cut_length_mm),
          size: n(p.size),
          remarks: n(p.remarks),
          end1: n(p.end1),
          end2: n(p.end2),
          from_ref: n(p.from_ref),
          to_ref: n(p.to_ref),
        },
      });
    });
  }

  return { rawJson: { sheets: allSheets }, tags };
};