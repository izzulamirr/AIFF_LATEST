// Drizzle schema for EASY's Supabase Postgres database.
// Mirrors the design in the approved architecture plan: tenancy via
// organizations/organization_members layered over Supabase's auth.users,
// projects -> documents -> extraction_jobs/extraction_results ->
// extracted_tags (the shape-agnostic cross-document join surface) ->
// rule_sets/rules -> findings/finding_comments -> report_exports.
//
// auth.users is Supabase-managed; we reference it by uuid without owning
// the table (see authUsers below, a minimal reference-only definition).

import {
  pgTable,
  pgSchema,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  integer,
  bigserial,
  primaryKey,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Supabase's built-in auth schema -- referenced, never migrated by us.
const authSchema = pgSchema("auth");
export const authUsers = authSchema.table("users", {
  id: uuid("id").primaryKey(),
});

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  planTier: text("plan_tier").notNull().default("trial"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizationMembers = pgTable(
  "organization_members",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    check("organization_members_role_check", sql`${table.role} in ('owner','admin','reviewer','viewer')`),
  ]
);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  createdBy: uuid("created_by").references(() => authUsers.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// 'pid' | 'hmb' | 'pfd' | 'spec_sheet'
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    docType: text("doc_type").notNull(),
    fileName: text("file_name").notNull(),
    fileHash: text("file_hash").notNull(),
    storagePath: text("storage_path").notNull(),
    pageCount: integer("page_count"),
    uploadedBy: uuid("uploaded_by").references(() => authUsers.id),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("documents_project_hash_unique").on(table.projectId, table.fileHash),
    check("documents_doc_type_check", sql`${table.docType} in ('pid','hmb','pfd','spec_sheet','iso','ga','pll','pid_legend')`),
  ]
);

export const documentPages = pgTable(
  "document_pages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    pageNumber: integer("page_number").notNull(),
    pageText: text("page_text"),
  },
  (table) => [uniqueIndex("document_pages_doc_page_unique").on(table.documentId, table.pageNumber)]
);

// 'queued' | 'running' | 'succeeded' | 'failed'
export const extractionJobs = pgTable(
  "extraction_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    progressPhase: text("progress_phase"),
    progressCurrent: integer("progress_current"),
    progressTotal: integer("progress_total"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("extraction_jobs_status_check", sql`${table.status} in ('queued','running','succeeded','failed')`),
  ]
);

export const extractionResults = pgTable("extraction_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  extractionJobId: uuid("extraction_job_id").references(() => extractionJobs.id),
  schemaVersion: text("schema_version").notNull(),
  rawJson: jsonb("raw_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// The shape-agnostic cross-document join surface -- every tag/line/equipment
// number found in any document, normalized so P&ID/H&MB/PFD/spec rows can be
// matched to "the same real-world thing" despite structurally different
// source schemas.
export const extractedTags = pgTable(
  "extracted_tags",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    docType: text("doc_type").notNull(),
    tagType: text("tag_type").notNull(), // 'line' | 'equipment' | 'instrument' | 'valve' | 'stream'
    tagNumber: text("tag_number").notNull(),
    tagNumberNormalized: text("tag_number_normalized").notNull(),
    sourcePage: integer("source_page"),
    attributes: jsonb("attributes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("extracted_tags_project_norm_idx").on(table.projectId, table.tagNumberNormalized),
    index("extracted_tags_project_type_idx").on(table.projectId, table.tagType),
  ]
);

export const ruleSets = pgTable("rule_sets", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").references(() => organizations.id), // null = shipped/global
  name: text("name").notNull(),
  standard: text("standard"), // e.g. 'API 526', 'IOGP S-616'
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rules = pgTable(
  "rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleSetId: uuid("rule_set_id")
      .notNull()
      .references(() => ruleSets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    applicableDocTypes: text("applicable_doc_types").array().notNull(),
    severity: text("severity").notNull().default("error"),
    checkType: text("check_type").notNull(), // see @easy/shared RuleConfig
    config: jsonb("config").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("rules_severity_check", sql`${table.severity} in ('error','warning','info')`)]
);

export const projectRuleSets = pgTable(
  "project_rule_sets",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ruleSetId: uuid("rule_set_id")
      .notNull()
      .references(() => ruleSets.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.ruleSetId] })]
);

export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id").references(() => rules.id), // null = ad-hoc Phase-1 finding
    tagNumber: text("tag_number"),
    docAId: uuid("doc_a_id").references(() => documents.id),
    docBId: uuid("doc_b_id").references(() => documents.id),
    fieldChecked: text("field_checked").notNull(),
    valueA: text("value_a"),
    valueB: text("value_b"),
    severity: text("severity").notNull(),
    status: text("status").notNull().default("open"),
    assigneeId: uuid("assignee_id").references(() => authUsers.id),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => authUsers.id),
  },
  (table) => [
    index("findings_project_status_idx").on(table.projectId, table.status),
    check("findings_status_check", sql`${table.status} in ('open','investigating','resolved','false_positive')`),
  ]
);

export const findingComments = pgTable("finding_comments", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  findingId: uuid("finding_id")
    .notNull()
    .references(() => findings.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => authUsers.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const reportExports = pgTable(
  "report_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    format: text("format").notNull(),
    filterCriteria: jsonb("filter_criteria"),
    storagePath: text("storage_path").notNull(),
    generatedBy: uuid("generated_by").references(() => authUsers.id),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("report_exports_format_check", sql`${table.format} in ('csv','pdf')`)]
);
