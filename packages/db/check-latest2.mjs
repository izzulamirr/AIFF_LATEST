import postgres from "postgres";
import fs from "node:fs";

const envText = fs.readFileSync(new URL("../../apps/worker/.env", import.meta.url), "utf8");
const env = {};
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const sql = postgres(env.DATABASE_URL, { prepare: false });

const jobs = await sql`select id, document_id, status, created_at from extraction_jobs order by created_at desc limit 3`;
console.log("recent jobs:", jobs);

const j = jobs[0];
const [doc] = await sql`select file_name, doc_type from documents where id = ${j.document_id}`;
console.log(`\nlatest job ${j.id} -> ${doc?.file_name}, status=${j.status}, created=${j.created_at}`);
const counts = await sql`select tag_type, count(*), array_agg(distinct source_page order by source_page) as pages from extracted_tags where document_id = ${j.document_id} group by tag_type`;
console.log(counts);

const [res] = await sql`select raw_json from extraction_results where extraction_job_id = ${j.id} limit 1`;
if (res?.raw_json) {
  const sheets = res.raw_json.sheets ?? [];
  for (const s of sheets) {
    console.log("---");
    console.log("sheet:", s.result?.sheet);
    console.log("spools:", s.result?.spools?.length ?? 'MISSING KEY');
    console.log("welds:", s.result?.welds?.length ?? 'MISSING KEY');
    console.log("route_points:", s.result?.route_points?.length ?? 'MISSING KEY');
    console.log("dimensions:", s.result?.dimensions?.length ?? 'MISSING KEY');
    console.log("bom_items:", s.result?.bom_items?.length ?? 'MISSING KEY');
  }
}

await sql.end();
