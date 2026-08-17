// The discipline-specific rule engine's config shape. Stored as `rules.config`
// jsonb in the DB (see packages/db/src/schema.ts). Validated with Zod both
// when an admin authors a rule (apps/web) and when the worker evaluates it
// (apps/worker), so the two never silently drift.
//
// `custom_expression` is deliberately NOT arbitrary code -- rule configs are
// DB-stored and will eventually be authored by non-developer discipline
// engineers, so this is a real code-execution boundary. Evaluate it with a
// sandboxed expression library (e.g. json-logic-js or expr-eval), never
// `eval()`/`new Function()`.
import { z } from "zod";
import { DOC_TYPES } from "./types";

const docTypeSchema = z.enum(DOC_TYPES);

const fieldRefSchema = z.object({
  docType: docTypeSchema,
  path: z.string(), // dot-path into extracted_tags.attributes, e.g. "size"
});

export const fieldEqualityConfigSchema = z.object({
  checkType: z.literal("field_equality"),
  fieldA: fieldRefSchema,
  fieldB: fieldRefSchema,
  normalize: z.enum(["trim_upper", "numeric"]),
  tolerance: z.number().optional(), // for normalize: "numeric" -- |a - b| <= tolerance passes
});

export const fieldPresenceConfigSchema = z.object({
  checkType: z.literal("field_presence"),
  docType: docTypeSchema,
  condition: z.object({ path: z.string(), equals: z.string() }),
  requiredField: z.string(),
});

export const valueRangeConfigSchema = z.object({
  checkType: z.literal("value_range"),
  docType: docTypeSchema,
  field: z.string(),
  min: z.number().optional(),
  max: z.number().optional(),
  relativeTo: z.object({ path: z.string(), mustExceedByPct: z.number() }).optional(),
});

export const regexFormatConfigSchema = z.object({
  checkType: z.literal("regex_format"),
  field: z.string(),
  pattern: z.string(),
});

export const customExpressionConfigSchema = z.object({
  checkType: z.literal("custom_expression"),
  expression: z.string(), // sandboxed expression language input, not JS source
});

export const ruleConfigSchema = z.discriminatedUnion("checkType", [
  fieldEqualityConfigSchema,
  fieldPresenceConfigSchema,
  valueRangeConfigSchema,
  regexFormatConfigSchema,
  customExpressionConfigSchema,
]);

export type RuleConfig = z.infer<typeof ruleConfigSchema>;
