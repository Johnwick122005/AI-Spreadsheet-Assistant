/*======================================================================
  AI Assistant — Provider-based integration
  Supports: Groq (free key), Google Gemini, OpenRouter
  Adds live web research + Markdown-table responses
======================================================================*/

import { research } from './research.js';
import { parseMarkdownTables, textWithoutTables } from './markdown.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const geminiUrl = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

const DEFAULT_MODELS = {
  groq: 'openai/gpt-oss-120b',
  gemini: 'gemini-3.8-flash',
  // The best free model measured for this workload: highest intelligence of the
  // free variants and the top free score on AA-AnalystAgent, which is literally
  // spreadsheet analysis. A key with no credit still answers — openRouterCall
  // walks OPENROUTER_FALLBACKS, all of which are $0.
  openrouter: 'thinkingmachines/inkling-2-small:free',
};

// Free models tried in order when the preferred one is retired, overloaded or
// out of quota. The order is deliberate (measured Nov 2026):
//   inkling-2-small       AA Intelligence 30.6, AA-AnalystAgent 71.3% pass@1,
//                         73.3% non-hallucination — best quality, slowest.
//   nemotron-3.5-super-vl ~290 tok/s across 11 endpoints, reasoning off by
//                         default — the fast way out.
//   gemma-4-26b-a4b-it    the most-requested free model, 245 ms median.
// openrouter/free is appended last: it picks a random free model per request,
// so it answers, but table formatting varies from call to call.
const OPENROUTER_FALLBACKS = [
  'thinkingmachines/inkling-2-small:free',
  'nvidia/nemotron-3.5-super-vl:free',
  'google/gemma-4-26b-a4b-it:free',
  'openrouter/free',
];

// Reasoning tokens are billed against max_tokens on OpenRouter. A thinking model
// at its default effort can spend the whole budget before it writes a single
// table row, so ask for light reasoning and leave the answer room to finish.
const OPENROUTER_REASONING = {
  'thinkingmachines/inkling-2-small:free': 'low',
};
const REASONING_HEADROOM = 1200;

// Tried in order when a Groq model is retired or unavailable.
const GROQ_PREFERRED = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b',
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
];

// Gemini fallback chain tried in order when the primary model is unavailable.
// (gemini-2.0-flash and gemini-2.5-flash are retired; Google's current default is gemini-3.8-flash)
// Lite/older Flash models are included because they are the ones most often
// left on a free-tier project.
const GEMINI_FALLBACKS = [
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-flash-latest',
];

const KEY_SLOTS = { groq: 'ai_key_groq', gemini: 'ai_key_gemini', openrouter: 'ai_key_openrouter' };
const KEYS_SLOTS = { groq: 'ai_keys_groq', gemini: 'ai_keys_gemini', openrouter: 'ai_keys_openrouter' };
const MODEL_SLOTS = { groq: 'ai_model_groq', gemini: 'ai_model_gemini', openrouter: 'ai_model_openrouter' };

const PROVIDERS = ['groq', 'gemini', 'openrouter'];
export const PROVIDER_LABELS = { groq: 'Groq', gemini: 'Gemini', openrouter: 'OpenRouter' };

// Google retired these names; stored values are silently upgraded.
const RETIRED_GEMINI = ['gemini-2.5-flash', 'gemini-flash-latest-retired-check'];

let apiKey = null;   // first key of the selected provider
let model = null;
let aiEnabled = false;
let groqModelCache = new Map(); // key → { t, ids }

/* ---------- Migration from old single-key storage ---------- */
(function migrateLegacyStorage() {
  try {
    const legacyKey = localStorage.getItem('ai_api_key');
    if (legacyKey) {
      localStorage.setItem('ai_key_openrouter', legacyKey);
      localStorage.removeItem('ai_api_key');
    }
    const legacyModel = localStorage.getItem('ai_model_v2') || localStorage.getItem('ai_model');
    if (legacyModel) {
      localStorage.setItem('ai_model_openrouter', legacyModel);
      localStorage.removeItem('ai_model_v2');
      localStorage.removeItem('ai_model');
    }
    // Pollinations is no longer usable from browsers (Turnstile-gated).
    localStorage.removeItem('ai_key_pollinations');
    localStorage.removeItem('ai_model_pollinations');
  } catch (e) {
    console.warn('Storage migration failed', e);
  }
})();

