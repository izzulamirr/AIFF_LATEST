// Phase 2 stub. Not wired into the Phase 1 pipeline yet -- Phase 1 findings
// are produced by hardcoded comparison logic (see the architecture plan's
// roadmap), not this rule engine. This file exists now so the RuleConfig
// shape (packages/shared/src/rule-config.ts) has one real consumer to keep
// it honest, and so Phase 2 has a clear landing spot.
import { ruleConfigSchema, type RuleConfig } from "@easy/shared";
import type { CorrelatableTag, MatchedGroup } from "../correlate";

export interface RuleEvalResult {
  ruleId: string;
  passed: boolean;
  valueA?: string;
  valueB?: string;
  fieldChecked: string;
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), obj);
}

function normalizeForCompare(value: unknown, normalize: "trim_upper" | "numeric"): string | number | null {
  if (value == null) return null;
  if (normalize === "numeric") {
    const n = Number(value);
    return Number.isNaN(n) ? null : n;
  }
  return String(value).trim().toUpperCase();
}

// Evaluates one rule against one matched tag group (a set of tags across
// doc types sharing a normalized tag number, or a spec_class lookup -- see
// correlate.ts). TODO(Phase 2): wire this into pipeline.ts after a
// project's documents finish extracting, iterate all active rule_sets, and
// upsert `findings` rows for failures.
export function evaluateFieldEquality(rule: Extract<RuleConfig, { checkType: "field_equality" }>, group: MatchedGroup): RuleEvalResult | null {
  const tagA = group.tags.find((t) => t.docType === rule.fieldA.docType);
  const tagB = group.tags.find((t) => t.docType === rule.fieldB.docType);
  if (!tagA || !tagB) return null; // nothing to compare -- one side isn't present in this group

  const rawA = getPath(tagA.attributes, rule.fieldA.path);
  const rawB = getPath(tagB.attributes, rule.fieldB.path);
  const a = normalizeForCompare(rawA, rule.normalize);
  const b = normalizeForCompare(rawB, rule.normalize);

  let passed: boolean;
  if (rule.normalize === "numeric" && typeof a === "number" && typeof b === "number") {
    passed = Math.abs(a - b) <= (rule.tolerance ?? 0);
  } else {
    passed = a === b;
  }

  return {
    ruleId: rule.checkType, // placeholder -- real caller substitutes the actual rules.id
    passed,
    valueA: rawA == null ? undefined : String(rawA),
    valueB: rawB == null ? undefined : String(rawB),
    fieldChecked: `${rule.fieldA.docType}.${rule.fieldA.path} vs ${rule.fieldB.docType}.${rule.fieldB.path}`,
  };
}

export { ruleConfigSchema };
