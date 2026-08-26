import { and, desc, eq, inArray } from "drizzle-orm";
import { extractedTags, extractionJobs, findings, documents } from "@easy/db";
import {
  normalizeTagNumber,
  decodeLineNumber,
  enrichIsoLineAttrs,
  normalizeSlope,
  parsePressureRating,
  higherRating,
  type SpecBreakEntry,
} from "@easy/shared";
import { getDb } from "./db";

type ExtractedTag = typeof extractedTags.$inferSelect;
type Finding = typeof findings.$inferInsert;

export interface VerifyIsoBomInput {
  projectId: string;
  isoDocumentId: string;
  pllDocumentId?: string;
  specDocumentId?: string;
  // A single ISO line commonly runs across several P&ID sheets/documents
  // (continued via "CONT'D FROM/ON" off-page connectors) -- gate 3 checks
  // every selected P&ID, not just one, and traces the line across all of
  // them rather than only the last match found.
  pidDocumentIds?: string[];
  gaDocumentId?: string;
}

// Gate-ordered ISO verification chain, per the piping QA workflow:
//   0. Document/admin (title block completeness)
//   1. Line exists in the PLL (fail = stop)
//   2. Design basis, ISO title block vs PLL (class mismatch = stop)
//   3. P&ID cross-check
//   4. Spec compliance (material etc. per class)
//   5. Geometry/drafting  -- NOT verifiable from extracted data, skipped
//   6. Supports
//   7. BOM internal consistency (item codes resolve to spec catalogue)
//   8. GA routing
// Checks that need data we don't extract (north arrow, holds, dimensional
// closure, weld counts, coordinates, quantities-counted-vs-stated, MTO
// roll-up, clash detection) are intentionally NOT approximated -- a check
// that can't actually be performed must not silently "pass".
//
// fieldChecked is prefixed "N." with the gate number so the UI can group
// and order findings by gate.
export async function verifyIsoBom(input: VerifyIsoBomInput): Promise<{ findingsCreated: number }> {
  const { projectId, isoDocumentId, pllDocumentId, specDocumentId, pidDocumentIds, gaDocumentId } = input;
  const pidDocIds = (pidDocumentIds ?? []).filter(Boolean);
  const db = getDb();

  const docIds = [isoDocumentId, pllDocumentId, specDocumentId, ...pidDocIds, gaDocumentId].filter((id): id is string => Boolean(id));
  const allTags = await db.select().from(extractedTags).where(inArray(extractedTags.documentId, docIds));

  const docNameById = new Map(
    pidDocIds.length > 0 ? (await db.select().from(documents).where(inArray(documents.id, pidDocIds))).map((d) => [d.id, d.fileName] as const) : []
  );

  const isoLines = mergeIsoLineSheets(allTags.filter((t) => t.documentId === isoDocumentId && t.tagType === "line"));
  const isoBomItems = allTags.filter((t) => t.documentId === isoDocumentId && t.tagType === "bom_item");
  const pllLines = pllDocumentId ? allTags.filter((t) => t.documentId === pllDocumentId && t.tagType === "line") : [];
  const specClasses = specDocumentId ? allTags.filter((t) => t.documentId === specDocumentId && t.tagType === "spec_class") : [];
  const pidLines = pidDocIds.length > 0 ? allTags.filter((t) => pidDocIds.includes(t.documentId) && t.tagType === "line") : [];
  const pidValves = pidDocIds.length > 0 ? allTags.filter((t) => pidDocIds.includes(t.documentId) && t.tagType === "valve") : [];
  const pidFittings = pidDocIds.length > 0 ? allTags.filter((t) => pidDocIds.includes(t.documentId) && t.tagType === "fitting") : [];
  const pidInstruments = pidDocIds.length > 0 ? allTags.filter((t) => pidDocIds.includes(t.documentId) && t.tagType === "instrument") : [];
  const gaLines = gaDocumentId ? allTags.filter((t) => t.documentId === gaDocumentId && t.tagType === "line") : [];
  const gaSupports = gaDocumentId ? allTags.filter((t) => t.documentId === gaDocumentId && t.tagType === "support") : [];

  const specByNorm = new Map(specClasses.map((s) => [normalizeTagNumber(s.tagNumber), s] as const));
  const pllByNorm = new Map<string, ExtractedTag[]>();
  for (const l of pllLines) {
    const key = l.tagNumberNormalized;
    const list = pllByNorm.get(key);
    if (list) list.push(l);
    else pllByNorm.set(key, [l]);
  }
  // Every occurrence of a line number is kept, not just the last one seen
  // -- the same physical line legitimately appears on multiple P&ID sheets
  // (and across multiple P&ID documents) as it's traced from start to end.
  const pidByNorm = new Map<string, ExtractedTag[]>();
  for (const l of pidLines) {
    const key = l.tagNumberNormalized;
    const list = pidByNorm.get(key);
    if (list) list.push(l);
    else pidByNorm.set(key, [l]);
  }
  const gaByNorm = new Map(gaLines.map((l) => [l.tagNumberNormalized, l] as const));

  // Legend "P&ID REPRESENTATION vs DETAILS" typicals: the P&ID draws one
  // simplified instrument bubble, but the legend's details column says what
  // the assembly really contains (orifice plate + isolation valves, TW
  // thermowell + spec break, ...) -- parts that appear on the ISO even
  // though the P&ID never draws them. Fetched project-wide because the legend
  // is its own document rather than one of the selected docs -- but strictly
  // within THIS project, and from only its newest legend document, so a
  // duplicate legend upload cannot double-count typicals.
  const allLegendItems = await db
    .select()
    .from(extractedTags)
    .where(and(eq(extractedTags.projectId, projectId), eq(extractedTags.tagType, "legend_item")));
  const legendDocumentIds = [...new Set(allLegendItems.map((t) => t.documentId))];
  let scopedLegendItems = allLegendItems;
  if (legendDocumentIds.length > 1) {
    const [newestLegend] = await db
      .select({ id: documents.id })
      .from(documents)
      .where(inArray(documents.id, legendDocumentIds))
      .orderBy(desc(documents.uploadedAt))
      .limit(1);
    if (newestLegend) scopedLegendItems = allLegendItems.filter((t) => t.documentId === newestLegend.id);
  }
  const legendTypicals = scopedLegendItems.filter((t) => {
    const a = t.attributes as Record<string, unknown>;
    return typeof a.implied_components === "string" && a.implied_components.trim().length > 0;
  });
  const typicalFor = (instrumentTag: string): ExtractedTag | undefined => {
    const prefix = (instrumentTag.trim().toUpperCase().match(/^[A-Z]+/) ?? [])[0];
    if (!prefix) return undefined;
    return legendTypicals.find((t) => {
      const applies = String((t.attributes as Record<string, unknown>).applies_to ?? "");
      return applies
        .toUpperCase()
        .split("/")
        .map((s) => s.trim())
        .includes(prefix);
    });
  };

  const out: Finding[] = [];
  let stopped = false;

  // ---- Gate 0: Document / admin --------------------------------------
  // Title block completeness on the ISO itself. North arrow, hold flags,
  // transmittal revision match, and continuation-sheet back-links are not
  // extractable from the current pipeline -- not checked.
  // Title-block fields blank on the drawing but decodable from the line
  // number convention (size-service-class-unique-insulation-heattrace) are
  // filled from the decode before any gate runs.
  const isoAttrsByTagId = new Map<number, Record<string, unknown>>(
    isoLines.map((line) => [line.id, enrichIsoLineAttrs(line.tagNumber, line.attributes as Record<string, unknown>)] as const)
  );

  const REQUIRED_TITLE_BLOCK_FIELDS = ["document_number", "drawing_number", "revision", "sheet", "spec_class", "size"] as const;
  for (const line of isoLines) {
    const attrs = isoAttrsByTagId.get(line.id)!;
    for (const field of REQUIRED_TITLE_BLOCK_FIELDS) {
      if (isBlank(attrs[field])) {
        out.push(makeFinding(projectId, line, isoDocumentId, undefined, `0.${field}`, null, null, "warning", `Title block field "${field}" is missing/blank on the ISO.`));
      }
    }
  }

  // ---- Gate 1: Line exists (PLL) -- fail = stop -----------------------
  if (!pllDocumentId) {
    if (isoLines[0]) {
      out.push(
        makeFinding(projectId, isoLines[0], isoDocumentId, undefined, "1.line_exists", null, null, "info", "Gate 1 skipped: no Process Line List (PLL) document selected. Upload a PLL and select it to run gates 1-2.")
      );
    }
  } else {
    for (const line of isoLines) {
      const attrs = isoAttrsByTagId.get(line.id)!;
      const matches = pllByNorm.get(line.tagNumberNormalized) ?? [];

      if (matches.length === 0) {
        out.push(makeFinding(projectId, line, isoDocumentId, pllDocumentId, "1.line_exists", line.tagNumber, null, "error", `ISO line ${line.tagNumber} was not found in the PLL. Chain stopped.`));
        stopped = true;
        continue;
      }
      if (matches.length > 1) {
        out.push(makeFinding(projectId, line, isoDocumentId, pllDocumentId, "1.duplicates", line.tagNumber, String(matches.length), "warning", `Line ${line.tagNumber} appears ${matches.length} times in the PLL.`));
      }

      // Line number decode: the size/class encoded in the line number must
      // agree with the title block's own fields. Uses the segment decoder
      // where the convention fits, and falls back to a substring check for
      // other numbering conventions.
      const decoded = decodeLineNumber(line.tagNumber);
      if (decoded) {
        const sizeNum = parseNumber(attrs.size);
        if (sizeNum != null && sizeNum !== decoded.sizeMm) {
          out.push(
            makeFinding(projectId, line, isoDocumentId, undefined, "1.decode_size", String(attrs.size), decoded.size, "warning", `Title block size "${attrs.size}" disagrees with the size encoded in line number "${line.tagNumber}".`)
          );
        }
        if (!isBlank(attrs.spec_class) && normalizeTagNumber(String(attrs.spec_class)) !== normalizeTagNumber(decoded.spec_class)) {
          out.push(
            makeFinding(projectId, line, isoDocumentId, undefined, "1.decode_class", String(attrs.spec_class), decoded.spec_class, "warning", `Title block class "${attrs.spec_class}" disagrees with the class encoded in line number "${line.tagNumber}".`)
          );
        }
      } else {
        const norm = (v: unknown) => normalizeTagNumber(String(v ?? "")).replace(/[^A-Z0-9"]/g, "");
        const lineNorm = norm(line.tagNumber);
        for (const [field, label] of [
          ["size", "size"],
          ["spec_class", "class"],
        ] as const) {
          const value = attrs[field];
          if (!isBlank(value) && !lineNorm.includes(norm(value))) {
            out.push(
              makeFinding(projectId, line, isoDocumentId, undefined, `1.decode_${label}`, String(value), line.tagNumber, "warning", `The ${label} "${value}" from the title block does not appear in line number "${line.tagNumber}".`)
            );
          }
        }
      }

      const pll = matches[0];
      const pllAttrs = pll.attributes as Record<string, unknown>;
      compareNumeric(out, projectId, line, isoDocumentId, pllDocumentId, "1.size", attrs.size, pllAttrs.size, "error");
      // From/To: the ISO extraction currently has no from/to fields, so
      // this workflow item can't be checked yet -- see gap notes.
    }

    // NOTE: the workflow's reverse check (PLL lines with no ISO) is
    // intentionally NOT emitted -- with a full project line list it floods
    // the findings with hundreds of rows about lines this ISO doesn't
    // touch, which the user explicitly doesn't want here. It belongs at
    // project level once all ISOs are in, not on a single ISO's report.
  }

  // ---- Gate 2: Design basis (ISO title block vs PLL) -------------------
  // Class mismatch = stop. Blank on either side is skipped, not a mismatch.
  if (!stopped && pllDocumentId) {
    for (const line of isoLines) {
      const attrs = isoAttrsByTagId.get(line.id)!;
      const pll = (pllByNorm.get(line.tagNumberNormalized) ?? [])[0];
      if (!pll) continue; // gate 1 already flagged it
      const pllAttrs = pll.attributes as Record<string, unknown>;

      if (!isBlank(attrs.spec_class) && !isBlank(pllAttrs.spec_class) && normalizeTagNumber(String(attrs.spec_class)) !== normalizeTagNumber(String(pllAttrs.spec_class))) {
        out.push(
          makeFinding(projectId, line, isoDocumentId, pllDocumentId, "2.piping_class", String(attrs.spec_class), String(pllAttrs.spec_class), "error", `Piping class mismatch between ISO and PLL for line ${line.tagNumber}. Chain stopped.`)
        );
        stopped = true;
        continue;
      }

      compareNumeric(out, projectId, line, isoDocumentId, pllDocumentId, "2.design_pressure", attrs.design_pressure, pllAttrs.design_pressure, "error");
      compareNumeric(out, projectId, line, isoDocumentId, pllDocumentId, "2.design_temperature", attrs.design_temperature, pllAttrs.design_temperature, "error");
      compareNumeric(out, projectId, line, isoDocumentId, pllDocumentId, "2.operating_pressure", attrs.operating_pressure, pllAttrs.operating_pressure, "warning");
      compareNumeric(out, projectId, line, isoDocumentId, pllDocumentId, "2.operating_temperature", attrs.operating_temperature, pllAttrs.operating_temperature, "warning");
      compareNumeric(out, projectId, line, isoDocumentId, pllDocumentId, "2.test_pressure", attrs.hydrotest_pressure, pllAttrs.test_pressure, "error");
      compareText(out, projectId, line, isoDocumentId, pllDocumentId, "2.service", attrs.service, pllAttrs.service, "warning");
      compareText(out, projectId, line, isoDocumentId, pllDocumentId, "2.paint_system", attrs.painting_system, pllAttrs.paint_system, "warning");
      compareNumeric(out, projectId, line, isoDocumentId, pllDocumentId, "2.insulation_thickness", attrs.insul_thickness_mm, pllAttrs.insulation_thickness, "warning");
      compareText(out, projectId, line, isoDocumentId, pllDocumentId, "2.insulation_code", attrs.insul_spec, pllAttrs.insulation_code, "warning");
      compareText(out, projectId, line, isoDocumentId, pllDocumentId, "2.pwht", attrs.pwht, pllAttrs.pwht, "warning");
      compareNumeric(out, projectId, line, isoDocumentId, pllDocumentId, "2.ndt_percent", attrs.radiograph, pllAttrs.ndt_percent, "warning");
      compareText(out, projectId, line, isoDocumentId, pllDocumentId, "2.heat_trace", attrs.heat_trace, pllAttrs.heat_trace, "warning");
      // Slope: both sides are canonicalized to "1:100" at extraction
      // (normalizeSlope), so a plain text compare is correct here. The ISO
      // side is a printed annotation, never measured from geometry.
      compareText(out, projectId, line, isoDocumentId, pllDocumentId, "2.slope", attrs.slope, pllAttrs.slope, "warning");
    }
  }

  // ---- Gate 3: P&ID ----------------------------------------------------
  // Traces each ISO line across every selected P&ID (a physical line
  // commonly spans several P&ID sheets/documents via off-page "CONT'D
  // FROM/ON" connectors) -- every occurrence is checked, not just one.
  if (!stopped && pidDocIds.length > 0) {
    for (const line of isoLines) {
      const attrs = isoAttrsByTagId.get(line.id)!;
      const matches = pidByNorm.get(line.tagNumberNormalized) ?? [];
      if (matches.length === 0) {
        out.push(
          makeFinding(projectId, line, isoDocumentId, pidDocIds[0], "3.line_on_pid", line.tagNumber, null, "error", `Line ${line.tagNumber} on the ISO was not found on any of the ${pidDocIds.length} selected P&ID(s).`)
        );
        continue;
      }

      // Trace summary: every sheet/document this line was found on, so a
      // line legitimately split across 2-5 P&IDs is visibly confirmed as
      // followed end to end, not just matched once.
      const trace = matches
        .map((m) => {
          const sheet = (m.attributes as Record<string, unknown>).sheet_number;
          const docName = docNameById.get(m.documentId) ?? m.documentId;
          return sheet ? `${docName} (sheet ${sheet})` : docName;
        })
        .join(", ");
      out.push(makeFinding(projectId, line, isoDocumentId, matches[0].documentId, "3.line_trace", line.tagNumber, String(matches.length), "info", `Found on: ${trace}`));

      // PLL coverage: the line list's own P&ID column is the authoritative
      // statement of which drawings this line appears on. Every drawing it
      // names must be found among the selected P&IDs' occurrences -- matched
      // against both the extracted title-block drawing number and the
      // uploaded file's name, so a file whose content is a different drawing
      // than its filename claims is caught either way.
      const pllForLine = (pllByNorm.get(line.tagNumberNormalized) ?? [])[0];
      const pllPidNo = pllForLine ? (pllForLine.attributes as Record<string, unknown>).pid_no : undefined;
      if (typeof pllPidNo === "string" && !isBlank(pllPidNo)) {
        const foundRefs = matches.flatMap((m) => {
          const sheet = (m.attributes as Record<string, unknown>).sheet_number;
          return [typeof sheet === "string" ? normalizeTagNumber(sheet) : "", normalizeTagNumber(docNameById.get(m.documentId) ?? "")];
        });
        for (const expected of pllPidNo.split("/").map((s) => s.trim()).filter(Boolean)) {
          const expectedNorm = normalizeTagNumber(expected);
          const covered = foundRefs.some((ref) => ref && (ref.includes(expectedNorm) || expectedNorm.includes(ref)));
          if (!covered) {
            out.push(
              makeFinding(projectId, line, isoDocumentId, pllDocumentId, "3.pid_coverage", null, expected, "error", `The PLL says line ${line.tagNumber} appears on P&ID "${expected}", but that drawing was not found among the selected P&ID(s) -- either it wasn't selected/uploaded, or an uploaded file contains a different drawing than its name claims.`)
            );
          }
        }
      }

      // Trace completeness: an occurrence whose off-page connector says the
      // line continues on another drawing means there should be at least one
      // more occurrence among the selected P&IDs. A single occurrence with a
      // continuation reference is a trace that stops mid-line -- the
      // continuation sheet is missing from the selection (or not extracted).
      const continuationRefs = matches
        .map((m) => (m.attributes as Record<string, unknown>).continues_on)
        .filter((v): v is string => typeof v === "string" && !isBlank(v));
      if (continuationRefs.length > 0 && matches.length === 1) {
        out.push(
          makeFinding(projectId, line, isoDocumentId, matches[0].documentId, "3.continuation", line.tagNumber, continuationRefs.join(" / "), "warning", `Line ${line.tagNumber} continues onto drawing(s) ${continuationRefs.join(" / ")} via off-page connector, but no other occurrence was found among the selected P&ID(s) -- the trace stops mid-line. Select/upload the continuation P&ID.`)
        );
      }

      // Slope: printed on the P&ID next to the line (e.g. "1:100" with a
      // triangle symbol) vs the ISO's own slope annotation. Both are
      // canonicalized (normalizeSlope) so "1 IN 100" and "1:100" agree.
      // A P&ID-required slope that the ISO doesn't carry at all is a
      // MISMATCH, not a skip -- the P&ID is the requirement and a blank ISO
      // means the ISO is wrong (missing the slope annotation).
      for (const match of matches) {
        const matchAttrs = match.attributes as Record<string, unknown>;
        if (isBlank(matchAttrs.slope)) continue;
        const pidSlope = normalizeSlope(String(matchAttrs.slope));
        const sheet = matchAttrs.sheet_number ? ` (${docNameById.get(match.documentId) ?? match.documentId}, sheet ${matchAttrs.sheet_number})` : "";
        if (isBlank(attrs.slope)) {
          out.push(
            makeFinding(projectId, line, isoDocumentId, match.documentId, "3.slope", null, pidSlope, "error", `P&ID${sheet} requires slope ${pidSlope} on line ${line.tagNumber}, but the ISO carries no slope annotation -- the ISO is missing it.`)
          );
        } else {
          compareText(out, projectId, line, isoDocumentId, match.documentId, "3.slope", normalizeSlope(String(attrs.slope)), pidSlope, "error", `Slope disagrees with P&ID${sheet}.`);
        }
      }

      // Size must agree at every occurrence along the line's path, not
      // just the first one matched -- a size mismatch partway through the
      // route is exactly what "reading start to end" is meant to catch.
      // Unit-aware (P&IDs often print a bare number, e.g. "350" for
      // "350 mm") so a formatting difference alone isn't a false positive.
      for (const match of matches) {
        const matchAttrs = match.attributes as Record<string, unknown>;
        const sheet = matchAttrs.sheet_number ? ` (${docNameById.get(match.documentId) ?? match.documentId}, sheet ${matchAttrs.sheet_number})` : "";
        compareNumeric(out, projectId, line, isoDocumentId, match.documentId, "3.size", attrs.size, matchAttrs.size, "warning", `Size disagrees on P&ID${sheet}.`);
      }

      // Routing: the ISO's line endpoints (from/to) should correspond to
      // the P&ID's from/to for the same line, taken across every sheet the
      // line was traced through (the "from" is on the first sheet, the "to"
      // on the last). Equipment naming differs between an ISO (nozzle/tie-in
      // callout) and a P&ID (equipment tag), so this is a lenient
      // normalized-containment check surfaced as a warning, not an error.
      const pidLineAttrsForRoute = matches.map((m) => m.attributes as Record<string, unknown>);
      const endpoints = pidEndpointSet(pidLineAttrsForRoute);
      if (endpoints.size > 0) {
        for (const [field, value, label] of [
          ["3.route_from", attrs.from_location, "from"],
          ["3.route_to", attrs.to_location, "to"],
        ] as const) {
          if (isBlank(value)) continue;
          // A continuation reference names another drawing, not equipment --
          // nothing on the P&ID to compare it against, so it's reported as
          // information rather than a mismatch.
          if (isContinuationRef(value)) {
            out.push(
              makeFinding(projectId, line, isoDocumentId, matches[0].documentId, field, String(value), null, "info", `ISO "${label}" endpoint for line ${line.tagNumber} is a continuation reference to another drawing, so it can't be compared with the P&ID's equipment -- follow it onto that drawing to close the trace.`)
            );
            continue;
          }
          if (!endpointInSet(value, endpoints)) {
            out.push(
              makeFinding(projectId, line, isoDocumentId, matches[0].documentId, field, String(value), [...endpoints].join(" / "), "warning", `ISO "${label}" endpoint for line ${line.tagNumber} does not correspond to any P&ID endpoint for this line.`)
            );
          }
        }
      }

      // Component presence, both directions, at the granularity the
      // extractions support: P&ID valves/instruments referencing this line
      // (across all selected P&IDs) vs. ISO BOM valve/instrument items.
      // The ISO BOM has counts and item codes but usually no per-valve tag
      // numbers, so this compares counts and instrument tags -- it can't
      // match individual untagged valves.
      const lineNorm = line.tagNumberNormalized;
      const refersToLine = (t: ExtractedTag, key: string) => {
        const ref = (t.attributes as Record<string, unknown>)[key];
        return typeof ref === "string" && normalizeTagNumber(ref) === lineNorm;
      };
      // Valves are matched across the spec break -- past it the run carries a
      // different line number, but those valves are still on this drawing.
      const specClasses = isoSpecClasses(isoAttrsByTagId.get(line.id)!);
      const pidLineValves = pidValves.filter((v) =>
        matchesLineAcrossSpecBreak((v.attributes as Record<string, unknown>).line_number, line.tagNumber, specClasses)
      );
      const pidLineInstruments = pidInstruments.filter((i) => refersToLine(i, "line_or_equipment_ref"));

      const bomForLine = isoBomItems.filter((b) => {
        const ln = (b.attributes as Record<string, unknown>).line_number;
        return typeof ln === "string" && normalizeTagNumber(ln) === lineNorm;
      });
      const bomValveCount = bomForLine
        .filter((b) => String((b.attributes as Record<string, unknown>).component_type ?? "").toLowerCase().includes("valve"))
        .reduce((sum, b) => sum + (parseNumber((b.attributes as Record<string, unknown>).quantity) ?? 1), 0);

      // By quantity, not by row: one valve row can stand for several
      // identical valves, and untagged hand valves count like tagged ones.
      const pidValveCount = countPidValves(pidLineValves.map((v) => v.attributes as Record<string, unknown>));
      if (pidValveCount > 0 && bomValveCount < pidValveCount) {
        out.push(
          makeFinding(projectId, line, isoDocumentId, matches[0].documentId, "3.valves", String(bomValveCount), String(pidValveCount), "warning", `Across all selected P&IDs, ${pidValveCount} valve(s) are shown on line ${line.tagNumber}, but the ISO BOM only lists ${bomValveCount}.`)
        );
      }

      for (const instrument of pidLineInstruments) {
        // Assembly accessories are part of their primary device, supplied
        // with it -- they are not separate ISO BOM items and must not each
        // be flagged as "missing from the BOM". Covers valve-actuator
        // accessories (parent_valve: ZI/ZIT/ZC/ZSO/ZSC/XY...) and
        // instrument-on-instrument mounts (parent_instrument: a TT in its
        // TW thermowell). Only the primary itself gets checked.
        const instAttrs = instrument.attributes as Record<string, unknown>;
        if (!isBlank(instAttrs.parent_valve) || !isBlank(instAttrs.parent_instrument)) continue;
        const instNorm = normalizeTagNumber(instrument.tagNumber);
        const onIso = bomForLine.some((b) => {
          const a = b.attributes as Record<string, unknown>;
          return (typeof a.item_code === "string" && normalizeTagNumber(a.item_code).includes(instNorm)) || (typeof a.description === "string" && normalizeTagNumber(a.description).includes(instNorm));
        });
        if (!onIso) {
          out.push(
            makeFinding(projectId, line, isoDocumentId, instrument.documentId, "3.instrument", null, instrument.tagNumber, "warning", `Instrument ${instrument.tagNumber} on the P&ID (line ${line.tagNumber}) was not found in the ISO BOM.`)
          );
        }
      }

      // Simplified-representation expansion: for each primary instrument on
      // this line, the legend's typical says which real components the P&ID
      // symbol hides. Emit the expansion as info, then check the ISO BOM for
      // the strongly-named implied parts (thermowell, orifice, diaphragm
      // seal, isolation valves) -- the P&ID simplifies, the ISO must not.
      for (const instrument of pidLineInstruments) {
        const instAttrs = instrument.attributes as Record<string, unknown>;
        if (!isBlank(instAttrs.parent_valve) || !isBlank(instAttrs.parent_instrument)) continue;
        const typical = typicalFor(instrument.tagNumber);
        if (!typical) continue;
        const implied = String((typical.attributes as Record<string, unknown>).implied_components);
        out.push(
          makeFinding(projectId, line, isoDocumentId, typical.documentId, "3.typical", instrument.tagNumber, implied, "info", `Per the legend's "${typical.tagNumber}" typical, the simplified P&ID symbol ${instrument.tagNumber} implies these parts on the ISO: ${implied}.`)
        );

        const bomText = bomForLine.map((b) => `${(b.attributes as Record<string, unknown>).description ?? ""}`.toLowerCase()).join(" | ");
        const impliedLower = implied.toLowerCase();
        const KEYWORD_CHECKS: Array<{ pattern: RegExp; bomPattern: RegExp; label: string }> = [
          { pattern: /thermowell|thermo\s*well/, bomPattern: /thermowell|thermo\s*well|\btw\b/, label: "thermowell" },
          { pattern: /orifice/, bomPattern: /orifice/, label: "orifice plate/flanges" },
          { pattern: /diaphragm/, bomPattern: /diaphragm/, label: "diaphragm seal" },
        ];
        for (const check of KEYWORD_CHECKS) {
          if (check.pattern.test(impliedLower) && !check.bomPattern.test(bomText)) {
            out.push(
              makeFinding(projectId, line, isoDocumentId, typical.documentId, "3.typical_parts", instrument.tagNumber, check.label, "warning", `${instrument.tagNumber} implies a ${check.label} on line ${line.tagNumber} (legend typical "${typical.tagNumber}"), but nothing matching was found in the ISO BOM.`)
            );
          }
        }
        if (/isolation valve/.test(impliedLower) && bomValveCount === 0) {
          out.push(
            makeFinding(projectId, line, isoDocumentId, typical.documentId, "3.typical_parts", instrument.tagNumber, "isolation valve(s)", "warning", `${instrument.tagNumber} implies isolation valve(s) on line ${line.tagNumber} (legend typical "${typical.tagNumber}"), but the ISO BOM lists no valves.`)
          );
        }
      }

      // Fitting count on the line, from the ISO BOM (attributes, not tag
      // rows -- passing the rows left every category at zero). Categories
      // the P&ID also draws (flange joints, blinds, reducers...) are
      // compared min-basis: a P&ID draws only SOME flanges (breaks, blinds,
      // nozzle mating flanges), so its count is a floor the ISO BOM must
      // meet, never an exact target. Elbows/tees stay ISO-only info.
      const tally = tallyFittings(bomForLine.map((b) => b.attributes as Record<string, unknown>));
      const fittingSummary = [...tally.entries()]
        .filter(([, c]) => c > 0)
        .map(([k, c]) => `${k}: ${c}`)
        .join(", ");
      if (fittingSummary) {
        out.push(makeFinding(projectId, line, isoDocumentId, undefined, "3.fittings", fittingSummary, null, "info", `Fittings counted on the ISO BOM for line ${line.tagNumber}.`));
      }

      const pidLineFittings = pidFittings.filter((f) => refersToLine(f, "line_number"));
      const pidFittingTally = tallyFittings(
        pidLineFittings.map((f) => {
          const a = f.attributes as Record<string, unknown>;
          return { component_type: a.fitting_type, description: `${a.fitting_type ?? ""} ${a.size ?? ""}`, quantity: a.quantity };
        })
      );
      for (const [category, pidCount] of pidFittingTally) {
        if (category === "valves" || pidCount <= 0) continue; // valves already cross-checked above
        const isoCount = tally.get(category) ?? 0;
        if (isoCount < pidCount) {
          out.push(
            makeFinding(projectId, line, isoDocumentId, pidLineFittings[0]?.documentId, `3.${category}`, String(isoCount), String(pidCount), "warning", `The selected P&ID(s) draw ${pidCount} ${category} on line ${line.tagNumber}, but the ISO BOM only lists ${isoCount} -- the P&ID only draws some ${category}, so its count is a minimum the ISO must meet.`)
          );
        }
      }
      // Flow direction, tie-in numbers, spec-break/drain/vent/blind
      // placement, and equipment/nozzle tag positions are not extractable
      // from the current pipeline -- not checked (see gap notes). Slope is
      // checked against the PLL in gate 2, not here.
    }
  }

  // ---- Gate 4: Specs ---------------------------------------------------
  // A drawing with a spec break carries two classes ("MATL <class>" callouts
  // either side of a joint), so each BOM item is governed by its own class,
  // not the title block's -- specForItem below resolves that per item.
  const specClassByLine = new Map<string, ExtractedTag | undefined>();
  const specBreaksByLine = new Map<string, SpecBreakEntry[]>();
  for (const line of isoLines) {
    const attrs = isoAttrsByTagId.get(line.id)!;
    const breaks = Array.isArray(attrs.spec_breaks) ? (attrs.spec_breaks as SpecBreakEntry[]) : [];
    if (breaks.length > 1) specBreaksByLine.set(line.tagNumber, breaks);
  }

  // The class governing one BOM item: its own item_spec_class when the
  // drawing has a break, else the line's class.
  const itemSpecCode = (attrs: Record<string, unknown>, lineNumber: string | undefined): string | undefined => {
    const own = typeof attrs.item_spec_class === "string" && attrs.item_spec_class.trim() ? attrs.item_spec_class : undefined;
    if (own) return own;
    if (lineNumber == null) return undefined;
    const lineAttrs = isoLines.find((l) => l.tagNumber === lineNumber);
    const lineSpec = lineAttrs ? isoAttrsByTagId.get(lineAttrs.id)?.spec_class : undefined;
    return typeof lineSpec === "string" ? lineSpec : undefined;
  };

  if (!stopped && specDocumentId) {
    for (const line of isoLines) {
      const attrs = isoAttrsByTagId.get(line.id)!;
      const specClassCode = typeof attrs.spec_class === "string" ? attrs.spec_class : undefined;
      if (!specClassCode) continue;
      const spec = specByNorm.get(normalizeTagNumber(specClassCode));
      specClassByLine.set(line.tagNumber, spec);
      if (!spec) {
        out.push(
          makeFinding(projectId, line, isoDocumentId, specDocumentId, "4.spec_class", specClassCode, null, "error", `Line ${line.tagNumber} references spec class "${specClassCode}", which was not found in the uploaded spec sheet.`)
        );
      }

      // Every class introduced by a spec break needs its own spec sheet, or
      // the items on that side of the break can't be checked at all.
      for (const entry of specBreaksByLine.get(line.tagNumber) ?? []) {
        if (isBlank(entry.spec_class) || normalizeTagNumber(entry.spec_class) === normalizeTagNumber(specClassCode)) continue;
        if (!specByNorm.get(normalizeTagNumber(entry.spec_class))) {
          out.push(
            makeFinding(projectId, line, isoDocumentId, specDocumentId, "4.break_spec_class", entry.spec_class, null, "error", `Line ${line.tagNumber} has a spec break to class "${entry.spec_class}"${entry.location_note ? ` (${entry.location_note})` : ""}, but no spec sheet for that class is uploaded -- items on that side of the break cannot be verified.`)
          );
        }
      }
    }

    // Spec-break joint rule: every component belongs to its own side of the
    // break -- the two mating flanges and the bolts each stay with their own
    // class. The single exception is the GASKET: one part sandwiched between
    // the two flanges, so it must be rate-matched to the HIGHER-rated class
    // (a 150#/300# break takes the 300# gasket).
    for (const line of isoLines) {
      const breaks = specBreaksByLine.get(line.tagNumber);
      if (!breaks || breaks.length < 2) continue;
      const ratings = breaks.map((b) => (b.rating == null ? null : Number(b.rating))).filter((r): r is number => r != null && Number.isFinite(r));
      if (ratings.length < 2) continue;
      const required = Math.max(...ratings);
      if (required === Math.min(...ratings)) continue; // same rating both sides: nothing to match up

      // The joint is rate-matched to the higher class: the lower side's mating
      // flange, the gasket between them and their bolts are all made to the
      // higher rating so they bolt together. (Those parts still BELONG to the
      // side they sit on -- a 300# flange upstream of a 150#/300# break is a
      // 150#-class item rated up -- which is why placement is by position and
      // only the RATING is checked here.)
      const lineNorm = normalizeTagNumber(line.tagNumber);
      const onLine = (b: ExtractedTag) => {
        const a = b.attributes as Record<string, unknown>;
        return typeof a.line_number === "string" && normalizeTagNumber(a.line_number) === lineNorm;
      };
      const bestRatingOf = (pattern: RegExp): number | null =>
        isoBomItems
          .filter((b) => {
            const a = b.attributes as Record<string, unknown>;
            return onLine(b) && pattern.test(`${a.component_type ?? ""} ${a.description ?? ""}`);
          })
          .reduce<number | null>((max, b) => {
            const a = b.attributes as Record<string, unknown>;
            return higherRating(max, parsePressureRating(`${a.description ?? ""} ${a.item_code ?? ""}`));
          }, null);

      for (const part of [
        { label: "flange", field: "4.break_flange_rating", pattern: /flange/i, why: "the two mating flanges at the break must be the same rating to bolt together" },
        { label: "gasket", field: "4.break_gasket_rating", pattern: /gasket/i, why: "the gasket at the break is a single part shared between both flanges" },
      ] as const) {
        const best = bestRatingOf(part.pattern);
        if (best == null || best >= required) continue;
        out.push(
          makeFinding(projectId, line, isoDocumentId, undefined, part.field, `${best}#`, `${required}#`, "error", `Line ${line.tagNumber} breaks between classes rated ${ratings.join("# / ")}#, and ${part.why}, so the break joint needs a ${required}# ${part.label} -- but the highest ${part.label} rating in the BOM is ${best}#.`)
        );
      }
    }

    for (const item of isoBomItems) {
      const attrs = item.attributes as Record<string, unknown>;
      const lineNumber = typeof attrs.line_number === "string" ? attrs.line_number : undefined;
      if (!lineNumber) continue;
      // The item's OWN class on a spec-break drawing, so a 300# flange is
      // checked against the 300# spec rather than the title block's 150# one.
      const ownCode = itemSpecCode(attrs, lineNumber);
      const spec = (ownCode ? specByNorm.get(normalizeTagNumber(ownCode)) : undefined) ?? specClassByLine.get(lineNumber);
      if (!spec) continue;

      const category = mapComponentCategory(typeof attrs.component_type === "string" ? attrs.component_type : undefined);
      if (!category) continue; // fasteners/supports/instruments: governed elsewhere, skipped (not silently passed as in-spec)

      const specAttrs = spec.attributes as Record<string, unknown>;
      const rows = (specAttrs[category] as Array<Record<string, unknown>>) ?? [];
      if (rows.length === 0) continue;

      const matchedRow = findSpecRow(rows, attrs.item_code);
      if (matchedRow) {
        // Wrong item: the code exists but the BOM's own fields contradict
        // what the spec row requires.
        compareText(out, projectId, item, isoDocumentId, specDocumentId, "4.material", attrs.material, matchedRow.material, "error");
      }
    }
  }

  // ---- Gate 5: Geometry / drafting --------------------------------------
  // Dimensional closure, continuity, coordinates/elevations, weld types and
  // counts, field-vs-shop welds, branch orientation, bolt hole orientation,
  // and size-change-without-reducer all require geometry the extraction
  // pipeline does not capture. Intentionally NOT checked -- no findings
  // emitted, so absence of findings here must not be read as a pass.

  // ---- Gate 6: Supports --------------------------------------------------
  if (!stopped) {
    const supportItems = isoBomItems.filter((b) => String((b.attributes as Record<string, unknown>).component_type ?? "").toLowerCase().includes("support"));
    for (const support of supportItems) {
      const attrs = support.attributes as Record<string, unknown>;
      const description = String(attrs.description ?? "");
      // Every support must carry a type designation (e.g. SW100, RB201).
      if (!/[A-Z]{1,3}\d{2,}/.test(description)) {
        out.push(makeFinding(projectId, support, isoDocumentId, undefined, "6.support_type", description, null, "warning", `Support BOM item ${support.tagNumber} has no recognizable support type designation.`));
      } else if (gaDocumentId && gaSupports.length > 0) {
        const typeMatch = description.match(/[A-Z]{1,3}\d{2,}/g) ?? [];
        const inGa = gaSupports.some((g) => {
          const gAttrs = g.attributes as Record<string, unknown>;
          const gText = `${g.tagNumber} ${String(gAttrs.support_type ?? "")}`;
          return typeMatch.some((t) => normalizeTagNumber(gText).includes(normalizeTagNumber(t)));
        });
        if (!inGa) {
          out.push(
            makeFinding(projectId, support, isoDocumentId, gaDocumentId, "6.support_in_ga", typeMatch.join(", "), null, "warning", `Support type(s) ${typeMatch.join(", ")} from ISO BOM item ${support.tagNumber} not found among the GA's supports.`)
          );
        }
      }
    }
    // Support standard and stress-isometric cross-checks need those document
    // types, which don't exist yet -- not checked.
  }

  // ---- Gate 7: BOM ------------------------------------------------------
  if (!stopped && specDocumentId) {
    for (const item of isoBomItems) {
      const attrs = item.attributes as Record<string, unknown>;
      const itemCode = typeof attrs.item_code === "string" ? attrs.item_code : undefined;
      const lineNumber = typeof attrs.line_number === "string" ? attrs.line_number : undefined;
      if (!itemCode || !lineNumber) continue;
      // Resolve against the item's own class on a spec-break drawing, so a
      // 300# item isn't reported as "not-in-spec" against the 150# catalogue.
      const ownCode = itemSpecCode(attrs, lineNumber);
      const spec = (ownCode ? specByNorm.get(normalizeTagNumber(ownCode)) : undefined) ?? specClassByLine.get(lineNumber);
      if (!spec) continue;

      const category = mapComponentCategory(typeof attrs.component_type === "string" ? attrs.component_type : undefined);
      if (!category) continue;
      const specAttrs = spec.attributes as Record<string, unknown>;
      const rows = (specAttrs[category] as Array<Record<string, unknown>>) ?? [];
      if (rows.length === 0) continue;

      if (!findSpecRow(rows, itemCode)) {
        // Not-in-spec: the code doesn't resolve to the catalogue at all --
        // deliberately distinct from gate 4's "wrong item" material check.
        const specClassLabel = typeof specAttrs.class_code === "string" ? specAttrs.class_code : spec.tagNumber;
        out.push(
          makeFinding(projectId, item, isoDocumentId, specDocumentId, "7.item_code", itemCode, null, "warning", `BOM item ${item.tagNumber} (${itemCode}, ${category}) does not resolve to any entry under spec class "${specClassLabel}" -- not-in-spec.`)
        );
      }
    }
    // Drawn-vs-list reconciliation, quantity counting, cut-length checks,
    // and MTO roll-up need drawing geometry / an MTO document -- not checked.
  }

  // ---- Gate 8: GA --------------------------------------------------------
  if (!stopped && gaDocumentId) {
    for (const line of isoLines) {
      const match = gaByNorm.get(line.tagNumberNormalized);
      if (!match) {
        out.push(makeFinding(projectId, line, isoDocumentId, gaDocumentId, "8.line_routing", line.tagNumber, null, "warning", `Line ${line.tagNumber} on the ISO was not found in the GA's pipe routing.`));
      }
    }
    // Coordinates, elevations, clearances, clash detection, and battery
    // limit alignment are not extractable -- not checked.
  }

  // Re-verifying should reflect current state, not accumulate stale
  // findings from earlier runs.
  await db.delete(findings).where(eq(findings.docAId, isoDocumentId));
  if (out.length > 0) {
    await db.insert(findings).values(out);
  }

  return { findingsCreated: out.length };
}

// Side-by-side design-basis comparison for the UI -- every gate-2 field
// with the ISO value, the PLL value, and a verdict, including matches (the
// findings table only carries mismatches). Field pairs mirror gate 2
// exactly so the table and the findings can never disagree.
export interface DesignBasisRow {
  field: string;
  isoValue: string | null;
  pllValue: string | null;
  status: "match" | "mismatch" | "not compared";
}

const DESIGN_BASIS_FIELDS: Array<{ label: string; isoKey: string; pllKey: string; numeric: boolean }> = [
  { label: "Piping class", isoKey: "spec_class", pllKey: "spec_class", numeric: false },
  { label: "Size", isoKey: "size", pllKey: "size", numeric: true },
  { label: "Design pressure", isoKey: "design_pressure", pllKey: "design_pressure", numeric: true },
  { label: "Design temperature", isoKey: "design_temperature", pllKey: "design_temperature", numeric: true },
  { label: "Operating pressure", isoKey: "operating_pressure", pllKey: "operating_pressure", numeric: true },
  { label: "Operating temperature", isoKey: "operating_temperature", pllKey: "operating_temperature", numeric: true },
  { label: "Test pressure", isoKey: "hydrotest_pressure", pllKey: "test_pressure", numeric: true },
  { label: "Service", isoKey: "service", pllKey: "service", numeric: false },
  { label: "Insulation code", isoKey: "insul_spec", pllKey: "insulation_code", numeric: false },
  { label: "Insulation thickness", isoKey: "insul_thickness_mm", pllKey: "insulation_thickness", numeric: true },
  { label: "Heat trace", isoKey: "heat_trace", pllKey: "heat_trace", numeric: false },
  { label: "Paint system", isoKey: "painting_system", pllKey: "paint_system", numeric: false },
  { label: "NDT / radiograph", isoKey: "radiograph", pllKey: "ndt_percent", numeric: true },
  { label: "Slope", isoKey: "slope", pllKey: "slope", numeric: false },
];

export function buildDesignBasisComparison(isoAttrs: Record<string, unknown>, pllAttrs: Record<string, unknown>): DesignBasisRow[] {
  return DESIGN_BASIS_FIELDS.map(({ label, isoKey, pllKey, numeric }) => {
    const isoRaw = isoAttrs[isoKey];
    const pllRaw = pllAttrs[pllKey];
    const isoValue = isoRaw == null ? null : String(isoRaw);
    const pllValue = pllRaw == null ? null : String(pllRaw);

    // Mirrors compareNumeric/compareText in the gate chain, units included,
    // so this table and the findings can never disagree.
    let status: DesignBasisRow["status"];
    if (isBlank(isoRaw) || isBlank(pllRaw)) {
      status = "not compared";
    } else if (numeric) {
      const common = toCommonUnit(isoRaw, pllRaw);
      status = common
        ? numbersAgree(common.a, common.b)
          ? "match"
          : "mismatch"
        : String(isoRaw).trim().toLowerCase() === String(pllRaw).trim().toLowerCase()
          ? "match"
          : "mismatch";
    } else {
      status = String(isoRaw).trim().toLowerCase() === String(pllRaw).trim().toLowerCase() ? "match" : "mismatch";
    }
    return { field: label, isoValue, pllValue, status };
  });
}

// A multi-sheet drawing yields one line tag per sheet, all carrying the same
// line number. Collapsed into one line per number so each gate reports a
// finding once rather than once per sheet.
//
// Endpoints are taken from the ends of the whole run, not from any one sheet:
// the run STARTS on the first sheet and ENDS on the last, so from_location
// comes from the lowest-numbered sheet that states one and to_location from
// the highest. (Every other field is filled from whichever sheet has it --
// notably spec_breaks, which exist only on the sheet that draws the break.)
export function mergeIsoLineSheets(lines: ExtractedTag[]): ExtractedTag[] {
  const byNorm = new Map<string, ExtractedTag[]>();
  for (const line of lines) {
    const list = byNorm.get(line.tagNumberNormalized) ?? [];
    list.push(line);
    byNorm.set(line.tagNumberNormalized, list);
  }

  return [...byNorm.values()].map((sheets) => {
    if (sheets.length === 1) return sheets[0];
    const ordered = [...sheets].sort((a, b) => (a.sourcePage ?? 0) - (b.sourcePage ?? 0));
    const merged: Record<string, unknown> = { ...(ordered[0].attributes as Record<string, unknown>) };
    for (const sheet of ordered.slice(1)) {
      for (const [key, value] of Object.entries(sheet.attributes as Record<string, unknown>)) {
        if (Array.isArray(value) ? value.length === 0 : isBlank(value)) continue;
        const current = merged[key];
        const currentEmpty = Array.isArray(current) ? current.length === 0 : isBlank(current);
        if (currentEmpty) merged[key] = value;
      }
    }
    // First sheet that states a start, last sheet that states an end.
    const firstFrom = ordered.find((s) => !isBlank((s.attributes as Record<string, unknown>).from_location));
    const lastTo = [...ordered].reverse().find((s) => !isBlank((s.attributes as Record<string, unknown>).to_location));
    if (firstFrom) merged.from_location = (firstFrom.attributes as Record<string, unknown>).from_location;
    if (lastTo) merged.to_location = (lastTo.attributes as Record<string, unknown>).to_location;
    return { ...ordered[0], attributes: merged };
  });
}

// An ISO endpoint can be a continuation reference to another drawing
// ("CONT. ON 18\"-22-214-01-CRD-0001-BC70N-N", "CONT. FROM DRG 2") rather
// than an equipment/nozzle tag. That names a drawing, not a piece of
// equipment, so it is not comparable to the P&ID's from/to equipment --
// reporting it as a routing mismatch would be a false positive.
function isContinuationRef(value: unknown): boolean {
  if (isBlank(value)) return false;
  return /\bCONT\b|\bCONT'?D\b|\bCONTINUE/i.test(String(value)) || /\bDRG\b|\bDWG\b/i.test(String(value));
}

function isBlank(value: unknown): boolean {
  if (value == null) return true;
  const s = String(value).trim().toUpperCase();
  if (s === "" || s === "NA" || s === "N/A" || s === "NIL" || s === "NIL." || s === "-") return true;
  // Issued-for-review drawings print unfilled title-block cells as
  // "XX.XX" / "XX" (optionally followed by a unit) -- placeholders, not
  // data. Comparing them produced false mismatches (e.g. service "XX.XX"
  // vs the PLL's real value).
  return /^X+([.,]X+)?$/.test(s.split(/\s+/)[0]);
}

function parseNumber(value: unknown): number | null {
  if (isBlank(value)) return null;
  const match = String(value).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

// ISOs and line lists routinely use different units for the same quantity
// (an ISO title block in kPag against a line list in barg is common), so a
// correct line would otherwise be reported as a design-basis mismatch.
// Values are converted to a canonical unit before comparing; an unknown or
// absent unit is left as-is and compared numerically, which is the old
// behaviour.
const PRESSURE_TO_BAR: Record<string, number> = {
  bar: 1,
  barg: 1,
  bara: 1,
  kpa: 0.01,
  kpag: 0.01,
  kpaa: 0.01,
  mpa: 10,
  mpag: 10,
  psi: 0.0689476,
  psig: 0.0689476,
  kgcm2: 0.980665,
  "kg/cm2": 0.980665,
};

const LENGTH_TO_MM: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, '"': 25.4, inch: 25.4 };

function unitOf(value: unknown): string | null {
  if (value == null) return null;
  // Everything after the leading number, e.g. "5 kPag" -> "kpag", '2"' -> '"'
  const match = String(value).trim().match(/^-?[\d.,]+\s*(.*)$/);
  if (!match) return null;
  const unit = match[1].trim().toLowerCase().replace(/\s+/g, "");
  return unit || null;
}

// Returns both values in a common unit, or null when they can't be
// meaningfully converted (different quantity kinds, or an unrecognised
// unit on one side only).
function toCommonUnit(a: unknown, b: unknown): { a: number; b: number } | null {
  const na = parseNumber(a);
  const nb = parseNumber(b);
  if (na == null || nb == null) return null;

  const ua = unitOf(a);
  const ub = unitOf(b);
  if (!ua || !ub || ua === ub) return { a: na, b: nb };

  for (const table of [PRESSURE_TO_BAR, LENGTH_TO_MM]) {
    const fa = table[ua];
    const fb = table[ub];
    if (fa != null && fb != null) return { a: na * fa, b: nb * fb };
  }
  // Temperatures: only °C is used on these documents; a °F/°C mix would
  // need an offset conversion, so it is deliberately not guessed here.
  return null;
}

// Small tolerance so unit conversion's floating point residue (e.g.
// 5 kPag -> 0.05 barg) doesn't read as a mismatch.
function numbersAgree(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= scale * 1e-6;
}

function findSpecRow(rows: Array<Record<string, unknown>>, itemCode: unknown): Record<string, unknown> | undefined {
  if (typeof itemCode !== "string" || !itemCode) return undefined;
  const codeNorm = normalizeTagNumber(itemCode);
  return rows.find((row) => {
    const rowCode = typeof row.item_code === "string" ? row.item_code : typeof row.valve_index_code === "string" ? row.valve_index_code : undefined;
    return rowCode != null && normalizeTagNumber(rowCode) === codeNorm;
  });
}

function mapComponentCategory(componentType: string | undefined): "pipes" | "fittings" | "flanges" | "valves" | null {
  if (!componentType) return null;
  const t = componentType.toLowerCase();
  if (t.includes("pipe") && !t.includes("support")) return "pipes";
  if (t.includes("fitting")) return "fittings";
  if (t.includes("flange")) return "flanges";
  if (t.includes("valve")) return "valves";
  return null;
}

// ---- Routing & fitting count (gate 3, ISO vs P&ID) --------------------
// A BOM row's component_type + description are read together (the type is
// often just "FITTINGS" while the description says "90 DEG LR ELBOW").
type FittingCategory =
  | "valves"
  | "elbows"
  | "tees"
  | "reducers"
  | "flanges"
  | "spectacle blinds"
  | "olets"
  | "caps"
  | "couplings"
  | "expansion joints"
  | "other fittings";

function classifyFitting(componentType: unknown, description: unknown): FittingCategory | null {
  const ct = String(componentType ?? "").toLowerCase();
  const t = `${ct} ${String(description ?? "").toLowerCase()}`;
  // Non-fittings first: fasteners, pipe stock, supports, instruments.
  if (/gasket|\bbolt\b|\bstud\b|\bnut\b|washer/.test(t)) return null;
  if (ct.includes("support") || /\bsupport\b/.test(t)) return null;
  // Per the legend's categories an expansion joint/bellows is an in-line
  // symbol, NOT a valve -- even when it carries a tag (EJ-A101). Checked
  // before the valve keyword so "expansion joint" descriptions that mention
  // valves elsewhere can't misclassify.
  if (/expansion\s*joint|bellows|\bej\b/.test(t)) return "expansion joints";
  // A control valve is a valve even when the BOM files it under INSTRUMENT
  // (real ISOs do -- FV-0003 is component_type "INSTRUMENT"), so this comes
  // before the instrument exclusion. Valve ACCESSORIES stay excluded: a
  // positioner or limit switch is part of its valve, not another valve.
  if (/valve/.test(t) && !/positioner|actuator|limit\s*switch|solenoid|handswitch|\bhs-|manifold/.test(t)) return "valves";
  if (ct.includes("instrument")) return null;
  if (/\bpipe\b/.test(t) && !/elbow|tee|reducer|flange|olet|coupling|\bcap\b|bend|nipple/.test(t)) return null;
  // BOM descriptions are abbreviated to fit the column, so match on the
  // stem rather than the full word: a real BOM row reads "REDU CONC ASME
  // B16.9", not "REDUCER". Matching only full words silently dropped those
  // rows into "other fittings" and reported the ISO as having 0 reducers
  // while the P&ID drew 2.
  if (/\belbo|\bbend\b|\bell\b/.test(t)) return "elbows";
  if (/\btee\b|\btees\b/.test(t)) return "tees";
  if (/\bredu|swage|\bred\s*conc|\bred\s*ecc/.test(t)) return "reducers";
  // Before flanges: a spectacle blind / spade is its own isolation component
  // and is one of the few things a P&ID actually draws, so it is worth
  // comparing on its own rather than being absorbed into the flange count.
  // "BLIND FLANGE" is deliberately NOT caught here -- that is a blanking
  // flange and belongs with the flanges.
  if (/spectacle|figure.?8|\bfig\.?\s*8\b|\bspade\b/.test(t)) return "spectacle blinds";
  if (/flange|\bflg\b|\bflan\b/.test(t)) return "flanges";
  if (/olet|stub.?in|stub.?on/.test(t)) return "olets";
  if (/\bcap\b|\bplug\b/.test(t)) return "caps";
  if (/coupling|\bcplg\b|union|\bnipp/.test(t)) return "couplings";
  if (ct.includes("fitting")) return "other fittings";
  return null;
}

// "Valves" as one number hides the thing a reviewer actually checks: that the
// ISO has the same KINDS of valve the P&ID calls for. A missing check valve
// and a spare gate valve cancel out in a total. Both sides are classified
// into the same vocabulary so they can be compared type by type -- the ISO
// from its BOM description text, the P&ID from the symbol type read off the
// drawing.
export type ValveCategory =
  | "gate"
  | "ball"
  | "globe"
  | "check"
  | "butterfly"
  | "plug"
  | "needle"
  | "diaphragm"
  | "control"
  | "relief/safety"
  | "other valves";

export const VALVE_DISPLAY_ORDER: ValveCategory[] = [
  "gate",
  "ball",
  "globe",
  "check",
  "butterfly",
  "plug",
  "needle",
  "diaphragm",
  "control",
  "relief/safety",
  "other valves",
];

export function classifyValve(text: unknown): ValveCategory | null {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return null;
  // Ordered so a compound description lands on its defining word: a
  // "gate valve, ball type handle" is a gate valve, and "swing check" and
  // "non-return" are the same category whatever else the row says.
  if (/check|non.?return|\bnrv\b/.test(t)) return "check";
  if (/relief|safety|\bpsv\b|\bprv\b|\btsv\b|rupture/.test(t)) return "relief/safety";
  if (/control valve|\bcv\b-|\bfv-|\bpcv|\btcv|\blcv|\bfcv\b|\bxv-|actuated|emergency isolation|\beiv\b/.test(t)) return "control";
  if (/\bgate\b/.test(t)) return "gate";
  if (/\bball\b/.test(t)) return "ball";
  if (/\bglobe\b/.test(t)) return "globe";
  if (/butterfly/.test(t)) return "butterfly";
  if (/\bplug\b/.test(t)) return "plug";
  if (/needle/.test(t)) return "needle";
  if (/diaphragm/.test(t)) return "diaphragm";
  if (/valve/.test(t)) return "other valves";
  return null;
}

// NPS to DN. Deliberately a lookup, not a 25.4 multiply: nominal sizes are
// names, not measurements -- NPS 8 is DN200, not DN203.2 -- so converting
// arithmetically makes an 8" P&ID valve fail to match a "200" ISO BOM row.
const NPS_TO_DN: Record<string, number> = {
  "0.5": 15, "0.75": 20, "1": 25, "1.25": 32, "1.5": 40, "2": 50, "2.5": 65, "3": 80,
  "4": 100, "5": 125, "6": 150, "8": 200, "10": 250, "12": 300, "14": 350, "16": 400,
  "18": 450, "20": 500, "24": 600, "28": 700, "30": 750, "36": 900, "42": 1050, "48": 1200,
};
const DN_TO_NPS = new Map(Object.entries(NPS_TO_DN).map(([nps, dn]) => [dn, nps]));

// Canonical DN for a size written any way these documents write it: '8"',
// "8 in", "3/4\"", "200", "200 mm", or a reducer's '8" x 6"' (first size).
export function normalizeNominalSize(value: unknown): number | null {
  if (value == null) return null;
  const first = String(value).split(/x|×/i)[0].trim();
  if (!first) return null;
  const fraction = first.match(/^(\d+)?\s*(\d+)\s*\/\s*(\d+)/);
  const inches = /"|inch|\bin\b|''/.test(first);
  let num: number | null;
  if (fraction) {
    num = (fraction[1] ? Number(fraction[1]) : 0) + Number(fraction[2]) / Number(fraction[3]);
  } else {
    num = parseNumber(first);
  }
  if (num == null) return null;
  // A bare number on these BOMs is mm; anything marked in inches, and any
  // value small enough to only make sense as inches, goes through NPS->DN.
  if (inches || num <= 48) {
    const key = String(Number(num.toFixed(2)));
    return NPS_TO_DN[key] ?? Math.round(num * 25.4);
  }
  return Math.round(num);
}

export function formatNominalSize(dn: number | null): string {
  if (dn == null) return "unsized";
  const nps = DN_TO_NPS.get(dn);
  return nps ? `${nps}" (DN${dn})` : `DN${dn}`;
}

// Line classes are written with the insulation/service suffix attached in
// some places ("AC03N-N") and without it in others ("AC03N"), which would
// otherwise split one class into two rows.
export function normalizeSpecClass(value: unknown): string | null {
  if (isBlank(value)) return null;
  const s = String(value).trim().toUpperCase();
  const m = s.match(/^([A-Z]{2}\d{2}[A-Z]?)(?:[-\s].*)?$/);
  return m ? m[1] : s;
}

// Same quantity-summing rule as the fittings tally, applied per valve type.
function tallyValves(rows: Array<{ text: unknown; quantity: unknown }>): Map<ValveCategory, number> {
  const tally = new Map<ValveCategory, number>();
  for (const row of rows) {
    const cat = classifyValve(row.text);
    if (!cat) continue;
    tally.set(cat, (tally.get(cat) ?? 0) + (parseNumber(row.quantity) ?? 1));
  }
  return tally;
}

export interface ValveMatchRow {
  category: ValveCategory;
  size: string;
  // The raw DN this row's `size` display string was formatted from --
  // exposed so a caller can cross-check the SAME size against a third data
  // source (e.g. the client spec + admin item list, see
  // verifyBomCrossCheck.ts's resolveValveClientStatus) without re-parsing
  // the display string back into a number.
  dn: number | null;
  isoCount: number;
  pidCount: number;
  isoDetail: string | null;
  pidDetail: string | null;
  status: "match" | "iso only" | "pid only" | "count mismatch";
}

// One block per material class the line passes through. A line with two spec
// breaks runs three classes, and a valve only means anything against the
// class governing the segment it sits in -- comparing the whole line at once
// lets a surplus in one class cancel a shortfall in another.
export interface ValveMatchGroup {
  specClass: string;
  rows: ValveMatchRow[];
  isoTotal: number;
  pidTotal: number;
}

// Pairs the two documents' valves one for one, on type and nominal size, so
// a reviewer sees WHICH valve disagrees rather than that some total differs.
// Neither side can be matched by tag: the ISO BOM aggregates by quantity and
// carries no per-valve tags, and most P&ID valves are untagged. Type + size
// is the strongest key both sides actually have.
export function buildValveMatch(
  isoBom: Array<Record<string, unknown>>,
  pidValves: Array<Record<string, unknown>>
): ValveMatchGroup[] {
  interface Side {
    count: number;
    details: string[];
  }
  const isoSide = new Map<string, Side>();
  const pidSide = new Map<string, Side>();
  const meta = new Map<string, { spec: string; category: ValveCategory; dn: number | null }>();

  const add = (map: Map<string, Side>, spec: string, category: ValveCategory, dn: number | null, qty: number, detail: string) => {
    const key = `${spec}|${category}|${dn ?? "?"}`;
    meta.set(key, { spec, category, dn });
    const side = map.get(key) ?? { count: 0, details: [] };
    side.count += qty;
    if (detail && !side.details.includes(detail)) side.details.push(detail);
    map.set(key, side);
  };

  for (const item of isoBom) {
    const text = `${item.component_type ?? ""} ${item.description ?? ""}`;
    const category = classifyValve(text);
    if (!category) continue;
    const spec = normalizeSpecClass(item.item_spec_class) ?? "unassigned";
    const desc = String(item.description ?? "").split(",")[0].trim();
    add(isoSide, spec, category, normalizeNominalSize(item.size), parseNumber(item.quantity) ?? 1, desc);
  }
  for (const valve of pidValves) {
    const category = classifyValve(valve.valve_type);
    if (!category) continue;
    const spec = normalizeSpecClass(valve.spec_class) ?? "unassigned";
    const tag = valve.untagged ? "untagged" : String(valve.tag_number ?? "").trim();
    add(pidSide, spec, category, normalizeNominalSize(valve.size), parseNumber(valve.quantity) ?? 1, tag || "untagged");
  }

  const rank = { "pid only": 0, "iso only": 1, "count mismatch": 2, match: 3 } as const;
  const bySpec = new Map<string, ValveMatchRow[]>();
  for (const key of new Set([...isoSide.keys(), ...pidSide.keys()])) {
    const { spec, category, dn } = meta.get(key)!;
    const iso = isoSide.get(key);
    const pid = pidSide.get(key);
    const isoCount = iso?.count ?? 0;
    const pidCount = pid?.count ?? 0;
    let status: ValveMatchRow["status"];
    if (isoCount > 0 && pidCount === 0) status = "iso only";
    else if (pidCount > 0 && isoCount === 0) status = "pid only";
    else status = isoCount === pidCount ? "match" : "count mismatch";
    const rows = bySpec.get(spec) ?? [];
    rows.push({
      category,
      size: formatNominalSize(dn),
      dn,
      isoCount,
      pidCount,
      isoDetail: iso ? iso.details.join(" / ") : null,
      pidDetail: pid ? pid.details.filter((d) => d !== "untagged").join(" / ") || "untagged" : null,
      status,
    });
    bySpec.set(spec, rows);
  }

  const groups: ValveMatchGroup[] = [...bySpec.entries()].map(([specClass, rows]) => {
    // Disagreements first within each class -- the reason the table exists.
    rows.sort((a, b) => rank[a.status] - rank[b.status] || a.category.localeCompare(b.category));
    return {
      specClass,
      rows,
      isoTotal: rows.reduce((n, r) => n + r.isoCount, 0),
      pidTotal: rows.reduce((n, r) => n + r.pidCount, 0),
    };
  });
  // Class order follows the run: the line's own class first, then the classes
  // it breaks into, with anything unassigned last so it stands out.
  groups.sort((a, b) => {
    if (a.specClass === "unassigned") return 1;
    if (b.specClass === "unassigned") return -1;
    return a.specClass.localeCompare(b.specClass);
  });
  return groups;
}

// Sums quantity (not row count -- one row can be "ELBOW ... QTY 4") per
// fitting category across a line's BOM rows.
function tallyFittings(bom: Array<Record<string, unknown>>): Map<FittingCategory, number> {
  const tally = new Map<FittingCategory, number>();
  for (const item of bom) {
    const cat = classifyFitting(item.component_type, item.description);
    if (!cat) continue;
    const qty = parseNumber(item.quantity) ?? 1;
    tally.set(cat, (tally.get(cat) ?? 0) + qty);
  }
  return tally;
}

// Every material class this ISO drawing covers: its title-block class plus
// every class named in its spec breaks.
export function isoSpecClasses(isoAttrs: Record<string, unknown>): string[] {
  const classes = new Set<string>();
  if (!isBlank(isoAttrs.spec_class)) classes.add(String(isoAttrs.spec_class).trim().toUpperCase());
  const breaks = Array.isArray(isoAttrs.spec_breaks) ? (isoAttrs.spec_breaks as SpecBreakEntry[]) : [];
  for (const b of breaks) {
    if (b && !isBlank(b.spec_class)) classes.add(String(b.spec_class).trim().toUpperCase());
  }
  return [...classes];
}

// A line number embeds its material class (8"-22-214-01-CRD-0002-AC03N-N),
// so a run that changes class at a spec break appears on the P&ID under two
// different numbers -- ...-AC03N-N upstream and ...-BC70N-N downstream. A
// plain equality match therefore drops every valve and fitting past the
// break, which is exactly the part a spec-break review cares about. Matching
// with the drawing's own known classes removed reunites the segments without
// loosening the match to unrelated lines.
function lineKeyIgnoringSpec(lineNumber: string, specClasses: string[]): string {
  let key = normalizeTagNumber(lineNumber);
  for (const cls of specClasses) {
    key = key.split(cls.toUpperCase()).join("");
  }
  return key.replace(/--+/g, "-");
}

export function matchesLineAcrossSpecBreak(candidate: unknown, isoLineNumber: string, specClasses: string[]): boolean {
  if (typeof candidate !== "string" || !candidate.trim()) return false;
  const norm = normalizeTagNumber(candidate);
  if (norm === normalizeTagNumber(isoLineNumber)) return true;
  if (specClasses.length < 2) return false;
  return lineKeyIgnoringSpec(candidate, specClasses) === lineKeyIgnoringSpec(isoLineNumber, specClasses);
}

// A valve row can stand for several identical valves (a "2 x 2\" BALL VALVE"
// typical), so the P&ID's valve count is the sum of quantities, not the
// number of rows. Untagged rows count exactly like tagged ones.
export function countPidValves(valveAttrs: Array<Record<string, unknown>>): number {
  return valveAttrs.reduce((total, a) => total + (parseNumber(a.quantity) ?? 1), 0);
}

// The same valves grouped by the material class of the segment each one sits
// in. On a line with a spec break the run changes class partway along, so a
// single total hides which side the valves belong to.
export function countPidValvesBySpec(valveAttrs: Array<Record<string, unknown>>): Map<string, number> {
  const bySpec = new Map<string, number>();
  for (const a of valveAttrs) {
    const spec = normalizeSpecClass(a.spec_class) ?? "unassigned";
    bySpec.set(spec, (bySpec.get(spec) ?? 0) + (parseNumber(a.quantity) ?? 1));
  }
  return bySpec;
}

function normEndpoint(value: unknown): string {
  return normalizeTagNumber(String(value ?? "")).replace(/[-\s]/g, "");
}

// Union of every from/to equipment on the P&ID occurrences of a line.
function pidEndpointSet(pidLineAttrs: Array<Record<string, unknown>>): Set<string> {
  const set = new Set<string>();
  for (const a of pidLineAttrs) {
    for (const key of ["from_equipment", "to_equipment"] as const) {
      if (!isBlank(a[key])) set.add(normEndpoint(a[key]));
    }
  }
  return set;
}

// Lenient: an ISO endpoint corresponds to the P&ID if either contains the
// other once normalized (ISO nozzle "N1 OF V-101" vs P&ID equipment
// "V-101"). Blank ISO endpoint = nothing to check = treated as present.
function endpointInSet(value: unknown, set: Set<string>): boolean {
  if (isBlank(value)) return true;
  const nv = normEndpoint(value);
  if (!nv) return true;
  for (const e of set) {
    if (e && (e.includes(nv) || nv.includes(e))) return true;
  }
  return false;
}

// Side-by-side routing & fitting comparison for the UI (gate 3, ISO vs
// P&ID). Routing rows compare the ISO's from/to against the P&ID's; the
// valve row is cross-checked; every other fitting category is an ISO-only
// tally because a P&ID does not draw elbows/tees/reducers -- there is no
// P&ID figure to compare, and none is invented.
export interface RoutingFittingRow {
  field: string;
  isoValue: string | null;
  pidValue: string | null;
  status: "match" | "mismatch" | "iso only" | "not compared";
}

// Only categories a P&ID actually DRAWS are compared here. Elbows, tees,
// flanges and olets are ISO-only by nature -- a P&ID never shows them, so
// they could only ever report "iso only" and were pure noise in this table.
// They remain classified (and counted in the BOM-by-spec view); they just
// aren't rows in the ISO-vs-P&ID comparison.
const FITTING_DISPLAY_ORDER: FittingCategory[] = ["reducers", "spectacle blinds", "expansion joints", "caps", "couplings", "other fittings"];

export function buildRoutingFittingComparison(
  isoAttrs: Record<string, unknown>,
  isoBom: Array<Record<string, unknown>>,
  pidLineAttrs: Array<Record<string, unknown>>,
  pidValveCount: number,
  pidLineFittings: Array<Record<string, unknown>> = []
): RoutingFittingRow[] {
  const rows: RoutingFittingRow[] = [];
  const endpoints = pidEndpointSet(pidLineAttrs);
  const uniq = (vals: unknown[]) => Array.from(new Set(vals.filter((v) => !isBlank(v)).map((v) => String(v))));
  const pidFroms = uniq(pidLineAttrs.map((a) => a.from_equipment));
  const pidTos = uniq(pidLineAttrs.map((a) => a.to_equipment));

  const routeRow = (label: string, isoVal: unknown, pidList: string[]): RoutingFittingRow => {
    const isoValue = isBlank(isoVal) ? null : String(isoVal);
    const pidValue = pidList.length ? pidList.join(" / ") : null;
    let status: RoutingFittingRow["status"];
    // A continuation reference points at another drawing, not equipment, so
    // there is nothing on the P&ID to compare it with -- not a mismatch.
    if (isoValue == null || endpoints.size === 0 || isContinuationRef(isoVal)) status = "not compared";
    else status = endpointInSet(isoVal, endpoints) ? "match" : "mismatch";
    return { field: label, isoValue, pidValue, status };
  };
  rows.push(routeRow("Route from", isoAttrs.from_location, pidFroms));
  rows.push(routeRow("Route to", isoAttrs.to_location, pidTos));

  // Slope, ISO annotation vs P&ID annotation(s), both canonicalized so
  // "1 IN 100" and "1:100" agree. The P&ID is the requirement: a slope on
  // the P&ID with a blank ISO is a MISMATCH (the ISO is missing a required
  // annotation), not a skip. Only a P&ID with no slope leaves nothing to
  // compare against.
  const pidSlopes = uniq(pidLineAttrs.map((a) => normalizeSlope(typeof a.slope === "string" ? a.slope : undefined)));
  const isoSlope = normalizeSlope(isBlank(isoAttrs.slope) ? undefined : String(isoAttrs.slope));
  rows.push({
    field: "Slope",
    isoValue: isoSlope ?? null,
    pidValue: pidSlopes.length ? pidSlopes.join(" / ") : null,
    status: pidSlopes.length === 0 ? "not compared" : isoSlope && pidSlopes.includes(isoSlope) ? "match" : "mismatch",
  });

  const tally = tallyFittings(isoBom);
  const isoValves = tally.get("valves") ?? 0;
  rows.push({
    field: "Valves",
    isoValue: String(isoValves),
    pidValue: pidLineAttrs.length ? String(pidValveCount) : null,
    status: pidValveCount === 0 ? "not compared" : isoValves >= pidValveCount ? "match" : "mismatch",
  });

  // Totals only here. The per-type and per-spec breakdowns live in the
  // dedicated "Valve match" table below, which is where a reviewer goes for
  // detail -- duplicating them inline made this table unreadable.

  // P&ID-drawn fittings (flange joints, blinds, reducers...) compare
  // min-basis: the P&ID draws only some of them, so its count is a floor
  // the ISO BOM must meet. Categories the P&ID doesn't draw stay ISO-only.
  const pidTally = tallyFittings(
    pidLineFittings.map((a) => ({ component_type: a.fitting_type, description: `${a.fitting_type ?? ""} ${a.size ?? ""}`, quantity: a.quantity }))
  );
  for (const cat of FITTING_DISPLAY_ORDER) {
    const isoCount = tally.get(cat) ?? 0;
    const pidCount = pidTally.get(cat) ?? 0;
    if (isoCount === 0 && pidCount === 0) continue;
    rows.push({
      field: cat[0].toUpperCase() + cat.slice(1),
      isoValue: String(isoCount),
      pidValue: pidCount > 0 ? `${pidCount} drawn (min)` : null,
      status: pidCount === 0 ? "iso only" : isoCount >= pidCount ? "match" : "mismatch",
    });
  }
  return rows;
}

function makeFinding(
  projectId: string,
  tag: ExtractedTag,
  docAId: string,
  docBId: string | undefined,
  fieldChecked: string,
  valueA: unknown,
  valueB: unknown,
  severity: "error" | "warning" | "info",
  notes?: string
): Finding {
  return {
    projectId,
    tagNumber: tag.tagNumber,
    docAId,
    docBId: docBId ?? null,
    fieldChecked,
    valueA: valueA == null ? null : String(valueA),
    valueB: valueB == null ? null : String(valueB),
    severity,
    status: "open",
    notes: notes ?? null,
  };
}

// Text comparison: blank on either side = skipped, never a mismatch.
function compareText(
  out: Finding[],
  projectId: string,
  tag: ExtractedTag,
  docAId: string,
  docBId: string | undefined,
  field: string,
  valueA: unknown,
  valueB: unknown,
  severity: "error" | "warning" | "info",
  notes?: string
) {
  if (isBlank(valueA) || isBlank(valueB)) return;
  const a = String(valueA).trim().toLowerCase();
  const b = String(valueB).trim().toLowerCase();
  if (a !== b) out.push(makeFinding(projectId, tag, docAId, docBId, field, valueA, valueB, severity, notes));
}

// Numeric comparison: extracts the number from each side so "150", "150 C",
// and "150.0" agree, and converts units when both sides have a recognised
// (possibly different) one -- "350" and "350 mm" agree with no unit penalty
// since a bare number on one side is treated as already-comparable. Blank/
// NA/NIL on either side = skipped. Falls back to text comparison when
// either side has no parseable number (e.g. "AMB.").
function compareNumeric(
  out: Finding[],
  projectId: string,
  tag: ExtractedTag,
  docAId: string,
  docBId: string | undefined,
  field: string,
  valueA: unknown,
  valueB: unknown,
  severity: "error" | "warning" | "info",
  notes?: string
) {
  if (isBlank(valueA) || isBlank(valueB)) return;
  const common = toCommonUnit(valueA, valueB);
  if (common == null) {
    // No parseable number on one side (e.g. "AMB."), or units that can't be
    // converted -- fall back to a literal comparison rather than guessing.
    compareText(out, projectId, tag, docAId, docBId, field, valueA, valueB, severity, notes);
    return;
  }
  if (!numbersAgree(common.a, common.b)) out.push(makeFinding(projectId, tag, docAId, docBId, field, valueA, valueB, severity, notes));
}

// ---------------------------------------------------------------------
// Document-detail page support: sibling-document options, routing/valve
// match data, and spooling data, factored out of the ISO document page so
// the "Spooling" and "Valve match" views can each load only what they need
// instead of the full combined report. Pure re-shaping of already-extracted
// tags -- no extraction/gate-chain logic lives here.
// ---------------------------------------------------------------------

export interface IsoDocContext {
  pllOptions: (typeof documents.$inferSelect)[];
  specOptions: (typeof documents.$inferSelect)[];
  pidOptions: (typeof documents.$inferSelect)[];
  gaOptions: (typeof documents.$inferSelect)[];
  docNameById: Map<string, string>;
  isoFindings: (typeof findings.$inferSelect)[];
}

// Sibling documents in the project (PLL/spec/P&ID/GA options for the verify
// form + valve-match/routing lookups), scoped to the latest SUCCEEDED
// extraction job per document.
export async function loadIsoDocContext(projectId: string, document: { id: string; fileName: string }): Promise<IsoDocContext> {
  const db = getDb();
  const docId = document.id;

  const siblingDocs = await db.select().from(documents).where(eq(documents.projectId, projectId));

  const siblingJobs = await db
    .select({ job: extractionJobs })
    .from(extractionJobs)
    .innerJoin(documents, eq(documents.id, extractionJobs.documentId))
    .where(eq(documents.projectId, projectId));
  // Keep the NEWEST job per document, by timestamp. A document accumulates
  // one job row per attempt, and the query has no ORDER BY, so "the first
  // row seen" is whatever order Postgres happens to return -- which for a
  // document that failed a few times before succeeding is usually a failed
  // one. That made a successfully extracted P&ID vanish from the verify
  // form's dropdowns while the project listing (which does compare
  // timestamps) showed it as succeeded.
  const latestJobByDoc = new Map<string, (typeof siblingJobs)[number]["job"]>();
  for (const { job } of siblingJobs) {
    const existing = latestJobByDoc.get(job.documentId);
    if (!existing || job.createdAt > existing.createdAt) latestJobByDoc.set(job.documentId, job);
  }
  const latestStatusByDoc = new Map([...latestJobByDoc].map(([docId2, job]) => [docId2, job.status] as const));

  const succeeded = siblingDocs.filter((d) => d.id !== docId && latestStatusByDoc.get(d.id) === "succeeded");
  const pllOptions = succeeded.filter((d) => d.docType === "pll");
  const specOptions = succeeded.filter((d) => d.docType === "spec_sheet");
  const pidOptions = succeeded.filter((d) => d.docType === "pid");
  const gaOptions = succeeded.filter((d) => d.docType === "ga");

  const docNameById = new Map(siblingDocs.map((d) => [d.id, d.fileName]));
  docNameById.set(document.id, document.fileName);

  const isoFindings = await db.select().from(findings).where(eq(findings.docAId, docId)).orderBy(desc(findings.createdAt));

  return { pllOptions, specOptions, pidOptions, gaOptions, docNameById, isoFindings };
}

// Routing & fitting count + valve match, ISO vs the project's P&IDs -- one
// entry per ISO line, aggregated across every extracted P&ID (a line
// legitimately spans several sheets/documents). Returns [] when there are
// no P&ID options or no ISO line tags to check.
export async function loadRoutingAndValveMatch(params: {
  tags: ExtractedTag[];
  pidOptions: (typeof documents.$inferSelect)[];
  docNameById: Map<string, string>;
}): Promise<
  Array<{
    lineNumber: string;
    pidDocNames: string[];
    rows: RoutingFittingRow[] | null;
    valveMatch?: ValveMatchGroup[];
  }>
> {
  const { tags, pidOptions, docNameById } = params;
  const isoLineTags = mergeIsoLineSheets(tags.filter((t) => t.tagType === "line"));
  if (pidOptions.length === 0 || isoLineTags.length === 0) return [];

  const db = getDb();
  const pidTags = await db
    .select()
    .from(extractedTags)
    .where(and(inArray(extractedTags.documentId, pidOptions.map((d) => d.id)), inArray(extractedTags.tagType, ["line", "valve", "fitting"])));
  const isoBomTags = tags.filter((t) => t.tagType === "bom_item");

  return isoLineTags.map((line) => {
    const norm = line.tagNumberNormalized;
    const pidLineMatches = pidTags.filter((t) => t.tagType === "line" && t.tagNumberNormalized === norm);
    if (pidLineMatches.length === 0) return { lineNumber: line.tagNumber, pidDocNames: [], rows: null };

    const pidLineAttrs = pidLineMatches.map((t) => t.attributes as Record<string, unknown>);
    const isoAttrsForSpec = enrichIsoLineAttrs(line.tagNumber, line.attributes as Record<string, unknown>);
    const specClasses = isoSpecClasses(isoAttrsForSpec);
    // Valves are matched across the spec break: past the break the run
    // carries a different line number, and those valves are still part of
    // this ISO drawing.
    const pidLineValveAttrs = pidTags
      .filter((t) => t.tagType === "valve" && matchesLineAcrossSpecBreak((t.attributes as Record<string, unknown>).line_number, line.tagNumber, specClasses))
      .map((t) => t.attributes as Record<string, unknown>);
    const pidValveCount = countPidValves(pidLineValveAttrs);
    const bomForLine = isoBomTags
      .filter((b) => {
        const ln = (b.attributes as Record<string, unknown>).line_number;
        return typeof ln === "string" && normalizeTagNumber(ln) === norm;
      })
      .map((b) => b.attributes as Record<string, unknown>);
    const pidLineFittings = pidTags
      .filter((t) => t.tagType === "fitting" && matchesLineAcrossSpecBreak((t.attributes as Record<string, unknown>).line_number, line.tagNumber, specClasses))
      .map((t) => t.attributes as Record<string, unknown>);
    const pidDocNames = Array.from(new Set(pidLineMatches.map((t) => docNameById.get(t.documentId) ?? t.documentId)));
    return {
      lineNumber: line.tagNumber,
      pidDocNames,
      rows: buildRoutingFittingComparison(isoAttrsForSpec, bomForLine, pidLineAttrs, pidValveCount, pidLineFittings),
      valveMatch: buildValveMatch(bomForLine, pidLineValveAttrs),
    };
  });
}

// A resolved reference to a BOM item found inside a free-text field
// (location_note, from_ref, to_ref) -- e.g. "F12 G23 B11" or "item 4" cite
// BOM item numbers as landmarks, but until now that was just opaque text a
// reviewer had to look up by hand. This links each citation back to its
// actual bom_item tag on the SAME sheet (BOM items are recorded per-page,
// same as everything else), and null bomItem is itself a real signal --
// the drawing cites an item this sheet's own BOM never captured, either a
// missed BOM row or a misread item number.
export interface ItemCitation {
  start: number;
  end: number;
  raw: string; // exact matched substring, e.g. "F12", "item 4"
  itemNo: string; // normalized bare number, e.g. "12"
  bomItem: { description: string | null; componentType: string | null; size: string | null; material: string | null } | null;
  // True when this sheet's own BOM has MORE than one row sharing this same
  // item_no -- confirmed real case on a live document: item "13" appeared
  // twice on the same sheet (a gate valve AND an unrelated gasket), so a
  // "gate valve item 13" citation would silently resolve to whichever BOM
  // row happened to load last, wrong more than half the time. bomItem is
  // just the FIRST of the colliding rows here, not a confident match --
  // the UI must treat this differently from a clean single match.
  ambiguous: boolean;
}

export interface SpoolWeldDetail {
  tagNumber: string;
  weldType: string;
  size: string | null;
  // This weld's own row ID in this sheet's printed WELD LIST table, when it
  // has one -- an explicit, checkable cross-reference (apps/worker/src/
  // extraction/iso.ts), not just an internal size lookup.
  weldListId: string | null;
  // Deterministic cross-check (apps/worker/src/extraction/isoQualityChecks.ts)
  // -- set when this weld's own matched WELD LIST row (weldListId) disagrees
  // with what was recorded for the weld itself (size/shop-vs-field), a sign
  // one of the two readings is wrong. No vision, no API cost.
  weldListFlag: string | null;
  // Deterministic cross-check (apps/worker/src/extraction/isoQualityChecks.ts)
  // -- set when this weld reports the SAME size as every other weld citing
  // the same reducing weldolet/tee item, which almost always means one of
  // them is actually on the branch side, not the main run. No vision, no
  // API cost.
  sizeFlag: string | null;
  locationNote: string;
  // Deterministic geometric cross-check (apps/worker/src/scripts/
  // applyGeometricWeldFlags.ts) -- set when this weld's leader line, traced
  // directly from the PDF's own vector geometry, snaps onto a pipe-route
  // stretch that a geometrically-confirmed field weld shows is NOT the same
  // stretch as this weld's own recorded spool_no implies. No vision, no API
  // cost. Unambiguous: a real field weld bounds exactly one spool on each
  // side, so this can't be a missed valve/flange explaining it away.
  geometryFlag: string | null;
  // Softer signal, same script: this weld sits on the same unbroken stretch
  // of pipe (confirmed by geometry, no field weld anywhere in it) as
  // another weld recorded under a DIFFERENT spool_no. Unlike geometryFlag,
  // this one can legitimately be explained by a valve/flange boundary the
  // geometry doesn't know about yet (not classified) -- worth a look, not
  // a confirmed error.
  geometryGroupFlag: string | null;
  // Set only when applyGeometricWeldFlags.ts auto-corrected spool_no itself
  // (never invented -- only applied when the rest of this weld's own
  // unbroken pipe run unanimously agreed on one value). The original value
  // is preserved here, never silently overwritten and lost.
  spoolNoCorrectedFrom: string | null;
  // Set only when location_note's own item-number reference was manually
  // confirmed wrong against the real drawing (e.g. SW41: extraction said
  // "item 10 valve", the actual drawing shows item 11) and corrected --
  // never auto-applied, since item balloon numbers aren't in the PDF's
  // real text layer (vector glyph outlines only, same limitation as most
  // dimension values) so geometry can't verify these on its own yet.
  locationNoteCorrectedFrom: string | null;
  // Item-balloon codes ("F12", "G23", "B11") or bare "item N" mentions found
  // in locationNote, resolved against this weld's own sheet BOM -- see
  // ItemCitation's own comment.
  itemCitations: ItemCitation[];
  // See gasketWithoutFlange's own comment.
  gasketWithoutFlange: boolean;
}

export interface ContainerOrientationLeg {
  axis: "E" | "N" | "EL";
  containerDim: "length" | "width" | "height";
  extentMm: number;
  clearanceMm: number;
}

export interface SpoolRow {
  spoolNo: string;
  boundaryNote: string | null;
  boundingBoxMm: number[] | null;
  shippingContainer: string | null;
  // Which axis to lay along the container's length/width/height for the
  // best (max-min-clearance) fit -- see apps/worker/src/extraction/
  // containerFit.ts's own comment. null when oversized or unmeasured.
  containerOrientation: ContainerOrientationLeg[] | null;
  // Deterministic cross-check (apps/worker/src/extraction/iso.ts's
  // boundaryNoteLooksBranchBased), not from the model -- set when
  // boundaryNote itself admits the bounding joints sit on a branch leg,
  // which means this spool may be a branch cluster that should have been
  // folded into its main-run spool instead of standing on its own.
  boundaryFlag: string | null;
  weldRange: string | null;
  welds: SpoolWeldDetail[];
  dimensions: DimensionRow[];
}

// What kind of physical feature a dimension's from_ref/to_ref text names --
// derived purely from the already-extracted text (no re-extraction), so a
// reviewer can tell at a glance which dimensions bound a VALVE (per the
// extraction schema's own rule, a dimension reaching a valve stops at its
// flange FACE, not a centerline the way a fitting does) or a GASKET/flange
// bolt-up joint (a real spool boundary, per the same domain rules used
// throughout this document's spool boundary-walk), as opposed to an
// ordinary weld or in-line fitting (elbow/tee/weldolet).
export type DimensionRefKind = "valve" | "gasket" | "weld" | "fitting" | "tie-in" | null;

export interface DimensionRow {
  tagNumber: string;
  valueMm: string | null;
  axis: string | null;
  spoolNo: string | null;
  fromRef: string | null;
  toRef: string | null;
  fromKind: DimensionRefKind;
  toKind: DimensionRefKind;
  sourcePage: number | null;
  // Deterministic cross-check (apps/worker/src/extraction/iso.ts) -- set
  // when this dimension's own spool_no disagrees with the spool_no already
  // recorded for a weld its from_ref/to_ref names.
  spoolFlag: string | null;
  // Manual, auditable override of the whole dimension's own Type category
  // (see dimensionKind in the spooling page) for cases neither end's own
  // ref text can reveal automatically, or actively misleads the automatic
  // classifier. "weldolet" -- confirmed real case: DIM1-15/DIM1-16 (136mm
  // each) measure a weldolet's own branch-connection depth, not a plain
  // pipe run, even though neither ref literally says "weldolet" (their own
  // text only names the instrument tag and the branch weld, e.g. "BW16 on
  // 25mm instrument branch"). "pipe" -- forces the generic bucket over an
  // auto "valve" false positive: confirmed real case, DIM1-7 (15mm) reads
  // "valve" only because its own from_ref names item 7 (a known valve item)
  // as a general area landmark ("G9 / item 7"), not because the dimension
  // actually terminates at that valve's own flange face -- its real
  // endpoint is a spectacle blind boundary, and the 15mm itself is gasket/
  // stud-bolt clearance at that joint, not a valve body measurement.
  // "valve" -- the opposite override, for when classifyDimensionRef's
  // weld-tag-first priority (below) picks a weld tag over a valve word that
  // ALSO appears in the same ref text, but this dimension's real terminus
  // is actually the valve, not that weld: confirmed real case, DIM1-6
  // (457mm) reads "pipe" because its own from_ref "BW06 / item 7 ball valve
  // region" contains both BW06 and "ball valve", and the weld-tag-first
  // rule picks BW06 -- correct for other similarly-shaped refs on this same
  // sheet, but confirmed wrong here specifically, where BW06 is naming the
  // general area the valve sits in, not this dimension's own endpoint.
  manualKind: "weldolet" | "pipe" | "valve" | null;
  // Item-balloon codes / bare "item N" mentions in fromRef and toRef,
  // resolved against this dimension's own sheet BOM -- see ItemCitation's
  // own comment. Kept separate per end so the UI can annotate each column
  // independently.
  fromRefCitations: ItemCitation[];
  toRefCitations: ItemCitation[];
  // See gasketWithoutFlange's own comment. Checked across BOTH ends
  // combined -- a dimension's own from/to pair together describes one
  // joint's worth of context, so a flange cited on one side still counts
  // as covering a gasket cited on the other.
  gasketWithoutFlange: boolean;
}

// A fabrication/cut sheet's own printed CUT PIPE LENGTH table -- the raw
// pipe stock a spool is built FROM, not the same thing as a DimensionRow
// (which measures the assembled spool). spoolNo is frequently null since
// this table is usually printed once for the whole sheet, not per spool
// (see the extraction schema's own comment on the cut_pieces field).
export interface CutPieceRow {
  tagNumber: string;
  cutLengthMm: string | null;
  size: string | null;
  remarks: string | null;
  end1: string | null;
  end2: string | null;
  // Traced from this piece's own printed <N> marker on the drawn route (see
  // the extraction schema's own comment) to the nearest weld/fitting/tie-in
  // on each side -- null when the marker couldn't be located.
  fromRef: string | null;
  toRef: string | null;
  spoolNo: string | null;
  sourcePage: number | null;
  // A human-confirmed override for the reconciliation match, set when the
  // automatic matcher (weld tag or shared coordinate token in a dimension's
  // own end-text) can't safely resolve one end -- e.g. a weld's location_note
  // citing a dimension's VALUE ("start of the 3437mm run") rather than a tag
  // or coordinate. Value-citation alone isn't a safe general signal (a weld
  // sitting midway along a run can cite that run's length too, without being
  // an endpoint of it -- confirmed this would have hijacked piece 5's correct
  // match), so it's only trusted here, per-piece, after manual confirmation.
  manualDimensionMatch: string | null;
  manualDimensionNote: string | null;
  // Overrides the elbow count the "elbow"-word-count heuristic would derive
  // from the matched dimension's own end text. Needed when a boundary weld
  // sits at a real elbow the dimension's own end-text doesn't literally
  // name as one (confirmed case: BW11, described only as "midway on
  // horizontal run", but its own piece's remaining length is exactly 2x the
  // independently-validated single-elbow constant -- a real second elbow
  // the text just doesn't call out explicitly).
  manualElbowCount: 0 | 1 | 2 | null;
}

// A fabrication/cut sheet's own printed WELD LIST table, captured verbatim
// so each weld's own weldListId citation can be checked against what the
// row actually says instead of just trusted (see the extraction schema's
// own comment on the weld_list field, and computeIsoQualityFlags for the
// real case -- a continuous table ID sequence spanning both shop and field
// welds -- that motivated this).
export interface WeldListRow {
  id: string;
  nd: string | null;
  type: string | null;
  category: string | null;
  matchedWeldTag: string | null;
  status: "verified" | "mismatch" | "unmatched";
  detail: string | null;
  sourcePage: number | null;
}

// A cut piece and a printed dimension can describe the SAME physical span
// two different ways: the piece as raw straight stock, weld-to-weld; the
// dimension as an assembled measurement that, per the existing dimension
// rules, lands on a FITTING'S OWN CENTERLINE when either end is an elbow
// (not its far weld). When a piece's own two bounding welds match a
// dimension's own two ends (directly by weld tag, or indirectly because
// that weld's own location_note names the same fitting/coordinate the
// dimension references), the difference between the two isn't noise -- it's
// exactly the fitting take-up length the dimension's centerline convention
// adds back in. Two elbows (one at each end) split that difference evenly;
// one elbow attributes all of it to that single end; zero means the gap is
// just ordinary weld/bevel-prep allowance, not a fitting.
export interface ReconciliationRow {
  pieceTag: string;
  cutLengthMm: number | null;
  size: string | null;
  fromRef: string | null;
  toRef: string | null;
  matchedDimensionTag: string | null;
  dimensionValueMm: number | null;
  remainingMm: number | null;
  elbowCount: 0 | 1 | 2 | null;
  perElbowMm: number | null;
  note: string | null;
}

export interface SpoolingView {
  spoolTags: ExtractedTag[];
  weldTags: ExtractedTag[];
  spoolsByPage: Map<number, SpoolRow[]>;
  weldCountsByType: Map<string, number>;
  weldsByType: Map<string, ExtractedTag[]>;
  weldTypesSorted: string[];
  dimensionRows: DimensionRow[];
  cutPieceRows: CutPieceRow[];
  weldListRows: WeldListRow[];
  reconciliationRows: ReconciliationRow[];
  // Welds/dimensions whose own spool_no is blank, or set but doesn't match
  // any spool the extraction actually produced its own tag for -- rendered
  // nowhere else now that welds/dimensions nest under their spool, so these
  // exist to keep that gap visible instead of the data silently vanishing.
  unassignedWelds: SpoolWeldDetail[];
  unassignedDimensions: DimensionRow[];
}

// Classifies a dimension's from_ref/to_ref text by what kind of physical
// feature it names. Priority matters here: a reference commonly mentions
// several things at once (e.g. "F5 G9 B11 tie-in flange / item 7 region"
// names both a flange AND a valve) -- valve wins first since it's the
// domain rule with the sharpest consequence (dimension stops at the flange
// FACE, not a centerline), then gasket/flange, then a weld tag, then an
// in-line fitting, then a tie-in/continuation callout. "item N" alone
// doesn't say what item N IS, so a short document-specific list of this
// sheet's own known valve item numbers (read off its BOM: item 7 the ball
// valve, items 13/14/19 the gate valves) backs up the plain "valve" keyword
// match for references that name the item but not the word.
const KNOWN_VALVE_ITEM_NUMBERS = new Set(["7", "13", "14", "19"]);
// A weld tag present ANYWHERE in a ref is checked first, ahead of valve/
// gasket -- it's the most concrete, unambiguous destination signal (the
// schema's own rule: "always cite a weld tag... never a fitting's
// description"), so it overrides any OTHER landmark word also present in
// the same string. Confirmed real case: "BW06 / item 7 ball valve region"
// contains both a real weld tag AND the word "valve" together -- this
// dimension measures to BW06, a weld, with "ball valve region" merely
// naming the nearby area for orientation, not a real valve boundary.
function classifyDimensionRef(ref: string | null): DimensionRefKind {
  if (!ref) return null;
  if (/\b(BW|SW|FW)\s*0*\d+\b/i.test(ref)) return "weld";
  if (/\bvalves?\b/i.test(ref)) return "valve";
  const itemMatch = /\bitem\s*(\d+)\b/i.exec(ref);
  if (itemMatch && KNOWN_VALVE_ITEM_NUMBERS.has(itemMatch[1])) return "valve";
  // Require the literal word "gasket"/"flange" -- an "F12 G23 B11"-style
  // item-balloon code on its own does NOT mean this exact point is a real
  // gasket/flange boundary; those codes get cited constantly just to name
  // whatever flange/gasket/bolt items sit nearby, including on ordinary
  // shop-welded stub flanges well inside a spool (confirmed real case:
  // "spectacle blind item 8 / F12 G23 B11 joint" is measuring the PIPE RUN
  // up to that point, not the joint's own length -- matching gasket on the
  // bare code alone wrongly tagged it "gasket" instead of "pipe").
  if (/\bgaskets?\b|\bflanges?\b/i.test(ref)) return "gasket";
  if (/\belbows?\b|\btees?\b|\bweldolets?\b|\breducers?\b/i.test(ref)) return "fitting";
  if (/\btie-?in\b|\bcont\.?\s*(on|from)\b/i.test(ref)) return "tie-in";
  return null;
}

// Cross-end demotion: a "valve" reading on ONE end is downgraded when the
// OTHER end resolves to a concrete weld tag -- confirmed real case: DIM1-16
// reads "TT-0003 / G15 B11 / item 14 gate valve" -> "BW18 on 25mm instrument
// branch". The toRef's own weld tag (BW18) is this dimension's real,
// unambiguous destination (a weldolet-to-branch-weld span); "item 14 gate
// valve" in the fromRef only orients WHERE that branch tap-off sits (a
// different, unrelated valve elsewhere on the line), not what this
// dimension itself measures to. A genuine weld-to-valve dimension (one
// truly terminating at a valve's own flange face) hasn't shown a weld tag
// competing on its OTHER end in any case seen so far -- when it does, the
// weld tag wins.
function demoteCrossEndValve(fromKind: DimensionRefKind, toKind: DimensionRefKind): [DimensionRefKind, DimensionRefKind] {
  const from = fromKind === "valve" && toKind === "weld" ? null : fromKind;
  const to = toKind === "valve" && fromKind === "weld" ? null : toKind;
  return [from, to];
}

function weldTagsIn(s: string | null | undefined): string[] {
  if (!s) return [];
  return (s.match(/\b(BW|SW|FW)\s*0*\d+\b/gi) ?? []).map((t) => t.replace(/\s+/g, "").toUpperCase());
}
// A printed coordinate signature like "E1725430", "N1208328", "EL+103262"
// -- shared between a weld's own location_note and a dimension's ref text
// when both are naming the same fitting, even though the dimension itself
// never cites a weld tag directly (it names the fitting's own centerline).
function coordTokensIn(s: string | null | undefined): string[] {
  if (!s) return [];
  return (s.match(/\b[EN]\d{6,}\b|\bEL\s*[+-]?\d{5,}\b/gi) ?? []).map((t) => t.replace(/\s+/g, "").toUpperCase());
}
function refMatchesEnd(weldTag: string | null, weldLocationNote: string | null, dimEndText: string | null): boolean {
  if (!weldTag || !dimEndText) return false;
  if (weldTagsIn(dimEndText).includes(weldTag)) return true;
  const weldCoords = coordTokensIn(weldLocationNote);
  const dimCoords = coordTokensIn(dimEndText);
  return weldCoords.some((c) => dimCoords.includes(c));
}
// Same verified-connection signal as refMatchesEnd (a shared weld tag or a
// shared printed coordinate), applied dimension-end to dimension-end rather
// than weld to dimension-end -- this is what lets two dimensions be
// recognized as continuing from the same physical joint.
function refsShareJoint(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const aTags = weldTagsIn(a);
  if (aTags.length > 0 && aTags.some((t) => weldTagsIn(b).includes(t))) return true;
  const aCoords = coordTokensIn(a);
  return aCoords.length > 0 && aCoords.some((c) => coordTokensIn(b).includes(c));
}
// Chains consecutive dimensions end-to-end when no single printed dimension
// spans a cut piece's own two bounding welds, but a SEQUENCE of them does --
// confirmed real case: a piece needed 3 dimensions chained together (elbow
// -> a branch weld -> a weldolet -> the far flange), no single dimension
// covering the whole span, previously requiring a manual override each time
// this shape came up. Only links two dimensions via the SAME verified
// signal refMatchesEnd already uses (a shared weld tag or printed
// coordinate) -- never a fuzzy text/phrase match, since two dimensions
// merely using similar wording is not proof they share a physical joint.
// Bounded search depth and stops at the FIRST (shortest) chain found each
// hop, since a longer alternate path through unrelated dimensions is far
// more likely to be a coincidental token overlap than the real physical
// route.
const MAX_CHAIN_HOPS = 4;
function findDimensionChain(
  pFromTag: string | null,
  pFromLoc: string | null,
  pToTag: string | null,
  pToLoc: string | null,
  pool: DimensionRow[]
): DimensionRow[] | null {
  type ChainState = { chain: DimensionRow[]; endRef: string | null };
  let frontier: ChainState[] = [];
  for (const d of pool) {
    if (!d.valueMm) continue;
    if (refMatchesEnd(pFromTag, pFromLoc, d.fromRef)) frontier.push({ chain: [d], endRef: d.toRef });
    if (refMatchesEnd(pFromTag, pFromLoc, d.toRef)) frontier.push({ chain: [d], endRef: d.fromRef });
  }
  for (let hop = 1; hop <= MAX_CHAIN_HOPS; hop++) {
    const reached = frontier.find((s) => refMatchesEnd(pToTag, pToLoc, s.endRef));
    if (reached) return reached.chain;
    if (hop === MAX_CHAIN_HOPS) break;
    const next: ChainState[] = [];
    for (const state of frontier) {
      const used = new Set(state.chain.map((d) => d.tagNumber));
      for (const d of pool) {
        if (!d.valueMm || used.has(d.tagNumber)) continue;
        if (refsShareJoint(state.endRef, d.fromRef)) next.push({ chain: [...state.chain, d], endRef: d.toRef });
        else if (refsShareJoint(state.endRef, d.toRef)) next.push({ chain: [...state.chain, d], endRef: d.fromRef });
      }
    }
    frontier = next;
  }
  return null;
}

// Finds item-balloon citations in a free-text field and resolves each one
// against the given sheet's own BOM (item_no -> bom_item lookup, already
// scoped to the right page by the caller). Two citation shapes: "F12"/
// "G23"/"B11" (a single letter -- Flange/Gasket/Bolt -- immediately
// followed by the item number, the printed convention for a joint's own
// hardware trio) and bare "item 12". Both normalize to the same bare
// item_no for lookup. Overlapping matches are deduped, first match wins
// (the two patterns can't legitimately overlap on real text, but a
// malformed string shouldn't produce garbled overlapping spans).
function findItemCitations(text: string | null, bomByItemNo: Map<string, NonNullable<ItemCitation["bomItem"]>[]>): ItemCitation[] {
  if (!text) return [];
  function resolve(itemNo: string): Pick<ItemCitation, "bomItem" | "ambiguous"> {
    const matches = bomByItemNo.get(itemNo) ?? [];
    return { bomItem: matches[0] ?? null, ambiguous: matches.length > 1 };
  }
  const raw: ItemCitation[] = [];
  const codeRe = /\b([FGB])\s*0*(\d+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = codeRe.exec(text))) {
    raw.push({ start: m.index, end: m.index + m[0].length, raw: m[0], itemNo: m[2], ...resolve(m[2]) });
  }
  const itemRe = /\bitem\s*0*(\d+)\b/gi;
  while ((m = itemRe.exec(text))) {
    raw.push({ start: m.index, end: m.index + m[0].length, raw: m[0], itemNo: m[1], ...resolve(m[1]) });
  }
  raw.sort((a, b) => a.start - b.start);
  const result: ItemCitation[] = [];
  let lastEnd = -1;
  for (const c of raw) {
    if (c.start < lastEnd) continue;
    result.push(c);
    lastEnd = c.end;
  }
  return result;
}

// A joint's own hardware trio (flange + gasket + bolt, "F12 G23 B11") is
// normally cited together -- confirmed real case: this sheet cites "G9"
// twice near item 7's valve (DIM1-6, DIM1-7) with no flange code either
// time, unlike its other bolted joints where all three appear together
// (e.g. "F12 G23 B11" at the spectacle blind). A gasket with no flange
// cited alongside it in the SAME text is the printed drawing's own
// incomplete item-balloon set showing up in the extraction -- worth a
// human look, though this can only see what's already in the extracted
// text, not confirm a balloon is truly absent from the drawing itself.
function gasketWithoutFlange(citations: ItemCitation[]): boolean {
  const hasGasket = citations.some((c) => c.bomItem?.componentType?.toUpperCase() === "GASKET");
  const hasFlange = citations.some((c) => c.bomItem?.componentType?.toUpperCase() === "FLANGE");
  return hasGasket && !hasFlange;
}

// Pipe spools + weld list -- straight off this ISO's own extracted tags, no
// cross-document referencing needed. Pure function: same input always
// produces the same grouping/sorting, independent of the DB.
export function buildSpoolingView(tags: ExtractedTag[]): SpoolingView {
  // A spool tag's own tagNumber isn't consistently formatted (the full
  // line-prefixed string like "8\"-...-N-01" for some spools, just "12" for
  // others, an inconsistency inherited from extraction) -- sorting by
  // Number(tagNumber) directly yields NaN for the full-string form, which
  // made this order effectively arbitrary instead of ascending.
  function spoolNumberKey(tagNumber: string): string {
    // No hyphen requirement -- a weld's own spool_no is always the bare
    // number, but a dimension's spool_no attribute inconsistently shows up
    // as "spool 01" (space, not hyphen) as well as bare "02" for the same
    // document, so this has to catch trailing digits regardless of what
    // precedes them.
    const m = /(\d+)\s*$/.exec(tagNumber.trim());
    return m ? m[1] : tagNumber;
  }
  const spoolTags = [...tags.filter((t) => t.tagType === "spool")].sort(
    (a, b) => (a.sourcePage ?? 0) - (b.sourcePage ?? 0) || Number(spoolNumberKey(a.tagNumber)) - Number(spoolNumberKey(b.tagNumber))
  );
  const weldTags = [...tags.filter((t) => t.tagType === "weld")].sort((a, b) => (a.sourcePage ?? 0) - (b.sourcePage ?? 0));

  // Which spool numbers actually exist as their own spool tag -- a weld or
  // dimension whose own spool_no is blank, OR set but doesn't match any of
  // these (a typo, or a spool the extraction never produced its own tag
  // for), has nowhere to nest and would otherwise vanish from the page
  // entirely now that welds/dimensions render only inside their spool's own
  // sub-table (see unassignedWelds/unassignedDimensions below).
  const existingSpoolKeys = new Set(spoolTags.map((t) => spoolNumberKey(t.tagNumber)));

  // BOM items are recorded per-page, same as everything else -- item_no
  // (e.g. "12") is only unique WITHIN one sheet's own BOM, so lookups must
  // stay scoped by page rather than pooled across the whole document.
  // Collects an ARRAY per item_no rather than overwriting on collision --
  // confirmed real case: item "13" appeared twice on the same sheet (a
  // gate valve and an unrelated gasket), which a plain overwrite would
  // have silently resolved to whichever loaded last, wrong for any
  // citation that actually meant the other one.
  const bomByItemNoByPage = new Map<number, Map<string, NonNullable<ItemCitation["bomItem"]>[]>>();
  for (const t of tags) {
    if (t.tagType !== "bom_item") continue;
    const page = t.sourcePage ?? 0;
    const a = t.attributes as Record<string, unknown>;
    const map = bomByItemNoByPage.get(page) ?? new Map<string, NonNullable<ItemCitation["bomItem"]>[]>();
    const list = map.get(t.tagNumber.trim()) ?? [];
    list.push({
      description: typeof a.description === "string" ? a.description : null,
      componentType: typeof a.component_type === "string" ? a.component_type : null,
      size: typeof a.size === "string" ? a.size : null,
      material: typeof a.material === "string" ? a.material : null,
    });
    map.set(t.tagNumber.trim(), list);
    bomByItemNoByPage.set(page, map);
  }
  function bomForPage(page: number | null): Map<string, NonNullable<ItemCitation["bomItem"]>[]> {
    return bomByItemNoByPage.get(page ?? 0) ?? new Map();
  }

  // Collapses a spool's own weld tags into compact ranges (e.g. "SW01-SW06,
  // FW01") instead of listing every single one -- SW and FW are separate
  // numbering sequences (see the extraction prompt's own numeric-continuity
  // rule), so a run is only ever collapsed within the same prefix, never
  // across the two.
  function compactWeldRanges(tagNumbers: string[]): string {
    const parsed = tagNumbers
      .map((t) => {
        const m = /^([A-Za-z]+)0*(\d+)$/.exec(t.replace(/\s+/g, ""));
        return m ? { prefix: m[1].toUpperCase(), num: Number(m[2]), raw: t } : null;
      })
      .filter((v): v is { prefix: string; num: number; raw: string } => v !== null);
    const byPrefix = new Map<string, { num: number; raw: string }[]>();
    for (const p of parsed) {
      const list = byPrefix.get(p.prefix) ?? [];
      list.push({ num: p.num, raw: p.raw });
      byPrefix.set(p.prefix, list);
    }
    const groups: string[] = [];
    for (const entries of byPrefix.values()) {
      const sorted = [...entries].sort((a, b) => a.num - b.num);
      let runStart = sorted[0];
      let runEnd = sorted[0];
      const flush = () => groups.push(runStart === runEnd ? runStart.raw : `${runStart.raw}-${runEnd.raw}`);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].num === runEnd.num + 1) {
          runEnd = sorted[i];
        } else {
          flush();
          runStart = sorted[i];
          runEnd = sorted[i];
        }
      }
      flush();
    }
    return groups.join(", ");
  }

  // A weld's own spool_no attribute is always the bare spool number (e.g.
  // "01", "12") -- matched against a spool's tagNumber via spoolNumberKey
  // since that isn't consistently the same bare form.
  const weldTagsBySpool = new Map<string, string[]>();
  // Same grouping, but keeping each weld's own type/location so the spool
  // table can show what each individual weld connects to, not just the
  // compact range.
  const weldDetailsBySpool = new Map<string, SpoolWeldDetail[]>();
  const unassignedWelds: SpoolWeldDetail[] = [];
  function weldSortKey(tagNumber: string): [string, number] {
    const m = /^([A-Za-z]+)\s*0*(\d+)$/.exec(tagNumber.replace(/\s+/g, ""));
    return m ? [m[1].toUpperCase(), Number(m[2])] : [tagNumber, 0];
  }
  for (const t of weldTags) {
    const a = t.attributes as Record<string, unknown>;
    const spoolNo = a.spool_no;
    const locationNote = typeof a.location_note === "string" && a.location_note ? a.location_note : "-";
    const weldItemCitations = findItemCitations(locationNote, bomForPage(t.sourcePage));
    const detail: SpoolWeldDetail = {
      tagNumber: t.tagNumber,
      weldType: typeof a.weld_type === "string" && a.weld_type ? a.weld_type : "-",
      size: typeof a.size === "string" && a.size ? a.size : null,
      weldListId: typeof a.weld_list_id === "string" && a.weld_list_id ? a.weld_list_id : null,
      weldListFlag: typeof a.weld_list_flag === "string" ? a.weld_list_flag : null,
      sizeFlag: typeof a.size_flag === "string" ? a.size_flag : null,
      locationNote,
      geometryFlag: typeof a.geometry_flag === "string" ? a.geometry_flag : null,
      geometryGroupFlag: typeof a.geometry_group_flag === "string" ? a.geometry_group_flag : null,
      spoolNoCorrectedFrom: typeof a.spool_no_corrected_from === "string" ? a.spool_no_corrected_from : null,
      locationNoteCorrectedFrom: typeof a.location_note_corrected_from === "string" ? a.location_note_corrected_from : null,
      itemCitations: weldItemCitations,
      gasketWithoutFlange: gasketWithoutFlange(weldItemCitations),
    };
    if (typeof spoolNo !== "string" || !spoolNo || !existingSpoolKeys.has(spoolNumberKey(spoolNo))) {
      unassignedWelds.push(detail);
      continue;
    }
    const list = weldTagsBySpool.get(spoolNo) ?? [];
    list.push(t.tagNumber);
    weldTagsBySpool.set(spoolNo, list);
    const details = weldDetailsBySpool.get(spoolNo) ?? [];
    details.push(detail);
    weldDetailsBySpool.set(spoolNo, details);
  }
  for (const details of [...weldDetailsBySpool.values(), unassignedWelds]) {
    details.sort((x, y) => {
      const [px, nx] = weldSortKey(x.tagNumber);
      const [py, ny] = weldSortKey(y.tagNumber);
      return px === py ? nx - ny : px.localeCompare(py);
    });
  }

  const spoolsByPage = new Map<number, SpoolRow[]>();
  for (const t of spoolTags) {
    const page = t.sourcePage ?? 0;
    const a = t.attributes as Record<string, unknown>;
    const boundaryNote = a.boundary_note;
    const boundingBoxMm = a.bounding_box_mm;
    const shippingContainer = a.shipping_container;
    const containerOrientation = a.container_orientation;
    const boundaryFlag = a.boundary_flag;
    const list = spoolsByPage.get(page) ?? [];
    const key = spoolNumberKey(t.tagNumber);
    const spoolWelds = weldTagsBySpool.get(key);
    list.push({
      spoolNo: t.tagNumber,
      boundaryNote: typeof boundaryNote === "string" ? boundaryNote : null,
      boundingBoxMm: Array.isArray(boundingBoxMm) ? (boundingBoxMm as number[]) : null,
      shippingContainer: typeof shippingContainer === "string" ? shippingContainer : null,
      containerOrientation: Array.isArray(containerOrientation) ? (containerOrientation as ContainerOrientationLeg[]) : null,
      boundaryFlag: typeof boundaryFlag === "string" ? boundaryFlag : null,
      weldRange: spoolWelds && spoolWelds.length > 0 ? compactWeldRanges(spoolWelds) : null,
      welds: weldDetailsBySpool.get(key) ?? [],
      dimensions: [], // filled in below, once dimensionRows exists
    });
    spoolsByPage.set(page, list);
  }

  const weldCountsByType = new Map<string, number>();
  const weldsByType = new Map<string, ExtractedTag[]>();
  for (const t of weldTags) {
    const type = String((t.attributes as Record<string, unknown>).weld_type ?? "unknown");
    weldCountsByType.set(type, (weldCountsByType.get(type) ?? 0) + 1);
    const list = weldsByType.get(type) ?? [];
    list.push(t);
    weldsByType.set(type, list);
  }
  // Shop weld first, field weld second (by far the two biggest groups on a
  // typical ISO), everything else after in whatever order it was found --
  // each type gets its own table since SW/FW counts can differ by an order
  // of magnitude and lumping them together buries the smaller group.
  const WELD_TYPE_ORDER = ["shop weld", "field weld"];
  const weldTypesSorted = [...weldsByType.keys()].sort((a, b) => {
    const ia = WELD_TYPE_ORDER.indexOf(a);
    const ib = WELD_TYPE_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  // "DIM1-2" vs "DIM1-10" -- string comparison sorts "-10" before "-2", so
  // pull the trailing sequence number out and compare numerically instead.
  function dimSortKey(tagNumber: string): number {
    const m = /-(\d+)$/.exec(tagNumber);
    return m ? Number(m[1]) : 0;
  }
  const dimensionRows: DimensionRow[] = tags
    .filter((t) => t.tagType === "dimension")
    .sort((a, b) => (a.sourcePage ?? 0) - (b.sourcePage ?? 0) || dimSortKey(a.tagNumber) - dimSortKey(b.tagNumber))
    .map((t) => {
      const a = t.attributes as Record<string, unknown>;
      const fromRef = typeof a.from_ref === "string" ? a.from_ref : null;
      const toRef = typeof a.to_ref === "string" ? a.to_ref : null;
      const [fromKind, toKind] = demoteCrossEndValve(classifyDimensionRef(fromRef), classifyDimensionRef(toRef));
      const fromRefCitations = findItemCitations(fromRef, bomForPage(t.sourcePage));
      const toRefCitations = findItemCitations(toRef, bomForPage(t.sourcePage));
      return {
        tagNumber: t.tagNumber,
        valueMm: typeof a.value_mm === "string" ? a.value_mm : null,
        axis: typeof a.axis === "string" ? a.axis : null,
        spoolNo: typeof a.spool_no === "string" ? a.spool_no : null,
        fromRef,
        toRef,
        fromKind,
        toKind,
        sourcePage: t.sourcePage,
        spoolFlag: typeof a.spool_flag === "string" ? a.spool_flag : null,
        manualKind:
          a.manual_kind === "weldolet" ? "weldolet" : a.manual_kind === "pipe" ? "pipe" : a.manual_kind === "valve" ? "valve" : null,
        fromRefCitations,
        toRefCitations,
        gasketWithoutFlange: gasketWithoutFlange([...fromRefCitations, ...toRefCitations]),
      };
    });

  // Nests each dimension under the spool it was assigned to (spoolsByPage's
  // own rows, built above) so the spooling page can show them directly
  // under their spool instead of as a separate flat table -- same
  // trailing-digit key as weldTagsBySpool/weldDetailsBySpool use, needed
  // here specifically because a dimension's spool_no is inconsistently
  // "spool 01" vs bare "02" for the same document (see spoolNumberKey).
  const dimensionsBySpool = new Map<string, DimensionRow[]>();
  // Same reasoning as unassignedWelds -- a dimension whose own spool_no is
  // blank, or doesn't match any spool that actually exists, has nowhere to
  // nest and would otherwise vanish from the page entirely.
  const unassignedDimensions: DimensionRow[] = [];
  for (const d of dimensionRows) {
    if (!d.spoolNo || !existingSpoolKeys.has(spoolNumberKey(d.spoolNo))) {
      unassignedDimensions.push(d);
      continue;
    }
    const key = spoolNumberKey(d.spoolNo);
    const list = dimensionsBySpool.get(key) ?? [];
    list.push(d);
    dimensionsBySpool.set(key, list);
  }
  for (const spools of spoolsByPage.values()) {
    for (const s of spools) {
      s.dimensions = dimensionsBySpool.get(spoolNumberKey(s.spoolNo)) ?? [];
    }
  }

  const cutPieceRows: CutPieceRow[] = tags
    .filter((t) => t.tagType === "cut_piece")
    .sort((a, b) => (a.sourcePage ?? 0) - (b.sourcePage ?? 0) || Number(a.tagNumber) - Number(b.tagNumber) || a.tagNumber.localeCompare(b.tagNumber))
    .map((t) => {
      const a = t.attributes as Record<string, unknown>;
      return {
        tagNumber: t.tagNumber,
        cutLengthMm: typeof a.cut_length_mm === "string" ? a.cut_length_mm : null,
        size: typeof a.size === "string" ? a.size : null,
        remarks: typeof a.remarks === "string" ? a.remarks : null,
        end1: typeof a.end1 === "string" ? a.end1 : null,
        end2: typeof a.end2 === "string" ? a.end2 : null,
        fromRef: typeof a.from_ref === "string" ? a.from_ref : null,
        toRef: typeof a.to_ref === "string" ? a.to_ref : null,
        spoolNo: typeof a.spool_no === "string" ? a.spool_no : null,
        sourcePage: t.sourcePage,
        manualDimensionMatch: typeof a.manual_dimension_match === "string" ? a.manual_dimension_match : null,
        manualDimensionNote: typeof a.manual_dimension_note === "string" ? a.manual_dimension_note : null,
        manualElbowCount: a.manual_elbow_count === 0 || a.manual_elbow_count === 1 || a.manual_elbow_count === 2 ? a.manual_elbow_count : null,
      };
    });

  const weldListRows: WeldListRow[] = tags
    .filter((t) => t.tagType === "weld_list_row")
    .sort((a, b) => (a.sourcePage ?? 0) - (b.sourcePage ?? 0) || Number(a.tagNumber) - Number(b.tagNumber) || a.tagNumber.localeCompare(b.tagNumber))
    .map((t) => {
      const a = t.attributes as Record<string, unknown>;
      const matched = weldTags.find((w) => {
        const wa = w.attributes as Record<string, unknown>;
        return typeof wa.weld_list_id === "string" && wa.weld_list_id === t.tagNumber;
      });
      const matchedAttrs = matched?.attributes as Record<string, unknown> | undefined;
      const flag = matchedAttrs && typeof matchedAttrs.weld_list_flag === "string" ? matchedAttrs.weld_list_flag : null;
      return {
        id: t.tagNumber,
        nd: typeof a.nd === "string" ? a.nd : null,
        type: typeof a.type === "string" ? a.type : null,
        category: typeof a.category === "string" ? a.category : null,
        matchedWeldTag: matched?.tagNumber ?? null,
        status: (!matched ? "unmatched" : flag ? "mismatch" : "verified") as WeldListRow["status"],
        detail: flag,
        sourcePage: t.sourcePage,
      };
    });

  const weldLocationNoteByTag = new Map(
    weldTags.map((w) => [w.tagNumber, typeof (w.attributes as Record<string, unknown>).location_note === "string" ? ((w.attributes as Record<string, unknown>).location_note as string) : null])
  );
  const reconciliationRows: ReconciliationRow[] = cutPieceRows
    .filter((p) => p.fromRef && p.toRef && p.cutLengthMm)
    .map((p) => {
      const pFromTag = weldTagsIn(p.fromRef)[0] ?? p.fromRef;
      const pToTag = weldTagsIn(p.toRef)[0] ?? p.toRef;
      const pFromLoc = weldLocationNoteByTag.get(pFromTag ?? "") ?? null;
      const pToLoc = weldLocationNoteByTag.get(pToTag ?? "") ?? null;

      // A manual override (see CutPieceRow.manualDimensionMatch) always wins
      // over the automatic finder below -- it exists for the cases neither
      // the single-dimension match NOR the auto-chain finder can safely
      // resolve on their own. "DIM1-12+DIM1-13" chains two dimensions
      // end-to-end (no single printed dimension spans the piece, but
      // consecutive ones together do) -- summed value, with the elbow count
      // taken only from the chain's own two OUTER ends (the shared internal
      // joint between chained dimensions is never a real boundary of the
      // piece, so it must never be counted).
      const manualTags = p.manualDimensionMatch ? p.manualDimensionMatch.split("+").map((t) => t.trim()) : null;
      let match: Pick<DimensionRow, "tagNumber" | "valueMm" | "fromRef" | "toRef"> | undefined;
      let autoChainNote: string | null = null;
      if (manualTags) {
        const rows = manualTags.map((tag) => dimensionRows.find((d) => d.tagNumber === tag)).filter((d): d is DimensionRow => !!d);
        if (rows.length === manualTags.length) {
          const sum = rows.reduce((acc, d) => acc + (d.valueMm ? Number(d.valueMm) : 0), 0);
          match = { tagNumber: manualTags.join(" + "), valueMm: String(sum), fromRef: rows[0].fromRef, toRef: rows[rows.length - 1].toRef };
        }
      } else {
        match = dimensionRows.find((d) => {
          if (!d.valueMm) return false;
          const straight = refMatchesEnd(pFromTag, pFromLoc, d.fromRef) && refMatchesEnd(pToTag, pToLoc, d.toRef);
          const reversed = refMatchesEnd(pFromTag, pFromLoc, d.toRef) && refMatchesEnd(pToTag, pToLoc, d.fromRef);
          return straight || reversed;
        });
        if (!match) {
          // No single dimension spans this piece -- try chaining consecutive
          // ones together via verified shared joints (see
          // findDimensionChain's own comment). Flagged with a note (amber
          // tint on the page) since this is an algorithmic discovery, not a
          // human-confirmed match like a manual override -- worth a glance,
          // not silently treated as equally certain.
          const chain = findDimensionChain(pFromTag, pFromLoc, pToTag, pToLoc, dimensionRows);
          if (chain) {
            match = {
              tagNumber: chain.map((d) => d.tagNumber).join(" + "),
              valueMm: String(chain.reduce((acc, d) => acc + Number(d.valueMm ?? 0), 0)),
              fromRef: chain[0].fromRef,
              toRef: chain[chain.length - 1].toRef,
            };
            autoChainNote = `Auto-chained ${chain.length} consecutive dimensions (${chain.map((d) => d.tagNumber).join(" -> ")}) via shared weld tags/coordinates -- no single printed dimension spans this piece. Worth a quick check against the drawing, same as any algorithmic match.`;
          }
        }
      }

      if (!match || !match.valueMm) {
        return { pieceTag: p.tagNumber, cutLengthMm: Number(p.cutLengthMm), size: p.size, fromRef: p.fromRef, toRef: p.toRef, matchedDimensionTag: null, dimensionValueMm: null, remainingMm: null, elbowCount: null, perElbowMm: null, note: null };
      }
      const dimValue = Number(match.valueMm);
      const cutLength = Number(p.cutLengthMm);
      const remaining = dimValue - cutLength;
      const elbowCount =
        p.manualElbowCount ?? (((/\belbows?\b/i.test(match.fromRef ?? "") ? 1 : 0) + (/\belbows?\b/i.test(match.toRef ?? "") ? 1 : 0)) as 0 | 1 | 2);
      return {
        pieceTag: p.tagNumber,
        cutLengthMm: cutLength,
        size: p.size,
        fromRef: p.fromRef,
        toRef: p.toRef,
        matchedDimensionTag: match.tagNumber,
        dimensionValueMm: dimValue,
        remainingMm: remaining,
        elbowCount,
        perElbowMm: elbowCount > 0 ? remaining / elbowCount : null,
        note: p.manualDimensionNote ?? autoChainNote,
      };
    });

  return {
    spoolTags,
    weldTags,
    spoolsByPage,
    weldCountsByType,
    weldsByType,
    weldTypesSorted,
    dimensionRows,
    cutPieceRows,
    weldListRows,
    reconciliationRows,
    unassignedWelds,
    unassignedDimensions,
  };
}
