import postgres from "postgres";
import fs from "node:fs";

const envText = fs.readFileSync(new URL("../../apps/worker/.env", import.meta.url), "utf8");
const env = {};
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}

const sql = postgres(env.DATABASE_URL, { prepare: false });

const projectId = "fe3ef7db-748b-4e0e-b124-1be21e3f5c42";
const docs = await sql`select id, file_name, doc_type, uploaded_at, uploaded_by from documents where project_id = ${projectId} order by uploaded_at desc`;
console.log(docs);

await sql.end();
