// Each spool's real fabricated size, checked against standard shipping
// containers' internal envelopes. This VALIDATES the FW/erection-joint
// boundaries the drawing itself shows (see each spool's own boundary_note)
// -- it never invents or moves a boundary. A spool that comes back oversized
// usually means a field weld was missed during extraction, or is a genuine
// design issue worth a human look.
//
// Two independent signals feed each axis's own extent, kept STRICTLY per
// axis (E/N/EL) -- an isometric run only ever points along one of three
// directions, and a turn through an elbow/tee switches which one, so
// dimensions either side of a turn are very likely on DIFFERENT axes.
// Summing them together across axes (an earlier version of this did)
// produces a number that isn't any real physical dimension of the spool at
// all -- e.g. a 1407mm run before a bend plus a 3437mm run after it are NOT
// one 4844mm straight length.
//  - E/N/EL coordinate spread -> a true per-axis extent, but only as good as
//    how many coordinate callouts the sheet happens to print.
//  - Printed dimensions, summed WITHIN their own axis only (never across
//    axes) -- but only after deduplicating same-endpoint dimensions (see
//    below), since two dimensions terminating at the SAME physical point
//    are not two sequential segments to add together.
// Each axis takes whichever of the two signals is bigger for THAT axis
// (never the safer-looking smaller one); an axis with neither a coordinate
// spread nor any axis-tagged dimension stays at 0 (unmeasured, not "zero
// size").
//
// Shared between extractIsoDocument (checked fresh during a live extraction)
// and recheckIsoQualityFlags (re-run against data already in the database,
// no new extraction) -- same reason isoQualityChecks.ts is shared.

export const CONTAINERS = [
  { name: "20ft", internalMm: [5900, 2390, 2350] as [number, number, number] },
  { name: "40ft", internalMm: [12032, 2390, 2350] as [number, number, number] },
] as const;
export type ContainerName = (typeof CONTAINERS)[number]["name"];

export const AXES = ["e", "n", "el"] as const;
export type Axis = (typeof AXES)[number];
export function normalizeAxis(raw: string | undefined | null): Axis | null {
  const a = raw?.trim().toLowerCase();
  return a === "e" || a === "n" || a === "el" ? a : null;
}

// A dimension's own spool_no can come through in an inconsistent format from
// a fresh extraction's own weld's spool_no (bare "02") vs a spool record's
// own spool_no ("spool 02") -- confirmed real case where one dimension
// recorded the bare form while its neighbors recorded the prefixed form for
// the SAME spool. Grouping on the raw string would silently split that
// spool's own dimensions across two map keys, undercounting its envelope.
// Normalize to the bare trailing number everywhere spool_no is used as a
// grouping/lookup key in this module.
export function normalizeSpoolNo(spoolNo: string): string {
  const m = /(\d+)\s*$/.exec(spoolNo.trim());
  return m ? m[1] : spoolNo.trim();
}

export interface RoutePointForFit {
  spoolNo: string;
  e: number;
  n: number;
  el: number;
}
export interface DimensionForFit {
  spoolNo: string | null;
  axis: string | null | undefined;
  valueMm: number | string | null | undefined;
  fromRef: string | null;
  toRef: string | null;
  // Manual, auditable override (same pattern as a cut piece's own
  // manualDimensionMatch) for a dimension that describes a BRANCH leg
  // rather than a continuation of the axis it's tagged with -- confirmed
  // real case: a spool's main-run EL dimensions (top flange -> BW01 -> BW06
  // -> spectacle blind) got summed with a SEPARATE 80mm drain branch's own
  // elbow-to-valve EL dimension, even though the branch doesn't extend
  // below the main run's own bottom point -- no shared landmark exists to
  // detect this automatically (the branch's own elbow/valve cite no weld
  // tag or coordinate at all), so it can only be confirmed by a human
  // reading the actual drawing. Excluded dimensions are dropped entirely
  // from their (spool, axis) sum, not merely deduplicated.
  excludeFromEnvelope?: boolean;
}
export interface WeldForFit {
  tagNumber: string;
  locationNote: string | null;
}

export interface ContainerFitResult {
  boundingBoxMm: { E: number; N: number; EL: number };
  summedLengthMm: number | null;
  container: ContainerName | "oversized";
  // Which axis to lay along which container dimension for the BEST fit
  // (max-min clearance across all three, not just the first rotation that
  // happens to satisfy every axis) -- null when oversized. The sorted-array
  // comparison used for the plain fit/no-fit call above is enough for a
  // yes/no answer, but throws away which axis is which, so it can't tell
  // anyone packing the crate which way to actually lay the spool -- this is
  // the same fit re-derived with the axis labels kept.
  orientation: { axis: "E" | "N" | "EL"; containerDim: "length" | "width" | "height"; extentMm: number; clearanceMm: number }[] | null;
}

