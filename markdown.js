/*======================================================================
  Markdown utilities
  - Safe Markdown → HTML (no external library, no XSS)
  - GitHub-style pipe table extraction (AI → spreadsheet cells)
  - Table → A1 cell mapping
======================================================================*/

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function decodeBasicEntities(value) {
  return String(value)
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

/* Strip inline formatting from a value that will land in a cell. */
export function stripInlineMarkdown(value) {
  return decodeBasicEntities(
    String(value ?? '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
      .replace(/(^|[^_])_([^_\n]+)_/g, '$1$2')
      .replace(/\s+/g, ' ')
  ).trim();
}

function splitRow(line) {
  let text = String(line).trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);

  const cells = [];
  let current = '';
  let escaped = false;
  for (const ch of text) {
    if (escaped) { current += ch; escaped = false; }
    else if (ch === '\\') { escaped = true; }
    else if (ch === '|') { cells.push(current.trim()); current = ''; }
    else current += ch;
  }
  cells.push(current.trim());
  return cells;
}

const SEPARATOR_RE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/;

function readTableAt(lines, start) {
  const headers = splitRow(lines[start]).map(stripInlineMarkdown);
  if (headers.length < 2) return { table: null, next: start + 1 };

  let i = start + 2;
  const rows = [];
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || !line.includes('|') || /^\s*#/.test(line)) break;
    const cells = splitRow(line).map(stripInlineMarkdown);
    if (cells.length < 2) break;
    while (cells.length < headers.length) cells.push('');
    rows.push(cells.slice(0, headers.length));
    i++;
  }
  return { table: { headers, rows }, next: i };
}

/* Extract every GitHub-flavoured Markdown table in a string. */
export function parseMarkdownTables(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const tables = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes('|') || !SEPARATOR_RE.test(lines[i + 1])) continue;
    const { table, next } = readTableAt(lines, i);
    if (table && table.rows.length) tables.push(table);
    i = next - 1;
  }
  return tables;
}

/* Remove table blocks (header + separator + rows) from prose. */
export function textWithoutTables(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const kept = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].includes('|') && i + 1 < lines.length && SEPARATOR_RE.test(lines[i + 1])) {
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) i++;
      continue;
    }
    kept.push(lines[i]);
    i++;
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------- Table → A1 cells ---------- */

function colName(index) {
  let n = Number(index);
  let out = '';
  while (n >= 0) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

function colNumber(letters) {
  return [...String(letters).toUpperCase()].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
}

export function tableSize(table) {
  if (!table) return { rows: 0, cols: 0 };
  const rows = 1 + (table.rows?.length || 0);
  const cols = Math.max(
    table.headers?.length || 0,
    ...(table.rows || []).map((row) => row.length),
    0
  );
  return { rows, cols };
}

/* Map a parsed table to { addr, value, header } records, starting at origin. */export function tableToCells(table, origin = 'A1', maxRows = 100, maxCols = 26) {
  if (!table) return [];
  const match = String(origin).toUpperCase().match(/^([A-Z]+)(\d+)$/);
  const startCol = match ? colNumber(match[1]) : 0;
  const startRow = match ? Number(match[2]) : 1;

  const allRows = [table.headers || [], ...(table.rows || [])];
  const rowLimit = Math.min(allRows.length, Math.max(0, maxRows - startRow + 1));
  const cells = [];

  for (let r = 0; r < rowLimit; r++) {
    const row = allRows[r] || [];
    const colLimit = Math.min(row.length, Math.max(0, maxCols - startCol));
    for (let c = 0; c < colLimit; c++) {
      const value = String(row[c] ?? '').trim();
      if (!value) continue;
      cells.push({
        addr: colName(startCol + c) + (startRow + r),
        value,
        header: r === 0,
      });
    }
  }
  return cells;
}

/* Re-serialise a parsed table as Markdown (used to show it in the chat). */
export function tableToMarkdown(table) {
  if (!table) return '';
  const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
  const headers = (table.headers || []).map(cell);
  const rows = (table.rows || []).map((row) => {
    const copy = [...row];
    while (copy.length < headers.length) copy.push('');
    return copy.slice(0, headers.length).map(cell);
  });
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

/* ---------- Markdown → safe HTML ---------- */

function renderInline(value) {
  let text = escapeHtml(value);
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  text = text.replace(
    /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>'
  );
  return text;
}

export function renderTable(table) {
  const headers = table.headers || [];
  const rows = table.rows || [];
  const numericCols = headers.map((_, col) =>
    rows.length > 0 && rows.every((row) => isNumericCell(row[col]))
  );
  const cellCls = (cell) => (isNumericCell(cell) ? ' class="num"' : '');
  const head = headers
    .map((cell, col) => `<th${numericCols[col] ? ' class="num"' : ''}>${renderInline(cell)}</th>`)
    .join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td${cellCls(cell)}>${renderInline(cell)}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="ai-table-wrap"><table class="ai-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function isNumericCell(value) {
  const text = String(value ?? '').trim().replace(/\u00a0/g, ' ');
  if (!text) return false;
  return /^[-−]?\s?[₹$€£]?\s?\d[\d,]*(\.\d+)?\s?%?$/.test(text);
}

export function renderMarkdown(markdown, options = {}) {
  const tableRenderer = options.tableRenderer || renderTable;
  const source = String(markdown ?? '');

  // Protect fenced code blocks first so tables inside them are not parsed.
  const codeBlocks = [];
  const withPlaceholders = source.replace(/```([\w-]*)\s*\n([\s\S]*?)```/g, (_, _lang, code) => {
    codeBlocks.push(`<pre class="ai-code"><code>${escapeHtml(code)}</code></pre>`);
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });

  const lines = withPlaceholders.split(/\r?\n/);
  const output = [];
  let paragraph = [];
  let tableIndex = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { flushParagraph(); continue; }

    const codeMatch = trimmed.match(/^\u0000CODE(\d+)\u0000$/);
    if (codeMatch) {
      flushParagraph();
      output.push(codeBlocks[Number(codeMatch[1])]);
      continue;
    }

    // Table
    if (trimmed.includes('|') && i + 1 < lines.length && SEPARATOR_RE.test(lines[i + 1])) {
      flushParagraph();
      const { table, next } = readTableAt(lines, i);
      if (table && table.rows.length) output.push(tableRenderer(table, tableIndex++));
      i = next - 1;
      continue;
    }

    // Heading (rendered compactly inside the sidebar)
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      output.push(`<h4 class="ai-h">${renderInline(heading[2])}</h4>`);
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(trimmed)) {
      flushParagraph();
      const items = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(`<li>${renderInline(lines[i].trim().replace(/^[-*+]\s+/, ''))}</li>`);
        i++;
      }
      i--;
      output.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+[.)]\s+/.test(trimmed)) {
      flushParagraph();
      const items = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(`<li>${renderInline(lines[i].trim().replace(/^\d+[.)]\s+/, ''))}</li>`);
        i++;
      }
      i--;
      output.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Quote
    if (/^>\s?/.test(trimmed)) {
      flushParagraph();
      output.push(`<blockquote>${renderInline(trimmed.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }

    // Horizontal rule
    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      flushParagraph();
      output.push('<hr>');
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  return output.join('\n').replace(/\u0000CODE(\d+)\u0000/g, (_, n) => codeBlocks[Number(n)]);
}
