import postgres from "postgres";
import fs from "node:fs";

const envText = fs.readFileSync(new URL("../../apps/worker/.env", import.meta.url), "utf8");
const env = {};
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const sql = postgres(env.DATABASE_URL, { prepare: false });

const docId = "4d1c2f45-dad4-4b3b-9ff6-1d636f284f64";

const cols = await sql`select column_name from information_schema.columns where table_name = 'extracted_tags'`;
console.log("columns:", cols.map((c) => c.column_name));

const welds = await sql`select * from extracted_tags where document_id = ${docId} and tag_type = 'weld' order by source_page, tag_number`;
console.log("total welds:", welds.length);
for (const w of welds) {
  console.log(JSON.stringify(w));
}

const spools = await sql`select * from extracted_tags where document_id = ${docId} and tag_type = 'spool' order by source_page, tag_number`;
console.log("\ntotal spools:", spools.length);
for (const s of spools) {
  console.log(JSON.stringify(s).slice(0, 300));
}

await sql.end();
