/*======================================================================
  AI Spreadsheet — Main Application Controller
  ALL state lives in grid.js (single source of truth).
======================================================================*/

import {
  getAllSheets, saveSheet, deleteSheet,
} from './storage.js';
import {
  COLUMNS, ROWS,
  initGrid, getSheets, getActiveSheet, getSelectedCell,
  isDirty, setDirty, setActiveSheet, setSheets,
  renderTabs, renderGrid, moveSelection, moveToEdge, selectCell,
  seedDemoData, getCellValue, ensureCell, setCellValue,
  recomputeAndRender, getCurrentSheet, setSheetDirty, colIndexToCol,
  parseAddr, colIndex, recalculateSheet, recalculateAllSheets,
  getSelectionRect, selectRange, selectAll, beginEditSelected,
  captureState, recordHistory, clearHistory, undo, redo,
  canUndo, canRedo, undoLabel, redoLabel,
  applyStyle, selectionHasStyle, toggleStyle, clearFormatting,
  clearSelection, fillDown, fillRight, copySelection, cutSelection, pasteText,
  sortSelection, addSheetState, renameSheetState, duplicateSheetState,
  formatCellDisplay, markDirty,
} from './grid.js';
import {
  isAIEnabled, sendAIMessage, testConnection,
  parseAIResponse, getSheetContext, initBadge,
  setModel, getModel, getProvider, setProvider,
  addApiKey, removeApiKey, getApiKeys, keyCount, configuredProviders,
  listModels, openRouterAccount, PROVIDER_LABELS,
} from './ai.js';
import {
  renderMarkdown, renderTable, tableToCells, tableSize, tableToMarkdown,
  parseMarkdownTables, escapeHtml,
} from './markdown.js';

/*======================================================================
  UI Element references
======================================================================*/
let formulaInput, cellAddressDisplay, aiInput, aiChat, aiSidebar, toastEl;
let researchEnabled = true;
let formulaEditSnapshot = null;
let formulaEditTouched = false;
let findMatches = [];
let findMatchIndex = -1;
let findQuery = '';
let sheetMenuTarget = null;

/*======================================================================
  Initialization
======================================================================*/
document.addEventListener('DOMContentLoaded', async () => {
  try {
    initGrid();

    formulaInput = document.getElementById('formula-input');
    cellAddressDisplay = document.getElementById('cell-address');
    aiInput = document.getElementById('ai-input');
    aiChat = document.getElementById('ai-chat');
    aiSidebar = document.getElementById('ai-sidebar');
    toastEl = document.getElementById('toast');
    try { researchEnabled = localStorage.getItem('ai_web_research') !== '0'; } catch { /* ignore */ }

    updateConnectivity();

    // Restore AI key + badge
    initBadge();

    // Load sheets from IndexedDB (non-fatal if fails)
    try {
      const all = await getAllSheets();
      const mapped = {};
      all.forEach((s) => {
        mapped[s.name] = {
          name: s.name,
          cells: s.cells || {},
          raw: s.raw || {},
          dirty: s.dirty || false,
          meta: s.meta || { colWidths: {}, rowHeights: {}, freeze: { rows: 0, cols: 0 } },
        };
      });
      if (!mapped[getActiveSheet()]) {
        // Make sure we land on a sheet that exists
        const names = Object.keys(mapped);
        if (names.length) setActiveSheet(names[0]);
        else mapped[getActiveSheet()] = { name: getActiveSheet(), cells: {}, raw: {}, dirty: false };
      }
      setSheets(mapped); // replace state in grid.js wholesale
    } catch (e) {
      console.warn('Storage load failed, starting fresh', e);
      setSheets({
        [getActiveSheet()]: { name: getActiveSheet(), cells: {}, raw: {}, dirty: false },
      });
    }

    // Ensure current sheet has demo data if empty
    const cur = getCurrentSheet();
    if (cur && Object.keys(cur.cells).length === 0) {
      seedDemoData(getActiveSheet());
    }

    // Values are stored with the sheets; recompute formulas so totals always
    // reflect the raw cells that were saved (and today's date for TODAY()).
    recalculateAllSheets();

    renderTabs();
    renderGrid();
    selectCellUI('A1');

    // Event listeners
    setupFormulaBar();
    setupKeyboard();
    setupToolbar();
    setupFormatBar();
    setupFindReplace();
    setupSheetMenu();
    setupClipboard();
    setupAI();

    window.addEventListener('grid-selection', (event) => {
      updateFormatToolbar(event.detail?.cell || null);
    });
    window.addEventListener('grid-history', updateHistoryButtons);
    updateFormatToolbar(getCellValue(getSelectedCell()));
    updateHistoryButtons();

    // Auto-save: visibility change + beforeunload
    const autoSave = async () => {
      if (pendingEdit) return; // an AI write waits for Save or Discard
      if (isDirty()) {
        try { await saveAllSheets(); } catch (e) { console.warn('Auto-save failed', e); }
      }
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') autoSave();
    });
    window.addEventListener('beforeunload', autoSave);
    window.addEventListener('beforeunload', (e) => {
      if (!pendingEdit) return;
      // An undecided AI write would be lost; let the browser ask first.
      e.preventDefault();
      e.returnValue = '';
    });

    // Sheet switching from tab clicks (grid.js dispatches this)
    window.addEventListener('switch-sheet', (e) => {
      const name = e.detail;
      if (name) selectSheet(name);
    });
    window.addEventListener('new-sheet', () => promptNewSheet());
    window.addEventListener('close-sheet', (e) => {
      const name = e.detail?.name;
      if (name) closeSheetByName(name);
    });
  } catch (e) {
    console.error('Initialization failed:', e);
    showToast('App failed to load: ' + e.message, 'error');
  }
});

/*======================================================================
  Sheet Management
======================================================================*/
async function saveAllSheets(options = {}) {
  const announce = options.announce !== false;
  if (pendingEdit) {
    pendingEdit = null;
    renderEditReview();
  }
  const all = getSheets();

  // Keep IndexedDB in step with the workbook: sheets that were renamed,
  // deleted, or undone away must not survive as stale records.
  try {
    const stored = await getAllSheets();
    for (const record of stored) {
      if (!all[record.name]) await deleteSheet(record.name);
    }
  } catch (err) {
    console.warn('Could not reconcile stored sheets', err);
  }

  for (const [name, sheet] of Object.entries(all)) {
    await saveSheet(name, sheet.cells, sheet.raw, sheet.dirty, sheet.meta);
    sheet.dirty = false;
  }
  setDirty(false);
  renderTabs();
  if (announce) showToast('Saved locally', 'ok');
}

async function selectSheet(name) {
  if (!getSheets()[name]) return;
  setActiveSheet(name);
  if (formulaInput) formulaInput.value = '';
  renderTabs();
  renderGrid();
  selectCellUI('A1');
}

async function promptNewSheet() {
  const name = prompt('New sheet name:', nextSheetName());
  if (!name) return;
  const clean = name.trim();
  if (!clean) return;
  if (getSheets()[clean]) { showToast('Sheet already exists', 'error'); return; }
  recordHistory('New sheet');
  addSheetState(clean);
  await saveSheet(clean, {}, {}, true, getSheets()[clean].meta);
  renderTabs();
  selectSheet(clean);
  showToast(`Sheet "${clean}" created`, 'ok');
}

function nextSheetName() {
  let n = Object.keys(getSheets()).length + 1;
  while (getSheets()[`Sheet${n}`]) n++;
  return `Sheet${n}`;
}

async function renameSheetPrompt(name = getActiveSheet()) {
  const next = prompt('Rename sheet:', name);
  if (!next) return;
  const clean = next.trim();
  if (!clean || clean === name) return;
  if (getSheets()[clean]) { showToast('A sheet with that name already exists', 'error'); return; }
  const sheet = getSheets()[name];
  if (!sheet) return;
  recordHistory('Rename sheet');
  if (!renameSheetState(name, clean)) { showToast('Could not rename sheet', 'error'); return; }
  try {
    await deleteSheet(name);
    await saveSheet(clean, sheet.cells, sheet.raw, true, sheet.meta);
  } catch (err) {
    showToast('Rename saved in memory; local save failed: ' + err.message, 'error');
  }
  renderTabs();
  selectSheet(clean);
  showToast(`Renamed to “${clean}”`, 'ok');
}

async function duplicateSheetPrompt(name = getActiveSheet()) {
  const suggested = `${name} copy`;
  const next = prompt('Name for the copy:', suggested);
  if (!next) return;
  const clean = next.trim();
  if (!clean) return;
  if (getSheets()[clean]) { showToast('A sheet with that name already exists', 'error'); return; }
  recordHistory('Duplicate sheet');
  if (!duplicateSheetState(name, clean)) { showToast('Could not duplicate sheet', 'error'); return; }
  await saveSheet(clean, getSheets()[clean].cells, getSheets()[clean].raw, true, getSheets()[clean].meta);
  renderTabs();
  selectSheet(clean);
  showToast(`Created “${clean}”`, 'ok');
}

async function deleteCurrentSheet() {
  await closeSheetByName(getActiveSheet());
}

