import postgres from "postgres";
import fs from "node:fs";

const envText = fs.readFileSync(new URL("../../apps/worker/.env", import.meta.url), "utf8");
const env = {};
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const sql = postgres(env.DATABASE_URL, { prepare: false });

const jobs = await sql`select id, document_id, status, created_at from extraction_jobs order by created_at desc limit 5`;
console.log("recent jobs:", jobs);

for (const j of jobs.slice(0, 3)) {
  const [doc] = await sql`select file_name, doc_type, page_count from documents where id = ${j.document_id}`;
  console.log(`\njob ${j.id} -> ${doc?.file_name} (${doc?.doc_type}), status=${j.status}, created=${j.created_at}`);
  const counts = await sql`select tag_type, count(*), array_agg(distinct source_page order by source_page) as pages from extracted_tags where document_id = ${j.document_id} group by tag_type`;
  console.log(counts);
}

await sql.end();
