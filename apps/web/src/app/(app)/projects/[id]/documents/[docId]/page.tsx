import Link from "next/link";
import { asc, desc, eq, inArray, and } from "drizzle-orm";
import { documents, documentPages, extractionResults, extractedTags } from "@easy/db";
import { normalizeTagNumber, enrichIsoLineAttrs } from "@easy/shared";
import { getDb } from "@/lib/db";
import { buildDesignBasisComparison, loadIsoDocContext, mergeIsoLineSheets, type DesignBasisRow, type IsoDocContext } from "@/lib/verifyIso";
import { extractSheetItems, type SheetItem } from "@/lib/parseSheetPage";
import { crossCheckItem, normalizeSpecClassCode, dnToNpsInches, formatNpsInches, type CrossCheckResult } from "@/lib/verifySpecCrossCheck";
import { SizeToggle } from "@/components/SizeToggle";
import { verifyIsoAction } from "./actions";
import { ExtractedTagsTable, type TagGroup } from "./ExtractedTagsTable";

const DOC_TYPE_LABELS: Record<string, string> = {
  pid: "P&ID",
  hmb: "H&MB",
  pfd: "PFD",
  spec_sheet: "Spec Sheet",
  iso: "ISO",
  ga: "GA",
  pll: "Line List (PLL)",
  pid_legend: "P&ID Legend",
};

const ADMIN_STATUS_STYLES: Record<CrossCheckResult["status"], string> = {
  match: "text-green-600",
  mismatch: "text-orange-600",
  not_found: "text-red-600",
  class_not_found: "text-red-500",
  size_unrecognized: "text-yellow-600",
  out_of_scope: "text-gray-400",
  no_client_data: "text-blue-500",
};

// Admin item-list Size P1 is DN (mm) -- shown alongside its NPS (inch)
// equivalent via SizeToggle, same lookup dnToNpsInches/crossCheckItem
// itself uses, so the display and the match verdict can never disagree.
function adminSizeDisplay(mm: string): { mm: string; inch: string } {
  const inches = dnToNpsInches(mm);
  return { mm: mm ? `${mm} mm` : "-", inch: inches == null ? "" : formatNpsInches(inches) };
}

const GATE_LABELS: Record<string, string> = {
  "0": "0 Document",
  "1": "1 Line list",
  "2": "2 Design basis",
  "3": "3 P&ID",
  "4": "4 Specs",
  "5": "5 Geometry",
  "6": "6 Supports",
  "7": "7 BOM",
  "8": "8 GA",
};