async function closeSheetByName(name) {
  if (Object.keys(getSheets()).length <= 1) {
    showToast('Cannot close the last sheet', 'error'); return false;
  }
  const names = Object.keys(getSheets());
  const sheet = getSheets()[name];
  if (!sheet) return false;
  const question = sheet.dirty
    ? `Close sheet "${name}"? It has unsaved changes.`
    : `Close sheet "${name}"?`;
  if (!confirm(question)) return false;
  recordHistory('Close sheet');
  try {
    await deleteSheet(name);
  } catch (err) {
    showToast('Close saved in memory; local save failed: ' + err.message, 'error');
  }
  delete getSheets()[name];
  if (getActiveSheet() === name) {
    const remaining = names.filter((n) => n !== name);
    const index = Math.max(0, names.indexOf(name));
    const next = remaining[Math.min(index, remaining.length - 1)] || remaining[0];
    selectSheet(next);
  } else {
    renderTabs();
  }
  setDirty(true);
  showToast(`Closed "${name}"`, 'ok');
  return true;
}

/*======================================================================
  Formula Bar
======================================================================*/
function setupFormulaBar() {
  formulaInput.addEventListener('focus', () => {
    formulaEditSnapshot = captureState();
    formulaEditTouched = false;
  });
  formulaInput.addEventListener('input', () => {
    if (!formulaEditTouched) {
      recordHistory('Edit formula', formulaEditSnapshot || captureState());
      formulaEditTouched = true;
    }
    const addr = getSelectedCell();
    const cell = ensureCell(addr);
    if (cell) {
      cell.raw = formulaInput.value;
      recomputeAndRender(addr);
    }
    setDirty(true);
    setSheetDirty(getActiveSheet(), true);
  });
  formulaInput.addEventListener('blur', () => {
    const addr = getSelectedCell();
    const cell = getCellValue(addr);
    if (cell && cell.raw !== formulaInput.value) {
      if (!formulaEditTouched) recordHistory('Edit formula', formulaEditSnapshot || captureState());
      cell.raw = formulaInput.value;
      recomputeAndRender(addr);
      setDirty(true);
      setSheetDirty(getActiveSheet(), true);
    }
    formulaEditSnapshot = null;
    formulaEditTouched = false;
  });
  formulaInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      formulaInput.blur();
      moveSelection(1, 0);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const cell = getCellValue(getSelectedCell());
      formulaInput.value = cell ? cell.raw : '';
      formulaEditTouched = false;
      formulaInput.blur();
    }
  });

  cellAddressDisplay.addEventListener('click', () => {
    const addr = prompt('Go to cell or range (e.g. D12 or A1:C8):', getSelectionRect().range);
    if (!addr) return;
    const clean = addr.toUpperCase().replace(/\s+/g, '');
    if (/^[A-Z]+\d+:[A-Z]+\d+$/.test(clean)) {
      const [start, end] = clean.split(':');
      selectRange(start, end);
    } else if (/^[A-Z]+\d+$/.test(clean)) {
      selectCellUI(clean);
    }
  });

  document.getElementById('btn-ai-formula').onclick = async () => {
    if (!isAIEnabled()) { showToast('Configure AI API key first', 'error'); return; }
    const desc = prompt('Describe the formula you want:');
    if (!desc) return;
    const context = getSheetContext(getActiveSheet(), getCurrentSheet().cells, getSelectedCell());
    showToast('Asking the assistant…', 'ok');
    try {
      const { text } = await sendAIMessage('Write a spreadsheet formula for: ' + desc, context, { research: false });
      const parsed = parseAIResponse(text);
      setAssistantOpen(true);
      if (parsed.type === 'write') {
        const addr = getSelectedCell();
        const value = parsed.value.startsWith('=') ? parsed.value : `=${parsed.value}`;
        const message = addAIMessage(`Formula for ${addr}.`, 'ai', {
          html: true,
          permission: cellPermission(addr, value),
        });
        message.querySelector('.ai-permit-allow')?.focus();
      } else {
        addAIMessage(parsed.text || text);
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  };
}

function selectCellUI(addr) {
  selectCell(addr);
}

/*======================================================================
  Keyboard Navigation
======================================================================*/
function isTypingTarget(el) {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
    || el.tagName === 'SELECT' || el.isContentEditable);
}

function setupKeyboard() {
  window.addEventListener('keydown', (e) => {
    const ae = document.activeElement;
    if (isTypingTarget(ae)) return;
    if (ae && ae.closest && ae.closest('dialog[open]')) return;
    // Leave Enter and the arrow keys to real controls (Save/Discard, the model
    // picker, dialog buttons) so the keyboard can operate them. Modifier
    // shortcuts still work after a toolbar button was clicked.
    const interactive = ae && ae.closest
      && ae.closest('button, a, [role="button"], [contenteditable="true"]');
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    if (!mod && interactive) return;

    if (mod) {
      const lower = key.toLowerCase();
      if (lower === 'z') {
        e.preventDefault();
        const label = e.shiftKey ? redo() : undo();
        showToast(label ? `${e.shiftKey ? 'Redid' : 'Undid'} ${label}` : 'Nothing to undo', label ? 'ok' : '');
        return;
      }
      if (lower === 'y') {
        e.preventDefault();
        const label = redo();
        showToast(label ? `Redid ${label}` : 'Nothing to redo', label ? 'ok' : '');
        return;
      }
      if (lower === 'b') { e.preventDefault(); toggleStyle('bold'); return; }
      if (lower === 'i') { e.preventDefault(); toggleStyle('italic'); return; }
      if (lower === 'u') { e.preventDefault(); toggleStyle('underline'); return; }
      if (lower === 'f') { e.preventDefault(); openFindDialog(false); return; }
      if (lower === 'h') { e.preventDefault(); openFindDialog(true); return; }
      if (lower === 'd') { e.preventDefault(); fillDown(); return; }
      if (lower === 'r') { e.preventDefault(); fillRight(); return; }
      if (lower === 'a') { e.preventDefault(); selectAll(); return; }
      if (lower === 'p') { e.preventDefault(); printSheet(); return; }
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(lower)) {
        e.preventDefault();
        const dRow = lower === 'arrowdown' ? 1 : lower === 'arrowup' ? -1 : 0;
        const dCol = lower === 'arrowright' ? 1 : lower === 'arrowleft' ? -1 : 0;
        moveToEdge(dRow, dCol, e.shiftKey);
        return;
      }
    }

    if (key === 'F2') {
      e.preventDefault();
      beginEditSelected(null);
      return;
    }
    if (key === 'Delete' || key === 'Backspace') {
      e.preventDefault();
      clearSelection();
      return;
    }
    if (key === 'Escape') {
      selectCell(getSelectedCell());
      return;
    }

    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter', 'PageUp', 'PageDown', 'Home'].includes(key)) {
      e.preventDefault();
      if (key === 'Home') {
        if (mod) selectCell('A1');
        else {
          const [, row] = parseAddr(getSelectedCell());
          selectCell('A' + row);
        }
        return;
      }
      const page = key === 'PageUp' ? -20 : key === 'PageDown' ? 20 : 0;
      const dRow = (key === 'ArrowDown' || key === 'Enter' || key === 'PageDown') ? 1
        : (key === 'ArrowUp' || key === 'PageUp') ? -1 : 0;
      const dCol = key === 'ArrowRight' || (key === 'Tab' && !e.shiftKey) ? 1
        : key === 'ArrowLeft' || (key === 'Tab' && e.shiftKey) ? -1 : 0;
      const extend = e.shiftKey && key !== 'Tab' && key !== 'Enter';
      if (page) moveSelection(page, 0, extend);
      else moveSelection(dRow, dCol, extend);
      return;
    }

    // Typing on the grid starts an edit exactly like a desktop spreadsheet.
    if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      beginEditSelected(key);
    }
  });
}

/*======================================================================
  Format bar, clipboard, find, sheet menu, print
======================================================================*/

function updateHistoryButtons() {
  const undoBtn = document.getElementById('btn-undo');
  const redoBtn = document.getElementById('btn-redo');
  if (undoBtn) {
    undoBtn.disabled = !canUndo();
    undoBtn.title = canUndo() ? `Undo ${undoLabel()} (Ctrl+Z)` : 'Nothing to undo';
  }
  if (redoBtn) {
    redoBtn.disabled = !canRedo();
    redoBtn.title = canRedo() ? `Redo ${redoLabel()} (Ctrl+Y)` : 'Nothing to redo';
  }
}

function updateFormatToolbar(cell) {
  const style = cell?.style || {};
  const setPressed = (id, on) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('active', !!on);
    el.setAttribute('aria-pressed', String(!!on));
  };
  setPressed('fmt-bold', style.bold);
  setPressed('fmt-italic', style.italic);
  setPressed('fmt-underline', style.underline);
  setPressed('fmt-strike', style.strike);
  setPressed('fmt-align-left', style.align === 'left');
  setPressed('fmt-align-center', style.align === 'center');
  setPressed('fmt-align-right', style.align === 'right');

  const number = document.getElementById('fmt-number');
  if (number) number.value = style.numFmt || 'general';
  const textColor = document.getElementById('fmt-text-color');
  if (textColor) textColor.value = style.color || '#17231d';
  const fillColor = document.getElementById('fmt-fill-color');
  if (fillColor) fillColor.value = style.fill || '#e5efe7';
  updateHistoryButtons();
}

