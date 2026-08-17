import Link from "next/link";
import { eq } from "drizzle-orm";
import { documents, extractedTags } from "@easy/db";
import { getDb } from "@/lib/db";
import { loadIsoDocContext, loadRoutingAndValveMatch, type ValveMatchGroup } from "@/lib/verifyIso";

export default async function ValveMatchPage({ params }: { params: Promise<{ id: string; docId: string }> }) {
  const { id: projectId, docId } = await params;
  const db = getDb();

  const [document] = await db.select().from(documents).where(eq(documents.id, docId)).limit(1);
  if (!document || document.projectId !== projectId) return <p>Document not found.</p>;
  if (document.docType !== "iso") return <p>Not an ISO document.</p>;

  const tags = await db.select().from(extractedTags).where(eq(extractedTags.documentId, docId));
  const { pidOptions, docNameById } = await loadIsoDocContext(projectId, document);
  const routingFittings = await loadRoutingAndValveMatch({ tags, pidOptions, docNameById });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/projects/${projectId}/documents/${docId}`} className="text-sm text-blue-600 underline">
          &larr; Back to {document.fileName}
        </Link>
        <h1 className="text-xl font-semibold">Valve match: {document.fileName}</h1>
      </div>

      <section className="rounded border p-4">
        <h3 className="mb-2 font-medium">Routing &amp; fittings: ISO vs P&amp;ID</h3>
        {routingFittings.length === 0 && <p className="mb-4 text-sm text-gray-500">No P&amp;ID uploaded/extracted in this project yet.</p>}
        {routingFittings.map(({ lineNumber, pidDocNames, rows }) => (
          <div key={lineNumber} className="mb-4">
            <p className="mb-1 text-sm">
              Line <span className="font-mono">{lineNumber}</span>{" "}
              {rows ? <span className="text-gray-500">vs {pidDocNames.join(", ")}</span> : <span className="text-red-600">-- not found on any P&amp;ID</span>}
            </p>
            {rows && (
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="py-1">Item</th>
                    <th>ISO</th>
                    <th>P&amp;ID</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.field} className="border-b">
                      <td className="py-1">{row.field}</td>
                      <td>{row.isoValue ?? "-"}</td>
                      <td>{row.pidValue ?? "-"}</td>
                      <td
                        className={
                          row.status === "match"
                            ? "text-green-600"
                            : row.status === "mismatch"
                              ? "text-red-600"
                              : "text-gray-400"
                        }
                      >
                        {row.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}

        {routingFittings.some((r) => r.valveMatch && r.valveMatch.length > 0) && (
          <>
            <h3 className="mb-2 mt-6 font-medium">Valve match: ISO vs P&amp;ID</h3>
            <p className="mb-2 text-xs text-gray-500">
              Paired on valve type and nominal size (the ISO BOM aggregates by quantity and most P&amp;ID valves are untagged, so
              neither side can be matched by tag). Disagreements are listed first.
            </p>
            {routingFittings
              .filter((r): r is typeof r & { valveMatch: ValveMatchGroup[] } => Boolean(r.valveMatch?.length))
              .map(({ lineNumber, valveMatch: groups }) => (
                <div key={lineNumber} className="mb-4">
                  <p className="mb-2 text-sm">
                    Line <span className="font-mono">{lineNumber}</span>
                    <span className="ml-2 text-gray-500">
                      {groups.length > 1 ? `${groups.length} material classes along the run` : "single material class"}
                    </span>
                  </p>
                  {groups.map((group) => (
                    <div
                      key={group.specClass}
                      className={`mb-4 rounded border p-3 ${group.specClass === "unassigned" ? "border-amber-500" : ""}`}
                    >
                      <p className="mb-2 text-sm font-medium">
                        <span className="font-mono">{group.specClass}</span>
                        <span className="ml-3 font-normal text-gray-500">
                          ISO {group.isoTotal} / P&amp;ID {group.pidTotal}
                        </span>
                      </p>
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="border-b">
                            <th className="py-1">Valve type</th>
                            <th>Size</th>
                            <th>ISO</th>
                            <th>P&amp;ID</th>
                            <th>ISO description</th>
                            <th>P&amp;ID tag</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.rows.map((row) => (
                            <tr key={`${row.category}-${row.size}`} className="border-b">
                              <td className="py-1">{row.category}</td>
                              <td className="font-mono text-xs">{row.size}</td>
                              <td>{row.isoCount || "-"}</td>
                              <td>{row.pidCount || "-"}</td>
                              <td className="text-xs text-gray-500">{row.isoDetail ?? "-"}</td>
                              <td className="text-xs text-gray-500">{row.pidDetail ?? "-"}</td>
                              <td
                                className={
                                  row.status === "match"
                                    ? "text-green-600"
                                    : row.status === "count mismatch"
                                      ? "text-amber-600"
                                      : "text-red-600"
                                }
                              >
                                {row.status}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              ))}
          </>
        )}
      </section>
    </div>
  );
}
