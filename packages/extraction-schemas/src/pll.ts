import { PAGE_RANGE_SCHEMA, type ClaudeTool } from "./common";

// Process Line List (PLL): the authoritative per-line register -- gate 1
// and gate 2 of the ISO verification chain check every ISO against it
// (line existence, then design basis). Usually a genuine multi-page table
// with a real text layer, so text extraction is the primary path (unlike
// ISOs, which are vector CAD exports).
export const LOCATE_PLL_SECTIONS_TOOL: ClaudeTool = {
  name: "locate_pll_sections",
  description: "Identifies the page range(s) containing the process line list table in this document.",
  input_schema: {
    type: "object",
    properties: {
      line_table_pages: PAGE_RANGE_SCHEMA,
    },
    required: ["line_table_pages"],
  },
};

// Values carry their engineering unit inline, taken from the table's own
// column header (e.g. a "Design Temperature (°C)" column of 310 becomes
// "310 °C"). Gate 2's comparison parses the leading number, so the unit is
// for human readability and audit -- it never breaks the numeric compare.
// Where one cell holds two values (a line running to two destinations, a
// min/max pair spread over sub-columns), they are joined with " / " -- never
// a newline, which is unreadable in the findings table and in JSON.
export const PLL_TABLE_TOOL: ClaudeTool = {
  name: "record_pll_table",
  description:
    "Records per-line rows from a process line list table. Append the unit from the column header to every measured value (e.g. \"310 °C\", \"150 barg\", \"200 mm\"). If one cell contains two or more values, join them with \" / \" -- never a line break.",
  input_schema: {
    type: "object",
    properties: {
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            line_number: { type: "string" },
            fluid_code: { type: "string" },
            size: { type: "string", description: 'Nominal size with unit, e.g. "200 mm" or "2\\""' },
            spec_class: { type: "string", description: 'Piping class, e.g. "15S2F" or "150JY11"' },
            insulation_code: { type: "string" },
            insulation_thickness: { type: "string", description: 'With unit, e.g. "25 mm"' },
            from_location: { type: "string", description: 'If several, join with " / "' },
            to_location: { type: "string", description: 'If several, join with " / "' },
            design_pressure: { type: "string", description: 'Governing/maximum design pressure with unit, e.g. "150 barg"' },
            design_pressure_min: { type: "string", description: 'Minimum design pressure with unit, if the table gives a min/max pair, e.g. "-1 barg"' },
            design_temperature: { type: "string", description: 'Governing/maximum design temperature with unit, e.g. "310 °C"' },
            design_temperature_min: { type: "string", description: 'Minimum design temperature with unit, e.g. "200 °C"' },
            operating_pressure: { type: "string", description: "With unit" },
            operating_temperature: { type: "string", description: "With unit" },
            test_pressure: { type: "string", description: 'Hydrotest pressure with unit, e.g. "225 barg"' },
            test_medium: { type: "string" },
            service: { type: "string" },
            heat_trace: { type: "string", description: 'e.g. "ET" or "NT"' },
            hold: { type: "string", description: 'Any hold flag on this line, e.g. "HOLD 3"' },
            ndt_percent: { type: "string", description: 'With unit, e.g. "10 %"' },
            pwht: { type: "string" },
            paint_system: { type: "string" },
            corrosion_allowance: { type: "string", description: 'With unit, e.g. "3 mm"' },
            slope: { type: "string", description: 'Required pipe slope for this line if the list has a slope column, e.g. "1:100". Blank if none.' },
            pid_no: { type: "string", description: 'If the line appears on several P&IDs, join them with " / "' },
          },
          required: ["line_number"],
        },
      },
    },
    required: ["lines"],
  },
};