/* ---------- API key pool ----------
   Each provider keeps an ordered list of keys. A message is tried with the
   selected provider's keys first, then with every other provider that has
   keys, so one exhausted free tier does not take the assistant down. */

function normalizeKeyList(value) {
  return [...new Set(
    String(value || '')
      .split(/[\s,;]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  )];
}

export function getApiKeys(provider = getProvider()) {
  if (!PROVIDERS.includes(provider)) return [];

  let keys = [];
  try {
    const raw = localStorage.getItem(KEYS_SLOTS[provider]);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) keys = parsed;
  } catch (e) {
    keys = [];
  }

  // Fold in the old single-key slot the first time a list is read.
  const legacy = localStorage.getItem(KEY_SLOTS[provider]);
  if (legacy) keys.push(legacy);

  keys = [...new Set(keys.map((entry) => String(entry || '').trim()).filter(Boolean))];

  try {
    if (keys.length) localStorage.setItem(KEYS_SLOTS[provider], JSON.stringify(keys));
    else localStorage.removeItem(KEYS_SLOTS[provider]);
    if (legacy && keys.includes(legacy)) localStorage.removeItem(KEY_SLOTS[provider]);
  } catch (e) {
    console.warn('Could not persist API keys', e);
  }
  return keys;
}

function saveApiKeys(provider, keys) {
  const clean = [...new Set((keys || []).map((entry) => String(entry || '').trim()).filter(Boolean))];
  try {
    if (clean.length) localStorage.setItem(KEYS_SLOTS[provider], JSON.stringify(clean));
    else localStorage.removeItem(KEYS_SLOTS[provider]);
    localStorage.removeItem(KEY_SLOTS[provider]);
  } catch (e) {
    console.warn('Could not persist API keys', e);
  }
  groqModelCache.clear();
  modelListCache.clear();
  loadFromProvider();
  updateApiBadge();
  return clean;
}

export function addApiKey(value, provider = getProvider()) {
  const added = normalizeKeyList(value);
  if (!added.length) return getApiKeys(provider);
  return saveApiKeys(provider, [...getApiKeys(provider), ...added]);
}

export function removeApiKey(index, provider = getProvider()) {
  const keys = getApiKeys(provider);
  if (index < 0 || index >= keys.length) return keys;
  keys.splice(index, 1);
  return saveApiKeys(provider, keys);
}

export function keyCount(provider = getProvider()) {
  return getApiKeys(provider).length;
}

export function configuredProviders() {
  return PROVIDERS.filter((provider) => getApiKeys(provider).length > 0);
}

/* ---------- Provider selection ---------- */

export function getProvider() {
  const stored = localStorage.getItem('ai_provider') || 'groq';
  if (stored === 'pollinations') {
    localStorage.setItem('ai_provider', 'groq');
    return 'groq';
  }
  return stored;
}

export function setProvider(p) {
  if (p !== 'groq' && p !== 'gemini' && p !== 'openrouter') p = 'groq';
  localStorage.setItem('ai_provider', p);
  apiKey = null;
  model = null;
  aiEnabled = false;
  groqModelCache.clear();
  loadFromProvider();
}

function loadFromProvider() {
  const p = getProvider();
  const keys = getApiKeys(p);
  apiKey = keys[0] || null;
  const stored = localStorage.getItem(MODEL_SLOTS[p]);
  if (p === 'gemini' && stored && RETIRED_GEMINI.includes(stored)) {
    localStorage.removeItem(MODEL_SLOTS[p]);
    model = DEFAULT_MODELS.gemini;
  } else {
    model = stored || DEFAULT_MODELS[p];
  }
  // The assistant is usable when *any* provider has a key, not just the selected one.
  aiEnabled = configuredProviders().length > 0;
}

