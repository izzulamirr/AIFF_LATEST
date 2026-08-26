// Recomputes the deterministic ISO quality-check flags (boundary_flag on
// spools, spool_flag on dimensions -- see ../extraction/isoQualityChecks.ts)
// against extracted_tags ALREADY in the
// database for one document. No new extraction, no vision call, no API
// cost at all -- this only re-runs the same pure post-processing logic
// extractIsoDocument already applies at extraction time, useful for
// picking up a check that was added/changed AFTER a document was already
// extracted, without spending an API call to re-extract it.
//
// Usage: pnpm --filter worker exec tsx src/scripts/recheckIsoQualityFlags.ts <documentId>
import "dotenv/config";
import { eq, and, inArray } from "drizzle-orm";
import { createDb, extractedTags } from "@easy/db";
import {
  computeIsoQualityFlags,
  type IsoQualitySpool,
  type IsoQualityWeld,
  type IsoQualityDimension,
  type IsoQualityWeldListRow,
} from "../extraction/isoQualityChecks";
import { computeContainerFit, normalizeSpoolNo, type DimensionForFit, type WeldForFit, type RoutePointForFit, type EnvelopeOverride, type Axis } from "../extraction/containerFit";

// location_flag on welds was retired: it was based on matching flange/
// gasket/bolt item-number clusters (e.g. "F8 G14 B16") back to a single
// "owning" spool, which assumed a cluster code identifies one physical
// joint. It doesn't -- BOM items carry quantities, so the same item numbers
// legitimately label multiple, unrelated physical joints across a sheet
// whenever that flange/gasket/bolt type is used more than once. Confirmed
// via a real drawing where "F8 G14 B16" recurs at genuinely different
// locations, not just spool 04's boundary. This script still clears any
// location_flag values a prior run of the old logic left in the database.

