/*======================================================================
  Grid Controller — SINGLE SOURCE OF TRUTH for state
  Owns: sheets, activeSheet, selectedCell, dirty
  app.js must read/write state ONLY through these exports.
======================================================================*/

import { computeCell } from './engine.js';

export const COLUMNS = 26;
export const ROWS = 100;

let sheets = {};          // name -> { name, cells, raw, dirty }
let activeSheet = 'Sheet1';
let selectedCell = 'A1';
let dirty = false;

let gridBody, colHeaders, formulaInput, cellAddressDisplay, statusText;

export function initGrid() {
  gridBody = document.getElementById('grid-body');
  colHeaders = document.getElementById('col-headers');
  formulaInput = document.getElementById('formula-input');
  cellAddressDisplay = document.getElementById('cell-address');
  statusText = document.getElementById('status-text');
}

/* ---------- State accessors (single source of truth) ---------- */

export function getSheets() { return sheets; }
export function getActiveSheet() { return activeSheet; }
export function getSelectedCell() { return selectedCell; }
export function isDirty() { return dirty; }
export function setDirty(val) { dirty = val; }

export function setSheets(newSheets) {
  sheets = newSheets || {};
}

export function setActiveSheet(name) {
  if (sheets[name]) {
    activeSheet = name;
  }
}

export function setSelectedCell(addr) {
  selectedCell = addr;
}

export function parseAddr(addr) {
  const m = String(addr).match(/^([A-Z]+)(\d+)$/i);
  if (!m) return ['A', 1];
  return [m[1].toUpperCase(), parseInt(m[2], 10)];
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

/* ---------- Tabs ---------- */

export function renderTabs() {
  const container = document.getElementById('sheet-tabs');
  if (!container) return;
  container.innerHTML = '';
  Object.keys(sheets).forEach((name) => {
    const btn = document.createElement('button');
    btn.className = `sheet-tab ${name === activeSheet ? 'active' : ''} ${sheets[name].dirty ? 'dirty' : ''}`;
    btn.dataset.sheet = name;
    btn.textContent = name;
    btn.title = name;
    btn.setAttribute('aria-pressed', String(name === activeSheet));
    btn.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('switch-sheet', { detail: name }));
    });
    container.appendChild(btn);
  });

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'sheet-tab-add';
  add.title = 'New sheet';
  add.setAttribute('aria-label', 'New sheet');
  add.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-plus"></use></svg>';
  add.addEventListener('click', () => window.promptNewSheet?.());
  container.appendChild(add);
}

/* ---------- Grid rendering ---------- */

export function renderGrid() {
  const sheet = sheets[activeSheet];
  if (!sheet) return;

  // Column headers
  colHeaders.querySelectorAll('th.col-header').forEach((el) => el.remove());
  const [activeCol, activeRow] = parseAddr(selectedCell);
  for (let c = 0; c < COLUMNS; c++) {
    const label = colIndexToCol(c);
    const th = document.createElement('th');
    th.className = 'col-header' + (label === activeCol ? ' selected' : '');
    th.textContent = label;
    colHeaders.appendChild(th);
  }

  // Rows
  gridBody.innerHTML = '';
  for (let r = 1; r <= ROWS; r++) {
    const tr = document.createElement('tr');

    const th = document.createElement('th');
    th.className = 'row-number' + (r === activeRow ? ' selected' : '');
    th.textContent = r;
    tr.appendChild(th);

    for (let c = 0; c < COLUMNS; c++) {
      const addr = colIndexToCol(c) + r;
      const cell = sheet.cells[addr] || { raw: '', value: '', error: null };
      const td = document.createElement('td');
      td.className = 'cell';
      td.dataset.address = addr;
      if (cell.header) td.classList.add('header-cell');
      if (addr === selectedCell) td.classList.add('selected');

      const raw = cell.raw || '';
      const value = cell.value !== undefined ? cell.value : '';
      const error = cell.error;

      td.title = raw || '';

      if (raw.startsWith('=')) {
        td.classList.add('formula-cell');
        td.textContent = error ? `⚠ ${error}` : value;
        if (error) td.classList.add('error-cell');
      } else {
        td.textContent = value;
      }

      if (!cell.header) {
        const text = String(value ?? '').trim();
        if (/^-?\d+(\.\d+)?$/.test(text) || /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) {
          td.classList.add('num');
        }
      }

      td.addEventListener('click', () => selectCell(addr));
      td.addEventListener('dblclick', () => startEdit(addr, td));
      tr.appendChild(td);
    }
    gridBody.appendChild(tr);
  }

  // Sync formula bar
  const activeCell = sheet.cells[selectedCell];
  cellAddressDisplay.value = selectedCell;
  formulaInput.value = activeCell ? (activeCell.raw || '') : '';
  formulaInput.placeholder = activeCell?.raw?.startsWith('=')
    ? 'Formula cell — edit formula…'
    : 'Enter value or formula…';

  scrollToSelected();
  updateStatusBar();
}