function weldTagsIn(s: string | null): string[] {
  if (!s) return [];
  return (s.match(/\b(BW|SW|FW)\s*0*\d+\b/gi) ?? []).map((t) => t.replace(/\s+/g, "").toUpperCase());
}
function coordTokensIn(s: string | null): string[] {
  if (!s) return [];
  return (s.match(/\b[EN]\d{6,}\b|\bEL\s*[+-]?\d{5,}\b/gi) ?? []).map((t) => t.replace(/\s+/g, "").toUpperCase());
}
// A ref's own "landmark" identity for overlap detection -- its own directly
// printed coordinate tokens, PLUS (bridging through a cited weld tag) that
// weld's own location_note coordinate tokens. Needed because two dimensions
// can describe the SAME physical point in incompatible text -- confirmed
// real case: one dimension's own toRef prints a coordinate directly, while
// another's toRef only cites the field weld sitting at that same point by
// tag, with no coordinate of its own -- they're the same point, but a plain
// text comparison between the two dimensions' own ref strings never sees it.
function landmarksOf(ref: string | null, weldLocationByTag: Map<string, string | null>): string[] {
  if (!ref) return [];
  const direct = coordTokensIn(ref);
  const bridged = weldTagsIn(ref).flatMap((tag) => coordTokensIn(weldLocationByTag.get(tag) ?? null));
  return [...direct, ...bridged];
}

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    if (this.parent[i] !== i) this.parent[i] = this.find(this.parent[i]);
    return this.parent[i];
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

// Sums a (spool, axis) group's own dimension values, but first merges any
// that share a landmark (either end) into clusters and takes only the
// cluster's own MAX -- correct for genuine overlap (two dimensions ending at
// the SAME point) and merely conservative, never an undercount, for a
// genuine chain (a relay of dimensions handing off end-to-end, which also
// share landmarks at each handoff but whose true combined length the max
// alone would understate -- accepted tradeoff, since silently double-
// counting an overlap is the worse failure mode for a container-fit check).
function dedupedAxisSum(members: { valueMm: number; fromRef: string | null; toRef: string | null }[], weldLocationByTag: Map<string, string | null>): number {
  const landmarks = members.map((m) => ({ from: landmarksOf(m.fromRef, weldLocationByTag), to: landmarksOf(m.toRef, weldLocationByTag) }));
  const uf = new UnionFind(members.length);
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const shares = (a: string[], b: string[]) => a.some((x) => b.includes(x));
      if (
        shares(landmarks[i].to, landmarks[j].to) ||
        shares(landmarks[i].from, landmarks[j].from) ||
        shares(landmarks[i].to, landmarks[j].from) ||
        shares(landmarks[i].from, landmarks[j].to)
      ) {
        uf.union(i, j);
      }
    }
  }
  const maxByCluster = new Map<number, number>();
  members.forEach((m, i) => {
    const root = uf.find(i);
    maxByCluster.set(root, Math.max(maxByCluster.get(root) ?? 0, m.valueMm));
  });
  return [...maxByCluster.values()].reduce((a, b) => a + b, 0);
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([item, ...p]);
  });
  return out;
}
// Picks the BEST fitting rotation (maximizing the tightest clearance across
// all 3 axes), not just any rotation that happens to satisfy every axis --
// one that leaves only a few mm on one axis is a real shipping risk
// (insulation, crating, or measurement tolerance could push it over), when a
// different rotation of the SAME box often leaves generous clearance
// everywhere instead. Only 6 permutations, so trying all of them is cheap.
function bestOrientation(extent: { E: number; N: number; EL: number }, internalMm: readonly [number, number, number]): ContainerFitResult["orientation"] {
  const axes: ("E" | "N" | "EL")[] = ["E", "N", "EL"];
  const dims: ("length" | "width" | "height")[] = ["length", "width", "height"];
  let best: ContainerFitResult["orientation"] = null;
  let bestMinClearance = -Infinity;
  for (const axisOrder of permutations(axes)) {
    const clearances = axisOrder.map((axis, i) => internalMm[i] - extent[axis]);
    if (clearances.some((c) => c < 0)) continue;
    const minClearance = Math.min(...clearances);
    if (minClearance > bestMinClearance) {
      bestMinClearance = minClearance;
      best = axisOrder.map((axis, i) => ({ axis, containerDim: dims[i], extentMm: extent[axis], clearanceMm: clearances[i] }));
    }
  }
  return best;
}

