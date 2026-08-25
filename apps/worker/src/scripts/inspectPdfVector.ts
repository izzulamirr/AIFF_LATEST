// Diagnostic CLI for apps/worker/src/pdfVectorGeometry.ts -- downloads a
// real ISO PDF from Storage, extracts its vector segments and positioned
// text runs, and prints whatever sits near a given tag's text position.
// Built to re-verify the SW21 leader-line example by hand (a red line
// traced from the SW21 diamond up to its attachment point on the pipe) end
// to end through the real extractor -- see the Phase 1 plan for why this
// matters: it's the concrete, reviewable checkpoint before any shape
// classification or graph-walk logic gets written against assumptions
// instead of real geometry.
//
// Usage: pnpm --filter worker exec tsx src/scripts/inspectPdfVector.ts <documentId> [--near "SW21"] [--radius 40] [--render out.png]
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { createDb, documents, extractedTags } from "@easy/db";
import { and, eq, inArray } from "drizzle-orm";
import { createCanvas } from "@napi-rs/canvas";
import "../pdfPolyfills";
import { extractPageTextPositions, extractPageVectorSegments } from "../pdfVectorGeometry";
import { classifyPageShapes, computeBoundedGroups, computeWeldSpoolCorrections } from "../pdfShapeClassification";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

function parseArgs(argv: string[]) {
  const documentId = argv[2];
  let near: string | null = null;
  let radius = 40;
  let xy: [number, number] | null = null;
  let render: string | null = null;
  let classify = false;
  let dimensions = false;
  let spools = false;
  let crop: [number, number, number] | null = null;
  let grid = false;
  let gridStep = 10;
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === "--near") near = argv[++i];
    else if (argv[i] === "--radius") radius = Number(argv[++i]);
    else if (argv[i] === "--xy") xy = [Number(argv[++i]), Number(argv[++i])];
    else if (argv[i] === "--render") render = argv[++i];
    else if (argv[i] === "--classify") classify = true;
    else if (argv[i] === "--dimensions") dimensions = true;
    else if (argv[i] === "--spools") spools = true;
    else if (argv[i] === "--crop") crop = [Number(argv[++i]), Number(argv[++i]), Number(argv[++i])];
    else if (argv[i] === "--grid") grid = true;
    else if (argv[i] === "--grid-step") gridStep = Number(argv[++i]);
  }
  return { documentId, near, radius, xy, render, classify, dimensions, spools, crop, grid, gridStep };
}

// Deterministic per-edge color for the render overlay -- HSL around the
// wheel so adjacent edge ids stay visually distinct without random flicker
// between runs.
function edgeColor(edgeId: number): string {
  const hue = (edgeId * 47) % 360;
  return `hsla(${hue}, 85%, 45%, 0.9)`;
}