export function setApiKey(key) {
  const p = getProvider();
  saveApiKeys(p, key ? normalizeKeyList(key) : []);
}

export function getApiKey() {
  if (apiKey === null) loadFromProvider();
  return apiKey;
}

function getModelFor(provider) {
  if (provider === getProvider()) return getModel();
  const stored = localStorage.getItem(MODEL_SLOTS[provider]);
  if (provider === 'gemini' && stored && RETIRED_GEMINI.includes(stored)) {
    return DEFAULT_MODELS.gemini;
  }
  return stored || DEFAULT_MODELS[provider] || DEFAULT_MODELS.groq;
}

export function setModel(m) {
  const p = getProvider();
  model = m || DEFAULT_MODELS[p];
  localStorage.setItem(MODEL_SLOTS[p], model);
}

export function getModel() {
  if (model === null) loadFromProvider();
  return model || DEFAULT_MODELS[getProvider()];
}

export function isAIEnabled() {
  if (apiKey === null) loadFromProvider();
  return aiEnabled;
}

function updateApiBadge() {
  const el = document.getElementById('api-status');
  if (!el) return;
  const ready = configuredProviders();
  const total = ready.reduce((sum, provider) => sum + getApiKeys(provider).length, 0);
  if (total) {
    const active = ready.includes(getProvider()) ? getProvider() : ready[0];
    const keyWord = total === 1 ? 'key' : 'keys';
    el.textContent = 'AI ready';
    el.title = `${total} ${keyWord} · ${ready.map((p) => `${PROVIDER_LABELS[p]} ${getApiKeys(p).length}`).join(' · ')} — click to manage`;
    el.className = 'status-badge ai-ready ai-chip';
    el.dataset.provider = active;
  } else {
    el.textContent = 'Set up AI';
    el.title = 'Connect an AI provider — click to set up';
    el.className = 'status-badge ai-off ai-chip';
    delete el.dataset.provider;
  }
  el.classList.remove('hidden');
}

export function initBadge() {
  if (apiKey === null) loadFromProvider();
  updateApiBadge();
}

/* ---------- Shared helpers ---------- */

function buildSystemPrompt(contextStr, selectedCell, researchData, options = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const sources = researchData?.sources || [];

  const researchBlock = researchData
    ? `LIVE WEB RESEARCH (fetched ${new Date(researchData.fetchedAt).toUTCString()}):
${researchData.context}

SOURCE INDEX:
${sources.map((source) => `[${source.id}] ${source.title} — ${source.url}`).join('\n')}
`
    : options.researchRequested
      ? 'WEB RESEARCH: unavailable for this message (search failed). If current facts are needed, say the data may be outdated.\n'
      : 'WEB RESEARCH: disabled by the user. Answer from the sheet and general knowledge; flag anything that may be out of date.\n';

  return `You are the AI assistant inside a spreadsheet application. Today is ${today}.
Cells are addressed A1, B2, C10, ...

SPREADSHEET CONTEXT (non-empty cells, raw values):
${contextStr}

Selected cell: ${selectedCell || 'A1'}

${researchBlock}
RESPONSE RULES
1. Ground every factual claim in the research when research is provided. Cite sources inline as [1], [2] matching the SOURCE INDEX. Never invent names, numbers, prices, dates or rankings. If the sources do not contain the answer, say so plainly.
2. When the user asks for a list, ranking, comparison or table, output EXACTLY ONE GitHub-flavoured Markdown pipe table. The app previews it and asks the user to approve writing it into cells.
   - First row = column headers; one item per row; at most 20 data rows.
   - Use the units given in the sources; never convert currencies or invent an exchange rate.
   - Put the unit in the header (e.g. "Market cap (₹ crore)") and plain numbers in cells (1599546), without thousands separators.
   - Keep cells short (<= 40 characters).
   - Do NOT emit WRITE: lines for tables.
3. Do not add a "Sources" section; the app appends one. Use inline [n] citations only.
4. For a single-cell edit, respond with exactly one line: WRITE:CELL_ADDRESS=VALUE_OR_FORMULA
   Example: WRITE:B10=SUM(B2:B9)
5. For everything else, answer in at most 120 words using short paragraphs or bullets.
6. The user approves every change before it reaches the sheet, so never say a value, table or formula has been applied. Describe it as ready to write.
7. Be honest about uncertainty, missing data and freshness. Prefer "not available in the sources" over guessing.
`;
}

