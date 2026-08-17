import { PAGE_RANGE_SCHEMA, type ClaudeTool } from "./common";

// H&MBs are usually one wide stream table spanning several pages -- locate
// the table's page range, then extract per-stream rows.
export const LOCATE_HMB_SECTIONS_TOOL: ClaudeTool = {
  name: "locate_hmb_sections",
  description: "Identifies the page range containing the Heat & Mass Balance stream table(s) in this document.",
  input_schema: {
    type: "object",
    properties: {
      stream_table_pages: PAGE_RANGE_SCHEMA,
    },
    required: ["stream_table_pages"],
  },
};

export const HMB_STREAM_TABLE_TOOL: ClaudeTool = {
  name: "record_hmb_stream_table",
  description: "Records per-stream-number rows from a Heat & Mass Balance table.",
  input_schema: {
    type: "object",
    properties: {
      streams: {
        type: "array",
        items: {
          type: "object",
          properties: {
            stream_number: { type: "string" },
            line_number: { type: "string" },
            flow_rate: { type: "string" },
            temperature: { type: "string" },
            pressure: { type: "string" },
            phase: { type: "string" },
            composition: { type: "string" },
          },
          required: ["stream_number"],
        },
      },
    },
    required: ["streams"],
  },
};