function dist2(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

async function main() {
  const { documentId, near, radius, xy, render, classify, dimensions, spools, crop, grid, gridStep } = parseArgs(process.argv);
  if (!documentId) {
    console.error(
      'Usage: tsx src/scripts/inspectPdfVector.ts <documentId> [--near "SW21"] [--radius 40] [--xy x y] [--render out.png] [--classify] [--dimensions] [--spools] [--crop x y radius] [--grid] [--grid-step 10]'
    );
    process.exit(1);
  }
  if (crop && !render) {
    console.error("--crop requires --render <out.png> to know where to save it.");
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Missing DATABASE_URL -- see apps/worker/.env.example.");
  const db = createDb(databaseUrl);
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!doc) throw new Error(`No document ${documentId}`);
  console.log(`File: ${doc.fileName}, storagePath: ${doc.storagePath}`);

  const storage = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: fileData, error } = await storage.storage.from("documents").download(doc.storagePath);
  if (error || !fileData) throw new Error(`Download failed: ${error?.message}`);
  const buf = Buffer.from(await fileData.arrayBuffer());
  console.log(`Downloaded ${buf.length} bytes`);

  // Both extractors take an explicit page list rather than discovering it
  // themselves, so get the page count first via a bare pdf.js load.
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  const pageNumbers = Array.from({ length: pdf.numPages }, (_, i) => i + 1);

  const texts = await extractPageTextPositions(buf, pageNumbers);
  const segments = await extractPageVectorSegments(buf, pageNumbers);

  // Ground truth for the classify cross-check -- this document's own
  // already-extracted weld tags, grouped by sourcePage, so the geometric
  // weld-symbol count found here can be compared against what the live
  // (vision-based) pipeline already recorded for the same sheet.
  const existingWeldTags = classify || spools
    ? await db.select().from(extractedTags).where(and(eq(extractedTags.documentId, documentId), inArray(extractedTags.tagType, ["weld"])))
    : [];
  // Ground truth for --dimensions -- this document's own already-extracted
  // dimension tags (value_mm, axis, spool_no, from_ref/to_ref), so the real
  // inventory below is built from values actually on record for this sheet,
  // not guessed at from regex-matching arbitrary numeric text.
  const existingDimensionTags = dimensions
    ? await db.select().from(extractedTags).where(and(eq(extractedTags.documentId, documentId), inArray(extractedTags.tagType, ["dimension"])))
    : [];

  let renderedPage = false;

  for (const pageNumber of pageNumbers) {
    const pageTexts = texts.filter((t) => t.pageNumber === pageNumber);
    const pageSegments = segments.filter((s) => s.pageNumber === pageNumber);
    console.log(`\n--- Page ${pageNumber}: ${pageTexts.length} text runs, ${pageSegments.length} painted paths ---`);

    const shapes = classify || dimensions || spools ? classifyPageShapes(pageNumber, segments, texts) : null;
    if (shapes && classify) {
      const existingCount = existingWeldTags.filter((t) => (t.sourcePage ?? 0) === pageNumber).length;
      console.log(
        `\n  Classification: ${shapes.welds.length} weld symbols found (this document's already-extracted weld tags for this page: ${existingCount}), ` +
          `${shapes.leaderLines.length} leader lines, ${shapes.nodes.length} route nodes, ${shapes.edges.length} route edges, ${shapes.unclassified.length} unclassified shapes.`
      );

      const missingTags = existingWeldTags
        .filter((t) => (t.sourcePage ?? 0) === pageNumber)
        .map((t) => t.tagNumber.toUpperCase())
        .filter((tag) => !shapes.welds.some((w) => w.tagNumber === tag));
      if (missingTags.length > 0) console.log(`  Already-extracted weld tags with NO matching geometric symbol found: ${missingTags.join(", ")}`);
      const extraTags = shapes.welds.map((w) => w.tagNumber).filter((tag) => !existingWeldTags.some((t) => t.tagNumber.toUpperCase() === tag));
      if (extraTags.length > 0) console.log(`  Geometric weld symbols with NO matching already-extracted tag: ${extraTags.join(", ")}`);

      console.log(`\n  Weld -> edge snap assignments:`);
      for (const a of shapes.weldEdgeAssignments) {
        const flag = a.distance > 20 ? "  <-- WEAK SNAP" : "";
        console.log(`    ${a.weldTagNumber} -> edge ${a.edgeId} @ (${a.atPoint[0].toFixed(1)},${a.atPoint[1].toFixed(1)}), distance ${a.distance.toFixed(2)}${flag}`);
      }
      const unsnapped = shapes.welds.filter((w) => !shapes.weldEdgeAssignments.some((a) => a.weldTagNumber === w.tagNumber));
      if (unsnapped.length > 0) console.log(`  Welds with NO leader line found (so no edge snap): ${unsnapped.map((w) => w.tagNumber).join(", ")}`);

      if (shapes.unclassified.length > 0) {
        console.log(`\n  Unclassified shapes (candidate valve/flange/dimension marks), largest 20 by size:`);
        const sorted = [...shapes.unclassified].sort((a, b) => b.bboxDiagonal - a.bboxDiagonal).slice(0, 20);
        for (const u of sorted) {
          console.log(`    [${u.points.length}pt, diag ${u.bboxDiagonal.toFixed(1)}] nearby text: ${u.nearbyText.join(" ") || "(none)"}`);
        }
      }
    }

    // Phase 3a: not classification, just a systematic real-data inventory --
    // for every dimension this document's OWN prior extraction already put
    // on record, find its value's text run(s) and dump every nearby shape at
    // two radii, flagging anything that's actually part of a known weld's
    // leader-line geometry (the "5035"/SW43/SW45 entanglement found this
    // session) so it doesn't get silently mistaken for dimension geometry.
    if (dimensions && shapes) {
      const pageDims = existingDimensionTags.filter((t) => (t.sourcePage ?? 0) === pageNumber);
      console.log(`\n  === Dimension inventory: ${pageDims.length} already-extracted dimension tag(s) on this page ===`);
      for (const dimTag of pageDims) {
        const attrs = dimTag.attributes as Record<string, unknown>;
        const valueMm = typeof attrs.value_mm === "string" ? attrs.value_mm : null;
        const axis = typeof attrs.axis === "string" ? attrs.axis : null;
        const spoolNo = typeof attrs.spool_no === "string" ? attrs.spool_no : null;
        console.log(`\n  [${dimTag.tagNumber}] value_mm="${valueMm}" axis=${axis ?? "?"} spool_no=${spoolNo ?? "?"}`);
        if (!valueMm) {
          console.log(`    (no value_mm on record -- nothing to search for)`);
          continue;
        }
        const valueTexts = pageTexts.filter((t, i) => t.str.trim() === valueMm || `${t.str}${pageTexts[i + 1]?.str ?? ""}`.trim() === valueMm);
        if (valueTexts.length === 0) {
          console.log(`    "${valueMm}" not found as a text run on this page (may be on a different sheet, or printed differently).`);
          continue;
        }
        for (const vt of valueTexts) {
          console.log(`    text "${vt.str}" @ (${vt.x.toFixed(1)}, ${vt.y.toFixed(1)})`);
          for (const r of [20, 50]) {
            const nearbySegs = pageSegments.filter((s) => s.points.some((p) => Math.hypot(p[0] - vt.x, p[1] - vt.y) < r));
            console.log(`      within ${r}pt: ${nearbySegs.length} shape(s)`);
            for (const s of nearbySegs) {
              const matchesLeader = shapes.leaderLines.find((l) => s.points.some((p) => dist2(p, l.to) < 0.5 || dist2(p, l.from) < 0.5));
              const flag = matchesLeader ? `  <-- belongs to weld ${matchesLeader.weldTagNumber}'s leader line, NOT this dimension` : "";
              console.log(
                `        [width=${s.lineWidth}, ${s.points.length}pt]${flag} ${s.points.map((p) => `(${p[0].toFixed(1)},${p[1].toFixed(1)})`).join(" ")}`
              );
            }
          }
          const nearbyText = pageTexts.filter((t) => t !== vt && Math.hypot(t.x - vt.x, t.y - vt.y) < 30);
          console.log(`      nearby text (30pt): ${nearbyText.map((t) => `"${t.str}"`).join(" ") || "(none)"}`);
        }
      }
    }

    // Applies the geometry to the actual question: does the live pipeline's
    // (vision-based) spool_no per weld agree with what deterministic
    // geometry says? Groups are FW/valve-bounded connected components of the
    // route graph (computeBoundedGroups) -- a real, geometry-confirmed
    // boundary, though a group can still legitimately span >1 real spool if
    // an unclassified flange sits inside it (see that function's own
    // comment). Two kinds of disagreement get flagged:
    //  - Same geometric group, different spool_no in the DB -- vision split
    //    a group geometry says is one continuous, unbroken run. Could be a
    //    real vision mistake, OR a genuine valve/flange boundary geometry
    //    doesn't know about yet -- can't tell which without valve/flange
    //    classification (not built), so this is a LEAD, not a verdict.
    //  - Different geometric groups (a confirmed field weld sits between
    //    them), same spool_no in the DB -- this one IS a confident
    //    violation: two welds either side of a real field weld can never be
    //    the same spool, full stop (the same HARD CONSTRAINT already
    //    encoded in isoQualityChecks.ts, just checked here against a
    //    geometrically-confirmed FW instead of a vision-reported one).
    if (spools && shapes) {
      const boundedGroups = computeBoundedGroups(shapes);
      const spoolByWeld = new Map(
        existingWeldTags
          .filter((t) => (t.sourcePage ?? 0) === pageNumber)
          .map((t) => [t.tagNumber.toUpperCase(), (t.attributes as Record<string, unknown>).spool_no as string | undefined])
      );

      console.log(
        `\n  === Geometry vs. already-extracted spool_no: ${boundedGroups.groupCount} FW/valve-bounded group(s) found (${shapes.valves.length} valve(s) detected and split into the route graph) ===`
      );
      shapes.valves.forEach((v, i) => {
        const vbg = boundedGroups.valveBorderTags[i];
        console.log(
          `    valve @ (${v.center[0].toFixed(1)},${v.center[1].toFixed(1)}) bboxDiagonal=${v.bboxDiagonal.toFixed(1)} beforeEdgeIds=${v.beforeEdgeIds.join(",")} afterEdgeIds=${v.afterEdgeIds.join(",")} before=[${vbg?.before.join(",")}] after=[${vbg?.after.join(",")}]`
        );
        if (process.env.DEBUG_VALVES) {
          const incident = (nodeId: number) => shapes.edges.filter((e) => e.nodeA === nodeId || e.nodeB === nodeId).map((e) => e.id);
          console.log(`      beforeFarNodeIds=${v.beforeFarNodeIds.join(",")} afterFarNodeIds=${v.afterFarNodeIds.join(",")}`);
          for (const nodeId of v.beforeFarNodeIds) console.log(`      before far node=${nodeId} incident edges=${incident(nodeId).join(",")}`);
          for (const nodeId of v.afterFarNodeIds) console.log(`      after far node=${nodeId} incident edges=${incident(nodeId).join(",")}`);
        }
      });
      const byGroup = new Map<number, string[]>();
      for (const [tag, groupId] of boundedGroups.groupByWeld) {
        const list = byGroup.get(groupId) ?? [];
        list.push(tag);
        byGroup.set(groupId, list);
      }
      for (const [groupId, tags] of [...byGroup.entries()].sort((a, b) => a[0] - b[0])) {
        const spoolsInGroup = new Map<string, string[]>();
        for (const tag of tags) {
          const sp = spoolByWeld.get(tag) ?? "(none)";
          const list = spoolsInGroup.get(sp) ?? [];
          list.push(tag);
          spoolsInGroup.set(sp, list);
        }
        const agrees = spoolsInGroup.size === 1;
        console.log(`\n  Group ${groupId} (${tags.length} welds, geometrically one unbroken run): ${agrees ? "AGREES" : "DISAGREES"} with recorded spool_no`);
        for (const [sp, tagsInSpool] of spoolsInGroup) console.log(`    spool_no="${sp}": ${tagsInSpool.join(", ")}`);
      }

      // The confident direction: a weld sharing an FW's own spool_no while
      // sitting in a group that ISN'T one of the groups that FW's own edge
      // actually borders (fwBorderGroups) -- geometrically impossible, not
      // just "different from some other weld nearby."
      const fwWelds = shapes.welds.filter((w) => w.weldType === "field weld");
      for (const fw of fwWelds) {
        const fwSpool = spoolByWeld.get(fw.tagNumber);
        if (!fwSpool) continue;
        const borderGroups = boundedGroups.fwBorderGroups.get(fw.tagNumber) ?? [];
        const impossibleMatches = [...boundedGroups.groupByWeld.entries()].filter(
          ([tag, groupId]) => tag !== fw.tagNumber && spoolByWeld.get(tag) === fwSpool && !borderGroups.includes(groupId)
        );
        if (impossibleMatches.length > 0) {
          console.log(
            `\n  CONFIRMED VIOLATION: field weld ${fw.tagNumber} (borders group(s) ${borderGroups.join(",") || "none found"}) shares spool_no="${fwSpool}" with, but is NOT geometrically adjacent to: ${impossibleMatches.map(([t]) => t).join(", ")}`
          );
        }
      }

      // Same question for valves: does a weld share spool_no with the welds
      // on the OTHER side of a confirmed valve? Uses the real shared
      // function (not a hand-rolled reimplementation like the FW block
      // above) since the "clean consensus on both sides" logic is more
      // involved than a simple border-group membership check.
      const rawSpoolByTag = new Map(spoolByWeld);
      const { hardFlagByTag } = computeWeldSpoolCorrections(shapes, boundedGroups, rawSpoolByTag);
      for (const [tag, message] of hardFlagByTag) {
        if (message.includes("valve symbol")) console.log(`\n  CONFIRMED VALVE-CROSSING VIOLATION: ${tag} -- ${message}`);
        else if (message.includes("branch of a tee/junction")) console.log(`\n  CONFIRMED JUNCTION-SIBLING VIOLATION: ${tag} -- ${message}`);
        // else: the FW case above already covers field-weld messages
      }

      if (boundedGroups.junctionLegs.size > 0) {
        console.log(`\n  === Junction legs (${boundedGroups.junctionLegs.size} junction(s) with 2+ distinct legs) ===`);
        for (const [junctionId, legs] of boundedGroups.junctionLegs) {
          console.log(`    junction node ${junctionId}: ${legs.map((l) => `[${l.join(",")}]`).join(" vs ")}`);
        }
      }
    }

    if (xy) {
      const [x, y] = xy;
      console.log(`\n  Near (${x}, ${y}), radius ${radius}, all widths:`);
      const nearby = pageSegments.filter((s) => s.points.some((p) => Math.hypot(p[0] - x, p[1] - y) < radius));
      for (const s of nearby) {
        const kind = s.points.length === 2 ? "LINE" : s.points.length <= 6 ? "polygon" : "curve/complex";
        console.log(`    [width=${s.lineWidth}, ${kind}, ${s.points.length}pt] ${s.points.map((p) => `(${p[0].toFixed(1)},${p[1].toFixed(1)})`).join(" ")}`);
      }
      const nearbyText = pageTexts.filter((t) => Math.hypot(t.x - x, t.y - y) < radius);
      console.log(`  Nearby text: ${nearbyText.map((t) => `"${t.str}"@(${t.x.toFixed(1)},${t.y.toFixed(1)})`).join(" ")}`);
    }

    // Visual proof: render the actual page and draw the extracted geometry
    // on top of it -- a coordinate dump is hard to eyeball against the real
    // drawing, an overlaid image isn't. Every width=0 path in cyan (the real
    // CAD symbol/line geometry, per this session's finding that width=6 is
    // duplicate text-glyph outlines and noise); whatever matched --near
    // highlighted in red/lime on top of that.
    const nearMatchesThisPage = near ? pageTexts.some((t, i) => t.str.includes(near) || `${t.str}${pageTexts[i + 1]?.str ?? ""}`.includes(near)) : true;
    if (render && !renderedPage && nearMatchesThisPage) {
      renderedPage = true;
      const page = await pdf.getPage(pageNumber);
      // A crop needs to be zoomed in far enough that tiny symbols (a valve's
      // bowtie, an item balloon) are actually legible -- confirmed this
      // session that scale=3 (the whole-page default) is nowhere near
      // enough for that; the crops that worked used 10-12.
      const scale = crop ? 12 : 3;
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;

      const toPixel = (x: number, y: number) => viewport.convertToViewportPoint(x, y) as [number, number];

      // Crop bounds computed up front (not just at output time) so the grid
      // labels below can be anchored to the crop's own visible edge --
      // fixes a real bug where labels were placed near the FULL page's
      // top-left corner (x0+2, 12) / (2, y0-2), which falls completely
      // outside a crop centered far from the page origin, producing a
      // gridded-but-unlabeled image.
      const cropBounds = crop
        ? (() => {
            const [cx, cy, cropRadius] = crop;
            const [px, py] = toPixel(cx, cy);
            const halfPx = cropRadius * scale;
            const sx = Math.max(0, px - halfPx);
            const sy = Math.max(0, py - halfPx);
            const sw = Math.min(canvas.width - sx, halfPx * 2);
            const sh = Math.min(canvas.height - sy, halfPx * 2);
            return { sx, sy, sw, sh };
          })()
        : null;

      // Labeled gridlines at a fixed PDF-point interval -- the actual
      // missing piece behind this session's failed attempt to pin down a
      // valve symbol's exact coordinates from a rendered crop: every prior
      // attempt required guessing a center point, rendering, and iterating
      // blind. This makes reading an exact coordinate off the image a
      // direct lookup instead. Drawn first (light, so real drawing content
      // stays legible on top) and independent of scale, so a labeled line
      // means the same PDF coordinate at any zoom level.
      if (grid) {
        ctx.strokeStyle = "rgba(0,120,255,0.35)";
        ctx.lineWidth = 1;
        ctx.font = `${Math.max(9, scale * 1.1)}px sans-serif`;
        const [pageW, pageH] = [viewport.width / scale, viewport.height / scale];
        const labelY = cropBounds ? cropBounds.sy + 14 : 12;
        const labelX = cropBounds ? cropBounds.sx + 3 : 2;
        for (let gx = Math.ceil(0 / gridStep) * gridStep; gx <= pageW; gx += gridStep) {
          const [x0, y0] = toPixel(gx, 0);
          const [x1, y1] = toPixel(gx, pageH);
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
          const text = String(gx);
          const tw = ctx.measureText(text).width;
          ctx.fillStyle = "rgba(255,255,255,0.85)";
          ctx.fillRect(x0 + 1, labelY - 10, tw + 2, 12);
          ctx.fillStyle = "rgba(0,90,200,0.95)";
          ctx.fillText(text, x0 + 2, labelY);
        }
        for (let gy = Math.ceil(0 / gridStep) * gridStep; gy <= pageH; gy += gridStep) {
          const [x0, y0] = toPixel(0, gy);
          const [x1, y1] = toPixel(pageW, gy);
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
          const text = String(gy);
          const tw = ctx.measureText(text).width;
          ctx.fillStyle = "rgba(255,255,255,0.85)";
          ctx.fillRect(labelX - 1, y0 - 11, tw + 2, 12);
          ctx.fillStyle = "rgba(0,90,200,0.95)";
          ctx.fillText(text, labelX, y0 - 2);
        }
      }

      if (shapes) {
        // Each merged route edge in its own color -- makes a mis-merge (two
        // edges that should be one, or one edge that bled across a real
        // joint) visible at a glance, the same way the plain cyan overlay
        // made the diamond/leader line visible in Phase 1.
        ctx.lineWidth = 2;
        for (const edge of shapes.edges) {
          ctx.strokeStyle = edgeColor(edge.id);
          ctx.beginPath();
          const [x0, y0] = toPixel(...edge.points[0]);
          ctx.moveTo(x0, y0);
          for (const p of edge.points.slice(1)) {
            const [px, py] = toPixel(...p);
            ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
        for (const node of shapes.nodes) {
          const [nx, ny] = toPixel(...node.point);
          ctx.fillStyle = node.edgeIds.length >= 3 ? "rgba(255,140,0,0.9)" : "rgba(80,80,80,0.7)";
          ctx.beginPath();
          ctx.arc(nx, ny, node.edgeIds.length >= 3 ? 5 : 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
        for (const a of shapes.weldEdgeAssignments) {
          const [px, py] = toPixel(...a.atPoint);
          ctx.fillStyle = edgeColor(a.edgeId);
          ctx.beginPath();
          ctx.arc(px, py, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "black";
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
        // Detected valve symbols -- a green square at the split point, so a
        // valve is visually distinguishable from a weld's round dot and
        // from a plain route-graph node, and can be checked by eye against
        // where the real bowtie sits in the underlying page render.
        for (const v of shapes.valves) {
          const [vx, vy] = toPixel(...v.center);
          ctx.fillStyle = "rgba(0, 200, 60, 0.85)";
          ctx.fillRect(vx - 5, vy - 5, 10, 10);
          ctx.strokeStyle = "black";
          ctx.lineWidth = 0.5;
          ctx.strokeRect(vx - 5, vy - 5, 10, 10);
        }
      } else {
        // Color-coded by line width -- cyan=0 (real CAD symbol/line
        // geometry), magenta=6 (assumed text-glyph-outline noise, but that
        // assumption was only checked against actual text glyphs, never
        // against a valve/fitting symbol; coloring it separately makes it
        // directly checkable against a rendered symbol instead of assumed),
        // orange=14 (the real pipe centerline).
        ctx.lineWidth = 1;
        for (const s of pageSegments) {
          if (s.points.length < 2) continue;
          if (s.lineWidth === 0) ctx.strokeStyle = "rgba(0, 180, 220, 0.55)";
          else if (s.lineWidth === 6) ctx.strokeStyle = "rgba(230, 0, 200, 0.55)";
          else if (s.lineWidth === 14) ctx.strokeStyle = "rgba(255, 140, 0, 0.55)";
          else continue;
          ctx.beginPath();
          const [x0, y0] = toPixel(...s.points[0]);
          ctx.moveTo(x0, y0);
          for (const p of s.points.slice(1)) {
            const [px, py] = toPixel(...p);
            ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
      }

      if (near) {
        const nearTargets = pageTexts.filter((t, i) => t.str.includes(near) || `${t.str}${pageTexts[i + 1]?.str ?? ""}`.includes(near));
        for (const target of nearTargets) {
          const highlighted = pageSegments.filter(
            (s) => s.lineWidth === 0 && s.points.some((p) => Math.hypot(p[0] - target.x, p[1] - target.y) < radius)
          );
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(255, 0, 60, 0.9)";
          for (const s of highlighted) {
            ctx.beginPath();
            const [x0, y0] = toPixel(...s.points[0]);
            ctx.moveTo(x0, y0);
            for (const p of s.points.slice(1)) {
              const [px, py] = toPixel(...p);
              ctx.lineTo(px, py);
            }
            ctx.stroke();
          }
          const [tx, ty] = toPixel(target.x, target.y);
          ctx.fillStyle = "rgba(0, 200, 0, 0.9)";
          ctx.beginPath();
          ctx.arc(tx, ty, 5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      let outputCanvas = canvas;
      if (cropBounds) {
        const { sx, sy, sw, sh } = cropBounds;
        const cropped = createCanvas(sw, sh);
        cropped.getContext("2d").drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
        outputCanvas = cropped;
      }

      await writeFile(render, outputCanvas.toBuffer("image/png"));
      console.log(`\n  Rendered overlay -> ${render}`);
    }

    if (!near) continue;

    // A tag like "SW21" is not one text run -- the drawing's own text layer
    // splits it into a "SW" run and a separate "21" run sitting a few points
    // away (confirmed this session: "SW" @ (259.4,272.8), "21" @
    // (260.6,268.7)). Match on either a single run containing the needle, or
    // two adjacent runs (by reading order, which pdf.js preserves from the
    // content stream) whose concatenation does.
    const targets = pageTexts.filter((t, i) => t.str.includes(near) || `${t.str}${pageTexts[i + 1]?.str ?? ""}`.includes(near));
    if (targets.length === 0) {
      console.log(`  "${near}" not found on this page (checked single runs and adjacent-pair concatenations).`);
      continue;
    }
    for (const target of targets) {
      console.log(`\n  Target "${target.str}" @ (${target.x.toFixed(1)}, ${target.y.toFixed(1)}), radius ${radius}:`);

      const nearbyText = pageTexts.filter((t) => t !== target && Math.hypot(t.x - target.x, t.y - target.y) < radius);
      console.log(`    Nearby text (${nearbyText.length}):`);
      for (const t of nearbyText) console.log(`      "${t.str}" @ (${t.x.toFixed(1)}, ${t.y.toFixed(1)})`);

      const nearbySegments = pageSegments.filter((s) => s.points.some((p) => Math.hypot(p[0] - target.x, p[1] - target.y) < radius));
      console.log(`    Nearby painted paths (${nearbySegments.length}):`);
      for (const s of nearbySegments) {
        const kind = s.points.length === 2 ? "LINE" : s.points.length <= 6 ? "polygon" : "curve/complex";
        const ptStr = s.points.map((p) => `(${p[0].toFixed(1)},${p[1].toFixed(1)})`).join(" ");
        console.log(`      [${kind}, ${s.points.length}pt, stroke=${s.stroked} fill=${s.filled} width=${s.lineWidth}] ${ptStr}`);
      }
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
