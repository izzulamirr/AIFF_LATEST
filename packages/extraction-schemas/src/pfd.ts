import { PAGE_RANGE_SCHEMA, type ClaudeTool } from "./common";

// PFDs are usually one sheet per process area, similar in structure to P&IDs
// but coarser-grained (major equipment + key streams, not every valve/instrument).
export const LOCATE_PFD_SECTIONS_TOOL: ClaudeTool = {
  name: "locate_pfd_sheets",
  description: "Identifies which page(s) contain each PFD sheet/process area, keyed by sheet number.",
  input_schema: {
    type: "object",
    properties: {
      sheets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            sheet_number: { type: "string" },
            process_area: { type: "string" },
            pages: PAGE_RANGE_SCHEMA,
          },
          required: ["sheet_number", "pages"],
        },
      },
    },
    required: ["sheets"],
  },
};

export const PFD_SHEET_TOOL: ClaudeTool = {
  name: "record_pfd_sheet",
  description: "Records major equipment and key process streams visible on one PFD sheet.",
  input_schema: {
    type: "object",
    properties: {
      equipment: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tag_number: { type: "string" },
            equipment_type: { type: "string" },
            description: { type: "string" },
          },
          required: ["tag_number"],
        },
      },
      streams: {
        type: "array",
        items: {
          type: "object",
          properties: {
            stream_number: { type: "string" },
            design_temp: { type: "string" },
            design_pressure: { type: "string" },
          },
          required: ["stream_number"],
        },
      },
    },
    required: ["equipment"],
  },
};
