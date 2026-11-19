# Roadmap

> From a daily-driver grid to a credible local-first spreadsheet with reviewed AI.
>
> **Status:** Phase 1 shipped. Phase 2 is the next development block.  
> **Companion document:** [Feature research and benchmark](FEATURE-RESEARCH.md)  
> **Last updated:** 19 November 2026

---

## How this roadmap is organised

The benchmark products are broad. This roadmap is deliberately ordered by **user
frequency and data-model dependency**, not by feature count. Each phase must leave the
app usable, testable, and shippable on its own.

| Phase | Theme | Outcome | Status |
| --- | --- | --- | --- |
| **1** | Daily-driver grid | Ranges, undo/redo, clipboard, formatting, find/replace, sort, fill, sheet management, print, 116 functions | **Shipped** |
| **2** | Structure and clarity | Row/column operations, borders/fonts/merge, freeze panes, filters, multi-key sort, conditional formatting, validation, comments | Next |
| **3** | Charts and analysis | Charts, pivot tables, named ranges, array formulas, deeper formula coverage | Planned |
| **4** | Scale and interoperability | Virtualized large grids, XLSX fidelity, local version history, print layout | Planned |
| **5** | Collaboration and automation | Optional backend collaboration, sandboxed macros, expanded reviewed AI | Conditional |

### Guiding principles

1. **Local-first.** The grid must work with no account, no key, and no network.
2. **AI safety is an invariant.** AI never writes without an explicit user command, a
   permission slip, and a Save/Discard review. New AI features inherit the same gate.
3. **Structure before visuals.** Do not build charts or pivots on a range model that
   breaks when a row is inserted.
4. **Formatting is data.** Styles, borders, merges, validation, and conditional rules
   must persist in IndexedDB and survive reload and export.
5. **Every mutation is undoable.** New editing operations join the snapshot history.
6. **No regressions in the core.** A phase is not done until the previous phase's
   flows still pass.
7. **Keep the code inspectable.** No build step is required to run the app. Add
   dependencies only when the offline and auditability costs are justified.

### Effort scale

Estimates are **ideal engineer-weeks** for one developer who knows the codebase. They
include implementation, tests, documentation, and accessibility checks. They exclude
long review cycles and unexpected browser bugs. Calendar time is typically longer.

| Size | Ideal effort | Meaning |
| --- | --- | --- |
| S | 0.5–1 week | Localised change, one or two files, low data-model risk |
| M | 1–3 weeks | New UI plus model changes, several test paths |
| L | 3–6 weeks | Cross-cutting model change, migration, or performance work |
| XL | 6+ weeks | New subsystem, backend, or security boundary |

---

## Phase 1 — Daily-driver grid (shipped)

### Delivered

- Multi-cell selection with drag, `Shift+Click`, `Shift+Arrow`, row/column headers, and
  status-bar sum/average/count.
- Undo/redo with full-workbook snapshots, labelled actions, a 60-entry cap, and
  keyboard/button access.
- TSV clipboard copy, cut, and paste with multi-cell blocks and relative formula
  translation.
- Fill down (`Ctrl+D`) and fill right (`Ctrl+R`).
- Formatting: bold, italic, underline, strike, alignment, text colour, fill colour, and
  seven number formats.
- Find and replace on the active sheet, with previous/next, replace one, replace all,
  and a case-sensitive toggle.
- Single-key sort over a detected region, with header detection, blanks last, and
  stable ties.
- Sheet create, rename, duplicate, delete, and a tab context menu.
- Print window with the used range, formatting, and row/column headers.
- 116 callable functions (114 core plus lazy `IF` and `IFERROR`), cross-sheet
  references, absolute references, and formula translation.
- IndexedDB persistence with style metadata and stale-record reconciliation.

### Phase 1 acceptance criteria (met)

- [x] A range selection reports the correct address and aggregate statistics.
- [x] `Shift+Arrow` extends a selection; row and column headers select whole rows and
      columns.
- [x] Typing on a selected cell starts an edit; `Enter` commits and moves down.
- [x] Copy/paste translates relative references; fill down/right translates them too.
- [x] Formatting applies to a range, persists across reload, and undoes as one action.
- [x] Sort keeps the header row, sends blanks last, and is stable.
- [x] Find/replace operates on the active sheet and reports the match count.
- [x] A sheet can be created, renamed, duplicated, switched, and deleted.
- [x] A cross-sheet formula evaluates correctly.
- [x] Print opens a formatted window with the used range.
- [x] All Phase 1 Playwright flows and the existing AI/offline suites pass.

