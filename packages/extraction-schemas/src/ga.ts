import { PAGE_RANGE_SCHEMA, type ClaudeTool } from "./common";

// General Arrangement drawings, for this platform's purposes, are read for
// pipe routing and support info -- not equipment tags -- so an ISO's lines
// can be checked for physical routing/support consistency.
export const LOCATE_GA_SECTIONS_TOOL: ClaudeTool = {
  name: "locate_ga_sheets",
  description: "Identifies which page(s) contain each General Arrangement drawing sheet, keyed by its drawing number.",
  input_schema: {
    type: "object",
    properties: {
      sheets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            drawing_number: { type: "string" },
            pages: PAGE_RANGE_SCHEMA,
          },
          required: ["drawing_number", "pages"],
        },
      },
    },
    required: ["sheets"],
  },
};

export const GA_SHEET_TOOL: ClaudeTool = {
  name: "record_ga_sheet",
  description: "Records pipe routing and pipe support rows visible on one General Arrangement sheet.",
  input_schema: {
    type: "object",
    properties: {
      pipe_routing: {
        type: "array",
        items: {
          type: "object",
          properties: {
            line_number: { type: "string" },
            size: { type: "string" },
            route_description: { type: "string" },
          },
          required: ["line_number"],
        },
      },
      supports: {
        type: "array",
        items: {
          type: "object",
          properties: {
            support_tag: { type: "string" },
            support_type: { type: "string" },
            line_number: { type: "string" },
          },
          required: ["support_tag"],
        },
      },
    },
    required: ["pipe_routing"],
  },
};
