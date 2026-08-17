import { PAGE_RANGE_SCHEMA, type ClaudeTool } from "./common";

// Isometric drawings are usually one drawing per line/spool, each carrying a
// Bill of Material (BOM) table for that line's pipe/fittings/flanges/valves.
// Locate each drawing by its drawing number, then extract each separately --
// same locate -> per-sheet pattern as pid.ts.
export const LOCATE_ISO_SECTIONS_TOOL: ClaudeTool = {
  name: "locate_iso_sheets",
  description:
    "Identifies each isometric SHEET in this document -- one entry per sheet, never one entry covering several sheets. " +
    'A multi-sheet drawing repeats the SAME drawing number on every sheet and distinguishes them only by the title block\'s "SHEET n OF m" field, ' +
    "so key each entry by drawing number AND sheet number and give it its own single-page range. A 3-page document showing " +
    '"SHEET 1 OF 3", "SHEET 2 OF 3", "SHEET 3 OF 3" must return three entries, each with pages start = end = that page.',
  input_schema: {
    type: "object",
    properties: {
      sheets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            drawing_number: { type: "string" },
            sheet: {
              type: "string",
              description: 'The title block\'s sheet field for THIS sheet, e.g. "1 OF 3". Required when the document holds more than one sheet.',
            },
            pages: PAGE_RANGE_SCHEMA,
          },
          required: ["drawing_number", "pages"],
        },
      },
    },
    required: ["sheets"],
  },
};

