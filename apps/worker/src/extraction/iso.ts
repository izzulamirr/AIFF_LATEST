import Anthropic from "@anthropic-ai/sdk";
import {
  LOCATE_ISO_SECTIONS_TOOL,
  ISO_SHEET_TOOL,
  ISO_SPOOL_TRACKING_TOOL,
  buildSystemPrompt,
  buildNumberedText,
  sliceText,
  type PageRange,
} from "@easy/extraction-schemas";
import { enrichIsoLineAttrs, normalizeSlope, assignItemSpec, parsePressureRating } from "@easy/shared";
import { callTool, callWithRetry } from "./claudeClient";
import { renderPdfPages, renderPdfPageTiles } from "../pdfImages";
import { normalizeCellValue } from "./pll";
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
    size?: string;
    location_note?: string;
  }>;
  dimensions?: Array<{
    value_mm: string;
    axis?: string;
    from_ref?: string;
    to_ref?: string;
    spool_no?: string;
  }>;
}

// Result of the separate ISO_SPOOL_TRACKING_TOOL call -- merged into
// IsoSheetResult after both calls for a sheet complete (see the per-sheet
// loop below). All four fields are schema-required on this tool (an empty
// array is fine; a missing key is not), so they're non-optional here too.
interface IsoSpoolTrackingResult {
  spools: NonNullable<IsoSheetResult["spools"]>;
  route_points: NonNullable<IsoSheetResult["route_points"]>;
  welds: NonNullable<IsoSheetResult["welds"]>;
  dimensions: NonNullable<IsoSheetResult["dimensions"]>;
}

const SYSTEM_PROMPT = buildSystemPrompt("piping isometric drawing");

