import { PAGE_RANGE_SCHEMA, type ClaudeTool } from "./common";

// Same proven shape as AIFF's electron/specExtraction.js: locate the Class
// Index, then per-class detail pages, then branch tables; extract each
// separately. Reused here as a *pattern*, not copied code.
export const LOCATE_SPEC_SECTIONS_TOOL: ClaudeTool = {
  name: "locate_spec_sections",
  description:
    "Identifies which page ranges contain the Piping Class Index, each class's detailed datasheet, and the branch tables in this Piping Material Specification document.",
  input_schema: {
    type: "object",
    properties: {
      class_index_pages: PAGE_RANGE_SCHEMA,
      classes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            class_code: { type: "string" },
            detail_pages: PAGE_RANGE_SCHEMA,
          },
          required: ["class_code", "detail_pages"],
        },
      },
      branch_table_pages: PAGE_RANGE_SCHEMA,
    },
    required: ["classes"],
  },
};

export const SPEC_CLASS_INDEX_TOOL: ClaudeTool = {
  name: "record_class_index",
  description: "Records the Piping Class Index / summary table rows.",
  input_schema: {
    type: "object",
    properties: {
      classes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            class_code: { type: "string" },
            service: { type: "string" },
            size_min: { type: "string" },
            size_max: { type: "string" },
            material: { type: "string" },
            corrosion_allowance: { type: "string" },
            design_code: { type: "string" },
            nace_sour_service: { type: "boolean" },
            max_pressure: { type: "string" },
            temp_range: { type: "string" },
            asme_class: { type: "string" },
            flange_facing: { type: "string" },
            gasket_type: { type: "string" },
            stud_bolts: { type: "string" },
            nde_extent: { type: "string" },
            pwht_required: { type: "boolean" },
            remarks: { type: "string" },
          },
          required: ["class_code"],
        },
      },
    },
    required: ["classes"],
  },
};

