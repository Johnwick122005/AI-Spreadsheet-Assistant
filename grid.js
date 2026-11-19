/*======================================================================
  Grid Controller — SINGLE SOURCE OF TRUTH for workbook state

  Owns: sheets, activeSheet, selection, dirty, undo/redo history

  app.js must read/write state ONLY through these exports. The controller
  also owns the small, well-tested spreadsheet operations (selection,
  clipboard, fill, sort, formatting) so the UI layer stays thin.
======================================================================*/

import { computeCell, translateFormula } from './engine.js';

export const COLUMNS = 26;
export const ROWS = 100;
const MAX_HISTORY = 60;

let sheets = {};          // name -> { name, cells, raw, dirty, meta }
let activeSheet = 'Sheet1';
let selection = { anchor: 'A1', focus: 'A1' };
let dirty = false;

let undoStack = [];
let redoStack = [];

let gridBody, colHeaders, formulaInput, cellAddressDisplay, statusText, gridWrapper;
let editing = null;
let dragState = null;
let renderQueued = false;
let lastScrollKey = '';
let internalClipboard = null;

/*======================================================================
  Setup
======================================================================*/

export function initGrid() {
  gridBody = document.getElementById('grid-body');
  colHeaders = document.getElementById('col-headers');
  formulaInput = document.getElementById('formula-input');
  cellAddressDisplay = document.getElementById('cell-address');
  statusText = document.getElementById('status-text');
  gridWrapper = document.getElementById('grid-scroll');

  setupPointerSelection();
  setupHeaderSelection();
  setupEditingEvents();
}

function defaultMeta() {
  return { colWidths: {}, rowHeights: {}, freeze: { rows: 0, cols: 0 } };
}

function normalizeSheet(sheet, name) {
  if (!sheet) sheet = {};
  if (!sheet.name) sheet.name = name || 'Sheet1';
  if (!sheet.cells) sheet.cells = {};
  if (!sheet.raw) sheet.raw = {};
  if (typeof sheet.dirty !== 'boolean') sheet.dirty = false;
  if (!sheet.meta) sheet.meta = defaultMeta();
  if (!sheet.meta.colWidths) sheet.meta.colWidths = {};
  if (!sheet.meta.rowHeights) sheet.meta.rowHeights = {};
  if (!sheet.meta.freeze) sheet.meta.freeze = { rows: 0, cols: 0 };
  return sheet;
}

/*======================================================================
  State accessors
======================================================================*/

export function getSheets() { return sheets; }
export function getActiveSheet() { return activeSheet; }
export function getSelectedCell() { return selection.focus; }
export function getSelection() { return { ...selection }; }
export function isDirty() { return dirty; }
export function setDirty(value) { dirty = !!value; }

export function setSheets(newSheets) {
  sheets = {};
  Object.entries(newSheets || {}).forEach(([name, sheet]) => {
    sheets[name] = normalizeSheet(sheet, name);
  });
  if (!sheets[activeSheet]) {
    const names = Object.keys(sheets);
    if (names.length) activeSheet = names[0];
    else sheets[activeSheet] = normalizeSheet({ name: activeSheet }, activeSheet);
  }
  clampSelection();
}

export function setActiveSheet(name) {
  if (sheets[name]) activeSheet = name;
}

export function setSelectedCell(addr) {
  selection = { anchor: addr, focus: addr };
}

export function getSheetMeta(name = activeSheet) {
  const sheet = sheets[name];
  return sheet ? normalizeSheet(sheet, name).meta : defaultMeta();
}

/*======================================================================
  Address helpers
======================================================================*/

export function parseAddr(addr) {
  const match = String(addr).match(/^([A-Z]+)(\d+)$/i);
  if (!match) return ['A', 1];
  return [match[1].toUpperCase(), parseInt(match[2], 10)];
}

export function colIndex(col) {
  return [...col.toUpperCase()].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
}

