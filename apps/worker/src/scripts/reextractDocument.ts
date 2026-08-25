// Re-runs the real extraction pipeline for an ALREADY-UPLOADED document, in
// process, bypassing the pg-boss queue -- there's no existing UI action for
// this (the only current trigger is re-uploading the identical file, which
// re-hashes and re-inserts an extraction_jobs row via uploadDocument). Calls
// runExtractionJob (apps/worker/src/pipeline.ts) directly, the exact same
// function apps/worker/src/index.ts's queue worker calls, so behavior is
// identical to a real production run -- including deleting any prior
// documentPages/extractedTags rows for this document first (pipeline.ts's
// own re-run safety), a real Claude API call (real token cost, logged per
// call by claudeClient.ts as "[claude] <tool>: input=X output=Y ..."), and
// writing a fresh extractionJobs row so job status/progress is visible the
// same way a real upload's is.
//
// Usage: pnpm --filter worker exec tsx src/scripts/reextractDocument.ts <documentId>
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { createDb, documents, extractionJobs } from "@easy/db";
import { eq } from "drizzle-orm";
import { runExtractionJob } from "../pipeline";

async function main() {
  const documentId = process.argv[2];
  if (!documentId) {
    console.error("Usage: tsx src/scripts/reextractDocument.ts <documentId>");
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!databaseUrl || !apiKey || !supabaseUrl || !supabaseKey) {
    throw new Error("Missing DATABASE_URL / ANTHROPIC_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY -- see apps/worker/.env.example.");
  }

  const db = createDb(databaseUrl);
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!doc) throw new Error(`No document ${documentId}`);
  console.log(`Re-extracting: ${doc.fileName} (docType=${doc.docType})`);
  console.log(`This deletes and replaces all extracted_tags for this document, and makes real Claude API calls (real token cost).`);

  const storage = createClient(supabaseUrl, supabaseKey);
  const [job] = await db.insert(extractionJobs).values({ documentId }).returning();
  console.log(`Created extraction job ${job.id}, running...`);

  await runExtractionJob(db, storage, job.id, documentId, apiKey);

  const [finished] = await db.select().from(extractionJobs).where(eq(extractionJobs.id, job.id)).limit(1);
  console.log(`\nDone. Job status: ${finished.status}${finished.errorMessage ? ` (${finished.errorMessage})` : ""}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
