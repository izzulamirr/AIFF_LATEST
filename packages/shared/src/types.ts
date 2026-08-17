export const DOC_TYPES = ["pid", "hmb", "pfd", "spec_sheet", "iso", "ga", "pll", "pid_legend"] as const;
export type DocType = (typeof DOC_TYPES)[number];

// 'spec_class' is a special case: spec sheets define rules keyed by class
// code (e.g. "A1A"), not physical tags -- P&ID/PFD lines carry a spec_class
// field that joins against this during rule evaluation, rather than an
// exact tag_number match like the other tag types use.
//
// 'bom_item' rows come from an ISO's Bill of Material (keyed by item_no, not
// cross-document-correlated by tag number -- they're checked against their
// referenced spec_class instead, see lib/verifyIso.ts). 'support' rows come
// from a GA's pipe support schedule (keyed by support_tag). 'legend_item'
// rows come from a P&ID's legend/symbols/abbreviations sheet -- keyed by
// the symbol or abbreviation itself, not a physical tag.
// 'fitting' rows are untagged inline piping symbols drawn on a P&ID line
// (flange pairs, blinds, reducers, expansion joints, strainers...) -- keyed
// by their fitting type, referenced to a line via attributes.line_number.
// 'spool' rows come from an ISO's own "PIPE SPOOLS" list (keyed by spool
// number). 'weld' rows come from the weld/joint marks drawn along an ISO's
// pipe run (shop weld, field weld, socket weld...) -- untagged, keyed by
// a per-sheet sequence number, referenced to a line via attributes.line_number.
// 'route_point' rows come from an ISO's own E/N/EL coordinate callouts
// (audit data behind each spool's computed bounding box). 'dimension' rows
// come from an ISO's own printed dimension lines (audit data behind each
// spool's computed length) -- both untagged, keyed by a per-sheet sequence
// number, each optionally tagged with the spool_no it was attributed to.
export const TAG_TYPES = [
  "line",
  "equipment",
  "instrument",
  "valve",
  "stream",
  "spec_class",
  "bom_item",
  "support",
  "legend_item",
  "fitting",
  "spool",
  "weld",
  "route_point",
  "dimension",
] as const;
export type TagType = (typeof TAG_TYPES)[number];

export const ORG_ROLES = ["owner", "admin", "reviewer", "viewer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const FINDING_STATUSES = ["open", "investigating", "resolved", "false_positive"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const SEVERITIES = ["error", "warning", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const EXTRACTION_JOB_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type ExtractionJobStatus = (typeof EXTRACTION_JOB_STATUSES)[number];

export interface ExtractionProgressEvent {
  phase: string; // e.g. 'locate_sections' | 'sheet_3_of_12' | 'merge'
  current: number;
  total: number;
  detail?: string;
}