export function colIndexToCol(n) {
  let s = '';
  while (n >= 0) {
    const rem = n % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

function pointToAddr(col, rowIndex) {
  return colIndexToCol(Math.max(0, Math.min(COLUMNS - 1, col)))
    + (Math.max(0, Math.min(ROWS - 1, rowIndex)) + 1);
}

function addrToPoint(addr) {
  const [col, row] = parseAddr(addr);
  return { col: Math.max(0, colIndex(col)), row: Math.max(0, Math.min(ROWS, row) - 1) };
}

function clampSelection() {
  const a = addrToPoint(selection.anchor);
  const f = addrToPoint(selection.focus);
  selection = {
    anchor: pointToAddr(a.col, a.row),
    focus: pointToAddr(f.col, f.row),
  };
}

export function getSelectionRect() {
  const a = addrToPoint(selection.anchor);
  const f = addrToPoint(selection.focus);
  const c1 = Math.min(a.col, f.col);
  const c2 = Math.max(a.col, f.col);
  const r1 = Math.min(a.row, f.row);
  const r2 = Math.max(a.row, f.row);
  return {
    r1, r2, c1, c2,
    start: pointToAddr(c1, r1),
    end: pointToAddr(c2, r2),
    range: c1 === c2 && r1 === r2 ? pointToAddr(c1, r1) : `${pointToAddr(c1, r1)}:${pointToAddr(c2, r2)}`,
    single: c1 === c2 && r1 === r2,
    rows: r2 - r1 + 1,
    cols: c2 - c1 + 1,
  };
}

export function inSelection(addr) {
  const rect = getSelectionRect();
  const p = addrToPoint(addr);
  return p.col >= rect.c1 && p.col <= rect.c2 && p.row >= rect.r1 && p.row <= rect.r2;
}

/*======================================================================
  Selection
======================================================================*/

export function selectCell(addr) {
  selection = { anchor: addr, focus: addr };
  renderGrid();
}

export function selectRange(anchor, focus) {
  selection = { anchor, focus };
  renderGrid();
}

export function selectAll() {
  selection = { anchor: 'A1', focus: pointToAddr(COLUMNS - 1, ROWS - 1) };
  renderGrid();
}

export function moveSelection(dRow, dCol, extend = false) {
  const [col, row] = parseAddr(selection.focus);
  const next = pointToAddr(
    colIndex(col) + dCol,
    row - 1 + dRow,
  );
  if (extend) selection = { anchor: selection.anchor, focus: next };
  else selection = { anchor: next, focus: next };
  renderGrid();
}

export function moveToEdge(dRow, dCol, extend = false) {
  const sheet = sheets[activeSheet];
  if (!sheet) return;
  const [colText, row] = parseAddr(selection.focus);
  let col = colIndex(colText);
  let r = row - 1;
  const stepRow = Math.sign(dRow);
  const stepCol = Math.sign(dCol);

  const occupied = (c, rr) => {
    const cell = sheet.cells[pointToAddr(c, rr)];
    return !!(cell && String(cell.raw || '').trim());
  };

  if (stepRow) {
    while (r + stepRow >= 0 && r + stepRow < ROWS && occupied(col, r + stepRow)) r += stepRow;
    if (r === row - 1) r = Math.max(0, Math.min(ROWS - 1, r + stepRow));
  }
  if (stepCol) {
    while (col + stepCol >= 0 && col + stepCol < COLUMNS && occupied(col + stepCol, r)) col += stepCol;
    if (col === colIndex(colText)) col = Math.max(0, Math.min(COLUMNS - 1, col + stepCol));
  }
  const next = pointToAddr(col, r);
  if (extend) selection = { anchor: selection.anchor, focus: next };
  else selection = { anchor: next, focus: next };
  renderGrid();
}

/*======================================================================
  Undo / redo
======================================================================*/

function snapshotState() {
  return JSON.parse(JSON.stringify({ sheets, activeSheet, selection }));
}

function applySnapshot(state) {
  sheets = {};
  Object.entries(state.sheets || {}).forEach(([name, sheet]) => {
    sheets[name] = normalizeSheet(sheet, name);
  });
  activeSheet = state.activeSheet && sheets[state.activeSheet]
    ? state.activeSheet
    : (Object.keys(sheets)[0] || 'Sheet1');
  selection = state.selection || { anchor: 'A1', focus: 'A1' };
  clampSelection();
  dirty = true;
  Object.values(sheets).forEach((sheet) => { sheet.dirty = true; });
  renderTabs();
  renderGrid();
  dispatchStateEvent();
}

export function captureState() {
  return snapshotState();
}

export function recordHistory(label = 'Edit', before = null) {
  undoStack.push({ label, state: before || snapshotState(), at: Date.now() });
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack = [];
  dispatchStateEvent();
}

export function clearHistory() {
  undoStack = [];
  redoStack = [];
  dispatchStateEvent();
}

export function canUndo() { return undoStack.length > 0; }
export function canRedo() { return redoStack.length > 0; }
export function undoLabel() { return undoStack.length ? undoStack[undoStack.length - 1].label : ''; }
export function redoLabel() { return redoStack.length ? redoStack[redoStack.length - 1].label : ''; }

export function undo() {
  const item = undoStack.pop();
  if (!item) return '';
  redoStack.push({ label: item.label, state: snapshotState(), at: Date.now() });
  applySnapshot(item.state);
  return item.label;
}

export function redo() {
  const item = redoStack.pop();
  if (!item) return '';
  undoStack.push({ label: item.label, state: snapshotState(), at: Date.now() });
  applySnapshot(item.state);
  return item.label;
}

function dispatchStateEvent() {
  window.dispatchEvent(new CustomEvent('grid-history', {
    detail: { canUndo: canUndo(), canRedo: canRedo(), undoLabel: undoLabel(), redoLabel: redoLabel() },
  }));
}

/*======================================================================
  Tabs
======================================================================*/

export function renderTabs() {
  const container = document.getElementById('sheet-tabs');
  if (!container) return;
  container.innerHTML = '';
  Object.keys(sheets).forEach((name) => {
    const btn = document.createElement('button');
    btn.className = `sheet-tab ${name === activeSheet ? 'active' : ''} ${sheets[name].dirty ? 'dirty' : ''}`;
    btn.dataset.sheet = name;
    btn.textContent = name;
    btn.title = `${name} — double-click to rename, right-click for more`;
    btn.setAttribute('aria-pressed', String(name === activeSheet));
    btn.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('switch-sheet', { detail: name }));
    });
    btn.addEventListener('dblclick', (event) => {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent('rename-sheet', { detail: { name } }));
    });
    btn.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent('sheet-context', {
        detail: { name, x: event.clientX, y: event.clientY },
      }));
    });
    container.appendChild(btn);
  });

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'sheet-tab-add';
  add.title = 'New sheet';
  add.setAttribute('aria-label', 'New sheet');
  add.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-plus"></use></svg>';
  add.addEventListener('click', () => window.dispatchEvent(new CustomEvent('new-sheet')));
  container.appendChild(add);
}