function collectContext(context) {
  const lines = [];
  let count = 0;
  for (const [addr, cell] of Object.entries(context.cells || {})) {
    if (cell.raw && String(cell.raw).trim() && count < 50) {
      lines.push(`${addr}: ${cell.raw}`);
      count++;
    }
  }
  return lines.length > 0 ? lines.join('\n') : '(empty sheet)';
}

function errorHint(status, provider) {
  if (provider === 'gemini') {
    if (status === 400) return ' (bad request — check the model name, e.g. gemini-3.8-flash)';
    if (status === 401 || status === 403) return ' (invalid or missing Gemini API key — get one at aistudio.google.com)';
    if (status === 402) return ' (this project is on a paid plan with no credit left — add credits, or disable billing on the project to return to the free tier. Free-tier projects do not return 402)';
    if (status === 429) return ' (rate limit / free-tier quota — wait a moment or try again)';
    if (status === 503) return ' (Google model temporarily overloaded — app retried with fallback models)';
  }
  if (provider === 'openrouter') {
    if (status === 401) return ' (invalid OpenRouter key — get one at openrouter.ai/keys)';
    if (status === 402) return ' (insufficient credits — a :free model or openrouter/free avoids this, or add credits at openrouter.ai)';
    if (status === 403) return ' (permission, guardrail, or moderation block — check the key at openrouter.ai/keys; a :free model also needs a non-negative balance)';
    if (status === 404) return ' (model not found — check the model name at openrouter.ai/models)';
  }
  if (provider === 'groq') {
    if (status === 401) return ' (invalid Groq API key — create a free key at console.groq.com/keys)';
    if (status === 403) return ' (Groq denied access — the key may be revoked or the model restricted)';
    if (status === 404) return ' (model not found or retired on Groq — the app will try another model)';
    if (status === 413) return ' (request too large — ask a narrower question or turn web research off)';
    if (status === 429) return ' (Groq rate limit — wait a few seconds and retry; free tier has per-minute limits)';
    if (status === 400) return ' (bad request — check the model name at console.groq.com/docs/models)';
  }
  return '';
}

function providerError(provider, status, body) {
  const label = PROVIDER_LABELS[provider] || provider;
  const err = new Error(
    `${label} error: ${status}${errorHint(status, provider)} ${String(body || '').slice(0, 280)}`.trim()
  );
  err.status = status;
  err.provider = provider;
  return err;
}

function networkError(provider, cause) {
  const err = new Error(
    `${PROVIDER_LABELS[provider] || provider} could not be reached (${cause?.message || cause})`
  );
  err.provider = provider;
  return err; // no status → another key/provider may still work
}

/* ---------- Model discovery ---------- */

// Model lists rarely change within a session; five minutes keeps the settings
// dialog responsive without hammering the provider.
const MODEL_LIST_TTL = 5 * 60 * 1000;
const modelListCache = new Map(); // `${provider}:${key}` → { t, models }

function isFreeOpenRouterModel(entry) {
  const id = String(entry?.id || '');
  if (id === 'openrouter/free' || /:free$/i.test(id)) return true;
  const prompt = Number(entry?.pricing?.prompt);
  const completion = Number(entry?.pricing?.completion);
  return Number.isFinite(prompt) && Number.isFinite(completion) && prompt === 0 && completion === 0;
}

