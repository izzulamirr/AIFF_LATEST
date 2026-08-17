import postgres from "postgres";
import fs from "node:fs";

const envText = fs.readFileSync(new URL("../../apps/worker/.env", import.meta.url), "utf8");
const env = {};
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}

const sql = postgres(env.DATABASE_URL, { prepare: false });

const isoDocId = "e4758bcf-abf1-4b10-bbe4-5e5797e8c143";
const rows = await sql`
  select id, tag_number, attributes from extracted_tags
  where document_id = ${isoDocId} and tag_type = 'bom_item' and tag_number = '10'
`;
console.log("Candidates for BOM item 10:");
for (const r of rows) console.log(r.id, "|", r.attributes.description, "| spec:", r.attributes.item_spec_class);

const target = rows.find((r) => /CHECK VALVE - LONG PATTERN/i.test(r.attributes.description));
if (!target) throw new Error("Target row not found");

console.log("\nUpdating row", target.id, "item_spec_class:", target.attributes.item_spec_class, "-> BC70N");
const newAttrs = { ...target.attributes, item_spec_class: "BC70N" };
await sql`update extracted_tags set attributes = ${sql.json(newAttrs)} where id = ${target.id}`;

const [check] = await sql`select attributes from extracted_tags where id = ${target.id}`;
console.log("Confirmed stored value:", check.attributes.item_spec_class);

await sql.end();
