import { createDb } from "@easy/db";

// Singleton Drizzle instance for server-side data access (Server
// Components / Server Actions / Route Handlers). Auth + Storage + Realtime
// still go through Supabase's own client (see lib/supabase/*) -- this is
// purely the typed Postgres query layer.
let dbInstance: ReturnType<typeof createDb> | null = null;

export function getDb() {
  if (!dbInstance) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Missing DATABASE_URL -- see apps/web/.env.example.");
    dbInstance = createDb(url);
  }
  return dbInstance;
}
