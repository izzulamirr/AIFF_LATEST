import Link from "next/link";
import { and, asc, eq, inArray } from "drizzle-orm";
import { documents, documentPages, extractedTags, organizationMembers, organizations, projects } from "@easy/db";
import { enrichIsoLineAttrs, normalizeTagNumber } from "@easy/shared";
import { createClient } from "@/lib/supabase/server";
import { getDb } from "@/lib/db";
import { extractSheetItems, combineAdminText, type SheetItem } from "@/lib/parseSheetPage";
import {
  isoSpecClasses,
  matchesLineAcrossSpecBreak,
  mergeIsoLineSheets,
  buildValveMatch,
  buildRoutingFittingComparison,
  countPidValves,
  type ValveMatchGroup,
  type RoutingFittingRow,
} from "@/lib/verifyIso";
import {
  crossCheckBomItem,
  resolveBomItemSpecClass,
  normalizeBomSpecClass,
  resolveValveClientStatus,
  resolveClientAndAdminData,
} from "@/lib/verifyBomCrossCheck";

const BOM_STATUS_STYLES: Record<string, string> = {
  match: "text-green-600",
  not_found: "text-red-600",
  size_unrecognized: "text-yellow-600",
  out_of_scope: "text-gray-400",
  class_not_found: "text-red-500",
  no_client_data: "text-blue-500",
};

interface BomRow {
  itemNo: string;
  componentType: string;
  size: string;
  quantity: string;
  description: string;
  result: ReturnType<typeof crossCheckBomItem>;
  // The actual matched admin item lines (not just whether any exist) -- see
  // combineAdminText for why this is shown as real text, not a yes/no.
  adminMatches: SheetItem[] | null;
}

// Full-chain verification, standalone: pick ANY ISO drawing across every
// project you're a member of (not scoped to a single project/document's own
// URL), and it auto-detects every material class that drawing's own BOM
// resolves to -- same detection the class-detail page's Stage 2 already
// uses (a spec break puts 2-3 classes on one drawing) -- so there's no
// separate "which spec" step to configure by hand.
export default async function CrossCheckPage({ searchParams }: { searchParams: Promise<{ isoDocId?: string; spec?: string }> }) {
  const { isoDocId, spec } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const db = getDb();

  const memberships = await db
    .select({ organization: organizations })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(eq(organizationMembers.userId, user.id));
  const orgIds = memberships.map((m) => m.organization.id);
  const projectRows = orgIds.length ? await db.select().from(projects).where(inArray(projects.organizationId, orgIds)) : [];
  const projectIds = projectRows.map((p) => p.id);
  const projectNameById = new Map(projectRows.map((p) => [p.id, p.name]));

  const isoDocs = projectIds.length
    ? await db
        .select()
        .from(documents)
        .where(and(inArray(documents.projectId, projectIds), eq(documents.docType, "iso")))
    : [];

  const selectedIsoDoc = isoDocId ? isoDocs.find((d) => d.id === isoDocId) : undefined;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Cross check</h1>
        <p className="text-sm text-gray-500">
          Full-chain verification for one ISO drawing at a time: P&amp;ID &harr; ISO routing/counts, the ISO&apos;s own BOM &harr;
          client spec, and client spec &harr; admin item list.
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          ISO drawing
          <select name="isoDocId" defaultValue={isoDocId ?? ""} className="mt-1 block min-w-80 rounded border px-3 py-2">
            <option value="">Select a drawing&hellip;</option>
            {isoDocs.map((d) => (
              <option key={d.id} value={d.id}>
                {projectNameById.get(d.projectId) ?? d.projectId} / {d.fileName}
              </option>
            ))}
          </select>
        </label>
        <button className="rounded bg-black px-4 py-2 text-sm text-white">Load</button>
      </form>
      {isoDocs.length === 0 && <p className="text-sm text-gray-500">No ISO drawings uploaded to any of your projects yet.</p>}

      {selectedIsoDoc && <VerifyIsoContent projectId={selectedIsoDoc.projectId} isoDoc={selectedIsoDoc} selectedSpecParam={spec} />}
    </div>
  );
}