// Returns [{ id, name, free }]. `free` is true (free on this provider),
// false (metered) or null (unknown — Gemini's free tier is project-scoped).
export async function listModels(provider = getProvider(), key = null) {
  const target = key || getApiKeys(provider)[0];
  if (!target) throw new Error('Add a key first — the model list comes from the provider.');

  const cacheKey = `${provider}:${target}`;
  const cached = modelListCache.get(cacheKey);
  if (cached && Date.now() - cached.t < MODEL_LIST_TTL) return cached.models;

  let models = [];

  if (provider === 'groq') {
    const res = await fetch(GROQ_MODELS_URL, {
      headers: { 'Authorization': 'Bearer ' + target },
    });
    if (!res.ok) throw providerError('groq', res.status, 'could not list models');
    const data = await res.json();
    models = (data.data || [])
      .filter((entry) => entry?.id && !/whisper|tts|guard|embed|moderation|playai/i.test(entry.id))
      .map((entry) => ({ id: entry.id, name: entry.id, free: true }));
  } else if (provider === 'openrouter') {
    const res = await fetch(OPENROUTER_MODELS_URL, {
      headers: { 'Authorization': 'Bearer ' + target },
    });
    if (!res.ok) throw providerError('openrouter', res.status, 'could not list models');
    const data = await res.json();
    models = (data.data || [])
      .filter((entry) => {
        if (!entry?.id) return false;
        const outputs = entry.architecture?.output_modalities;
        return !Array.isArray(outputs) || outputs.includes('text');
      })
      .map((entry) => ({
        id: entry.id,
        name: entry.name || entry.id,
        free: isFreeOpenRouterModel(entry),
      }));
  } else {
    const res = await fetch(`${GEMINI_MODELS_URL}?pageSize=1000`, {
      headers: { 'X-goog-api-key': target },
    });
    if (!res.ok) throw providerError('gemini', res.status, 'could not list models');
    const data = await res.json();
    models = (data.models || [])
      .filter((entry) => (entry.supportedGenerationMethods || []).includes('generateContent'))
      .map((entry) => {
        const id = String(entry.name || '').replace(/^models\//, '');
        return { id, name: entry.displayName || id, free: null };
      })
      .filter((entry) => entry.id);
  }

  models.sort((a, b) => {
    if (a.free !== b.free) return a.free === true ? -1 : b.free === true ? 1 : 0;
    return a.id.localeCompare(b.id);
  });

  modelListCache.set(cacheKey, { t: Date.now(), models });
  return models;
}

// Credit and free-request state for one OpenRouter key. Failing to read it is
// never fatal — the assistant works without the hint.
export async function openRouterAccount(key) {
  const res = await fetch(OPENROUTER_KEY_URL, {
    headers: { 'Authorization': 'Bearer ' + key },
  });
  if (!res.ok) throw providerError('openrouter', res.status, 'could not read key limits');
  const payload = await res.json();
  const info = payload?.data || {};
  return {
    freeTier: Boolean(info.is_free_tier),
    limit: info.limit ?? null,
    limitRemaining: info.limit_remaining ?? null,
    usage: info.usage ?? null,
    freeRequests: info.free_model_daily_requests || null,
  };
}

/* ---------- Sending messages ---------- */

// Try the key's model first, then fall back through the Gemini fallback chain.
// A model that is retired (404) or overloaded (503/429) is skipped; auth errors
// (400/401/402/403) abort this key so the caller can move to the next one.
async function geminiCall(prompt, generationConfig, systemPrompt, conn = null) {
  const key = conn?.key || apiKey;
  const preferred = conn?.model || getModel();
  const candidates = [...new Set([preferred, ...GEMINI_FALLBACKS])];
  const attempts = [];
  let lastStatus = null;

  for (const candidate of candidates) {
    const fullPrompt = systemPrompt ? systemPrompt + '\n\nUser: ' + prompt : prompt;
    let res;
    try {
      res = await fetch(geminiUrl(candidate), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': key,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: fullPrompt }] }],
          generationConfig,
        }),
      });
    } catch (netErr) {
      throw networkError('gemini', netErr);
    }

    if (res.ok) {
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (candidate !== preferred && (!conn || conn.provider === getProvider())) {
        console.log(`Gemini: primary model failed, used fallback ${candidate}`);
        setModel(candidate); // remember the working model
      }
      return text;
    }

    const errText = await res.text();
    attempts.push(`${candidate}: ${res.status}`);
    lastStatus = res.status;

    if (res.status === 400 || res.status === 401 || res.status === 402 || res.status === 403) {
      throw providerError('gemini', res.status, errText);
    }
    // Retired (404) / busy (503) / rate-limited (429) → try the next candidate
  }

  const err = providerError(
    'gemini',
    lastStatus || 503,
    `models unavailable: ${attempts.join(', ')}`
  );
  err.message += ' This is usually temporary Google load or free-tier quota — wait a minute and retry.';
  throw err;
}

