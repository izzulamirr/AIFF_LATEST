import postgres from "postgres";
import fs from "node:fs";

const envText = fs.readFileSync(new URL("../../apps/worker/.env", import.meta.url), "utf8");
const env = {};
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const sql = postgres(env.DATABASE_URL, { prepare: false });

const [res] = await sql`select * from extraction_results where extraction_job_id = 'f02db772-407b-4fc9-9a5e-b1ae503f54a4' limit 1`;
if (res && res.raw_json) {
  const raw = res.raw_json;
  const sheets = raw.sheets ?? [];
  console.log("num sheets in rawJson:", sheets.length);
  for (const s of sheets) {
    console.log("---");
    console.log("drawing/line:", s.result?.line_number, "sheet:", s.result?.sheet);
    console.log("spools count:", s.result?.spools?.length ?? 'MISSING KEY');
    console.log("welds count:", s.result?.welds?.length ?? 'MISSING KEY');
    console.log("route_points count:", s.result?.route_points?.length ?? 'MISSING KEY');
    console.log("dimensions count:", s.result?.dimensions?.length ?? 'MISSING KEY');
    console.log("bom_items count:", s.result?.bom_items?.length ?? 'MISSING KEY');
    if (s.result?.spools) console.log("spool_nos:", s.result.spools.map(x => x.spool_no));
  }
} else {
  console.log("no raw_json found:", res);
}

await sql.end();
