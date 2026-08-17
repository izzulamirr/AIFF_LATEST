"use client";

import { useState, useTransition } from "react";

// Deleting a document also destroys its extraction and any findings raised
// from it, and there is no undo, so the button asks first and names the file
// it is about to remove rather than relying on the user's aim.
export function DeleteDocumentButton({
  fileName,
  onDelete,
}: {
  fileName: string;
  onDelete: () => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <button
        type="button"
        disabled={pending}
        aria-label={`Delete ${fileName}`}
        className="rounded border border-red-600 px-2 py-1 text-xs text-red-600 hover:bg-red-600 hover:text-white disabled:opacity-50"
        onClick={() => {
          if (!window.confirm(`Delete "${fileName}"?\n\nThis also removes its extracted data and any findings raised from it. This cannot be undone.`)) {
            return;
          }
          setError(null);
          startTransition(async () => {
            try {
              await onDelete();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Delete failed.");
            }
          });
        }}
      >
        {pending ? "Deleting…" : "Delete"}
      </button>
      {error && <span className="ml-2 text-xs text-red-600">{error}</span>}
    </>
  );
}