/* ---------- Groq ---------- */

// Fetch the models this key can actually use. Cached per key for 10 minutes.
async function listGroqModels(key) {
  const cached = groqModelCache.get(key);
  if (cached && Date.now() - cached.t < 10 * 60 * 1000) {
    return cached.ids;
  }
  const res = await fetch(GROQ_MODELS_URL, {
    headers: { 'Authorization': 'Bearer ' + key },
  });
  if (!res.ok) throw providerError('groq', res.status, 'could not list models');
  const data = await res.json();
  const ids = (data.data || []).map((entry) => entry.id).filter(Boolean);
  groqModelCache.set(key, { t: Date.now(), ids });
  return ids;
}

// Order candidates: the key's model first, then known-good chat models that
// this key can actually access. Falls back to any chat-capable model.
async function pickGroqModels(conn) {
  const key = conn?.key || apiKey;
  const preferredModel = conn?.model || getModel();
  let available = [];
  try {
    available = await listGroqModels(key);
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw err;
    console.warn('Groq model discovery failed, using preferred list:', err.message);
  }

  const preferred = [...new Set([preferredModel, ...GROQ_PREFERRED].filter(Boolean))];

  if (!available.length) return preferred.slice(0, 3);

  const usable = available.filter((id) => !/whisper|tts|guard|embed|moderation|playai/i.test(id));
  const known = preferred.filter((id) => available.includes(id));
  if (known.length) return known;
  if (usable.length) return usable.slice(0, 3);
  return available.slice(0, 3);
}

async function groqCall(message, systemPrompt, { temperature = 0.2, maxTokens = 1800 } = {}, conn = null) {
  const key = conn?.key || apiKey;
  const preferred = conn?.model || getModel();
  const candidates = await pickGroqModels(conn);
  const attempts = [];
  let lastStatus = null;

  for (const candidate of candidates) {
    let res;
    try {
      res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + key,
        },
        body: JSON.stringify({
          model: candidate,
          messages: [
            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
            { role: 'user', content: message },
          ],
          temperature,
          max_tokens: maxTokens,
        }),
      });
    } catch (netErr) {
      throw networkError('groq', netErr);
    }

    if (res.ok) {
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || '';
      if (candidate !== preferred && (!conn || conn.provider === getProvider())) {
        console.log(`Groq: primary model failed, used ${candidate}`);
        setModel(candidate); // remember the working model
      }
      return text;
    }

    const errText = await res.text();
    attempts.push(`${candidate}: ${res.status}`);
    lastStatus = res.status;

    // Bad key / denied access: this key is done, try the next one.
    if (res.status === 401 || res.status === 403) {
      throw providerError('groq', res.status, errText);
    }
    // 400 (bad model/params), 404 (retired), 413 (too large), 429 (rate limit) → try the next model.
  }

  throw providerError('groq', lastStatus || 429, attempts.join(', '));
}

