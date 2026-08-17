import { createBrowserClient } from "@supabase/ssr";

// Browser-side client for use in Client Components (auth state, Realtime
// subscriptions on findings/finding_comments -- see Phase 3 of the plan).
export function createClient() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}