async function VerifyIsoContent({
  projectId,
  isoDoc,
  selectedSpecParam,
}: {
  projectId: string;
  isoDoc: typeof documents.$inferSelect;
  selectedSpecParam: string | undefined;
}) {
  const db = getDb();
  const docId = isoDoc.id;

  const isoLineTagsAll = await db.select().from(extractedTags).where(and(eq(extractedTags.documentId, docId), eq(extractedTags.tagType, "line")));
  // One line tag per sheet on a multi-sheet drawing -- collapsed to one per
  // real line.
  const isoLineTags = mergeIsoLineSheets(isoLineTagsAll);
  const isoBomTags = await db.select().from(extractedTags).where(and(eq(extractedTags.documentId, docId), eq(extractedTags.tagType, "bom_item")));

  if (isoLineTags.length === 0) {
    return <p className="text-gray-500">No line data extracted from this drawing yet.</p>;
  }

  const availableSpecs = [...new Set(isoLineTags.flatMap((l) => isoSpecClasses(l.attributes as Record<string, unknown>)))];
  const selectedSpec = selectedSpecParam && availableSpecs.includes(selectedSpecParam) ? selectedSpecParam : (availableSpecs[0] ?? null);

  const siblings = await db.select().from(documents).where(eq(documents.projectId, projectId));
  const pidDocs = siblings.filter((d) => d.docType === "pid");
  const specSheetDocs = siblings.filter((d) => d.docType === "spec_sheet");
  const adminXlsxDocs = specSheetDocs.filter((d) => d.fileName.toLowerCase().endsWith(".xlsx"));

  const pidTags = pidDocs.length
    ? await db
        .select()
        .from(extractedTags)
        .where(and(inArray(extractedTags.documentId, pidDocs.map((d) => d.id)), inArray(extractedTags.tagType, ["line", "valve", "fitting"])))
    : [];

  const valveGroups: ValveMatchGroup[] = [];
  const routingRows: Array<{ lineNumber: string; rows: RoutingFittingRow[] }> = [];
  for (const line of isoLineTags) {
    const isoAttrs = enrichIsoLineAttrs(line.tagNumber, line.attributes as Record<string, unknown>);
    const specClasses = isoSpecClasses(isoAttrs);
    const norm = line.tagNumberNormalized;

    const pidLineMatches = pidTags.filter((t) => t.tagType === "line" && t.tagNumberNormalized === norm);
    const pidLineAttrs = pidLineMatches.map((t) => t.attributes as Record<string, unknown>);
    const pidLineValveAttrs = pidTags
      .filter((t) => t.tagType === "valve" && matchesLineAcrossSpecBreak((t.attributes as Record<string, unknown>).line_number, line.tagNumber, specClasses))
      .map((t) => t.attributes as Record<string, unknown>);
    const pidLineFittings = pidTags
      .filter((t) => t.tagType === "fitting" && matchesLineAcrossSpecBreak((t.attributes as Record<string, unknown>).line_number, line.tagNumber, specClasses))
      .map((t) => t.attributes as Record<string, unknown>);
    const pidValveCount = countPidValves(pidLineValveAttrs);

    const bomForLine = isoBomTags
      .filter((b) => {
        const ln = (b.attributes as Record<string, unknown>).line_number;
        return typeof ln === "string" && normalizeTagNumber(ln) === norm;
      })
      .map((b) => b.attributes as Record<string, unknown>);

    valveGroups.push(...buildValveMatch(bomForLine, pidLineValveAttrs));
    routingRows.push({ lineNumber: line.tagNumber, rows: buildRoutingFittingComparison(isoAttrs, bomForLine, pidLineAttrs, pidValveCount, pidLineFittings) });
  }
  const selectedValveGroup = valveGroups.find((g) => g.specClass === selectedSpec) ?? null;

  const allSpecClassTags = specSheetDocs.length
    ? await db.select().from(extractedTags).where(and(inArray(extractedTags.documentId, specSheetDocs.map((d) => d.id)), eq(extractedTags.tagType, "spec_class")))
    : [];
  const allAdminItems: SheetItem[] = [];
  if (adminXlsxDocs.length > 0) {
    const adminPages = await db
      .select()
      .from(documentPages)
      .where(inArray(documentPages.documentId, adminXlsxDocs.map((d) => d.id)))
      .orderBy(asc(documentPages.pageNumber));
    for (const p of adminPages) allAdminItems.push(...extractSheetItems(p.pageText));
  }
  const { clientClassByNorm, adminGroupsByNorm } = resolveClientAndAdminData(allSpecClassTags, allAdminItems, new Set(availableSpecs));

  // One block per ISO SHEET, not one flat list -- a multi-sheet drawing
  // repeats its own item numbering per sheet (item "7" on sheet 1 OF 3 is a
  // different component than item "7" on sheet 2 OF 3), so a flat list
  // mixing every sheet together showed the same item number several times
  // with no way to tell which sheet a given row was actually on. Uses
  // isoLineTagsAll (one tag per sheet) instead of the merged isoLineTags
  // (one tag per real line, used everywhere else on this page) specifically
  // for this grouping -- same split docId/page.tsx's own "BOM by spec, per
  // sheet" view and the class-detail page's Stage 2 BOM cross-check use.
  let bomBySheet: Array<{ lineNumber: string; sheetLabel: string; page: number | null; rows: BomRow[] }> = [];
  if (selectedSpec) {
    const normalizedSelected = normalizeBomSpecClass(selectedSpec);
    const clientClass = clientClassByNorm.get(normalizedSelected);
    const adminGroups = adminGroupsByNorm.get(normalizedSelected);

    bomBySheet = [...isoLineTagsAll]
      .sort((a, b) => (a.sourcePage ?? 0) - (b.sourcePage ?? 0))
      .map((line) => {
        const lineAttrs = line.attributes as Record<string, unknown>;
        const norm = normalizeTagNumber(line.tagNumber);

        const rows = isoBomTags
          .filter((tag) => {
            if (line.sourcePage != null && tag.sourcePage !== line.sourcePage) return false;
            const ln = (tag.attributes as Record<string, unknown>).line_number;
            return typeof ln === "string" && normalizeTagNumber(ln) === norm;
          })
          .map((tag) => {
            const item = tag.attributes as Record<string, unknown>;
            const itemClass = resolveBomItemSpecClass(item, lineAttrs);
            if (normalizeBomSpecClass(itemClass) !== normalizedSelected) return null;

            const result = crossCheckBomItem(item, clientClass);
            const adminMatches =
              adminGroups && result.matchedCategory != null && result.matchedRowIndex != null
                ? (adminGroups.get(`${result.matchedCategory}:${result.matchedRowIndex}`) ?? [])
                : null;

            return {
              itemNo: tag.tagNumber,
              componentType: String(item.component_type ?? "-"),
              size: String(item.size ?? "-"),
              quantity: String(item.quantity ?? "-"),
              description: String(item.description ?? "-"),
              result,
              adminMatches,
            };
          })
          .filter((r): r is BomRow => r !== null);

        if (rows.length === 0) return null;
        const sheetLabel = typeof lineAttrs.sheet === "string" && lineAttrs.sheet ? lineAttrs.sheet : line.sourcePage != null ? `page ${line.sourcePage}` : "";
        return { lineNumber: line.tagNumber, sheetLabel, page: line.sourcePage, rows };
      })
      .filter((v): v is { lineNumber: string; sheetLabel: string; page: number | null; rows: BomRow[] } => v !== null);
  }

  return (
    <div className="flex flex-col gap-6">
      {availableSpecs.length === 0 ? (
        <p className="text-gray-500">This drawing&apos;s BOM has no resolvable material class.</p>
      ) : (
        <div>
          {availableSpecs.length > 1 && (
            <p className="mb-2 text-xs text-amber-700">
              &#9888; This drawing&apos;s BOM spans {availableSpecs.length} classes (a spec break along the run) -- pick which one
              below.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {availableSpecs.map((s) => (
              <Link
                key={s}
                href={`?isoDocId=${encodeURIComponent(isoDoc.id)}&spec=${encodeURIComponent(s)}`}
                className={`rounded border px-3 py-1 text-sm ${s === selectedSpec ? "border-black bg-black text-white" : "text-gray-600 hover:bg-gray-50"}`}
              >
                {s}
              </Link>
            ))}
          </div>
        </div>
      )}

      <section>
        <h2 className="mb-2 font-medium">Routing &amp; fitting counts: ISO vs P&amp;ID</h2>
        {routingRows.map(({ lineNumber, rows }) => (
          <div key={lineNumber} className="mb-4">
            <p className="mb-1 text-sm">
              Line <span className="font-mono">{lineNumber}</span>
            </p>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-1">Field</th>
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
                    <td className={row.status === "match" ? "text-green-600" : row.status === "mismatch" ? "text-red-600" : "text-gray-400"}>{row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      {selectedValveGroup && (
        <section>
          <h2 className="mb-2 font-medium">
            Valve match: ISO vs P&amp;ID vs Client vs Admin -- <span className="font-mono">{selectedSpec}</span>
          </h2>
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-1 pl-3">Valve type</th>
                  <th>Size</th>
                  <th>ISO</th>
                  <th>P&amp;ID</th>
                  <th>ISO description</th>
                  <th>Status</th>
                  <th className="border-l pl-3">Client Spec</th>
                  <th>Admin</th>
                </tr>
              </thead>
              <tbody>
                {selectedValveGroup.rows.map((row) => {
                  const clientResult = resolveValveClientStatus(row.dn, clientClassByNorm.get(selectedValveGroup.specClass), adminGroupsByNorm.get(selectedValveGroup.specClass));
                  return (
                    <tr key={`${row.category}-${row.size}`} className="border-b align-top">
                      <td className="py-1 pl-3">{row.category}</td>
                      <td className="font-mono text-xs">{row.size}</td>
                      <td>{row.isoCount || "-"}</td>
                      <td>{row.pidCount || "-"}</td>
                      <td className="text-xs text-gray-500">{row.isoDetail ?? "-"}</td>
                      <td className={row.status === "match" ? "text-green-600" : row.status === "count mismatch" ? "text-amber-600" : "text-red-600"}>{row.status}</td>
                      <td className={`border-l pl-3 ${clientResult.status === "match" ? "text-green-600" : clientResult.status === "not_found" ? "text-red-600" : "text-gray-400"}`}>
                        {clientResult.status === "match" ? "match" : clientResult.status === "not_found" ? "not in spec" : clientResult.status === "no_client_data" ? "no client data" : "-"}
                      </td>
                      <td>
                        {clientResult.adminConfirmed == null ? (
                          <span className="text-gray-400">-</span>
                        ) : clientResult.adminConfirmed ? (
                          <span className="text-green-600">yes</span>
                        ) : (
                          <span className="text-red-600">no admin line</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {selectedSpec && (
        <section>
          <h2 className="mb-2 font-medium">
            BOM items: ISO vs Client vs Admin -- <span className="font-mono">{selectedSpec}</span>
          </h2>
          <p className="mb-2 text-xs text-gray-500">
            Every BOM line resolved to this class (pipes, fittings, flanges included -- valves are covered in more detail above). Client
            Spec checks the item&apos;s type+size against this class&apos;s own extracted spec; Admin checks whether the client&apos;s own
            procurement item list independently confirms it.
          </p>
          {bomBySheet.length === 0 && <p className="text-gray-500">No BOM items resolved to spec &quot;{selectedSpec}&quot; on this drawing.</p>}

          {bomBySheet.map(({ lineNumber, sheetLabel, page, rows }) => (
            <div key={`${lineNumber}-${page ?? sheetLabel}`} className="mb-4 rounded border p-3">
              <p className="mb-2 text-sm font-medium">
                Sheet {sheetLabel || "?"} <span className="font-normal text-gray-500">&middot; line</span>{" "}
                <span className="font-mono font-normal">{lineNumber}</span>
              </p>
              <div className="overflow-x-auto rounded border">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b bg-gray-50 text-xs uppercase text-gray-500">
                      <th className="py-2 pl-3">Item</th>
                      <th>Type</th>
                      <th>Size</th>
                      <th>Qty</th>
                      <th>Description</th>
                      <th>Client Spec</th>
                      <th>Admin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={i} className="border-b align-top">
                        <td className="py-1 pl-3 font-mono text-xs">{row.itemNo}</td>
                        <td className="text-xs text-gray-500">{row.componentType}</td>
                        <td>{row.size}</td>
                        <td>{row.quantity}</td>
                        <td className="max-w-xs text-xs text-gray-600">{row.description}</td>
                        <td className={`max-w-xs text-xs ${BOM_STATUS_STYLES[row.result.status]}`}>
                          {row.result.clientDescription ?? row.result.label}
                          {row.result.clientSize ? <span className="ml-1 text-gray-400">({row.result.clientSize})</span> : null}
                        </td>
                        <td className="max-w-xs text-xs">
                          {row.adminMatches == null ? (
                            <span className="text-gray-400">-</span>
                          ) : row.adminMatches.length > 0 ? (
                            <span className="text-green-600">{row.adminMatches.map((m) => combineAdminText(m)).join("; ")}</span>
                          ) : (
                            <span className="text-red-600">No admin line</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