// A key with no credit fails a paid model with 402. Rather than giving up on
// the key, retry it down the free chain, then with the first :free model this
// key discovered for itself. The working model is remembered.
async function pickOpenRouterModels(conn) {
  const key = conn?.key || apiKey;
  const preferred = conn?.model || getModel();
  const candidates = [preferred, ...OPENROUTER_FALLBACKS];

  try {
    const models = await listModels('openrouter', key);
    const free = models.find((entry) => entry.free && !candidates.includes(entry.id));
    if (free) candidates.push(free.id);
  } catch (err) {
    console.warn('OpenRouter model discovery failed:', err.message);
  }

  return [...new Set(candidates.filter(Boolean))].slice(0, 6);
}

async function openRouterCall(message, systemPrompt, conn = null, { maxTokens = 1800 } = {}) {
  const key = conn?.key || apiKey;
  const preferred = conn?.model || getModel();
  const candidates = await pickOpenRouterModels(conn);
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: message });

  const attempts = [];
  let lastStatus = null;

  for (const candidate of candidates) {
    let res;
    try {
      res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + key,
          'HTTP-Referer': 'https://localhost:3000',
          'X-Title': 'AI Spreadsheet',
        },
        body: JSON.stringify({
          model: candidate,
          messages,
          temperature: 0.2,
          max_tokens: maxTokens + (OPENROUTER_REASONING[candidate] ? REASONING_HEADROOM : 0),
          ...(OPENROUTER_REASONING[candidate] ? { reasoning: { effort: OPENROUTER_REASONING[candidate] } } : {}),
        }),
      });
    } catch (netErr) {
      throw networkError('openrouter', netErr);
    }

    if (res.ok) {
      const data = await res.json();
      if (conn) {
        conn.model = candidate;
        conn.switchedModel = candidate !== preferred;
      }
      if (candidate !== preferred && (!conn || conn.provider === getProvider())) {
        console.log(`OpenRouter: ${preferred} unavailable, used ${candidate}`);
        setModel(candidate); // remember the free model that worked
      }
      return data.choices?.[0]?.message?.content || '';
    }

    const errText = await res.text();
    attempts.push(`${candidate}: ${res.status}`);
    lastStatus = res.status;

    // The key itself is unusable — another key or provider should try.
    if (res.status === 401 || res.status === 403) {
      throw providerError('openrouter', res.status, errText);
    }
    // 402 (no credit for this model), 404 (model retired), 400 (model
    // rejected) and 429 (this model's quota) all fall through to the next
    // candidate, which includes the free router.
  }

  throw providerError('openrouter', lastStatus || 402, attempts.join(', '));
}

/* ---------- Key pool dispatch ---------- */

const MAX_ATTEMPTS = 10;

// Selected provider's keys first, then every other provider that has keys.
function buildAttempts() {
  const active = getProvider();
  const order = [active, ...PROVIDERS.filter((provider) => provider !== active)];

  const attempts = [];
  for (const provider of order) {
    getApiKeys(provider).forEach((key, index) => {
      attempts.push({ provider, key, index, model: getModelFor(provider) });
    });
  }
  return attempts;
}

function callProvider(attempt, message, systemPrompt) {
  if (attempt.provider === 'gemini') {
    return geminiCall(message, { temperature: 0.2, maxOutputTokens: 1800 }, systemPrompt, attempt);
  }
  if (attempt.provider === 'groq') {
    return groqCall(message, systemPrompt, {}, attempt);
  }
  return openRouterCall(message, systemPrompt, attempt);
}

function summariseFailures(failures) {
  const unique = [];
  const seen = new Set();
  for (const err of failures) {
    const id = `${err.provider || '?'}:${err.status ?? 'network'}`;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(err);
  }

  const first = unique[0];
  const rest = unique.slice(1)
    .map((err) => `${PROVIDER_LABELS[err.provider] || err.provider} ${err.status ?? 'unreachable'}`);
  const suffix = rest.length ? ` Also tried: ${rest.join(', ')}.` : '';

  const err = new Error(`${String(first?.message || 'No AI provider answered').replace(/\.+$/, '')}.${suffix}`);
  err.failures = unique;
  return err;
}