/*======================================================================
  Rendering
======================================================================*/

function styleForCell(cell) {
  const style = cell?.style || {};
  const value = cell?.value;
  const isNumericValue = (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.trim() !== '' && !isError(value) && !isNaN(Number(value)));
  const numeric = style.numFmt === 'text' ? false : isNumericValue;
  return { style, numeric, display: formatCellDisplay(value, style, cell) };
}

function isError(value) {
  return typeof value === 'string' && value.startsWith('#');
}

export function formatCellDisplay(value, style = {}, cell = null) {
  if (cell && cell.error) return cell.error;
  if (isError(value)) return value;
  if (value === null || value === undefined || value === '') return '';

  const fmt = style.numFmt || 'general';
  if (fmt === 'text') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';

  const numeric = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(numeric)) return String(value);

  if (fmt === 'date') {
    const raw = String(value);
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : raw;
  }
  if (fmt === 'currency') {
    return numeric.toLocaleString('en-US', {
      style: 'currency', currency: style.currency || 'USD',
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }
  if (fmt === 'percent') {
    return `${(numeric * 100).toLocaleString('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    })}%`;
  }
  if (fmt === 'number') {
    return numeric.toLocaleString('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }
  if (fmt === 'integer') {
    return numeric.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
  return String(value);
}

function cellClasses(cell, addr, rect) {
  const [, row] = parseAddr(addr);
  const p = addrToPoint(addr);
  const classes = ['cell'];
  if (cell?.header) classes.push('header-cell');
  if (typeof cell?.raw === 'string' && cell.raw.startsWith('=')) classes.push('formula-cell');
  if (cell?.error) classes.push('error-cell');
  if (cell?.style?.bold) classes.push('is-bold');
  if (cell?.style?.italic) classes.push('is-italic');
  if (cell?.style?.underline) classes.push('is-underline');
  if (cell?.style?.strike) classes.push('is-strike');
  if (addr === selection.focus) classes.push('selected');
  else if (p.col >= rect.c1 && p.col <= rect.c2 && p.row >= rect.r1 && p.row <= rect.r2) {
    classes.push('in-range');
  }
  if (cell?.style?.fill) classes.push('has-fill');
  return classes.join(' ');
}

export function renderGrid() {
  const sheet = sheets[activeSheet];
  if (!sheet) return;
  normalizeSheet(sheet, activeSheet);
  const rect = getSelectionRect();

  // Column headers
  colHeaders.querySelectorAll('th.col-header').forEach((el) => el.remove());
  for (let c = 0; c < COLUMNS; c++) {
    const label = colIndexToCol(c);
    const th = document.createElement('th');
    const selected = c >= rect.c1 && c <= rect.c2;
    th.className = `col-header${selected ? ' selected' : ''}`;
    th.textContent = label;
    th.dataset.col = label;
    th.title = `Select column ${label}`;
    colHeaders.appendChild(th);
  }

  // Rows
  gridBody.innerHTML = '';
  const fragment = document.createDocumentFragment();
  for (let r = 1; r <= ROWS; r++) {
    const tr = document.createElement('tr');
    const rowSelected = r - 1 >= rect.r1 && r - 1 <= rect.r2;

    const rowHeader = document.createElement('th');
    rowHeader.className = `row-number${rowSelected ? ' selected' : ''}`;
    rowHeader.textContent = r;
    rowHeader.dataset.row = String(r);
    rowHeader.title = `Select row ${r}`;
    tr.appendChild(rowHeader);

    for (let c = 0; c < COLUMNS; c++) {
      const addr = colIndexToCol(c) + r;
      const cell = sheet.cells[addr];
      const td = document.createElement('td');
      td.className = cellClasses(cell, addr, rect);
      td.dataset.address = addr;
      td.setAttribute('role', 'gridcell');
      td.setAttribute('aria-selected', addr === selection.focus ? 'true' : 'false');
      td.title = cell?.raw || '';

      const { style, numeric, display } = styleForCell(cell);
      if (numeric) td.classList.add('num');
      td.textContent = cell?.error ? `⚠ ${display}` : display;

      if (style.align) td.style.textAlign = style.align;
      else if (numeric) td.style.textAlign = 'right';
      if (style.color) td.style.color = style.color;
      if (style.fill) td.style.background = style.fill;
      if (style.bold) td.style.fontWeight = '600';
      if (style.italic) td.style.fontStyle = 'italic';
      if (style.underline || style.strike) {
        td.style.textDecoration = [style.underline ? 'underline' : '', style.strike ? 'line-through' : '']
          .filter(Boolean).join(' ');
      }

      tr.appendChild(td);
    }
    fragment.appendChild(tr);
  }
  gridBody.appendChild(fragment);

  // Sync formula bar (do not fight the caret while the reader is typing there)
  const activeCell = sheet.cells[selection.focus];
  if (document.activeElement !== formulaInput) {
    cellAddressDisplay.value = rect.range;
    formulaInput.value = activeCell ? (activeCell.raw || '') : '';
    formulaInput.placeholder = activeCell?.raw?.startsWith('=')
      ? 'Formula cell — edit formula…'
      : 'Enter value or formula…';
  }

  scrollToSelected();
  updateStatusBar();
  window.dispatchEvent(new CustomEvent('grid-selection', {
    detail: { rect, focus: selection.focus, cell: activeCell || null, sheet: activeSheet },
  }));
}

function scrollToSelected() {
  const key = `${selection.focus}|${getSelectionRect().range}`;
  if (key === lastScrollKey) return;
  lastScrollKey = key;
  const td = document.querySelector(`td[data-address="${selection.focus}"]`);
  if (td) td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function updateStatusBar() {
  if (statusText) {
    statusText.textContent = dirty ? 'Unsaved changes' : 'Ready';
    statusText.classList.toggle('unsaved', dirty);
  }
  const info = document.getElementById('cell-info');
  const rect = getSelectionRect();
  if (info) info.textContent = rect.range;

  const statsEl = document.getElementById('selection-stats');
  if (!statsEl) return;
  const sheet = sheets[activeSheet];
  const values = [];
  if (sheet) {
    for (let r = rect.r1; r <= rect.r2; r++) {
      for (let c = rect.c1; c <= rect.c2; c++) {
        const cell = sheet.cells[pointToAddr(c, r)];
        if (!cell) continue;
        const value = cell.value ?? cell.raw ?? '';
        if (value !== '') values.push(value);
      }
    }
  }
  const nums = values
    .map((v) => (typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''))))
    .filter((n) => Number.isFinite(n));
  if (!values.length) {
    statsEl.textContent = '';
    return;
  }
  const parts = [`${values.length} cell${values.length === 1 ? '' : 's'}`];
  if (nums.length) {
    const sum = nums.reduce((a, b) => a + b, 0);
    const avg = sum / nums.length;
    const short = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    parts.unshift(`Σ ${short(sum)}`, `x̄ ${short(avg)}`);
  }
  statsEl.textContent = parts.join(' · ');
}

/*======================================================================
  Pointer selection and editing
======================================================================*/

function setupPointerSelection() {
  if (!gridBody) return;

  gridBody.addEventListener('mousedown', (event) => {
    const td = event.target.closest('td.cell');
    if (!td || event.button !== 0) return;
    if (editing) finishEditing('none');
    // Fragment selection prevents focus changes, so a colour picker or
    // toolbar input would keep focus and swallow the next keystrokes.
    const active = document.activeElement;
    if (active && active !== document.body && typeof active.blur === 'function') active.blur();
    const addr = td.dataset.address;
    if (!addr) return;

    if (event.shiftKey) {
      selection = { anchor: selection.anchor, focus: addr };
    } else {
      selection = { anchor: addr, focus: addr };
    }
    dragState = { active: true, anchor: selection.anchor, moved: false };
    renderGrid();
    event.preventDefault();
  });

  gridBody.addEventListener('dblclick', (event) => {
    const td = event.target.closest('td.cell');
    if (!td) return;
    startEditOn(td.dataset.address, null);
  });

  document.addEventListener('mousemove', (event) => {
    if (!dragState?.active) return;
    const td = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('td.cell');
    if (!td || !td.dataset.address) return;
    const addr = td.dataset.address;
    if (addr === selection.focus) return;
    dragState.moved = true;
    selection = { anchor: dragState.anchor, focus: addr };
    queueRender();
  });

  document.addEventListener('mouseup', () => {
    if (dragState) dragState.active = false;
  });
}

function setupHeaderSelection() {
  if (colHeaders) {
    colHeaders.addEventListener('click', (event) => {
      const corner = event.target.closest('.corner-cell');
      if (corner) { selectAll(); return; }
      const th = event.target.closest('th.col-header');
      if (!th) return;
      const col = colIndex(th.dataset.col);
      if (event.shiftKey) {
        selection = { anchor: selection.anchor, focus: pointToAddr(col, ROWS - 1) };
      } else {
        selection = { anchor: pointToAddr(col, 0), focus: pointToAddr(col, ROWS - 1) };
      }
      renderGrid();
    });
  }

  if (gridBody) {
    gridBody.addEventListener('click', (event) => {
      const th = event.target.closest('th.row-number');
      if (!th) return;
      const row = Number(th.dataset.row) - 1;
      if (event.shiftKey) {
        selection = { anchor: selection.anchor, focus: pointToAddr(COLUMNS - 1, row) };
      } else {
        selection = { anchor: pointToAddr(0, row), focus: pointToAddr(COLUMNS - 1, row) };
      }
      renderGrid();
    });
  }
}

function setupEditingEvents() {
  // The editor is created per cell; no persistent listeners are needed here.
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderGrid();
  });
}

export function beginEditSelected(initial = null) {
  const td = document.querySelector(`td[data-address="${selection.focus}"]`);
  if (td) startEditOn(selection.focus, initial);
}

function startEditOn(addr, initial = null) {
  if (editing) return;
  const sheet = sheets[activeSheet];
  if (!sheet) return;
  const td = document.querySelector(`td[data-address="${addr}"]`);
  if (!td) return;

  const before = snapshotState();
  const oldRaw = sheet.cells[addr]?.raw || '';
  const input = document.createElement('input');
  input.className = 'cell-edit';
  input.type = 'text';
  input.value = initial === null ? oldRaw : initial;
  input.setAttribute('aria-label', `Edit ${addr}`);
  td.textContent = '';
  td.appendChild(input);
  input.focus();
  if (initial === null) input.select();

  editing = { addr, input, before, oldRaw, finished: false };

  const finish = (direction) => finishEditing(direction);
  input.addEventListener('blur', () => finish('none'));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      finish(event.shiftKey ? 'up' : 'down');
    } else if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      finish(event.shiftKey ? 'left' : 'right');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish('cancel');
    }
  });
  window.__cellEditor = { finish };
}

