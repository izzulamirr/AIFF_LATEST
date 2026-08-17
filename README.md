# EASY

AI-powered cross-document engineering review -- cross-checks P&IDs, H&MBs (Heat & Mass Balance), PFDs (Process Flow Diagrams), and piping spec sheets against each other, flags inconsistencies, and (eventually) applies discipline-specific rule sets (API/IOGP/corporate standards). Inspired by URUS Ai, built as a separate product.

Monorepo (pnpm workspaces + Turborepo):

```
apps/
  web/                 Next.js App Router -- auth, orgs/projects/documents UI, Server Actions for CRUD + upload
  worker/               Node service -- downloads uploaded PDFs, runs the Claude extraction pipeline, correlates tags across documents
packages/
  db/                    Drizzle schema (Postgres/Supabase) shared by web + worker
  shared/                 Zod types: DocType, RuleConfig discriminated union, etc.
  extraction-schemas/     The Claude tool-use schemas per document type (P&ID/H&MB/PFD/spec sheet)
supabase/
  rls.sql                Row Level Security policies -- run in the Supabase SQL editor
  storage.sql             Storage bucket + policies -- run in the Supabase SQL editor
```

Current status: **Phase 0 (Foundations) scaffolding is complete and typechecks/builds cleanly.** Auth, org/project creation, and document upload (which enqueues an extraction job) all work end to end once you provide real Supabase/Anthropic credentials below. The extraction pipeline (Phase 1) is fully coded per document type but has not been run against a real Claude API key or real engineering PDFs yet -- validate that P&ID/PFD extraction accuracy is acceptable via plain PDF text (vs. needing native page-image input) before relying on it, per the note in `packages/extraction-schemas/src/pid.ts`.

## One-time setup

### 1. Supabase project

1. Create a project at [supabase.com](https://supabase.com).
2. **Settings -> Database -> Connection string** -- copy the "Transaction" pooler connection string. This is `DATABASE_URL` for both `apps/web` and `apps/worker`.
3. **Settings -> API** -- copy the Project URL, `anon` public key, and `service_role` key.
4. Push the schema:
   ```
   cd packages/db
   cp .env.example .env   # if you add one, or just export DATABASE_URL inline
   DATABASE_URL="<your connection string>" pnpm db:push
   ```
5. In the Supabase SQL editor, run `supabase/rls.sql` then `supabase/storage.sql` (in that order -- storage policies reference the `projects`/`organization_members` tables `rls.sql` doesn't create, but doesn't require RLS to already be *enabled* on them, just present).

### 2. Anthropic API key

Get one at [console.anthropic.com](https://console.anthropic.com). Used by `apps/worker` for the extraction pipeline (`claude-opus-4-8`).

### 3. Environment variables

```
cp apps/web/.env.example apps/web/.env.local
cp apps/worker/.env.example apps/worker/.env
```
Fill in both with the values from steps 1-2.

### 4. Install and run

```
pnpm install
pnpm dev   # runs apps/web (localhost:3000) and apps/worker together via Turborepo
```

Sign up at `localhost:3000/login`, create an organization on the dashboard, create a project, and upload a PDF -- it'll be picked up by the worker (check its console output) and extracted.

## Deployment (MVP target: Vercel + Supabase, per the architecture decision)

- **`apps/web`**: deploy to Vercel. Set the same env vars as `.env.local` in the Vercel project settings.
- **`apps/worker`**: deploy to Railway or Fly.io as a long-running process (`pnpm --filter @easy/worker build && pnpm --filter @easy/worker start`) -- **not** Vercel; it needs to run multi-minute Claude extraction jobs, which serverless functions can't do.
- **Before any real enterprise security review**: re-platform onto AWS (Supabase Storage -> S3, Supabase Auth -> Clerk/WorkOS with SSO/SAML, worker -> ECS Fargate). This was a deliberate MVP-speed tradeoff, not an oversight -- see the plan discussion this was built from.

## What's next (roadmap)

1. **Phase 1 -- Cross-document analysis** (in progress): validate P&ID + H&MB extraction against real sample documents, wire the correlation step (`apps/worker/src/correlate.ts`) into the pipeline to produce actual findings, add a findings list UI.
2. **Phase 2 -- Rule engine**: wire `apps/worker/src/rules/evaluate.ts` into the pipeline, build a rule-authoring UI, seed a starter API/IOGP rule set.
3. **Phase 3 -- Collaboration + export**: findings dashboard with status/assignee/comments (Supabase Realtime), CSV/PDF export.

See the architecture plan this was scaffolded from for full reasoning on each decision (tech stack tradeoffs, data model, per-document-type extraction design, correlation strategy).
