// Same pg-boss queue apps/worker listens on (see apps/worker/src/queue.ts).
// apps/web only ever enqueues jobs here, right after creating the
// extraction_jobs row -- this is the "transactional-ish" enqueue pattern
// from the architecture plan (both writes happen in the same request, so a
// document is never left without a corresponding job).
import PgBoss from "pg-boss";

export const EXTRACT_DOCUMENT_QUEUE = "extract-document";

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