// Measured values carry their unit inline, read from the title block's own
// column header (e.g. a "PRESS. kPag" column of 5 becomes "5 kPag", a
// "TEMP. °C" column of 90 becomes "90 °C"). Units on ISOs and line lists
// frequently differ (kPag vs barg is common), so gate 2 converts before
// comparing -- see convertPressure in apps/web/src/lib/verifyIso.ts. That
// conversion is only possible if the unit is captured here.
export const ISO_SHEET_TOOL: ClaudeTool = {
  name: "record_iso_sheet",
  description:
    "Records the title block info, line/spec info, and Bill of Material rows for one isometric drawing. Append the unit from the title block's column header to every measured value (e.g. \"5 kPag\", \"90 °C\", \"25 mm\"). Leave non-numeric placeholders such as NA / NIL. / AMB. exactly as printed.",
  input_schema: {
    type: "object",
    properties: {
      document_number: { type: "string" },
      drawing_number: { type: "string" },
      line_number: { type: "string" },
      size: { type: "string", description: 'Nominal size as printed, e.g. "2\\"" or "50 mm"' },
      spec_class: { type: "string" },
      service: { type: "string" },
      from_location: {
        type: "string",
        description:
          "Where the pipeline STARTS, read from the drawn pipe run itself: follow the piping in the flow direction and record the callout at its start point -- an equipment/nozzle connection (e.g. \"N1 / V-101\"), a tie-in flag, or a \"CONT'D FROM <drawing no.>\" continuation box. This is on the drawing at the end of the pipe, not in the title block.",
      },
      to_location: {
        type: "string",
        description:
          "Where the pipeline ENDS, read from the drawn pipe run itself: the callout at the far end of the piping -- an equipment/nozzle connection, tie-in flag, or \"CONT'D ON <drawing no.>\" continuation box.",
      },
      slope: { type: "string", description: 'Any slope annotation printed on the drawing, e.g. "1:100", "SLOPE 1:100 TOWARDS V-101". Read the printed note; do not infer slope from the geometry. Leave blank if none is shown.' },
      scale: { type: "string" },
      sheet: { type: "string" }, // e.g. "1 OF 4"
      revision: { type: "string" },
      owner_pid_no: { type: "string" }, // owner/client's own P&ID drawing number, if different from pid_no
      pid_no: { type: "string" }, // the P&ID drawing number this ISO cross-references
      owner_ga_dwg_no: { type: "string" },
      ga_dwg_no: { type: "string" }, // the GA drawing number this ISO cross-references
      design_pressure: { type: "string", description: 'DESIGN row, PRESS. column, with the header\'s unit, e.g. "10.5 kPag"' },
      design_temperature: { type: "string", description: 'DESIGN row, TEMP. column, with unit, e.g. "150 °C"' },
      operating_pressure: { type: "string", description: 'OPERATING row, PRESS. column, with unit, e.g. "5 kPag"' },
      operating_temperature: { type: "string", description: 'OPERATING row, TEMP. column, with unit, e.g. "90 °C"' },
      hydrotest_pressure: { type: "string", description: "HYDROTEST row, PRESS. column, with unit" },
      hydrotest_temperature: { type: "string", description: 'HYDROTEST row, TEMP. column, with unit (or "AMB." as printed)' },
      painting_system: { type: "string" },
      radiograph: { type: "string" },
      test_type: { type: "string" },
      insul_spec: { type: "string" },
      insul_thickness_mm: { type: "string", description: 'Insulation thickness with unit, e.g. "25 mm"' },
      spec_breaks: {
        type: "array",
        description:
          'Spec (material class) breaks drawn on this isometric. A break is marked by "MATL <class>" callout boxes either side of a joint (usually a flanged joint), and/or by a continuation line number carrying a different class. Record one entry per class present on the drawing, INCLUDING the title-block class. Leave the array empty only when the whole drawing is one class.',
        items: {
          type: "object",
          properties: {
            spec_class: { type: "string", description: 'The piping/material class code, e.g. "AC03N", "BC70N"' },
            rating: {
              type: "string",
              description:
                'This class\'s ASME pressure class as a bare number when it can be told from the drawing or BOM, e.g. "150" or "300". A 150#/300# spec break shows both ratings in the BOM (150# flanges/gaskets/150RF bolts vs 300# ones); the class on the higher-rated side is the higher number. Blank if not determinable.',
            },
            location_note: {
              type: "string",
              description: 'Where this class applies / where the break sits, as drawn, e.g. "downstream of flanged joint at check valve, toward CONT. ON 18\\"-22-214-01-CRD-0001-BC70N-N"',
            },
          },
          required: ["spec_class"],
        },
      },
      bom_items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            item_no: { type: "string" }, // the BOM row's own ID/item number (e.g. "1", "2")
            description: { type: "string" },
            component_type: { type: "string" }, // pipe | fittings | fasteners | valves | pipe supports | instruments | ...
            size: { type: "string" },
            quantity: { type: "string" },
            material: { type: "string" },
            item_code: { type: "string" }, // the BOM's "ITEM CODE" column (e.g. "P9610-C", "HK9511") -- references a specific row in the piping spec, NOT a class code like "150JY11"
            item_spec_basis: {
              type: "string",
              description:
                'How item_spec_class was decided, so it can be audited: "position" (traced the item\'s balloon to a point up/downstream of the MATL callout), "rating" (placed by its own pressure class), "rate-matched gasket" (the break-joint gasket taking the higher class), or "sheet has no spec break". Blank when item_spec_class is blank.',
            },
            item_spec_class: {
              type: "string",
              description:
                'When the drawing has a spec break (see spec_breaks), the class that governs THIS item -- the side of the break it belongs to. A spec break is a POINT on the run, so EVERY item sits on one definite side; assign all of them, including un-rated ones. ' +
                'Use two signals. (1) POSITION -- follow each BOM item number\'s balloon/leader to where it sits on the drawn run and see whether that point is upstream or downstream of the "MATL" callouts; this is the only way to place plain pipe, weldolets and butt-weld elbows/tees/reducers, which carry no rating. A repeated item code split across two BOM rows is the giveaway that one row is each side of the break (e.g. TUBE-9 28.1M on the long upstream run and TUBE-9 1.5M on the short stub past the break; ELBO-31 qty 7 upstream and ELBO-31 qty 1 downstream) -- place each row by where its balloons actually are. ' +
                '(2) RATING, for rated items AWAY FROM THE BREAK JOINT -- a "150# RF" flange, gasket, 150RF bolt or 150# valve is the 150# class, a "300# RF" one or an alloy-overlay valve is the 300# class. ' +
                'CRITICAL: rating does NOT identify the side AT the break joint, because the joint is rate-matched to the HIGHER class. The mating flange on the lower-rated side, together with the joint gasket and its bolts, is made to the higher rating so the two flanges bolt together -- yet that flange still BELONGS to the lower class, because the break is at the joint face, after it. So on a 150#/300# break, a 300# flange sitting upstream of the MATL callout is a 150#-class (AC03N) item rate-matched up, NOT a 300#-class item. Place all break-joint hardware by POSITION and record basis "position (rate-matched to the higher class)". ' +
                'Never place by rating where the rating comes from the component\'s own standard rather than the line class either: ASME B16.36 orifice flanges (and their gaskets) start at 300#, so a 150# line\'s orifice assembly is 300# with no break involved -- place those by position too. ' +
                'Leave blank ONLY when the drawing genuinely does not show which side an item is on. Blank on single-class drawings and on sheets with no break.',
            },
          },
          required: ["item_no", "description"],
        },
      },
    },
    required: ["line_number", "bom_items"],
  },
};

