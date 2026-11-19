# Spreadsheet Feature Research

> Benchmark of Microsoft Excel, Google Sheets, LibreOffice Calc, and Apple Numbers,
> with a gap analysis for AI Spreadsheet Assistant.
>
> **Research date:** 19 November 2026  
> **Scope:** documented product capabilities and workflow expectations. This is not a
> performance benchmark, a usability lab, or a claim of file-format compatibility.
> **Method:** direct review of official vendor documentation and product pages. Every
> URL in [Sources](#sources) returned HTTP 200 when checked on the research date.
> Vendor help centres move pages; the links below are the resolved canonical URLs.

---

## Executive summary

The four benchmark products converge on the same daily-driver core: a large grid,
formula references and a broad function library, undo/redo, clipboard operations,
formatting, sorting and filtering, validation, conditional formatting, charts,
pivot tables, comments, file exchange, and some form of collaboration or
automation. They differ mainly in **centre of gravity**:

| Product | Centre of gravity | What it optimises | Constraint that matters here |
| --- | --- | --- | --- |
| **Microsoft Excel** | Breadth and enterprise data work | Formula depth, PivotTables, Power Query, VBA/Office Scripts, co-authoring, the `.xlsx` ecosystem | Desktop-class surface area; web edition is narrower than desktop |
| **Google Sheets** | Browser-first collaboration | Real-time co-authoring, Apps Script, connected-data functions, zero install, version history | Offline use is opt-in and limited; very large data needs a different tool |
| **LibreOffice Calc** | Open-source desktop suite | DataPilot (pivot), conditional formatting, validity, macros, ODF/OOXML interchange | Collaboration is file-based rather than a hosted real-time service |
| **Apple Numbers** | Apple-native visual documents | Tables as movable objects, categories, pivot tables, charts, iCloud collaboration, clean export | Strongest inside Apple's ecosystem; not a Windows/enterprise replacement |
| **AI Spreadsheet Assistant** | Local-first, auditable AI in a spreadsheet | Offline grid, reviewed AI writes, research with sources, no backend | Small grid, no charts/pivots/validation/collaboration yet |

For this project, "parity" should mean **the daily-driver threshold**, not a clone of
twenty years of enterprise features. The benchmark supports five tests:

1. **Never lose work.** Undo/redo, autosave, and a clear saved/unsaved state.
2. **Express normal calculations.** A broad formula library, cross-sheet references,
   absolute references, and predictable error propagation.
3. **Reshape data safely.** Ranges, clipboard, fill, sort, find/replace, filters, and
   row/column operations that keep references coherent.
4. **Communicate results.** Number formats, borders, conditional formatting, charts,
   and print/PDF output.
5. **Fit the workflow.** Import/export, comments, freeze panes, and — only where the
   product can support it — collaboration and automation.

Phase 1 closed tests 1–2 and most of test 3 for ordinary small workbooks. Test 3's
structural operations and filters, plus tests 4–5, analysis (pivot tables), and scale,
remain the meaningful gaps.

---

## 1. Benchmark at a glance

### What each product documents

- **Excel** documents an alphabetical function reference covering several hundred
  functions, PivotTables, conditional formatting, data validation, freeze panes,
  charts, sorting, filtering, and real-time co-authoring. [1–8, 36]
- **Google Sheets** documents a large function list, pivot tables, conditional
  formatting, in-cell dropdowns, sort and filter, offline access, and a product page
  centred on real-time collaboration and connected data. [9–15]
- **LibreOffice Calc** documents DataPilot pivot tables, conditional formatting, cell
  validity, a desktop spreadsheet with charts and data tools, and Basic macro
  support. [16–19]
- **Apple Numbers** documents "hundreds of built-in functions", pivot tables,
  comments, cell conditions, collaboration, and export/sharing. [20–25]

### Capability matrix

Legend: **Yes** = documented first-class capability; **Partial** = available with a
meaningful limit; **No** = not implemented. "This app" describes the Phase 1 build.

#### Editing and navigation

| Capability | Excel | Sheets | Calc | Numbers | This app |
| --- | --- | --- | --- | --- | --- |
| Multi-cell ranges, drag/shift selection, row/column selection | Yes | Yes | Yes | Yes | Yes |
| Typing-to-edit, `F2`, formula bar | Yes | Yes | Yes | Yes | Yes |
| Undo / redo | Yes | Yes | Yes | Yes | Yes — session history, 60 snapshots |
| Cut / copy / paste with relative reference translation | Yes | Yes | Yes | Yes | Yes — TSV text; same-sheet translation |
| Fill down / right | Yes | Yes | Yes | Yes | Yes — commands; no fill handle yet |
| Find and replace | Yes | Yes | Yes | Yes | Yes — current sheet, literal text, case toggle |
| Multiple sheets and cross-sheet references | Yes | Yes | Yes | Yes | Yes |
| Insert/delete/resize/hide rows and columns | Yes | Yes | Yes | Yes | No |
| Freeze panes / repeating headers | Yes | Yes | Yes | Yes | No |
| Merge cells | Yes | Yes | Yes | Yes | No |
| Cell comments / notes | Yes | Yes | Yes | Yes | No |

#### Data shaping

| Capability | Excel | Sheets | Calc | Numbers | This app |
| --- | --- | --- | --- | --- | --- |
| Sort | Yes — multi-key | Yes — multi-key | Yes — multi-key | Yes | Partial — one key, contiguous region, header detection, blanks last |
| Filters / filter views | Yes | Yes | Yes | Yes | No |
| Data validation / dropdowns | Yes | Yes | Yes | Partial — cell controls | No |
| Conditional formatting | Yes | Yes | Yes | Yes — cell conditions | No |
| Pivot tables | Yes | Yes | Yes — DataPilot | Yes | No |
| Structured tables / database ranges | Yes | Yes | Yes | Yes | No |

#### Presentation and output

| Capability | Excel | Sheets | Calc | Numbers | This app |
| --- | --- | --- | --- | --- | --- |
| Bold/italic/underline/strike, alignment, text and fill colours | Yes | Yes | Yes | Yes | Yes |
| Fonts, font sizes, borders, cell styles | Yes | Yes | Yes | Yes | No — cell styles are a small set |
| Number, currency, percent, date formats | Yes | Yes | Yes | Yes | Partial — general, 2dp, integer, USD, percent, date, text |
| Charts | Yes | Yes | Yes | Yes | No |
| Images and shapes | Yes | Yes | Yes | Yes | No |
| Print / PDF | Yes | Yes | Yes | Yes | Partial — browser print window, no page setup |

#### Formulas and analysis

| Capability | Excel | Sheets | Calc | Numbers | This app |
| --- | --- | --- | --- | --- | --- |
| Function library | Several hundred [1] | Large list [9] | Large desktop library [19] | "Hundreds" [20] | 116 callable functions (114 core + `IF`/`IFERROR`) |
| Absolute references (`$A$1`) | Yes | Yes | Yes | Yes | Yes |
| Cross-sheet references | Yes | Yes | Yes | Yes | Yes — quoted sheet names supported |
| Error values and propagation | Yes | Yes | Yes | Yes | Yes — `#DIV/0!`, `#N/A`, `#VALUE!`, `#NUM!`, `#NAME?`, `#CYCLE`, `#ERROR` |

#### Collaboration, automation, and platform

| Capability | Excel | Sheets | Calc | Numbers | This app |
| --- | --- | --- | --- | --- | --- |
| Real-time co-authoring | Yes [8] | Yes [10] | Partial — shared files, not hosted real-time | Yes [24] | No |
| Comments and mentions | Yes | Yes | Yes | Yes [23] | No |
| Macros / scripting | VBA and Office Scripts [26] | Apps Script [27] | LibreOffice Basic [28] | Shortcuts / AppleScript [29] | No |
| Offline editing | Desktop yes; web limited | Partial — opt-in offline [30] | Yes | Yes | Yes — PWA and IndexedDB |
| Mobile use | Yes | Yes | Desktop-first | Yes | Yes — responsive PWA |
| Import/export | XLSX, CSV, PDF and more | XLSX, CSV, PDF, connected data [15] | ODS, XLSX, CSV, PDF | XLSX, CSV, PDF [25] | Partial — XLSX/CSV, print-to-PDF; no live formula export |
| Grid scale | Desktop-class | Large, cloud-backed | Desktop-class | Large | 26 columns × 100 rows |

---

## 2. Product notes

### Microsoft Excel

Excel's advantage is not one feature but the combination of a deep formula engine,
PivotTables, Power Query-style data shaping, rich formatting, and the `.xlsx` file
format that most of the business world exchanges. The official function reference is
organised alphabetically and spans several hundred entries. [1] The PivotTable guide
describes an interactive table that summarises, compares, and rearranges source data. [2]
Conditional formatting, data validation, freeze panes, charts, sorting, and filtering
are all documented as first-class worksheet features. [3–7, 36] Co-authoring is
documented as simultaneous editing of the same workbook. [8]

Implication for this project: Excel sets the **expectation ceiling** for formulas and
analysis. It is not realistic to match its function count or PivotTable depth in a
small PWA. It is realistic to match the common subset: lookup functions, conditional
aggregation, date arithmetic, text functions, and a table-like pivot summary later.

### Google Sheets

Sheets is the reference for **browser-first collaboration**. Its product page leads
with real-time co-editing, comments, and connected data; its help centre documents
pivot tables, conditional formatting, dropdown validation, and sort/filter. [9–14]
Offline editing exists but is explicitly opt-in and limited. [30] The function list is
large and includes spreadsheet staples plus Google-specific functions such as
`ARRAYFORMULA`, `QUERY`, and import functions. Apps Script provides automation. [27]

Implication for this project: Sheets validates the **zero-install, single-page app**
delivery model. It also shows that connected data and collaboration are separate
platform investments, not grid features. The app already has the zero-install and
offline advantages; it should not pretend to have Sheets-style live collaboration
without a backend.

### LibreOffice Calc

Calc is the strongest open-source desktop benchmark. Its help documents DataPilot
pivot tables, conditional formatting, and cell validity. [16–18] It supports ODS and
OOXML interchange, charts, data tools, and Basic macros. [19, 28] Collaboration is
file-based rather than a hosted real-time service.

Implication for this project: Calc is the closest philosophical match for a
**local-first, inspectable** spreadsheet. Its data-validity and conditional-formatting
guides are useful models for the roadmap because they describe rule-based features
without a cloud dependency. Calc also shows the value of a macro layer, but that is a
late-stage investment for this app.

### Apple Numbers

Numbers treats tables as objects on a canvas, not as the whole document. Apple
documents "hundreds of built-in functions", pivot tables, comments, cell conditions,
collaboration, and export. [20–25] Its cell-controls feature (checkboxes, sliders,
steppers, pop-up menus) covers some validation use cases without a general rule
engine. [33]

Implication for this project: Numbers is the benchmark for **presentation and
approachability**. Its table-as-object model is out of scope for a grid-first PWA, but
its emphasis on readable output, comments, and simple controls supports the Phase 2
focus on clarity rather than raw feature count.

---

## 3. Gap analysis after Phase 1

### AI is not the benchmark axis

The benchmark products have added AI assistants, but AI is not what makes a
spreadsheet a daily driver. The grid must remain correct and usable with no model, no
network, and no key. This app's differentiator is not "AI in a grid"; it is **AI that
cannot write without an explicit command, a permission slip, and a Save/Discard
review**. That invariant is more valuable than matching a competitor's assistant
surface area, and it should constrain every future AI feature.

The four products also support array or dynamic formulas. They are useful, but they
change the formula engine's return contract and spill-range behaviour. They belong
after the range/table abstraction is stable, not in the next phase.

### What Phase 1 closed

| Capability | Evidence in the app |
| --- | --- |
| Multi-cell selection and aggregates | Drag, `Shift+Click`, `Shift+Arrow`, row/column headers, status-bar sum/average/count |
| Undo / redo | Full-workbook snapshots, 60-entry cap, labelled buttons and shortcuts |
| Clipboard | TSV copy/cut/paste, multi-cell paste, relative formula translation |
| Fill | Fill down (`Ctrl+D`) and fill right (`Ctrl+R`) |
| Formatting | Bold, italic, underline, strike, alignment, text colour, fill colour, seven number formats |
| Find and replace | Current-sheet search, previous/next, replace one/all, case toggle |
| Sort | Single-key sort over a detected region, header detection, blanks last, stable ties |
| Sheet management | Create, rename, duplicate, delete, context menu, unsaved markers |
| Print | Print window with the used range, formatting, and row/column headers |
| Formula library | 116 callable functions (114 core plus lazy `IF`/`IFERROR`) across math, statistics, text, dates, lookup, logical, financial, and conditional aggregation |
| Cross-sheet formulas | `=SUM(Sheet2!A1:A2)`, quoted sheet names, absolute references |
| Persistence | IndexedDB save/reload with style metadata and stale-record reconciliation |

### What remains

| Gap | Benchmark expectation | Why it matters | Priority |
| --- | --- | --- | --- |
| Row/column insert, delete, resize, hide | Every product | Structural edits are part of normal spreadsheet work; inserting a row must not silently break references | P0 |
| Borders, fonts, font sizes, merge | Every product | Formatting is how a sheet becomes readable and printable | P0 |
| Freeze panes / repeating headers | Every product | Long sheets are unusable without a fixed header | P0 |
| Filters | Every product | Users expect to narrow a table without deleting rows | P0 |
| Conditional formatting | Every product | Colour rules communicate thresholds and exceptions | P1 |
| Data validation / dropdowns | Every product (Numbers partial) | Prevents bad input and makes templates usable | P1 |
| Charts | Every product | A chart is the fastest way to communicate a trend | P1 |
| Pivot tables | Every product | Summarising groups is the main analysis workflow beyond formulas | P1 |
| Comments / notes | Every product | Review and handoff need cell-level discussion | P2 |
| Multi-key sort | Every product | Single-key sort is insufficient for real tables | P1 |
| Array formulas | Excel, Sheets, Calc, Numbers | Dynamic arrays change what a formula can return | P2 |
| Larger grid + virtualization | Desktop-class products | 26×100 is a demo-sized grid; real workbooks grow | P1 |
| XLSX fidelity | Excel, Sheets, Calc, Numbers | Round-tripping formatting and live formulas is a trust issue | P1 |
| Collaboration | Excel, Sheets, Numbers | Requires a backend and a conflict model; not a grid feature | P3 |
| Macros / scripting | Excel, Sheets, Calc, Numbers | Power users need repeatable automation; also a security surface | P3 |

### Priority logic

Priority is **frequency × dependency × cost**, not a vote:

- **P0** features are used in ordinary editing sessions and unlock other work:
  row/column operations, borders, freeze panes, and filters.
- **P1** features make the sheet communicate and analyse: conditional formatting,
  validation, charts, pivot tables, multi-key sort, larger grid, XLSX fidelity.
- **P2** features are valuable but can wait for a stable data model: comments, array
  formulas, named ranges, version history.
- **P3** features require a backend or a security model the app does not have:
  real-time collaboration, accounts, and arbitrary macro execution.

### Feature dependencies

```text
Row/column operations ──> reference rewriting ──> structural undo
        │
        ├──> filters (hidden rows)
        └──> freeze panes (viewport model)

Style metadata ──> borders/fonts/merge ──> print layout
        │
        └──> conditional formatting (rule engine + recalculation hooks)

Edit pipeline ──> data validation ──> paste/import validation
        │
        └──> comments (cell metadata)

Range detection ──> sort ──> multi-key sort
        │
        ├──> filters
        └──> pivot tables (source range + aggregation)

Formula engine ──> array formulas ──> dynamic spill ranges
        │
        └──> chart series (range references)
```

The important consequence: **do not build charts or pivots before the range and
reference model is stable.** A chart that cannot survive an inserted row is worse than
no chart.

---

## 4. What parity should mean for this project

### Table stakes (must reach)

- Structural edits that preserve formulas.
- Readable output: borders, fonts, alignment, number formats, print.
- Freeze panes and filters for long tables.
- Conditional formatting and validation for templates.
- A larger grid with virtualization.
- Multi-key sort and a dependable XLSX round trip.

### Differentiators (already present, keep them)

- **Local-first:** the grid works offline and data stays in the browser.
- **Auditable AI:** the model never writes without a user command, a permission slip,
  and a Save/Discard review.
- **Sourced research:** answers can carry citations and table extraction.
- **Small, inspectable codebase:** no build step, no backend, no telemetry.

### Explicit non-goals

- Pixel-perfect Excel rendering or full `.xlsx` feature preservation.
- A full VBA-compatible macro runtime.
- Real-time multi-user collaboration without a server and a conflict model.
- An infinite canvas or Numbers-style freeform layout.
- Matching every function in Excel. The target is the common 10–15% that covers most
  small-business and personal worksheets.

### Success measures for the next phase

| Measure | Target |
| --- | --- |
| Structural edit safety | Insert/delete a row or column; every reference still points at the intended cell |
| Formatting coverage | Borders, font family/size, merge, and wrap available on a range |
| Long-sheet usability | Header row and first column can be frozen |
| Data shaping | Filter and multi-key sort work on a detected table without data loss |
| Presentation | At least four chart types render from a selected range and export with print |
| Analysis | A pivot summary can be created from a range and refreshed after edits |
| Scale | 10,000 populated cells remain responsive in Chrome on a mid-range laptop |
| Compatibility | XLSX export preserves values, formulas (as live formulas where possible), number formats, and sheet names |

---

## 5. Recommendations

1. **Stabilise structure before visuals.** Implement row/column operations with
   reference rewriting and tests first. Every later feature benefits.
2. **Treat formatting as data, not CSS.** Borders, fonts, merge, and conditional rules
   belong in the cell/sheet model so they survive save/reload and export.
3. **Add freeze panes and filters together.** Both depend on a viewport/row-visibility
   model; splitting them creates two half-models.
4. **Build one range/table abstraction.** Sort, filters, charts, and pivots should all
   consume the same `{range, header, rows, columns}` contract.
5. **Keep AI out of the critical path.** The grid must remain fully usable with no key,
   no network, and no AI. AI actions should be previewed and reversible like any other
   edit.
6. **Do not fake collaboration.** Comments and version history can be local-first;
   real-time co-authoring needs a backend and should be a separate product decision.

---

## Sources

All sources were accessed on **19 November 2026**. Microsoft Support redirects are
shown by their resolved URLs where the original `office/...` link moved.

1. Microsoft Support — *Excel functions (alphabetical)*.  
   <https://support.microsoft.com/en-us/excel/excel-functions-alphabetical>
2. Microsoft Support — *Create a PivotTable to analyze worksheet data*.  
   <https://support.microsoft.com/en-us/excel/get-started/create-a-pivottable-to-analyze-worksheet-data>
3. Microsoft Support — *Use conditional formatting to highlight information in Excel*.  
   <https://support.microsoft.com/en-us/excel/use-conditional-formatting-to-highlight-information-in-excel>
4. Microsoft Support — *Apply data validation to cells*.  
   <https://support.microsoft.com/en-us/excel/get-started/apply-data-validation-to-cells>
5. Microsoft Support — *Freeze panes to lock rows and columns*.  
   <https://support.microsoft.com/en-us/excel/get-started/freeze-panes-to-lock-rows-and-columns>
6. Microsoft Support — *Create a chart from start to finish*.  
   <https://support.microsoft.com/en-us/excel/get-started/create-a-chart-from-start-to-finish>
7. Microsoft Support — *Sort data in a range or table in Excel*.  
   <https://support.microsoft.com/en-us/excel/sort-data-in-a-range-or-table-in-excel>
8. Microsoft Support — *Collaborate on Excel workbooks at the same time with co-authoring*.  
   <https://support.microsoft.com/en-us/excel/get-started/collaborate-on-excel-workbooks-at-the-same-time-with-co-authoring>
9. Google Docs Editors Help — *Google Sheets function list*.  
   <https://support.google.com/docs/table/25273?hl=en>
10. Google Workspace — *Google Sheets product page*.  
    <https://workspace.google.com/products/sheets/>
11. Google Docs Editors Help — *Create & use pivot tables*.  
    <https://support.google.com/docs/answer/1272900?hl=en>
12. Google Docs Editors Help — *Use conditional formatting rules in Google Sheets*.  
    <https://support.google.com/docs/answer/78413>
13. Google Docs Editors Help — *Create an in-cell dropdown list*.  
    <https://support.google.com/docs/answer/186103>
14. Google Docs Editors Help — *Sort & filter your data*.  
    <https://support.google.com/docs/answer/3540681>
15. Google Docs Editors Help — *Import data sets & spreadsheets*.  
    <https://support.google.com/docs/answer/40608>
16. LibreOffice Help — *Pivot Table*.  
    <https://help.libreoffice.org/latest/en-US/text/scalc/guide/datapilot.html>
17. LibreOffice Help — *Applying Conditional Formatting*.  
    <https://help.libreoffice.org/latest/en-US/text/scalc/guide/cellstyle_conditional.html>
18. LibreOffice Help — *Validity of Cell Contents*.  
    <https://help.libreoffice.org/latest/en-US/text/scalc/guide/validity.html>
19. LibreOffice — *Calc product page*.  
    <https://www.libreoffice.org/discover/calc/>
20. Apple — *Numbers Support*.  
    <https://support.apple.com/numbers>
21. Apple Support — *Numbers User Guide for Mac* (table of contents).  
    <https://support.apple.com/guide/numbers/toc>
22. Apple Support — *Formulas and Functions Help*.  
    <https://support.apple.com/guide/functions/welcome/web>
23. Apple Support — *Add and print comments in Numbers on Mac*.  
    <https://support.apple.com/guide/numbers/add-and-print-comments-tan9cb3153b0/16.0/mac/1.0>
24. Apple Support — *Intro to collaboration in Numbers*.  
    <https://support.apple.com/guide/numbers/intro-to-collaboration-tan0bbbf4c04/16.0/mac/1.0>
25. Apple Support — *Send a spreadsheet in Numbers on Mac*.  
    <https://support.apple.com/guide/numbers/send-a-spreadsheet-tan368d49f8b/16.0/mac/1.0>
26. Microsoft Learn — *Office Scripts documentation*.  
    <https://learn.microsoft.com/en-us/office/dev/scripts/>
27. Google for Developers — *Apps Script*.  
    <https://developers.google.com/apps-script>
28. LibreOffice Help — *LibreOffice Basic Help*.  
    <https://help.libreoffice.org/latest/en-US/text/sbasic/shared/main0601.html>
29. Apple Support — *Shortcuts User Guide*.  
    <https://support.apple.com/guide/shortcuts/welcome/ios>
30. Google Docs Editors Help — *Work on Google Docs, Sheets, & Slides offline*.  
    <https://support.google.com/docs/answer/6388102>
31. Apple Support — *Intro to pivot tables in Numbers on Mac*.  
    <https://support.apple.com/guide/numbers/intro-to-pivot-tables-tan7ce76e776/16.0/mac/1.0>
32. Apple Support — *Use cell conditions in Numbers on Mac*.  
    <https://support.apple.com/guide/numbers/highlight-cells-tan93f5de5c3/16.0/mac/1.0>
33. Apple Support — *Add checkboxes and other controls to cells*.  
    <https://support.apple.com/guide/numbers/add-checkboxes-and-other-controls-to-cells-tan2a2aa073d/16.0/mac/1.0>
34. Apple Support — *Filter data in Numbers on Mac*.  
    <https://support.apple.com/guide/numbers/filter-data-tan28bd63a8a/16.0/mac/1.0>
35. Apple Support — *Merge or unmerge cells in Numbers on Mac*.  
    <https://support.apple.com/guide/numbers/merge-or-unmerge-cells-tan834b645e7/16.0/mac/1.0>
36. Microsoft Support — *Filter data in a range or table in Excel*.  
    <https://support.microsoft.com/en-us/excel/get-started/filter-data-in-a-range-or-table-in-excel>
