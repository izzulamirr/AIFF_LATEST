"use client";

import { useState } from "react";
import type { AdminFieldComparison } from "@/lib/verifySpecCrossCheck";

// One admin line, pre-resolved server-side (see AdminMatchesCell in
// page.tsx -- this component only ever filters/renders what it's given, it
// never re-derives a verdict itself, same "no business logic in the client
// bundle" split SizeToggle.tsx already established for this page's other
// interactive piece).
export interface AdminMatchRow {
  reference: string;
  fields: AdminFieldComparison[];
  description: string;
  hasMismatch: boolean;
}

const FILTERS = ["all", "mismatch", "ok"] as const;
type Filter = (typeof FILTERS)[number];
const FILTER_LABELS: Record<Filter, string> = { all: "All", mismatch: "Mismatches", ok: "OK" };

function FieldVerdictBadge({ comparison }: { comparison: AdminFieldComparison }) {
  const title = `Admin: ${comparison.adminValue}  ·  Client: ${comparison.clientValue}`;
  if (comparison.verdict === "match") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-green-50 px-1.5 py-0.5 text-green-700" title={title}>
        &#10003; {comparison.adminValue}
      </span>
    );
  }
  if (comparison.verdict === "differs") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-red-50 px-1.5 py-0.5 text-red-700" title={title}>
        &#10007; {comparison.adminValue}
      </span>
    );
  }
  return (
    <span className="text-gray-400" title={title}>
      {comparison.adminValue}
    </span>
  );
}

// Lets a reviewer narrow a row's (sometimes 100+) admin lines down to just
// the ones that disagree with the client spec on at least one field, or
// just the ones that don't -- filtering client-side (not a server
// round-trip) since every row's already been resolved server-side already;
// this is purely a view over data that's already fully present.
export function AdminMatchesTable({ rows }: { rows: AdminMatchRow[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const mismatchCount = rows.filter((r) => r.hasMismatch).length;
  const counts: Record<Filter, number> = { all: rows.length, mismatch: mismatchCount, ok: rows.length - mismatchCount };
  const visible = filter === "all" ? rows : rows.filter((r) => (filter === "mismatch" ? r.hasMismatch : !r.hasMismatch));

  return (
    <div className="mt-1">
      <div className="mb-1 flex gap-1">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`rounded px-2 py-0.5 text-xs ${filter === f ? "bg-gray-700 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
          >
            {FILTER_LABELS[f]} ({counts[f]})
          </button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[42rem] text-left text-xs">
          <thead>
            <tr className="border-b text-gray-500">
              <th className="py-1 pr-2">Reference</th>
              <th className="pr-2">Size</th>
              <th className="pr-2">Material</th>
              <th className="pr-2">Schedule / Class</th>
              <th className="pr-2">End Type</th>
              <th className="pr-2">Standard</th>
              <th>Admin description</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row, i) => (
              <tr key={i} className="border-b align-top">
                <td className="py-1 pr-2 font-mono">{row.reference || "-"}</td>
                {row.fields.map((f) => (
                  <td key={f.field} className="pr-2">
                    <FieldVerdictBadge comparison={f} />
                  </td>
                ))}
                <td className="text-gray-600">{row.description}</td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} className="py-2 text-gray-400">
                  No {FILTER_LABELS[filter].toLowerCase()} lines.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