### Known limits carried into Phase 2

- No row/column insertion, deletion, resizing, or hiding.
- No borders, font family/size, wrap text, or merged cells.
- No freeze panes, filters, or conditional formatting.
- Sort is single-key and only over a contiguous region.
- Find/replace is limited to the active sheet and literal text.
- No data validation, comments, charts, pivots, or collaboration.
- Undo history is in memory only; reloading clears it.
- The grid is 26 columns × 100 rows.

---

## Phase 2 — Structure and clarity (next)

**Goal:** make ordinary table work safe and readable. A user should be able to insert
a row without breaking formulas, freeze a header, filter a table, add borders, and
validate input.

**Exit criteria for the phase:**

- Every structural edit preserves or correctly invalidates references.
- A long table can be frozen, filtered, sorted by multiple keys, and printed.
- Formatting and validation survive reload and round-trip through print.
- No existing Phase 1 flow regresses.
- All new operations are undoable.

### 2.1 Row and column operations

**Why:** structural edits are the most common missing spreadsheet action. They are
also the highest-risk change because formulas, merges, validation ranges, and
conditional-format ranges all depend on coordinates.

**Scope**

- Insert row above / below; insert column left / right.
- Delete selected rows/columns.
- Resize row height and column width by drag and by dialog.
- Hide/unhide rows and columns.
- Update formula references across all sheets, including quoted sheet names and
  absolute references.
- Emit `#REF!` when a referenced cell is deleted, matching spreadsheet convention.
- Keep merged ranges, validation ranges, and conditional-format ranges coherent, or
  reject the operation with a clear message if the range cannot be transformed.

**Acceptance criteria**

- Inserting a row above `SUM(B2:B4)` expands the range to include the new row.
- Deleting a row inside the range shrinks it.
- A cross-sheet reference to the moved row updates in every sheet.
- Deleting a referenced cell produces `#REF!`, not a silent wrong value.
- Undo restores the exact prior workbook, including styles and metadata.
- Hidden rows/columns do not appear in print.
- Widths and heights persist across reload.

**Dependencies:** reference-rewriting utility, sheet metadata for dimensions.
**Effort:** L (3–5 weeks). **Risk:** high; build a reference-rewrite test matrix first.

### 2.2 Borders, fonts, merge, and wrap

**Why:** users judge a spreadsheet by how it prints. The current formatting subset is
useful but cannot produce a readable report.

**Scope**

- Border presets (all, outside, top, bottom, left, right, none) with line style and
  colour.
- Font family and size, restricted to self-hosted fonts plus a safe fallback stack.
- Wrap text and vertical alignment.
- Merge and unmerge cells, with a confirmation when merging would discard data.
- A compact style record shared by cells and ranges.
- Print and PDF output that respects borders, fonts, wrap, and merges.

**Acceptance criteria**

- A border applied to a range renders identically in the grid and print preview.
- Wrapped text increases row height or clips predictably without overlapping.
- Merged cells keep the top-left value and clear the rest after confirmation.
- Styles persist across reload and copy/paste.
- Clear formatting removes borders, fonts, colours, alignment, and wrap in one undoable
  action.
- The style payload for a 10,000-cell sheet remains under a documented budget.

**Dependencies:** style model extension, print layout work.
**Effort:** M–L (2–4 weeks).

### 2.3 Freeze panes

**Why:** a 100-row sheet is already hard to read without a fixed header.

**Scope**

- Freeze rows above and columns left of the selected cell.
- Sticky header row and first column in the scroll container.
- Freeze/unfreeze from the View menu or toolbar.
- Persist the freeze position per sheet.
- Keep the formula bar and selection behaviour correct while frozen.

**Acceptance criteria**

- Freezing at `B2` keeps row 1 and column A visible while scrolling to row 100.
- The frozen region does not cover or misalign the grid.
- Editing and selection in the frozen region update the normal cells.
- Print output is unaffected by the on-screen freeze.
- The control is keyboard-accessible and works at 390 px width.

**Dependencies:** grid scroll/viewport model.
**Effort:** M (1–2 weeks). **Risk:** medium; test with the on-screen keyboard on mobile.

### 2.4 Filters and filter views

**Why:** filtering is the normal way to narrow a table without deleting rows.

**Scope**

- AutoFilter row on a detected table.
- Filter by value checklist and by condition (text contains, number range, date range,
  blanks/non-blanks).