function pageRangeToNumbers(range: PageRange): number[] {
  const numbers: number[] = [];
  for (let n = range.start; n <= range.end; n++) numbers.push(n);
  return numbers;
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
    })
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
      })
    );

    // Separate call, separate token budget -- confirmed on a real run that
    // packing a full BOM AND spools AND a welds array running into the
    // dozens AND route_points AND dimensions into ONE response ran out of
    // room even at max_tokens=64000, with welds specifically coming back
    // near-empty on sheets where the BOM alone was already large.
    const spoolResult = await callWithRetry(async () => {
      const r = await callTool<IsoSpoolTrackingResult>(client, {
        tool: ISO_SPOOL_TRACKING_TOOL,
        systemPrompt: SYSTEM_PROMPT,
        userText:
          `${sheetText}\n\nThis is isometric drawing "${sheet.drawing_number}"${sheet.sheet ? `, sheet ${sheet.sheet}` : ""} -- page ${sheet.pages.start} of the document. The FIRST attached image is the whole sheet -- use it to trace the route and see how everything connects. ` +
          `The REMAINING ${sheetTiles.length} images are overlapping close-up tiles of that same sheet, in reading order (row 1 left to right, then row 2), each covering about a ${sheetTiles[0]?.cols ?? 3}x${sheetTiles[0]?.rows ?? 2} slice of it at far higher resolution than the whole-sheet image. ` +
          `Weld tag numbers (SW/FW + digits), E/N/EL coordinate callouts, and printed dimension values are frequently ONLY legible in the tiles -- the whole-sheet image compresses them to a few pixels. Read every weld tag, coordinate, and dimension from the tiles; use the whole-sheet image only to work out spool boundaries and how the route connects. Adjacent tiles OVERLAP, so a mark appearing in two tiles is ONE mark -- do not record it twice. ` +
          `Read the pipe spools, route-point coordinates, welds, and dimensions printed on THIS sheet via the record_iso_spool_tracking tool call -- completeness here (especially the welds array) matters as much as the BOM does.`,
        maxTokens: 64000,
        useThinking: true,
        images: [...sheetImages, ...sheetTiles.map((t) => t.pngBase64)],
      });
      // required in the schema is a strong hint to the model, not an
      // API-enforced constraint (this tool isn't strict-mode) -- confirm
      // the arrays actually came back rather than trusting the schema
      // alone, and retry the sheet if the model dropped them under
      // output-token pressure instead of silently persisting partial data.
      const missing = (["spools", "welds", "route_points", "dimensions"] as const).filter((k) => r[k] === undefined);
      if (missing.length > 0) {
        throw new Error(`record_iso_spool_tracking for ${sheet.drawing_number} sheet ${sheet.sheet ?? "?"} is missing required field(s): ${missing.join(", ")}`);
      }
      return r;
    });

    const result: IsoSheetResult = { ...sheetResult, ...spoolResult };
    allSheets.push({ drawing_number: sheet.drawing_number, pageNumber: sheet.pages.start, result });
    onProgress?.({ phase: "sheet", current: i + 1, total: locatedSheets.length, detail: `${sheet.drawing_number}${sheet.sheet ? ` sheet ${sheet.sheet}` : ""}` });
  }

  // Spool shipping-fit validation -- each spool's real fabricated size,
  // checked against standard shipping containers' internal envelopes. This
  // VALIDATES the FW/erection-joint boundaries the drawing itself shows (see
  // each spool's own boundary_note) -- it never invents or moves a boundary.
  // A spool that comes back oversized usually means a field weld was missed
  // during extraction, or is a genuine design issue worth a human look.
  //
  // Two independent signals feed the size, kept STRICTLY per axis (E/N/EL) --
  // an isometric run only ever points along one of three directions, and a
  // turn through an elbow/tee switches which one, so dimensions either side
  // of a turn are very likely on DIFFERENT axes. Summing them together (as
  // an earlier version of this did) produces a number that isn't any real
  // physical dimension of the spool at all -- e.g. a 1407mm run before a
  // bend plus a 3437mm run after it are NOT one 4844mm straight length.
  //  - E/N/EL coordinate spread -> a true per-axis extent, but only as good
  //    as how many coordinate callouts the sheet happens to print.
  //  - Printed dimensions, summed WITHIN their own axis only (never across
  //    axes) -> fills in an axis the coordinate spread missed, or confirms
  //    it independently when both are present.
  // Each axis takes whichever of the two signals is bigger for THAT axis
  // (never the safer-looking smaller one); an axis with neither a
  // coordinate spread nor any axis-tagged dimension stays at 0 (unmeasured,
  // not "zero size").
  const CONTAINERS = [
    { name: "20ft", internalMm: [5900, 2390, 2350] },
    { name: "40ft", internalMm: [12032, 2390, 2350] },
  ] as const;
  const AXES = ["e", "n", "el"] as const;
  type Axis = (typeof AXES)[number];
  function normalizeAxis(raw: string | undefined): Axis | null {
    const a = raw?.trim().toLowerCase();
    return a === "e" || a === "n" || a === "el" ? a : null;
  }

  interface RoutePoint {
    spoolNo: string;
    e: number;
    n: number;
    el: number;
  }
  const routePoints: RoutePoint[] = [];
  for (const { result } of allSheets) {
    for (const p of result.route_points ?? []) {
      const spoolNo = p.spool_no?.trim();
      const e = Number(p.easting_mm);
      const northing = Number(p.northing_mm);
      const el = Number(String(p.elevation_mm ?? "").replace(/^\+/, ""));
      if (!spoolNo || !Number.isFinite(e) || !Number.isFinite(northing) || !Number.isFinite(el)) continue;
      routePoints.push({ spoolNo, e, n: northing, el });
    }
  }
  const pointsBySpool = new Map<string, RoutePoint[]>();
  for (const p of routePoints) {
    const list = pointsBySpool.get(p.spoolNo) ?? [];
    list.push(p);
    pointsBySpool.set(p.spoolNo, list);
  }

  // Dimension lines per spool, PER AXIS -- read as their own top-level array
  // (not attached to welds), each tagged with which of the three isometric
  // directions it runs along. Only dimensions sharing the same axis are
  // summed together; a dimension with no readable axis contributes to
  // neither signal for that spool (better an axis stays unmeasured than
  // guessed wrong).
  const dimsBySpoolAxis = new Map<string, Map<Axis, number[]>>();
  for (const { result } of allSheets) {
    for (const d of result.dimensions ?? []) {
      const spoolNo = d.spool_no?.trim();
      const axis = normalizeAxis(d.axis);
      const value = Number(d.value_mm);
      if (!spoolNo || !axis || !Number.isFinite(value) || value <= 0) continue;
      const byAxis = dimsBySpoolAxis.get(spoolNo) ?? new Map<Axis, number[]>();
      const list = byAxis.get(axis) ?? [];
      list.push(value);
      byAxis.set(axis, list);
      dimsBySpoolAxis.set(spoolNo, byAxis);
    }
  }

  const allSpoolNos = new Set([...pointsBySpool.keys(), ...dimsBySpoolAxis.keys()]);
  const fitBySpool = new Map<
    string,
    { boundingBoxMm: [number, number, number]; summedLengthMm: number | null; container: string | null }
  >();
  for (const spoolNo of allSpoolNos) {
    const points = pointsBySpool.get(spoolNo) ?? [];
    const coordExtent = (vals: number[]) => (vals.length >= 2 ? Math.max(...vals) - Math.min(...vals) : 0);
    const coordByAxis: Record<Axis, number> = {
      e: coordExtent(points.map((p) => p.e)),
      n: coordExtent(points.map((p) => p.n)),
      el: coordExtent(points.map((p) => p.el)),
    };

    const dimByAxis = dimsBySpoolAxis.get(spoolNo);
    const axisTotals = AXES.map((axis) => {
      const dims = dimByAxis?.get(axis) ?? [];
      const summed = dims.length > 0 ? dims.reduce((a, b) => a + b, 0) : 0;
      return Math.max(coordByAxis[axis], summed);
    });
    const anyDimSum = dimByAxis ? [...dimByAxis.values()].some((d) => d.length > 0) : false;
    const summedLengthMm = anyDimSum
      ? Math.max(...AXES.map((axis) => (dimByAxis?.get(axis) ?? []).reduce((a, b) => a + b, 0)))
      : null;

    if (points.length < 2 && !anyDimSum) continue; // no size data at all for this spool

    const box = [...axisTotals].sort((a, b) => b - a) as [number, number, number];
    const container = CONTAINERS.find((c) => box.every((dim, i) => dim <= c.internalMm[i]))?.name ?? "oversized";
    fitBySpool.set(spoolNo, { boundingBoxMm: box, summedLengthMm, container });
  }

  const tags: TagDraft[] = [];
  const n = normalizeCellValue; // collapse any embedded newlines to " / "
  for (const { drawing_number, pageNumber, result } of allSheets) {
    // Classes present on this sheet, with their pressure class where known --
    // the basis for placing each BOM item when the drawing has a spec break.
    const specsWithRatings = (result.spec_breaks ?? []).map((b) => ({
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
    for (const item of result.bom_items ?? []) {
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

    for (const spool of result.spools ?? []) {
      const spoolNo = n(spool.spool_no);
      if (!spoolNo) continue;
      const fit = fitBySpool.get(spoolNo);
      tags.push({
        tagType: "spool",
        tagNumber: spoolNo,
        sourcePage: pageNumber,
        attributes: {
          drawing_number,
          line_number: result.line_number,
          boundary_note: n(spool.boundary_note),
          // Each axis is max(coordinate extent, dimension sum) WITHIN that
          // same axis -- see the fitBySpool computation above for why the two
          // signals are only ever combined per axis, never across axes.
          // null when neither coordinate callouts nor axis-tagged dimensions
          // were found for this spool at all (not enough data to size it).
          bounding_box_mm: fit?.boundingBoxMm ?? null,
          // The single largest per-axis dimension total, for reference/audit
          // -- not itself a spool dimension (that's bounding_box_mm), just
          // shows the biggest run-length signal that went into computing it.
          summed_length_mm: fit?.summedLengthMm ?? null,
          shipping_container: fit?.container ?? null,
        },
      });
    }

    // Prefer the weld's own printed tag (SW01, FW02 -- shop and field welds
    // are numbered in two separate sequences that both restart at 01, so the
    // prefix is kept rather than normalized away). Falls back to a per-sheet
    // sequence number only for the rare mark with no printed tag at all.
    (result.welds ?? []).forEach((weld, i) => {
      tags.push({
        tagType: "weld",
        tagNumber: n(weld.weld_tag) ?? `W${pageNumber}-${i + 1}`,
        sourcePage: pageNumber,
        attributes: {
          drawing_number,
          line_number: result.line_number,
          spool_no: n(weld.spool_no),
          weld_type: n(weld.weld_type),
          size: n(weld.size),
          location_note: n(weld.location_note),
        },
      });
    });

    // Audit trail for the spool sizing computation above -- stored as their
    // own tags (not just used transiently) so a wrong bounding_box_mm/
    // summed_length_mm can be traced back to the exact points/dimensions
    // that produced it, instead of having to be inferred after the fact.
    (result.route_points ?? []).forEach((p, i) => {
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
    (result.dimensions ?? []).forEach((d, i) => {
      tags.push({
        tagType: "dimension",
        tagNumber: `DIM${pageNumber}-${i + 1}`,
        sourcePage: pageNumber,
        attributes: {
          drawing_number,
          line_number: result.line_number,
          spool_no: n(d.spool_no),
          value_mm: n(d.value_mm),
          axis: n(d.axis),
          from_ref: n(d.from_ref),
          to_ref: n(d.to_ref),
        },
      });
    });
  }

  return { rawJson: { sheets: allSheets }, tags };
};