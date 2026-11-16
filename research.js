/*======================================================================
  Web Research — key-free, browser-only
  ----------------------------------------------------------------------
  Search : DuckDuckGo HTML, read through r.jina.ai (CORS-enabled)
  Fallback: Wikipedia search API (CORS-enabled)
  Read   : r.jina.ai reader → cleaned, density-ranked text
  Tables : Wikipedia parse API (clean wikitables) + Markdown pipe tables
  Cache  : sessionStorage, 20 minutes (browser-only, never sent anywhere)
======================================================================*/

import { parseMarkdownTables } from './markdown.js';

const JINA = 'https://r.jina.ai/';
const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const CACHE_PREFIX = 'ai_research_v1:';
const CACHE_TTL = 20 * 60 * 1000;
const CACHE_MAX = 12;

const LOW_VALUE_HOSTS = [
  'youtube.com', 'youtu.be', 'facebook.com', 'instagram.com', 'x.com',
  'twitter.com', 'tiktok.com', 'pinterest.com', 'reddit.com',
];

const memCache = new Map();

/* ---------- Small utilities ---------- */

function decodeEntities(value) {
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

function cleanInline(value) {
  return decodeEntities(
    String(value ?? '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => {
        const text = String(alt).replace(/^Image\s*\d+:\s*/i, '').replace(/\s*logo$/i, '').trim();
        return text ? ` ${text} ` : ' ';
      })
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[*_`#>]+/g, ' ')
      .replace(/\s+/g, ' ')
  ).trim();
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
}

function isLowValue(url) {
  const host = hostOf(url);
  return LOW_VALUE_HOSTS.some((blocked) => host === blocked || host.endsWith('.' + blocked));
}

function safeHttpUrl(value) {
  const url = String(value || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
}

function decodeDdgLink(href) {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    const wrapped = url.searchParams.get('uddg');
    if (wrapped) {
      try { return decodeURIComponent(wrapped); } catch { return wrapped; }
    }
    return url.href;
  } catch {
    return href;
  }
}

async function fetchText(url, { timeout = 22000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeReaderError(text) {
  const head = String(text || '').slice(0, 320);
  return /^\s*<!DOCTYPE html/i.test(head)
    || /Authentication required/i.test(head)
    || /Rate limit|Too Many Requests/i.test(head)
    || /^Error:/i.test(head.trim());
}

/* ---------- Cache ---------- */

function pruneCache() {
  try {
    const keys = Object.keys(sessionStorage).filter((k) => k.startsWith(CACHE_PREFIX));
    if (keys.length <= CACHE_MAX) return;
    keys.slice(0, keys.length - CACHE_MAX).forEach((k) => sessionStorage.removeItem(k));
  } catch { /* private mode */ }
}

function cacheGet(key) {
  if (memCache.has(key)) return memCache.get(key);
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || Date.now() - parsed.t > CACHE_TTL) {
      sessionStorage.removeItem(CACHE_PREFIX + key);
      return null;
    }
    memCache.set(key, parsed.data);
    return parsed.data;
  } catch {
    return null;
  }
}

function cacheSet(key, data) {
  memCache.set(key, data);
  try {
    pruneCache();
    sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), data }));
  } catch { /* quota / private mode */ }
}

/* ---------- Search ---------- */

/* Turn a natural-language instruction into a search query. */
export function buildSearchQuery(prompt) {
  let query = String(prompt || '').trim();

  // Drop the output specification: "include rank, company..." / "with columns: ..."
  query = query.split(/\b(?:include|including|with\s+(?:rank|columns?|fields?|details?)|with columns?|columns?\s*:|showing|containing|so that)\b/i)[0];

  query = query
    .replace(/\b(make|create|build|generate|give|show|find|get|prepare|produce|fetch)\b/gi, ' ')
    .replace(/\b(me|please|a|an|the)\b/gi, ' ')
    .replace(/\b(list|table|spreadsheet|sheet)\b/gi, ' ')
    .replace(/\bof\b/gi, ' ')
    .replace(/\bstock market\b/gi, 'stocks')
    .replace(/\bmarket capitalisation\b/gi, 'market capitalization')
    .replace(/\s+/g, ' ')
    .replace(/^[,.;:\s]+|[,.;:\s]+$/g, '')
    .trim();

  if (!query) query = String(prompt || '').trim();
  return query.slice(0, 160);
}

function parseDdgResults(markdown, limit) {
  const lines = String(markdown || '').split(/\r?\n/);
  const results = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^##\s+\[(.+?)\]\((.+?)\)\s*$/);
    if (!heading) continue;

    const title = cleanInline(heading[1]);
    const url = decodeDdgLink(heading[2]);
    if (!title || !safeHttpUrl(url) || isLowValue(url)) continue;
    if (hostOf(url) === 'duckduckgo.com') continue;
    if (seen.has(url)) continue;

    // Collect the result block up to the next result heading.
    const block = [];
    let j = i + 1;
    for (; j < lines.length && !/^##\s+/.test(lines[j]); j++) block.push(lines[j]);

    let snippet = cleanInline(block.join(' '))
      .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s]*/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (snippet.length > 300) snippet = snippet.slice(0, 297).trim() + '…';

    results.push({ title, url, snippet });
    seen.add(url);
    i = j - 1;
    if (results.length >= limit) break;
  }
  return results;
}

export async function searchWeb(query, limit = 5) {
  const searchUrl = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const markdown = await fetchText(JINA + searchUrl, { timeout: 22000 });
  if (looksLikeReaderError(markdown)) throw new Error('Search reader unavailable');
  const results = parseDdgResults(markdown, limit);
  if (!results.length) throw new Error('No search results');
  return results;
}

async function wikiSearch(query, limit = 4) {
  const url = `${WIKI_API}?action=query&list=search&srsearch=${encodeURIComponent(query)}`
    + `&srlimit=${limit}&format=json&origin=*`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wikipedia search HTTP ${res.status}`);
  const data = await res.json();
  return (data.query?.search || []).map((item) => ({
    title: item.title,
    url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(item.title.replace(/ /g, '_')),
    snippet: cleanInline(item.snippet).slice(0, 300),
  }));
}

/* ---------- Page reading ---------- */

/* Strip reader chrome, images and link targets, then keep the densest prose. */
function densify(markdown, maxChars) {
  const text = String(markdown || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => {
      const label = String(alt).replace(/^Image\s*\d+:\s*/i, '').replace(/\s*logo$/i, '').trim();
      return label ? ` ${label} ` : ' ';
    })
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    .replace(/^\s*Title:.*$/gm, '')
    .replace(/^\s*URL Source:.*$/gm, '')
    .replace(/^\s*Markdown Content:\s*$/gm, '')
    .replace(/^\s*\[!\[.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const scored = paragraphs.map((p, index) => {
    let score = Math.min(p.length, 600);
    const digits = (p.match(/\d/g) || []).length;
    score += Math.min(digits, 90) * 8;
    score += (p.match(/\b[A-Z][a-z]{3,}\b/g) || []).length * 2;
    if (/cookie|subscribe|newsletter|privacy policy|terms of|advertise|follow us|download (the )?app/i.test(p)) score -= 400;
    if (/^(\*|-|\d+\.)\s/.test(p) && p.length < 80) score -= 100;
    return { p, index, score };
  });

  const keep = new Set(
    scored
      .filter((item) => item.score > 40)
      .sort((a, b) => b.score - a.score)
      .slice(0, 22)
      .map((item) => item.index)
  );
  scored.slice(0, 2).forEach((item) => keep.add(item.index));

  let out = '';
  for (const item of scored) {
    if (!keep.has(item.index)) continue;
    if (out.length + item.p.length > maxChars) {
      const room = maxChars - out.length;
      if (room > 120) out += (out ? '\n' : '') + item.p.slice(0, room);
      break;
    }
    out += (out ? '\n' : '') + item.p;
  }
  return out || text.slice(0, maxChars).trim();
}

function scoreTable(table) {
  const header = (table.headers || []).join(' ').toLowerCase();
  let score = Math.min((table.rows?.length || 0), 30);
  if (/\brank\b/.test(header)) score += 30;
  if (/\bname\b|\bcompany\b|\bteam\b|\bplayer\b|\bcountry\b/.test(header)) score += 12;
  if (/market cap|market value|valuation|revenue|profit|price|population|gdp/.test(header)) score += 16;
  if (/\bsymbol\b|\bticker\b|\bsector\b|\bindustry\b/.test(header)) score += 8;
  return score;
}

export async function readPage(url, { maxChars = 4800 } = {}) {
  const raw = await fetchText(JINA + url, { timeout: 26000 });
  if (looksLikeReaderError(raw)) throw new Error('Reader could not read page');

  // Keep markdown tables found in the reader output before densifying.
  const tables = parseMarkdownTables(raw)
    .filter((table) => table.headers.length >= 2 && table.rows.length >= 2)
    .map((table) => ({ ...table, score: scoreTable(table) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  return { text: densify(raw, maxChars), tables };
}

/* ---------- Wikipedia wikitables (clean structured data) ---------- */

function cleanWikiCell(html) {
  return decodeEntities(
    String(html)
      .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\s+/g, ' ')
  ).trim();
}

function extractWikiTables(html, maxTables) {
  const tables = [];
  const tableRe = /<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>([\s\S]*?)<\/table>/g;
  let match;

  while ((match = tableRe.exec(html))) {
    const rows = [...match[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
      .map((row) => [...row[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((cell) => cleanWikiCell(cell[1])))
      .filter((row) => row.length >= 2);

    if (rows.length < 3) continue;
    const headers = rows[0];
    if (headers.length < 2 || !headers.some((h) => h)) continue;

    const table = {
      headers,
      rows: rows.slice(1, 31),
      score: scoreTable({ headers, rows: rows.slice(1) }),
    };
    if (table.rows.length) tables.push(table);
  }

  return tables.sort((a, b) => b.score - a.score).slice(0, maxTables);
}

async function fetchWikiTables(url, maxTables = 2) {
  const marker = '/wiki/';
  const at = url.indexOf(marker);
  if (at < 0) return [];
  const title = decodeURIComponent(url.slice(at + marker.length).split(/[?#]/)[0]).replace(/_/g, ' ');
  if (!title) return [];

  const api = `${WIKI_API}?action=parse&page=${encodeURIComponent(title)}&prop=text&format=json&origin=*`;
  const res = await fetch(api);
  if (!res.ok) return [];
  const data = await res.json();
  const html = data.parse?.text?.['*'];
  if (!html) return [];
  return extractWikiTables(html, maxTables);
}

/* ---------- Research orchestration ---------- */

function tablesToText(tables, maxRows = 15, maxCols = 8) {
  return tables.map((table, index) => {
    const header = table.headers.slice(0, maxCols).join(' | ');
    const rows = table.rows.slice(0, maxRows)
      .map((row) => row.slice(0, maxCols).join(' | '))
      .join('\n');
    return `--- TABLE ${index + 1} (${table.rows.length} data rows) ---\n${header}\n${rows}`;
  }).join('\n\n');
}

export async function research(prompt, { onStatus, maxChars = 15000 } = {}) {
  const query = buildSearchQuery(prompt);
  const cacheKey = query.toLowerCase();
  const cached = cacheGet(cacheKey);
  if (cached) {
    onStatus?.('📚 Using research from the last 20 minutes…');
    return cached;
  }

  onStatus?.('🔎 Searching the web…');
  let results = [];
  let searchVia = 'duckduckgo';

  try {
    results = await searchWeb(query, 5);
  } catch (err) {
    console.warn('DuckDuckGo search failed, falling back to Wikipedia:', err);
    try {
      results = await wikiSearch(query, 4);
      searchVia = 'wikipedia';
    } catch (wikiErr) {
      throw new Error('Web search unavailable: ' + (err.message || err));
    }
  }

  if (!results.length) throw new Error('No web results found');

  const sources = results.slice(0, 5).map((result, index) => ({
    id: index + 1,
    title: result.title,
    url: result.url,
    snippet: result.snippet || '',
  }));

  const toRead = results.slice(0, 3);
  onStatus?.(`📄 Reading ${toRead.length} source${toRead.length === 1 ? '' : 's'}…`);

  const pageReads = await Promise.allSettled(
    toRead.map((result) => readPage(result.url))
  );

  const wikiTables = await Promise.allSettled(
    toRead
      .filter((result) => hostOf(result.url).endsWith('wikipedia.org'))
      .map((result) => fetchWikiTables(result.url, 2))
  );

  const structured = [];
  const seenHeaders = new Set();

  const addTable = (table) => {
    const signature = (table.headers || []).join('|').toLowerCase();
    if (!signature || seenHeaders.has(signature)) return;
    seenHeaders.add(signature);
    structured.push(table);
  };

  for (const result of wikiTables) {
    if (result.status === 'fulfilled') result.value.forEach(addTable);
  }
  for (const result of pageReads) {
    if (result.status !== 'fulfilled') continue;
    (result.value.tables || []).forEach(addTable);
  }

  // Build the compact research brief sent to the model.
  const chunks = [];
  chunks.push(`WEB RESEARCH — fetched ${new Date().toUTCString()}`);
  chunks.push(`Search query: "${query}"  (search via ${searchVia})`);
  chunks.push('RESULTS:');
  sources.forEach((source) => {
    chunks.push(`[${source.id}] ${source.title} — ${source.url}`);
    if (source.snippet) chunks.push(`    ${source.snippet}`);
  });

  if (structured.length) {
    chunks.push('\nSTRUCTURED TABLES (exact values extracted from the pages — prefer these):');
    chunks.push(tablesToText(structured.slice(0, 3)));
  }

  chunks.push('\nPAGE EXCERPTS:');
  pageReads.forEach((result, index) => {
    if (result.status !== 'fulfilled' || !result.value?.text) return;
    chunks.push(`\n--- SOURCE [${index + 1}] ${toRead[index].title} (${toRead[index].url}) ---`);
    chunks.push(result.value.text);
  });

  let context = chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (context.length > maxChars) {
    context = context.slice(0, maxChars).trimEnd() + '\n…[research truncated]';
  }

  const data = {
    query,
    via: searchVia,
    fetchedAt: Date.now(),
    context,
    sources,
    tables: structured.slice(0, 3),
  };

  cacheSet(cacheKey, data);
  return data;
}
