import Link from "next/link";
import { and, asc, eq, inArray } from "drizzle-orm";
import { documents, documentPages, extractedTags } from "@easy/db";
import { getDb } from "@/lib/db";
import { extractSheetItems, combineAdminText, type SheetItem } from "@/lib/parseSheetPage";
import {
  normalizeSpecClassCode,
  formatNpsInches,
  dnToNpsInches,
  DN_TO_NPS_INCHES,
  groupAdminItemsByClassRow,
  findAdminItemsUnmatchedBySize,
  mergeAdjacentClassRows,
  compareAdminItemToClientRow,
  type SpecCategory,
  type MergedClassRow,
  type AdminFieldComparison,
} from "@/lib/verifySpecCrossCheck";
import { normalizeTagNumber } from "@easy/shared";
import { isoSpecClasses } from "@/lib/verifyIso";
import { crossCheckBomItem, resolveBomItemSpecClass, normalizeBomSpecClass } from "@/lib/verifyBomCrossCheck";
import { recheckClassAction } from "./actions";
import { AdminMatchesTable, type AdminMatchRow } from "./AdminMatchesTable";

const CATEGORY_CONFIG: Array<{ key: SpecCategory; label: string }> = [
  { key: "pipes", label: "Pipe" },
  { key: "fittings", label: "Fittings" },
  { key: "flanges", label: "Flanges" },
  { key: "valves", label: "Valves" },
];

const SIZING_LEGEND = Object.entries(DN_TO_NPS_INCHES)
  .map(([mm, inches]) => ({ mm: Number(mm), inches }))
  .sort((a, b) => a.mm - b.mm);

const BOM_STATUS_STYLES: Record<string, string> = {
  match: "text-green-600",
  not_found: "text-red-600",
  size_unrecognized: "text-yellow-600",
  out_of_scope: "text-gray-400",
  class_not_found: "text-red-500",
  no_client_data: "text-blue-500",
};

// STAGE 1 is a static "auto-matched by size/type, not yet human-reviewed"
// label, not a computed match/mismatch verdict -- this app's cross-check
// logic (see verifySpecCrossCheck.ts's module comment) deliberately dropped
// free-text material/description comparison as a verdict driver because it
// produced false failures unrelated to real spec discrepancies, so this
// view doesn't reintroduce that here either. The per-field table (see
// AdminMatchesTable) is a separate, purely visual reviewer aid -- it never
// changes the Status column's own verdict. All comparison happens HERE,
// server-side; AdminMatchesTable only filters/renders the already-resolved
// rows it's given (see that file's own comment).
function AdminMatchesCell({
  items,
  adminSelected,
  category,
  clientFields,
}: {
  items: SheetItem[];
  adminSelected: boolean;
  category: SpecCategory;
  clientFields: MergedClassRow;
}) {
  if (!adminSelected) return <span className="text-xs text-gray-400">Select an admin item list above.</span>;
  if (items.length === 0) return <span className="text-xs text-gray-400">-</span>;

  const rows: AdminMatchRow[] = items.map((item) => {
    const inches = dnToNpsInches(item.sizeP1);
    const adminSize = { mm: item.sizeP1 ? `${item.sizeP1} mm` : "-", inch: inches == null ? "" : formatNpsInches(inches) };
    const fields = compareAdminItemToClientRow(item, category, clientFields, adminSize);
    return {
      reference: item.reference,
      fields,
      description: combineAdminText(item),
      hasMismatch: fields.some((f) => f.verdict === "differs"),
    };
  });
  const mismatchCount = rows.filter((r) => r.hasMismatch).length;

  return (
    <details>
      <summary className="cursor-pointer text-xs text-amber-700">
        <span className="inline-block max-w-[26rem] truncate align-bottom">
          &#9888; {rows[0].description}{" "}
          <span className="text-gray-400">
            ({items.length} admin line{items.length === 1 ? "" : "s"}
            {mismatchCount > 0 ? `, ${mismatchCount} mismatch${mismatchCount === 1 ? "" : "es"}` : ""})
          </span>
        </span>
      </summary>
      <AdminMatchesTable rows={rows} />
    </details>
  );
}

