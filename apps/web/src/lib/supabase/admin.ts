import { createClient } from "@supabase/supabase-js";

// Service-role client -- server-only, never import this from client code.
// Storage's authenticated-role RLS path is currently broken on this project
// (any custom policy on storage.objects trips Postgres's RLS recursion
// guard, error 42P17 "infinite recursion detected in rules for relation",
// independent of policy content -- confirmed by reproducing the identical
// error for both an authorized and an unauthorized test user). Until that's
// resolved platform-side, uploads go through this admin client instead, with
// org-membership authorization enforced explicitly in code (see
// requireProjectMembership in actions.ts) rather than via storage RLS.
export function createAdminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}