// Split out from ISO_SHEET_TOOL as its own tool call, each sheet gets its own
// full output-token budget for spool tracking -- confirmed on a real run
// that packing a full BOM (20+ rows) AND spools AND a welds array running
// into the dozens AND route_points AND dimensions into ONE response ran out
// of room even at a generous max_tokens, with welds specifically coming back
// near-empty on sheets where the BOM alone was already large. Uses the same
// page image(s) as ISO_SHEET_TOOL for this sheet, just a separate call.
export const ISO_SPOOL_TRACKING_TOOL: ClaudeTool = {
  name: "record_iso_spool_tracking",
  description:
    "Records this isometric sheet's pipe spool boundaries, route coordinates, welds, and dimensions -- the data behind the spool/weld-list tracking view. This is a separate call from the title-block/BOM extraction specifically so it gets its own full output budget; treat completeness here as being just as important as the BOM itself. Apply the SAME tracing effort to every sheet regardless of its length or weld count -- a sheet with many spools/welds is not licence for shorter, vaguer boundary_notes or location_notes than a simple one; if anything it needs MORE care, not less, since there is more to get wrong.",
  input_schema: {
    type: "object",
    properties: {
      spools: {
        type: "array",
        description:
          'Every pipe spool on this sheet -- cross-check against the sheet\'s own printed "PIPE SPOOLS" list under the BOM (e.g. "PIPE SPOOLS [1] [2]") for the spool NUMBERS, but also determine each one\'s real boundary by walking the route and classifying EVERY joint/weld mark you cross by its CONNECTION TYPE, not by hunting for the letters "FW":\n' +
          '- SHOP WELD (SW) -- never a boundary. It joins pieces together INSIDE one spool during fabrication, so a run of many SW marks in a row all stay in the SAME spool.\n' +
          '- FIELD WELD (FW) -- always a boundary. A weld done on site means the two sides were fabricated and shipped as separate pieces.\n' +
          '- A BOLTED/FLANGED joint (two flanges mating face to face) -- ALSO always a boundary, even where the drawing gives it no "FW" tag at all. A bolt-up connection is inherently field-made -- that is what flanges are for. Do not confuse this with a flange that is shop-welded onto a pipe stub (SW mark) and stays inside the spool; the boundary is the BOLTED FACE where two separate flanges meet, not every flange symbol on the drawing. SPOTTING ONE WITH NO "FW" TEXT: an isometric commonly marks a bolted joint with a cluster of balloon callouts sitting together AT one point on the route -- a flange item number, a gasket item number, and a bolt item number, often printed as a compact group like "F5/G9/B11" (Flange-item5, Gasket-item9, Bolt-item11). A gasket only ever exists BETWEEN two mating flange faces, so wherever a flange+gasket+bolt group is clustered at one point along the run -- with no weld mark AT that same point -- that cluster IS the field-bolted joint, and therefore a spool boundary, whether or not it also carries an "FW" tag. Don\'t mistake a shop-welded stub flange (a flange item balloon sitting right next to an SW mark, no separate gasket+bolt group with it) for this -- that one stays inside the spool.\n' +
          '- A VALVE sitting in the run -- ALSO always a boundary, for the same reason as a flange bolt-up: a valve is essentially always installed flanged/bolted (see its own BOM description -- "FLANGED-RF TO ASME B16.5" etc.), so both faces where it bolts to the adjoining pipe are field joints. When walking the route and you cross a valve\'s own BOM item balloon, that spool ENDS at the last shop weld before the valve, and a NEW spool STARTS at the next shop weld after it -- the valve itself sits at the boundary, belonging to neither spool\'s own weld list (like any other boundary component). A line with several valve items (check valve counts/qty in the BOM -- one item row can mean several physical instances) creates one boundary PER physical valve encountered along the walk, not just once per item row. CONFIRMED EXAMPLE: a 200mm trunnion ball valve sitting in the main run right before a shop weld tagged SW07 is exactly this case -- the spool ending there stops at the last shop weld before the valve (e.g. SW06), and the NEXT spool starts at SW07, with the valve\'s own flange-gasket-bolt cluster (see the flange-bolt-up bullet above) as the physical marker of that boundary, not a separate, unrelated flange joint. Don\'t treat a valve\'s bolt-up cluster as "just a flange near a valve" and miss that it IS the boundary because a valve sits right there.\n' +
          'So a spool boundary is wherever the run crosses an FW, a flange bolt-up, OR a valve -- whichever comes first walking the route -- never a shop weld. Follow the bracketed spool-number marks drawn along the route (e.g. "[1]", "[2]") to confirm where one spool ends and the next begins, but the connection-type classification above is the authoritative boundary, not just where a bracket happens to be drawn. ' +
          'USEFUL SHORTCUT, WITH A CAVEAT: SW and FW tags are usually numbered in the order the route is walked, each its own sequence (SW1, SW2... and FW1, FW2... separately), so once you find which weld number a boundary falls at, the weld numbers right after it usually belong to the next spool as a block. Treat this as a strong hint, NOT an absolute rule -- it breaks at a BRANCH: a side branch off the main run commonly gets its own short run of numbers carved out of the middle of what would otherwise be one continuous block (e.g. the main run gets SW01, SW02, then the drafter detours to number the branch\'s own welds SW03-SW05, then RESUMES the main run at SW06 onward) -- so a branch\'s spool can hold numbers that interrupt its neighboring spool\'s own sequence rather than sitting in a clean range after it. Whenever a branch is present, verify each weld\'s spool by which physical line it is actually drawn on (the connection-type walk above), and only fall back to pure numeric continuity on a straight run with no branch. ' +
          "SANITY CHECK: a real spool is only ever a shippable size (see below) -- if the connection-type walk implies a spool's own run is approaching roughly 6000mm with no FW or flange bolt-up crossed yet, that is a strong signal a boundary was missed on the drawing (or misread), not that the run genuinely continues that far as one piece. Look again for a boundary mark near that point before concluding the spool keeps going. " +
          "HARD CONSTRAINT, CHECK BEFORE FINALIZING: a single spool_no must never end up attached to TWO different FW or flange-bolt-up welds in the welds array below. Each real spool has exactly ONE terminating boundary (its own upstream FW/flange, per the rule above) -- if your walk would attach a second FW or flange bolt-up to a spool_no that already has one, that is proof a boundary between them was missed, not that the spool legitimately spans both. When you find this, stop and split: everything from just after the FIRST FW/flange up to (and including) the SECOND becomes its own additional spool, with spool_no incremented for it and renumbered for everything downstream of it. Do this check across the whole sheet before finalizing the spools, welds, route_points, and dimensions arrays. " +
          "A SHORT SPOOL CAN LEGITIMATELY HAVE ZERO SHOP WELDS: a spool bounded by two closely-spaced boundaries (e.g. FW03 starting it, FW04 ending it, with nothing in between) is completely normal and must not be padded out with nearby SW tags just because they carry close numbers or sit near this spool's bracketed label on the page -- that is a real, separate error mode, distinct from the missed-boundary case above. Include a shop weld in a spool ONLY when you can trace the physical pipe line and confirm that weld sits ON the run strictly between this spool's own two boundary joints. If a block of SW tags (e.g. SW70-SW78) turns out to sit on a different physical line/branch than the one between your two FWs, they belong to whichever spool that other line is actually part of, not to this one -- proximity on the page or in the numbering is never sufficient on its own. " +
          "A ZERO-SW SPOOL DOES NOT CONSUME ANY SW NUMBERS: since the SW sequence numbers shop welds, not spools, a spool with none of its own leaves the SW count completely uninterrupted -- the next spool's own SW range picks up immediately where the last spool's left off, with NO gap. E.g. if one spool's shop welds end at SW55 and the next two spools (bounded by FW alone) have zero SW each, the following spool that DOES have shop welds starts at SW56, not some later number -- don't skip ahead assuming the zero-SW spools each used up a block of numbers themselves. " +
          'THIS BOUNDARY WALK IS THE SINGLE SOURCE OF TRUTH for the whole sheet -- route_points, welds, and dimensions below all assign spool_no by re-applying this exact same walk (branches and the 6000mm sanity check included), never independently. A point/weld/dimension must never be placed in a spool it would fall outside of by this logic, even if that leaves its own spool_no blank. ' +
          'boundary_note QUALITY BAR: a boundary_note that only restates the spool number or says something generic like "next spool along the main run" with no joint actually named at either end is NOT acceptable, even on a long or repetitive sheet -- it is a sign the boundary walk for that spool was not actually carried out. Every boundary_note must name the real joint/weld/tie-in at BOTH ends, the same way the examples above do ("from FW01 to FW02, spanning items 4-9, includes 2 elbows and the trunnion ball valve"). If you cannot name both ends, that means the walk still needs doing, not that a placeholder is good enough. ' +
          'blank spool_no ACROSS A WHOLE SHEET IS A RED FLAG, NOT A DEFAULT: leaving an individual weld\'s spool_no blank because of genuine boundary ambiguity (see route_points/welds/dimensions below) is correct and should be rare. Ending up with MOST OR ALL of a sheet\'s welds unassigned -- e.g. every spool on the sheet showing zero welds -- means the boundary walk was not done carefully enough for that sheet, not that this sheet is unusually ambiguous. Before finalizing, if that pattern shows up, re-trace the sheet with the same weld-by-weld care used on a short sheet rather than accepting the blanks.',
        items: {
          type: "object",
          properties: {
            spool_no: {
              type: "string",
              description:
                'The BARE spool number only -- "1", "2", "12" -- never the full line-tagged name some "PIPE SPOOLS" lists print (e.g. print "8"-22-214-01-CRD-0002-AC03N-N-01", record just "01" or "1"). Every other array below (route_points, welds, dimensions) cross-references a point/weld/dimension to its spool by exact string match against THIS value -- a spool numbered "1" here but referenced as the full line name somewhere else silently breaks that match, so pick one bare format and use it identically everywhere on this sheet.',
            },
            boundary_note: {
              type: "string",
              description:
                'Where this spool starts and ends on the drawn route, in terms of the FW/erection joint or tie-in at each end (e.g. "from the battery-limit tie-in flange to FW01" or "from FW01 to FW02, spanning items 4-9, includes 2 elbows and the trunnion ball valve") -- never describe a boundary as a shop weld.',
            },
          },
          required: ["spool_no"],
        },
      },
      route_points: {
        type: "array",
        description:
          'Every 3D coordinate callout printed along the drawn route on this sheet -- isometrics routinely label vertices/bends/tie-ins with "E <easting> N <northing> EL <elevation>" (or similar). These exist so a spool\'s real fabricated size can be checked (for shipping-container fit) from its own coordinate spread, rather than guessed from the 2D drawing. Record every occurrence on this sheet -- these ALSO drive the dimensions array\'s own axis field below (whichever of E/N/EL changes between two coordinate points tells you the axis of the dimension line between them), so capturing every callout here directly improves how confidently that field can be filled in. ' +
          "CRITICAL: assign spool_no by re-walking the SAME connection-type boundary logic as the spools array (SW never crosses a boundary, FW and flange bolt-ups always do) -- do not just attach a point to whichever spool number is nearest on the page. If a point sits exactly at a boundary, or you are not confident which side it is really on, leave spool_no blank rather than guessing -- an unassigned point is safer than a wrongly-assigned one, since a wrong assignment silently inflates that spool's measured size. " +
          "Leave the whole array empty if this sheet prints no coordinate callouts.",
        items: {
          type: "object",
          properties: {
            spool_no: { type: "string", description: "Which spool this point falls inside, in the SAME bare format as the spools array's own spool_no (see its description) -- must string-match it exactly. Leave blank if uncertain -- see the array's own description for why." },
            easting_mm: { type: "string", description: 'The E value exactly as printed, e.g. "1725430".' },
            northing_mm: { type: "string", description: 'The N value exactly as printed, e.g. "1208328".' },
            elevation_mm: { type: "string", description: 'The EL value exactly as printed, sign included, e.g. "+103262" or "-450".' },
            location_note: { type: "string", description: 'What this point is at, e.g. "tee elbow near item 4" or "tie-in at battery limit".' },
          },
          required: ["easting_mm", "northing_mm", "elevation_mm"],
        },
      },
      welds: {
        type: "array",
        description:
          'Every weld/joint mark drawn along the pipe route on THIS sheet, per the symbols defined in the drawing\'s own legend row (shop weld, field weld, socket weld, screwed joint, compression joint, site connection -- the exact symbols and their meaning are printed once, usually along the bottom of the sheet). Sweep the whole run end to end and record every mark, including repeated/small ones near fittings and flanges -- do not skip any. Read the actual symbol at each occurrence against the legend; do not assume shop vs field.',
        items: {
          type: "object",
          properties: {
            weld_tag: {
              type: "string",
              description:
                'This weld\'s own printed tag/number, exactly as shown next to the mark (e.g. "SW01", "FW02"). Shop welds (SW) and field welds (FW) are normally numbered in two SEPARATE sequences that each restart at 01 -- "SW01" and "FW01" both existing on the same drawing is correct, not a duplicate. Keep the SW/FW prefix attached so the two sequences are never confused with each other. Leave blank only if the drawing genuinely prints no number at this specific mark.',
            },
            spool_no: {
              type: "string",
              description:
                "Which spool this weld falls inside, in the SAME bare format as the spools array's own spool_no (see its description) -- must string-match it exactly. Use the spools array's own numeric-continuity shortcut as a hint (see its description), but verify against which physical line the weld is actually drawn on, especially near a branch, since a branch's own welds can interrupt an otherwise-consecutive number block. Do not just pick the nearest spool number on the page. A field weld itself sits AT a boundary -- record it under the spool it terminates (the one ending there, upstream side), not the one starting after it. NEVER let two FW/flange-bolt-up welds share the same spool_no -- see the spools array's HARD CONSTRAINT check. Leave blank if uncertain, but blank should be RARE -- reserved for a genuinely ambiguous individual weld, not a whole sheet's worth. If most or all welds on this sheet are ending up blank, that means the boundary walk was not done carefully enough here, not that this sheet is unusually hard -- see the spools array's own red-flag note.",
            },
            weld_type: {
              type: "string",
              description: 'The legend symbol at this mark, in the drawing\'s own words, e.g. "shop weld", "field weld", "socket weld", "screwed joint", "compression joint", "site connection". Must agree with the weld_tag prefix when one is present (an "SW" tag is a shop weld, an "FW" tag is a field weld).',
            },
            size: { type: "string", description: "The pipe size at this weld, as printed on the segment it sits on, if legible." },
            location_note: {
              type: "string",
              description:
                'Where this weld sits, specific enough for a reviewer to find it on the drawing, e.g. "between elbow item 4 and flange item 5" or "at the spec break joint near the check valves". ' +
                'QUALITY BAR: never write this as only "main run", "upper run", "lower run", or similar generic run-position text with nothing else -- that is not specific enough for a reviewer to find the weld, and is a sign the drawing was not actually examined at that mark. Always name what is physically nearest the mark: an item number, fitting type, flange/gasket/bolt group, branch tee, spec-break, or tie-in. A generic run-position phrase may be added alongside a specific reference (e.g. "main run, near item 6 elbow"), never used by itself.',
            },
          },
          required: ["weld_type"],
        },
      },
      dimensions: {
        type: "array",
        description:
          'EVERY printed linear dimension line on this sheet (a number with arrowed dimension lines, e.g. "457", "403", "3437") -- this is what actually determines a spool\'s real fabricated length, so completeness here matters more than for almost any other field. ' +
          "Read every one drawn on the route, regardless of what sits at its two ends -- a dimension commonly spans pipe-to-fitting, fitting-to-fitting, weld-to-flange, or any other pair of points, NOT only weld-to-weld. Do not skip a dimension just because neither end is a weld mark, and do not skip small/short dimensions (e.g. \"15\") -- several short segments in a row are exactly as real as one long one and must all be counted. " +
          "Dimensions are drawn to a fitting's CENTERLINE, not to its far weld -- an elbow or tee needs a weld at EACH of its ends (e.g. SW08 and SW09 both belong to the same one elbow), and a dimension line ending \"at\" that fitting lands at its centerline, which sits physically BETWEEN those two welds, roughly at the fitting's own midpoint -- not at the second weld itself. So a dimension reading \"1407\" from SW07 to an elbow formed by SW08+SW09 terminates part-way through that elbow, at half its own body, not all the way out to SW09. Record to_ref as the fitting itself (e.g. \"elbow at SW08/SW09\"), not as whichever of its two welds happens to be nearest. This does not change which spool the dimension belongs to -- a fitting whose two welds straddle a spool boundary is unusual and should be flagged via a blank spool_no like any other boundary-crossing case. " +
          "CRITICAL for spool_no: a dimension belongs to a spool only when BOTH of its ends sit inside that SAME spool by the connection-type boundary walk (see the spools array's own description). If a dimension spans across a spool boundary (e.g. from inside spool 1 to inside spool 2), leave its spool_no BLANK rather than assigning it to either side -- counting a cross-boundary dimension into one spool's total would overstate that spool's real size. " +
          "CRITICAL for axis: this is an ISOMETRIC drawing, so a straight run only ever points in one of THREE directions on the page -- vertical (rise/fall = elevation), or one of the two diagonal directions (the two horizontal plan axes). A run that turns through an elbow/tee changes direction, so the dimension BEFORE the turn and the dimension AFTER it are very likely on DIFFERENT axes -- do not assume consecutive dimensions are collinear just because they sit on the same pipe. " +
          "PREFERRED METHOD -- cross-reference against route_points, don't just eyeball the page angle: if this sheet prints E/N/EL coordinates at or near both ends of a dimension (see the route_points array), compare them -- whichever of E, N, or EL actually CHANGES between those two coordinates IS the dimension's axis, and the other two staying the same confirms it. This is a direct read, not a guess, and is far more reliable than judging which way a line slants on the page. Only fall back to reading the drawn angle visually when no coordinates bracket that particular dimension. " +
          "Record axis matching the SAME E/N/EL naming the route_points array uses: \"E\" and \"N\" for the two horizontal/diagonal directions, \"EL\" for vertical. Leave axis blank only if neither method (coordinates or visual angle) gives a confident answer.",
        items: {
          type: "object",
          properties: {
            value_mm: { type: "string", description: "The printed number exactly as shown, no unit (ISOs dimension in mm by default unless stated otherwise)." },
            axis: { type: "string", description: 'Which of the three isometric directions this dimension runs along: "E", "N", or "EL" -- see the array\'s own description for how to tell them apart. Leave blank if unclear.' },
            from_ref: { type: "string", description: 'What is at the start of this dimension line, e.g. "SW01", "item 4 elbow", "flange near item 7".' },
            to_ref: { type: "string", description: "What is at the end of this dimension line." },
            spool_no: { type: "string", description: "Which spool this dimension's span falls entirely inside, in the SAME bare format as the spools array's own spool_no (see its description) -- must string-match it exactly. Leave blank if it crosses a spool boundary -- see the array's own description." },
          },
          required: ["value_mm"],
        },
      },
    },
    // All required (key must be present -- an empty array still satisfies
    // this where a sheet genuinely has none) so a truncated response fails
    // validation and retries rather than silently persisting partial data.
    required: ["spools", "welds", "route_points", "dimensions"],
  },
};