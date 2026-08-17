import { eq } from "drizzle-orm";
import { organizationMembers, organizations } from "@easy/db";
import { createClient } from "@/lib/supabase/server";
import { getDb } from "@/lib/db";
import { createOrganization } from "../actions";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const db = getDb();
  const memberships = user
    ? await db
        .select({ organization: organizations })
        .from(organizationMembers)
        .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
        .where(eq(organizationMembers.userId, user.id))
    : [];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Your organizations</h1>

      {memberships.length === 0 && <p className="text-gray-500">You don&apos;t belong to an organization yet.</p>}
      <ul className="flex flex-col gap-2">
        {memberships.map(({ organization }) => (
          <li key={organization.id} className="rounded border p-3">
            {organization.name} <span className="text-xs text-gray-400">({organization.planTier})</span>
          </li>
        ))}
      </ul>

      <form action={createOrganization} className="flex max-w-sm gap-2">
        <input name="name" placeholder="New organization name" required className="flex-1 rounded border px-3 py-2" />
        <button className="rounded bg-black px-4 py-2 text-white">Create</button>
      </form>
    </div>
  );
}