export async function sendAIMessage(message, context, options = {}) {
  if (apiKey === null) loadFromProvider();
  const selected = getProvider();
  if (!isAIEnabled()) {
    throw new Error('AI not configured. Click 🔑 API Key to set it.');
  }

  let researchData = null;
  let researchError = null;

  if (options.research !== false) {
    try {
      researchData = await research(message, { onStatus: options.onStatus });
    } catch (err) {
      researchError = err.message || String(err);
      console.warn('Web research failed:', err);
      options.onStatus?.('⚠ Web research unavailable — answering from the sheet/model');
    }
  }

  const contextStr = collectContext(context);
  const systemPrompt = buildSystemPrompt(
    contextStr,
    context?.selectedCell,
    researchData,
    { researchRequested: options.research !== false }
  );

  const attempts = buildAttempts().slice(0, MAX_ATTEMPTS);
  const failures = [];

  for (const attempt of attempts) {
    try {
      const text = await callProvider(attempt, message, systemPrompt);
      return {
        text: text || '',
        research: researchData,
        researchError,
        provider: attempt.provider,
        model: attempt.model,
        fallback: attempt.provider !== selected,
        switchedModel: attempt.switchedModel === true,
        keyIndex: attempt.index,
      };
    } catch (err) {
      failures.push(err);
    }
  }

  throw summariseFailures(failures);
}

export async function testConnection() {
  if (apiKey === null) loadFromProvider();
  const attempts = buildAttempts().slice(0, MAX_ATTEMPTS);
  if (!attempts.length) throw new Error('No API key set. Add one above.');

  const results = [];
  for (const attempt of attempts) {
    try {
      const reply = await testAttempt(attempt);
      results.push({
        provider: attempt.provider,
        index: attempt.index,
        model: attempt.model,
        ok: true,
        reply: String(reply).trim().slice(0, 40),
      });
    } catch (err) {
      results.push({
        provider: attempt.provider,
        index: attempt.index,
        model: attempt.model,
        ok: false,
        status: err.status,
        message: err.message,
      });
    }
  }

  const working = results.filter((result) => result.ok);
  if (!working.length) {
    throw summariseFailures(results.map((result) => Object.assign(
      new Error(result.message),
      { provider: result.provider, status: result.status }
    )));
  }

  return { ok: working.length, total: results.length, results };
}

function testAttempt(attempt) {
  const ping = 'Reply with exactly: OK';
  if (attempt.provider === 'gemini') {
    return geminiCall(ping, { maxOutputTokens: 8 }, null, attempt);
  }
  if (attempt.provider === 'groq') {
    return groqCall(ping, 'You are a connection test. Reply with exactly: OK', { maxTokens: 8 }, attempt);
  }
  return openRouterCall(ping, null, attempt, { maxTokens: 8 });
}

export function parseAIResponse(text) {
  const raw = String(text || '');
  const tables = parseMarkdownTables(raw);

  const cleaned = textWithoutTables(raw)
    .replace(/WRITE:\s*[A-Z]+\d+\s*=\s*[^\n]+/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // A table is the strongest signal: the app writes it into the sheet.
  if (tables.length) {
    return { type: 'table', tables, text: cleaned };
  }

  const writeMatch = raw.match(/WRITE:\s*([A-Z]+\d+)\s*=\s*([^\n]+)/i);
  if (writeMatch) {
    return {
      type: 'write',
      cell: writeMatch[1].toUpperCase(),
      value: writeMatch[2].trim().replace(/^`+|`+$/g, ''),
      text: cleaned,
    };
  }

  return { type: 'text', text: raw };
}

export function getSheetContext(sheetName, cells, selectedCell) {
  return {
    sheet: sheetName,
    selectedCell,
    cells,
  };
}

export { updateApiBadge };
