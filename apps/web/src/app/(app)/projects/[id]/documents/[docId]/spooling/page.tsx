import Link from "next/link";
import { Fragment } from "react";
import { eq } from "drizzle-orm";
import { documents, extractedTags } from "@easy/db";
import { getDb } from "@/lib/db";
import { buildSpoolingView, type DimensionRefKind } from "@/lib/verifyIso";

// One overall category per dimension row. "valve" -- a valve has a genuine
// face-to-face body length, so a dimension reaching one stops at its flange
// FACE rather than measuring through it, changing what the number actually
// means. "weldolet" -- a manually-confirmed override (see DimensionRow's
// own manualKind) for a dimension that measures a weldolet's own branch-
// connection depth, which also isn't a plain in-line pipe length, even
// though neither end's ref text says "weldolet" literally. A gasket/flange
// has no meaningful length of its own (confirmed real case: DIM1-13 reaches
// an "orifice flange assembly" but its 1111mm is plainly measuring the PIPE
// RUN up to that point, not the flange) -- every dimension that merely
// names a flange/gasket landmark, without also naming a valve, is still a
// plain pipe measurement and stays "pipe". A manualKind of "pipe" forces
// this bucket even when an end's ref text WOULD auto-classify as valve --
// confirmed real case: DIM1-7 (15mm) names item 7 (a known valve item) only
// as a general area landmark in its from_ref, not as the dimension's real
// endpoint (a spectacle blind) -- the 15mm is gasket/stud-bolt clearance at
// that boundary, not a valve body measurement, so the auto "valve" read is
// a false positive here. A manualKind of "valve" is the opposite override,
// for when a weld tag co-occurring in the same ref text as a valve word
// wins the auto classification (weld tags are checked first) but the
// dimension's real endpoint is actually the valve -- confirmed real case:
// DIM1-6 (457mm)'s from_ref "BW06 / item 7 ball valve region" names both,
// and BW06 is only the general area, not this dimension's own endpoint.
type DimensionKind = "valve" | "weldolet" | "pipe";
function dimensionKind(fromKind: DimensionRefKind, toKind: DimensionRefKind, manualKind: "weldolet" | "pipe" | "valve" | null): DimensionKind {
  if (manualKind === "weldolet") return "weldolet";
  if (manualKind === "pipe") return "pipe";
  if (manualKind === "valve") return "valve";
  return fromKind === "valve" || toKind === "valve" ? "valve" : "pipe";
}
const DIMENSION_KIND_STYLE: Record<DimensionKind, string> = {
  valve: "bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300",
  weldolet: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300",
  pipe: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
};