- Hide non-matching rows without deleting data.
- Clear all filters; show a count of visible rows.
- A filter view that does not change the saved filter state for other users (local
  only for now).
- Sort visible rows without disturbing hidden rows, or clearly disable sort while a
  filter is active.

**Acceptance criteria**

- Filtering hides rows, leaves the underlying cells intact, and recalculates formulas
  against the full data set.
- Clearing the filter restores every row exactly.
- A filter applied to a header row does not treat the header as data.
- Filter state persists across reload or is explicitly documented as session-only.
- Keyboard users can open, navigate, and clear the filter menu.

**Dependencies:** row visibility model, range/table abstraction, sort.
**Effort:** L (3–5 weeks).

### 2.5 Multi-key sort

**Why:** one key is not enough for real tables with duplicate categories.

**Scope**

- Sort dialog with up to three keys.
- Per-key ascending/descending and a header-row toggle.
- Stable ties, blanks last, numeric-vs-text ordering.
- Sort the selected range or the detected table.
- Undo as one action.

**Acceptance criteria**

- Sorting by `Category` then `Amount` produces the expected order.
- Ties preserve their original relative order.
- The header row is never sorted when the toggle is on.
- Blank cells stay at the bottom in both directions.
- The dialog is keyboard-accessible and remembers the last keys for the session.

**Dependencies:** sort engine, range detection.
**Effort:** S–M (1–2 weeks).

### 2.6 Conditional formatting

**Why:** colour rules turn a table into a readable report and are a benchmark
table-stakes feature.

**Scope**

- Rule types: cell value comparison, text contains, date occurring, top/bottom N,
  duplicate/unique, formula-based.
- Formats: text colour, fill colour, bold, italic, border.
- Two-colour and three-colour scales; data bars.
- Apply to a range, priority order, stop-if-true.
- Rules recalculate after edits and persist per sheet.
- Manage rules: list, edit, delete, reorder.

**Acceptance criteria**

- A rule changes only presentation, never the stored value or formula result.
- Editing a value immediately updates the rule's effect.
- Rules survive reload and print.
- Copy/paste of a cell copies its rule or explicitly documents that rules stay with
  the range.
- A sheet with 100 rules over 10,000 cells remains responsive.
- A deleting/inserting rows operation updates rule ranges correctly, or blocks with a
  clear message.

**Dependencies:** style model, recalculation hooks, range transformation from 2.1.
**Effort:** L (3–5 weeks). **Risk:** medium–high; rule evaluation can become a
performance hotspot.

### 2.7 Data validation

**Why:** validation prevents bad input and makes templates trustworthy.

**Scope**

- Whole number, decimal, date, time, text length, list, and custom formula rules.
- Input message and error alert (stop, warning, information).
- In-cell dropdown for list validation.
- Apply to a range; copy/paste and fill respect validation.
- Validation state persists and is included in print where relevant.
- Accessible error messaging, not a colour-only cue.

**Acceptance criteria**

- An invalid entry is rejected or flagged according to the alert style.
- A dropdown list opens from the keyboard and filters as the user types.
- Pasting invalid values either rejects the paste or marks the cells, consistently.
- Validation ranges follow row/column insertion and deletion.
- Rules survive reload and are listed/edited in one place.
- Existing formulas and values are never silently rewritten.

**Dependencies:** edit pipeline, row/column transformation, range model.
**Effort:** M–L (2–4 weeks).

### 2.8 Comments and notes

**Why:** review and handoff need cell-level context.

**Scope**

- Add, edit, and delete a comment on a cell.
- Author name, timestamp, and a visible indicator.
- Threaded replies are optional; start with a single note per cell.
- Show/hide comments; include or exclude them in print.
- Persist comments in IndexedDB.

**Acceptance criteria**

- A commented cell shows an indicator without obscuring its value.
- The comment survives reload and sheet duplication.
- Deleting a row deletes or re-anchors its comments predictably.
- Comments are reachable by keyboard and announced by screen readers.
- Printing comments is opt-in.

**Dependencies:** cell metadata, row/column operations.
**Effort:** S–M (1–2 weeks).

### Phase 2 release gate

- [ ] Row/column operations pass a reference-rewrite matrix (same sheet, cross-sheet,
      absolute, ranges, deleted references, merged cells).
- [ ] Borders, fonts, merge, wrap, freeze, filters, multi-key sort, conditional
      formatting, validation, and comments have automated UI coverage.
