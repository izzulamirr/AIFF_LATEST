import Link from "next/link";
import { eq } from "drizzle-orm";
import { organizationMembers, organizations, projects } from "@easy/db";
import { createClient } from "@/lib/supabase/server";
import { getDb } from "@/lib/db";
import { createProject } from "../actions";

export default async function ProjectsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const db = getDb();

  const memberships = await db
    .select({ organization: organizations })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(eq(organizationMembers.userId, user.id));

  const projectRows = await db.select().from(projects);
  const projectsByOrg = memberships.map(({ organization }) => ({
    organization,
    projects: projectRows.filter((p) => p.organizationId === organization.id),
  }));

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Projects</h1>

      {projectsByOrg.map(({ organization, projects: orgProjects }) => (
        <div key={organization.id} className="flex flex-col gap-2">
          <h2 className="font-medium">{organization.name}</h2>
          <ul className="flex flex-col gap-1">
            {orgProjects.map((project) => (
              <li key={project.id}>
                <Link href={`/projects/${project.id}`} className="text-blue-600 underline">
                  {project.name}
                </Link>
              </li>
            ))}
            {orgProjects.length === 0 && <li className="text-sm text-gray-500">No projects yet.</li>}
          </ul>

          <form action={createProject} className="flex max-w-sm gap-2">
            <input type="hidden" name="organizationId" value={organization.id} />
            <input name="name" placeholder="New project name" required className="flex-1 rounded border px-3 py-2" />
            <button className="rounded bg-black px-4 py-2 text-white">Create</button>
          </form>
        </div>
      ))}

      {memberships.length === 0 && (
        <p className="text-gray-500">
          You need an organization first --{" "}
          <Link href="/dashboard" className="underline">
            create one on the dashboard
          </Link>
          .
        </p>
      )}
    </div>
  );
}
