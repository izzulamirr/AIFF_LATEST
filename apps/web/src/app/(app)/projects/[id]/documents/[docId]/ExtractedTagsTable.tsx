"use client";

import { Fragment, useState } from "react";

export interface TagRow {
  id: number;
  tagType: string;
  tagNumber: string;
  sourcePage: number | null;
  attributes: unknown;
}

export interface TagGroup {
  tag: TagRow;
  accessories: TagRow[];
}

// Extracted-tags table with valve assemblies collapsible: each valve that
// has sub-instruments (its accessories carry parent_valve) can be expanded
// or hidden. Groups with no accessories render as a plain row. Server passes
// the grouping down pre-computed (see page.tsx) so this component only owns
// the open/closed UI state.
export function ExtractedTagsTable({ groups }: { groups: TagGroup[] }) {
  const parentIdsWithSubs = groups.filter((g) => g.accessories.length > 0).map((g) => g.tag.id);
  // Default: everything expanded (matches the previous always-shown view);
  // the user can collapse any assembly, or all of them at once.
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const toggle = (id: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const allCollapsed = parentIdsWithSubs.length > 0 && parentIdsWithSubs.every((id) => collapsed.has(id));
  const toggleAll = () => setCollapsed(allCollapsed ? new Set() : new Set(parentIdsWithSubs));

  return (
    <>
      {parentIdsWithSubs.length > 0 && (
        <button onClick={toggleAll} className="mb-2 rounded border px-2 py-1 text-xs text-gray-600 hover:bg-gray-50">
          {allCollapsed ? "Expand all assemblies" : "Collapse all assemblies"}
        </button>
      )}
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b">
            <th className="py-2">Tag type</th>
            <th>Tag number</th>
            <th>Page</th>
            <th>Attributes</th>
          </tr>
        </thead>
        <tbody>
          {groups.map(({ tag, accessories }) => {
            const hasSubs = accessories.length > 0;
            const isOpen = hasSubs && !collapsed.has(tag.id);
            return (
              <Fragment key={tag.id}>
                <tr className="border-b align-top">
                  <td className="py-2">{tag.tagType}</td>
                  <td>
                    {hasSubs ? (
                      <button onClick={() => toggle(tag.id)} className="inline-flex items-center gap-1 text-left hover:underline">
                        <span className="text-gray-500">{isOpen ? "▾" : "▸"}</span>
                        <span>{tag.tagNumber}</span>
                        <span className="ml-1 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                          {accessories.length} sub-instrument{accessories.length > 1 ? "s" : ""}
                        </span>
                      </button>
                    ) : (
                      tag.tagNumber
                    )}
                  </td>
                  <td>{tag.sourcePage ?? "-"}</td>
                  <td>
                    <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(tag.attributes, null, 2)}</pre>
                  </td>
                </tr>
                {isOpen &&
                  accessories.map((acc) => (
                    <tr key={acc.id} className="border-b align-top bg-gray-50/60">
                      <td className="py-2 pl-6 text-gray-500">&#8627; {acc.tagType}</td>
                      <td className="text-gray-700">{acc.tagNumber}</td>
                      <td>{acc.sourcePage ?? "-"}</td>
                      <td>
                        <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(acc.attributes, null, 2)}</pre>
                      </td>
                    </tr>
                  ))}
              </Fragment>
            );
          })}
          {groups.length === 0 && (
            <tr>
              <td colSpan={4} className="py-4 text-gray-500">
                No tags extracted.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