- [ ] Existing Phase 1 and AI/offline suites pass.
- [ ] A 10,000-cell workbook with formatting and rules remains interactive.
- [ ] Print/PDF output matches the grid for borders, fills, fonts, and merges.
- [ ] README, this roadmap, and the in-app help are updated.
- [ ] Service-worker cache version is bumped.

---

## Phase 3 — Charts and analysis

**Goal:** turn a correct table into an answer. Charts and pivot summaries are the two
features users ask for after formatting.

### 3.1 Charts

**Scope**

- Chart types: column, bar, line, area, pie, doughnut, scatter.
- Create from a selected range with a detected header/series layout.
- Titles, axis labels, legend, gridlines, number formats.
- Resize, move, delete, and persist the chart on the sheet.
- Live update when source values change.
- Export the chart in print/PDF; optional PNG/SVG download.
- Handle blanks, text, errors, and negative values predictably.

**Acceptance criteria**

- A chart created from `A1:B5` updates within one frame of an edit.
- Switching a series between rows and columns works.
- The chart survives reload and appears in print.
- A deleted source range produces a clear empty/error state, not a broken canvas.
- Charts are keyboard-selectable and have a text alternative.
- No external charting dependency is required; render with SVG or canvas.

**Dependencies:** range/table abstraction, style/print layer.
**Effort:** L (4–6 weeks).

### 3.2 Pivot tables

**Scope**

- Source range with a header row.
- Row, column, value, and filter fields.
- Aggregations: sum, count, average, min, max.
- Grand totals, subtotals, and blank handling.
- Refresh after source edits; a visible "stale" state.
- Persist the pivot definition and its output range.
- A compact builder panel; no drag-and-drop requirement in the first version.

**Acceptance criteria**

- A pivot over a 1,000-row table produces correct totals and counts.
- Changing a source value and refreshing updates the pivot.
- Adding a row inside the source range is included after refresh.
- The pivot does not overwrite unrelated cells; the destination is explicit.
- The definition survives reload and can be deleted without deleting source data.
- Keyboard users can build and refresh a pivot.

**Dependencies:** range abstraction, aggregation engine, row/column safety.
**Effort:** L (4–6 weeks). **Risk:** high; define a narrow first version.

### 3.3 Named ranges and structured tables

**Scope**

- Named ranges with a name manager.
- Use names in formulas and chart/pivot source fields.
- A table object with a stable name, header row, and structured references where
  feasible.
- Migration from plain ranges without rewriting values.

**Acceptance criteria**

- Renaming a range updates formulas that use the name.
- A table survives row insertion and formula references remain correct.
- Names are validated (no spaces, no cell-reference collisions) and persisted.
- Import/export preserves names where the file format supports them.

**Dependencies:** reference model, formula parser.
**Effort:** M–L (2–4 weeks).

### 3.4 Formula depth

**Scope**

- `SUBTOTAL` and `AGGREGATE` for filtered data.
- More date/time, text, lookup, statistical, and financial functions driven by user
  requests.
- Array formulas / dynamic spill ranges, behind the range model.
- Formula autocomplete and argument hints.
- Better error messages with the failing token.

**Acceptance criteria**

- `SUBTOTAL` ignores filtered-out rows in the same way as the benchmark products.
- Array formulas return a spill range and refuse to overwrite non-empty cells without
  confirmation.
- Autocomplete is keyboard-navigable and does not trap focus.
- Existing formulas continue to parse and evaluate unchanged.

**Dependencies:** parser/AST, range model.
**Effort:** M–L (2–4 weeks).

### Phase 3 release gate

- [ ] Chart and pivot regression suites pass on desktop and mobile.
- [ ] A workbook with a chart, a pivot, and conditional formatting reloads intact.
- [ ] Performance budget holds with 50,000 populated cells and five charts.
- [ ] Print/PDF output includes charts and pivots with legible labels.
- [ ] Documentation covers chart/pivot limits and refresh semantics.

---

## Phase 4 — Scale and interoperability

**Goal:** stop being a demo-sized grid and become a trustworthy place to keep a real
workbook.

### 4.1 Virtualized grid

**Scope**

- Render only visible rows/columns; keep the DOM small.
- Target at least 50,000 rows × 256 columns, with 10,000 populated cells as the
  interactive baseline.
- Chunked IndexedDB persistence for large sheets.
- Incremental recalculation instead of recomputing every formula on every edit.
- A dependency graph for formulas, with cycle detection preserved.

