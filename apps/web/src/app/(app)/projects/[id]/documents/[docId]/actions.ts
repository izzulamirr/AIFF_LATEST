"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { documents } from "@easy/db";
import { createClient } from "@/lib/supabase/server";
import { getDb } from "@/lib/db";
import { verifyIsoBom } from "@/lib/verifyIso";
import { requireProjectMembership } from "../../actions";

function optionalId(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function multiId(formData: FormData, key: string): string[] {
  return formData.getAll(key).filter((v): v is string => typeof v === "string" && v.length > 0);
}

export async function verifyIsoAction(isoDocumentId: string, formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated.");

  const db = getDb();
  const [isoDocument] = await db.select().from(documents).where(eq(documents.id, isoDocumentId)).limit(1);
  if (!isoDocument) throw new Error("Document not found.");
  if (isoDocument.docType !== "iso") throw new Error("Verification is only available for ISO documents.");

  await requireProjectMembership(isoDocument.projectId, user.id);

  await verifyIsoBom({
    projectId: isoDocument.projectId,
    isoDocumentId,
    pllDocumentId: optionalId(formData, "pllDocumentId"),
    specDocumentId: optionalId(formData, "specDocumentId"),
    pidDocumentIds: multiId(formData, "pidDocumentIds"),
    gaDocumentId: optionalId(formData, "gaDocumentId"),
  });

  revalidatePath(`/projects/${isoDocument.projectId}/documents/${isoDocumentId}`);
}