function finishEditing(direction = 'none') {
  if (!editing || editing.finished) return;
  const state = editing;
  state.finished = true;
  editing = null;
  window.__cellEditor = null;

  if (direction === 'cancel') {
    renderGrid();
    return;
  }

  const sheet = sheets[activeSheet];
  if (!sheet) return;
  const value = state.input.value;
  const cell = sheet.cells[state.addr];

  if (value !== state.oldRaw) {
    recordHistory('Edit cell', state.before);
    if (!cell) sheet.cells[state.addr] = { raw: value, value: '', error: null };
    else cell.raw = value;
    if (value === '' && !sheet.cells[state.addr]?.style && !sheet.cells[state.addr]?.header) {
      delete sheet.cells[state.addr];
    } else {
      computeIntoSheet(sheet, state.addr, activeSheet);
    }
    recalculateSheet(activeSheet);
    dirty = true;
    sheet.dirty = true;
  }

  if (direction === 'down') moveSelection(1, 0);
  else if (direction === 'up') moveSelection(-1, 0);
  else if (direction === 'right') moveSelection(0, 1);
  else if (direction === 'left') moveSelection(0, -1);
  else renderGrid();
}

/*======================================================================
  Calculation
======================================================================*/

function computeIntoSheet(sheet, addr, sheetName = activeSheet) {
  const cell = sheet?.cells?.[addr];
  if (!cell) return;

  const raw = cell.raw || '';
  if (!raw.startsWith('=')) {
    cell.value = raw;
    cell.error = null;
    return;
  }

  try {
    const result = computeCell(raw, sheet.cells, new Set(), {
      sheetName,
      address: addr,
      workbook: sheets,
    });
    cell.value = result;
    cell.error = typeof result === 'string' && result.startsWith('#') ? result : null;
  } catch {
    cell.value = '#ERROR';
    cell.error = '#ERROR';
  }
}

