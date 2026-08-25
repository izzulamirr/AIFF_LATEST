// Phase 2 of the vector-geometry tracer: turns pdfVectorGeometry.ts's raw
// VectorSegment/TextPosition lists into typed shapes -- weld symbols, their
// leader lines, and a connected pipe-route graph -- then snaps each weld
// onto the specific route edge its leader line actually touches. See the
// Phase 2 plan for the real-data evidence behind every signature used here
// (SW21/SW22 diamonds + leader lines, confirmed on the real drawing).
//
// Weld symbols/leader lines/the route graph operate on lineWidth === 0
// geometry (plus width=14 for the real pipe centerline, see the route
// graph's own comment). Valve symbols (below) are the one exception --
// confirmed on real data that width=6 is NOT purely the duplicate
// vector-drawn text-glyph outlines it was first assumed to be (that part is
// still true for text); valve/fitting symbol bodies are MOSTLY drawn at
// width=6, alongside the glyph-outline noise. Not exclusively, though: a
// full-page scan (prompted by a user-identified valve between SW30 and
// SW31, itself a width=6 bowtie just outside the old bbox band -- see
// VALVE_BBOX_MAX) turned up a second, previously undetected bowtie at
// (563.3,431.2) that's width=0, sitting right in among the width=0 route
// geometry -- same shape signature, just a different stroke width -- so the
// valve scan checks both widths, not width=6 alone.
import type { TextPosition, VectorSegment } from "./pdfVectorGeometry";

export interface WeldSymbol {
  tagNumber: string;
  weldType: "shop weld" | "field weld" | "unknown";
  center: [number, number];
  // All 4 diamond vertices, not just one -- a first version of this matched
  // leader lines against the TOP vertex only (true for SW21/SW22, the two
  // examples that motivated it), but a real check across more welds found
  // SW26's leader line touches its WEST vertex instead. The leader line
  // comes from whichever vertex actually faces the pipe attachment point,
  // which varies -- there's no single "always this side" convention.
  vertices: [number, number][];
}

export interface LeaderLine {
  weldTagNumber: string;
  from: [number, number]; // whichever of the weld symbol's 4 vertices this line actually touches
  to: [number, number]; // the far end -- the point actually touching the route
}

export interface RouteNode {
  id: number;
  point: [number, number]; // centroid of the endpoint(s) clustered into this node
  edgeIds: number[];
}

export interface RouteEdge {
  id: number;
  points: [number, number][]; // the edge's own polyline geometry, absolute page space
  nodeA: number;
  nodeB: number;
}

export interface WeldEdgeAssignment {
  weldTagNumber: string;
  edgeId: number;
  atPoint: [number, number]; // nearest point on the edge's polyline to the leader line's far end
  distance: number; // snap distance -- large values are a red flag, not a confident snap
}

export interface UnclassifiedShape {
  points: [number, number][];
  bboxDiagonal: number;
  nearbyText: string[];
}

export interface ValveSymbol {
  center: [number, number];
  bboxDiagonal: number;
  vertices: [number, number][]; // the 5 unique vertices of the closed bowtie path
  // Every route edge on the "before" / "after" side of this valve -- never
  // unioned across in computeBoundedGroups, exactly like a field weld's own
  // edge. Each always includes the corresponding half of the primary split
  // (splitting the nearest edge in two); PLUS a second entry when a bridge
  // to a nearby "loose end" was found on that side (see classifyPageShapes'
  // own comment on the valve-bridging pass) -- a valve often sits in a real
  // gap where the drawn pipe centerline is interrupted (confirmed on real
  // data: a ~36pt gap with no continuous stroke through the symbol at all),
  // so the two true sides are frequently separate, never-merged route
  // pieces rather than one edge to split.
  beforeEdgeIds: number[];
  afterEdgeIds: number[];
  // The actual far-side node id(s) reachable via beforeEdgeIds/afterEdgeIds
  // respectively -- the primary split's own far node, PLUS the bridge
  // target's node when one was found. Tracked explicitly rather than
  // re-derived from edge structure downstream, since the primary split and
  // a bridge edge don't share the same nodeA/nodeB convention for "which
  // end is far."
  beforeFarNodeIds: number[];
  afterFarNodeIds: number[];
  // Self-loop edges (both ends already the same graph node) near enough to
  // the valve to matter, but excluded from splitting since a self-loop
  // can't meaningfully be split into two different sides. Confirmed on a
  // real case: at a busy multi-weld tee, several short weld-bearing stubs
  // legitimately present as self-loops (each one's own two raw endpoints
  // independently merge into the same tee-node cluster), not just
  // meaningless artifacts -- a weld attached partway along one of these is
  // still real data, just not reachable through the normal split mechanism.
  // computeBoundedGroups uses these to classify such a weld by direction
  // instead.
  nearbySelfLoopEdgeIds: number[];
  // Set only when a bridge search (see JUNCTION_BRIDGE_SEARCH_RADIUS) found
  // a real JUNCTION (a tee/branch node, degree >= 3) rather than another
  // dead end on that side -- deliberately NOT folded into
  // beforeEdgeIds/beforeFarNodeIds (or the after- equivalents), unlike a
  // dead-end bridge. Merging a junction's own reachable welds into this
  // valve's before/after set would conflate "my own branch-specific welds"
  // with "everything else sharing the same trunk" -- exactly the
  // distinction computeBoundedGroups' junction-sibling check needs to draw.
  // Confirmed necessary on a real case: item 23 (a drain valve, genuinely
  // no pipe after it) sits on a branch off the same tee SW21/SW22 attach
  // to -- the real violation is that two different branches off one tee,
  // each independently bounded by its own valve, share a spool number, not
  // "before vs after of item 23's own valve" (which can never fire here).
  beforeJunctionNodeId: number | null;
  afterJunctionNodeId: number | null;
}

export interface PageShapeClassification {
  pageNumber: number;
  welds: WeldSymbol[];
  leaderLines: LeaderLine[];
  nodes: RouteNode[];
  edges: RouteEdge[];
  weldEdgeAssignments: WeldEdgeAssignment[];
  valves: ValveSymbol[];
  unclassified: UnclassifiedShape[];
  // Connector edges created by a weldolet-tap union (see
  // findMidEdgeTapTarget's own comment) -- unlike every other edge id
  // tracked on ValveSymbol, these are NOT boundary edges; they're ordinary,
  // unioned route edges. Tracked separately so computeBoundedGroups can
  // identify which GROUPS got merged by one, since that merge is a newer,
  // less-proven kind of connection than a plain FW/valve-bounded segment --
  // confirmed necessary on a real case where auto-fixing within such a
  // group corrected two welds in the WRONG direction (see
  // computeWeldSpoolCorrections' own comment on weldoletMergedGroupIds).
  weldoletTapEdgeIds: number[];
  // For every field weld whose own shared edge got split at its interior
  // position (see the field-weld splitting pass' own comment, right before
  // this function returns), its two ORIGINAL far nodes -- analogous to
  // ValveSymbol.beforeFarNodeIds/afterFarNodeIds, since a field weld is
  // exactly as hard a spool boundary as a valve, but wasn't getting the
  // same interior-split treatment (Phase 4 predates all of this session's
  // edge-splitting work). Confirmed necessary on a real case: FW02 sits at
  // segment index 22 of one 41-point edge that 6 other welds (spanning 4
  // different recorded spools) also shared, with nothing splitting it at
  // FW02's own position. No entry for an FW that was already effectively
  // at one of its edge's own endpoints (no real split needed).
  fwSplitFarNodes: Map<string, { before: number; after: number }>;
  // Both new sub-edges per split field weld (or the single original edge,
  // for the rare FW that didn't need splitting) -- the real boundary-edge
  // set computeBoundedGroups must exclude from union, replacing the old
  // "exclude whichever single edge this FW's own assignment happens to
  // reference" (which did nothing when many welds shared one long edge).
  fwBoundaryEdgeIds: number[];
}