function setupFormatBar() {
  document.getElementById('btn-undo').onclick = () => {
    const label = undo();
    showToast(label ? `Undid ${label}` : 'Nothing to undo', label ? 'ok' : '');
  };
  document.getElementById('btn-redo').onclick = () => {
    const label = redo();
    showToast(label ? `Redid ${label}` : 'Nothing to redo', label ? 'ok' : '');
  };

  document.getElementById('fmt-bold').onclick = () => toggleStyle('bold');
  document.getElementById('fmt-italic').onclick = () => toggleStyle('italic');
  document.getElementById('fmt-underline').onclick = () => toggleStyle('underline');
  document.getElementById('fmt-strike').onclick = () => toggleStyle('strike');

  const align = (value) => {
    const active = selectionHasStyle('align') && getCellValue(getSelectedCell())?.style?.align === value;
    applyStyle({ align: active ? null : value }, 'Align');
  };
  document.getElementById('fmt-align-left').onclick = () => align('left');
  document.getElementById('fmt-align-center').onclick = () => align('center');
  document.getElementById('fmt-align-right').onclick = () => align('right');

  document.getElementById('fmt-number').onchange = (event) => {
    applyStyle({ numFmt: event.target.value === 'general' ? null : event.target.value }, 'Number format');
  };
  document.getElementById('fmt-text-color').onchange = (event) => {
    applyStyle({ color: event.target.value }, 'Text colour');
  };
  document.getElementById('fmt-fill-color').onchange = (event) => {
    applyStyle({ fill: event.target.value }, 'Fill colour');
  };
  document.getElementById('btn-clear-format').onclick = () => {
    clearFormatting();
    showToast('Formatting cleared', 'ok');
  };

  document.getElementById('btn-find').onclick = () => openFindDialog(false);
  document.getElementById('btn-sort-asc').onclick = () => runSort('asc');
  document.getElementById('btn-sort-desc').onclick = () => runSort('desc');
  document.getElementById('btn-print').onclick = printSheet;
}

function runSort(direction) {
  const result = sortSelection(direction);
  if (!result) {
    showToast('Select at least two rows to sort', 'error');
    return;
  }
  showToast(`Sorted ${result.column} ${direction === 'desc' ? 'Z→A' : 'A→Z'} over ${result.range}`, 'ok');
}

function setupClipboard() {
  const allowed = (event) => {
    if (isTypingTarget(document.activeElement)) return false;
    if (event.target.closest && event.target.closest('input, textarea, [contenteditable="true"]')) return false;
    const selectedText = window.getSelection ? String(window.getSelection()) : '';
    if (selectedText) return false;
    return true;
  };

  document.addEventListener('copy', (event) => {
    if (!allowed(event)) return;
    const text = copySelection(false);
    if (!text) return;
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
    const rect = getSelectionRect();
    showToast(`Copied ${rect.range}`, 'ok');
  });

  document.addEventListener('cut', (event) => {
    if (!allowed(event)) return;
    const text = cutSelection();
    if (!text) return;
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
    showToast('Cut to clipboard', 'ok');
  });

  document.addEventListener('paste', (event) => {
    if (!allowed(event)) return;
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    const result = pasteText(text, { internal: true });
    showToast(`Pasted ${result.rows} × ${result.cols}`, 'ok');
  });
}

/* ---------- Find and replace ---------- */

function openFindDialog(replace = false) {
  const dialog = document.getElementById('find-dialog');
  if (!dialog) return;
  if (!dialog.open) dialog.show();
  const query = document.getElementById('find-input');
  if (!query.value) {
    const current = getCellValue(getSelectedCell());
    if (current?.raw && current.raw.length < 80 && !current.raw.startsWith('=')) query.value = current.raw;
  }
  query.focus();
  query.select();
  if (replace) document.getElementById('replace-input').focus();
  refreshFindMatches();
}

function refreshFindMatches() {
  const query = document.getElementById('find-input')?.value || '';
  const caseSensitive = document.getElementById('find-case')?.checked;
  if (!query) {
    findMatches = [];
    findMatchIndex = -1;
    findQuery = '';
    updateFindStatus();
    return;
  }
  if (query === findQuery && findMatches.length) {
    updateFindStatus();
    return;
  }
  findQuery = query;
  const sheet = getCurrentSheet();
  const needle = caseSensitive ? query : query.toLowerCase();
  findMatches = [];
  if (sheet) {
    Object.entries(sheet.cells).forEach(([addr, cell]) => {
      const raw = String(cell.raw || '');
      if (!raw) return;
      const hay = caseSensitive ? raw : raw.toLowerCase();
      if (hay.includes(needle)) findMatches.push(addr);
    });
  }
  findMatches.sort((a, b) => {
    const [ac, ar] = parseAddr(a);
    const [bc, br] = parseAddr(b);
    return ar - br || colIndex(ac) - colIndex(bc);
  });
  findMatchIndex = -1;
  updateFindStatus();
}

function updateFindStatus(message = '') {
  const status = document.getElementById('find-status');
  if (!status) return;
  if (message) { status.textContent = message; return; }
  if (!document.getElementById('find-input')?.value) {
    status.textContent = 'Type a value or formula to search.';
    return;
  }
  if (!findMatches.length) {
    status.textContent = 'No matches on this sheet.';
    return;
  }
  const current = findMatchIndex >= 0 ? `${findMatchIndex + 1} of ${findMatches.length}` : `${findMatches.length} match${findMatches.length === 1 ? '' : 'es'}`;
  status.textContent = `${current}${findMatchIndex >= 0 ? ` · ${findMatches[findMatchIndex]}` : ''}`;
}

function findNext(direction = 1) {
  refreshFindMatches();
  if (!findMatches.length) { updateFindStatus(); return; }
  const selected = getSelectedCell();
  const current = findMatches.indexOf(selected);
  if (current >= 0) {
    findMatchIndex = (current + direction + findMatches.length) % findMatches.length;
  } else {
    findMatchIndex = direction > 0 ? 0 : findMatches.length - 1;
  }
  selectCellUI(findMatches[findMatchIndex]);
  updateFindStatus();
}

function replaceCurrent() {
  findNext(1);
  if (findMatchIndex < 0) return;
  const addr = findMatches[findMatchIndex];
  const cell = getCellValue(addr);
  const query = document.getElementById('find-input')?.value || '';
  if (!cell || !query) return;
  const caseSensitive = document.getElementById('find-case')?.checked;
  const flags = caseSensitive ? 'g' : 'gi';
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  const replacement = document.getElementById('replace-input')?.value || '';
  const next = String(cell.raw || '').replace(pattern, replacement);
  if (next === cell.raw) return;
  recordHistory('Replace');
  cell.raw = next;
  recomputeAndRender(addr);
  markDirty();
  refreshFindMatches();
  updateFindStatus(`Replaced in ${addr}.`);
}

function replaceAll() {
  const query = document.getElementById('find-input')?.value || '';
  if (!query) return;
  const caseSensitive = document.getElementById('find-case')?.checked;
  const flags = caseSensitive ? 'g' : 'gi';
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  const replacement = document.getElementById('replace-input')?.value || '';
  const sheet = getCurrentSheet();
  if (!sheet) return;
  const targets = Object.entries(sheet.cells).filter(([, cell]) => pattern.test(String(cell.raw || '')));
  pattern.lastIndex = 0;
  if (!targets.length) { updateFindStatus('No matches on this sheet.'); return; }
  recordHistory('Replace all');
  targets.forEach(([, cell]) => {
    cell.raw = String(cell.raw || '').replace(pattern, replacement);
  });
  recalculateSheet();
  markDirty();
  renderGrid();
  findMatches = [];
  findQuery = '';
  refreshFindMatches();
  updateFindStatus(`Replaced in ${targets.length} cell${targets.length === 1 ? '' : 's'}.`);
}

function setupFindReplace() {
  const dialog = document.getElementById('find-dialog');
  const input = document.getElementById('find-input');
  const replace = document.getElementById('replace-input');
  if (!dialog || !input) return;
  input.addEventListener('input', () => {
    findQuery = '';
    findMatches = [];
    findMatchIndex = -1;
    refreshFindMatches();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      findNext(event.shiftKey ? -1 : 1);
    }
  });
  replace.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); replaceCurrent(); }
  });
  document.getElementById('btn-find-next').onclick = () => findNext(1);
  document.getElementById('btn-find-prev').onclick = () => findNext(-1);
  document.getElementById('btn-replace').onclick = replaceCurrent;
  document.getElementById('btn-replace-all').onclick = replaceAll;
  dialog.addEventListener('close', () => { findMatches = []; findQuery = ''; });
}

/* ---------- Sheet menu ---------- */

