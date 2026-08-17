import "dotenv/config";
import { and, eq, lt } from "drizzle-orm";
import { createClient } from "@supabase/supabase-js";
import { createDb, extractionJobs } from "@easy/db";
import { getQueue, EXTRACT_DOCUMENT_QUEUE, type ExtractDocumentJobData } from "./queue";
import { runExtractionJob } from "./pipeline";

const DATABASE_URL = requireEnv("DATABASE_URL");
const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const ANTHROPIC_API_KEY = requireEnv("ANTHROPIC_API_KEY");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}. See apps/worker/.env.example.`);
  return value;
}

// A job is only ever moved out of 'running' by the process that owns it, so
// if this worker is killed mid-extraction (crash, redeploy, Ctrl-C) the row
// stays 'running' forever and apps/web shows that document as permanently
// processing, with no way to retry it. Any job still 'running' when a worker
// starts up was started by a process that no longer exists. The age threshold
// only matters if a second worker is running concurrently -- it keeps this
// from reaping a job that another worker legitimately has in flight.
const STALE_RUNNING_JOB_MINUTES = 15;

async function failOrphanedJobs(db: ReturnType<typeof createDb>) {
  const cutoff = new Date(Date.now() - STALE_RUNNING_JOB_MINUTES * 60_000);
  const orphaned = await db
    .update(extractionJobs)
    .set({
      status: "failed",
      finishedAt: new Date(),
      errorMessage: "Extraction was interrupted -- the worker stopped while this document was being processed. Re-run the extraction.",
    })
    .where(and(eq(extractionJobs.status, "running"), lt(extractionJobs.startedAt, cutoff)))
    .returning({ id: extractionJobs.id, documentId: extractionJobs.documentId });

  for (const job of orphaned) {
    console.log(`[worker] recovered orphaned job ${job.id} (document ${job.documentId}) -- marked failed`);
  }
}

async function main() {
  const db = createDb(DATABASE_URL);
  const storage = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const boss = await getQueue(DATABASE_URL);

  await failOrphanedJobs(db);

  console.log(`[worker] listening on queue "${EXTRACT_DOCUMENT_QUEUE}"`);

  await boss.work<ExtractDocumentJobData>(EXTRACT_DOCUMENT_QUEUE, async ([job]) => {
    const { documentId, extractionJobId } = job.data;
    console.log(`[worker] processing document ${documentId} (job ${extractionJobId})`);
    try {
      await runExtractionJob(db, storage, extractionJobId, documentId, ANTHROPIC_API_KEY);
      console.log(`[worker] document ${documentId} succeeded`);
    } catch (err) {
      // runExtractionJob already persists the failure to extraction_jobs;
      // re-throwing lets pg-boss track/retry the job per its own policy.
      console.error(`[worker] document ${documentId} failed:`, err);
      throw err;
    }
  });
}

main().catch((err) => {
  console.error("[worker] fatal error during startup:", err);
  process.exit(1);
});
