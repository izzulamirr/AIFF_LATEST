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
// Split from what was originally one combined "spool tracking" call
// (spools+welds+route_points+dimensions together) into two sequential
// calls -- ISO_SPOOL_WELDS_TOOL first, then ISO_ROUTE_DIMENSIONS_TOOL fed
// the first call's own results as reference text (see extractIsoDocument).
// The combined call's own schema had grown to ~9,000 tokens of rules after
// several rounds of hardening, and a real extraction was observed dropping
// ALL FOUR arrays on both the original attempt and its retry -- splitting
// the boundary-walk-heavy half (spools+welds) from the comparatively
// mechanical half (route_points+dimensions) reduces how much a single
// response has to hold in mind at once, and lets the second call reference
// ALREADY-SETTLED spool/weld data instead of re-deriving it from scratch
// in the same breath as reading dimension lines.
export const ISO_SPOOL_WELDS_TOOL: ClaudeTool = {
  name: "record_iso_spool_welds",
  description:
    "Records this isometric sheet's pipe spool boundaries, welds, and printed weld-list table (if any) -- the harder, boundary-walk half of the spool/weld-list tracking view (route coordinates and dimensions are a separate call, record_iso_route_dimensions, which uses THIS call's own results as reference). This is a separate call from the title-block/BOM extraction specifically so it gets its own full output budget; treat completeness here as being just as important as the BOM itself. Apply the SAME tracing effort to every sheet regardless of its length or weld count -- a sheet with many spools/welds is not licence for shorter, vaguer boundary_notes or location_notes than a simple one; if anything it needs MORE care, not less, since there is more to get wrong.",
  input_schema: {
    type: "object",
    properties: {
      spools: {
        type: "array",
        description:
          'Every pipe spool on this sheet -- cross-check against the sheet\'s own printed "PIPE SPOOLS" list under the BOM (e.g. "PIPE SPOOLS [1] [2]") for the spool NUMBERS, but also determine each one\'s real boundary by walking the route and classifying EVERY joint/weld mark you cross by its CONNECTION TYPE, not by hunting for the letters "FW":\n' +
          '- SHOP WELD -- never a boundary. Read its symbol against THIS sheet\'s own legend, whatever prefix it prints for a shop-fabricated joint ("SW", "BW"/buttweld, or another) -- it joins pieces together INSIDE one spool during fabrication, so a run of many shop-weld marks in a row all stay in the SAME spool.\n' +
          '- FIELD WELD (FW) -- always a boundary. A weld done on site means the two sides were fabricated and shipped as separate pieces.\n' +
          '- A BOLTED/FLANGED joint (two flanges mating face to face) -- ALSO always a boundary, even where the drawing gives it no "FW" tag at all. A bolt-up connection is inherently field-made -- that is what flanges are for. Do not confuse this with a flange that is shop-welded onto a pipe stub (SW mark) and stays inside the spool; the boundary is the BOLTED FACE where two separate flanges meet, not every flange symbol on the drawing. SPOTTING ONE WITH NO "FW" TEXT: an isometric commonly marks a bolted joint with a cluster of balloon callouts sitting together AT one point on the route -- a flange item number, a gasket item number, and a bolt item number, often printed as a compact group like "F5/G9/B11" (Flange-item5, Gasket-item9, Bolt-item11). A gasket only ever exists BETWEEN two mating flange faces, so wherever a flange+gasket+bolt group is clustered at one point along the run -- with no weld mark AT that same point -- that cluster IS the field-bolted joint, and therefore a spool boundary, whether or not it also carries an "FW" tag. Don\'t mistake a shop-welded stub flange (a flange item balloon sitting right next to an SW mark, no separate gasket+bolt group with it) for this -- that one stays inside the spool.\n' +
          '- A VALVE sitting in the run -- ALSO always a boundary, for the same reason as a flange bolt-up: a valve is essentially always installed flanged/bolted (see its own BOM description -- "FLANGED-RF TO ASME B16.5" etc.), so both faces where it bolts to the adjoining pipe are field joints. When walking the route and you cross a valve\'s own BOM item balloon, that spool ENDS at the last shop weld before the valve, and a NEW spool STARTS at the next shop weld after it -- the valve itself sits at the boundary, belonging to neither spool\'s own weld list (like any other boundary component). A line with several valve items (check valve counts/qty in the BOM -- one item row can mean several physical instances) creates one boundary PER physical valve encountered along the walk, not just once per item row. CONFIRMED EXAMPLE: a 200mm trunnion ball valve sitting in the main run right before a shop weld tagged SW07 is exactly this case -- the spool ending there stops at the last shop weld before the valve (e.g. SW06), and the NEXT spool starts at SW07, with the valve\'s own flange-gasket-bolt cluster (see the flange-bolt-up bullet above) as the physical marker of that boundary, not a separate, unrelated flange joint. Don\'t treat a valve\'s bolt-up cluster as "just a flange near a valve" and miss that it IS the boundary because a valve sits right there. ' +
          'A VALVE HAS TWO SEPARATE FLANGE FACES, NOT ONE -- DO NOT LET A SHARED NEARBY LABEL MERGE THEM: the shop weld just before a valve and the shop weld just after it both sit close to the SAME flange/gasket/bolt item-balloon group (the valve\'s own two mating flanges are commonly labelled with the same or overlapping nearby callouts), which makes it easy to misread them as both being on the SAME side of ONE joint. They are not -- they are on OPPOSITE sides of the valve. If two different shop welds both reference the same flange-cluster label, check whether a valve\'s own BOM item balloon sits physically between them: if it does, the valve is still the boundary exactly as above, and the two welds belong to two DIFFERENT spools (one ending just before the valve, the other starting just after it) even though their location text mentions the same nearby flange label.\n' +
          'NAMING A BOUNDARY IN location_note IS NOT THE SAME AS ACTING ON IT -- CONFIRMED REAL MISS: a weld can end up with a location_note that correctly names a flange/valve cluster sitting right next to it (e.g. "near the G9 / F12 G23 B11 flange") while STILL being left in whichever spool was already being built, because describing the surroundings was mistaken for having resolved the boundary. Writing down what is nearby is not the same step as deciding which side of it you are on. Every time a weld\'s own nearest neighbor is a valve\'s item balloon or one of its two flange/gasket clusters, stop and explicitly answer: is this weld\'s own weld mark BEFORE the valve (upstream, still fabricated as part of the run walked so far) or AFTER it (downstream, the first weld of a new run)? Place it according to that answer, not according to which spool_no you happened to be assigning to the previous few welds.\n' +
          '- A BOUNDARY ON A SHORT SIDE BRANCH DOES NOT SPLIT THE MAIN RUN: the FW/flange-bolt-up/valve-is-a-boundary rules above apply to a component sitting IN-LINE on the run you are walking -- the pipe axis actually passes THROUGH it. A branch (a tee or weldolet tapping OFF the main run at an angle, not continuing it) is a DIFFERENT physical line -- its own FW, bolted flange, or valve is a boundary for THAT BRANCH\'s own fabrication only, and never ends or splits the MAIN run\'s spool. Keep walking the main run straight through the branch point as if the branch were not there -- the main run\'s own spool_no only changes where the MAIN run itself (not the branch) next crosses an FW or bolted flange. This holds whether or not the branch is long enough to be a spool of its own: a short capped branch (drain/vent, ending in a valve and blind flange, with no number of its own in the drafter\'s PIPE SPOOLS list) attaches entirely to the main-run spool it tees off of, boundary components included -- do not let a valve or flange sitting on that short branch terminate the main spool. CONCRETE CASE: a shop weld on one end of an elbow that turns OFF the main run toward a short branch (the elbow\'s other end has its own shop weld too, same as any elbow), with a bolted flange group at the branch\'s far end -- that flange group is the BRANCH\'s own boundary, not the main line\'s; the main run\'s spool_no continues past the elbow unbroken, only ending when the MAIN run\'s own path later crosses its own FW or bolted flange.\n' +
          '- A SMALL CIRCLE/OVAL SITTING DIRECTLY ON THE PIPE ROUTE IS A WELDOLET/BRANCH SYMBOL, even with no size tag printed: distinct from the diamond weld mark and from the boxed item-number balloon, a plain small circle or oval sitting right on the drawn pipe line marks a branch connection welded onto the main run -- most often a small-bore branch feeding an instrument (via a small isolation valve item, typically near "INSTR."/"PIPING" labeling) but also a drain, vent, or other small branch. This symbol very often appears with NO "AxB NS" size-change text next to it -- do not treat the absence of a size tag as proof there is no branch here; the circle/oval on its own is sufficient evidence of one. Treat it exactly like any other branch point above: the branch\'s own downstream fitting/valve/instrument and welds belong to that branch, not the main run, and a boundary on that branch does not split the main run\'s own spool.\n' +
          '- A REDUCING TEE IS A BRANCH; A CONCENTRIC/ECCENTRIC REDUCER IS NOT -- DO NOT CONFUSE THE TWO ITEMS: both change pipe size and both commonly carry an "AxB NS"-style size callout, but they are physically different fittings with different consequences. A TEE (BOM description containing "REDUCING TEE" or similar) has THREE openings -- the main run continues through it AND a branch taps off at an angle -- so it IS a genuine branch point (see the branch rules above). A REDUCER (BOM description containing "REDU CONC", "CONCENTRIC REDUCER", "ECCENTRIC REDUCER", or similar) has only TWO openings -- it is an IN-LINE fitting where the SAME single line simply narrows and continues as ONE path, with NO branch to track at all. A shared size callout does not tell you which one you are looking at -- read the actual BOM description for the item balloon at that point before deciding: misreading a plain reducer as a tee invents a branch that does not exist, misreading a tee as a plain reducer misses a real one. When a tee and a reducer on the same sheet happen to share a size (e.g. both are 200x150), do not let that similarity merge them into one item in your own boundary_note or location_note text -- they are different BOM rows with different item numbers, and only one of them is actually a branch.\n' +
          '- ON A BUSY CLUSTER WHERE SEVERAL BRANCHES CONVERGE, ESTABLISH THE MAIN RUN BY SIZE BEFORE WALKING BY LINE: where multiple tees, weldolets, or valves sit close together (e.g. two reducing tees and two weldolets bunched in one area), tracing the drawn line alone becomes unreliable -- there is too much crossing/converging geometry to be confident which mark sits on which physical path. Use pipe SIZE as an independent, more robust signal instead: the main run holds ONE dominant nominal size (the sheet/line\'s own title-block size) continuously through the cluster, and every branch, by definition, steps DOWN to a smaller size at the exact point it taps off (see the reducer/weldolet rules above). So before assigning spool_no to any weld inside a busy cluster: first find where the dominant size enters the cluster and where it exits it -- that continuous same-size path IS the main run, no matter how many smaller-size branches tee off along the way, and no matter how visually tangled the cluster looks. Only a boundary crossing on THAT path, at the dominant size, can end or start a main-run spool_no. A cluster of branch components at a reduced size can never be mistaken for a main-run boundary once you have checked its size against the sheet\'s own dominant size -- however numerous those branch components are, or how complicated they are to describe, size tells you they are not the main run. Weld tag numbers carry no information about this (see the note below) -- size is the tool to reach for instead: on a branch-heavy cluster, the deciding question is "which size is this weld\'s own segment," never "which number comes next."\n' +
          'So a spool boundary is wherever the run crosses an FW, a flange bolt-up, OR a valve -- whichever comes first walking the route -- never a shop weld. Follow the bracketed spool-number marks drawn along the route (e.g. "[1]", "[2]") to confirm where one spool ends and the next begins, but the connection-type classification above is the authoritative boundary, not just where a bracket happens to be drawn. ' +
          'RECOMMENDED PROCEDURE -- TWO PASSES, NOT ONE: do not classify every weld in whatever order you happen to notice it on the page -- work the sheet in two clear passes instead. FIRST PASS, MAIN RUN ONLY: trace the sheet\'s own dominant size (see the busy-cluster rule above) from its entry tie-in to its exit tie-in/off-sheet continuation, ignoring every branch for now, and mark every FW/flange-bolt-up/valve boundary you cross ON that dominant-size path. This gives you the main run\'s own spool boundaries and lets you assign spool_no to every SW/FW sitting ON the main path cleanly, before any branch complexity is involved. SECOND PASS, BRANCHES: for every weld NOT on the main path, trace it back to whichever tap-off point (weldolet, tee, reducer) it belongs to, and assign it to that branch\'s own parent main-run spool (per the branch rule above) -- or to its own spool_no only if the drafter\'s own PIPE SPOOLS list actually gives that branch a number. Doing branches as a deliberate second pass, only after the main skeleton is already settled, is what prevents the exact mistake the SECOND HARD CONSTRAINT below exists to catch -- a branch cluster getting mistaken for a main-run spool because it was classified in the middle of an already-confusing single pass, rather than after the main run\'s own shape was already known. ' +
          'NUMBERING IS NOT A RELIABLE SIGNAL -- DO NOT USE IT TO DETERMINE spool_no: SW and FW tag numbers just reflect whatever order the drafter happened to walk the route in when labelling the sheet. That order is not a fixed, predictable convention -- it can vary sheet to sheet and even area to area on the same sheet, so do not assume any particular pattern (not "branches always continue the tally afterward," not "branches always interrupt mid-sequence," not any other rule of thumb). A clean run of consecutive numbers is NOT evidence those welds share one physical line, and a gap or a jump in the numbers is NOT evidence of a branch or a boundary either -- treat tag-number order, proximity, and how "sequential" a set of numbers looks as carrying NO information about spool membership, in either direction. The ONLY basis for deciding which spool a weld belongs to is the connection-type boundary walk above (SW/FW/flange/valve classification) and, in a busy cluster, pipe size (see the size rule above). Decide spool_no from those alone, then record whatever numbers land in each spool as simply whatever they are -- do not expect them to look orderly, and do not treat it as a problem if they do not. ' +
          "SANITY CHECK: a real spool is only ever a shippable size (see below) -- if the connection-type walk implies a spool's own run is approaching roughly 6000mm with no FW or flange bolt-up crossed yet, that is a strong signal a boundary was missed on the drawing (or misread), not that the run genuinely continues that far as one piece. Look again for a boundary mark near that point before concluding the spool keeps going. " +
          "HARD CONSTRAINT, CHECK BEFORE FINALIZING: a single spool_no must never end up attached to TWO different FW or flange-bolt-up welds in the welds array below. Each real spool has exactly ONE terminating boundary (its own upstream FW/flange, per the rule above) -- if your walk would attach a second FW or flange bolt-up to a spool_no that already has one, that is proof a boundary between them was missed, not that the spool legitimately spans both. When you find this, stop and split: everything from just after the FIRST FW/flange up to (and including) the SECOND becomes its own additional spool, with spool_no incremented for it and renumbered for everything downstream of it. Do this check across the whole sheet before finalizing the spools, welds, route_points, and dimensions arrays. " +
          "SECOND HARD CONSTRAINT, CHECK BEFORE FINALIZING: read back your own boundary_note for every spool. If a spool's own boundary_note describes its bounding joints as sitting on a BRANCH LEG rather than the main run (see the side-branch rule above), that spool should not exist as written -- you have just caught yourself violating that rule. Undo it: fold those welds back into whichever main-run spool that branch tees off of, delete the extra spool_no, and renumber everything downstream, the same corrective action as the first HARD CONSTRAINT. Do not let a cluster of branch/valve components (multiple tees, weldolets, or valves close together) become its own spool_no just because it is complex to describe -- complexity of the branch cluster is not evidence it is a separate shippable spool; only the drafter's own PIPE SPOOLS list and an actual MAIN-run boundary crossing justify a new spool_no. " +
          "WELD-NUMBER COMPLETENESS CHECK, CHECK BEFORE FINALIZING: list out the shop-weld numbers and the FW numbers you found, each as their own sequence, and look for gaps -- e.g. you have SW20 through SW43 and SW45 through SW50, but no SW44 (same idea for a BW-numbered sheet). On a busy sheet a missing number in the middle of an otherwise-continuous run is almost always a mark that got missed, not a genuine hole in the drafter's own numbering -- go back and look again specifically for it before finalizing, the same way the SANITY CHECK above asks you to look again for a missed boundary. This applies to the tail end of the sequence too: if the highest number you found is SW50 but a '51' or similar is visible anywhere else on the sheet (a balloon, a stray mark near the sheet edge), that is the same gap, just at the end instead of the middle. IF THIS SHEET ALSO PRINTS ITS OWN WELD LIST/SCHEDULE TABLE (a table of weld IDs with size/type/category, separate from the drawn marks): cross-check your traced count and sizes against that table's own row count before finalizing -- it's a direct, authoritative completeness signal, not just a visual re-scan. " +
          "GLOBAL SCATTER CHECK, CHECK BEFORE FINALIZING: numbering is not proof of spool membership (see below), but that does not mean any resulting pattern of spool assignments is equally plausible -- there is a real difference between ONE clean, localized branch detour (a short contiguous run of numbers carved out of the main block, e.g. SW03-SW05 sitting inside an otherwise SW01-SW09 main run) and the sheet's numbers bouncing repeatedly between many DIFFERENT, physically distant spools with no locality at all (e.g. spool 4 uses SW20-23, the very next numbers SW24-29 turn up in spools 10 and 11 -- described as a completely different area of the sheet -- and the walk then apparently returns to SW30 onward back in spool 5, physically next to spool 4). The first is a normal branch interruption. The second is not a plausible pattern for one continuous walk and is a strong sign the walk itself was not done coherently, even if each individual weld's own reasoning sounded fine in isolation. Before finalizing, look at the FULL sequence of spool assignments across the sheet, in weld-number order: if it reads as a scattered, back-and-forth mess rather than a walk that visits each region in a sensible order (with at most a few short, explainable branch detours), treat that the same as the SANITY CHECK above catching an oversized spool -- go back and re-trace the sheet as one continuous walk rather than having decided each weld's spool independently of the others. " +
          "A WELD SITTING RIGHT AT A BOLTED-FLANGE BOUNDARY CLUSTER NEEDS EXTRA CARE ABOUT WHICH SIDE IT IS ON: a shop weld drawn very close to a flange/gasket/bolt cluster is easy to attribute to the wrong side of that boundary by mistake, since it is easy to just keep it in whichever spool's list you happened to already be building. The deciding question must be answered from the drawing, not assumed: does the drawn pipe reach this weld BEFORE the flange cluster (upstream -- belongs to the spool ENDING there) or AFTER it (downstream -- belongs to the spool STARTING there)? Check which side of the actual flange FACE it is physically drawn on, every time a weld sits close enough to a boundary that this could go either way. " +
          "A SHORT SPOOL CAN LEGITIMATELY HAVE ZERO SHOP WELDS: a spool bounded by two closely-spaced boundaries (e.g. FW03 starting it, FW04 ending it, with nothing in between) is completely normal and must not be padded out with nearby SW tags just because they carry close numbers or sit near this spool's bracketed label on the page -- that is a real, separate error mode, distinct from the missed-boundary case above. Include a shop weld in a spool ONLY when you can trace the physical pipe line and confirm that weld sits ON the run strictly between this spool's own two boundary joints. If a block of SW tags (e.g. SW70-SW78) turns out to sit on a different physical line/branch than the one between your two FWs, they belong to whichever spool that other line is actually part of, not to this one -- proximity on the page or in the numbering is never sufficient on its own. " +
          "A ZERO-SW SPOOL DOES NOT CONSUME ANY SW NUMBERS: since the SW sequence numbers shop welds, not spools, a spool with none of its own leaves the SW count completely uninterrupted -- the next spool's own SW range picks up immediately where the last spool's left off, with NO gap. E.g. if one spool's shop welds end at SW55 and the next two spools (bounded by FW alone) have zero SW each, the following spool that DOES have shop welds starts at SW56, not some later number -- don't skip ahead assuming the zero-SW spools each used up a block of numbers themselves. " +
          'THIS BOUNDARY WALK IS THE SINGLE SOURCE OF TRUTH for the whole sheet -- route_points, welds, and dimensions below all assign spool_no by re-applying this exact same walk (branches and the 6000mm sanity check included), never independently. A point/weld/dimension must never be placed in a spool it would fall outside of by this logic, even if that leaves its own spool_no blank. ' +
          'boundary_note QUALITY BAR: a boundary_note that only restates the spool number or says something generic like "next spool along the main run" with no joint actually named at either end is NOT acceptable, even on a long or repetitive sheet -- it is a sign the boundary walk for that spool was not actually carried out. Every boundary_note must name the real joint/weld/tie-in at BOTH ends, the same way the examples above do ("from FW01 to FW02, spanning items 4-9, includes 2 elbows and the trunnion ball valve"). If you cannot name both ends, that means the walk still needs doing, not that a placeholder is good enough. ' +
          'NEVER HEDGE BY NAMING TWO DIFFERENT CANDIDATE ENDPOINTS FOR THE SAME BOUNDARY -- CONFIRMED REAL CASE: a boundary_note reading like "...ending at the flanged joint near the top / and continuing down to the FW01 field weld near the elbow" is not a valid boundary_note, even though each half reads fine on its own -- it is two different, non-matching endpoint descriptions stitched together with a separator, which happens when the boundary walk found more than one plausible-looking candidate and never actually resolved which one is real. This is a distinct failure from the generic-placeholder case above: the text looks specific, so it can pass a casual read, but it is still evidence the walk was not finished. If you notice yourself joining two different named joints with "/" or "and also" as if both describe where this SAME spool ends, stop -- go back to the drawing, confirm each candidate\'s own real position and its own printed weld mark, and keep only the one your walk actually reaches first coming from this spool\'s own start. A boundary_note names exactly ONE joint at each end, never two.\n' +
          'A CANDIDATE BOUNDARY MUST BE VERIFIED AT ITS OWN PRINTED POSITION, NOT ASSUMED FROM ITS TAG: before naming a specific FW/valve/flange as a spool\'s ending boundary, confirm you can actually see that exact mark near where you think the boundary is, and that no OTHER weld with a LOWER position along the route sits between the last weld you have already placed and that candidate -- a field weld\'s own tag number (e.g. "FW01") tells you nothing about where it sits physically (see the welds array\'s own NUMBERING IS NOT A RELIABLE SIGNAL note), so do not place it at the boundary that would be numerically convenient; place it only where its own mark is actually drawn, even if that turns out to be several welds further along the run than expected.\n' +
          'blank spool_no ACROSS A WHOLE SHEET IS A RED FLAG, NOT A DEFAULT: leaving an individual weld\'s spool_no blank because of genuine boundary ambiguity (see route_points/welds/dimensions below) is correct and should be rare. Ending up with MOST OR ALL of a sheet\'s welds unassigned -- e.g. every spool on the sheet showing zero welds -- means the boundary walk was not done carefully enough for that sheet, not that this sheet is unusually ambiguous. Before finalizing, if that pattern shows up, re-trace the sheet with the same weld-by-weld care used on a short sheet rather than accepting the blanks.',
        items: {
          type: "object",
          properties: {
            spool_no: {
              type: "string",
              description:
                'The BARE spool number only -- "1", "2", "12" -- never the full line-tagged name some "PIPE SPOOLS" lists print (e.g. print "8"-22-214-01-CRD-0002-AC03N-N-01", record just "01" or "1"). The welds array below, AND the separate record_iso_route_dimensions call that follows this one, both cross-reference a point/weld/dimension to its spool by exact string match against THIS value -- a spool numbered "1" here but referenced as the full line name somewhere else silently breaks that match, so pick one bare format and use it identically everywhere on this sheet.',
            },
            boundary_note: {
              type: "string",
              description:
                'Where this spool starts and ends on the drawn route, in terms of the FW/erection joint or tie-in at each end (e.g. "from the battery-limit tie-in flange to FW01" or "from FW01 to FW02, spanning items 4-9, includes 2 elbows and the trunnion ball valve") -- never describe a boundary as a shop weld. ' +
                'A spool that carries an internal branch/reducer (a weldolet, tee, or "AxB NS" size-change tag, e.g. "200x80NS") is not just its main-run size -- say so, naming the branch item and the two sizes involved (e.g. "...also carries an 80mm drain branch off the 200mm main via the item 2 weldolet, ending at the item 13 valve"). A short capped branch stub (drain/vent, ending in a valve and blind flange) commonly ships attached to the spool it branches off of when the drafter\'s own PIPE SPOOLS list gives it no number of its own -- describe it as part of that spool rather than inventing a spool number the drawing does not print.',
            },
          },
          required: ["spool_no"],
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
                'This weld\'s own printed tag/number, exactly as shown next to the mark (e.g. "SW01", "BW01", "FW02"). The prefix is whatever THIS sheet\'s own legend uses for that weld category -- "SW" and "BW" (buttweld) both mean shop-fabricated on different drawings, "FW" means field weld; do not assume only "SW"/"FW" can appear. Shop and field marks are normally numbered in two SEPARATE sequences that each restart at 01 -- "BW01" and "FW01" (or "SW01" and "FW01") both existing on the same drawing is correct, not a duplicate. Keep the printed prefix attached so the sequences are never confused with each other. Leave blank only if the drawing genuinely prints no number at this specific mark.',
            },
            spool_no: {
              type: "string",
              description:
                "Which spool this weld falls inside, in the SAME bare format as the spools array's own spool_no (see its description) -- must string-match it exactly. Do NOT use the weld's own tag number to decide this in any way -- not continuity, not proximity to another number, not how orderly the numbers look (see the spools array's own NUMBERING IS NOT A RELIABLE SIGNAL note for why). Determine this purely from which physical line the weld is actually drawn on (the connection-type walk) and, in a busy cluster, pipe size. Do not just pick the nearest spool number on the page. A field weld itself sits AT a boundary -- record it under the spool it terminates (the one ending there, upstream side), not the one starting after it. NEVER let two FW/flange-bolt-up welds share the same spool_no -- see the spools array's HARD CONSTRAINT check. Leave blank if uncertain, but blank should be RARE -- reserved for a genuinely ambiguous individual weld, not a whole sheet's worth. If most or all welds on this sheet are ending up blank, that means the boundary walk was not done carefully enough here, not that this sheet is unusually hard -- see the spools array's own red-flag note.",
            },
            weld_type: {
              type: "string",
              description:
                'The legend symbol at this mark, in the drawing\'s own words, e.g. "shop weld", "field weld", "socket weld", "screwed joint", "compression joint", "site connection". Must agree with the weld_tag prefix when one is present -- an "SW" or "BW" (buttweld) tag is a shop weld, an "FW" tag is a field weld, whichever prefix THIS sheet\'s own legend uses for each category. ' +
                'THIS WELD\'S OWN PRINTED PREFIX, READ DIRECTLY AT THE MARK, IS THE AUTHORITY -- A WELD LIST TABLE\'S TYPE/CATEGORY COLUMN NEVER OVERRIDES IT: if this sheet also prints its own WELD LIST table (see weld_list_id), that table\'s row is a completeness cross-check on count and size, not a replacement for what is actually drawn at this specific mark. CONFIRMED REAL CASE: a mark printed "BW12" (clearly legible, an ordinary buttweld) got relabeled a field weld because the matched table row happened to say "FIELDWELD" -- backwards; the table row\'s own ID did not actually correspond to that tag\'s embedded number at all (see weld_list_id\'s own note on this). Read the prefix at the mark first, decide weld_type from THAT, and only then check the table for size/completeness. If the two genuinely still disagree after you are confident about both, say so in location_note (e.g. "printed BW at the mark; the sheet\'s own WELD LIST table lists a FIELDWELD entry that doesn\'t match this tag\'s number") rather than silently picking one.',
            },
            weld_list_id: {
              type: "string",
              description:
                'If THIS sheet prints its own WELD LIST / weld schedule table (a table of rows like ID / N.D. / Type / Category, separate from the drawn marks) -- the specific row this weld corresponds to, as an explicit, checkable cross-reference (not just an internal size lookup). A schedule numbered 1..N in table order SOMETIMES lines up 1:1 with the drawn tags\' own numbering (table "ID 8" <-> drawn "BW08"), but not always. ' +
                'WATCH SPECIFICALLY FOR A CONTINUOUS TABLE ID COUNTING ACROSS BOTH SHOP AND FIELD WELDS, WHEN THE DRAWING\'S OWN TAGS DO NOT -- CONFIRMED REAL CASE, the exact mechanism, not just "sometimes wrong": the drawing\'s shop welds were tagged BW01..BW19 and its one field weld was tagged separately as FW01 (its own sequence, restarting at 01, per the weld_tag field\'s own note) -- but the table numbered straight through, ID 1..20, with the field weld occupying ONE row in the middle of that same count (table ID 12 = FIELDWELD = the drawing\'s FW01) rather than being pulled out to its own separate numbering the way the drawing\'s tags are. The effect: every table row AFTER that field-weld row is offset by however many field welds preceded it in the table -- here, table ID 13 was actually BW12, ID 14 was BW13, ... ID 20 was BW19, a consistent -1 shift, not row-by-row noise. This is EASY TO MISS: pattern-matching "row 16 -> tag ...16" looks right for the rows BEFORE the offset starts, so a mapping that is correct for the first several rows is not proof it stays correct after a field weld\'s own row. ' +
                'HOW TO GET THIS RIGHT: first find the table row(s) whose Type/Category says FIELDWELD, and match each one to its ACTUAL field-weld mark on the drawing by position (not by assuming its ID equals that mark\'s own embedded number -- see weld_tag\'s own note that FW numbering restarts separately). Once you know which row(s) are field welds, every BUTTWELD row AFTER them is shifted down by that count relative to its own tag\'s embedded number -- adjust your matching accordingly instead of a naive ID=N. ' +
                'Before trusting ANY mapping, spot-check it against the drawing, not just internal table consistency: does the table\'s OWN row count match how many weld marks you actually found on the sheet, and for a row you are UNSURE about, does its ND plausibly match what you can actually see at the physically corresponding mark (a main-run weld should read a larger ND than a branch weld right next to a reducing tee/weldolet -- if the table says otherwise for your assumed row, that is the offset catching you, not a real size). If the mapping does not hold up after checking for this specific field-weld-offset pattern, do not force it -- leave weld_list_id blank for welds you cannot confidently match by both position AND content, rather than assuming the Nth row is the Nth tag. Leave blank entirely if this sheet has no such table.',
            },
            size: {
              type: "string",
              description:
                "The pipe size at this weld, as printed on the segment it sits ON, if legible -- not the spool's or line's overall/dominant size. " +
                'A reducing weldolet/tee/branch connection (often tagged "AxB NS", e.g. "200x80NS") changes the pipe size from that point onward on the branch leg -- a weld on the main run just before it is the LARGER size, a weld on the branch leg just after it is the SMALLER size, even though both belong to the same nominal line. Do not carry the spool\'s dominant size onto a weld that actually sits on a reduced branch. ' +
                'WHEN THIS SHEET HAS ITS OWN WELD LIST TABLE (see weld_list_id): cross-check against that table\'s own N.D./size column for the matched row, and prefer it when it disagrees with what looks printed at the mark itself -- the table is typically the more legible, authoritative source, especially in a busy tile where the drawn callout is small. ' +
                "THIS FIELD IS THE DECIDING SIGNAL IN A BUSY CLUSTER, NOT JUST A DESCRIPTIVE ONE: per the spools array's own busy-cluster rule, where multiple pipe sizes converge (main run plus one or more reduced branches), a weld's own size is exactly what tells you WHICH physical run it actually sits on, and therefore which spool it belongs to -- use it that way when assigning spool_no below, don't just record it and move on. If two welds end up assigned to the same physical segment/spool despite printing DIFFERENT sizes, that is itself a red flag that one of them was placed on the wrong pipe -- go back and re-check which run each one is really drawn on before finalizing.",
            },
            location_note: {
              type: "string",
              description:
                'Where this weld sits, specific enough for a reviewer to find it on the drawing, e.g. "main run, near elbow item 4" or "80mm drain branch, at the spec break joint near the check valves". ' +
                'KEEP IT SHORT -- TWO THINGS ONLY: (1) which line it is on (the main run, or name the specific branch, e.g. "80mm drain branch"), and (2) what it is welded on/next to (an item number, fitting type, flange/gasket/bolt group, branch tee, spec-break, or tie-in). That is the whole note. ' +
                'DO NOT restate this spool\'s own pipe size, run length, or printed coordinates here (e.g. "on the 200mm vertical 2376mm run ... at E1725430/N1205642/EL+103262") -- size belongs in the size field, length is already in the dimensions array, and the coordinate is already in route_points; repeating them in prose here only makes the note longer without telling a reviewer anything the other fields do not already say. ' +
                'QUALITY BAR: never write this as only "main run", "upper run", "lower run", or similar generic run-position text with nothing else -- that is not specific enough for a reviewer to find the weld, and is a sign the drawing was not actually examined at that mark. Always name what is physically nearest the mark: an item number, fitting type, flange/gasket/bolt group, branch tee, spec-break, or tie-in. A generic run-position phrase may be added alongside a specific reference (e.g. "main run, near item 6 elbow"), never used by itself. ' +
                'ITEM BALLOONS ARE GROUND TRUTH, NOT A SOFT HINT: every fitting/branch/reducer on the drawing carries its own small boxed BOM item number (e.g. "2", "13") -- when one sits directly beside or touching a weld mark, that IS the weld\'s nearest labeled thing, cite that exact item number, not an approximate "near item X" guess pulled from general page proximity. Do not attach a balloon to whichever nearby weld happens to be easiest to read (e.g. one in a clearer tile) instead of the one it is actually drawn next to -- if a "2"/weldolet balloon and an "AxB NS" branch tag sit right after the tie-in, at the TOP of the spool, they belong on the weld(s) there, not on a weld further down the run just because that weld\'s tag was more legible. When cross-referencing the tile images, keep the item balloon\'s position anchored to its actual neighboring weld mark(s), not to whichever weld you are more confident about elsewhere on the sheet.',
            },
          },
          required: ["weld_type"],
        },
      },
      weld_list: {
        type: "array",
        description:
          'This sheet\'s own printed WELD LIST / weld schedule table, if it has one (a fabrication/cut sheet commonly does; a pure routing sheet commonly does not -- leave this array empty rather than inventing one). Read every row, in the table\'s own printed order -- this is what welds\' own weld_list_id fields cross-reference, and what the sheet\'s printed count should match against your own traced weld count (see the WELD-NUMBER COMPLETENESS CHECK above).',
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "This row's own printed ID/sequence number, exactly as printed, e.g. \"1\", \"12\"." },
            nd: { type: "string", description: "This row's own ND/size column value, exactly as printed, e.g. \"200\", \"25\"." },
            type: { type: "string", description: "This row's own Type column, exactly as printed, e.g. \"BUTTWELD\", \"FIELDWELD\"." },
            category: { type: "string", description: "This row's own Category column, exactly as printed, e.g. \"FABRICATION-ITEM\"." },
          },
          required: ["id"],
        },
      },
    },
    // All three required (key must be present -- an empty array still
    // satisfies this where a sheet genuinely has none) so a truncated
    // response fails validation and retries rather than silently
    // persisting partial data.
    required: ["spools", "welds", "weld_list"],
  },
};

