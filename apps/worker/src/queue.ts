// Postgres-native job queue (pg-boss) running against the same Supabase
// Postgres instance as the app -- job enqueue happens transactionally with
// document creation from apps/web (no dual-write problem), and this worker
// polls for work. See the architecture plan for why this was chosen over
// SQS/Lambda for the MVP: one fewer service to operate, and this pattern
// scales fine until there's real multi-org concurrent-upload throughput.
import PgBoss from "pg-boss";

export const EXTRACT_DOCUMENT_QUEUE = "extract-document";

export interface ExtractDocumentJobData {
  documentId: string;
  extractionJobId: string; // the extraction_jobs row apps/web already created transactionally with this enqueue
}

let bossInstance: PgBoss | null = null;

export async function getQueue(connectionString: string): Promise<PgBoss> {
  if (bossInstance) return bossInstance;
  const boss = new PgBoss(connectionString);
  boss.on("error", (err) => console.error("[pg-boss] error:", err));
  await boss.start();
  await boss.createQueue(EXTRACT_DOCUMENT_QUEUE);
  bossInstance = boss;
  return boss;
}