function dist(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function bboxDiagonal(points: [number, number][]): number {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

// Unit tangent/direction from one point toward another -- used both to tell
// "these two route pieces are the same straight run, just broken by a
// symbol on top of it" apart from "these are two nearby but unrelated
// pieces" (classifyPageShapes' route-merging pass), and to classify a weld
// attached to a self-loop edge by direction from a valve's center
// (computeBoundedGroups' valveBorderTags).
function unitTangent(from: [number, number], to: [number, number]): [number, number] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  return len === 0 ? [0, 0] : [dx / len, dy / len];
}
function absDot(a: [number, number], b: [number, number]): number {
  return Math.abs(a[0] * b[0] + a[1] * b[1]);
}

// Confirmed on SW21 (center (262.3,272.3), radius ~6.1) and SW22 (center
// (296.15,288.6), radius ~6.1): a weld symbol is a closed 4-vertex diamond
// (5 points including the closing point back to the start), each vertex
// roughly equidistant from the centroid. Tolerances are deliberately loose
// (35% radius variance, 2-20pt radius range) since only two real examples
// informed them -- the verification step's own job is to confirm this holds
// for every such shape on the sheet, not just these two.
//
// A first version required EXACTLY 5 points, which silently missed SW41,
// SW48, and others -- checking their raw geometry directly found the real
// cause: for those welds, the diamond and its leader line are the SAME
// `constructPath`/stroke call, not two separate ones (confirmed on SW48:
// `(596.2,616.0) (590.2,609.8) (583.9,616.1) (589.9,622.2) (596.2,616.0)
// (620.5,622.0)` -- 5 points closing the diamond, then a 6th continuing
// straight into the leader line on the same path). Not a shape-detection
// ambiguity, just an inconsistency in how this PDF was generated -- some
// welds get 2 separate paths, others get 1 combined one.
//
// SW44 showed a second variant: the extra point comes BEFORE the diamond,
// not after -- `(256.3,445.6) (221.8,428.0) (215.8,421.9) (209.5,428.0)
// (215.5,434.2) (221.8,428.0)` is the leader's far end, then the diamond
// starting at index 1. So the diamond's 5-point closed loop can sit at ANY
// offset within a longer path, not just the start -- scan every valid
// offset rather than assuming one fixed layout.
function detectDiamond(
  points: [number, number][]
): { center: [number, number]; vertices: [number, number][]; leaderBefore: [number, number][]; leaderAfter: [number, number][] } | null {
  for (let offset = 0; offset + 4 < points.length; offset++) {
    if (dist(points[offset], points[offset + 4]) > 0.5) continue; // must close back to its own start
    const verts = points.slice(offset, offset + 4);
    const cx = verts.reduce((s, p) => s + p[0], 0) / 4;
    const cy = verts.reduce((s, p) => s + p[1], 0) / 4;
    const center: [number, number] = [cx, cy];
    const radii = verts.map((p) => dist(p, center));
    const avgRadius = radii.reduce((a, b) => a + b, 0) / 4;
    if (avgRadius < 2 || avgRadius > 20) continue;
    if (radii.some((r) => Math.abs(r - avgRadius) > avgRadius * 0.35)) continue;
    return {
      center,
      vertices: verts,
      leaderBefore: points.slice(0, offset + 1), // ends at verts[0] -- a leading continuation into the diamond
      leaderAfter: points.slice(offset + 4), // starts at verts[0] (the closing point) -- a trailing continuation out
    };
  }
  return null;
}

// Confirmed on item 10 (two independent physical placements, ~18.3-18.4pt
// bbox diagonal, essentially identical relative vertices between the two)
// and item 23 (a different valve type/size, same ~18.4pt diagonal): the
// classic isometric in-line-valve "bowtie" symbol is a single width=6
// closed path of exactly 6 points (5 edges) that self-intersects once --
// two of its non-adjacent edges cross, which is what makes it read as an
// hourglass rather than a simple pentagon. Checking for that crossing
// (rather than a fixed vertex template) is what makes this
// orientation-independent -- isometric pipes run in more than one
// canonical direction, so not every valve instance is rotated the same way
// as the two confirmed here.
//
// The bbox-diagonal band is centered on the confirmed ~18.3-18.4pt value --
// isometric valve symbols are apparently drawn at one standard annotation
// size regardless of actual pipe diameter (a 200mm ball valve and an 80mm
// gate valve both measured the same), which makes this a tight, reliable
// filter against the much smaller glyph-outline fragments that make up
// most of the rest of the width=6 population. One confirmed real valve
// (user-identified, between SW30 and SW31) measured 25.13 -- a genuine
// self-intersecting bowtie, just a different apparent size, sitting well
// clear of the next-largest non-valve crossing shape on this sheet (no
// other candidate anywhere between 18.5 and 25.13). Widened to 26 to admit
// it with a small margin, same "confirmed case + margin" approach as every
// other tolerance in this file.
const VALVE_BBOX_MIN = 14;
const VALVE_BBOX_MAX = 26;

function segmentsIntersect(a1: [number, number], a2: [number, number], b1: [number, number], b2: [number, number]): boolean {
  const cross = (p: [number, number], q: [number, number], r: [number, number]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = cross(b1, b2, a1);
  const d2 = cross(b1, b2, a2);
  const d3 = cross(a1, a2, b1);
  const d4 = cross(a1, a2, b2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function detectValveBowtie(points: [number, number][]): { center: [number, number]; bboxDiagonal: number; vertices: [number, number][] } | null {
  if (points.length !== 6) return null;
  if (dist(points[0], points[5]) > 0.5) return null; // must close back to its own start
  const verts = points.slice(0, 5);
  const diag = bboxDiagonal(verts);
  if (diag < VALVE_BBOX_MIN || diag > VALVE_BBOX_MAX) return null;
  const edges: [[number, number], [number, number]][] = verts.map((v, i) => [v, verts[(i + 1) % 5]]);
  let crosses = false;
  for (let i = 0; i < 5 && !crosses; i++) {
    for (let j = i + 1; j < 5; j++) {
      if (j === i + 1 || (i === 0 && j === 4)) continue; // adjacent edges share an endpoint -- never counts as crossing
      if (segmentsIntersect(edges[i][0], edges[i][1], edges[j][0], edges[j][1])) {
        crosses = true;
        break;
      }
    }
  }
  if (!crosses) return null;
  const cx = verts.reduce((s, p) => s + p[0], 0) / 5;
  const cy = verts.reduce((s, p) => s + p[1], 0) / 5;
  return { center: [cx, cy], bboxDiagonal: diag, vertices: verts };
}

// Weld tag prefixes, kept as two small named regexes rather than scattered
// literals -- this is a hardcoded heuristic by necessity (pure vector shape/
// text matching, no legend to read), same category as VALVE_BBOX_MIN/MAX
// etc. "SW" was the only confirmed shop-weld prefix for most of this
// session; "BW" (buttweld) confirmed real on a different sheet of this same
// line (a fabrication/cut sheet, tags "BW01"..."BW19" + one "FW01") -- same
// shop-fabricated-never-a-boundary semantics, different printed prefix.
const SHOP_WELD_TAG_PREFIX = /^(SW|BW)/i;
const FIELD_WELD_TAG_PREFIX = /^FW/i;

// "SW21"/"BW21" is never one text run -- the drawing's own text layer splits
// it into a prefix run and a separate number run a few points away
// (confirmed this session: "SW" @ (259.4,272.8), "21" @ (260.6,268.7)).
// Merge adjacent runs in reading order before matching against shapes.
interface MergedLabel {
  str: string;
  x: number;
  y: number;
}
function mergeWeldTagLabels(texts: TextPosition[]): MergedLabel[] {
  const merged: MergedLabel[] = [];
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    if (/^(SW|BW|FW)$/i.test(t.str.trim())) {
      const next = texts[i + 1];
      if (next && dist([t.x, t.y], [next.x, next.y]) < 15) {
        merged.push({ str: `${t.str}${next.str}`.toUpperCase(), x: t.x, y: t.y });
        i++; // consume the number run too
        continue;
      }
    }
    merged.push({ str: t.str, x: t.x, y: t.y });
  }
  return merged;
}

function weldTypeFromTag(tag: string): WeldSymbol["weldType"] {
  if (SHOP_WELD_TAG_PREFIX.test(tag)) return "shop weld";
  if (FIELD_WELD_TAG_PREFIX.test(tag)) return "field weld";
  return "unknown";
}

function pointToSegmentDistance(p: [number, number], a: [number, number], b: [number, number]): { dist: number; point: [number, number] } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = a[0] + t * dx;
  const cy = a[1] + t * dy;
  return { dist: dist(p, [cx, cy]), point: [cx, cy] };
}

function pointToPolylineDistance(p: [number, number], polyline: [number, number][]): { dist: number; point: [number, number] } {
  let best = { dist: Infinity, point: polyline[0] };
  for (let i = 0; i + 1 < polyline.length; i++) {
    const candidate = pointToSegmentDistance(p, polyline[i], polyline[i + 1]);
    if (candidate.dist < best.dist) best = candidate;
  }
  return best;
}

// Same as pointToPolylineDistance, but also reports which segment of the
// polyline the closest point falls on -- needed to actually split a route
// edge's polyline at a valve's snapped point (see the valve-splitting pass
// in classifyPageShapes), not just to measure a snap distance.
function pointToPolylineDistanceIndexed(p: [number, number], polyline: [number, number][]): { dist: number; point: [number, number]; segmentIndex: number } {
  let best = { dist: Infinity, point: polyline[0], segmentIndex: 0 };
  for (let i = 0; i + 1 < polyline.length; i++) {
    const candidate = pointToSegmentDistance(p, polyline[i], polyline[i + 1]);
    if (candidate.dist < best.dist) best = { ...candidate, segmentIndex: i };
  }
  return best;
}

// Small tick/arrowhead clusters (dimension marks, route-node markers -- see
// the plan's own note on why shape alone can't tell these apart yet) are
// nowhere near this size; real pipe-route pieces span much further. This
// keeps them out of the route graph so they don't become spurious tiny
// "edges" -- they surface in `unclassified` instead, for Phase 3 to sort out
// once the route graph gives them positional context (on vs. off an edge).
const ROUTE_MIN_SPAN = 15;
// Endpoints within this distance of each other are treated as the same
// physical joint outright, no further check needed.
const NODE_MERGE_TOLERANCE = 3;
// Measured directly against this document: the gap between a route piece's
// endpoint and the nearest OTHER piece's endpoint spreads continuously from
// 0 to 70+pt, with no natural cutoff -- p25=6.8, p50=17.4, p75=26.3. A pure
// distance tolerance can't bridge the real gaps (pipe centerline broken
// wherever a symbol sits on top of it) without also wrongly joining nearby
// unrelated pieces. GAP_BRIDGE_RADIUS widens the search, but a bridge only
// forms when direction agrees too (see COLLINEAR_COS_THRESHOLD below) --
// distance alone is not sufficient evidence of a real connection.
const GAP_BRIDGE_RADIUS = 30;
// cos(20deg) ~= 0.94 -- how parallel two pieces' tangents (and the gap
// direction between their endpoints) must be to bridge them. A genuine
// continuation of the same straight pipe run should be very close to
// perfectly collinear (it's vector-exact CAD geometry, not a hand
// sketch); 20 degrees leaves room for curveTo-flattening noise right at
// an endpoint without accepting a real corner/branch as a "straight" gap.
const COLLINEAR_COS_THRESHOLD = Math.cos((20 * Math.PI) / 180);
// How close a leader line's far end must land to a route edge to count as a
// confident snap, vs. a gap worth flagging (e.g. the edge got missed
// because it was filtered out, or genuinely doesn't reach this weld).
const SNAP_WARN_DISTANCE = 20;
// How close a detected valve bowtie's centroid must land to a route edge
// before it's trusted to split that edge. Measured directly against this
// document: every one of 7 detected bowtie candidates (matching all 3
// manually-confirmed valve locations from Phase 5a, plus 4 more of the
// same shape elsewhere on the sheet) has a nearest-route-edge distance
// clustered tightly in the 14.8-17.0pt band -- NOT close to 0. The bowtie
// is asymmetric relative to its own attachment point (the vertex where it
// actually touches the pipe, not its bounding-box centroid), so this
// consistent offset is real geometry, not noise; a first version of this
// threshold (15) was set assuming near-zero distance and silently dropped
// 6 of the 7 real candidates. 25 comfortably covers the measured band with
// margin while still being much tighter than "anything on the page." The
// one confirmed larger valve (diag=25.1, see VALVE_BBOX_MAX) scales the
// same offset up with it -- measured at 27.2 -- so the same "scale the
// symbol, scale the offset" logic pushes this to 30, still with margin, and
// still nowhere near "anything on the page" (no other real candidate is
// within 20pt of this line either way).
const VALVE_SNAP_MAX_DISTANCE = 30;
// How far past a primary split's own dead-end node to search for a "loose
// end" (a separate route piece with nowhere else to go) that's really the
// pipe continuing on the other side of a valve. A valve visually interrupts
// the drawn centerline in this CAD convention -- confirmed directly on a
// real case: item 10's first instance has a ~36pt gap with NO continuous
// stroke through the symbol at all, well beyond GAP_BRIDGE_RADIUS (which is
// deliberately conservative for the general case, since without a valve's
// own confirmed presence a 36pt+ bridge risks false-connecting unrelated
// pieces elsewhere). Only one real gap has been measured so far -- this is
// a starting point, not a settled constant; check it against more examples
// before trusting it broadly, same discipline as every other tolerance
// here.
const VALVE_BRIDGE_SEARCH_RADIUS = 60;
// A wider radius specifically for bridging to a JUNCTION (a real tee/branch
// node, degree >= 3) rather than another lone dead end. Confirmed directly:
// item 23's own "before" dead end sits 69.9pt from the real tee where
// SW21/SW22 attach -- just past VALVE_BRIDGE_SEARCH_RADIUS. A junction gets
// its own, larger tolerance rather than just widening the general radius,
// because a junction's own multi-edge identity (several other real pipe
// pieces already converge there) is much stronger grounding than another
// lone dead end happening to be nearby -- the false-connection risk that
// keeps the dead-end radius conservative doesn't apply the same way here.
// One confirmed real gap so far -- same "starting point, not settled"
// caveat as every other tolerance in this file.
const JUNCTION_BRIDGE_SEARCH_RADIUS = 85;

export function classifyPageShapes(pageNumber: number, segments: VectorSegment[], texts: TextPosition[]): PageShapeClassification {
  const pageSegments = segments.filter((s) => s.pageNumber === pageNumber && s.lineWidth === 0);
  const pageTexts = texts.filter((t) => t.pageNumber === pageNumber);
  const labels = mergeWeldTagLabels(pageTexts);

  const welds: WeldSymbol[] = [];
  const leaderLines: LeaderLine[] = [];
  const consumedDiamondIdx = new Set<number>();
  for (let i = 0; i < pageSegments.length; i++) {
    const shape = detectDiamond(pageSegments[i].points);
    if (!shape) continue;
    const label = labels
      .filter((l) => /^(SW|BW|FW)\d+$/i.test(l.str))
      .map((l) => ({ l, d: dist([l.x, l.y], shape.center) }))
      .sort((a, b) => a.d - b.d)[0];
    if (!label || label.d > 20) continue; // no plausible tag nearby -- not confident this is a weld symbol
    consumedDiamondIdx.add(i);
    const tagNumber = label.l.str.toUpperCase();
    welds.push({ tagNumber, weldType: weldTypeFromTag(label.l.str), center: shape.center, vertices: shape.vertices });
    // Some welds' diamond and leader line share this same path (see
    // detectDiamond's own comment) -- when that's the case, the leader is
    // already right here, no separate 2-point line to go find. The extra
    // points can sit before the diamond's start, after its close, or (in
    // principle) both -- whichever side actually has more than just the
    // diamond's own vertex.
    if (shape.leaderAfter.length > 1) {
      leaderLines.push({ weldTagNumber: tagNumber, from: shape.leaderAfter[0], to: shape.leaderAfter[shape.leaderAfter.length - 1] });
    } else if (shape.leaderBefore.length > 1) {
      leaderLines.push({ weldTagNumber: tagNumber, from: shape.leaderBefore[shape.leaderBefore.length - 1], to: shape.leaderBefore[0] });
    }
  }

  const consumedLeaderIdx = new Set<number>();
  for (let i = 0; i < pageSegments.length; i++) {
    if (consumedDiamondIdx.has(i)) continue;
    const pts = pageSegments[i].points;
    if (pts.length !== 2) continue;
    // Check all 4 vertices, not one fixed side -- the leader line touches
    // whichever vertex faces the pipe, which varies weld to weld.
    let matchedWeld: WeldSymbol | null = null;
    let matchedFromVertex: [number, number] | null = null;
    let to: [number, number] | null = null;
    for (const weld of welds) {
      for (const v of weld.vertices) {
        if (dist(v, pts[0]) < 0.5) {
          matchedWeld = weld;
          matchedFromVertex = v;
          to = pts[1];
          break;
        }
        if (dist(v, pts[1]) < 0.5) {
          matchedWeld = weld;
          matchedFromVertex = v;
          to = pts[0];
          break;
        }
      }
      if (matchedWeld) break;
    }
    if (!matchedWeld || !matchedFromVertex || !to) continue;
    if (leaderLines.some((l) => l.weldTagNumber === matchedWeld!.tagNumber)) continue; // already has an attached leader
    consumedLeaderIdx.add(i);
    leaderLines.push({ weldTagNumber: matchedWeld.tagNumber, from: matchedFromVertex, to });
  }

  // Everything left is either a route-graph edge candidate (long enough) or
  // an unclassified small shape (dimension marks, route-node markers, and
  // valve/flange symbols not yet identified -- see the plan's Phase 3 note).
  //
  // Route candidates are NOT width=0-only: checking a weld whose leader-line
  // snap distance was 158pt (SW20) found the real pipe centerline running
  // right through its leader's far endpoint drawn at width=14, a completely
  // different, much smaller population (22 paths sheet-wide vs. 324 at
  // width=0) -- width=0 is mostly leader lines/diamonds/annotation marks,
  // not the pipe route itself. width=14 is included here alongside width=0
  // rather than replacing it, since it's not yet confirmed whether any
  // genuine route geometry also exists at width=0.
  const routeWidthSegments = segments.filter((s) => s.pageNumber === pageNumber && (s.lineWidth === 0 || s.lineWidth === 14));
  const routeCandidates: { points: [number, number][] }[] = [];
  const unclassified: UnclassifiedShape[] = [];
  for (let i = 0; i < routeWidthSegments.length; i++) {
    const isWidth0 = routeWidthSegments[i].lineWidth === 0;
    // width=0 entries consumed as a diamond/leader above must be skipped --
    // width=14 entries were never in that pool, so always pass through.
    if (isWidth0) {
      const idxInPageSegments = pageSegments.indexOf(routeWidthSegments[i]);
      if (consumedDiamondIdx.has(idxInPageSegments) || consumedLeaderIdx.has(idxInPageSegments)) continue;
    }
    const points = routeWidthSegments[i].points;
    if (points.length < 2) continue;
    if (bboxDiagonal(points) >= ROUTE_MIN_SPAN) {
      routeCandidates.push({ points });
    } else if (isWidth0) {
      // Only width=0 leftovers go in the unclassified catalog -- width=14
      // is confirmed real route geometry, a short piece of it is still
      // route geometry, not a candidate valve/flange/dimension mark.
      const centroid: [number, number] = [points.reduce((s, p) => s + p[0], 0) / points.length, points.reduce((s, p) => s + p[1], 0) / points.length];
      const nearbyText = pageTexts.filter((t) => dist([t.x, t.y], centroid) < 20).map((t) => t.str);
      unclassified.push({ points, bboxDiagonal: bboxDiagonal(points), nearbyText });
    }
  }


  // Union-find over each route candidate's two endpoints -- turns "N
  // separately stroked pieces" into "a connected graph with real
  // joints/branches." Two passes: an exact-touch merge (NODE_MERGE_TOLERANCE,
  // no direction check needed), then a direction-aware bridge across the
  // larger real gaps a symbol leaves in an otherwise-straight run (see
  // GAP_BRIDGE_RADIUS/COLLINEAR_COS_THRESHOLD's own comments for why
  // distance alone can't do this safely).
  const endpoints: [number, number][] = [];
  const endpointTangents: [number, number][] = [];
  const edgeEndpointIdx: [number, number][] = []; // per route candidate: [startEndpointIdx, endEndpointIdx]
  for (const rc of routeCandidates) {
    edgeEndpointIdx.push([endpoints.length, endpoints.length + 1]);
    endpoints.push(rc.points[0], rc.points[rc.points.length - 1]);
    endpointTangents.push(unitTangent(rc.points[1] ?? rc.points[0], rc.points[0]), unitTangent(rc.points[rc.points.length - 2] ?? rc.points[rc.points.length - 1], rc.points[rc.points.length - 1]));
  }
  const parent = endpoints.map((_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  for (let i = 0; i < endpoints.length; i++) {
    for (let j = i + 1; j < endpoints.length; j++) {
      // Same piece's own two ends are never bridged to each other -- a
      // route piece doesn't loop back and connect to itself.
      if (Math.floor(i / 2) === Math.floor(j / 2)) continue;
      const d = dist(endpoints[i], endpoints[j]);
      if (d <= NODE_MERGE_TOLERANCE) {
        union(i, j);
        continue;
      }
      if (d > GAP_BRIDGE_RADIUS) continue;
      // Direction-aware bridge: the two pieces' own tangents must be
      // collinear with each other, AND the gap between their endpoints
      // must continue in that same direction -- rules out merging two
      // pieces that are merely nearby (parallel runs, a crossing, a real
      // corner) rather than genuinely the same straight run broken by a
      // symbol drawn on top of it.
      const tangentsAgree = absDot(endpointTangents[i], endpointTangents[j]) >= COLLINEAR_COS_THRESHOLD;
      if (!tangentsAgree) continue;
      const gapDir = unitTangent(endpoints[i], endpoints[j]);
      if (absDot(gapDir, endpointTangents[i]) < COLLINEAR_COS_THRESHOLD) continue;
      union(i, j);
    }
  }

  const nodeIdByRoot = new Map<number, number>();
  const nodes: RouteNode[] = [];
  const edges: RouteEdge[] = [];
  function nodeIdFor(endpointIdx: number): number {
    const root = find(endpointIdx);
    let nodeId = nodeIdByRoot.get(root);
    if (nodeId === undefined) {
      nodeId = nodes.length;
      nodeIdByRoot.set(root, nodeId);
      nodes.push({ id: nodeId, point: endpoints[endpointIdx], edgeIds: [] });
    }
    return nodeId;
  }
  routeCandidates.forEach((rc, i) => {
    const [startIdx, endIdx] = edgeEndpointIdx[i];
    const nodeA = nodeIdFor(startIdx);
    const nodeB = nodeIdFor(endIdx);
    const edgeId = edges.length;
    edges.push({ id: edgeId, points: rc.points, nodeA, nodeB });
    nodes[nodeA].edgeIds.push(edgeId);
    nodes[nodeB].edgeIds.push(edgeId);
  });
  // Node point = centroid of every endpoint clustered into it, not just the
  // first one seen, so a node sits at the merged group's actual center.
  const groupPoints = new Map<number, [number, number][]>();
  endpoints.forEach((p, i) => {
    const root = find(i);
    const nodeId = nodeIdByRoot.get(root)!;
    const list = groupPoints.get(nodeId) ?? [];
    list.push(p);
    groupPoints.set(nodeId, list);
  });
  for (const node of nodes) {
    const pts = groupPoints.get(node.id)!;
    node.point = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  }

  // Detect valve symbols and split the route graph at each one -- a valve is
  // a real spool boundary, structurally the same role a field weld already
  // plays (see computeBoundedGroups), except a valve has no leader line of
  // its own: it sits directly on the pipe centerline, so its position IS the
  // cut point, and the edge it lands on must actually be broken into two
  // there (not just excluded wholesale) so welds on either side resolve to
  // the correct sub-edge. Must run before weld-to-edge snapping below, so
  // that snapping sees the post-split edges, not stale long ones spanning
  // across a valve.
  // A dead-end node's own edge continues in roughly this direction, IF it
  // could keep going past the dead end -- used both to search for a bridge
  // target from a dead end, and to describe the candidate END being
  // searched from. `atStart` says which end of the edge the node actually
  // is (its points[0] vs its last point), since the tangent calculation
  // differs by side.
  function deadEndOutwardTangent(node: RouteNode, edge: RouteEdge): [number, number] {
    const atStart = dist(edge.points[0], node.point) < 0.5;
    return atStart
      ? unitTangent(edge.points[1] ?? edge.points[0], edge.points[0])
      : unitTangent(edge.points[edge.points.length - 2] ?? edge.points[edge.points.length - 1], edge.points[edge.points.length - 1]);
  }

  // Searches past a valve-split's own dead-end node for either (a) another
  // dead end that's really the SAME pipe continuing as a separate,
  // never-merged piece, or (b) a real JUNCTION (a tee/branch node, degree
  // >= 3) that this dead end's own branch reconnects to -- see
  // VALVE_BRIDGE_SEARCH_RADIUS/JUNCTION_BRIDGE_SEARCH_RADIUS's own comments
  // for why a valve's confirmed presence justifies reaching further than
  // the general gap-bridging pass above normally would, and why a junction
  // gets its own larger radius. Reuses the general pass's collinearity
  // discipline (tangentsAgree + gapDir check) for dead-end targets; a
  // junction has no single tangent of its own, so it relies on gap-
  // direction alignment only. Prefers a dead-end match over a junction
  // match at equal distance, since a dead-end's extra tangent-opposition
  // check is stronger evidence.
  function findBridgeTarget(
    deadEndNode: RouteNode,
    outwardTangent: [number, number],
    excludeNodeIds: Set<number>
  ): { node: RouteNode; isJunction: boolean } | null {
    let best: { node: RouteNode; d: number; isJunction: boolean } | null = null;
    for (const candidate of nodes) {
      if (excludeNodeIds.has(candidate.id)) continue;
      const degree = new Set(candidate.edgeIds).size;
      const isDeadEnd = candidate.edgeIds.length === 1;
      const isJunction = degree >= 3;
      if (!isDeadEnd && !isJunction) continue; // a plain degree-2 pass-through point, or a self-loop-only node, is not a meaningful target
      const radius = isJunction ? JUNCTION_BRIDGE_SEARCH_RADIUS : VALVE_BRIDGE_SEARCH_RADIUS;
      const d = dist(deadEndNode.point, candidate.point);
      if (d > radius) continue;
      const gapDir = unitTangent(deadEndNode.point, candidate.point);
      if (absDot(gapDir, outwardTangent) < COLLINEAR_COS_THRESHOLD) continue;
      if (isDeadEnd) {
        // A dead-end target needs its OWN tangent roughly opposing ours too
        // -- two independent pipe stubs approaching each other from
        // opposite ends is much stronger evidence than gap direction alone.
        const candidateEdge = edges.find((e) => e.id === candidate.edgeIds[0])!;
        const candidateTangent = deadEndOutwardTangent(candidate, candidateEdge);
        const opposes =
          absDot(outwardTangent, candidateTangent) >= COLLINEAR_COS_THRESHOLD &&
          outwardTangent[0] * candidateTangent[0] + outwardTangent[1] * candidateTangent[1] < 0;
        if (!opposes) continue;
      }
      // A junction's own established multi-edge identity is itself much
      // stronger grounding than another lone dead end, which is why it
      // doesn't need the extra tangent-opposition check -- gap-direction
      // alignment with our own outward continuation is the available signal.
      if (!best || d < best.d || (d === best.d && !isJunction && best.isJunction)) best = { node: candidate, d, isJunction };
    }
    return best ? { node: best.node, isJunction: best.isJunction } : null;
  }

  // Weldolet tap: unlike a valve or FW, a weldolet does NOT bound a spool --
  // it welds a branch directly onto the SIDE of an existing pipe run, not
  // at a formal tee/dead-end. Confirmed on a real case: item 23's own dead
  // end sits ~7pt from the MIDDLE of an already-connected edge (not at
  // either of its own endpoints) -- the branch it bounds should be UNIONED
  // into the main line's own group, not treated as a separately-bounded
  // side. Only tried after findBridgeTarget above finds nothing (that
  // represents stronger, more direct evidence when available), and the
  // search radius is deliberately tight -- a weldolet tap is a short,
  // direct connection, not a long reach. One confirmed real case so far --
  // same "starting point, not settled" caveat as every other tolerance
  // here.
  const WELDOLET_TAP_SEARCH_RADIUS = 20;
  // Looser than COLLINEAR_COS_THRESHOLD (~20deg), and checked as a SIGNED
  // (forward-only) dot product, not absDot -- confirmed necessary on the
  // real case: a weldolet branch approaches its tap point at a real angle
  // (~30deg off dead-straight here), unlike a straight pipe continuation,
  // which is what the tighter general-purpose threshold assumes. Signed
  // (not absolute) because a tap must be found by continuing OUTWARD from
  // the dead end, not by matching a direction that happens to be roughly
  // parallel but points backward -- confirmed necessary too: the one real
  // false positive found (an unrelated weld's edge near item 23's drain
  // side, which has nothing after it) had a gap direction pointing
  // BACKWARD (dot ~= -0.71) that absDot would have wrongly accepted.
  const WELDOLET_TAP_COS_THRESHOLD = Math.cos((40 * Math.PI) / 180);
  function findMidEdgeTapTarget(
    deadEndNode: RouteNode,
    outwardTangent: [number, number],
    excludeEdgeIds: Set<number>
  ): { edge: RouteEdge; point: [number, number]; segmentIndex: number } | null {
    let best: { edge: RouteEdge; point: [number, number]; segmentIndex: number; dist: number } | null = null;
    for (const edge of edges) {
      if (excludeEdgeIds.has(edge.id) || edge.nodeA === edge.nodeB) continue; // a self-loop's own "interior" isn't a meaningful tap target
      const candidate = pointToPolylineDistanceIndexed(deadEndNode.point, edge.points);
      if (candidate.dist > WELDOLET_TAP_SEARCH_RADIUS) continue;
      // Require the tap point to be genuinely INTERIOR, not effectively at
      // one of the edge's own endpoints -- that's what the dead-end/
      // junction search above already covers, more confidently.
      if (dist(candidate.point, edge.points[0]) < 3 || dist(candidate.point, edge.points[edge.points.length - 1]) < 3) continue;
      // Distance alone isn't enough evidence -- confirmed on a real false
      // positive: a dead end with genuinely nothing beyond it (item 23's
      // OWN drain side) matched a completely unrelated nearby weld's edge
      // purely by proximity. The gap direction must agree with the dead
      // end's own FORWARD outward continuation (see
      // WELDOLET_TAP_COS_THRESHOLD's own comment for why this is signed
      // and looser than the general collinearity check).
      const gapDir = unitTangent(deadEndNode.point, candidate.point);
      const forwardDot = gapDir[0] * outwardTangent[0] + gapDir[1] * outwardTangent[1];
      if (forwardDot < WELDOLET_TAP_COS_THRESHOLD) continue;
      if (!best || candidate.dist < best.dist) best = { edge, point: candidate.point, segmentIndex: candidate.segmentIndex, dist: candidate.dist };
    }
    return best ? { edge: best.edge, point: best.point, segmentIndex: best.segmentIndex } : null;
  }

  const pageSymbolSegments = segments.filter((s) => s.pageNumber === pageNumber && (s.lineWidth === 6 || s.lineWidth === 0));
  const valves: ValveSymbol[] = [];
  const weldoletTapEdgeIds: number[] = [];
  for (const seg of pageSymbolSegments) {
    const candidate = detectValveBowtie(seg.points);
    if (!candidate) continue;
    const snap = edges
      // A self-loop edge (both ends already the same graph node, e.g. a
      // short stub near a tee whose two raw endpoints both merged into that
      // tee's node during the route-graph build) can never be split into
      // two DIFFERENT sides -- splitting it still leaves both new pieces
      // touching the same original far node, silently defeating the whole
      // point of the cut. Confirmed on a real case: item 10's valve nearest
      // to the SW21/SW22 tee snapped onto exactly such a self-loop, and the
      // resulting "before"/"after" groups were identical, so a
      // valve-crossing check comparing them against each other could only
      // ever agree with itself. Skip self-loops outright and let the
      // search fall through to the next-nearest real edge.
      .filter((edge) => edge.nodeA !== edge.nodeB)
      .map((edge) => ({ edge, ...pointToPolylineDistanceIndexed(candidate.center, edge.points) }))
      .sort((a, b) => a.dist - b.dist)[0];
    // Self-loops excluded from the split search above aren't necessarily
    // irrelevant -- a weld can still be attached along one (see
    // ValveSymbol.nearbySelfLoopEdgeIds' own comment). Remembered here so
    // computeBoundedGroups can classify such a weld by direction, since a
    // self-loop can never itself be split to determine a side.
    const nearbySelfLoopEdgeIds = edges
      .filter((edge) => edge.nodeA === edge.nodeB)
      .map((edge) => ({ id: edge.id, dist: pointToPolylineDistanceIndexed(candidate.center, edge.points).dist }))
      .filter(({ dist }) => dist <= VALVE_SNAP_MAX_DISTANCE)
      .map(({ id }) => id);
    if (process.env.DEBUG_VALVES) {
      console.error(`[valve candidate] center=(${candidate.center[0].toFixed(1)},${candidate.center[1].toFixed(1)}) diag=${candidate.bboxDiagonal.toFixed(1)} nearestEdgeDist=${snap?.dist.toFixed(2)}`);
    }
    if (!snap || snap.dist > VALVE_SNAP_MAX_DISTANCE) continue; // no confident route placement -- don't force it
    const { edge, point: splitPoint, segmentIndex } = snap;
    const newNodeId = nodes.length;
    const edgeBId = edges.length;
    const originalEdgeId = edge.id;
    const originalNodeA = edge.nodeA;
    const originalNodeB = edge.nodeB;
    edges[originalEdgeId] = { id: originalEdgeId, points: [...edge.points.slice(0, segmentIndex + 1), splitPoint], nodeA: originalNodeA, nodeB: newNodeId };
    edges.push({ id: edgeBId, points: [splitPoint, ...edge.points.slice(segmentIndex + 1)], nodeA: newNodeId, nodeB: originalNodeB });
    const nodeAObj = nodes.find((n) => n.id === originalNodeA)!;
    const nodeBObj = nodes.find((n) => n.id === originalNodeB)!;
    nodeBObj.edgeIds = nodeBObj.edgeIds.map((id) => (id === originalEdgeId ? edgeBId : id));
    nodes.push({ id: newNodeId, point: splitPoint, edgeIds: [originalEdgeId, edgeBId] });
    const beforeEdgeIds = [originalEdgeId];
    const afterEdgeIds = [edgeBId];
    const beforeFarNodeIds = [originalNodeA];
    const afterFarNodeIds = [originalNodeB];

    // Either side of the primary split might be a genuine dead end (the
    // valve's own symbol interrupting the drawn centerline -- see
    // VALVE_BRIDGE_SEARCH_RADIUS's own comment) with the pipe really
    // continuing as a separate, never-merged piece nearby -- OR reconnecting
    // to a real tee/branch junction (see JUNCTION_BRIDGE_SEARCH_RADIUS's own
    // comment). Only attempted when that side has nowhere else to go
    // already (degree 1) -- a side that already connects onward is left
    // alone, trusting the existing structure rather than risking a
    // spurious extra connection.
    let beforeJunctionNodeId: number | null = null;
    let afterJunctionNodeId: number | null = null;
    for (const [deadEndNode, ownEdge, exclude, sideEdgeIds, sideFarNodeIds, isBefore] of [
      [nodeAObj, edges[originalEdgeId], new Set([originalNodeA, newNodeId, originalNodeB]), beforeEdgeIds, beforeFarNodeIds, true],
      [nodeBObj, edges[edgeBId], new Set([originalNodeB, newNodeId, originalNodeA]), afterEdgeIds, afterFarNodeIds, false],
    ] as const) {
      if (deadEndNode.edgeIds.length !== 1) continue;
      const target = findBridgeTarget(deadEndNode, deadEndOutwardTangent(deadEndNode, ownEdge), exclude);
      if (!target) {
        // No dead-end/junction match -- try a weldolet-style mid-edge tap
        // instead (see findMidEdgeTapTarget's own comment). Unlike the
        // bridges above, this one is NOT a boundary: it's unioned into the
        // ordinary route graph, since a weldolet doesn't bound a spool.
        const tap = findMidEdgeTapTarget(deadEndNode, deadEndOutwardTangent(deadEndNode, ownEdge), new Set([originalEdgeId, edgeBId]));
        if (!tap) continue;
        const { edge: tapEdge, point: tapPoint, segmentIndex: tapSegmentIndex } = tap;
        const tapNodeId = nodes.length;
        const tapEdgeBId = edges.length;
        const tapOriginalId = tapEdge.id;
        const tapOriginalNodeB = tapEdge.nodeB;
        edges[tapOriginalId] = { id: tapOriginalId, points: [...tapEdge.points.slice(0, tapSegmentIndex + 1), tapPoint], nodeA: tapEdge.nodeA, nodeB: tapNodeId };
        edges.push({ id: tapEdgeBId, points: [tapPoint, ...tapEdge.points.slice(tapSegmentIndex + 1)], nodeA: tapNodeId, nodeB: tapOriginalNodeB });
        const tapNodeBObj = nodes.find((n) => n.id === tapOriginalNodeB)!;
        tapNodeBObj.edgeIds = tapNodeBObj.edgeIds.map((id) => (id === tapOriginalId ? tapEdgeBId : id));
        const connectorEdgeId = edges.length;
        edges.push({ id: connectorEdgeId, points: [deadEndNode.point, tapPoint], nodeA: deadEndNode.id, nodeB: tapNodeId });
        nodes.push({ id: tapNodeId, point: tapPoint, edgeIds: [tapOriginalId, tapEdgeBId, connectorEdgeId] });
        deadEndNode.edgeIds.push(connectorEdgeId);
        weldoletTapEdgeIds.push(connectorEdgeId);
        if (process.env.DEBUG_VALVES) {
          console.error(
            `  [valve weldolet-tap] node ${deadEndNode.id} @ (${deadEndNode.point[0].toFixed(1)},${deadEndNode.point[1].toFixed(1)}) -> mid-edge ${tapOriginalId} @ (${tapPoint[0].toFixed(1)},${tapPoint[1].toFixed(1)})`
          );
        }
        continue;
      }
      if (target.isJunction) {
        // Deliberately NOT added as a graph edge, and NOT folded into
        // sideEdgeIds/sideFarNodeIds -- see beforeJunctionNodeId's own
        // comment on ValveSymbol for why keeping this separate matters.
        if (isBefore) beforeJunctionNodeId = target.node.id;
        else afterJunctionNodeId = target.node.id;
        if (process.env.DEBUG_VALVES) {
          console.error(
            `  [valve junction-bridge] node ${deadEndNode.id} @ (${deadEndNode.point[0].toFixed(1)},${deadEndNode.point[1].toFixed(1)}) -> junction node ${target.node.id} @ (${target.node.point[0].toFixed(1)},${target.node.point[1].toFixed(1)})`
          );
        }
        continue;
      }
      const bridgeEdgeId = edges.length;
      edges.push({ id: bridgeEdgeId, points: [deadEndNode.point, target.node.point], nodeA: deadEndNode.id, nodeB: target.node.id });
      deadEndNode.edgeIds.push(bridgeEdgeId);
      target.node.edgeIds.push(bridgeEdgeId);
      sideEdgeIds.push(bridgeEdgeId);
      sideFarNodeIds.push(target.node.id);
      if (process.env.DEBUG_VALVES) {
        console.error(`  [valve bridge] node ${deadEndNode.id} @ (${deadEndNode.point[0].toFixed(1)},${deadEndNode.point[1].toFixed(1)}) -> node ${target.node.id} @ (${target.node.point[0].toFixed(1)},${target.node.point[1].toFixed(1)})`);
      }
    }

    valves.push({
      center: candidate.center,
      bboxDiagonal: candidate.bboxDiagonal,
      vertices: candidate.vertices,
      beforeEdgeIds,
      afterEdgeIds,
      beforeFarNodeIds,
      afterFarNodeIds,
      nearbySelfLoopEdgeIds,
      beforeJunctionNodeId,
      afterJunctionNodeId,
    });
  }

  // How close the nearest point on an edge must be to one of that edge's OWN
  // endpoints before direction, not just distance, decides which edge a weld
  // really belongs to. Confirmed necessary on SW41: its leader line ends
  // almost exactly ON a 3-edge tee node (a real branch point, not a data
  // artifact), where pure nearest-distance is a coin-flip between the main
  // run and the branch leg it's actually drawn on -- and picked the main
  // run, wrongly merging a branch weld into the main line's spool group.
  const NODE_ZONE_RADIUS = 6;
  // How strongly good directional alignment outweighs a small distance
  // difference once inside a node zone -- large enough that a well-aligned
  // edge always beats a marginally-closer misaligned one (a real branch
  // splits off at a distinct angle in an isometric drawing, so a correct
  // match's alignment is not a close call).
  const ALIGNMENT_BONUS = 40;

  const weldEdgeAssignments: WeldEdgeAssignment[] = [];
  for (const leader of leaderLines) {
    const leaderDir = unitTangent(leader.from, leader.to);
    let best: { edgeId: number; point: [number, number]; dist: number; score: number } | null = null;
    for (const edge of edges) {
      const candidate = pointToPolylineDistance(leader.to, edge.points);
      let score = candidate.dist;
      const endpoints: [[number, number], [number, number]][] = [
        [edge.points[0], unitTangent(edge.points[1] ?? edge.points[0], edge.points[0])],
        [
          edge.points[edge.points.length - 1],
          unitTangent(edge.points[edge.points.length - 2] ?? edge.points[edge.points.length - 1], edge.points[edge.points.length - 1]),
        ],
      ];
      for (const [endpoint, tangent] of endpoints) {
        if (dist(candidate.point, endpoint) <= NODE_ZONE_RADIUS) {
          score = candidate.dist - absDot(leaderDir, tangent) * ALIGNMENT_BONUS;
          break;
        }
      }
      if (!best || score < best.score) best = { edgeId: edge.id, point: candidate.point, dist: candidate.dist, score };
    }
    if (best) {
      weldEdgeAssignments.push({ weldTagNumber: leader.weldTagNumber, edgeId: best.edgeId, atPoint: best.point, distance: best.dist });
    }
  }

  // Field welds get the SAME "split the shared edge at my own interior
  // position" treatment valves already get (see the valve-splitting pass
  // above) -- confirmed necessary on a real case: FW02's own snap point
  // falls at segment index 22 of one 41-point edge that 6 OTHER welds
  // (spanning 4 different recorded spools) ALSO share, landing exactly
  // between two of them. Without this, groupByWeld's find(edge.nodeA)
  // convention assigns every weld on that one shared edge the SAME group
  // id, completely ignoring that a real, confirmed field-weld boundary
  // sits between them. Must run AFTER weld-to-edge snapping (the reverse
  // order from the valve pass) since the split point comes from an FW's
  // own resolved atPoint/edge, and every OTHER weld sharing that same edge
  // needs reassigning to the correct new half afterward.
  const fwSplitFarNodes = new Map<string, { before: number; after: number }>();
  const fwBoundaryEdgeIds: number[] = [];
  for (const a of weldEdgeAssignments) {
    const weld = welds.find((w) => w.tagNumber === a.weldTagNumber);
    if (weld?.weldType !== "field weld") continue;
    const edge = edges.find((e) => e.id === a.edgeId)!;
    const { point: splitPoint, segmentIndex } = pointToPolylineDistanceIndexed(a.atPoint, edge.points);
    // Skip the rare case where the FW's own point is effectively AT one of
    // the edge's own endpoints already -- splitting would produce a
    // degenerate zero-length piece, and the edge is already "dedicated"
    // enough that excluding it whole is a fine fallback.
    if (dist(splitPoint, edge.points[0]) < 0.5 || dist(splitPoint, edge.points[edge.points.length - 1]) < 0.5) {
      fwBoundaryEdgeIds.push(edge.id);
      continue;
    }
    const newNodeId = nodes.length;
    const edgeBId = edges.length;
    const originalEdgeId = edge.id;
    const originalNodeA = edge.nodeA;
    const originalNodeB = edge.nodeB;
    edges[originalEdgeId] = { id: originalEdgeId, points: [...edge.points.slice(0, segmentIndex + 1), splitPoint], nodeA: originalNodeA, nodeB: newNodeId };
    edges.push({ id: edgeBId, points: [splitPoint, ...edge.points.slice(segmentIndex + 1)], nodeA: newNodeId, nodeB: originalNodeB });
    const nodeBObj = nodes.find((n) => n.id === originalNodeB)!;
    nodeBObj.edgeIds = nodeBObj.edgeIds.map((id) => (id === originalEdgeId ? edgeBId : id));
    nodes.push({ id: newNodeId, point: splitPoint, edgeIds: [originalEdgeId, edgeBId] });

    // Reassign every OTHER weld that was on the original (now-replaced)
    // edge to whichever new half its own atPoint is actually closer to --
    // this is what makes groupByWeld finally see them as sitting on
    // genuinely different edges, instead of all sharing the edge's same
    // fixed nodeA regardless of which side of the FW they're really on.
    for (const other of weldEdgeAssignments) {
      if (other === a || other.edgeId !== originalEdgeId) continue;
      const distBefore = pointToPolylineDistance(other.atPoint, edges[originalEdgeId].points).dist;
      const distAfter = pointToPolylineDistance(other.atPoint, edges[edgeBId].points).dist;
      other.edgeId = distBefore <= distAfter ? originalEdgeId : edgeBId;
    }
    // The FW's own assignment can point to either half -- it's excluded
    // from groupByWeld's own assignment regardless (field welds sit AT the
    // boundary, not inside either group); fwSplitFarNodes carries the real
    // before/after information downstream.
    a.edgeId = originalEdgeId;

    fwSplitFarNodes.set(a.weldTagNumber, { before: originalNodeA, after: originalNodeB });
    fwBoundaryEdgeIds.push(originalEdgeId, edgeBId);
  }

  return { pageNumber, welds, leaderLines, nodes, edges, weldEdgeAssignments, valves, unclassified, weldoletTapEdgeIds, fwSplitFarNodes, fwBoundaryEdgeIds };
}

export interface BoundedGroups {
  // Weld tag -> group id, for every SW whose edge could be grouped. A group
  // is one connected stretch of the route graph with every field-weld- or
  // valve-bearing edge removed -- two SWs in the same group sit on
  // physically continuous pipe with no known field weld or valve between
  // them.
  groupByWeld: Map<string, number>;
  groupCount: number;
  // FW tag -> the group id(s) that actually border it (from its own edge's
  // two nodes). A real spool_no match for that FW must be one of THESE
  // groups, nothing else -- comparing against this instead of "any defined
  // group" is what makes a violation check meaningful rather than trivially
  // true for every weld on the sheet (an earlier version compared against
  // groupByWeld.get(fwTag), which is always undefined since FWs are
  // excluded from that map, making "groupId !== undefined" true for nearly
  // any weld regardless of where it actually sits).
  fwBorderGroups: Map<string, number[]>;
  // For every detected valve (same index as shapes.valves), every weld tag
  // on the "before" side and every weld tag on the "after" side of its
  // split point. Includes BOTH welds reachable through the wider connected
  // component on that side AND welds whose leader line snaps directly onto
  // the valve's own short split-edge stub itself -- confirmed necessary on
  // a real case (SW27, right after item 10's valve): a weld can land
  // nearest to the NEAR end of that stub rather than reaching all the way
  // to the far node, and the generic "group id via find(edge.nodeA)"
  // convention used elsewhere is arbitrary for a boundary edge specifically
  // (its two ends are deliberately never unioned, so which one a weld's
  // assigned edge happens to call "nodeA" isn't a meaningful signal of
  // which side it's really on) -- without this, such a weld is silently
  // dropped from both sides instead of counted on the side it's really on.
  // A real spool_no match must differ between `before` and `after`: a valve
  // is exactly as hard a boundary as a field weld (see
  // boundaryNoteTreatsValveAsPassThrough's own comment in
  // isoQualityChecks.ts -- no legitimate reading of "the run continues
  // through a valve" exists), so both sides claiming the same spool_no is a
  // confirmed violation, not a soft disagreement.
  valveBorderTags: Array<{ before: string[]; after: string[] }>;
  // Every junction (tee/branch) node that has 2+ distinct "legs" attached
  // to it -- either a valve's own before/after side (via
  // beforeJunctionNodeId/afterJunctionNodeId), or the junction's own
  // directly-attached weld group (e.g. SW21/SW22, attached via a self-loop
  // edge whose both ends ARE the tee). Two different legs off the same tee,
  // each independently bounded by its own valve (or just directly attached
  // to the trunk), can never legitimately be the same spool -- confirmed
  // necessary on a real case: item 23's drain-valve branch and the main
  // continuation past item 10's valve are two legs of the SAME tee, and
  // Phase 5c's before-vs-after-of-one-valve check can never catch this
  // (item 23 has no "after" at all -- a drain valve genuinely has no pipe
  // past it).
  junctionLegs: Map<number, string[][]>;
  // Group id(s) that a weldolet-tap union (see PageShapeClassification.
  // weldoletTapEdgeIds' own comment) merged into their current, larger
  // shape this run. computeWeldSpoolCorrections' auto-fix pass skips these
  // groups (flag-only) -- confirmed necessary on a real case: a
  // weldolet-tap merge pulled SW23/SW26 (clean, "04") into the same group
  // as SW25/SW27 (each independently FW-flagged, "05"), and the existing
  // "clean subset outnumbers/ties the violating subset, so correct toward
  // it" auto-fix logic corrected SW25/SW27 to "04" -- backwards, since "05"
  // was actually correct. That same 2-vs-2 shape is structurally
  // indistinguishable from an already-validated case (SW41 vs SW20, a 1-
  // vs-1 tie that correctly auto-fixes) using vote counts alone -- the only
  // safe signal is that THIS group was just merged by the newer, less-
  // proven weldolet-tap mechanism, not a plain FW/valve-bounded segment.
  weldoletMergedGroupIds: Set<number>;
}

// A field weld is a real erection-joint boundary -- this is domain fact read
// straight off the tag prefix (SW/FW), not something geometry has to work
// out. A valve is too (see the ValveSymbol/detectValveBowtie comments) --
// classifyPageShapes already splits the route graph at each detected valve,
// so a valve-split edge behaves exactly like an FW-bearing one here: never
// unioned across. Cutting at both gives spool groupings WITHOUT needing
// flange-bolt-up shapes classified yet (still not identified -- see the
// `unclassified` catalog), so a group here can still legitimately span more
// than one real spool if an unclassified flange sits inside it uncut.
// That's a known, disclosed under-segmentation, not a bug: every group
// boundary this DOES find is a field weld or valve confirmed by geometry,
// not guessed by vision.
export function computeBoundedGroups(shapes: PageShapeClassification): BoundedGroups {
  const parent = shapes.nodes.map((n) => n.id);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // fwBoundaryEdgeIds (both real sub-edges per split FW) replaces the old
  // "whichever single edge this FW's own assignment happens to reference"
  // -- see PageShapeClassification.fwBoundaryEdgeIds' own comment for why
  // that did nothing when many welds shared one long edge.
  const fwEdgeIds = new Set(shapes.fwBoundaryEdgeIds);
  const valveEdgeIds = new Set(shapes.valves.flatMap((v) => [...v.beforeEdgeIds, ...v.afterEdgeIds]));
  for (const edge of shapes.edges) {
    if (fwEdgeIds.has(edge.id) || valveEdgeIds.has(edge.id)) continue; // a field weld or valve here breaks the pipe -- don't union across it
    union(edge.nodeA, edge.nodeB);
  }

  const groupIdByRoot = new Map<number, number>();
  const groupByWeld = new Map<string, number>();
  for (const a of shapes.weldEdgeAssignments) {
    const weld = shapes.welds.find((w) => w.tagNumber === a.weldTagNumber);
    if (weld?.weldType === "field weld") continue; // sits AT the boundary, not inside either group
    const edge = shapes.edges.find((e) => e.id === a.edgeId)!;
    const root = find(edge.nodeA);
    let groupId = groupIdByRoot.get(root);
    if (groupId === undefined) {
      groupId = groupIdByRoot.size;
      groupIdByRoot.set(root, groupId);
    }
    groupByWeld.set(a.weldTagNumber, groupId);
  }

  // For every FW, resolve which group(s) actually border it. Prefers
  // fwSplitFarNodes' own two ORIGINAL far nodes (the real before/after,
  // from the interior split -- see that field's own comment) when
  // available; falls back to the old edge-endpoint approach for the rare
  // FW that didn't need splitting (already on its own short dedicated
  // edge, no entry in fwSplitFarNodes).
  const fwBorderGroups = new Map<string, number[]>();
  for (const a of shapes.weldEdgeAssignments) {
    const weld = shapes.welds.find((w) => w.tagNumber === a.weldTagNumber);
    if (weld?.weldType !== "field weld") continue;
    const split = shapes.fwSplitFarNodes.get(a.weldTagNumber);
    const farNodes = split
      ? [split.before, split.after]
      : (() => {
          const edge = shapes.edges.find((e) => e.id === a.edgeId)!;
          return [edge.nodeA, edge.nodeB];
        })();
    const groupIds = farNodes.map((n) => groupIdByRoot.get(find(n))).filter((id): id is number => id !== undefined);
    fwBorderGroups.set(a.weldTagNumber, [...new Set(groupIds)]);
  }

  // For every valve, every weld tag on each side -- beforeFarNodeIds/
  // afterFarNodeIds cover both the primary split's own far node AND a
  // bridge target's node when one was found (see ValveSymbol's own
  // comment), used to pull in every weld whose OWN group (via the standard
  // find(edge.nodeA) convention) matches ANY of that side's roots, PLUS any
  // weld assigned directly to one of the valve's own boundary edges itself
  // (see valveBorderTags' own comment for why that second part is
  // necessary).
  const nonFwWeldEdge = new Map<string, RouteEdge>();
  for (const a of shapes.weldEdgeAssignments) {
    const weld = shapes.welds.find((w) => w.tagNumber === a.weldTagNumber);
    if (weld?.weldType === "field weld") continue;
    const edge = shapes.edges.find((e) => e.id === a.edgeId);
    if (edge) nonFwWeldEdge.set(a.weldTagNumber, edge);
  }
  const valveBorderTags: BoundedGroups["valveBorderTags"] = shapes.valves.map((v) => {
    const edgeA = shapes.edges.find((e) => e.id === v.beforeEdgeIds[0]); // the primary split's own "before" half, kept for direction reference below
    const edgeB = shapes.edges.find((e) => e.id === v.afterEdgeIds[0]);
    const beforeRoots = new Set(v.beforeFarNodeIds.map((n) => find(n)));
    const afterRoots = new Set(v.afterFarNodeIds.map((n) => find(n)));
    const beforeEdgeIdSet = new Set(v.beforeEdgeIds);
    const afterEdgeIdSet = new Set(v.afterEdgeIds);
    const before = new Set<string>();
    const after = new Set<string>();
    for (const [tag, edge] of nonFwWeldEdge) {
      if (beforeRoots.has(find(edge.nodeA)) || beforeEdgeIdSet.has(edge.id)) before.add(tag);
      if (afterRoots.has(find(edge.nodeA)) || afterEdgeIdSet.has(edge.id)) after.add(tag);
    }
    // A self-loop near the valve can't be split to reveal which side it's
    // on (see nearbySelfLoopEdgeIds' own comment), but a weld attached to
    // one is still real -- classify it by direction instead: a valve has
    // exactly one pipe direction on each side, so compare the weld's own
    // direction from the valve's center against whichever real side IS
    // already resolved (edgeA's far point for "before", edgeB's for
    // "after") and take whichever is a closer directional match. Confirmed
    // necessary on a real case: SW22, attached to a self-loop stub at a
    // busy tee right where item 10's valve sits.
    if (v.nearbySelfLoopEdgeIds.length > 0) {
      const beforeDir = edgeA && edgeA.points.length > 0 ? unitTangent(v.center, edgeA.points[0]) : null;
      const afterDir = edgeB && edgeB.points.length > 0 ? unitTangent(v.center, edgeB.points[edgeB.points.length - 1]) : null;
      if (beforeDir || afterDir) {
        for (const loopEdgeId of v.nearbySelfLoopEdgeIds) {
          for (const a of shapes.weldEdgeAssignments) {
            if (a.edgeId !== loopEdgeId) continue;
            const weld = shapes.welds.find((w) => w.tagNumber === a.weldTagNumber);
            if (!weld || weld.weldType === "field weld") continue;
            const weldDir = unitTangent(v.center, weld.center);
            const dot = (a: [number, number], b: [number, number]) => a[0] * b[0] + a[1] * b[1];
            // Higher (more positive) dot product = the weld's own direction
            // from the valve more closely aligns with that side's known
            // direction -- not an absolute-value comparison, since aligning
            // with one side's direction and opposing the other is exactly
            // the signal that distinguishes them.
            const beforeScore = beforeDir ? dot(weldDir, beforeDir) : -Infinity;
            const afterScore = afterDir ? dot(weldDir, afterDir) : -Infinity;
            if (beforeScore > afterScore) before.add(weld.tagNumber);
            else after.add(weld.tagNumber);
          }
        }
      }
    }
    return { before: [...before], after: [...after] };
  });

  // For every junction some valve's before/after side bridged to (see
  // ValveSymbol.beforeJunctionNodeId's own comment), collect each distinct
  // "leg" attached there: the junction's own directly-attached group (e.g.
  // SW21/SW22, via a self-loop edge whose both ends ARE the junction) PLUS
  // every valve whose own before/after side bridges to this same junction,
  // using that valve's OWN direct before/after set (never merged into one
  // another -- that's precisely the distinction this check needs to draw).
  const referencedJunctionIds = new Set<number>();
  for (const v of shapes.valves) {
    if (v.beforeJunctionNodeId !== null) referencedJunctionIds.add(v.beforeJunctionNodeId);
    if (v.afterJunctionNodeId !== null) referencedJunctionIds.add(v.afterJunctionNodeId);
  }
  const junctionLegs = new Map<number, string[][]>();
  for (const junctionId of referencedJunctionIds) {
    const legs: string[][] = [];
    const ownGroupId = groupIdByRoot.get(find(junctionId));
    if (ownGroupId !== undefined) {
      const ownTags = [...groupByWeld.entries()].filter(([, gid]) => gid === ownGroupId).map(([tag]) => tag);
      if (ownTags.length > 0) legs.push(ownTags);
    }
    shapes.valves.forEach((v, i) => {
      if (v.beforeJunctionNodeId === junctionId && valveBorderTags[i].before.length > 0) legs.push(valveBorderTags[i].before);
      if (v.afterJunctionNodeId === junctionId && valveBorderTags[i].after.length > 0) legs.push(valveBorderTags[i].after);
    });
    if (legs.length >= 2) junctionLegs.set(junctionId, legs);
  }

  // Every group id that a weldolet-tap connector edge (unioned, not
  // boundary-excluded) actually merged into -- see this field's own
  // comment on BoundedGroups for why auto-fix must not trust these yet.
  const weldoletMergedGroupIds = new Set<number>();
  for (const edgeId of shapes.weldoletTapEdgeIds) {
    const edge = shapes.edges.find((e) => e.id === edgeId);
    if (!edge) continue;
    const groupId = groupIdByRoot.get(find(edge.nodeA));
    if (groupId !== undefined) weldoletMergedGroupIds.add(groupId);
  }

  return { groupByWeld, groupCount: groupIdByRoot.size, fwBorderGroups, valveBorderTags, junctionLegs, weldoletMergedGroupIds };
}

export interface WeldSpoolCorrection {
  weldTagNumber: string;
  newSpoolNo: string;
  oldSpoolNo: string;
}
export interface WeldSpoolCorrections {
  correctionByTag: Map<string, WeldSpoolCorrection>;
  hardFlagByTag: Map<string, string>;
  groupFlagByTag: Map<string, string>;
}

// Cross-checks a sheet's already-recorded (vision-derived) spool_no per weld
// against the geometrically-confirmed FW/valve-bounded groups, and
// determines which of three things applies to each weld: safe to auto-fix,
// a confirmed hard violation with no determinable fix, or a softer
// group-level disagreement. Shared between apps/worker/src/extraction/iso.ts
// (checked live, during extraction) and apps/worker/src/scripts/
// applyGeometricWeldFlags.ts (re-run against a document already sitting in
// the database) -- see that script's own history for why each tier exists
// and what real case motivated it (SW41/FW02/SW40 on a real document).
export function computeWeldSpoolCorrections(
  shapes: PageShapeClassification,
  groups: BoundedGroups,
  rawSpoolByTag: Map<string, string | undefined>
): WeldSpoolCorrections {
  function computeHardViolations(spoolByTag: Map<string, string | undefined>): Map<string, string> {
    const flags = new Map<string, string>();
    const fwWelds = shapes.welds.filter((w) => w.weldType === "field weld");
    for (const fw of fwWelds) {
      const fwSpool = spoolByTag.get(fw.tagNumber);
      if (!fwSpool) continue;
      // The group(s) this FW's OWN edge actually borders -- a real spool_no
      // match must be one of THESE, not just "any group other than the FW's
      // own" (the FW itself is never in groupByWeld at all -- comparing
      // against that directly made the check trivially true for nearly
      // every weld on an earlier version of this).
      const borderGroups = groups.fwBorderGroups.get(fw.tagNumber) ?? [];
      for (const [tag, groupId] of groups.groupByWeld) {
        if (tag === fw.tagNumber) continue;
        if (spoolByTag.get(tag) !== fwSpool) continue;
        if (!borderGroups.includes(groupId)) {
          flags.set(
            tag,
            `Deterministic geometry check (no vision, no API cost): this weld's leader line snaps onto a pipe-route stretch that is NOT connected to field weld ${fw.tagNumber}'s own stretch without crossing ${fw.tagNumber} itself -- yet both are recorded under spool_no "${fwSpool}". A real field weld bounds exactly one spool on each side, so this cannot be correct.`
          );
        }
      }
    }
    return flags;
  }

  const tagsByGroup = new Map<number, string[]>();
  for (const [tag, groupId] of groups.groupByWeld) {
    const list = tagsByGroup.get(groupId) ?? [];
    list.push(tag);
    tagsByGroup.set(groupId, list);
  }

  // Pass 1: hard violations against the RAW recorded data, to know which
  // welds have independent evidence against them (used below to find a safe
  // correction target, and to exclude them from being "clean" consensus for
  // anyone else).
  const rawHardViolations = computeHardViolations(rawSpoolByTag);

  // Auto-fix pass: within each group, if every weld WITHOUT an independent
  // hard violation unanimously agrees on one spool_no, correct any
  // hard-violating weld in that SAME group to match. Structurally this can
  // only ever touch hard-violating welds -- if a clean (non-violating) weld
  // disagreed with the rest, the "clean" set's values wouldn't be unanimous
  // in the first place, and nothing fires. Never invents a new spool
  // number, only ever merges into an already-unanimous existing value.
  //
  // Skips any group a weldolet-tap union merged this run (see
  // weldoletMergedGroupIds' own comment) -- confirmed on a real case that
  // this "clean subset outvotes/ties the violating subset" logic can pick
  // the WRONG side once a weldolet-tap merge mixes a newly-joined clean
  // subset with an already-flagged one: a 2-vs-2 tie corrected two welds
  // (SW25, SW27) toward the newly-merged branch's value, backwards from the
  // truth. That shape is structurally identical to an already-validated
  // 1-vs-1 case (SW41 vs SW20) that correctly auto-fixes, so vote counting
  // alone can't tell them apart -- only knowing the group was JUST merged
  // by the newer, less-proven weldolet mechanism can. Flag-only for these
  // groups instead (Pass 2 below still runs normally).
  const correctionByTag = new Map<string, WeldSpoolCorrection>();
  for (const [groupId, tags] of tagsByGroup) {
    if (groups.weldoletMergedGroupIds.has(groupId)) continue;
    const cleanTags = tags.filter((t) => !rawHardViolations.has(t));
    const cleanValues = new Set(cleanTags.map((t) => rawSpoolByTag.get(t)).filter((s): s is string => !!s));
    if (cleanValues.size !== 1) continue; // no unanimous clean consensus -- not determinable
    const [correctValue] = cleanValues;
    for (const tag of tags) {
      if (!rawHardViolations.has(tag)) continue; // only correct welds with independent evidence against them
      const oldSpoolNo = rawSpoolByTag.get(tag);
      if (oldSpoolNo && oldSpoolNo !== correctValue) correctionByTag.set(tag, { weldTagNumber: tag, newSpoolNo: correctValue, oldSpoolNo });
    }
  }

  // Pass 2: recompute both flags against the POST-CORRECTION picture, so a
  // fixed weld naturally stops tripping either check, and remaining group
  // disagreements are judged against the corrected data.
  const correctedSpoolByTag = new Map(rawSpoolByTag);
  for (const [tag, { newSpoolNo }] of correctionByTag) correctedSpoolByTag.set(tag, newSpoolNo);
  const fwHardFlagByTag = computeHardViolations(correctedSpoolByTag);

  // Valve-crossing violation: unlike a field weld, a valve has no spool_no
  // of its own to compare against -- the check instead compares each SIDE's
  // own consensus. If the group before a valve and the group after it both
  // (independently) unanimously agree on spool_no, using only members
  // without their own FW violation as evidence (same "clean" discipline as
  // the auto-fix pass above), and those two consensus values are the SAME,
  // that's impossible: a valve always separates two spools, so the same
  // number on both sides means at least one side is wrong. No auto-fix
  // here (unlike the FW case) -- there's no way to tell which side, if
  // either, holds the right existing number, or whether the correct value
  // is a spool number that doesn't exist in the data at all yet (the same
  // "only auto-fix when fully determinable" reasoning that already governs
  // the FW correction pass above).
  function cleanConsensus(tags: string[]): string | null {
    const clean = tags.filter((t) => !fwHardFlagByTag.has(t));
    const values = new Set(clean.map((t) => correctedSpoolByTag.get(t)).filter((s): s is string => !!s));
    return values.size === 1 ? [...values][0] : null;
  }
  const valveFlagByTag = new Map<string, string>();
  for (const { before: beforeTags, after: afterTags } of groups.valveBorderTags) {
    if (beforeTags.length === 0 || afterTags.length === 0) continue; // nothing to compare on one side
    const beforeValue = cleanConsensus(beforeTags);
    const afterValue = cleanConsensus(afterTags);
    if (!beforeValue || !afterValue || beforeValue !== afterValue) continue;
    for (const tag of [...beforeTags, ...afterTags]) {
      if (correctedSpoolByTag.get(tag) !== beforeValue) continue;
      valveFlagByTag.set(
        tag,
        `Deterministic geometry check (no vision, no API cost): a confirmed valve symbol sits directly between this weld and the welds on the other side of it, yet both sides are recorded under the same spool_no "${beforeValue}". A valve is always a spool boundary (no exception), so this cannot be correct.`
      );
    }
  }
  // Junction-sibling violation: two different legs off the SAME tee/branch
  // -- each independently bounded by its own valve, or directly attached to
  // the trunk -- can never legitimately be the same spool. Distinct from
  // the valve-crossing check above: that one compares one valve's own
  // before-set against its own after-set, which structurally can't catch
  // this (confirmed on a real case: item 23 is a drain valve with no pipe
  // after it at all, so it has no "after" to compare -- the actual
  // violation is that its branch shares a spool_no with the main
  // continuation past a DIFFERENT valve, item 10's, both legs of the same
  // tee). Same "clean" discipline, same flag-only policy (no way to tell
  // which leg holds the right number, or whether the truth is a spool
  // number that doesn't exist in the data at all yet) as the checks above.
  const junctionFlagByTag = new Map<string, string>();
  for (const legs of groups.junctionLegs.values()) {
    const consensusByLeg = legs.map((tags) => ({ tags, value: cleanConsensus(tags) }));
    for (let i = 0; i < consensusByLeg.length; i++) {
      for (let j = i + 1; j < consensusByLeg.length; j++) {
        const a = consensusByLeg[i];
        const b = consensusByLeg[j];
        if (!a.value || !b.value || a.value !== b.value) continue;
        for (const tag of [...a.tags, ...b.tags]) {
          if (correctedSpoolByTag.get(tag) !== a.value) continue;
          junctionFlagByTag.set(
            tag,
            `Deterministic geometry check (no vision, no API cost): this weld sits on one branch of a tee/junction, but shares spool_no "${a.value}" with welds on a DIFFERENT branch of the same junction -- each branch off a tee is bounded by its own valve (or the tee itself), so two different branches cannot be the same spool.`
          );
        }
      }
    }
  }
  const hardFlagByTag = new Map([...fwHardFlagByTag, ...valveFlagByTag, ...junctionFlagByTag]);

  const groupFlagByTag = new Map<string, string>();
  for (const tags of tagsByGroup.values()) {
    const spoolsInGroup = new Set(tags.map((t) => correctedSpoolByTag.get(t)).filter((s): s is string => !!s));
    if (spoolsInGroup.size <= 1) continue; // this group agrees with itself -- nothing to flag
    for (const tag of tags) {
      // A weld that already has its OWN confirmed violation (hardFlagByTag)
      // elsewhere is already known-bad through stronger, independent
      // evidence -- it shouldn't also drag its innocent groupmates into
      // this weaker flag just by disagreeing with it.
      const ownSpool = correctedSpoolByTag.get(tag);
      const others = tags.filter((t) => t !== tag && correctedSpoolByTag.get(t) !== ownSpool && !hardFlagByTag.has(t));
      if (others.length === 0) continue;
      const otherSpools = [...new Set(others.map((t) => `${t} (spool_no="${correctedSpoolByTag.get(t)}")`))];
      groupFlagByTag.set(
        tag,
        `Deterministic geometry check (no vision, no API cost): this weld sits on the same unbroken stretch of pipe (no field weld anywhere between them) as ${otherSpools.join(", ")}, yet is recorded under a different spool_no ("${ownSpool}"). May be a genuine valve/flange split not yet verified, or a data error -- worth a human look.`
      );
    }
  }

  return { correctionByTag, hardFlagByTag, groupFlagByTag };
}

export const ROUTE_GRAPH_TUNING = { ROUTE_MIN_SPAN, NODE_MERGE_TOLERANCE, SNAP_WARN_DISTANCE };