// Second call for the same sheet, run AFTER ISO_SPOOL_WELDS_TOOL -- see
// extractIsoDocument's own comment for how that call's spools/welds results
// get fed into this one's prompt as reference text ("SPOOLS:"/"WELDS:"
// listings). Everything here assumes that reference text is present in the
// prompt; it deliberately does NOT re-explain the connection-type boundary
// walk (SW/FW/flange/valve classification) the way the combined tool used
// to, since this call is not the one deciding spool boundaries -- it is
// only placing coordinates/dimensions against boundaries already decided.
export const ISO_ROUTE_DIMENSIONS_TOOL: ClaudeTool = {
  name: "record_iso_route_dimensions",
  description:
    "Records this isometric sheet's route coordinates, dimensions, and cut-piece list -- the comparatively mechanical half of the spool/weld-list tracking view, run as a separate call from record_iso_spool_welds so this one can focus purely on coordinates/dimensions/cut-pieces using that call's own spool and weld results (given to you as reference text in the prompt) rather than re-deriving spool boundaries from scratch. Completeness here matters as much as the BOM does -- this is what actually determines a spool's real fabricated length.",
  input_schema: {
    type: "object",
    properties: {
      route_points: {
        type: "array",
        description:
          'Every 3D coordinate callout printed along the drawn route on this sheet -- isometrics routinely label vertices/bends/tie-ins with "E <easting> N <northing> EL <elevation>" (or similar). These exist so a spool\'s real fabricated size can be checked (for shipping-container fit) from its own coordinate spread, rather than guessed from the 2D drawing. Record every occurrence on this sheet -- these ALSO drive the dimensions array\'s own axis field below (whichever of E/N/EL changes between two coordinate points tells you the axis of the dimension line between them), so capturing every callout here directly improves how confidently that field can be filled in. ' +
          "CRITICAL: assign spool_no using the SPOOLS/WELDS reference text given to you in the prompt, not by re-walking the boundary logic yourself -- if this point is at or near a weld tag, use that weld's own spool_no directly; otherwise place it using the spool boundary_notes in the reference text (they name the joints/items at each spool's ends). Do not just attach a point to whichever spool number is nearest on the page. If a point sits exactly at a boundary, or you are not confident which side it is really on, leave spool_no blank rather than guessing -- an unassigned point is safer than a wrongly-assigned one, since a wrong assignment silently inflates that spool's measured size. " +
          "Leave the whole array empty if this sheet prints no coordinate callouts.",
        items: {
          type: "object",
          properties: {
            spool_no: { type: "string", description: "Which spool this point falls inside, in the SAME bare format as the reference SPOOLS/WELDS text uses -- must string-match it exactly. Leave blank if uncertain -- see the array's own description for why." },
            easting_mm: { type: "string", description: 'The E value exactly as printed, e.g. "1725430".' },
            northing_mm: { type: "string", description: 'The N value exactly as printed, e.g. "1208328".' },
            elevation_mm: { type: "string", description: 'The EL value exactly as printed, sign included, e.g. "+103262" or "-450".' },
            location_note: { type: "string", description: 'What this point is at, e.g. "tee elbow near item 4" or "tie-in at battery limit".' },
          },
          required: ["easting_mm", "northing_mm", "elevation_mm"],
        },
      },
      dimensions: {
        type: "array",
        description:
          'EVERY printed linear dimension line on this sheet (a number with arrowed dimension lines, e.g. "457", "403", "3437") -- this is what actually determines a spool\'s real fabricated length, so completeness here matters more than for almost any other field. ' +
          "Read every one drawn on the route, regardless of what sits at its two ends -- a dimension commonly spans pipe-to-fitting, fitting-to-fitting, weld-to-flange, or any other pair of points, NOT only weld-to-weld. Do not skip a dimension just because neither end is a weld mark, and do not skip small/short dimensions (e.g. \"15\") -- several short segments in a row are exactly as real as one long one and must all be counted. " +
          "Dimensions are drawn to a fitting's CENTERLINE, not to its far weld -- an elbow or tee needs a weld at EACH of its ends (e.g. SW08 and SW09 both belong to the same one elbow), and a dimension line ending \"at\" that fitting lands at its centerline, which sits physically BETWEEN those two welds, roughly at the fitting's own midpoint -- not at the second weld itself. So a dimension reading \"1407\" from SW07 to an elbow formed by SW08+SW09 terminates part-way through that elbow, at half its own body, not all the way out to SW09. Record to_ref as the fitting itself (e.g. \"elbow at SW08/SW09\"), not as whichever of its two welds happens to be nearest. This does not change which spool the dimension belongs to -- a fitting whose two welds straddle a spool boundary is unusual and should be flagged via a blank spool_no like any other boundary-crossing case. " +
          "THE CENTERLINE RULE ABOVE DOES NOT APPLY TO A VALVE -- A VALVE IS NEVER PART OF EITHER SPOOL'S OWN LENGTH: an elbow/tee is shop-welded INSIDE a spool, which is why its own dimension lands at its centerline as part of that spool's real size. A valve is different -- it is always a boundary, field-bolted rather than shop-fabricated, so NONE of its own physical body belongs to either adjacent spool (the reference SPOOLS/WELDS text will show a boundary at a valve as a gap between two different spool_no values with no weld between them, or an explicit mention in a boundary_note). A dimension line ending \"at\" a valve terminates at the valve's own FLANGE FACE -- where the spool's actual fabricated pipe/flange stops -- not part-way into the valve's body the way it would for an elbow. Do not count any part of a valve's own length into a spool's dimension total; shop drawings size the pipe the shop fabricates, and a valve is a separately procured, field-installed item, not something the shop builds into either spool.\n" +
          "CRITICAL for spool_no: a dimension belongs to a spool only when BOTH of its ends sit inside that SAME spool. If a dimension spans across a spool boundary (e.g. from inside spool 1 to inside spool 2), leave its spool_no BLANK rather than assigning it to either side -- counting a cross-boundary dimension into one spool's total would overstate that spool's real size. " +
          "USE THE REFERENCE SPOOLS/WELDS TEXT, DO NOT RE-DERIVE: this sheet's spools and welds were already determined by a separate call and are given to you as reference text in the prompt -- when from_ref and/or to_ref is a weld tag (e.g. \"SW48\"), that weld's own spool_no is already listed there; use it directly rather than working out the boundary yourself. If from_ref and to_ref are welds with the SAME spool_no, this dimension gets that spool_no too. If they have DIFFERENT spool_no values (they sit on opposite sides of a boundary), leave this dimension's spool_no BLANK, per the rule above -- do not assign it to whichever of the two seems closer. For an end that is not a weld (a fitting, tie-in, or other point), place it using the spool boundary_notes in the reference text instead. Staying consistent with the reference data this way, rather than guessing independently, is what makes a spool's own reported size trustworthy. " +
          "CRITICAL for axis: this is an ISOMETRIC drawing, so a straight run only ever points in one of THREE directions on the page -- vertical (rise/fall = elevation), or one of the two diagonal directions (the two horizontal plan axes). A run that turns through an elbow/tee changes direction, so the dimension BEFORE the turn and the dimension AFTER it are very likely on DIFFERENT axes -- do not assume consecutive dimensions are collinear just because they sit on the same pipe. " +
          "PREFERRED METHOD -- cross-reference against route_points, don't just eyeball the page angle: if this sheet prints E/N/EL coordinates at or near both ends of a dimension (see the route_points array), compare them -- whichever of E, N, or EL actually CHANGES between those two coordinates IS the dimension's axis, and the other two staying the same confirms it. This is a direct read, not a guess, and is far more reliable than judging which way a line slants on the page. " +
          "SECOND METHOD -- READ THE SHEET'S OWN NORTH/ORIENTATION ARROW, DON'T JUST EYEBALL AN ANGLE UNAIDED: almost every isometric sheet prints a small orientation symbol once, typically near the title block or a corner of the drawing -- an arrow (sometimes a small triad of three arrows) labeled N, often also showing which page-direction is E and which is vertical/EL. This symbol IS the sheet's own key to its axes: a run drawn PARALLEL to the printed N arrow is an N-axis run, one drawn parallel to the OTHER diagonal (the E direction) is an E-axis run, and any vertical run is EL, regardless of which way either happens to slant on THIS particular page layout -- do not assume a fixed page-direction (e.g. \"upper-left diagonal = N\") carries over between sheets; always re-check against this sheet's own printed symbol. Find that symbol first and match the dimension's drawn direction against it -- this, not an unaided guess at slope, is what \"reading the drawn angle\" is supposed to mean. " +
          "Only fall back to a bare visual judgment call when NEITHER the route_point coordinates NOR the sheet's own orientation symbol resolve it (e.g. the symbol is missing or illegible on this particular sheet) -- and even then, treat it as the least reliable of the three methods, not an equal alternative. " +
          "CONFIRMED REAL MISLABEL -- A LOOSE LOCATION-NOTE WORD IS NOT A COORDINATE CHECK: a dimension labeled by an informal description like \"sloped run\" was recorded as axis \"N\" purely from that wording, when the actual bracketing route_point coordinates showed its own value matched the E-delta exactly (955mm, with N constant at both ends) -- the word \"sloped\" describes the drawn LINE's angle on the page, not which named axis the printed number measures along; only the coordinate comparison (or, absent that, careful comparison against a dimension already confirmed on a real axis nearby) settles it. " +
          "Record axis matching the SAME E/N/EL naming the route_points array uses: \"E\" and \"N\" for the two horizontal/diagonal directions, \"EL\" for vertical. Leave axis blank only if neither method (coordinates or visual angle) gives a confident answer. " +
          "DO NOT LET A NEARBY BRANCH DETAIL STEAL A DIMENSION'S TRUE ENDPOINT -- CONFIRMED REAL CASE: a dimension's own extension/witness lines can run past a branch weldolet and its first branch weld without terminating there, continuing on to the real far end further down the main run -- e.g. a \"403\" dimension whose witness lines actually reach from one main-run weld all the way to another main-run weld several welds later was misread as running only from the branch weldolet to the branch's own first weld, because that branch detail happened to sit visually close to the dimension's near end. Trace each witness/extension line all the way to where it actually terminates (the same arrowhead-to-arrowhead span used for value_mm) rather than assigning from_ref/to_ref to whatever labeled feature happens to sit nearest the dimension text -- a branch attachment point sitting near a dimension's path is not automatically that dimension's own endpoint, exactly as it is not automatically a cut piece's own boundary (see cut_pieces' own rule on this).",
        items: {
          type: "object",
          properties: {
            value_mm: { type: "string", description: "The printed number exactly as shown, no unit (ISOs dimension in mm by default unless stated otherwise)." },
            axis: { type: "string", description: 'Which of the three isometric directions this dimension runs along: "E", "N", or "EL" -- see the array\'s own description for how to tell them apart. Leave blank if unclear.' },
            from_ref: { type: "string", description: 'What is at the start of this dimension line, e.g. "SW01", "item 4 elbow", "flange near item 7".' },
            to_ref: { type: "string", description: "What is at the end of this dimension line." },
            spool_no: { type: "string", description: "Which spool this dimension's span falls entirely inside, in the SAME bare format as the reference SPOOLS/WELDS text uses -- must string-match it exactly. Leave blank if it crosses a spool boundary -- see the array's own description." },
          },
          required: ["value_mm"],
        },
      },
      cut_pieces: {
        type: "array",
        description:
          'Every row of this sheet\'s own printed CUT PIPE LENGTH / cut list table, if it has one (a fabrication/cut sheet commonly does; a pure routing sheet commonly does not -- leave this array empty rather than inventing one). This table records how raw pipe stock was cut into pieces BEFORE welding into a spool -- piece number, cut length, size, and each end\'s prep (bevel for welding, square cut, screwed, etc.), NOT the same thing as a printed route dimension (which measures the ASSEMBLED spool, not the raw cut stock). Read every row, in table order. ' +
          'EACH PIECE IS ALSO MARKED DIRECTLY ON THE DRAWN ROUTE -- LOOK FOR IT, DO NOT ASSUME IT IS UNTRACEABLE: many fabrication sheets print a small marker AT the exact physical segment each cut piece occupies -- a single digit bracketed by two short angled strokes (like "<7>"), positioned right on the pipe centerline, ROTATED to align with whichever direction that segment is drawn (inline/diagonal on a diagonal run, stacked vertically -- the two bracket strokes above and below the digit -- on a vertical run). This is the direct link between a table row and its physical segment; do not assume this table is unlinked to the drawing just because spool_no/from_ref/to_ref look hard to fill in otherwise -- find each piece\'s own marker first. ' +
          'READ THE BRACKET STROKES AS STROKES, NEVER AS DIGITS -- CONFIRMED REAL MISREAD: the closing stroke of this marker is very easy to mistake for the digit "7" (both are a short diagonal line), which turns a real single-digit marker like "<4>" into a phantom two-digit misread like "47" -- and by the same error, "<7>" can misread as "17" if the opening stroke is mistaken for a "1". There is only ONE digit inside the two bracket strokes; if you find yourself reading two digits, re-examine which of them is actually a bracket stroke, not a second numeral. Cross-check your reading against the table itself -- the digit must be some piece_no that is actually a row in this array (1 through however many rows there are), never a number outside that range. ' +
          'ONCE YOU HAVE FOUND A PIECE\'S OWN MARKER: trace outward from it in both directions along the drawn pipe to the nearest REAL CUT BOUNDARY on each side, and record the WELD tag sitting at that boundary (e.g. "BW11", "FW01") in from_ref/to_ref -- never a fitting\'s description (not "elbow item 4", not "tee near item 2"): name the weld AT the boundary, not the fitting it happens to sit next to. ' +
          'A CUT PIECE IS NOT BOUNDED BY EVERY WELD IT PASSES -- CONFIRMED REAL CASE, DO NOT STOP AT THE FIRST WELD: shop welds are also used to attach a branch fitting (a weldolet) onto the SIDE of an otherwise continuous run -- that does NOT cut the main pipe into separate stock, since a weldolet is welded onto an intact pipe, not spliced into a break. A real cut-piece boundary is only a FIELD WELD, a VALVE, or an ELBOW (a bend needs a distinct fitting, which does end the straight stock) -- OR, independent of those, wherever a continuous straight run would otherwise exceed standard stock length (commonly ~6000mm/20ft) a field weld is required there regardless, which is the real reason a field weld exists at all mid-run. CONFIRMED REAL CASE: one piece\'s own marker sat right after an elbow, with FOUR more ordinary shop welds further along the same straight run (each one attaching a separate small-bore instrument branch via its own weldolet) before the pipe finally reached the next elbow/flange -- the piece\'s real to_ref was the LAST of those welds, at the true far boundary, not the first weld encountered right after the marker. When tracing outward from a piece\'s own marker, keep going PAST any weld that is merely a branch/weldolet attachment (check: does the weld\'s own location_note or the drawing show it feeding a small-bore branch line rather than continuing the main run\'s own size?) until you reach a weld that actually sits at a field weld, a valve, or an elbow. Set spool_no from whichever spool those two true bounding welds fall inside (same rule as the dimensions array: blank if the two ends genuinely sit in different spools). If no such boundary weld can be confidently identified on one side, leave that ref blank rather than guessing. ' +
          'CRITICAL for spool_no when a marker cannot be found: this table is usually printed once for the whole sheet, not broken out per spool, so a piece with no locatable marker often cannot be traced. In that case only, fall back to the weaker signal (matching cut length against a specific dimensioned segment already placed in one spool) -- and leave spool_no BLANK rather than guessing when even that does not make it traceable. A blank spool_no here is a sign the marker genuinely was not found or was ambiguous, not a default to reach for first.',
        items: {
          type: "object",
          properties: {
            piece_no: { type: "string", description: 'This row\'s own printed piece/item number, e.g. "1", "2".' },
            cut_length_mm: { type: "string", description: "The printed cut length, no unit (assume mm unless the table states otherwise)." },
            size: { type: "string", description: 'Nominal size for this piece, as printed on its own row, e.g. "80", "200".' },
            remarks: { type: "string", description: 'The table\'s own remarks/category column for this row, e.g. "SHOP", exactly as printed.' },
            end1: { type: "string", description: 'End-1 preparation exactly as printed, e.g. "BEVEL", "SQUARE CUT", "SCREWED".' },
            end2: { type: "string", description: "End-2 preparation exactly as printed, same vocabulary as end1." },
            from_ref: {
              type: "string",
              description:
                'The WELD that bounds this piece on one end, found by locating its own <N> marker on the drawn route (see the array\'s own description) and tracing to the nearest weld -- always a weld tag (e.g. "BW03", "FW01"), never a fitting\'s description, even when the piece runs right up to an elbow/tee/weldolet (see the array\'s own description for why). Leave blank if no weld can be confidently identified on this side.',
            },
            to_ref: { type: "string", description: "What bounds this piece on the other end, same method as from_ref." },
            spool_no: { type: "string", description: "Which spool this piece belongs to, in the SAME bare format as the reference SPOOLS/WELDS text uses. Leave blank when not confidently traceable to one spool -- see the array's own description." },
          },
          required: ["cut_length_mm"],
        },
      },
    },
    // All three required (key must be present -- an empty array still
    // satisfies this where a sheet genuinely has none) so a truncated
    // response fails validation and retries rather than silently persisting
    // partial data.
    required: ["route_points", "dimensions", "cut_pieces"],
  },
};