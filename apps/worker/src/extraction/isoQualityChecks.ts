// Deterministic, zero-API-cost cross-checks on an ISO sheet's already-
// extracted spools/welds/dimensions -- no vision call, no LLM, just
// comparing the model's own already-extracted text/data against itself for
// internal contradictions. Shared between extractIsoDocument (checked fresh
// during a live extraction) and recheckIsoQualityFlags (re-run against
// data already sitting in the database, with no new extraction at all --
// see that function's own comment).
//
// Each check here targets a SPECIFIC, real failure mode confirmed on an
// actual extraction, not a hypothetical one -- see the comment on each
// function for the concrete case that motivated it.

export interface IsoQualitySpool {
  tagNumber: string;
  boundaryNote: string | null;
}
export interface IsoQualityWeld {
  tagNumber: string;
  spoolNo: string | null;
  weldType: string | null;
  weldListId: string | null;
  size: string | null;
  locationNote: string | null;
}
export interface IsoQualityDimension {
  tagNumber: string;
  spoolNo: string | null;
  fromRef: string | null;
  toRef: string | null;
}
export interface IsoQualityWeldListRow {
  id: string;
  nd: string | null;
  type: string | null;
}

export interface IsoQualityFlags {
  spoolFlags: Map<string, string>;
  dimensionFlags: Map<string, string>;
  weldListFlags: Map<string, string>;
  weldSizeFlags: Map<string, string>;
}

