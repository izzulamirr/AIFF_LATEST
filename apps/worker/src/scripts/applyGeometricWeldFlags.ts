// Applies the vector-geometry tracer (pdfVectorGeometry.ts +
// pdfShapeClassification.ts) to a real, already-extracted ISO document:
// downloads its PDF, computes FW/valve-bounded connected components of the
// real pipe-route graph (computeBoundedGroups -- cut at every
// geometrically-located field weld, since FW is a domain-known boundary
// read off the tag prefix, no vision needed, and at every geometrically
// detected valve symbol, since a valve is also always a spool boundary --
// see detectValveBowtie's own comment for the shape signature), and
// cross-checks against the spool_no this document's own (vision-based)
// extraction already recorded per weld.
//
// Writes three distinct signals, kept separate because their confidence is
// genuinely different:
//  - Auto-fix (spool_no itself, only when fully determinable): within one
//    FW-bounded group (a confirmed, unbroken stretch of real pipe -- no
//    field weld anywhere in it), if every weld WITHOUT its own independent
//    hard violation unanimously agrees on one spool_no, any weld in that
//    SAME group that DOES have an independent hard violation gets corrected
//    to match. This only fires when there's zero ambiguity about the
//    correct value -- it never invents a new spool number, and never
//    "fixes" a weld whose only problem is disagreeing with other
//    equally-unproven welds (see geometry_group_flag below for that case,
//    which stays a flag, not a fix). Confirmed determinable case: SW41
//    conflicts with FW02 (hard violation) and sits in the same unbroken
//    group as SW20, which has no violation of its own and is the group's
//    only other member -- unanimous, safe to correct SW41 to SW20's spool.
//    The original value is preserved in spool_no_corrected_from, never
//    silently lost.
//  - geometry_flag: a weld sharing spool_no with a geometrically-verified
//    field weld that sits on a DIFFERENT connected stretch of pipe than it
//    does, where auto-fix did NOT find a determinable replacement (no clean
//    unanimous groupmate to correct toward -- e.g. SW40's group has no
//    agreement at all among its other members).
//  - geometry_group_flag: every remaining weld in an FW-bounded group whose
//    OWN recorded spool_no disagrees with another weld in that SAME group,
//    with no determinable correct value either way (e.g. Group 3 on the
//    test document: SW38/44/45/46/47/48, one visually continuous run
//    confirmed by rendering it over the actual page image, split across
//    FOUR different recorded spool numbers with no clean majority among
//    them). CAN mean a genuine valve/flange boundary this geometry doesn't
//    know about yet (not classified), not only a vision mistake.
//
// This script's own auto-fix/flag algorithm now lives in
// computeWeldSpoolCorrections (pdfShapeClassification.ts), shared with the
// live extraction path in apps/worker/src/extraction/iso.ts -- this file is
// kept as the standalone way to re-run that SAME logic against a document
// already sitting in the database (extracted before a logic change shipped,
// or before this integration existed at all), the same role
// recheckIsoQualityFlags.ts already plays for the text-based checks.
//
// Usage: pnpm --filter worker exec tsx src/scripts/applyGeometricWeldFlags.ts <documentId>
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { createDb, documents, extractedTags } from "@easy/db";
import { and, eq, inArray } from "drizzle-orm";
import { extractPageTextPositions, extractPageVectorSegments } from "../pdfVectorGeometry";
import { classifyPageShapes, computeBoundedGroups, computeWeldSpoolCorrections } from "../pdfShapeClassification";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