export default async function DocumentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; docId: string }>;
  searchParams: Promise<{ adminDocId?: string }>;
}) {
  const { id: projectId, docId } = await params;
  const { adminDocId } = await searchParams;
  const db = getDb();

  const [document] = await db.select().from(documents).where(eq(documents.id, docId)).limit(1);
  if (!document || document.projectId !== projectId) return <p>Document not found.</p>;

  const [result] = await db
    .select()
    .from(extractionResults)
    .where(eq(extractionResults.documentId, docId))
    .orderBy(desc(extractionResults.createdAt))
    .limit(1);

  const tags = await db.select().from(extractedTags).where(eq(extractedTags.documentId, docId));

  // Nest assembly accessories under their primary device: an instrument
  // carrying a parent_valve (valve-actuator accessories: positioner, ZI/ZIT,
  // limit switches, solenoid, handswitch) or a parent_instrument (e.g. a TT
  // installed in a TW thermowell -- the TW is always the primary) is a
  // subset of that primary and is rendered indented beneath it, not as a
  // flat top-level row. Docs with no parent links (every non-P&ID type)
  // fall through to the original flat listing unchanged.
  const tagByNorm = new Map(tags.map((t) => [normalizeTagNumber(t.tagNumber), t] as const));
  const accessoriesByParent = new Map<number, typeof tags>();
  const accessoryIds = new Set<number>();
  for (const t of tags) {
    const attrs = t.attributes as Record<string, unknown>;
    const parent = [attrs.parent_valve, attrs.parent_instrument].find((p): p is string => typeof p === "string" && p.trim().length > 0);
    if (!parent) continue;
    const parentTag = tagByNorm.get(normalizeTagNumber(parent));
    if (!parentTag || parentTag.id === t.id) continue; // orphan link stays top-level
    const list = accessoriesByParent.get(parentTag.id) ?? [];
    list.push(t);
    accessoriesByParent.set(parentTag.id, list);
    accessoryIds.add(t.id);
  }
  const topLevelTags = tags.filter((t) => !accessoryIds.has(t.id));
  const toRow = (t: (typeof tags)[number]) => ({ id: t.id, tagType: t.tagType, tagNumber: t.tagNumber, sourcePage: t.sourcePage, attributes: t.attributes });
  const tagGroups: TagGroup[] = topLevelTags.map((t) => ({ tag: toRow(t), accessories: (accessoriesByParent.get(t.id) ?? []).map(toRow) }));

  const isIso = document.docType === "iso";
  let pllOptions: IsoDocContext["pllOptions"] = [];
  let specOptions: IsoDocContext["specOptions"] = [];
  let pidOptions: IsoDocContext["pidOptions"] = [];
  let gaOptions: IsoDocContext["gaOptions"] = [];
  let isoFindings: IsoDocContext["isoFindings"] = [];
  let docNameById: IsoDocContext["docNameById"] = new Map();
  // One entry per ISO line: its design-basis comparison against the PLL
  // (or null when the line isn't in the PLL / no PLL is uploaded yet).
  let designBasis: Array<{ lineNumber: string; pllDocName: string | null; rows: DesignBasisRow[] | null }> = [];
  // BOM grouped by the class that governs each item, one block per SHEET --
  // a multi-sheet drawing carries a separate BOM per sheet and a spec break
  // ("MATL <class>" callouts either side of a joint) applies to the sheet
  // that draws it, so QC is done sheet by sheet.
  let bomBySpec: Array<{
    lineNumber: string;
    sheetLabel: string;
    page: number | null;
    breaks: Array<{ spec_class: string; rating?: string | number | null; location_note?: string }>;
    groups: Array<{
      specClass: string;
      items: Array<{ id: number; itemNo: string; description: string; itemCode: string; qty: string; basis: string }>;
    }>;
  }> = [];
  // Counts only -- the Pipe spools / Weld list detail lives on the
  // dedicated "Spooling" page (buildSpoolingView), and Routing & fittings /
  // Valve match on the dedicated "Valve match" page (loadRoutingAndValveMatch).
  let spoolCount = 0;
  let weldCount = 0;

  if (isIso) {
    ({ pllOptions, specOptions, pidOptions, gaOptions, docNameById, isoFindings } = await loadIsoDocContext(projectId, document));

    spoolCount = tags.filter((t) => t.tagType === "spool").length;
    weldCount = tags.filter((t) => t.tagType === "weld").length;

    // Design-basis comparison, ISO title block vs the PLL row for the same
    // line number -- rendered for every ISO line whether or not Verify has
    // been run, so the side-by-side view is always current.
    const isoLineTagsAll = tags.filter((t) => t.tagType === "line");
    // One line tag per sheet on a multi-sheet drawing -- collapse to one per
    // line so the comparison tables aren't repeated per sheet. The merge takes
    // the run's start from the first sheet and its end from the last (see
    // mergeIsoLineSheets); per-sheet tags stay available via sourcePage.
    const isoLineTags = mergeIsoLineSheets(isoLineTagsAll);
    if (pllOptions.length > 0 && isoLineTags.length > 0) {
      const pllTags = await db
        .select()
        .from(extractedTags)
        .where(and(inArray(extractedTags.documentId, pllOptions.map((d) => d.id)), eq(extractedTags.tagType, "line")));
      const pllByNorm = new Map(pllTags.map((t) => [t.tagNumberNormalized, t] as const));

      designBasis = isoLineTags.map((line) => {
        const pll = pllByNorm.get(normalizeTagNumber(line.tagNumber));
        // Same enrichment the gate chain applies: title-block blanks and
        // "XX.XX" placeholders are filled from the line-number decode.
        const isoAttrs = enrichIsoLineAttrs(line.tagNumber, line.attributes as Record<string, unknown>);
        return {
          lineNumber: line.tagNumber,
          pllDocName: pll ? docNameById.get(pll.documentId) ?? null : null,
          rows: pll ? buildDesignBasisComparison(isoAttrs, pll.attributes as Record<string, unknown>) : null,
        };
      });
    }

    // One block per sheet, in sheet order -- including sheets with no break,
    // whose rows all sit under the title-block class. Only the "Unassigned"
    // group means the drawing didn't show which side a row is on.
    bomBySpec = [...isoLineTagsAll]
      .sort((a, b) => (a.sourcePage ?? 0) - (b.sourcePage ?? 0))
      .map((line) => {
        const lineAttrs = line.attributes as Record<string, unknown>;
        const breaks = (Array.isArray(lineAttrs.spec_breaks) ? lineAttrs.spec_breaks : []) as Array<{
          spec_class: string;
          rating?: string | number | null;
          location_note?: string;
        }>;
        const lineClass = typeof lineAttrs.spec_class === "string" ? lineAttrs.spec_class : "";

        const norm = normalizeTagNumber(line.tagNumber);
        const items = tags.filter((t) => {
          if (t.tagType !== "bom_item") return false;
          // Scope to this sheet so each sheet's BOM is reviewed on its own.
          if (line.sourcePage != null && t.sourcePage !== line.sourcePage) return false;
          const ln = (t.attributes as Record<string, unknown>).line_number;
          return typeof ln === "string" && normalizeTagNumber(ln) === norm;
        });
        if (items.length === 0) return null;

        const byClass = new Map<string, Array<{ id: number; itemNo: string; description: string; itemCode: string; qty: string; basis: string }>>();
        for (const item of items) {
          const a = item.attributes as Record<string, unknown>;
          // With no break on this sheet the title-block class governs every
          // row, so an unset class there is not an open question.
          const own =
            typeof a.item_spec_class === "string" && a.item_spec_class.trim()
              ? a.item_spec_class
              : breaks.length < 2 && lineClass
                ? lineClass
                : "Unassigned";
          const list = byClass.get(own) ?? [];
          list.push({
            id: item.id,
            itemNo: item.tagNumber,
            description: String(a.description ?? ""),
            itemCode: String(a.item_code ?? "-"),
            qty: String(a.quantity ?? "-"),
            basis: typeof a.item_spec_basis === "string" ? a.item_spec_basis : breaks.length < 2 ? "sheet has no spec break" : "",
          });
          byClass.set(own, list);
        }
        const order = [...(breaks.length > 1 ? breaks.map((b) => b.spec_class) : [lineClass]), "Unassigned"];
        const groups = [...byClass.entries()]
          .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
          .map(([specClass, groupItems]) => ({ specClass, items: groupItems.sort((x, y) => Number(x.itemNo) - Number(y.itemNo)) }));
        const sheetLabel = typeof lineAttrs.sheet === "string" && lineAttrs.sheet ? lineAttrs.sheet : line.sourcePage != null ? `page ${line.sourcePage}` : "";
        return { lineNumber: line.tagNumber, sheetLabel, page: line.sourcePage, breaks, groups };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);
  }

  // Admin cross-check: this doc's own extracted piping classes vs a
  // sibling .xlsx item-list/catalogue export (the client's own material
  // take-off, uploaded as another "spec_sheet" document) -- see
  // apps/web/src/lib/verifySpecCrossCheck.ts's crossCheckItem for the
  // actual per-row verdict logic.
  const isSpecSheet = document.docType === "spec_sheet";
  const specClassTags = tags.filter((t) => t.tagType === "spec_class");
  let adminOptions: (typeof documents.$inferSelect)[] = [];
  let adminCrossCheckResults: Array<{ item: SheetItem; result: CrossCheckResult }> = [];
  if (isSpecSheet) {
    const specSiblings = await db
      .select()
      .from(documents)
      .where(eq(documents.projectId, projectId));
    adminOptions = specSiblings.filter((d) => d.id !== docId && d.docType === "spec_sheet" && d.fileName.toLowerCase().endsWith(".xlsx"));

    if (adminDocId) {
      const clientClassesByCode = new Map<string, Record<string, unknown>>();
      for (const t of tags) {
        if (t.tagType !== "spec_class") continue;
        clientClassesByCode.set(normalizeSpecClassCode(t.tagNumber), t.attributes as Record<string, unknown>);
      }

      const adminPages = await db.select().from(documentPages).where(eq(documentPages.documentId, adminDocId)).orderBy(asc(documentPages.pageNumber));
      const adminItemRows: SheetItem[] = [];
      for (const p of adminPages) adminItemRows.push(...extractSheetItems(p.pageText));

      adminCrossCheckResults = adminItemRows.map((item) => ({ item, result: crossCheckItem(item, clientClassesByCode) }));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/projects/${projectId}`} className="text-sm text-blue-600 underline">
          &larr; Back to project
        </Link>
        <h1 className="text-xl font-semibold">{document.fileName}</h1>
        <p className="text-sm text-gray-500">
          {DOC_TYPE_LABELS[document.docType] ?? document.docType} &middot; {document.pageCount ?? "?"} pages
        </p>
      </div>

      {isIso && (
        <section className="rounded border p-4">
          <h2 className="mb-2 font-medium">Verify ISO</h2>
          <p className="mb-3 text-sm text-gray-500">
            Gate-ordered check chain: 0 title block &rarr; 1 line exists in PLL (fail = stop) &rarr; 2 design basis vs PLL (class
            mismatch = stop) &rarr; 3 P&amp;ID &rarr; 4 specs &rarr; 6 supports &rarr; 7 BOM item codes &rarr; 8 GA routing. Gate 5
            (geometry/drafting) needs drawing geometry the extraction doesn&apos;t capture and is not checked.
          </p>
          <form action={verifyIsoAction.bind(null, docId)} className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              Line list (PLL)
              <select name="pllDocumentId" className="mt-1 block rounded border px-3 py-2">
                <option value="">None</option>
                {pllOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.fileName}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Spec sheet
              <select name="specDocumentId" className="mt-1 block rounded border px-3 py-2">
                <option value="">None</option>
                {specOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.fileName}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              P&amp;ID (ctrl/cmd-click to select more than one -- a line can span several sheets)
              <select name="pidDocumentIds" multiple size={Math.min(4, Math.max(2, pidOptions.length))} className="mt-1 block w-56 rounded border px-3 py-2">
                {pidOptions.length === 0 && (
                  <option value="" disabled>
                    None uploaded
                  </option>
                )}
                {pidOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.fileName}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              GA
              <select name="gaDocumentId" className="mt-1 block rounded border px-3 py-2">
                <option value="">None</option>
                {gaOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.fileName}
                  </option>
                ))}
              </select>
            </label>
            <button className="rounded bg-black px-4 py-2 text-white">Verify</button>
          </form>

          <h3 className="mb-2 mt-4 font-medium">Design basis: ISO vs PLL</h3>
          {designBasis.length === 0 && <p className="mb-4 text-sm text-gray-500">No PLL uploaded/extracted in this project yet.</p>}
          {designBasis.map(({ lineNumber, pllDocName, rows }) => (
            <div key={lineNumber} className="mb-4">
              <p className="mb-1 text-sm">
                Line <span className="font-mono">{lineNumber}</span>{" "}
                {rows ? <span className="text-gray-500">vs {pllDocName ?? "PLL"}</span> : <span className="text-red-600">-- not found in the PLL</span>}
              </p>
              {rows && (
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="py-1">Field</th>
                      <th>ISO</th>
                      <th>PLL</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.field} className="border-b">
                        <td className="py-1">{row.field}</td>
                        <td>{row.isoValue ?? "-"}</td>
                        <td>{row.pllValue ?? "-"}</td>
                        <td className={row.status === "match" ? "text-green-600" : row.status === "mismatch" ? "text-red-600" : "text-gray-400"}>
                          {row.status}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}

          <div className="mb-4 flex flex-wrap gap-3">
            <Link
              href={`/projects/${projectId}/documents/${docId}/valves`}
              className="rounded border px-3 py-2 text-sm text-blue-600 underline hover:bg-gray-50"
            >
              Valve match &amp; routing/fittings &rarr;
            </Link>
            <Link
              href={`/projects/${projectId}/documents/${docId}/spooling`}
              className="rounded border px-3 py-2 text-sm text-blue-600 underline hover:bg-gray-50"
            >
              Spooling ({spoolCount} spools, {weldCount} welds) &rarr;
            </Link>
          </div>

          {bomBySpec.length > 0 && (
            <>
              <h3 className="mb-2 mt-4 font-medium">BOM by spec, per sheet</h3>
              {bomBySpec.map(({ lineNumber, sheetLabel, page, breaks, groups }) => (
                <div key={`${lineNumber}-${page ?? sheetLabel}`} className="mb-6 rounded border p-3">
                  <p className="mb-1 text-sm font-medium">
                    Sheet {sheetLabel || "?"} <span className="font-normal text-gray-500">&middot; line</span>{" "}
                    <span className="font-mono font-normal">{lineNumber}</span>
                  </p>
                  <p className="mb-2 text-xs text-gray-500">
                    {breaks.length > 1 ? (
                      <>Spec break: {breaks.map((b) => `${b.spec_class}${b.rating ? ` (${b.rating}#)` : ""}`).join(" → ")}</>
                    ) : (
                      <>No spec break on this sheet -- the whole sheet is the title-block class.</>
                    )}
                  </p>
                  {breaks.length > 1 && breaks.some((b) => b.location_note) && (
                    <ul className="mb-2 list-disc pl-5 text-xs text-gray-500">
                      {breaks
                        .filter((b) => b.location_note)
                        .map((b) => (
                          <li key={b.spec_class}>
                            {b.spec_class}: {b.location_note}
                          </li>
                        ))}
                    </ul>
                  )}
                  {groups.map(({ specClass, items }) => (
                    <div key={specClass} className="mb-3">
                      <p className={`text-sm font-medium ${specClass === "Unassigned" ? "text-amber-600" : ""}`}>
                        {specClass} <span className="font-normal text-gray-500">({items.length} item{items.length > 1 ? "s" : ""})</span>
                        {specClass === "Unassigned" && (
                          <span className="ml-2 font-normal text-xs text-amber-600">
                            -- the drawing doesn&apos;t show which side of the break these sit on; confirm against the isometric
                          </span>
                        )}
                      </p>
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="border-b">
                            <th className="py-1 w-12">Item</th>
                            <th>Description</th>
                            <th className="w-32">Item code</th>
                            <th className="w-16">Qty</th>
                            <th className="w-40">Basis</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((item) => (
                            <tr key={item.id} className="border-b">
                              <td className="py-1">{item.itemNo}</td>
                              <td>{item.description}</td>
                              <td className="font-mono text-xs">{item.itemCode}</td>
                              <td>{item.qty}</td>
                              <td className="text-xs text-gray-500">{item.basis || "-"}</td>
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

          <h3 className="mb-2 mt-4 font-medium">Findings ({isoFindings.length})</h3>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="py-2">Gate</th>
                <th>Severity</th>
                <th>Tag</th>
                <th>Field</th>
                <th>ISO value</th>
                <th>Compared to</th>
                <th>Other value</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {[...isoFindings]
                .sort((a, b) => a.fieldChecked.localeCompare(b.fieldChecked))
                .map((finding) => {
                  const [gate, ...fieldParts] = finding.fieldChecked.split(".");
                  const field = fieldParts.join(".") || finding.fieldChecked;
                  return (
                    <tr key={finding.id} className="border-b align-top">
                      <td className="py-2">{GATE_LABELS[gate] ?? gate}</td>
                      <td>{finding.severity}</td>
                      <td>{finding.tagNumber}</td>
                      <td>{field}</td>
                      <td>{finding.valueA ?? "-"}</td>
                      <td>{finding.docBId ? docNameById.get(finding.docBId) ?? finding.docBId : "-"}</td>
                      <td>{finding.valueB ?? "-"}</td>
                      <td>{finding.notes ?? "-"}</td>
                    </tr>
                  );
                })}
              {isoFindings.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-4 text-gray-500">
                    No findings yet -- run Verify above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      {isSpecSheet && result && (
        <section className="rounded border p-4">
          <h2 className="mb-2 font-medium">Admin cross-check</h2>
          <p className="mb-3 text-sm text-gray-500">
            Check a client&apos;s own item-list/catalogue Excel export (&quot;Admin&quot;) against the piping classes
            extracted from this spec sheet -- does every admin row correspond to a requirement that actually exists in
            the client spec.
          </p>

          {specClassTags.length > 0 && (
            <div className="mb-4">
              <h3 className="mb-2 text-sm font-medium">Piping classes ({specClassTags.length})</h3>
              <div className="flex flex-wrap gap-2">
                {specClassTags.map((t) => (
                  <Link
                    key={t.id}
                    href={`/projects/${projectId}/documents/${docId}/classes/${encodeURIComponent(t.tagNumber)}${adminDocId ? `?adminDocId=${adminDocId}` : ""}`}
                    className="rounded border px-2 py-1 text-xs text-blue-600 underline hover:bg-gray-50"
                  >
                    {t.tagNumber}
                  </Link>
                ))}
              </div>
            </div>
          )}

          <form className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              Admin item list (.xlsx)
              <select name="adminDocId" defaultValue={adminDocId ?? ""} className="mt-1 block rounded border px-3 py-2">
                <option value="">Select a document&hellip;</option>
                {adminOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.fileName}
                  </option>
                ))}
              </select>
            </label>
            <button className="rounded bg-black px-4 py-2 text-sm text-white">Load</button>
          </form>

          {adminOptions.length === 0 && (
            <p className="mt-3 text-sm text-gray-500">
              No sibling .xlsx documents uploaded to this project yet -- upload the client&apos;s admin item list as a{" "}
              <span className="font-mono">spec_sheet</span> document to cross-check against it.
            </p>
          )}

          {adminDocId && (
            <>
              <p className="mt-3 mb-2 text-sm text-gray-500">{adminCrossCheckResults.length} admin row{adminCrossCheckResults.length === 1 ? "" : "s"} loaded.</p>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="py-1">Reference</th>
                    <th>Type</th>
                    <th>Spec code</th>
                    <th>Size</th>
                    <th>Status</th>
                    <th>Client spec</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {adminCrossCheckResults.map(({ item, result: r }, i) => {
                    const size = adminSizeDisplay(item.sizeP1);
                    return (
                      <tr key={`${item.reference}-${i}`} className="border-b align-top">
                        <td className="py-1 font-mono text-xs">{item.reference || "-"}</td>
                        <td>{item.type}</td>
                        <td className="font-mono text-xs">{item.specCode || "-"}</td>
                        <td>
                          <SizeToggle mm={size.mm} inch={size.inch} />
                        </td>
                        <td className={ADMIN_STATUS_STYLES[r.status]}>{r.label}</td>
                        <td className="text-xs text-gray-500">
                          {r.clientDescription ?? "-"}
                          {r.clientSize ? ` (${r.clientSize})` : ""}
                        </td>
                        <td className="text-xs text-gray-500">{r.note ?? "-"}</td>
                      </tr>
                    );
                  })}
                  {adminCrossCheckResults.length === 0 && (
                    <tr>
                      <td colSpan={7} className="py-4 text-gray-500">
                        No rows parsed from this document -- confirm it's an item-list/catalogue export (columns like
                        SPREF/GTYPE/Catalogue reference, or ItemCode/Material).
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}

      {!result && <p className="text-gray-500">No extraction result yet for this document.</p>}

      {result && (
        <>
          <section>
            <h2 className="mb-2 font-medium">Extracted tags ({tags.length})</h2>
            <ExtractedTagsTable groups={tagGroups} />
          </section>

          <section>
            <h2 className="mb-2 font-medium">Raw extraction result ({result.schemaVersion})</h2>
            <pre className="max-h-[600px] overflow-auto whitespace-pre-wrap rounded border p-4 text-xs">
              {JSON.stringify(result.rawJson, null, 2)}
            </pre>
          </section>
        </>
      )}
    </div>
  );
}
