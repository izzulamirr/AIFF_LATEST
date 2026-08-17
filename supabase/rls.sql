-- Row Level Security policies for EASY's multi-tenant tables.
-- Run this in the Supabase SQL editor AFTER `pnpm --filter @easy/db db:push`
-- has created the tables (see root README.md's setup steps).
--
-- Model: a user can read/write a row if they're a member of the
-- organization that (transitively) owns it. This is defense-in-depth on
-- top of the app-layer membership checks already in apps/web's server
-- actions (see apps/web/src/app/(app)/actions.ts) -- don't remove those
-- checks just because RLS exists; either layer alone is one mistake away
-- from a cross-tenant leak.

alter table organizations enable row level security;
alter table organization_members enable row level security;
alter table projects enable row level security;
alter table documents enable row level security;
alter table document_pages enable row level security;
alter table extraction_jobs enable row level security;
alter table extraction_results enable row level security;
alter table extracted_tags enable row level security;
alter table rule_sets enable row level security;
alter table rules enable row level security;
alter table project_rule_sets enable row level security;
alter table findings enable row level security;
alter table finding_comments enable row level security;
alter table report_exports enable row level security;

-- organizations: visible to members only
create policy "org members can read their org" on organizations
  for select using (
    exists (select 1 from organization_members m where m.organization_id = id and m.user_id = auth.uid())
  );

-- organization_members: a user can see the membership rows for orgs they belong to
create policy "org members can read membership rows" on organization_members
  for select using (
    exists (select 1 from organization_members m where m.organization_id = organization_members.organization_id and m.user_id = auth.uid())
  );

-- projects: member of the owning org
create policy "org members can read projects" on projects
  for select using (
    exists (select 1 from organization_members m where m.organization_id = projects.organization_id and m.user_id = auth.uid())
  );
create policy "org members can insert projects" on projects
  for insert with check (
    exists (select 1 from organization_members m where m.organization_id = projects.organization_id and m.user_id = auth.uid())
  );

-- Generic pattern for everything hanging off projects: join through
-- projects.organization_id to check membership. Repeated per table because
-- Postgres RLS policies can't be parameterized/shared across tables.
create policy "org members can read documents" on documents
  for select using (
    exists (
      select 1 from projects p
      join organization_members m on m.organization_id = p.organization_id
      where p.id = documents.project_id and m.user_id = auth.uid()
    )
  );
create policy "org members can insert documents" on documents
  for insert with check (
    exists (
      select 1 from projects p
      join organization_members m on m.organization_id = p.organization_id
      where p.id = documents.project_id and m.user_id = auth.uid()
    )
  );

create policy "org members can read document_pages" on document_pages
  for select using (
    exists (
      select 1 from documents d
      join projects p on p.id = d.project_id
      join organization_members m on m.organization_id = p.organization_id
      where d.id = document_pages.document_id and m.user_id = auth.uid()
    )
  );

create policy "org members can read extraction_jobs" on extraction_jobs
  for select using (
    exists (
      select 1 from documents d
      join projects p on p.id = d.project_id
      join organization_members m on m.organization_id = p.organization_id
      where d.id = extraction_jobs.document_id and m.user_id = auth.uid()
    )
  );

create policy "org members can read extraction_results" on extraction_results
  for select using (
    exists (
      select 1 from documents d
      join projects p on p.id = d.project_id
      join organization_members m on m.organization_id = p.organization_id
      where d.id = extraction_results.document_id and m.user_id = auth.uid()
    )
  );

create policy "org members can read extracted_tags" on extracted_tags
  for select using (
    exists (
      select 1 from projects p
      join organization_members m on m.organization_id = p.organization_id
      where p.id = extracted_tags.project_id and m.user_id = auth.uid()
    )
  );

create policy "org members can read rule_sets" on rule_sets
  for select using (
    organization_id is null -- shipped/global rule sets are visible to everyone
    or exists (select 1 from organization_members m where m.organization_id = rule_sets.organization_id and m.user_id = auth.uid())
  );

create policy "org members can read rules" on rules
  for select using (
    exists (
      select 1 from rule_sets rs
      where rs.id = rules.rule_set_id
        and (rs.organization_id is null or exists (
          select 1 from organization_members m where m.organization_id = rs.organization_id and m.user_id = auth.uid()
        ))
    )
  );

create policy "org members can read project_rule_sets" on project_rule_sets
  for select using (
    exists (
      select 1 from projects p
      join organization_members m on m.organization_id = p.organization_id
      where p.id = project_rule_sets.project_id and m.user_id = auth.uid()
    )
  );

create policy "org members can read findings" on findings
  for select using (
    exists (
      select 1 from projects p
      join organization_members m on m.organization_id = p.organization_id
      where p.id = findings.project_id and m.user_id = auth.uid()
    )
  );
create policy "org members can update findings" on findings
  for update using (
    exists (
      select 1 from projects p
      join organization_members m on m.organization_id = p.organization_id
      where p.id = findings.project_id and m.user_id = auth.uid()
    )
  );

create policy "org members can read finding_comments" on finding_comments
  for select using (
    exists (
      select 1 from findings f
      join projects p on p.id = f.project_id
      join organization_members m on m.organization_id = p.organization_id
      where f.id = finding_comments.finding_id and m.user_id = auth.uid()
    )
  );
create policy "org members can insert finding_comments" on finding_comments
  for insert with check (
    exists (
      select 1 from findings f
      join projects p on p.id = f.project_id
      join organization_members m on m.organization_id = p.organization_id
      where f.id = finding_comments.finding_id and m.user_id = auth.uid()
    )
  );

create policy "org members can read report_exports" on report_exports
  for select using (
    exists (
      select 1 from projects p
      join organization_members m on m.organization_id = p.organization_id
      where p.id = report_exports.project_id and m.user_id = auth.uid()
    )
  );

-- NOTE: apps/worker connects with the Supabase *service role* key, which
-- bypasses RLS entirely -- this is intentional (the worker needs to write
-- extraction results for any document regardless of which user triggered
-- it) and is why the service role key must never be exposed to the browser
-- (see apps/worker/.env.example).