export function computeAndCache(addr) {
  computeIntoSheet(sheets[activeSheet], addr);
}

/* Recompute every formula on a sheet. Values are resolved recursively from the
   raw cell contents, so order does not matter. Editing one cell therefore
   refreshes every dependent total in the same pass. */
export function recalculateSheet(name = activeSheet) {
  const sheet = sheets[name];
  if (!sheet) return;
  Object.keys(sheet.cells).forEach((addr) => computeIntoSheet(sheet, addr, name));
}

export function recalculateAllSheets() {
  Object.keys(sheets).forEach((name) => recalculateSheet(name));
}

export function recomputeAndRender(addr) {
  if (addr) computeAndCache(addr);
  recalculateSheet();
  renderGrid();
}

/*======================================================================
  Editing API used by app.js
======================================================================*/

export function setCellValue(addr, raw) {
  if (!sheets[activeSheet]) return null;
  if (!sheets[activeSheet].cells[addr]) sheets[activeSheet].cells[addr] = {};
  sheets[activeSheet].cells[addr].raw = raw;
  computeAndCache(addr);
  dirty = true;
  sheets[activeSheet].dirty = true;
  return sheets[activeSheet].cells[addr];
}

export function getCellValue(addr) {
  return sheets[activeSheet]?.cells[addr] || null;
}

export function ensureCell(addr) {
  if (!sheets[activeSheet]) return null;
  if (!sheets[activeSheet].cells[addr]) {
    sheets[activeSheet].cells[addr] = { raw: '', value: '', error: null };
  }
  return sheets[activeSheet].cells[addr];
}

export function getCurrentSheet() {
  return sheets[activeSheet] || null;
}

export function setSheetDirty(name, value) {
  if (sheets[name]) sheets[name].dirty = !!value;
}

export function markDirty(name = activeSheet) {
  dirty = true;
  if (sheets[name]) sheets[name].dirty = true;
}

/*======================================================================
  Formatting
======================================================================*/

export function applyStyle(patch, label = 'Format') {
  const rect = getSelectionRect();
  const sheet = sheets[activeSheet];
  if (!sheet) return;
  recordHistory(label);

  for (let r = rect.r1; r <= rect.r2; r++) {
    for (let c = rect.c1; c <= rect.c2; c++) {
      const addr = pointToAddr(c, r);
      if (!sheet.cells[addr]) sheet.cells[addr] = { raw: '', value: '', error: null };
      const cell = sheet.cells[addr];
      const style = { ...(cell.style || {}) };
      Object.entries(patch).forEach(([key, value]) => {
        if (value === null || value === undefined || value === '' || value === false) delete style[key];
        else style[key] = value;
      });
      if (Object.keys(style).length) cell.style = style;
      else delete cell.style;
      if (!cell.raw && !cell.style && !cell.header) delete sheet.cells[addr];
    }
  }
  markDirty();
  renderGrid();
}

