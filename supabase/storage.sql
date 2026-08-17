-- Creates the private "documents" Storage bucket and RLS policies for it.
-- Run this in the Supabase SQL editor (after rls.sql). Uploaded files are
-- stored at `${projectId}/${fileHash}-${fileName}` (see
-- apps/web/src/app/(app)/projects/[id]/actions.ts), so the first path
-- segment is always a project id -- these policies check organization
-- membership for that project, same pattern as rls.sql.
--
-- KNOWN ISSUE (found 2026-07-14): on this project, ANY custom RLS policy on
-- storage.objects makes authenticated-role inserts fail with Postgres error
-- 42P17 "infinite recursion detected in rules for relation" (thrown from
-- fireRIRrules), independent of the policy's own logic -- reproduced
-- identically for both an authorized and a deliberately-unauthorized test
-- user. This looks like a Supabase platform-side bug for this Postgres
-- version, not something fixable by editing the policy SQL. Because of this,
-- apps/web's actual upload code path (actions.ts) does NOT depend on these
-- policies -- it checks org membership in application code
-- (requireProjectMembership) and uploads via the service-role admin client
-- (lib/supabase/admin.ts) instead. These policies are left in place as
-- defense-in-depth for once the underlying platform bug is resolved, and to
-- cover any future direct-from-browser upload path.

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

create policy "org members can read project documents"
  on storage.objects for select
  using (
    bucket_id = 'documents'
    and exists (
      select 1 from projects p
      join organization_members m on m.organization_id = p.organization_id
      where p.id::text = (storage.foldername(storage.objects.name))[1] and m.user_id = auth.uid()
    )
  );

create policy "org members can upload project documents"
  on storage.objects for insert
  with check (
    bucket_id = 'documents'
    and exists (
      select 1 from projects p
      join organization_members m on m.organization_id = p.organization_id
      where p.id::text = (storage.foldername(storage.objects.name))[1] and m.user_id = auth.uid()
    )
  );

-- NOTE: apps/worker downloads via the service role key, which bypasses
-- Storage RLS entirely -- same reasoning as rls.sql's closing note.
