import Link from "next/link";
import { Fragment } from "react";
import { eq } from "drizzle-orm";
import { documents, extractedTags } from "@easy/db";
import { getDb } from "@/lib/db";
import { buildSpoolingView } from "@/lib/verifyIso";

export default async function SpoolingPage({ params }: { params: Promise<{ id: string; docId: string }> }) {
  const { id: projectId, docId } = await params;
  const db = getDb();

  const [document] = await db.select().from(documents).where(eq(documents.id, docId)).limit(1);
  if (!document || document.projectId !== projectId) return <p>Document not found.</p>;
  if (document.docType !== "iso") return <p>Not an ISO document.</p>;

  const tags = await db.select().from(extractedTags).where(eq(extractedTags.documentId, docId));
  const { spoolTags, weldTags, spoolsByPage, weldCountsByType, weldsByType, weldTypesSorted } = buildSpoolingView(tags);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/projects/${projectId}/documents/${docId}`} className="text-sm text-blue-600 underline">
          &larr; Back to {document.fileName}
        </Link>
        <h1 className="text-xl font-semibold">Spooling: {document.fileName}</h1>
      </div>

      <section className="rounded border p-4">
        {spoolTags.length === 0 && weldTags.length === 0 ? (
          <p className="text-sm text-gray-500">No spools or welds extracted from this document.</p>
        ) : (
          <>
            {spoolTags.length > 0 && (
              <>
                <h3 className="mb-2 font-medium">Pipe spools ({spoolTags.length})</h3>
                <p className="mb-2 text-xs text-gray-500">
                  Boundaries are the field weld / erection joint at each end -- a shop weld never ends a spool, it only joins pieces within
                  one. Each of the 3 axes is sized independently (coordinate spread vs. same-axis dimension sum, never combined across a
                  bend), checked against a 20ft then a 40ft container&apos;s internal envelope -- a flag here usually means a field weld was
                  missed during extraction, or is a genuine oversized-shipment issue worth a human look.
                </p>
                <div className="flex flex-col gap-3">
                  {[...spoolsByPage.entries()].map(([page, spools]) => (
                    <div key={page} className="rounded border px-3 py-2 text-sm">
                      <span className="text-gray-500">Sheet (page {page}):</span>
                      <div className="mt-1 overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <thead>
                            <tr className="border-b text-xs text-gray-500">
                              <th className="py-1 pr-2">Spool</th>
                              <th className="pr-2">Weld</th>
                              <th className="pr-2">Type</th>
                              <th>Connects to</th>
                            </tr>
                          </thead>
                          <tbody>
                            {spools.map((s) => (
                              <Fragment key={s.spoolNo}>
                                <tr className="border-b bg-gray-50/50 align-top">
                                  <td colSpan={4} className="py-1.5">
                                    <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-800">[{s.spoolNo}]</span>
                                    {s.boundaryNote && <span className="ml-2 text-xs text-gray-500">{s.boundaryNote}</span>}
                                    {s.shippingContainer === "oversized" && (
                                      <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700">
                                        &#9888; oversized -- exceeds a 40ft container ({s.boundingBoxMm?.map((d) => Math.round(d)).join(" x ")} mm)
                                      </span>
                                    )}
                                    {s.shippingContainer && s.shippingContainer !== "oversized" && s.boundingBoxMm && (
                                      <span className="ml-2 text-xs text-gray-400">
                                        fits {s.shippingContainer} ({s.boundingBoxMm.map((d) => Math.round(d)).join(" x ")} mm)
                                      </span>
                                    )}
                                  </td>
                                </tr>
                                {s.welds.length === 0 ? (
                                  <tr className="border-b">
                                    <td></td>
                                    <td colSpan={3} className="py-1 text-xs text-gray-400">
                                      No welds assigned to this spool.
                                    </td>
                                  </tr>
                                ) : (
                                  s.welds.map((w) => (
                                    <tr key={w.tagNumber} className="border-b align-top">
                                      <td></td>
                                      <td className="py-1 pr-2 font-mono text-xs text-blue-600">{w.tagNumber}</td>
                                      <td className="pr-2 text-xs capitalize text-gray-500">{w.weldType}</td>
                                      <td className="text-xs text-gray-600">{w.locationNote}</td>
                                    </tr>
                                  ))
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

            {weldTags.length > 0 && (
              <>
                <h3 className="mb-2 mt-6 font-medium">Weld list ({weldTags.length})</h3>
                <p className="mb-2 text-xs text-gray-500">{[...weldCountsByType.entries()].map(([type, n]) => `${n} ${type}`).join(", ")}</p>
                {weldTypesSorted.map((type) => {
                  const rows = weldsByType.get(type) ?? [];
                  return (
                    <div key={type} className="mb-4">
                      <p className="mb-1 text-sm font-medium capitalize">
                        {type} <span className="font-normal text-gray-500">({rows.length})</span>
                      </p>
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="border-b">
                            <th className="py-1">Weld</th>
                            <th>Size</th>
                            <th>Location</th>
                            <th>Page</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((t) => {
                            const a = t.attributes as Record<string, unknown>;
                            return (
                              <tr key={t.id} className="border-b align-top">
                                <td className="py-1 font-mono text-xs">{t.tagNumber}</td>
                                <td>{String(a.size ?? "-")}</td>
                                <td className="text-xs text-gray-500">{String(a.location_note ?? "-")}</td>
                                <td>{t.sourcePage ?? "-"}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                })}
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