// Manual, auditable override of one spool's own axis extent with a value
// derived from CUT PIECE lengths (the actual raw pipe material, unambiguous)
// rather than a printed dimension (which lands on a fitting's CENTERLINE by
// convention, not the far weld -- confirmed real case: a spool's own printed
// E-axis dimension terminates at an elbow's centerline, but the field weld
// bounding that spool is welded onto the elbow's own far end, so the
// dimension alone understates the spool's real fabricated length; summing
// the two cut pieces that actually make up that span gives the true value).
// Same audit pattern as a dimension's own excludeFromEnvelope, at the spool
// level instead of the dimension level -- applied AFTER the normal coord/
// dimension computation, replacing that one axis's value outright.
export interface EnvelopeOverride {
  spoolNo: string;
  axis: Axis;
  valueMm: number;
  note: string;
}

export function computeContainerFit(
  routePoints: RoutePointForFit[],
  dimensions: DimensionForFit[],
  welds: WeldForFit[],
  overrides: EnvelopeOverride[] = []
): Map<string, ContainerFitResult> {
  const weldLocationByTag = new Map(welds.map((w) => [w.tagNumber.trim().toUpperCase(), w.locationNote]));

  const pointsBySpool = new Map<string, RoutePointForFit[]>();
  for (const p of routePoints) {
    if (!p.spoolNo) continue;
    const key = normalizeSpoolNo(p.spoolNo);
    const list = pointsBySpool.get(key) ?? [];
    list.push(p);
    pointsBySpool.set(key, list);
  }

  const dimsBySpoolAxis = new Map<string, Map<Axis, { valueMm: number; fromRef: string | null; toRef: string | null }[]>>();
  for (const d of dimensions) {
    if (d.excludeFromEnvelope) continue;
    const spoolNo = d.spoolNo?.trim() ? normalizeSpoolNo(d.spoolNo) : null;
    const axis = normalizeAxis(d.axis);
    const value = Number(d.valueMm);
    if (!spoolNo || !axis || !Number.isFinite(value) || value <= 0) continue;
    const byAxis = dimsBySpoolAxis.get(spoolNo) ?? new Map<Axis, { valueMm: number; fromRef: string | null; toRef: string | null }[]>();
    const list = byAxis.get(axis) ?? [];
    list.push({ valueMm: value, fromRef: d.fromRef, toRef: d.toRef });
    byAxis.set(axis, list);
    dimsBySpoolAxis.set(spoolNo, byAxis);
  }

  const allSpoolNos = new Set([...pointsBySpool.keys(), ...dimsBySpoolAxis.keys()]);
  const results = new Map<string, ContainerFitResult>();
  for (const spoolNo of allSpoolNos) {
    const points = pointsBySpool.get(spoolNo) ?? [];
    const coordExtent = (vals: number[]) => (vals.length >= 2 ? Math.max(...vals) - Math.min(...vals) : 0);
    const coordByAxis: Record<Axis, number> = {
      e: coordExtent(points.map((p) => p.e)),
      n: coordExtent(points.map((p) => p.n)),
      el: coordExtent(points.map((p) => p.el)),
    };

    const dimByAxis = dimsBySpoolAxis.get(spoolNo);
    const axisTotals: Record<Axis, number> = { e: 0, n: 0, el: 0 };
    for (const axis of AXES) {
      const dims = dimByAxis?.get(axis) ?? [];
      const summed = dims.length > 0 ? dedupedAxisSum(dims, weldLocationByTag) : 0;
      axisTotals[axis] = Math.max(coordByAxis[axis], summed);
    }
    const anyDimSum = dimByAxis ? [...dimByAxis.values()].some((d) => d.length > 0) : false;
    const summedLengthMm = anyDimSum ? Math.max(...AXES.map((axis) => dedupedAxisSum(dimByAxis?.get(axis) ?? [], weldLocationByTag))) : null;

    if (points.length < 2 && !anyDimSum && !overrides.some((o) => normalizeSpoolNo(o.spoolNo) === spoolNo)) continue; // no size data at all for this spool

    const extent = { E: axisTotals.e, N: axisTotals.n, EL: axisTotals.el };
    for (const o of overrides) {
      if (normalizeSpoolNo(o.spoolNo) === spoolNo) extent[o.axis.toUpperCase() as "E" | "N" | "EL"] = o.valueMm;
    }
    const sortedBox = [extent.E, extent.N, extent.EL].sort((a, b) => b - a);
    const containerMatch = CONTAINERS.find((c) => sortedBox.every((dim, i) => dim <= c.internalMm[i]));
    const orientation = containerMatch ? bestOrientation(extent, containerMatch.internalMm) : null;

    results.set(spoolNo, {
      boundingBoxMm: extent,
      summedLengthMm,
      container: containerMatch?.name ?? "oversized",
      orientation,
    });
  }
  return results;
}
