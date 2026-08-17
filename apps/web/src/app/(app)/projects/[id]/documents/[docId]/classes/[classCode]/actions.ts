"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { documents, extractedTags } from "@easy/db";
import { createClient } from "@/lib/supabase/server";
import { getDb } from "@/lib/db";
import { normalizeSpecClassCode } from "@/lib/verifySpecCrossCheck";
import { revalidateSpecClassAttributes } from "@/lib/revalidateSpecClass";
import { requireProjectMembership } from "../../../../actions";

// Re-sorts this class's already-extracted pipes/fittings/flanges/valves
// into true ascending size order and recomputes its overlap/notes warnings
// from that corrected data (see revalidateSpecClass.ts) -- no Claude call,
// just re-deriving the warning banner from the same rows already stored on
// this tag. A no-op re-save when the data was already sorted and clean.
export async function recheckClassAction(documentId: string, classCode: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated.");

  const db = getDb();
  const [document] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!document) throw new Error("Document not found.");
  await requireProjectMembership(document.projectId, user.id);

  const specClassTags = await db
    .select()
    .from(extractedTags)
    .where(and(eq(extractedTags.documentId, documentId), eq(extractedTags.tagType, "spec_class")));
  const wantedCode = normalizeSpecClassCode(classCode);
  const classTag = specClassTags.find((t) => normalizeSpecClassCode(t.tagNumber) === wantedCode);
  if (!classTag) throw new Error(`Class "${classCode}" not found in this document.`);

  const { attrs } = revalidateSpecClassAttributes(classTag.attributes as Record<string, unknown>);
  await db.update(extractedTags).set({ attributes: attrs }).where(eq(extractedTags.id, classTag.id));

  revalidatePath(`/projects/${document.projectId}/documents/${documentId}/classes/${encodeURIComponent(classCode)}`);
}