// Admin lines whose type genuinely matches something in this class/category
// but whose OWN size falls outside every declared band's range (see
// findAdminItemsUnmatchedBySize) -- these never land in adminGroups at all,
// so without a dedicated row they were invisible. Rendered as one extra row
// PER TYPE (not one per whole category -- confirmed on a real class where
// lumping every unmatched flange line together mixed unrelated types like
// Spectacle blind and Gasket into one undifferentiated block under a
// misleading single heading), directly below that category's normal size
// bands, reusing AdminMatchesTable's own All/Mismatches/OK filter so this
// still reads as "one more row", not a separate page section. Every line is
// flagged a Size mismatch (there's no single client row to compare
// Schedule/End Type/Standard against, so those stay "unknown" rather than
// guessing one).
function UnmatchedBySizeRow({ typeLabel, items }: { typeLabel: string; items: SheetItem[] }) {
  if (items.length === 0) return null;

  const rows: AdminMatchRow[] = items.map((item) => {
    const inches = dnToNpsInches(item.sizeP1);
    const adminSize = item.sizeP1 ? `${inches == null ? "" : `${formatNpsInches(inches)}" `}(${item.sizeP1} mm)` : "-";
    const fields: AdminFieldComparison[] = [
      { field: "Size", adminValue: adminSize, clientValue: `not covered by any "${typeLabel}" row`, verdict: "differs" },
      { field: "Schedule / Class", adminValue: "-", clientValue: "-", verdict: "unknown" },
      { field: "End Type", adminValue: "-", clientValue: "-", verdict: "unknown" },
      { field: "Standard", adminValue: "-", clientValue: "-", verdict: "unknown" },
    ];
    return { reference: item.reference, fields, description: combineAdminText(item), hasMismatch: true };
  });

  return (
    <tr className="border-b align-top bg-red-50/40">
      <td className="py-1 pl-3 text-gray-500" colSpan={5}>
        {typeLabel} -- unmatched by size
      </td>
      <td className="border-l pl-3 text-red-600">Size mismatch</td>
      <td>
        <details>
          <summary className="cursor-pointer text-xs text-red-700">
            <span className="inline-block max-w-[26rem] truncate align-bottom">
              &#9888; {rows[0].description}{" "}
              <span className="text-gray-400">
                ({items.length} admin line{items.length === 1 ? "" : "s"}, {items.length} mismatch{items.length === 1 ? "" : "es"})
              </span>
            </span>
          </summary>
          <AdminMatchesTable rows={rows} />
        </details>
      </td>
    </tr>
  );
}