export const SPEC_CLASS_DETAIL_TOOL: ClaudeTool = {
  name: "record_class_detail",
  description: "Records the per-size-range pipe/fitting/flange/valve rows for a single piping class's detailed datasheet.",
  input_schema: {
    type: "object",
    properties: {
      pipes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            size_min: { type: "string" },
            size_max: { type: "string" },
            schedule: { type: "string" },
            end_type: { type: "string" },
            material: { type: "string" },
            item_code: { type: "string" }, // this row's own item/component code, if the spec sheet lists one (e.g. "P9610-C") -- an ISO's BOM references these
          },
        },
      },
      fittings: {
        type: "array",
        description:
          "Read each row's own column boundaries directly -- do not assume a material/spec split falls at the same NPS breakpoint as another row (e.g. the PIPE row's SMLS-vs-welded cutoff) just because it happens to show two values too. A second value printed further along a row often belongs to a size column that sits ABOVE this class's own SIZE row ceiling (e.g. a 26\"-36\" variant printed for reference on a class whose SIZE row stops at 24\") -- when that's the case it never actually applies to any size this class covers, so record only the one material that is genuinely in range rather than adding a second row for it. " +
          "WELDOLET (O'let) SIZE IS A SPECIAL CASE -- it is a branch-outlet fitting, so its real size boundary is its OUTLET/branch size, not the class's main-line size range, and this class's own FITTINGS table often prints that row with no clear per-column split at all. Don't default to the class's full SIZE range for it. Instead cross-reference the branch table this class points to (see the \"Branch connections refer Appendix...\" note, usually near the fittings notes): find the largest branch size that the branch-table legend's weldolet symbol (commonly \"WO\") is ever assigned to across the whole matrix (it typically stays capped at a small branch size, e.g. 2\" or 8\", switching to a reducing-tee symbol beyond that on every header row) -- that cap is the weldolet's real size_max, and 1/2\" (or this class's own size_min) is its size_min.",
        items: {
          type: "object",
          properties: {
            fitting_type: { type: "string" },
            size_min: { type: "string" },
            size_max: { type: "string" },
            material: { type: "string" },
            end_type: { type: "string" },
            item_code: { type: "string" },
          },
        },
      },
      flanges: {
        type: "array",
        description:
          'Include the FLANGES table\'s "Gasket" and "Stud Bolt/Hvy-Hex Nuts" rows as their own entries in this array (flange_type "Gasket" / "Stud Bolt/Hvy-Hex Nuts", each with its own printed size range) -- do NOT fold that material only into the gasket_type/stud_bolts fields below on some other row and skip a dedicated row for it. The admin cross-check matches on the word "gasket"/"bolt" inside flange_type, so a row is the only way that data is ever reachable. ' +
          'flange_type is the ROW\'S OWN printed label, verbatim -- a plain "Flange" row is "Flange", not an invented, more-descriptive name like "Weld Neck Flange" just because its material text happens to say "WN". Likewise, when one printed row shows two material/rating variants stacked in the same cell (e.g. a Class 150 line and a separate Class 300 "(Note d)" line under one "Flange" row), that is still ONE row in the source table -- do not split it into two synthetic rows with two different invented flange_type names. Only emit two rows when the sheet itself prints two distinct row labels. ' +
          "SIZE RANGE -- read where THIS row's own populated cell actually starts and ends against the SIZE (Inch) header columns above it; never assume a row spans the class's full size range just because a neighboring row (or the PIPE row) does. Some rows only apply at the small end (e.g. a plain Flange row that stops well before the class's largest sizes, with nothing printed for the columns beyond it), and some only apply at the large end with the small-size columns left BLANK (e.g. Spade & Spacer or a large-size-only Spectacle Blind, whose row has no text at all under 1/2\"-10\" and only starts partway across the table) -- a blank cell under a column means that item does NOT cover that size, not that the row's range should be read as starting from 1/2\" anyway. Trace the row's actual populated cell boundary against the header, left edge and right edge independently. " +
          "A ROW CAN VISUALLY SPLIT INTO TWO ADJACENT CELLS THAT SAY THE SAME THING -- e.g. a Stud Bolt row printed as one cell of text spanning the small/mid columns, then a SECOND cell further right (starting around the class's largest sizes) repeating that identical material wording verbatim. Don't mistake this for two different bands and don't stop at the first cell's own right edge either -- when the second cell's text genuinely repeats the first (not a different rating/material), the true size_max is the SECOND cell's right edge, not the first cell's. Read all the way to where the row's populated text actually ends before recording size_max, even past an internal cell break.",
        items: {
          type: "object",
          properties: {
            flange_type: { type: "string" },
            size_min: { type: "string" },
            size_max: { type: "string" },
            facing: { type: "string" },
            material: { type: "string" },
            gasket_type: { type: "string", description: "Only for a flange row that ALSO states its own mating gasket inline. Leave blank on the dedicated Gasket row itself (use material there instead) -- this is a supplement, never a substitute for it." },
            stud_bolts: { type: "string", description: "Only for a flange row that ALSO states its own bolting inline. Leave blank on the dedicated Stud Bolt row itself (use material there instead) -- this is a supplement, never a substitute for it." },
            item_code: { type: "string" },
          },
        },
      },
      valves: {
        type: "array",
        description:
          'valve_type is the bare component category as the table\'s own row grouping names it -- "Gate", "Globe", "Ball", "Check", "Butterfly" -- never append the bore/trim/operator variant (e.g. not "Ball (Full Bore, Trunnion, Gear)"). The admin cross-check routes purely on that plain word appearing in valve_type; put every distinguishing detail (full/reduced bore, floating/trunnion, lever/gear operator, body/trim material...) in description instead, where it belongs.',
        items: {
          type: "object",
          properties: {
            valve_type: { type: "string" },
            size_min: { type: "string" },
            size_max: { type: "string" },
            description: { type: "string" },
            valve_index_code: { type: "string" },
          },
        },
      },
    },
  },
};

export const SPEC_BRANCH_TABLES_TOOL: ClaudeTool = {
  name: "record_branch_tables",
  description: "Records the branch table matrix rows (e.g. Types T2/T3/T4/T6).",
  input_schema: {
    type: "object",
    properties: {
      branch_tables: {
        type: "array",
        items: {
          type: "object",
          properties: {
            branch_type: { type: "string" },
            header_size: { type: "string" },
            branch_size: { type: "string" },
            fitting_type: { type: "string" },
          },
          required: ["branch_type", "header_size", "branch_size"],
        },
      },
    },
    required: ["branch_tables"],
  },
};
