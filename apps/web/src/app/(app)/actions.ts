"use server";

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { organizations, organizationMembers, projects } from "@easy/db";
import { createClient } from "@/lib/supabase/server";
import { getDb } from "@/lib/db";

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export async function createOrganization(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  const db = getDb();
  const [org] = await db.insert(organizations).values({ name }).returning();
  await db.insert(organizationMembers).values({ organizationId: org.id, userId: user.id, role: "owner" });

  redirect("/dashboard");
}

export async function createProject(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const organizationId = String(formData.get("organizationId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!organizationId || !name) return;

  const db = getDb();

  // Confirm membership before allowing project creation -- this is the
  // app-layer tenant check that stands in for RLS until Phase 0's RLS
  // policies are written directly in Supabase (see the architecture plan).
  const [membership] = await db
    .select()
    .from(organizationMembers)
    .where(eq(organizationMembers.organizationId, organizationId))
    .limit(1);
  if (!membership || membership.userId !== user.id) throw new Error("Not a member of this organization.");

  const [project] = await db.insert(projects).values({ organizationId, name, createdBy: user.id }).returning();

  redirect(`/projects/${project.id}`);
}