export function selectionHasStyle(prop) {
  const rect = getSelectionRect();
  const sheet = sheets[activeSheet];
  if (!sheet) return false;
  for (let r = rect.r1; r <= rect.r2; r++) {
    for (let c = rect.c1; c <= rect.c2; c++) {
      if (!sheet.cells[pointToAddr(c, r)]?.style?.[prop]) return false;
    }
  }
  return true;
}

export function toggleStyle(prop) {
  applyStyle({ [prop]: !selectionHasStyle(prop) }, `Toggle ${prop}`);
}

export function clearFormatting() {
  const rect = getSelectionRect();
  const sheet = sheets[activeSheet];
  if (!sheet) return;
  recordHistory('Clear formatting');
  for (let r = rect.r1; r <= rect.r2; r++) {
    for (let c = rect.c1; c <= rect.c2; c++) {
      const addr = pointToAddr(c, r);
      const cell = sheet.cells[addr];
      if (!cell) continue;
      delete cell.style;
      if (!cell.raw && !cell.header) delete sheet.cells[addr];
    }
  }
  markDirty();
  renderGrid();
}

/*======================================================================
  Clear, fill, clipboard
======================================================================*/

export function clearSelection() {
  const rect = getSelectionRect();
  const sheet = sheets[activeSheet];
  if (!sheet) return;
  let changed = false;
  for (let r = rect.r1; r <= rect.r2; r++) {
    for (let c = rect.c1; c <= rect.c2; c++) {
      const addr = pointToAddr(c, r);
      const cell = sheet.cells[addr];
      if (!cell || (!cell.raw && !cell.header)) continue;
      changed = true;
      if (cell.style) {
        cell.raw = '';
        cell.value = '';
        cell.error = null;
        delete cell.header;
      } else {
        delete sheet.cells[addr];
      }
    }
  }
  if (!changed) return;
  recordHistory('Clear cells');
  recalculateSheet();
  markDirty();
  renderGrid();
}

function copyCellRecord(cell, dRow, dCol) {
  if (!cell) return null;
  return {
    raw: translateFormula(cell.raw || '', dRow, dCol),
    value: '',
    error: null,
    ...(cell.header ? { header: true } : {}),
    ...(cell.style ? { style: JSON.parse(JSON.stringify(cell.style)) } : {}),
  };
}

export function fillDown() {
  const rect = getSelectionRect();
  const sheet = sheets[activeSheet];
  if (!sheet) return;
  let sourceRow;
  if (rect.single) sourceRow = rect.r1 - 1;
  else sourceRow = rect.r1;
  if (sourceRow < 0) return;
  recordHistory('Fill down');
  for (let r = Math.max(rect.r1, sourceRow + 1); r <= rect.r2; r++) {
    for (let c = rect.c1; c <= rect.c2; c++) {
      const source = sheet.cells[pointToAddr(c, sourceRow)];
      if (!source) continue;
      sheet.cells[pointToAddr(c, r)] = copyCellRecord(source, r - sourceRow, 0);
    }
  }
  recalculateSheet();
  markDirty();
  renderGrid();
}

export function fillRight() {
  const rect = getSelectionRect();
  const sheet = sheets[activeSheet];
  if (!sheet) return;
  let sourceCol;
  if (rect.single) sourceCol = rect.c1 - 1;
  else sourceCol = rect.c1;
  if (sourceCol < 0) return;
  recordHistory('Fill right');
  for (let c = Math.max(rect.c1, sourceCol + 1); c <= rect.c2; c++) {
    for (let r = rect.r1; r <= rect.r2; r++) {
      const source = sheet.cells[pointToAddr(sourceCol, r)];
      if (!source) continue;
      sheet.cells[pointToAddr(c, r)] = copyCellRecord(source, 0, c - sourceCol);
    }
  }
  recalculateSheet();
  markDirty();
  renderGrid();
}

function parseDelimited(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === '\t') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

export function copySelection(cut = false) {
  const rect = getSelectionRect();
  const sheet = sheets[activeSheet];
  if (!sheet) return '';
  const lines = [];
  const records = [];
  for (let r = rect.r1; r <= rect.r2; r++) {
    const line = [];
    for (let c = rect.c1; c <= rect.c2; c++) {
      const addr = pointToAddr(c, r);
      const cell = sheet.cells[addr];
      line.push(cell?.raw || '');
      records.push({
        dr: r - rect.r1,
        dc: c - rect.c1,
        raw: cell?.raw || '',
        style: cell?.style ? JSON.parse(JSON.stringify(cell.style)) : null,
        header: !!cell?.header,
      });
    }
    lines.push(line.join('\t'));
  }
  const text = lines.join('\n');
  internalClipboard = { text, rows: rect.rows, cols: rect.cols, records, origin: { r: rect.r1, c: rect.c1 } };
  if (cut) clearSelection();
  return text;
}

