// TEMP read-only diagnostic script -- checks page count / token usage data
// for a specific document. No writes, no API calls. Delete after running.
import "dotenv/config";
import { eq } from "drizzle-orm";
import { createDb, documents, extractedTags, extractionJobs, extractionResults } from "@easy/db";

async function main() {
  const documentId = "4fea196e-5aca-456f-8ebe-badbb6ff0354";
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Missing DATABASE_URL");
  const db = createDb(databaseUrl);

  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  console.log("=== documents row ===");
  console.log(doc);

  const jobs = await db.select().from(extractionJobs).where(eq(extractionJobs.documentId, documentId));
  console.log("\n=== extraction_jobs rows ===");
  for (const j of jobs) console.log(j);

  const results = await db.select().from(extractionResults).where(eq(extractionResults.documentId, documentId));
  console.log("\n=== extraction_results rows (checking rawJson for usage/token keys) ===");
  for (const r of results) {
    console.log({ id: r.id, schemaVersion: r.schemaVersion, createdAt: r.createdAt, rawJsonKeys: r.rawJson && typeof r.rawJson === "object" ? Object.keys(r.rawJson as object) : typeof r.rawJson });
  }

  const tags = await db.select({ sourcePage: extractedTags.sourcePage, tagType: extractedTags.tagType }).from(extractedTags).where(eq(extractedTags.documentId, documentId));
  const pages = [...new Set(tags.map((t) => t.sourcePage))].sort((a, b) => (a ?? -1) - (b ?? -1));
  console.log(`\n=== extracted_tags ===`);
  console.log(`total tag rows: ${tags.length}`);
  console.log(`distinct sourcePage values: ${JSON.stringify(pages)}`);
  console.log(`distinct tagTypes: ${JSON.stringify([...new Set(tags.map((t) => t.tagType))])}`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