// A reducing weldolet/tee cited by 2+ welds' own location_note almost always
// has those welds split across its two different sizes (main run vs. the
// smaller branch) -- confirmed real case: two welds both described as
// sitting at the same "item 2 weldolet" (a printed 200x80NS reducing
// weldolet) came back with the SAME size (200 for both), when the second
// one is actually welded onto the weldolet's own branch outlet (80mm), not
// the main run -- see the size field's own prompt comment (packages/
// extraction-schemas/src/iso.ts) for the full case this rule was added for.
// All welds reporting the identical size at a shared reducing-item citation
// is itself the red flag; it does not require knowing which one is really
// which side, only that at least one of them almost certainly isn't what
// it says.
function reducingBranchItemIn(locationNote: string | null): string | null {
  if (!locationNote) return null;
  const m = /\bitem\s*0*(\d+)\s*\(?\s*(?:weldolet|tee)\b/i.exec(locationNote);
  return m ? m[1] : null;
}

// Requires BOTH a "branch leg(s)" mention AND boundary language ("bound"/
// "boundary"/"bounded") in the same note -- a spool correctly describing an
// internal branch it carries (e.g. "...also carries an 80mm drain branch
// off the 200mm main via the item 2 weldolet...") mentions "branch" without
// describing it as what BOUNDS the spool, and must not be flagged.
function boundaryNoteLooksBranchBased(note: string | null): boolean {
  if (!note) return false;
  const lower = note.toLowerCase();
  return /\bbranch\s+legs?\b/.test(lower) && /\bbound(ed|ary)?\b/.test(lower);
}

// A valve is ALWAYS a boundary (see the prompt's own rule -- never a
// mid-spool component), no exception. If a spool's own boundary_note says
// the main run continues "through" a valve to some LATER boundary, that's
// the model's own text admitting it walked past a real boundary instead of
// stopping there -- confirmed on a real extraction: spool 05's boundary_note
// read "...along the main run through the trunnion ball valve (item 10)
// cluster region up to the next bolted-flange boundary...", which folded
// what should have been two spools (split at the valve) into one, pulling
// in every weld between the valve and the next real boundary. Unlike the
// branch-leg check, this doesn't need a second qualifying condition -- there
// is no legitimate reading of "the run passes through a valve" that isn't
// this exact error, since the domain rule has no exception for it.
// Exported (not just used internally by computeIsoQualityFlags below) so
// extractIsoDocument (iso.ts) can run this SAME check immediately after
// record_iso_spool_welds returns, while the sheet's own context is still
// live, and trigger a targeted self-correction call rather than only
// surfacing this as a flag for a human to read after the fact -- see
// iso.ts's own comment on that loop for why.
export function boundaryNoteTreatsValveAsPassThrough(note: string | null): boolean {
  if (!note) return false;
  return /\bthrough\b[^.]{0,60}\bvalves?\b/i.test(note);
}

function weldTagsMentioned(ref: string | null): string[] {
  if (!ref) return [];
  return (ref.match(/\b[SF]W\s*0*\d+\b/gi) ?? []).map((t) => t.replace(/\s+/g, "").toUpperCase());
}

// The printed WELD LIST table's own Type column uses drafting vocabulary
// ("BUTTWELD", "FIELDWELD", ...) rather than the weld_type field's own
// ("shop weld", "field weld") -- only the field/shop distinction is checked
// here (a buttweld IS a shop weld, socket/screwed joints aren't printed in
// a table's Type column on any sheet seen so far), not an exact string match.
function weldListTypeImpliesField(type: string | null): boolean | null {
  if (!type) return null;
  return /field/i.test(type);
}

export function computeIsoQualityFlags(
  spools: IsoQualitySpool[],
  welds: IsoQualityWeld[],
  dimensions: IsoQualityDimension[],
  weldListRows: IsoQualityWeldListRow[] = []
): IsoQualityFlags {
  // HARD CONSTRAINT cross-check: a single spool_no should never terminate
  // at more than one field weld (each real spool has exactly one upstream
  // FW/flange boundary).
  const fwCountBySpool = new Map<string, number>();
  for (const w of welds) {
    if (!w.spoolNo || (w.weldType ?? "").toLowerCase() !== "field weld") continue;
    fwCountBySpool.set(w.spoolNo, (fwCountBySpool.get(w.spoolNo) ?? 0) + 1);
  }

  // Weld tag -> its own spool_no, for the dimensions cross-check.
  const weldSpoolByTag = new Map<string, string>();
  for (const w of welds) {
    if (w.tagNumber && w.spoolNo) weldSpoolByTag.set(w.tagNumber.replace(/\s+/g, "").toUpperCase(), w.spoolNo);
  }

  const spoolFlags = new Map<string, string>();
  for (const s of spools) {
    const flags: string[] = [];
    if (boundaryNoteLooksBranchBased(s.boundaryNote)) {
      flags.push(
        "boundary_note describes the bounding joints as sitting on a branch leg -- this spool may actually be a branch cluster that should be folded into its main-run spool rather than standing on its own."
      );
    }
    if (boundaryNoteTreatsValveAsPassThrough(s.boundaryNote)) {
      flags.push(
        "boundary_note describes the main run continuing THROUGH a valve to a later boundary -- a valve is always a boundary, never a mid-spool component, so this spool likely should have ended at the valve instead and is pulling in welds that belong to the next spool."
      );
    }
    const fwCount = fwCountBySpool.get(s.tagNumber) ?? 0;
    if (fwCount > 1) {
      flags.push(`${fwCount} field welds are recorded as terminating this spool -- a real spool has exactly one; a boundary was likely missed between them.`);
    }
    if (flags.length > 0) spoolFlags.set(s.tagNumber, flags.join(" "));
  }

  const dimensionFlags = new Map<string, string>();
  for (const d of dimensions) {
    if (!d.spoolNo) continue;
    const referencedTags = [...weldTagsMentioned(d.fromRef), ...weldTagsMentioned(d.toRef)];
    const conflicting = referencedTags.map((t) => ({ tag: t, weldSpool: weldSpoolByTag.get(t) })).find((r) => r.weldSpool && r.weldSpool !== d.spoolNo);
    if (conflicting) {
      dimensionFlags.set(
        d.tagNumber,
        `recorded under spool ${d.spoolNo}, but its own endpoint ${conflicting.tag} is recorded under spool ${conflicting.weldSpool} -- these disagree.`
      );
    }
  }

  // Weld-list cross-check: a weld's own weld_list_id is a citation to a row
  // this SAME extraction also read off the sheet's printed WELD LIST table
  // -- if the row's own ND/Type disagrees with what was recorded for the
  // weld itself, at least one of the two readings is wrong (see the
  // weld_list_id field's own prompt comment for the real case that
  // motivated this: a continuous table ID sequence spanning both shop and
  // field welds, while the drawing's own tags restart field-weld numbering
  // separately, silently offsets every row after the field weld's own slot).
  const weldListRowById = new Map(weldListRows.map((r) => [r.id.trim(), r]));
  const weldListFlags = new Map<string, string>();
  for (const w of welds) {
    if (!w.weldListId) continue;
    const row = weldListRowById.get(w.weldListId.trim());
    if (!row) continue;
    const mismatches: string[] = [];
    if (row.nd && w.size && row.nd.trim() !== w.size.trim()) {
      mismatches.push(`table row ${row.id} lists ND ${row.nd}, this weld is recorded as ${w.size}`);
    }
    const rowExpectsField = weldListTypeImpliesField(row.type);
    const weldIsField = w.weldType ? /field/i.test(w.weldType) : null;
    if (rowExpectsField !== null && weldIsField !== null && rowExpectsField !== weldIsField) {
      mismatches.push(`table row ${row.id} is typed "${row.type}", this weld is recorded as "${w.weldType}"`);
    }
    if (mismatches.length > 0) {
      weldListFlags.set(w.tagNumber, `Disagrees with its own matched WELD LIST row: ${mismatches.join("; ")} -- one of the two is wrong.`);
    }
  }

  // Reducing-branch size check -- see reducingBranchItemIn's own comment.
  const weldsByReducingItem = new Map<string, IsoQualityWeld[]>();
  for (const w of welds) {
    const item = reducingBranchItemIn(w.locationNote);
    if (!item) continue;
    const group = weldsByReducingItem.get(item) ?? [];
    group.push(w);
    weldsByReducingItem.set(item, group);
  }
  const weldSizeFlags = new Map<string, string>();
  for (const [item, group] of weldsByReducingItem) {
    if (group.length < 2) continue;
    const sizes = new Set(group.map((w) => w.size).filter((s): s is string => !!s));
    if (sizes.size !== 1) continue; // already split across sizes -- no red flag
    const [onlySize] = sizes;
    const tags = group.map((w) => w.tagNumber).join(", ");
    for (const w of group) {
      weldSizeFlags.set(
        w.tagNumber,
        `Same size (${onlySize}) as every other weld citing "item ${item}" (${tags}) -- a reducing weldolet/tee almost always splits its nearby welds across its two different sizes (main run vs. branch), so all of them matching is a sign one weld mark may actually be on the branch side, not the main run.`
      );
    }
  }

  return { spoolFlags, dimensionFlags, weldListFlags, weldSizeFlags };
}