**Acceptance criteria**

- Scrolling a 50,000-row sheet stays smooth on a mid-range laptop.
- Editing a cell updates only its dependents, not the whole sheet.
- Reload restores a large sheet without freezing the main thread for more than one
  second.
- Memory stays within a documented budget.
- Existing small-workbook behaviour is unchanged.

**Effort:** XL (6–10 weeks). **Risk:** high; profile before and after each change.

### 4.2 XLSX fidelity

**Scope**

- Export live formulas (`f` cells), not only displayed values.
- Preserve number formats, fonts, fills, borders, alignment, merged cells, column
  widths, row heights, freeze panes, and multiple sheets.
- Import the same properties from the first worksheet and, where feasible, all
  worksheets.
- Document what SheetJS community edition can and cannot round-trip.
- Fixture workbooks for regression tests.

**Acceptance criteria**

- A workbook exported by the app opens in Excel with formulas intact.
- A workbook with basic formatting round-trips through the app with no visible loss.
- Merged cells, freeze panes, and number formats survive export/import.
- Unsupported features are listed in the UI, not silently dropped.
- No formula is exported as a value when a live formula is representable.

**Effort:** L (4–6 weeks). **Risk:** medium–high; library limitations are real.

### 4.3 Local version history

**Scope**

- Automatic local snapshots on a schedule and before destructive operations.
- A history panel with timestamps and a short label.
- Restore a snapshot with a confirmation.
- Retention policy and storage budget.
- No server, no account.

**Acceptance criteria**

- A user can recover a workbook after an accidental clear or bad sort.
- Restoring creates a new undoable action rather than destroying the current state.
- History stays within the storage budget and old snapshots are pruned predictably.
- History is opt-in or clearly disclosed, with a "clear history" control.

**Effort:** M–L (2–4 weeks).

### 4.4 Print layout

**Scope**

- Page size, orientation, margins, scale/fit-to-width.
- Print area and page breaks.
- Repeated header rows/columns.
- Headers/footers with sheet name and page number.
- A print preview that matches the output.

**Acceptance criteria**

- A wide table fits on one page when "fit to width" is selected.
- Repeated headers appear on every printed page.
- The preview matches the printed/PDF result.
- Settings persist per sheet.

**Effort:** M (1–3 weeks).

### Phase 4 release gate

- [ ] Large-sheet benchmarks are documented and reproducible.
- [ ] XLSX fixtures pass in both directions.
- [ ] Version history and restore are covered by destructive-action tests.
- [ ] Print preview matches PDF output.
- [ ] Storage growth is measured and bounded.

---

## Phase 5 — Collaboration and automation (conditional)

**Goal:** only pursue this phase if the product direction requires multi-user work or
power-user automation. Both add a backend or a security boundary that the current
local-first app deliberately avoids.

### 5.1 Collaboration

**Scope**

- A small backend with authenticated workspaces.
- Real-time presence, cell-level or range-level editing, and conflict resolution
  (CRDT or operational transform).
- Comments and mentions; optional notifications.
- Share links with view/edit roles.
- An explicit privacy model: what leaves the browser, who can read it, and how to
  delete it.
- A local-only mode that remains fully functional.

**Acceptance criteria**

- Two clients editing the same sheet converge without lost updates in a documented
  conflict model.
- Offline edits reconcile on reconnect.
- Permissions are enforced server-side, not only in the UI.
- Comments and presence are accessible and do not leak sheet data to unauthorised
  users.
- The local-only app still works with the backend disabled.

**Effort:** XL (8+ weeks plus operations). **Risk:** very high; this is a different
product.

### 5.2 Sandboxed automation

**Scope**

- A macro/script layer that runs in a Web Worker with an explicit capability API.
- No `eval` in the main page; no network or DOM access by default.
- A permission prompt listing the cells and actions the script can touch.
- Custom functions with deterministic behaviour.
- Import/export of scripts as text.
- A dry-run mode with a preview of writes.

**Acceptance criteria**

- A script cannot read or write outside its granted ranges.
- A runaway script can be cancelled and does not freeze the page.
- Every script write goes through the existing review/undo model.
- Scripts are portable text and are not silently executed on load.
- Security review is documented and tested.

**Effort:** XL (6–10 weeks). **Risk:** high; arbitrary automation is a security
surface.

### 5.3 Reviewed AI expansion

**Scope**

