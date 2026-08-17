import type { ExtractorRegistry } from "./types";
import { extractPidDocument } from "./pid";
import { extractHmbDocument } from "./hmb";
import { extractPfdDocument } from "./pfd";
import { extractSpecSheetDocument } from "./specSheet";
import { extractIsoDocument } from "./iso";
import { extractGaDocument } from "./ga";
import { extractPllDocument } from "./pll";
import { extractPidLegendDocument } from "./pidLegend";

export const EXTRACTORS: ExtractorRegistry = {
  pid: extractPidDocument,
  hmb: extractHmbDocument,
  pfd: extractPfdDocument,
  spec_sheet: extractSpecSheetDocument,
  iso: extractIsoDocument,
  ga: extractGaDocument,
  pll: extractPllDocument,
  pid_legend: extractPidLegendDocument,
};

export * from "./types";
