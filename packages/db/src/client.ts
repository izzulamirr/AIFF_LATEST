import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// DATABASE_URL is Supabase's connection string (use the pooled "Transaction"
// connection string for serverless/worker use -- see apps/web and
// apps/worker's .env.example for where this comes from).
export function createDb(connectionString: string) {
  const client = postgres(connectionString, { prepare: false });
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;