export function selectCell(addr) {
  selectedCell = addr;
  renderGrid();
}

function startEdit(addr, td) {
  td.textContent = '';
  const input = document.createElement('input');
  input.className = 'cell-edit';
  const sheet = sheets[activeSheet];
  const cell = sheet.cells[addr];
  input.value = cell ? (cell.raw || '') : '';
  input.style.width = '100%';
  input.style.padding = '0 0.4rem';
  input.style.fontSize = '0.85rem';
  input.style.border = 'none';
  input.style.outline = 'none';
  input.style.background = 'transparent';
  td.appendChild(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    const val = input.value.trim();
    if (!sheet.cells[addr]) sheet.cells[addr] = {};
    sheet.cells[addr].raw = val;
    computeAndCache(addr);
    recalculateSheet();
    dirty = true;
    if (sheets[activeSheet]) sheets[activeSheet].dirty = true;
    renderGrid();
    selectCell(addr);
  };

  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(); }
    else if (e.key === 'Escape') {
      finished = true; // cancel without saving
      renderGrid();
      selectCell(addr);
    }
  });
}

function computeIntoSheet(sheet, addr) {
  const cell = sheet?.cells?.[addr];
  if (!cell) return;

  const raw = cell.raw || '';
  if (!raw.startsWith('=')) {
    cell.value = raw;
    cell.error = null;
    return;
  }

  try {
    const result = computeCell(raw, sheet.cells, new Set());
    cell.value = result;
    cell.error = result === '#ERROR' || result === '#CYCLE' || result === '#NAME?' ||
                 result === '#DIV/0!' ? String(result) : null;
  } catch (e) {
    cell.value = '#ERROR';
    cell.error = '#ERROR';
  }
}

export function computeAndCache(addr) {
  computeIntoSheet(sheets[activeSheet], addr);
}

/* Recompute every formula on a sheet. Values are resolved recursively from the
   raw cell contents, so order does not matter. Editing one cell can therefore
   refresh every dependent total in the same pass. */
export function recalculateSheet(name = activeSheet) {
  const sheet = sheets[name];
  if (!sheet) return;
  Object.keys(sheet.cells).forEach((addr) => computeIntoSheet(sheet, addr));
}

export function recalculateAllSheets() {
  Object.keys(sheets).forEach((name) => recalculateSheet(name));
}

export function recomputeAndRender() {
  recalculateSheet();
  renderGrid();
}

function scrollToSelected() {
  const td = document.querySelector(`td[data-address="${selectedCell}"]`);
  if (td) td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function updateStatusBar() {
  if (statusText) {
    statusText.textContent = dirty ? 'Unsaved changes' : 'Ready';
    statusText.classList.toggle('unsaved', dirty);
  }
  const info = document.getElementById('cell-info');
  if (info) info.textContent = selectedCell;
}

export function moveSelection(dRow, dCol) {
  const [col, row] = parseAddr(selectedCell);
  const nc = colIndex(col) + dCol;
  const nr = row + dRow;
  selectCell(colIndexToCol(Math.max(0, Math.min(COLUMNS - 1, nc))) +
             Math.max(1, Math.min(ROWS, nr)));
}

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
  Object.keys(s.cells).forEach((addr) => {
    computeAndCache(addr);
  });
}

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