async function main() {
  const documentId = process.argv[2];
  if (!documentId) {
    console.error("Usage: tsx src/scripts/recheckIsoQualityFlags.ts <documentId>");
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Missing DATABASE_URL -- see apps/worker/.env.example.");
  const db = createDb(databaseUrl);

  const tags = await db
    .select()
    .from(extractedTags)
    .where(and(eq(extractedTags.documentId, documentId), inArray(extractedTags.tagType, ["spool", "weld", "dimension", "weld_list_row", "route_point"])));

  if (tags.length === 0) {
    console.log(`No spool/weld/dimension/weld_list_row/route_point tags found for document ${documentId}.`);
    process.exit(0);
  }

  const spoolTags = tags.filter((t) => t.tagType === "spool");
  const weldTags = tags.filter((t) => t.tagType === "weld");
  const dimensionTags = tags.filter((t) => t.tagType === "dimension");
  const weldListRowTags = tags.filter((t) => t.tagType === "weld_list_row");
  const routePointTags = tags.filter((t) => t.tagType === "route_point");

  // Scoped per page (sheet), matching how extractIsoDocument computes these
  // checks -- a flange cluster or spool number on one sheet has nothing to
  // do with another sheet's own.
  const pages = [...new Set([...spoolTags, ...weldTags, ...dimensionTags, ...weldListRowTags, ...routePointTags].map((t) => t.sourcePage ?? 0))].sort((a, b) => a - b);

  let updated = 0;
  for (const page of pages) {
    const pageSpools = spoolTags.filter((t) => (t.sourcePage ?? 0) === page);
    const pageWelds = weldTags.filter((t) => (t.sourcePage ?? 0) === page);
    const pageDimensions = dimensionTags.filter((t) => (t.sourcePage ?? 0) === page);
    const pageWeldListRows = weldListRowTags.filter((t) => (t.sourcePage ?? 0) === page);
    const pageRoutePoints = routePointTags.filter((t) => (t.sourcePage ?? 0) === page);

    const spoolsInput: IsoQualitySpool[] = pageSpools.map((t) => {
      const a = t.attributes as Record<string, unknown>;
      return { tagNumber: t.tagNumber, boundaryNote: typeof a.boundary_note === "string" ? a.boundary_note : null };
    });
    const weldsInput: IsoQualityWeld[] = pageWelds.map((t) => {
      const a = t.attributes as Record<string, unknown>;
      return {
        tagNumber: t.tagNumber,
        spoolNo: typeof a.spool_no === "string" ? a.spool_no : null,
        weldType: typeof a.weld_type === "string" ? a.weld_type : null,
        weldListId: typeof a.weld_list_id === "string" ? a.weld_list_id : null,
        size: typeof a.size === "string" ? a.size : null,
        locationNote: typeof a.location_note === "string" ? a.location_note : null,
      };
    });
    const dimensionsInput: IsoQualityDimension[] = pageDimensions.map((t) => {
      const a = t.attributes as Record<string, unknown>;
      return {
        tagNumber: t.tagNumber,
        spoolNo: typeof a.spool_no === "string" ? a.spool_no : null,
        fromRef: typeof a.from_ref === "string" ? a.from_ref : null,
        toRef: typeof a.to_ref === "string" ? a.to_ref : null,
      };
    });
    const weldListRowsInput: IsoQualityWeldListRow[] = pageWeldListRows.map((t) => {
      const a = t.attributes as Record<string, unknown>;
      return {
        id: t.tagNumber,
        nd: typeof a.nd === "string" ? a.nd : null,
        type: typeof a.type === "string" ? a.type : null,
      };
    });

    const { spoolFlags, dimensionFlags, weldListFlags, weldSizeFlags } = computeIsoQualityFlags(spoolsInput, weldsInput, dimensionsInput, weldListRowsInput);
    // Empty on purpose -- only here so any location_flag a prior run of the
    // now-retired flange-cluster check left on a weld gets cleared below.
    const retiredWeldFlags = new Map<string, string>();

    const fitDimensions: DimensionForFit[] = pageDimensions.map((t) => {
      const a = t.attributes as Record<string, unknown>;
      return {
        spoolNo: typeof a.spool_no === "string" ? a.spool_no : null,
        axis: typeof a.axis === "string" ? a.axis : null,
        valueMm: typeof a.value_mm === "string" ? a.value_mm : null,
        fromRef: typeof a.from_ref === "string" ? a.from_ref : null,
        toRef: typeof a.to_ref === "string" ? a.to_ref : null,
        excludeFromEnvelope: a.exclude_from_envelope === true,
      };
    });
    const fitWelds: WeldForFit[] = pageWelds.map((t) => {
      const a = t.attributes as Record<string, unknown>;
      return { tagNumber: t.tagNumber, locationNote: typeof a.location_note === "string" ? a.location_note : null };
    });
    const fitRoutePoints: RoutePointForFit[] = pageRoutePoints
      .map((t) => {
        const a = t.attributes as Record<string, unknown>;
        const spoolNo = typeof a.spool_no === "string" ? a.spool_no : null;
        const e = Number(a.easting_mm);
        const nn = Number(a.northing_mm);
        const el = Number(String(a.elevation_mm ?? "").replace(/^\+/, ""));
        if (!spoolNo || !Number.isFinite(e) || !Number.isFinite(nn) || !Number.isFinite(el)) return null;
        return { spoolNo, e, n: nn, el };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);
    const envelopeOverrides: EnvelopeOverride[] = pageSpools.flatMap((t) => {
      const a = t.attributes as Record<string, unknown>;
      const raw = Array.isArray(a.envelope_override) ? (a.envelope_override as unknown[]) : [];
      return raw
        .map((o) => {
          if (typeof o !== "object" || !o) return null;
          const rec = o as Record<string, unknown>;
          const axis = typeof rec.axis === "string" ? (rec.axis.toLowerCase() as Axis) : null;
          const valueMm = Number(rec.value_mm);
          const note = typeof rec.note === "string" ? rec.note : "";
          if (!axis || !["e", "n", "el"].includes(axis) || !Number.isFinite(valueMm)) return null;
          return { spoolNo: t.tagNumber, axis, valueMm, note };
        })
        .filter((o): o is EnvelopeOverride => o !== null);
    });
    const containerFit = computeContainerFit(fitRoutePoints, fitDimensions, fitWelds, envelopeOverrides);
    for (const t of pageSpools) {
      const fit = containerFit.get(normalizeSpoolNo(t.tagNumber));
      const oldAttrs = t.attributes as Record<string, unknown>;
      const newBox = fit ? [fit.boundingBoxMm.E, fit.boundingBoxMm.N, fit.boundingBoxMm.EL] : null;
      const newContainer = fit?.container ?? null;
      const newSummed = fit?.summedLengthMm ?? null;
      const newOrientation = fit?.orientation ?? null;
      const oldBox = Array.isArray(oldAttrs.bounding_box_mm) ? (oldAttrs.bounding_box_mm as number[]) : null;
      const oldContainer = typeof oldAttrs.shipping_container === "string" ? oldAttrs.shipping_container : null;
      if (JSON.stringify(newBox) === JSON.stringify(oldBox) && newContainer === oldContainer && oldAttrs.container_fit_detail === undefined) continue;
      // container_fit_detail: null clears a stale field from an earlier,
      // now-consolidated version of this computation that no longer exists.
      await db
        .update(extractedTags)
        .set({
          attributes: {
            ...oldAttrs,
            bounding_box_mm: newBox,
            summed_length_mm: newSummed,
            shipping_container: newContainer,
            container_orientation: newOrientation,
            container_fit_detail: null,
          },
        })
        .where(eq(extractedTags.id, t.id));
      updated++;
      console.log(`  [spool ${t.tagNumber}] container fit: ${newContainer ?? "(none)"} -- envelope E=${fit?.boundingBoxMm.E}mm N=${fit?.boundingBoxMm.N}mm EL=${fit?.boundingBoxMm.EL}mm`);
    }

    console.log(
      `\n=== Page ${page} -- ${pageSpools.length} spools, ${pageWelds.length} welds, ${pageDimensions.length} dimensions, ${pageWeldListRows.length} weld-list rows ===`
    );

    for (const [rows, flags, field] of [
      [pageSpools, spoolFlags, "boundary_flag"],
      [pageWelds, retiredWeldFlags, "location_flag"],
      [pageWelds, weldListFlags, "weld_list_flag"],
      [pageWelds, weldSizeFlags, "size_flag"],
      [pageDimensions, dimensionFlags, "spool_flag"],
    ] as const) {
      for (const t of rows) {
        const newFlag = flags.get(t.tagNumber) ?? null;
        const oldAttrs = t.attributes as Record<string, unknown>;
        const oldFlag = typeof oldAttrs[field] === "string" ? (oldAttrs[field] as string) : null;
        if (newFlag === oldFlag) continue;
        await db
          .update(extractedTags)
          .set({ attributes: { ...oldAttrs, [field]: newFlag } })
          .where(eq(extractedTags.id, t.id));
        updated++;
        if (newFlag) console.log(`  [${t.tagType} ${t.tagNumber}] NEW FLAG: ${newFlag}`);
        else console.log(`  [${t.tagType} ${t.tagNumber}] flag cleared (was: ${oldFlag})`);
      }
    }
  }

  console.log(`\nDone. ${updated} tag(s) updated. Refresh the /spooling page to see the current flags.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