- Multi-cell transformations ("clean these columns") with a diff preview.
- Formula explanation and repair.
- Chart and pivot suggestions from a selected range.
- Data-quality suggestions with accept/reject per change.
- A visible model/provider and a cost/latency estimate before dispatch.

**Acceptance criteria**

- Every AI write still requires a user command, a permission slip, and Save/Discard.
- A multi-cell proposal shows a cell-by-cell diff and can be partially accepted.
- Rejecting a proposal leaves the workbook byte-for-byte unchanged.
- Research answers continue to carry sources.
- No API key is ever sent anywhere except the configured provider.

**Effort:** M–L (2–4 weeks), depending on provider APIs.

---

## Cross-cutting workstreams

These run through every phase and are part of "done", not a separate phase.

### Accessibility

- The grid uses ARIA grid roles; keep row/column counts and selection state accurate.
- Every new dialog is keyboard-operable and traps focus correctly.
- Do not rely on colour alone for validation, conditional formatting, or errors.
- Announce selection, sort, filter, and validation results to screen readers.
- Test at 200% zoom and at 390 px width.

### Performance

- Budget: first meaningful paint under 1.5 s on a mid-range laptop; edit-to-render
  under 50 ms for 10,000 populated cells; no long task over 200 ms during ordinary
  editing.
- Profile before optimising. Keep the formula engine pure and measurable.
- Virtualize before adding more DOM-heavy features.

### Security and privacy

- No telemetry, no analytics, no backend in the local-first mode.
- AI and research hosts remain network-only; never cache responses that contain keys.
- Sanitize all rendered text; never `innerHTML` untrusted model output.
- Keep keys in `localStorage`, never in the repository or a service worker cache.
- Treat imported files as untrusted input.
- Document every outbound request.

### Testing

- Unit tests for the formula engine, reference rewriting, and range transforms.
- Playwright flows for editing, formatting, sort/filter, validation, charts, pivots,
  print, persistence, and AI review.
- XLSX fixture round-trips.
- Offline and service-worker tests after every cache change.
- A regression suite for the AI safety invariant: no write without a permission slip.

### Documentation

- Update `README.md` for user-facing behaviour and shortcuts.
- Update this roadmap when a phase ships or slips.
- Keep `docs/FEATURE-RESEARCH.md` current when a benchmark claim changes.
- Add a changelog entry for every release.

---

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Reference-rewriting bugs corrupt formulas | High | High | Build a reference-transform test matrix before UI work; fuzz with generated sheets; keep snapshots for every structural edit |
| Style model bloats storage and rendering | Medium | High | Use compact style objects, dedupe repeated styles, measure payloads, virtualize rendering |
| Conditional formatting or filters slow the grid | Medium | High | Cache rule results per edit generation; profile with 10,000 cells and 100 rules; add a hard budget |
| XLSX library cannot preserve a feature | High | Medium | Document limitations in the UI; fixture tests; consider a targeted writer for formulas/styles if needed |
| Chart/pivot scope explodes | High | High | Ship a narrow first version; defer advanced chart types and calculated fields; gate on user demand |
| Collaboration requires a backend and changes the product | High | High | Keep it Phase 5 and opt-in; preserve a fully local mode; do not promise it early |
| Macro execution becomes a security hole | Medium | High | Web Worker sandbox, capability API, no network/DOM, dry-run, review gate |
| AI safety regresses under new features | Low–Medium | High | Invariant tests; one write path; permission slip and snapshot required by design |
| Performance work delays features | Medium | Medium | Set budgets, measure, and virtualize before adding heavy UI |

---

## Non-goals

- Pixel-perfect Excel rendering or full `.xlsx` feature preservation.
- A complete VBA-compatible macro runtime.
- Real-time collaboration without a backend, accounts, and a conflict model.
- An infinite canvas or a Numbers-style freeform layout.
- Matching every function in Excel.
- A mobile-native app; the PWA remains the delivery target.
- Background jobs, scheduled cloud refreshes, or server-side AI.
- Telemetry or analytics of any kind.

---

## Next actions

1. Write the reference-transform utility and its test matrix (Phase 2.1).
2. Extend the style record for borders, fonts, wrap, and merge (Phase 2.2).
3. Add freeze panes and filters on top of the row-visibility model (2.3–2.4).
4. Ship multi-key sort, conditional formatting, validation, and comments (2.5–2.8).
5. Re-run all Phase 1, AI, offline, and new Phase 2 suites; bump the service-worker
   cache; update README and docs.
