// Deterministic extraction of a PDF page's real vector geometry (line/curve
// paths in absolute page coordinates) and text runs (string + position).
// Phase 1 of tracing weld/spool/dimension placement directly from the ISO
// PDF's own CAD vector data instead of asking Claude's vision to visually
// re-derive it -- confirmed on a real ISO sheet that these drawings carry 0
// embedded raster images and thousands of real stroked vector paths plus a
// fully readable positioned text layer, so the exact leader-line-to-pipe
// connection a human would trace by eye is present as literal, computable
// geometry in the file. See pdfImages.ts/pdfText.ts for the sibling raster-
// image and plain-text extractors this reuses the same PDF buffer with.
import "./pdfPolyfills";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

export interface TextPosition {
  pageNumber: number;
  str: string;
  x: number;
  y: number;
}

export interface VectorSegment {
  pageNumber: number;
  // Absolute page-space points making up ONE painted path (already resolved
  // through the operator list's save/restore/transform stack -- see
  // extractPageVectorSegments's own comment for the matrix math). A path
  // with only 2 points is a straight line segment (a leader line or a
  // dimension witness line, most likely); more than that is a polyline,
  // polygon, or flattened curve (a symbol outline, a pipe route with
  // bends, or letterform/decorative art) -- shape classification (Phase 2)
  // decides what each one actually represents. Not deduplicated: the same
  // physical line can legitimately appear once per pass if the source draws
  // it stroke-then-fill.
  points: [number, number][];
  lineWidth: number | null;
  stroked: boolean;
  filled: boolean;
}

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

// PDF's `cm` operator concatenates as CTM' = M x CTM -- M (this operator's
// own args) is applied to path-space coordinates FIRST, then the CTM already
// in effect maps that into the frame established before this cm. Multiplying
// in the other order would silently produce wrong absolute positions any
// time more than one `cm` is nested (i.e. almost immediately on a real CAD
// export), so this order is load-bearing, not a stylistic choice.
function multiply(m: Matrix, ctm: Matrix): Matrix {
  return [
    m[0] * ctm[0] + m[1] * ctm[2],
    m[0] * ctm[1] + m[1] * ctm[3],
    m[2] * ctm[0] + m[3] * ctm[2],
    m[2] * ctm[1] + m[3] * ctm[3],
    m[4] * ctm[0] + m[5] * ctm[2] + ctm[4],
    m[4] * ctm[1] + m[5] * ctm[3] + ctm[5],
  ];
}

function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export async function extractPageTextPositions(pdfBuffer: Buffer, pageNumbers: number[]): Promise<TextPosition[]> {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
  const out: TextPosition[] = [];
  for (const pageNumber of pageNumbers) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    for (const item of textContent.items as Array<{ str?: string; transform?: number[] }>) {
      if (!item.str || !item.transform) continue;
      out.push({ pageNumber, str: item.str, x: item.transform[4], y: item.transform[5] });
    }
  }
  return out;
}

// pdf.js's numeric OPS codes for the path sub-operators packed into each
// constructPath call's own ops array -- each consumes a DIFFERENT number of
// raw coordinate values, confirmed against a real sample this session
// (`[[13,14,14,14,14],[0,0,9921,0,9921,7015,...` = moveTo + 4 lineTo, 2
// values each). Blindly pairing every 2 raw values as one point (an earlier
// draft of this) is only an accident of that one sample containing no curves
// or `re` rectangles -- curveTo consumes 6 (3 point-pairs), curveTo2/3
// consume 4 (2 point-pairs, PDF's `v`/`y` shorthand curves), and rectangle
// consumes 4 raw values that are NOT point-pairs at all (x, y, width,
// height) -- silently misreading those as 2 points would corrupt every
// point after the first `re` in a path. Codes read from pdfjsLib.OPS itself
// rather than hardcoded, since they're internal and only "confirmed for this
// pdfjs-dist version" rather than a stable public contract.
const ARITY: Record<number, number> = {
  [pdfjsLib.OPS.moveTo]: 2,
  [pdfjsLib.OPS.lineTo]: 2,
  [pdfjsLib.OPS.curveTo]: 6,
  [pdfjsLib.OPS.curveTo2]: 4,
  [pdfjsLib.OPS.curveTo3]: 4,
  [pdfjsLib.OPS.closePath]: 0,
  [pdfjsLib.OPS.rectangle]: 4,
};