function setupSheetMenu() {
  const menu = document.getElementById('sheet-menu');
  if (!menu) return;
  window.addEventListener('sheet-context', (event) => {
    sheetMenuTarget = event.detail.name;
    menu.hidden = false;
    const width = 190;
    const height = 108;
    menu.style.left = `${Math.min(event.detail.x, window.innerWidth - width - 8)}px`;
    menu.style.top = `${Math.min(event.detail.y, window.innerHeight - height - 8)}px`;
    menu.querySelector('button')?.focus();
  });
  window.addEventListener('rename-sheet', (event) => renameSheetPrompt(event.detail.name));
  menu.addEventListener('click', async (event) => {
    const action = event.target.closest('button')?.dataset.sheetAction;
    if (!action) return;
    const target = sheetMenuTarget;
    menu.hidden = true;
    if (action === 'rename') await renameSheetPrompt(target);
    else if (action === 'duplicate') await duplicateSheetPrompt(target);
    else if (action === 'close') await closeSheetByName(target);
  });
  document.addEventListener('click', (event) => {
    if (!menu.hidden && !menu.contains(event.target)) menu.hidden = true;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) { menu.hidden = true; menu.blur(); }
  });
}

/* ---------- Print ---------- */

function usedRange() {
  const sheet = getCurrentSheet();
  if (!sheet) return null;
  let minR = ROWS, maxR = 0, minC = COLUMNS, maxC = 0;
  Object.entries(sheet.cells).forEach(([addr, cell]) => {
    if (!String(cell.raw || '').trim() && !cell.style) return;
    const [col, row] = parseAddr(addr);
    const c = colIndex(col);
    minR = Math.min(minR, row); maxR = Math.max(maxR, row);
    minC = Math.min(minC, c); maxC = Math.max(maxC, c);
  });
  if (maxR === 0) return null;
  return { minR, maxR, minC, maxC };
}