export function cutSelection() {
  return copySelection(true);
}

export function pasteText(text, options = {}) {
  const rows = parseDelimited(text);
  if (!rows.length) return { rows: 0, cols: 0 };
  const rect = getSelectionRect();
  const sheet = sheets[activeSheet];
  if (!sheet) return { rows: 0, cols: 0 };

  const internal = options.internal && internalClipboard && internalClipboard.text === text
    ? internalClipboard
    : null;

  recordHistory('Paste');
  let pastedRows = 0;
  let pastedCols = 0;

  rows.forEach((line, rIdx) => {
    line.forEach((value, cIdx) => {
      const r = rect.r1 + rIdx;
      const c = rect.c1 + cIdx;
      if (r >= ROWS || c >= COLUMNS) return;
      const addr = pointToAddr(c, r);
      const record = internal
        ? internal.records.find((x) => x.dr === rIdx && x.dc === cIdx)
        : null;
      const raw = internal
        ? translateFormula(record?.raw ?? value, r - internal.origin.r, c - internal.origin.c)
        : value;

      if (!raw && !record?.style && !record?.header) {
        delete sheet.cells[addr];
      } else {
        sheet.cells[addr] = {
          raw,
          value: '',
          error: null,
          ...(record?.style ? { style: record.style } : {}),
          ...(record?.header ? { header: true } : {}),
        };
      }
      pastedRows = Math.max(pastedRows, rIdx + 1);
      pastedCols = Math.max(pastedCols, cIdx + 1);
    });
  });

  recalculateSheet();
  markDirty();
  selection = {
    anchor: pointToAddr(rect.c1, rect.r1),
    focus: pointToAddr(
      Math.min(COLUMNS - 1, rect.c1 + pastedCols - 1),
      Math.min(ROWS - 1, rect.r1 + pastedRows - 1),
    ),
  };
  renderGrid();
  return { rows: pastedRows, cols: pastedCols };
}

/*======================================================================
  Sort
======================================================================*/