const PAINT_OPS = new Set([
  pdfjsLib.OPS.stroke,
  pdfjsLib.OPS.closeStroke,
  pdfjsLib.OPS.fill,
  pdfjsLib.OPS.eoFill,
  pdfjsLib.OPS.fillStroke,
  pdfjsLib.OPS.eoFillStroke,
  pdfjsLib.OPS.closeFillStroke,
  pdfjsLib.OPS.closeEOFillStroke,
]);
const STROKE_OPS = new Set([pdfjsLib.OPS.stroke, pdfjsLib.OPS.closeStroke, pdfjsLib.OPS.fillStroke, pdfjsLib.OPS.eoFillStroke, pdfjsLib.OPS.closeFillStroke, pdfjsLib.OPS.closeEOFillStroke]);
const FILL_OPS = new Set([pdfjsLib.OPS.fill, pdfjsLib.OPS.eoFill, pdfjsLib.OPS.fillStroke, pdfjsLib.OPS.eoFillStroke, pdfjsLib.OPS.closeFillStroke, pdfjsLib.OPS.closeEOFillStroke]);

export async function extractPageVectorSegments(pdfBuffer: Buffer, pageNumbers: number[]): Promise<VectorSegment[]> {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
  const out: VectorSegment[] = [];

  for (const pageNumber of pageNumbers) {
    const page = await pdf.getPage(pageNumber);
    const opList = await page.getOperatorList();

    let ctm: Matrix = IDENTITY;
    const stack: Matrix[] = [];
    let lineWidth: number | null = null;
    // A single "path" (one or more constructPath calls before the next
    // paint) can contain multiple DISJOINT subpaths -- each `moveTo` starts
    // a new pen position with no implied connection to whatever came
    // before. Confirmed as a real, load-bearing distinction on this
    // document: one path painted the pipe route past a weld cluster, then
    // moveTo'd 300+pt away to an entirely unrelated stretch of pipe before
    // continuing, all under ONE stroke call. Flattening that into one
    // points array (an earlier version of this) fused unrelated pipe
    // segments into a single fake long "edge" downstream, which then made
    // physically distant welds look like they share one continuous run.
    // Each subpath becomes its own VectorSegment; only a bare lineTo/
    // curveTo/rectangle with no subpath open yet falls back to starting one
    // implicitly (a path is never valid without an initial moveTo, but
    // don't crash on a malformed one).
    let pendingSubpaths: [number, number][][] = [];

    function currentSubpath(): [number, number][] {
      if (pendingSubpaths.length === 0) pendingSubpaths.push([]);
      return pendingSubpaths[pendingSubpaths.length - 1];
    }

    for (let i = 0; i < opList.fnArray.length; i++) {
      const op = opList.fnArray[i];
      const args = opList.argsArray[i];

      if (op === pdfjsLib.OPS.save) {
        stack.push(ctm);
      } else if (op === pdfjsLib.OPS.restore) {
        ctm = stack.pop() ?? IDENTITY;
      } else if (op === pdfjsLib.OPS.transform) {
        ctm = multiply(args as Matrix, ctm);
      } else if (op === pdfjsLib.OPS.setLineWidth) {
        lineWidth = (args as number[])[0];
      } else if (op === pdfjsLib.OPS.constructPath) {
        const [subOps, coords] = args as [number[], number[], number[]];
        let c = 0;
        for (const subOp of subOps) {
          const arity = ARITY[subOp] ?? 0;
          if (subOp === pdfjsLib.OPS.moveTo) {
            pendingSubpaths.push([]);
          }
          if (subOp === pdfjsLib.OPS.rectangle) {
            const [x, y, w, h] = coords.slice(c, c + 4);
            // A rectangle is always its own closed subpath, never a
            // continuation of whatever came before it.
            pendingSubpaths.push([applyMatrix(ctm, x, y), applyMatrix(ctm, x + w, y), applyMatrix(ctm, x + w, y + h), applyMatrix(ctm, x, y + h), applyMatrix(ctm, x, y)]);
          } else {
            const subpath = currentSubpath();
            for (let k = c; k + 1 < c + arity; k += 2) subpath.push(applyMatrix(ctm, coords[k], coords[k + 1]));
          }
          c += arity;
        }
      } else if (PAINT_OPS.has(op)) {
        for (const subpath of pendingSubpaths) {
          if (subpath.length > 0) out.push({ pageNumber, points: subpath, lineWidth, stroked: STROKE_OPS.has(op), filled: FILL_OPS.has(op) });
        }
        pendingSubpaths = [];
      } else if (op === pdfjsLib.OPS.endPath) {
        // clip/eoClip deliberately fall through to no-op here: PDF's W/W*
        // only flags the CURRENT path for clipping, it doesn't end it -- a
        // "W S" sequence (clip AND stroke the same path) is valid and must
        // still reach the stroke branch above with pendingSubpaths intact.
        pendingSubpaths = [];
      }
    }
  }
  return out;
}