function printSheet() {
  const sheet = getCurrentSheet();
  const range = usedRange();
  if (!sheet || !range) { showToast('Nothing to print', 'error'); return; }
  const win = window.open('', '_blank', 'width=1100,height=800');
  if (!win) { showToast('Allow pop-ups to print or save as PDF', 'error'); return; }

  const styleBits = (cell) => {
    const style = cell?.style || {};
    const parts = [];
    if (style.bold) parts.push('font-weight:700');
    if (style.italic) parts.push('font-style:italic');
    if (style.underline || style.strike) parts.push(`text-decoration:${[style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(Boolean).join(' ')}`);
    if (style.color) parts.push(`color:${style.color}`);
    if (style.fill) parts.push(`background:${style.fill}`);
    if (style.align) parts.push(`text-align:${style.align}`);
    else if (typeof cell?.value === 'number') parts.push('text-align:right');
    return parts.join(';');
  };

  const head = [];
  head.push('<th class="corner"></th>');
  for (let c = range.minC; c <= range.maxC; c++) head.push(`<th>${colIndexToCol(c)}</th>`);
  const body = [];
  for (let r = range.minR; r <= range.maxR; r++) {
    const row = [`<th class="row">${r}</th>`];
    for (let c = range.minC; c <= range.maxC; c++) {
      const addr = colIndexToCol(c) + r;
      const cell = sheet.cells[addr];
      const text = cell ? formatCellDisplay(cell.value ?? cell.raw ?? '', cell.style || {}, cell) : '';
      row.push(`<td style="${styleBits(cell)}">${escapeHtml(text)}</td>`);
    }
    body.push(`<tr>${row.join('')}</tr>`);
  }

  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(getActiveSheet())}</title>
    <style>
      @page { size: A4 landscape; margin: 12mm; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:#17231d; }
      h1 { font-size: 16px; margin: 0 0 2px; }
      p { color:#5c6960; font-size: 11px; margin: 0 0 12px; }
      table { border-collapse: collapse; font-size: 10px; }
      th, td { border: 1px solid #c8d2c8; padding: 4px 6px; white-space: nowrap; }
      th { background: #e5efe7; color:#0c3b2b; font-weight: 600; }
      th.row, th.corner { background:#edf1e9; color:#5c6960; font-weight: 500; }
      tr { break-inside: avoid; }
    </style></head><body>
    <h1>${escapeHtml(getActiveSheet())}</h1>
    <p>Printed ${new Date().toLocaleString()} · ${range.minR}–${range.maxR} rows</p>
    <table><thead><tr>${head.join('')}</tr></thead><tbody>${body.join('')}</tbody></table>
    </body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
}

/*======================================================================
  Toolbar
======================================================================*/
function setupToolbar() {
  document.getElementById('btn-new-sheet').onclick = promptNewSheet;
  document.getElementById('btn-save').onclick = saveAllSheets;
  document.getElementById('btn-edit-save').onclick = savePendingEdit;
  document.getElementById('btn-edit-discard').onclick = discardPendingEdit;
  document.getElementById('btn-export-xlsx').onclick = exportXLSX;
  document.getElementById('btn-export-csv').onclick = exportCSV;
  document.getElementById('btn-import').onclick = () => document.getElementById('file-input').click();
  document.getElementById('file-input').onchange = handleImport;
  document.getElementById('btn-clear').onclick = () => {
    if (confirm('Clear entire sheet? Formatting goes too.')) {
      recordHistory('Clear sheet');
      getCurrentSheet().cells = {};
      setSheetDirty(getActiveSheet(), true);
      setDirty(true);
      renderGrid();
      showToast('Sheet cleared', 'ok');
    }
  };
  document.getElementById('btn-ai-toggle').onclick = () => setAssistantOpen(!aiSidebar.classList.contains('open'));
  document.getElementById('btn-ai-close').onclick = () => setAssistantOpen(false);
  document.addEventListener('keydown', (e) => {
    const dialog = document.getElementById('ai-settings-dialog');
    if (e.key === 'Escape' && aiSidebar.classList.contains('open') && !dialog.open) {
      setAssistantOpen(false);
    }
  });
  document.getElementById('btn-ai-test').onclick = async () => {
    const provider = document.getElementById('ai-provider').value;
    setProvider(provider);

    const pending = document.getElementById('ai-api-key').value.trim();
    if (pending) {
      addApiKey(pending, provider);
      document.getElementById('ai-api-key').value = '';
      renderKeyList(provider);
      updateModelOptions(provider);
      invalidateModelCache();
      refreshModelPicker();
    }

    const model = document.getElementById('ai-model').value.trim();
    if (model) setModel(model); else setModel(''); // falls back to per-provider default

    if (!configuredProviders().length) {
      showToast('Add at least one API key first', 'error');
      return;
    }

    showToast('Testing every saved key…', 'ok');
    try {
      const result = await testConnection();
      showToast(`Connected — ${result.ok} of ${result.total} keys answered`, 'ok');
    } catch (err) {
      showToast('No key worked: ' + String(err.message).slice(0, 220), 'error');
    }
  };
  document.getElementById('btn-ai-settings').onclick = () => {
    const dlg = document.getElementById('ai-settings-dialog');
    const provider = getProvider();
    document.getElementById('ai-provider').value = provider;
    document.getElementById('ai-api-key').value = '';
    document.getElementById('ai-api-key').placeholder = providerKeyPlaceholder(provider);
    document.getElementById('ai-model').value = getModel();
    document.getElementById('ai-model').placeholder = providerModelPlaceholder(provider);
    renderKeyList(provider);
    updateModelOptions(provider);
    dlg.showModal();
  };
  const apiStatus = document.getElementById('api-status');
  if (apiStatus) apiStatus.onclick = () => document.getElementById('btn-ai-settings').click();
  // Switching provider swaps in that provider's saved keys and model
  document.getElementById('ai-provider').onchange = () => {
    const p = document.getElementById('ai-provider').value;
    setProvider(p);
    const keyField = document.getElementById('ai-api-key');
    keyField.value = '';
    keyField.placeholder = providerKeyPlaceholder(p);
    const modelField = document.getElementById('ai-model');
    modelField.value = getModel();
    modelField.placeholder = providerModelPlaceholder(p);
    renderKeyList(p);
    updateModelOptions(p);
    invalidateModelCache();
    refreshModelPicker();
  };

  const keyField = document.getElementById('ai-api-key');
  const addKeyFromField = () => {
    const provider = document.getElementById('ai-provider').value;
    if (!keyField.value.trim()) { showToast('Paste a key first', 'error'); return; }
    const keys = addApiKey(keyField.value, provider);
    keyField.value = '';
    renderKeyList(provider);
    updateModelOptions(provider);
    invalidateModelCache();
    refreshModelPicker();
    showToast(`${keys.length} key${keys.length === 1 ? '' : 's'} saved for ${PROVIDER_LABELS[provider]}`, 'ok');
  };
  document.getElementById('btn-ai-add-key').onclick = addKeyFromField;
  keyField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addKeyFromField(); }
  });
}

function setAssistantOpen(open) {
  if (!aiSidebar) return;
  aiSidebar.classList.toggle('open', open);
  document.getElementById('btn-ai-toggle').setAttribute('aria-expanded', String(open));
  if (open) {
    refreshModelPicker();
    aiInput.focus();
  } else {
    closeModelMenu();
    document.getElementById('btn-ai-toggle').focus();
  }
}

function providerKeyPlaceholder(provider) {
  if (provider === 'groq') return 'gsk_... (Groq — free at console.groq.com/keys)';
  if (provider === 'gemini') return 'AIza... (Gemini)';
  return 'sk-or-... (OpenRouter)';
}

function providerModelPlaceholder(provider) {
  if (provider === 'groq') return 'openai/gpt-oss-120b (default)';
  if (provider === 'gemini') return 'gemini-3.8-flash (default)';
  return 'thinkingmachines/inkling-2-small:free (default)';
}

function providerDefaultModel(provider) {
  return providerModelPlaceholder(provider).replace(/\s*\(default\)$/, '');
}

function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n === 0 || n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

// Populate the model datalist from the provider's own model endpoint, so a
// client sees exactly what their key can use instead of typing a name blindly.
let modelDiscoverySeq = 0;

async function updateModelOptions(provider) {
  const datalist = document.getElementById('ai-model-options');
  const hint = document.getElementById('ai-model-hint');
  if (!datalist || !hint) return;

  // A late response for a provider the user already moved away from is dropped.
  const seq = ++modelDiscoverySeq;
  datalist.innerHTML = '';
  hint.classList.remove('form-hint-error');

  const fallback = providerDefaultModel(provider);
  const keys = getApiKeys(provider);
  if (!keys.length) {
    hint.textContent = `Add a key to see the models it can use. Leave blank for ${fallback}.`;
    return;
  }

  hint.textContent = `Reading ${PROVIDER_LABELS[provider] || provider} models…`;
  try {
    const models = await listModels(provider, keys[0]);
    if (seq !== modelDiscoverySeq) return;

    datalist.innerHTML = '';
    models.forEach((entry) => {
      const option = document.createElement('option');
      option.value = entry.id;
      const bits = [];
      if (entry.name && entry.name !== entry.id) bits.push(entry.name);
      if (entry.free === true) bits.push('free');
      option.textContent = bits.join(' · ');
      datalist.appendChild(option);
    });

    const freeCount = models.filter((entry) => entry.free === true).length;

    if (provider === 'openrouter') {
      const bits = [];
      try {
        const account = await openRouterAccount(keys[0]);
        if (seq !== modelDiscoverySeq) return;
        if (account.freeRequests?.limit != null) {
          const left = account.freeRequests.remaining;
          bits.push(`${left ?? '?'} of ${account.freeRequests.limit} free requests left today`);
        }
        if (account.limitRemaining != null) {
          const credit = formatUsd(account.limitRemaining);
          bits.push(Number(account.limitRemaining) > 0 ? `${credit} credit left` : 'no credit');
        }
      } catch (err) {
        // Credits are a bonus hint; the model list is the useful part.
      }
      const state = bits.length ? ` · ${bits.join(' · ')}` : '';
      hint.textContent = `${models.length} models · ${freeCount} free${state}. Free models cost $0 — leave blank for ${fallback}.`;
    } else if (provider === 'gemini') {
      hint.textContent = `${models.length} models can answer with this key. Free-tier limits are set by the key's Google project. Leave blank for ${fallback}.`;
    } else {
      hint.textContent = `${models.length} models on this key, all free-tier. Leave blank for ${fallback}.`;
    }
  } catch (err) {
    if (seq !== modelDiscoverySeq) return;
    hint.textContent = `Could not list models (${String(err.message).slice(0, 110)}). Leave blank to use ${fallback}.`;
    hint.classList.add('form-hint-error');
  }
}

function maskKey(key) {
  const value = String(key || '');
  if (value.length <= 10) return '••••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function renderKeyList(provider) {
  const list = document.getElementById('ai-key-list');
  const count = document.getElementById('ai-key-count');
  if (!list) return;

  const keys = getApiKeys(provider);
  if (count) count.textContent = keys.length ? `${keys.length} saved` : '';

  if (!keys.length) {
    list.innerHTML = `<p class="key-empty">No ${escapeHtml(PROVIDER_LABELS[provider] || provider)} keys saved yet.</p>`;
    return;
  }

  list.innerHTML = '';
  keys.forEach((key, index) => {
    const row = document.createElement('div');
    row.className = 'key-row';

    const code = document.createElement('code');
    code.textContent = maskKey(key);
    code.title = 'Saved key (hidden)';

    const tag = document.createElement('span');
    tag.className = 'key-tag';
    tag.textContent = index === 0 ? 'First' : `#${index + 1}`;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'key-remove';
    remove.textContent = '×';
    remove.title = 'Remove this key';
    remove.setAttribute('aria-label', `Remove key ${index + 1} for ${PROVIDER_LABELS[provider] || provider}`);
    remove.addEventListener('click', () => {
      removeApiKey(index, provider);
      renderKeyList(provider);
      updateModelOptions(provider);
      invalidateModelCache();
      refreshModelPicker();
      showToast('Key removed', 'ok');
    });

    row.append(code, tag, remove);
    list.appendChild(row);
  });
}

async function exportXLSX() {
  const XLSX = window.XLSX;
  if (!XLSX) { showToast('SheetJS not loaded', 'error'); return; }

  const wb = XLSX.utils.book_new();
  Object.entries(getSheets()).forEach(([name, sheet]) => {
    const data = [['', ...Array.from({ length: COLUMNS }, (_, i) => colIndexToCol(i))]];
    for (let r = 1; r <= ROWS; r++) {
      data.push([r, ...Array.from({ length: COLUMNS }, (_, c) => {
        const cell = sheet.cells[colIndexToCol(c) + r];
        return cell ? (cell.raw || '') : '';
      })]);
    }
    const ws = XLSX.utils.aoa_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  });
  XLSX.writeFile(wb, `spreadsheet_${new Date().toISOString().slice(0,10)}.xlsx`);
  showToast('Exported to Excel', 'ok');
}

async function exportCSV() {
  const sheet = getCurrentSheet();
  if (!sheet) { showToast('No active sheet', 'error'); return; }
  const lines = [['', ...Array.from({ length: COLUMNS }, (_, i) => colIndexToCol(i))].join(',')];
  for (let r = 1; r <= ROWS; r++) {
    const row = [r];
    for (let c = 0; c < COLUMNS; c++) {
      const cell = sheet.cells[colIndexToCol(c) + r];
      row.push(cell ? `"${(cell.raw || '').replace(/"/g, '""')}"` : '');
    }
    lines.push(row.join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `spreadsheet_${getActiveSheet()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Exported to CSV', 'ok');
}

/* Minimal RFC-4180 CSV reader: quoted fields, doubled quotes, embedded commas
   and newlines, CRLF or LF, optional BOM. Used for .csv imports so they keep
   working when the SheetJS CDN script is unavailable (offline or blocked). */
function parseCSV(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/* Replace the active sheet with a parsed grid.
   Two layouts are accepted:
   1. This app's own export — first row is a column map: "", "A", "B", …
   2. A normal CSV/XLSX — first row is a header row written into A1, B1, … */
function applyImportedRows(json) {
  if (!json.length) { showToast('Empty sheet', 'error'); return false; }

  const firstRow = json[0] || [];
  const isColumnMap = firstRow.length > 1
    && !String(firstRow[0] ?? '').trim()
    && firstRow.slice(1).every((v) => !String(v ?? '').trim() || /^[A-Z]+$/i.test(String(v).trim()));

  const headers = firstRow;
  getCurrentSheet().cells = {};
  json.forEach((row, rIdx) => {
    if (isColumnMap && rIdx === 0) return;
    const r = isColumnMap ? rIdx : rIdx + 1;

    row.forEach((val, cIdx) => {
      if (val === undefined || val === null || val === '') return;

      let addr;
      if (isColumnMap) {
        const m = String(headers[cIdx] ?? '').match(/^([A-Z]+)$/i);
        if (!m) return;
        addr = m[1].toUpperCase() + r;
      } else {
        if (cIdx >= COLUMNS) return;
        addr = colIndexToCol(cIdx) + r;
      }

      getCurrentSheet().cells[addr] = { raw: String(val), value: String(val), error: null };
    });
  });
  setSheetDirty(getActiveSheet(), true);
  setDirty(true);
  recalculateSheet(getActiveSheet());
  renderGrid();
  showToast(`Imported ${json.length - 1} rows`, 'ok');
  return true;
}

async function handleImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  const current = getCurrentSheet();
  const occupied = current && Object.keys(current.cells || {})
    .some((addr) => String(current.cells[addr]?.raw || '').trim());
  if (occupied && !confirm(
    `Import “${file.name}” into “${getActiveSheet()}”?\n\nThis replaces everything already in this sheet.`
  )) {
    return;
  }

  const isCSV = /\.csv$/i.test(file.name) || file.type === 'text/csv';
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      let json;
      if (isCSV) {
        json = parseCSV(ev.target.result);
      } else {
        const XLSX = window.XLSX;
        if (!XLSX) {
          showToast('Excel import needs SheetJS — connect once, then retry', 'error');
          return;
        }
        const wb = XLSX.read(new Uint8Array(ev.target.result), { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        json = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
      }
      applyImportedRows(json);
    } catch (err) {
      showToast('Import failed: ' + err.message, 'error');
    }
  };
  if (isCSV) reader.readAsText(file);
  else reader.readAsArrayBuffer(file);
}

/*======================================================================
  AI Assistant
======================================================================*/
function setupAI() {
  aiInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      await handleAIMessage();
    }
  });
  document.getElementById('btn-ai-send').onclick = handleAIMessage;

  const toggle = document.getElementById('btn-ai-research');
  if (toggle) {
    updateResearchToggle();
    toggle.onclick = () => {
      researchEnabled = !researchEnabled;
      try { localStorage.setItem('ai_web_research', researchEnabled ? '1' : '0'); } catch { /* ignore */ }
      updateResearchToggle();
      showToast(
        researchEnabled
          ? 'Web research on — answers cite live sources'
          : 'Web research off — answers use this sheet and the model',
        'ok'
      );
    };
  }

  setupModelPicker();
}

function updateResearchToggle() {
  const btn = document.getElementById('btn-ai-research');
  if (!btn) return;
  btn.classList.toggle('active', researchEnabled);
  btn.setAttribute('aria-pressed', String(researchEnabled));
  btn.textContent = researchEnabled ? 'Web research on' : 'Web research off';
  btn.title = researchEnabled
    ? 'The AI searches the web and cites sources before answering'
    : 'The AI answers without web search';
}

/*======================================================================
  Model picker in the assistant margin
  The list comes from the provider's own model endpoint, so it only shows
  models the saved key can actually use. Free models are listed first.
=====================================================================*/

let modelMenuItems = null;
let modelMenuProvider = null;
let modelMenuError = '';
let modelMenuLoading = false;

function shortModelId(id) {
  return String(id || '').replace(/^[a-z0-9][a-z0-9-]*\//i, '');
}

function invalidateModelCache() {
  modelMenuItems = null;
  modelMenuProvider = null;
  modelMenuError = '';
  modelMenuLoading = false;
}

function refreshModelPicker() {
  const current = document.getElementById('ai-model-current');
  const btn = document.getElementById('btn-ai-model');
  if (!current || !btn) return;

  const provider = getProvider();
  const label = PROVIDER_LABELS[provider] || provider;

  if (!getApiKeys(provider).length) {
    current.textContent = `No ${label} key`;
    btn.title = `Add a ${label} key to choose a model`;
    return;
  }

  const id = getModel();
  current.textContent = `${label} · ${shortModelId(id)}`;
  btn.title = `${label} · ${id} — click to change`;
}

function closeModelMenu() {
  const menu = document.getElementById('ai-model-menu');
  const btn = document.getElementById('btn-ai-model');
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function emptyNote(text) {
  const el = document.createElement('p');
  el.className = 'ai-model-empty';
  el.textContent = text;
  return el;
}

function groupLabel(text) {
  const el = document.createElement('p');
  el.className = 'ai-model-group';
  el.textContent = text;
  return el;
}

function optionRow(label, id, { free = false, selected = false } = {}) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'ai-model-option';
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(Boolean(selected)));
  row.title = id || 'Provider default';

  const name = document.createElement('span');
  name.className = 'ai-model-name';
  name.textContent = label;
  row.appendChild(name);

  if (free) {
    const tag = document.createElement('span');
    tag.className = 'ai-model-tag';
    tag.textContent = 'Free';
    row.appendChild(tag);
  }

  row.addEventListener('click', () => chooseModel(id));
  return row;
}

function renderModelList(query) {
  const list = document.getElementById('ai-model-list');
  const note = document.getElementById('ai-model-note');
  if (!list) return;

  const provider = getProvider();
  const q = String(query || '').trim().toLowerCase();
  list.replaceChildren();

  if (!getApiKeys(provider).length) {
    list.appendChild(emptyNote(`No ${PROVIDER_LABELS[provider] || provider} key saved yet. Add one under “Manage keys”.`));
    if (note) note.textContent = 'A key is needed to list models';
    return;
  }
  if (modelMenuLoading) {
    list.appendChild(emptyNote('Reading models…'));
    if (note) note.textContent = 'Checking what this key can use…';
    return;
  }
  if (modelMenuError) {
    list.appendChild(emptyNote(modelMenuError));
    if (note) note.textContent = 'Check the key under “Manage keys”';
    return;
  }

  const items = modelMenuItems || [];
  const match = (m) => !q
    || m.id.toLowerCase().includes(q)
    || String(m.name || '').toLowerCase().includes(q);

  const free = items.filter((m) => m.free === true && match(m));
  const rest = items.filter((m) => m.free !== true && match(m));
  const current = getModel();
  const defaultId = providerDefaultModel(provider);
  const onDefault = current === defaultId;

  if (!q) {
    list.appendChild(groupLabel('Default'));
    list.appendChild(optionRow(
      `Provider default · ${shortModelId(defaultId)}`,
      '',
      { selected: onDefault }
    ));
  }

  if (free.length) {
    list.appendChild(groupLabel(`Free models · ${free.length}`));
    free.slice(0, 80).forEach((m) => list.appendChild(optionRow(
      m.name || m.id,
      m.id,
      { free: true, selected: !onDefault && m.id === current }
    )));
  }

  if (rest.length) {
    list.appendChild(groupLabel(`${q ? 'Other' : 'Paid / other'} models · ${rest.length}`));
    rest.slice(0, 80).forEach((m) => list.appendChild(optionRow(
      m.name || m.id,
      m.id,
      { selected: !onDefault && m.id === current }
    )));
  }

  if (!free.length && !rest.length) {
    list.appendChild(emptyNote(`No model matches “${String(query || '').trim()}”.`));
  }

  if (note) {
    const freeCount = items.filter((m) => m.free === true).length;
    note.textContent = freeCount ? `${freeCount} free · ${items.length} total` : `${items.length} models`;
  }
}

async function loadModelItems() {
  const provider = getProvider();
  const keys = getApiKeys(provider);
  if (!keys.length) {
    modelMenuItems = [];
    modelMenuProvider = provider;
    return;
  }
  if (modelMenuItems && modelMenuProvider === provider) return;

  try {
    modelMenuItems = await listModels(provider, keys[0]);
    modelMenuProvider = provider;
    modelMenuError = '';
  } catch (err) {
    modelMenuItems = [];
    modelMenuProvider = provider;
    modelMenuError = String(err.message || err).slice(0, 160);
  }
}

async function openModelMenu() {
  const menu = document.getElementById('ai-model-menu');
  const btn = document.getElementById('btn-ai-model');
  const search = document.getElementById('ai-model-search');
  if (!menu || !btn || !search) return;

  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  search.value = '';

  const provider = getProvider();
  const needsLoad = getApiKeys(provider).length
    && (!modelMenuItems || modelMenuProvider !== provider);

  if (needsLoad) {
    modelMenuLoading = true;
    modelMenuError = '';
    renderModelList('');
    await loadModelItems();
    modelMenuLoading = false;
    if (menu.hidden) return;
  }

  renderModelList('');
  search.focus();
}

function chooseModel(id) {
  setModel(id);
  closeModelMenu();
  refreshModelPicker();

  const field = document.getElementById('ai-model');
  if (field) field.value = getModel();

  const label = shortModelId(getModel());
  showToast(id ? `Model: ${label}` : `Model: ${label} (default)`, 'ok');
}

function setupModelPicker() {
  const bar = document.getElementById('ai-model-bar');
  const btn = document.getElementById('btn-ai-model');
  const menu = document.getElementById('ai-model-menu');
  const search = document.getElementById('ai-model-search');
  const manage = document.getElementById('btn-ai-model-manage');
  if (!bar || !btn || !menu || !search) return;

  refreshModelPicker();

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) openModelMenu();
    else closeModelMenu();
  });

  search.addEventListener('input', () => renderModelList(search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeModelMenu();
      btn.focus();
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = document.querySelector('.ai-model-option');
      if (first) first.click();
    }
  });

  menu.addEventListener('click', (e) => e.stopPropagation());
  bar.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeModelMenu();
      btn.focus();
    }
  });

  document.addEventListener('click', (e) => {
    if (!menu.hidden && !bar.contains(e.target)) closeModelMenu();
  });

  if (manage) {
    manage.onclick = () => {
      closeModelMenu();
      document.getElementById('btn-ai-settings').click();
    };
  }
}

async function handleAIMessage() {
  const message = aiInput.value.trim();
  if (!message) return;
  if (!isAIEnabled()) {
    showToast('Connect an AI provider first', 'error');
    document.getElementById('btn-ai-settings').click();
    return;
  }

  addAIMessage(message, 'user');
  aiInput.value = '';
  const statusEl = addAIMessage(researchEnabled ? 'Researching the web…' : 'Thinking…', 'ai', { status: true });
  showToast('AI thinking…', 'ok');

  try {
    const context = getSheetContext(getActiveSheet(), getCurrentSheet().cells, getSelectedCell());
    const result = await sendAIMessage(message, context, {
      research: researchEnabled,
      onStatus: (status) => {
        const content = statusEl?.querySelector('.ai-content');
        if (content) content.textContent = status;
      },
    });

    if (statusEl.isConnected) statusEl.remove();
    refreshModelPicker();
    const parsed = parseAIResponse(result.text);
    const answer = parsed.text || '';
    const providerLabel = PROVIDER_LABELS[result.provider] || result.provider;
    const via = result.fallback
      ? providerLabel
      : result.switchedModel ? `${providerLabel} · free model` : '';

    // Replace the "thinking" toast as soon as the answer lands, so it never
    // sits under a permission slip saying the model is still working.
    if (via) {
      showToast(`Answered with ${via}`, 'ok');
    } else if (parsed.type === 'table') {
      showToast('Table ready — approve to write', 'ok');
    } else if (parsed.type === 'write' && parsed.cell) {
      showToast('Answer ready — approve to write', 'ok');
    } else {
      showToast(result.research ? 'AI response (web sources)' : 'AI response', 'ok');
    }

    if (parsed.type === 'write' && parsed.cell) {
      addAIMessage(answer || 'Ready to write.', 'ai', {
        html: true,
        via,
        sources: result.research?.sources,
        permission: cellPermission(parsed.cell, parsed.value),
      });
      return;
    }

    if (parsed.type === 'table' && parsed.tables.length) {
      const chatText = [answer, ...parsed.tables.map(tableToMarkdown)].filter(Boolean).join('\n\n');
      addAIMessage(chatText, 'ai', {
        html: true,
        via,
        sources: result.research?.sources || [],
        tables: parsed.tables,
        permissionInTable: true,
        permission: tablePermission(parsed.tables[0], message),
      });
      return;
    }

    addAIMessage(answer || result.text, 'ai', {
      html: true,
      via,
      sources: result.research?.sources || [],
    });
    if (result.researchError) {
      addAIMessage('Web research failed: ' + result.researchError + ' — answered without live sources.', 'ai');
    }
  } catch (err) {
    if (statusEl.isConnected) statusEl.remove();
    refreshModelPicker();
    showToast(err.message, 'error');
    addAIMessage('Error: ' + err.message);
  }
}

function addAIMessage(text, sender = 'ai', options = {}) {
  document.getElementById('ai-empty')?.remove();

  const div = document.createElement('div');
  div.className = `ai-message ${sender}`;
  if (options.status) div.classList.add('ai-status');

  const who = document.createElement('div');
  who.className = 'ai-who';
  who.textContent = sender === 'user'
    ? 'You'
    : options.via ? `Assistant · ${options.via}` : 'Assistant';
  div.appendChild(who);

  const content = document.createElement('div');
  content.className = 'ai-content';
  let permit = null;

  if (sender === 'ai' && (options.html || options.sources?.length || options.permission)) {
    const tables = options.tables || parseMarkdownTables(text);
    let html = options.html
      ? renderMarkdown(text, {
          tableRenderer: (table, index) => renderTableWithButton(table, index, options),
        })
      : `<p>${escapeHtml(text)}</p>`;

    if (options.permission && !options.permissionInTable) {
      html += renderPermissionCard(options.permission);
    }
    if (options.sources && options.sources.length) html += renderSources(options.sources);
    content.innerHTML = html;

    content.querySelectorAll('.ai-insert-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const table = tables[Number(btn.dataset.tableIndex)];
        if (!table) return;
        const result = insertTableSmart(table, text || 'AI table');
        const note = document.createElement('div');
        note.className = 'ai-inserted-note';
        note.textContent = `Inserted into “${result.sheet}”`;
        btn.replaceWith(note);
      });
    });

    const permitEl = content.querySelector('.ai-permit');
    if (permitEl && options.permission) permit = permitEl;
  } else {
    content.textContent = text;
  }

  div.appendChild(content);
  aiChat.appendChild(div);
  scrollChatToMessage(div, options.status);
  if (permit) mountPermission(permit, options.permission);
  return div;
}

/* Keep the newest message in view. Long answers start at their first line so
   the reader begins at the top instead of landing halfway down a table. */
function scrollChatToMessage(div, status = false) {
  if (!status && div.offsetHeight > aiChat.clientHeight - 48) {
    const delta = div.getBoundingClientRect().top - aiChat.getBoundingClientRect().top;
    aiChat.scrollTop += delta - 4;
    return;
  }
  aiChat.scrollTop = aiChat.scrollHeight;
}

const AI_PREVIEW_ROWS = 8;

function renderTableWithButton(table, index, options = {}) {
  const total = table.rows?.length || 0;
  const preview = total > AI_PREVIEW_ROWS
    ? { ...table, rows: table.rows.slice(0, AI_PREVIEW_ROWS) }
    : table;
  const more = total > AI_PREVIEW_ROWS
    ? `<div class="ai-table-more">Showing ${AI_PREVIEW_ROWS} of ${total} rows.</div>`
    : '';
  let action;
  if (options.permission && options.permissionInTable && index === 0) {
    action = renderPermissionCard(options.permission);
  } else {
    action = `<button class="ai-insert-btn" data-table-index="${index}">Insert into sheet</button>`;
  }
  return `<div class="ai-table-block">${renderTable(preview)}${more}${action}</div>`;
}

/*----------------------------------------------------------------------
  Write permission
  The assistant only proposes changes. Nothing reaches the sheet until
  the reader presses the allow button on a permission slip.
----------------------------------------------------------------------*/

/*----------------------------------------------------------------------
  Pending AI write
  The permission slip decides whether a write happens. This decides
  whether it stays: the sheets are snapshotted before the write and the
  reader gets Save or Discard on the strip above the status bar.
---------------------------------------------------------------------*/

let pendingEdit = null;

function captureEditSnapshot(label) {
  if (!pendingEdit) {
    pendingEdit = {
      sheets: JSON.parse(JSON.stringify(getSheets())),
      active: getActiveSheet(),
      selected: getSelectedCell(),
      count: 0,
      label,
    };
  }
  pendingEdit.count += 1;
  pendingEdit.label = label;
  renderEditReview();
}

function renderEditReview() {
  const bar = document.getElementById('edit-review');
  const text = document.getElementById('edit-review-text');
  if (!bar || !text) return;
  if (!pendingEdit) {
    bar.hidden = true;
    text.textContent = '';
    return;
  }
  const prefix = pendingEdit.count > 1 ? `${pendingEdit.count} AI edits · ` : '';
  text.textContent = prefix + pendingEdit.label;
  bar.hidden = false;
}

async function savePendingEdit() {
  if (!pendingEdit) return;
  pendingEdit = null;
  renderEditReview();
  try {
    await saveAllSheets({ announce: false });
    showToast('AI edit saved', 'ok');
  } catch (err) {
    showToast('Could not save: ' + err.message, 'error');
  }
}

async function discardPendingEdit() {
  if (!pendingEdit) return;
  const snapshot = pendingEdit;
  pendingEdit = null;
  renderEditReview();

  setSheets(snapshot.sheets);
  setActiveSheet(snapshot.active);
  renderTabs();
  selectCell(snapshot.selected);

  try {
    await saveAllSheets({ announce: false });
  } catch (err) {
    console.warn('Discard could not be persisted', err);
  }
  showToast('AI edit discarded', 'ok');
}

function renderPermissionCard(permission = {}) {
  const value = permission.target ? String(permission.target) : '';
  const target = value
    ? `<code class="ai-permit-value" title="${escapeHtml(value)}">${escapeHtml(value)}</code>`
    : '';
  const note = permission.note
    ? `<span class="ai-permit-note">${escapeHtml(permission.note)}</span>`
    : '';
  const detail = target || note ? `<div class="ai-permit-detail">${target}${note}</div>` : '';

  return `<div class="ai-permit" role="group" aria-label="Write permission">
    <div class="ai-permit-head">
      <span class="ai-permit-label">Write permission</span>
      <span class="ai-permit-title">${escapeHtml(permission.title || 'Write to sheet')}</span>
    </div>
    ${detail}
    <div class="ai-permit-actions">
      <button class="ai-permit-allow" type="button">${escapeHtml(permission.allowLabel || 'Write to sheet')}</button>
      <button class="ai-permit-deny" type="button">Keep in chat</button>
    </div>
  </div>`;
}

function mountPermission(card, permission) {
  let host = card;
  clearToast();

  const commit = () => {
    let result;
    try {
      result = permission.onAllow() || {};
    } catch (err) {
      showToast(err.message, 'error');
      return;
    }
    const note = document.createElement('div');
    note.className = 'ai-inserted-note';
    note.tabIndex = -1;
    note.textContent = result.note || 'Written to the sheet';
    host.replaceWith(note);
    host = note;
    note.focus({ preventScroll: true });
    if (result.toast) showToast(result.toast, 'ok');
  };

  card.querySelector('.ai-permit-allow').addEventListener('click', commit);
  card.querySelector('.ai-permit-deny').addEventListener('click', () => {
    const declined = document.createElement('div');
    declined.className = 'ai-permit-declined';

    const line = document.createElement('span');
    line.textContent = permission.declined || 'Nothing written.';

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'ai-permit-later';
    retry.textContent = permission.allowLabel || 'Write to sheet';
    retry.addEventListener('click', commit);

    declined.append(line, retry);
    host.replaceWith(declined);
    host = declined;
    retry.focus();
  });

  // The slip is the next thing to answer, so put the caret on it — unless
  // the reader is mid-edit somewhere outside the assistant.
  const active = document.activeElement;
  if (!active || active === document.body || aiSidebar.contains(active)) {
    card.querySelector('.ai-permit-allow').focus({ preventScroll: true });
  }
}

function cellPermission(addr, value) {
  const sheet = getActiveSheet();
  const existing = getCellValue(addr);
  const occupied = !!(existing && String(existing.raw || '').trim());
  return {
    title: `Write to ${addr}`,
    target: value,
    note: occupied ? `Replaces what ${addr} holds on “${sheet}”.` : `Sets ${addr} on “${sheet}”.`,
    allowLabel: `Write to ${addr}`,
    declined: 'Nothing written. The proposal stays here.',
    onAllow: () => writeCellNow(sheet, addr, value),
  };
}

function writeCellNow(sheetName, addr, value) {
  if (!getSheets()[sheetName]) throw new Error('That sheet no longer exists');
  captureEditSnapshot(`Cell ${addr} on “${sheetName}”`);
  activateSheet(sheetName);
  const cell = ensureCell(addr);
  if (cell) cell.raw = value;
  setDirty(true);
  setSheetDirty(sheetName, true);
  recomputeAndRender(addr);
  selectCell(addr);
  if (formulaInput) formulaInput.value = value;
  return { note: `Wrote to ${addr}` };
}

function tablePermission(table, promptText) {
  const plan = planTableWrite(table, promptText);
  const destination = plan.mode === 'new'
    ? `New sheet “${plan.sheet}”`
    : `${plan.sheet} · ${plan.start}`;
  return {
    title: `Write ${plan.rows} × ${plan.cols} table`,
    target: destination,
    note: plan.mode === 'new'
      ? 'The selected area already holds data.'
      : 'A new sheet is used if that space fills up first.',
    allowLabel: 'Write to sheet',
    declined: 'Nothing written. The table stays in the chat.',
    onAllow: () => {
      const result = insertTableSmart(table, promptText, plan);
      return { note: `Inserted into “${result.sheet}”` };
    },
  };
}

function activateSheet(name) {
  if (getActiveSheet() === name) return;
  setActiveSheet(name);
  renderTabs();
  renderGrid();
}

function planTableWrite(table, promptText) {
  const size = tableSize(table);
  const sheet = getActiveSheet();
  const start = getSelectedCell() || 'A1';
  const fits = isRangeEmpty(start, size.rows, size.cols);
  return {
    sheet: fits ? sheet : nextResultSheetName(promptText),
    start: fits ? start : 'A1',
    mode: fits ? 'selection' : 'new',
    rows: size.rows,
    cols: size.cols,
    promptText,
  };
}

/* Insert the first AI table at the approved spot.
   If that area already has data, use a dedicated result sheet instead of overwriting. */
function insertTableSmart(table, promptText = 'AI Result', plan = null) {
  const size = tableSize(table);
  if (!size.rows || !size.cols) throw new Error('The AI table is empty');
  if (!plan) plan = planTableWrite(table, promptText);

  captureEditSnapshot(`${size.rows} × ${size.cols} table`);

  let sheet;
  let start;

  if (plan.mode === 'new' || !getSheets()[plan.sheet]) {
    sheet = openResultSheet(plan.mode === 'new' ? plan.sheet : nextResultSheetName(promptText), promptText);
    start = 'A1';
  } else {
    activateSheet(plan.sheet);
    if (!isRangeEmpty(plan.start, plan.rows, plan.cols)) {
      sheet = openResultSheet(nextResultSheetName(promptText), promptText);
      start = 'A1';
    } else {
      sheet = plan.sheet;
      start = plan.start;
    }
  }

  const cells = tableToCells(table, start, ROWS, COLUMNS);
  for (const record of cells) {
    const cell = setCellValue(record.addr, record.value);
    if (cell && record.header) cell.header = true;
  }
  recalculateSheet(sheet);

  setDirty(true);
  setSheetDirty(sheet, true);
  selectCell(start);
  renderTabs();

  if (pendingEdit) {
    pendingEdit.label = `${size.rows} × ${size.cols} table → “${sheet}”`;
    renderEditReview();
  }

  return { sheet, rows: size.rows, cols: size.cols, start };
}

function renderSources(sources) {
  const items = sources.slice(0, 6).map((source) => {
    const url = /^https?:\/\//i.test(source.url || '') ? source.url : '#';
    return `<li><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">`
      + `${escapeHtml(source.title || url)}</a></li>`;
  }).join('');
  return `<div class="ai-sources"><div class="ai-sources-title">Sources</div><ol>${items}</ol></div>`;
}

/* Insert the first AI table at the selected cell is handled above.
   The selected area is checked again at approval time so a late edit
   cannot be overwritten by a stale preview. */

function isRangeEmpty(origin, rows, cols) {
  const [letters, rowText] = parseAddr(origin);
  const startCol = colIndex(letters);
  const startRow = Number(rowText);

  for (let r = 0; r < rows; r++) {
    if (startRow + r > ROWS) break;
    for (let c = 0; c < cols; c++) {
      if (startCol + c >= COLUMNS) break;
      const addr = colIndexToCol(startCol + c) + (startRow + r);
      const cell = getCellValue(addr);
      if (cell && String(cell.raw || '').trim()) return false;
    }
  }
  return true;
}

function openResultSheet(name, promptText) {
  let target = name;
  if (getSheets()[target]) target = nextResultSheetName(promptText);

  if (!getSheets()[target]) {
    getSheets()[target] = { name: target, cells: {}, raw: {}, dirty: true };
  }
  setActiveSheet(target);
  renderTabs();
  return target;
}

function nextResultSheetName(promptText) {
  const base = sheetNameFromPrompt(promptText);
  let name = base;
  let n = 2;
  while (getSheets()[name]) {
    name = `${base.slice(0, 26)} ${n}`;
    n++;
  }
  return name;
}

function sheetNameFromPrompt(text) {
  let name = String(text || '')
    .split(/\b(?:include|including|with columns?|columns?\s*:|so that)\b/i)[0]
    .replace(/^\s*(please\s+)?(make|create|build|generate|give|show|find|get|list|add)\s+(me\s+)?/i, '')
    .replace(/^\s*(?:a|an|the)?\s*(?:table|list|spreadsheet)\s+(?:of|with|showing)\s+/i, '')
    .replace(/^\s*the\s+/i, '')
    .replace(/\b(in|as|into)\s+(a\s+)?(new\s+)?(table|spreadsheet|sheet)\b/gi, ' ')
    .replace(/[\\/?*\[\]:]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s.,;:-]+$/g, '')
    .trim();

  if (!name) name = 'AI Result';
  if (name.length > 31) {
    name = name.slice(0, 31);
    const lastSpace = name.lastIndexOf(' ');
    if (lastSpace > 18) name = name.slice(0, lastSpace);
    name = name.trim();
  }
  const small = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
  return name
    .split(/\s+/)
    .map((word, i) => {
      if (/^[A-Z]{2,5}$/.test(word)) return word;
      if (i > 0 && small.has(word.toLowerCase())) return word.toLowerCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

window.aiQuickCommand = async (cmd) => {
  if (!isAIEnabled()) {
    showToast('Connect an AI provider first', 'error');
    document.getElementById('btn-ai-settings').click();
    return;
  }
  const commands = {
    sum: 'Calculate the sum of all numeric columns and suggest which cells to put the totals in.',
    average: 'Calculate the average of each numeric column and suggest formulas.',
    insights: 'Analyze the spreadsheet data and give me 3 key insights or observations.',
    clean: 'Suggest how to clean and organize this data (remove duplicates, fix formatting, etc.)',
    stocks: 'Make a table of the top 10 Indian stocks by market capitalization, with rank, company, market cap, and sector.',
  };
  aiInput.value = commands[cmd] || cmd;
  await handleAIMessage();
};

function saveApiKey() {
  const provider = document.getElementById('ai-provider').value;
  const field = document.getElementById('ai-api-key');
  const model = document.getElementById('ai-model').value.trim();

  setProvider(provider);
  if (field.value.trim()) addApiKey(field.value, provider);
  field.value = '';

  if (!configuredProviders().length) {
    showToast('Add at least one API key — free Groq keys at console.groq.com/keys', 'error');
    return;
  }

  if (model) setModel(model); else setModel(''); // per-provider default
  initBadge();
  invalidateModelCache();
  refreshModelPicker();
  renderKeyList(provider);
  closeDialog('ai-settings-dialog');

  const total = configuredProviders().reduce((sum, p) => sum + keyCount(p), 0);
  showToast(`${total} key${total === 1 ? '' : 's'} ready`, 'ok');
}

/*======================================================================
  Utilities
======================================================================*/
function updateConnectivity() {
  const el = document.getElementById('status-badge');
  if (!el) return;
  const online = navigator.onLine !== false;
  el.textContent = online ? 'Online' : 'Offline';
  el.className = `status-badge ${online ? 'online' : 'offline'}`;
  el.title = online ? 'Connected — live research available' : 'Offline — the sheet still works';
}

function showToast(msg, type = '') {
  if (!toastEl) { console.log('Toast:', msg); return; }
  toastEl.textContent = msg;
  toastEl.className = `toast ${type === 'ok' ? 'ok' : type === 'error' ? 'error' : type === 'ai' ? 'ai' : ''} show`;
  setTimeout(() => toastEl.classList.remove('show'), 2500);
}

function clearToast() {
  if (toastEl) toastEl.classList.remove('show');
}

function closeDialog(id) {
  const dlg = document.getElementById(id);
  if (dlg) dlg.close();
}

// Expose for inline HTML
window.selectSheet = selectSheet;
window.promptNewSheet = promptNewSheet;
window.deleteCurrentSheet = deleteCurrentSheet;
window.saveApiKey = saveApiKey;
window.closeDialog = closeDialog;

window.addEventListener('online', updateConnectivity);
window.addEventListener('offline', updateConnectivity);

/*======================================================================
  Service Worker — offline cache + installable PWA
======================================================================*/
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}