async function main() {
  const documentId = process.argv[2];
  if (!documentId) {
    console.error("Usage: tsx src/scripts/applyGeometricWeldFlags.ts <documentId>");
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Missing DATABASE_URL -- see apps/worker/.env.example.");
  const db = createDb(databaseUrl);
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!doc) throw new Error(`No document ${documentId}`);
  console.log(`File: ${doc.fileName}`);

  const storage = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: fileData, error } = await storage.storage.from("documents").download(doc.storagePath);
  if (error || !fileData) throw new Error(`Download failed: ${error?.message}`);
  const buf = Buffer.from(await fileData.arrayBuffer());

  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  const pageNumbers = Array.from({ length: pdf.numPages }, (_, i) => i + 1);
  const texts = await extractPageTextPositions(buf, pageNumbers);
  const segments = await extractPageVectorSegments(buf, pageNumbers);

  const weldTags = await db
    .select()
    .from(extractedTags)
    .where(and(eq(extractedTags.documentId, documentId), inArray(extractedTags.tagType, ["weld"])));

  let updated = 0;
  for (const pageNumber of pageNumbers) {
    const pageWeldTags = weldTags.filter((t) => (t.sourcePage ?? 0) === pageNumber);
    if (pageWeldTags.length === 0) continue;

    const shapes = classifyPageShapes(pageNumber, segments, texts);
    const boundedGroups = computeBoundedGroups(shapes);
    const rawSpoolByTag = new Map(pageWeldTags.map((t) => [t.tagNumber.toUpperCase(), (t.attributes as Record<string, unknown>).spool_no as string | undefined]));

    const { correctionByTag, hardFlagByTag, groupFlagByTag } = computeWeldSpoolCorrections(shapes, boundedGroups, rawSpoolByTag);

    console.log(
      `\n=== Page ${pageNumber}: ${correctionByTag.size} auto-fix(es), ${hardFlagByTag.size} confirmed geometric violation(s), ${groupFlagByTag.size} group-disagreement flag(s) ===`
    );
    for (const t of pageWeldTags) {
      const tag = t.tagNumber.toUpperCase();
      const correction = correctionByTag.get(tag);
      const newFlag = hardFlagByTag.get(tag) ?? null;
      const newGroupFlag = groupFlagByTag.get(tag) ?? null;
      const oldAttrs = t.attributes as Record<string, unknown>;
      const oldFlag = typeof oldAttrs.geometry_flag === "string" ? (oldAttrs.geometry_flag as string) : null;
      const oldGroupFlag = typeof oldAttrs.geometry_group_flag === "string" ? (oldAttrs.geometry_group_flag as string) : null;
      const oldCorrectedFrom = typeof oldAttrs.spool_no_corrected_from === "string" ? (oldAttrs.spool_no_corrected_from as string) : null;
      // A correction made on a PRIOR run has already been written into
      // spool_no itself -- this run's rawSpoolByTag reads that corrected
      // value back as "the" value, so correctionByTag naturally has no
      // entry for it the second time (nothing left to fix). That must NOT
      // erase the audit note recorded last time; only a NEW correction
      // this run should ever change it.
      const newCorrectedFrom = correction?.oldSpoolNo ?? oldCorrectedFrom;
      const newSpoolNo = correction?.newSpoolNo ?? oldAttrs.spool_no;
      if (newFlag === oldFlag && newGroupFlag === oldGroupFlag && newCorrectedFrom === oldCorrectedFrom) continue;
      await db
        .update(extractedTags)
        .set({ attributes: { ...oldAttrs, spool_no: newSpoolNo, spool_no_corrected_from: newCorrectedFrom, geometry_flag: newFlag, geometry_group_flag: newGroupFlag } })
        .where(eq(extractedTags.id, t.id));
      updated++;
      if (correction) console.log(`  [weld ${t.tagNumber}] AUTO-FIXED spool_no "${correction.oldSpoolNo}" -> "${correction.newSpoolNo}"`);
      if (newFlag !== oldFlag) console.log(`  [weld ${t.tagNumber}] geometry_flag ${newFlag ? "SET" : "cleared"} (spool_no="${newSpoolNo}")`);
      if (newGroupFlag !== oldGroupFlag) console.log(`  [weld ${t.tagNumber}] geometry_group_flag ${newGroupFlag ? "SET" : "cleared"} (spool_no="${newSpoolNo}")`);
    }
  }

  console.log(`\nDone. ${updated} tag(s) updated. Refresh the /spooling page to see the current flags.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