export default async function SpoolingPage({ params }: { params: Promise<{ id: string; docId: string }> }) {
  const { id: projectId, docId } = await params;
  const db = getDb();

  const [document] = await db.select().from(documents).where(eq(documents.id, docId)).limit(1);
  if (!document || document.projectId !== projectId) return <p>Document not found.</p>;
  if (document.docType !== "iso") return <p>Not an ISO document.</p>;

  const tags = await db.select().from(extractedTags).where(eq(extractedTags.documentId, docId));
  const { spoolTags, weldTags, spoolsByPage, dimensionRows, cutPieceRows, reconciliationRows, unassignedWelds, unassignedDimensions } = buildSpoolingView(tags);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/projects/${projectId}/documents/${docId}`} className="text-sm text-blue-600 underline">
          &larr; Back to {document.fileName}
        </Link>
        <h1 className="text-xl font-semibold">Spooling: {document.fileName}</h1>
      </div>

      <section className="rounded border p-4">
        {spoolTags.length === 0 && weldTags.length === 0 && dimensionRows.length === 0 && cutPieceRows.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No spools, welds, dimensions, or cut pieces extracted from this document.</p>
        ) : (
          <>
            {spoolTags.length > 0 && (
              <>
                <h3 className="mb-2 font-medium">Pipe spools ({spoolTags.length})</h3>
                <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
                  Boundaries are the field weld / erection joint at each end -- a shop weld never ends a spool, it only joins pieces within
                  one. Each of the 3 axes is sized independently (coordinate spread vs. same-axis dimension sum, never combined across a
                  bend), checked against a 20ft then a 40ft container&apos;s internal envelope -- a flag here usually means a field weld was
                  missed during extraction, or is a genuine oversized-shipment issue worth a human look.
                </p>
                <div className="flex flex-col gap-3">
                  {[...spoolsByPage.entries()].map(([page, spools]) => (
                    <div key={page} className="rounded border px-3 py-2 text-sm">
                      <span className="text-gray-500 dark:text-gray-400">Sheet (page {page}):</span>
                      <div className="mt-1 overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <thead>
                            <tr className="border-b text-xs text-gray-500 dark:text-gray-400">
                              <th className="py-1 pr-2">Spool</th>
                              <th className="pr-2">Weld</th>
                              <th className="pr-2">Type</th>
                              <th className="pr-2">Size</th>
                              <th>Connects to</th>
                            </tr>
                          </thead>
                          <tbody>
                            {spools.map((s) => (
                              <Fragment key={s.spoolNo}>
                                <tr className="border-b bg-gray-50/50 dark:bg-gray-800/50 align-top">
                                  <td colSpan={5} className="py-1.5">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-200">[{s.spoolNo}]</span>
                                      {s.shippingContainer === "oversized" ? (
                                        <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/50 dark:text-red-300">
                                          &#9888; oversized -- exceeds 40ft ({s.boundingBoxMm?.map((d) => Math.round(d)).join(" x ")} mm)
                                        </span>
                                      ) : s.shippingContainer && s.boundingBoxMm ? (
                                        <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/50 dark:text-green-300">
                                          &#10003; fits {s.shippingContainer} ({s.boundingBoxMm.map((d) => Math.round(d)).join(" x ")} mm)
                                        </span>
                                      ) : (
                                        <span className="text-xs text-gray-400">container fit: not enough data</span>
                                      )}
                                      {s.containerOrientation && s.containerOrientation.length > 0 && (
                                        <span className="text-xs text-gray-500 dark:text-gray-400">
                                          {s.containerOrientation
                                            .map((leg) => `${leg.axis}-axis (${leg.extentMm}mm) along ${leg.containerDim} (${leg.clearanceMm}mm spare)`)
                                            .join(" · ")}
                                        </span>
                                      )}
                                      {s.boundaryFlag && (
                                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-900/50 dark:text-amber-300" title={s.boundaryFlag}>
                                          &#9888; possible branch spool -- {s.boundaryFlag}
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                                {s.welds.length === 0 ? (
                                  <tr className="border-b">
                                    <td></td>
                                    <td colSpan={4} className="py-1 text-xs text-gray-400">
                                      No welds assigned to this spool.
                                    </td>
                                  </tr>
                                ) : (
                                  s.welds.map((w) => (
                                    <tr
                                      key={w.tagNumber}
                                      className={`border-b align-top ${w.geometryFlag || w.weldListFlag ? "bg-red-50 dark:bg-red-950/40" : w.geometryGroupFlag ? "bg-amber-50 dark:bg-amber-950/40" : w.spoolNoCorrectedFrom || w.locationNoteCorrectedFrom ? "bg-green-50 dark:bg-green-950/40" : ""}`}
                                    >
                                      <td></td>
                                      <td className="py-1 pr-2 font-mono text-xs text-blue-600">{w.tagNumber}</td>
                                      <td className="pr-2 text-xs capitalize text-gray-500 dark:text-gray-400">{w.weldType}</td>
                                      <td className="pr-2 text-xs text-gray-500 dark:text-gray-400">
                                        {w.size ?? "-"}
                                        {w.weldListId && (
                                          <span
                                            className={`ml-1 rounded px-1 py-0.5 font-mono text-[10px] ${w.weldListFlag ? "bg-red-100 text-red-800" : "bg-green-100 text-green-800"}`}
                                            title={w.weldListFlag ?? `Cross-referenced to this sheet's own printed WELD LIST table, row ID ${w.weldListId} -- verified, no disagreement.`}
                                          >
                                            WL#{w.weldListId}
                                          </span>
                                        )}
                                      </td>
                                      <td className="text-xs text-gray-600 dark:text-gray-300">
                                        {w.locationNote}
                                        {w.spoolNoCorrectedFrom && (
                                          <span
                                            className="ml-1 rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-800 dark:bg-green-900/50 dark:text-green-300"
                                            title={`Auto-corrected by deterministic geometry check -- was spool_no "${w.spoolNoCorrectedFrom}"`}
                                          >
                                            &#10003; geometry-corrected (was &quot;{w.spoolNoCorrectedFrom}&quot;)
                                          </span>
                                        )}
                                        {w.locationNoteCorrectedFrom && (
                                          <span
                                            className="ml-1 rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-800 dark:bg-green-900/50 dark:text-green-300"
                                            title={`Manually confirmed against the drawing -- was: "${w.locationNoteCorrectedFrom}"`}
                                          >
                                            &#10003; description corrected
                                          </span>
                                        )}
                                        {w.geometryFlag && (
                                          <span className="ml-1 rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-800 dark:bg-red-900/50 dark:text-red-300" title={w.geometryFlag}>
                                            &#9888; geometry-confirmed spool conflict
                                          </span>
                                        )}
                                        {!w.geometryFlag && w.geometryGroupFlag && (
                                          <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-900/50 dark:text-amber-300" title={w.geometryGroupFlag}>
                                            &#9888; geometry: same unbroken run as a different spool_no
                                          </span>
                                        )}
                                      </td>
                                    </tr>
                                  ))
                                )}
                                {s.dimensions.length > 0 && (
                                  <tr className="border-b">
                                    <td></td>
                                    <td colSpan={4} className="py-1.5">
                                      <div className="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">Dimensions ({s.dimensions.length})</div>
                                      <table className="w-full text-left text-xs">
                                        <thead>
                                          <tr className="border-b text-gray-500 dark:text-gray-400">
                                            <th className="py-1 pr-2">Dimension</th>
                                            <th className="pr-2">Value (mm)</th>
                                            <th className="pr-2">Axis</th>
                                            <th className="pr-2">Type</th>
                                            <th className="pr-2">From</th>
                                            <th>To</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {s.dimensions.map((d) => {
                                            const kind = dimensionKind(d.fromKind, d.toKind, d.manualKind);
                                            return (
                                              <tr key={d.tagNumber} className={`border-b align-top ${d.spoolFlag ? "bg-amber-50 dark:bg-amber-950/40" : ""}`}>
                                                <td className="py-1 pr-2 font-mono">{d.tagNumber}</td>
                                                <td className="pr-2">{d.valueMm ?? "-"}</td>
                                                <td className="pr-2">{d.axis ?? "-"}</td>
                                                <td className="pr-2">
                                                  <span className={`rounded px-1.5 py-0.5 text-xs capitalize ${DIMENSION_KIND_STYLE[kind]}`}>{kind}</span>
                                                  {d.spoolFlag && (
                                                    <span
                                                      className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800 dark:bg-amber-900/50 dark:text-amber-300"
                                                      title={d.spoolFlag}
                                                    >
                                                      &#9888; mismatch
                                                    </span>
                                                  )}
                                                </td>
                                                <td className="pr-2 text-gray-500 dark:text-gray-400">{d.fromRef ?? "-"}</td>
                                                <td className="text-gray-500 dark:text-gray-400">{d.toRef ?? "-"}</td>
                                              </tr>
                                            );
                                          })}
                                        </tbody>
                                      </table>
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {(unassignedWelds.length > 0 || unassignedDimensions.length > 0) && (
              <>
                <h3 className="mb-2 mt-6 font-medium">Unassigned ({unassignedWelds.length + unassignedDimensions.length})</h3>
                <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
                  Welds/dimensions whose own spool didn&apos;t come back set, or didn&apos;t match any spool the extraction produced its
                  own tag for -- they don&apos;t show up under any spool above, so they&apos;re worth a look here instead of going
                  unnoticed.
                </p>
                {unassignedWelds.length > 0 && (
                  <div className="mb-4 overflow-x-auto">
                    <p className="mb-1 text-sm font-medium">Welds ({unassignedWelds.length})</p>
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b text-xs text-gray-500 dark:text-gray-400">
                          <th className="py-1 pr-2">Weld</th>
                          <th className="pr-2">Type</th>
                          <th className="pr-2">Size</th>
                          <th>Location</th>
                        </tr>
                      </thead>
                      <tbody>
                        {unassignedWelds.map((w) => (
                          <tr key={w.tagNumber} className="border-b align-top bg-amber-50 dark:bg-amber-950/40">
                            <td className="py-1 pr-2 font-mono text-xs text-blue-600">{w.tagNumber}</td>
                            <td className="pr-2 text-xs capitalize text-gray-500 dark:text-gray-400">{w.weldType}</td>
                            <td className="pr-2 text-xs text-gray-500 dark:text-gray-400">{w.size ?? "-"}</td>
                            <td className="text-xs text-gray-600 dark:text-gray-300">{w.locationNote}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {unassignedDimensions.length > 0 && (
                  <div className="overflow-x-auto">
                    <p className="mb-1 text-sm font-medium">Dimensions ({unassignedDimensions.length})</p>
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b text-xs text-gray-500 dark:text-gray-400">
                          <th className="py-1 pr-2">Dimension</th>
                          <th className="pr-2">Value (mm)</th>
                          <th className="pr-2">Axis</th>
                          <th className="pr-2">From</th>
                          <th>To</th>
                        </tr>
                      </thead>
                      <tbody>
                        {unassignedDimensions.map((d) => (
                          <tr key={d.tagNumber} className="border-b align-top bg-amber-50 dark:bg-amber-950/40">
                            <td className="py-1 pr-2 font-mono text-xs">{d.tagNumber}</td>
                            <td className="pr-2 text-xs">{d.valueMm ?? "-"}</td>
                            <td className="pr-2 text-xs">{d.axis ?? "-"}</td>
                            <td className="pr-2 text-xs text-gray-500 dark:text-gray-400">{d.fromRef ?? "-"}</td>
                            <td className="text-xs text-gray-500 dark:text-gray-400">{d.toRef ?? "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}

            {reconciliationRows.length > 0 && (
              <>
                <h3 className="mb-2 mt-6 font-medium">
                  Fitting length reconciliation ({reconciliationRows.filter((r) => r.matchedDimensionTag).length}/{reconciliationRows.length})
                </h3>
                <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
                  For a cut piece whose two bounding welds also match a printed dimension&apos;s own two ends: the dimension measures an
                  assembled span (a fitting&apos;s own centerline when either end is an elbow), while the cut piece is the raw straight
                  stock in between -- the difference is real fitting take-up length, not error. Two elbows (one at each end) split it
                  evenly into a per-elbow figure; one elbow attributes all of it to that end; zero means the gap is ordinary weld/bevel
                  allowance, not a fitting.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="py-1">Piece</th>
                        <th>Cut length (mm)</th>
                        <th>From &rarr; To</th>
                        <th>Dimension</th>
                        <th>Dim. value (mm)</th>
                        <th>Remaining (mm)</th>
                        <th>Elbows</th>
                        <th>Per-elbow (mm)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reconciliationRows.map((r) =>
                        r.matchedDimensionTag ? (
                          <tr key={r.pieceTag} className={`border-b align-top ${r.note ? "bg-amber-50 dark:bg-amber-950/40" : "bg-green-50 dark:bg-green-950/40"}`}>
                            <td className="py-1 font-mono text-xs">{r.pieceTag}</td>
                            <td>{r.cutLengthMm}</td>
                            <td className="text-xs text-gray-500 dark:text-gray-400">
                              {r.fromRef} &rarr; {r.toRef}
                            </td>
                            <td className="font-mono text-xs">
                              {r.matchedDimensionTag}
                              {r.note && <div className="mt-0.5 max-w-[16rem] text-[11px] font-normal italic text-amber-700 dark:text-amber-400">{r.note}</div>}
                            </td>
                            <td>{r.dimensionValueMm}</td>
                            <td>{r.remainingMm}</td>
                            <td>{r.elbowCount}</td>
                            <td className={r.perElbowMm ? "font-medium text-purple-800 dark:text-purple-300" : ""}>
                              {r.perElbowMm ? r.perElbowMm.toFixed(1) : "-"}
                            </td>
                          </tr>
                        ) : (
                          <tr key={r.pieceTag} className="border-b align-top text-gray-400">
                            <td className="py-1 font-mono text-xs">{r.pieceTag}</td>
                            <td>{r.cutLengthMm}</td>
                            <td className="text-xs">
                              {r.fromRef} &rarr; {r.toRef}
                            </td>
                            <td colSpan={5} className="text-xs italic">
                              no matching dimension found
                            </td>
                          </tr>
                        )
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