export function detectRegion(addr = selection.focus) {
  const sheet = sheets[activeSheet];
  if (!sheet) return getSelectionRect();
  const start = addrToPoint(addr);
  const startAddr = pointToAddr(start.col, start.row);
  const startCell = sheet.cells[startAddr];
  if (!startCell || !String(startCell.raw || '').trim()) {
    return { ...getSelectionRect(), r1: start.row, r2: start.row, c1: start.col, c2: start.col, single: true, range: startAddr, start: startAddr, end: startAddr, rows: 1, cols: 1 };
  }

  const used = (p) => {
    const cell = sheet.cells[pointToAddr(p.col, p.row)];
    return !!(cell && String(cell.raw || '').trim());
  };
  const seen = new Set();
  const queue = [start];
  let minR = start.row, maxR = start.row, minC = start.col, maxC = start.col;
  while (queue.length) {
    const p = queue.pop();
    const key = `${p.row}:${p.col}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!used(p)) continue;
    minR = Math.min(minR, p.row); maxR = Math.max(maxR, p.row);
    minC = Math.min(minC, p.col); maxC = Math.max(maxC, p.col);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nr = p.row + dr;
        const nc = p.col + dc;
        if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLUMNS) continue;
        if (!seen.has(`${nr}:${nc}`)) queue.push({ row: nr, col: nc });
      }
    }
  }
  return {
    r1: minR, r2: maxR, c1: minC, c2: maxC,
    start: pointToAddr(minC, minR), end: pointToAddr(maxC, maxR),
    range: `${pointToAddr(minC, minR)}:${pointToAddr(maxC, maxR)}`,
    single: minR === maxR && minC === maxC,
    rows: maxR - minR + 1, cols: maxC - minC + 1,
  };
}

function looksLikeHeader(rect, sheet) {
  if (rect.rows < 2) return false;
  let headerText = 0;
  let dataNumeric = 0;
  for (let c = rect.c1; c <= rect.c2; c++) {
    const head = sheet.cells[pointToAddr(c, rect.r1)];
    const first = sheet.cells[pointToAddr(c, rect.r1 + 1)];
    if (head && String(head.raw || '').trim() && !/^-?[\d.,%$]+$/.test(String(head.raw).trim())) headerText++;
    const numeric = first && first.value !== '' && first.value !== null
      && Number.isFinite(Number(String(first.value).replace(/,/g, '')));
    if (numeric) dataNumeric++;
  }
  return headerText >= Math.max(1, Math.ceil(rect.cols / 2)) && dataNumeric > 0;
}

export function sortSelection(direction = 'asc') {
  const selected = getSelectionRect();
  const sheet = sheets[activeSheet];
  if (!sheet) return null;
  const rect = selected.single ? detectRegion(selection.focus) : selected;
  if (rect.rows < 2) return null;

  const keyCol = Math.max(rect.c1, Math.min(rect.c2, addrToPoint(selection.focus).col));
  const hasHeader = looksLikeHeader(rect, sheet);
  const first = rect.r1 + (hasHeader ? 1 : 0);
  if (first >= rect.r2) return null;

  const rows = [];
  for (let r = first; r <= rect.r2; r++) {
    const cells = {};
    for (let c = rect.c1; c <= rect.c2; c++) {
      const cell = sheet.cells[pointToAddr(c, r)];
      cells[c] = cell ? JSON.parse(JSON.stringify(cell)) : null;
    }
    const keyCell = sheet.cells[pointToAddr(keyCol, r)];
    const value = keyCell ? (keyCell.value ?? keyCell.raw ?? '') : '';
    rows.push({ cells, value, index: rows.length });
  }

  rows.sort((a, b) => {
    const aBlank = a.value === '' || a.value === null || a.value === undefined;
    const bBlank = b.value === '' || b.value === null || b.value === undefined;
    // Blanks stay at the bottom in either direction, as in Excel.
    if (aBlank && !bBlank) return 1;
    if (!aBlank && bBlank) return -1;
    if (aBlank && bBlank) return a.index - b.index;

    const aNum = typeof a.value === 'number' ? a.value : (a.value !== '' && !isNaN(Number(a.value)) ? Number(a.value) : null);
    const bNum = typeof b.value === 'number' ? b.value : (b.value !== '' && !isNaN(Number(b.value)) ? Number(b.value) : null);
    let cmp;
    if (aNum !== null && bNum !== null) cmp = aNum - bNum;
    else cmp = String(a.value ?? '').localeCompare(String(b.value ?? ''), undefined, { numeric: true, sensitivity: 'base' });
    if (cmp === 0) return a.index - b.index;
    return direction === 'desc' ? -cmp : cmp;
  });

  recordHistory(`Sort ${direction === 'desc' ? 'Z→A' : 'A→Z'}`);
  rows.forEach((row, offset) => {
    const targetRow = first + offset;
    for (let c = rect.c1; c <= rect.c2; c++) {
      const addr = pointToAddr(c, targetRow);
      if (row.cells[c]) sheet.cells[addr] = row.cells[c];
      else delete sheet.cells[addr];
    }
  });

  recalculateSheet();
  markDirty();
  renderGrid();
  return {
    rows: rows.length,
    header: hasHeader,
    column: colIndexToCol(keyCol),
    range: rect.range,
    direction,
  };
}

/*======================================================================
  Sheet operations
======================================================================*/

export function addSheetState(name) {
  if (!name || sheets[name]) return false;
  sheets[name] = normalizeSheet({ name, cells: {}, raw: {}, dirty: true }, name);
  return true;
}

export function renameSheetState(oldName, newName) {
  if (!sheets[oldName] || !newName || oldName === newName) return false;
  if (sheets[newName]) return false;
  const rebuilt = {};
  Object.keys(sheets).forEach((name) => {
    if (name === oldName) {
      rebuilt[newName] = normalizeSheet({ ...sheets[oldName], name: newName }, newName);
    } else {
      rebuilt[name] = sheets[name];
    }
  });
  sheets = rebuilt;
  if (activeSheet === oldName) activeSheet = newName;
  return true;
}

export function duplicateSheetState(sourceName, newName) {
  if (!sheets[sourceName] || !newName || sheets[newName]) return false;
  const copy = JSON.parse(JSON.stringify(sheets[sourceName]));
  copy.name = newName;
  copy.dirty = true;
  copy.cells = copy.cells || {};
  const rebuilt = {};
  let inserted = false;
  Object.keys(sheets).forEach((name) => {
    rebuilt[name] = sheets[name];
    if (name === sourceName) {
      rebuilt[newName] = normalizeSheet(copy, newName);
      inserted = true;
    }
  });
  if (!inserted) rebuilt[newName] = normalizeSheet(copy, newName);
  sheets = rebuilt;
  return true;
}

export function setSheetMeta(name, patch) {
  const sheet = sheets[name];
  if (!sheet) return;
  normalizeSheet(sheet, name);
  sheet.meta = { ...sheet.meta, ...patch };
  markDirty(name);
}

/*======================================================================
  Demo data
======================================================================*/

export function seedDemoData(name) {
  const s = sheets[name];
  if (!s) return;
  s.cells = {
    A1: { raw: 'Item', value: 'Item', header: true },
    B1: { raw: 'Price', value: 'Price', header: true },
    C1: { raw: 'Qty', value: 'Qty', header: true },
    D1: { raw: 'Total', value: 'Total', header: true },
    A2: { raw: 'Apples', value: 'Apples' },
    B2: { raw: '1.50', value: '1.50' },
    C2: { raw: '10', value: '10' },
    D2: { raw: '=B2*C2', value: '', error: null },
    A3: { raw: 'Bananas', value: 'Bananas' },
    B3: { raw: '0.75', value: '0.75' },
    C3: { raw: '20', value: '20' },
    D3: { raw: '=B3*C3', value: '', error: null },
    A4: { raw: 'Oranges', value: 'Oranges' },
    B4: { raw: '1.25', value: '1.25' },
    C4: { raw: '15', value: '15' },
    D4: { raw: '=B4*C4', value: '', error: null },
    A5: { raw: 'Grand Total', value: 'Grand Total' },
    B5: { raw: '', value: '' },
    C5: { raw: '', value: '' },
    D5: { raw: '=SUM(D2:D4)', value: '', error: null },
  };
  Object.keys(s.cells).forEach((addr) => computeIntoSheet(s, addr, name));
}
