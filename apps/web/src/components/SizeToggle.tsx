"use client";

import { useState } from "react";

// Both display strings are computed server-side (page.tsx already has the
// mm->inch lookup table) and passed in as plain props -- this component
// only ever toggles between two pre-formatted strings, it never imports the
// conversion logic itself, so it stays a small, dependency-free client
// bundle instead of pulling in @easy/shared's Node-only PDF modules.
export function SizeToggle({ mm, inch }: { mm: string; inch: string }) {
  const [showInch, setShowInch] = useState(false);
  if (!mm && !inch) return <span>-</span>;
  if (!inch) return <span>{mm}</span>; // nothing to toggle to -- a non-standard mm value, shown as-is

  return (
    <button
      type="button"
      onClick={() => setShowInch((v) => !v)}
      title="Click to switch between mm and inch"
      className="cursor-pointer text-left underline decoration-dotted underline-offset-2 hover:decoration-solid"
    >
      {showInch ? `${inch}"` : `${mm} mm`}
    </button>
  );
}