// A merged band collapses several of a category's own source rows (see
// mergeAdjacentClassRows) into one displayed row -- its admin matches are
// the union of every source row's own matches, deduped by reference (an
// admin item can only land on more than one source row when its own size
// range genuinely spans several of them, e.g. a combined "8-12" column).
function collectMatches(groups: Map<string, SheetItem[]>, category: SpecCategory, rowIndices: number[]): SheetItem[] {
  const seen = new Set<SheetItem>();
  const out: SheetItem[] = [];
  for (const index of rowIndices) {
    for (const item of groups.get(`${category}:${index}`) ?? []) {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

export default async function ClassDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; docId: string; classCode: string }>;
  searchParams: Promise<{ adminDocId?: string; isoDocId?: string; bomSpec?: string }>;
}) {
  const { id: projectId, docId, classCode } = await params;
  const { adminDocId, isoDocId, bomSpec } = await searchParams;
  const db = getDb();

  const [document] = await db.select().from(documents).where(eq(documents.id, docId)).limit(1);
  if (!document || document.projectId !== projectId) return <p>Document not found.</p>;
  if (document.docType !== "spec_sheet") return <p>Not a spec sheet document.</p>;

  const specClassTags = await db
    .select()
    .from(extractedTags)
    .where(and(eq(extractedTags.documentId, docId), eq(extractedTags.tagType, "spec_class")));
  const wantedCode = normalizeSpecClassCode(classCode);
  const classTag = specClassTags.find((t) => normalizeSpecClassCode(t.tagNumber) === wantedCode);
  if (!classTag) return <p>Class &quot;{classCode}&quot; not found in this document.</p>;

  const attrs = classTag.attributes as Record<string, unknown>;

  const siblings = await db.select().from(documents).where(eq(documents.projectId, projectId));
  const adminOptions = siblings.filter((d) => d.id !== docId && d.docType === "spec_sheet" && d.fileName.toLowerCase().endsWith(".xlsx"));

  let adminItems: SheetItem[] = [];
  if (adminDocId) {
    const adminPages = await db.select().from(documentPages).where(eq(documentPages.documentId, adminDocId)).orderBy(asc(documentPages.pageNumber));
    for (const p of adminPages) adminItems.push(...extractSheetItems(p.pageText));
  }
  const adminGroups = adminDocId ? groupAdminItemsByClassRow(classTag.tagNumber, attrs, adminItems) : new Map<string, SheetItem[]>();
  const unmatchedBySize = adminDocId ? findAdminItemsUnmatchedBySize(classTag.tagNumber, attrs, adminItems) : [];

  // BOM cross-check ("Stage 2"): an ISO drawing's own Bill of Material vs
  // this same class's client spec -- and, when the selected spec matches
  // THIS page's own class, the SAME admin-confirmed rows adminGroups above
  // already resolved. See verifyBomCrossCheck.ts's module comment for why
  // classification reads free text rather than trusting component_type
  // alone, and CategoryHint's own comment (verifySpecCrossCheck.ts) for why
  // it reuses that exact matching logic instead of re-solving the same
  // Tee/Reducer, Blind/Spectacle, Flange/Orifice collisions a second time.
  interface BomRow {
    itemNo: string;
    componentType: string;
    size: string;
    quantity: string;
    description: string;
    result: ReturnType<typeof crossCheckBomItem>;
    // The actual matched admin item lines (not just whether any exist) --
    // shown as their own real text (RTEXT+XTEXT, see combineAdminText) so a
    // reviewer sees WHAT confirmed the BOM line, not just a bare yes/no.
    adminMatches: SheetItem[] | null;
  }
  // One block per ISO SHEET, same "divide by sheet" pattern the ISO
  // document's own page already uses for its "BOM by spec, per sheet"
  // view (see docId/page.tsx's bomBySpec) -- a multi-sheet drawing carries
  // a separate BOM per sheet, so cross-checking them lumped together as one
  // flat list hid which sheet a mismatch was actually on.
  interface BomSheetGroup {
    lineNumber: string;
    sheetLabel: string;
    page: number | null;
    rows: BomRow[];
  }
  const isoOptions = siblings.filter((d) => d.docType === "iso");
  let bomAvailableSpecs: string[] = [];
  let selectedBomSpec: string | null = null;
  let bomBySheet: BomSheetGroup[] = [];
  if (isoDocId) {
    const isoLineTags = await db.select().from(extractedTags).where(and(eq(extractedTags.documentId, isoDocId), eq(extractedTags.tagType, "line")));
    const isoBomTags = await db.select().from(extractedTags).where(and(eq(extractedTags.documentId, isoDocId), eq(extractedTags.tagType, "bom_item")));

    // A single BOM can carry 2-3 different classes (a spec break along the
    // run) -- collect every class ANY of this ISO's lines reference, not
    // just the title-block one, so the selector covers all of them.
    const specSet = new Set<string>();
    for (const line of isoLineTags) for (const cls of isoSpecClasses(line.attributes as Record<string, unknown>)) specSet.add(cls);
    bomAvailableSpecs = [...specSet];

    selectedBomSpec =
      bomSpec && bomAvailableSpecs.includes(bomSpec)
        ? bomSpec
        : (bomAvailableSpecs.find((s) => normalizeBomSpecClass(s) === wantedCode) ?? bomAvailableSpecs[0] ?? null);

    if (selectedBomSpec) {
      const normalizedSelected = normalizeBomSpecClass(selectedBomSpec);

      // A multi-spec BOM can reference a class defined in a DIFFERENT
      // spec_sheet document than this page's own (e.g. this page is
      // AC03N1's document, but the BOM's spec break also touches BC70N,
      // extracted from a sibling document) -- resolved project-wide, only
      // when actually needed, rather than assuming it's always this page's
      // own class.
      let clientClass: Record<string, unknown> | undefined;
      if (normalizedSelected === wantedCode) {
        clientClass = attrs;
      } else {
        const allSpecClassTags = await db
          .select()
          .from(extractedTags)
          .where(and(inArray(extractedTags.documentId, siblings.map((d) => d.id)), eq(extractedTags.tagType, "spec_class")));
        clientClass = allSpecClassTags.find((t) => normalizeSpecClassCode(t.tagNumber) === normalizedSelected)?.attributes as Record<string, unknown> | undefined;
      }

      bomBySheet = [...isoLineTags]
        .sort((a, b) => (a.sourcePage ?? 0) - (b.sourcePage ?? 0))
        .map((line) => {
          const lineAttrs = line.attributes as Record<string, unknown>;
          const norm = normalizeTagNumber(line.tagNumber);

          const rows = isoBomTags
            .filter((tag) => {
              // Scope to this sheet -- a bom_item's own sourcePage is the
              // page its sheet was extracted from, same field the ISO
              // document's own per-sheet BOM view keys off of.
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
                normalizedSelected === wantedCode && adminDocId && result.matchedCategory != null && result.matchedRowIndex != null
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
        .filter((v): v is BomSheetGroup => v !== null);
    }
  }

  const headerLine = [
    attrs.service,
    attrs.material,
    attrs.asme_class ? `CL ${attrs.asme_class}${attrs.flange_facing ? ` ${attrs.flange_facing}` : ""}` : null,
    attrs.design_code,
  ]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join(" · ");
  const maxPressure = typeof attrs.max_pressure === "string" && attrs.max_pressure ? attrs.max_pressure : "-";
  const tempRange = typeof attrs.temp_range === "string" && attrs.temp_range ? attrs.temp_range : "-";
  const ends = typeof attrs.ends === "string" && attrs.ends ? attrs.ends : "-";

  const warnings = [
    ...((attrs.band_validation_issues as string[] | undefined) ?? []),
    ...((attrs.notes_validation_issues as string[] | undefined) ?? []),
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/projects/${projectId}/documents/${docId}`} className="text-sm text-blue-600 underline">
          &larr; Back to spec sheet
        </Link>
        <h1 className="text-xl font-semibold">Class Detail: {classTag.tagNumber}</h1>
        {headerLine && <p className="text-sm text-gray-600">{headerLine}</p>}
        <p className="text-sm text-gray-500">
          Max pressure: {maxPressure} &middot; Temp range: {tempRange} &middot; Ends: {ends}
        </p>
      </div>

      {warnings.length > 0 && (
        <details className="rounded border border-orange-300 bg-orange-50 p-3">
          <summary className="cursor-pointer text-sm font-medium text-orange-700">
            {warnings.length} extraction warning{warnings.length === 1 ? "" : "s"} -- re-verify against the source page
          </summary>
          <form action={recheckClassAction.bind(null, docId, classTag.tagNumber)} className="mt-2">
            <button className="rounded border border-orange-400 bg-white px-3 py-1 text-xs font-medium text-orange-700 hover:bg-orange-100">
              Recheck extracted data
            </button>
            <p className="mt-1 text-xs text-orange-700/80">
              Re-sorts pipes/fittings/flanges/valves into true ascending size order and re-runs the overlap/notes checks against that
              corrected data (no AI call -- gap checks against the source page still need a full re-extraction).
            </p>
          </form>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-orange-700">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}

      <details className="rounded border p-3">
        <summary className="cursor-pointer text-sm font-medium">Sizing legend (NPS &harr; DN)</summary>
        <table className="mt-2 w-full max-w-xs text-left text-sm">
          <thead>
            <tr className="border-b">
              <th className="py-1">NPS (in)</th>
              <th>DN (mm)</th>
            </tr>
          </thead>
          <tbody>
            {SIZING_LEGEND.map(({ mm, inches }) => (
              <tr key={mm} className="border-b">
                <td className="py-0.5">{formatNpsInches(inches)}&quot;</td>
                <td>{mm}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <section className="rounded border p-4">
        <h2 className="mb-2 font-medium">Stage 1: Admin cross-check</h2>
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
          <input type="hidden" name="isoDocId" value={isoDocId ?? ""} />
          <input type="hidden" name="bomSpec" value={bomSpec ?? ""} />
          <button className="rounded bg-black px-4 py-2 text-sm text-white">Load</button>
        </form>
        {adminOptions.length === 0 && <p className="mt-3 text-sm text-gray-500">No sibling .xlsx documents uploaded to this project yet.</p>}
      </section>

      <section className="rounded border p-4">
        <h2 className="mb-2 font-medium">Stage 2: BOM cross-check</h2>
        <p className="mb-3 text-sm text-gray-500">
          Check an ISO drawing&apos;s own Bill of Material against this class&apos;s client spec -- and, for this page&apos;s own class, the
          same admin-confirmed rows Stage 1 above already resolved.
        </p>
        <form className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            ISO drawing (.pdf)
            <select name="isoDocId" defaultValue={isoDocId ?? ""} className="mt-1 block rounded border px-3 py-2">
              <option value="">Select a document&hellip;</option>
              {isoOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.fileName}
                </option>
              ))}
            </select>
          </label>
          <input type="hidden" name="adminDocId" value={adminDocId ?? ""} />
          <button className="rounded bg-black px-4 py-2 text-sm text-white">Load</button>
        </form>
        {isoOptions.length === 0 && <p className="mt-3 text-sm text-gray-500">No ISO drawings uploaded to this project yet.</p>}

        {isoDocId && bomAvailableSpecs.length === 0 && (
          <p className="mt-3 text-sm text-gray-500">This drawing has no line/BOM data extracted.</p>
        )}

        {isoDocId && bomAvailableSpecs.length > 0 && (
          <>
            {bomAvailableSpecs.length > 1 && (
              <p className="mt-3 text-xs text-amber-700">
                &#9888; This drawing&apos;s BOM spans {bomAvailableSpecs.length} classes (a spec break along the run) -- pick which one to
                cross-check below.
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              {bomAvailableSpecs.map((spec) => (
                <Link
                  key={spec}
                  href={`?adminDocId=${encodeURIComponent(adminDocId ?? "")}&isoDocId=${encodeURIComponent(isoDocId)}&bomSpec=${encodeURIComponent(spec)}`}
                  className={`rounded border px-2 py-1 text-xs ${
                    spec === selectedBomSpec ? "border-black bg-black text-white" : "text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {spec}
                  {normalizeBomSpecClass(spec) === wantedCode ? " (this class)" : ""}
                </Link>
              ))}
            </div>

            {normalizeBomSpecClass(selectedBomSpec ?? "") !== wantedCode && (
              <p className="mt-2 text-xs text-blue-600">
                Cross-checking against class &quot;{selectedBomSpec}&quot;&apos;s own client spec. Admin-confirmed detail isn&apos;t shown
                here -- open that class&apos;s own page and load an admin document to see it.
              </p>
            )}

            {bomBySheet.length === 0 && (
              <p className="mt-3 text-sm text-gray-500">No BOM items resolved to spec &quot;{selectedBomSpec}&quot; on this drawing.</p>
            )}

            {bomBySheet.map(({ lineNumber, sheetLabel, page, rows }) => (
              <div key={`${lineNumber}-${page ?? sheetLabel}`} className="mt-3 rounded border p-3">
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
          </>
        )}
      </section>

      {CATEGORY_CONFIG.map(({ key, label }) => {
        const rows = (attrs[key] as Array<Record<string, unknown>> | undefined) ?? [];
        if (rows.length === 0) return null;
        const bands = mergeAdjacentClassRows(key, rows);
        return (
          <section key={key}>
            <h2 className="mb-2 font-medium">
              {label} ({bands.length})
            </h2>
            <div className="overflow-x-auto rounded border">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b bg-gray-50 text-xs uppercase text-gray-500">
                    <th className="py-2 pl-3" colSpan={5}>
                      Piping specification (client)
                    </th>
                    <th className="border-l pl-3" colSpan={2}>
                      Piping specification (admin)
                    </th>
                  </tr>
                  <tr className="border-b text-xs text-gray-500">
                    <th className="py-1 pl-3">Type</th>
                    <th>End Type</th>
                    <th>Class Rating / Schedule</th>
                    <th>Size</th>
                    <th>Description</th>
                    <th className="border-l pl-3">Status</th>
                    <th>Admin Matches</th>
                  </tr>
                </thead>
                <tbody>
                  {bands.map((band, i) => {
                    const matches = collectMatches(adminGroups, key, band.rowIndices);
                    return (
                      <tr key={i} className="border-b align-top">
                        <td className="py-1 pl-3">{band.type}</td>
                        <td>{band.endType}</td>
                        <td>{band.classRating}</td>
                        <td>{band.size}</td>
                        <td className="text-gray-600">{band.description}</td>
                        <td className="border-l pl-3">
                          {!adminDocId ? (
                            <span className="text-gray-400">-</span>
                          ) : matches.length === 0 ? (
                            <span className="text-gray-400">No admin match</span>
                          ) : (
                            <span className="text-orange-600">Review</span>
                          )}
                        </td>
                        <td>
                          <AdminMatchesCell items={matches} adminSelected={Boolean(adminDocId)} category={key} clientFields={band} />
                        </td>
                      </tr>
                    );
                  })}
                  {unmatchedBySize
                    .filter((g) => g.category === key)
                    .sort((a, b) => a.typeLabel.localeCompare(b.typeLabel))
                    .map((g) => (
                      <UnmatchedBySizeRow key={g.typeLabel} typeLabel={g.typeLabel} items={g.items} />
                    ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
