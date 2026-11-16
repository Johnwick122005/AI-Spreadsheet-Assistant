# AI Spreadsheet — Standalone Application

A complete, from-scratch spreadsheet application with Google Sheets/Excel-like functionality and built-in AI integration. Installable PWA, works online and offline, and the assistant can research the live web and — once you approve it — write a sourced table into the sheet.

## Design

The interface is a working paper: cool green-tinted paper, ink-green chrome and one red-ink accent. The assistant lives in the margin, separated from the sheet by a red rule. Libre Franklin carries the chrome, Source Serif 4 the assistant's prose, and Spline Sans Mono addresses and figures. All three typefaces are self-hosted for offline use.

## 📁 Files

| File | Purpose |
|------|---------|
| `index.html` | App shell — grid, toolbar, formula bar, AI margin |
| `style.css` | Working-paper design system — paper, ledger-green chrome, red margin rule |
| `fonts.css`, `fonts/` | Self-hosted Libre Franklin, Source Serif 4 and Spline Sans Mono (SIL OFL) |
| `app.js` | Main controller — sheets, toolbar, AI wiring, service worker registration |
| `engine.js` | Formula engine — tokenizer, evaluator, 22+ functions |
| `grid.js` | Grid rendering, cell editing, selection, calculations |
| `ai.js` | Provider integration — Groq, Gemini, OpenRouter; prompts and response parsing |
| `research.js` | Key-free web research — DuckDuckGo via r.jina.ai, Wikipedia API, table extraction |
| `markdown.js` | Safe Markdown rendering, pipe-table parsing, table → A1 cells |
| `storage.js` | Offline-first IndexedDB storage |
| `sw.js` | Service Worker — offline caching |
| `manifest.json` | PWA install manifest |

## 🚀 Quick Start

```powershell
cd C:\Users\prash\AI_Spreadsheet
npx serve .          # or: npm start
```

Open `http://localhost:3000`. Chrome/Edge will show an install icon in the address bar.

> The app uses ES modules and a service worker, so it must be served over `http://` or `https://`. Opening `index.html` directly from disk (`file://`) will not load it.

## 🔑 Setup AI

### Recommended — Groq (free key, no billing)

1. Create a free key at [console.groq.com/keys](https://console.groq.com/keys) (sign in with Google/GitHub; no card required).
2. In the app click **AI setup**.
3. Provider: **Groq** → paste the key (starts with `gsk_`).
4. Leave Model blank or enter `openai/gpt-oss-120b`.
5. Click **Test connection** — you should see `Connected — 1 of 1 keys answered`.

The app asks Groq which models the key can use and automatically falls back to another chat model if the default is retired or rate-limited. The Model field suggests the key's own model list as you type — leave it blank to use the free default.

> Free-tier caveat: Groq has per-minute and per-day token limits. If you see a 429, wait ~30 seconds and retry.

### Several keys at once

Each provider keeps an ordered list of keys. In **AI setup**, paste a key and press **Add key**; repeat for as many keys as you have. On every message the app tries:

1. every saved key for the selected provider, in order,
2. then every other provider that has keys.

A key that is out of quota (`429`), out of credit (`402`), revoked (`401`/`403`) or pointed at a missing model (`404`) is skipped. OpenRouter is checked once more before it is skipped: a `400`, `402` or `404` on a paid model retries the same key down the ordered free chain (see below). When a different provider answers, the reply is labelled `Assistant · Groq` so it is clear where it came from. **Test connection** checks every saved key and reports how many answered. A message makes at most 10 attempts.

Keys are masked in the dialog and never printed in full. Removing a key only removes it from this browser.

### Google Gemini — free tier, but scoped to the project

1. Go to [aistudio.google.com/api-keys](https://aistudio.google.com/api-keys) and create a key.
2. Provider: **Google Gemini** → paste key → Model: `gemini-3.8-flash` → **Test connection**.

The free tier covers only the models Google lists as free of charge, and it belongs to the key's **Google Cloud project**, not the key. If a billing account is attached, the project is a paid project: when its prepay balance reaches $0 every request returns `402`, including free models, and Google does not move the project back to the free tier automatically. Add credit, or disable billing on that project (AI Studio → Projects) to return to free.

`429` means the free-tier RPM/RPD/TPM quota is spent — limits are per project and reset at midnight Pacific. `403` means a key or project permission problem.

### OpenRouter — free models, no credit needed

1. Get a key from [openrouter.ai/keys](https://openrouter.ai/keys). No purchase is required for the free models.
2. Provider: **OpenRouter** → paste key → leave Model blank (defaults to `thinkingmachines/inkling-2-small:free`), or pick any id ending in `:free`.

The app requests OpenRouter's model list with your key, so the Model field autocompletes from what that key can actually use. Free models are listed first and the hint shows how many there are.

**Which free model.** Of the 17 free variants OpenRouter serves, three are worth using and the rest are not:

| Model | Why | Watch out |
| --- | --- | --- |
| `thinkingmachines/inkling-2-small:free` (default) | Best measured quality of any free model: AA Intelligence 30.6, AA-AnalystAgent 71.3% pass@1 (a spreadsheet-and-documents analysis benchmark), 73.3% non-hallucination, 1M context | Thinking is mandatory, so it is slow. The app sends `reasoning.effort: "low"` and an extra 1,200-token budget to keep it from thinking through the whole answer |
| `nvidia/nemotron-3.5-super-vl:free` | The fast option: ~290 tok/s over 11 endpoints, reasoning off by default, 1M context | AA Intelligence 13.6 and a ~30% hallucination rate, so check its numbers |
| `google/gemma-4-26b-a4b-it:free` | The most-requested free model (22M requests), 245 ms median latency, thinking off by default | Weaker instruction-following in non-reasoning mode (IFBench 45%) |

Avoid `inclusionai/ling-3.2-flash:free` (its only endpoint sustains ~16 tok/s, so a table takes a minute), `google/gemma-4-31b-it:free` (AA Intelligence 4), and the Nemotron 3.x reasoning models (index 6–12). `openrouter/free` is kept as the last fallback: it picks a random free model per request, so it answers, but the table style changes from call to call.

Free variants are capped at **20 requests/minute and 50/day**, rising to 1,000/day after $10 of lifetime credit purchases. Free capacity is shared, so a busy provider returns `429` or `503`; a negative account balance also blocks free models. `403` is a permission, guardrail or moderation block — not proof that a model is paid.

If the Model field holds a paid model and the key has no balance, OpenRouter answers `402`. The app does not surface that immediately: it retries the **same key** down the ordered free chain (`inkling-2-small`, `nemotron-3.5-super-vl`, `gemma-4-26b-a4b-it`, `openrouter/free`), then with the first `:free` model the key can see, and remembers whichever model answered. A client with a free-only key therefore gets an answer instead of a billing error.

### Choosing a model from the assistant

The assistant margin has a **Model** line under its title. Click it to open a list built from the provider's own model endpoint. Free models are listed first and tagged **Free**; type in the filter box to narrow the list; click a model to switch to it. **Provider default** returns to the built-in choice for that provider. Paid models are listed under **Paid / other** and need credit on the key — if one answers `402`, the app retries down the free chain instead of failing. The picker shows `Provider · model-id` and is updated whenever a key is added or removed, a provider is switched, or a fallback model answers. The choice is saved per provider and stays in sync with the Model field in **AI setup**.

### Saving or discarding an AI write

An AI write is a two-step decision. **Write to sheet** on the permission slip puts the table or value on the sheet, and a review strip then appears above the status bar: **Unsaved AI edit**, followed by what changed (for example `4 × 4 table → “Top 3 Indian Stocks by Market”`).

- **Save** persists the whole sheet set to this browser.
- **Discard** restores the sheets exactly as they were before the write, including removing any sheet the write created.
- The toolbar **Save** button also accepts a pending edit.
- Nothing is autosaved while an edit is pending, and leaving the page prompts first, so an undecided write cannot disappear silently.

> **Pollinations is no longer usable from browsers.** Its API now returns `403 {"error":"Missing Turnstile token"}` whenever an `Origin` header is present, so it was removed from the provider list.

## 🌐 Web Research

Web research is on by default (toggle **Web research on** in the AI margin). For each request:

1. Turns your prompt into a search query.
2. Searches DuckDuckGo HTML through the key-free [r.jina.ai](https://r.jina.ai) reader.
3. Falls back to the Wikipedia search API if search fails.
4. Reads the top pages, ranks the densest prose, and extracts structured tables.
5. Sends the brief to your AI provider, which must answer with one Markdown table and inline `[1]`, `[2]` citations.
6. The app shows that table in the margin and asks for permission. On **Write to sheet** it inserts at the selected cell — or into a new result sheet if the area already has data — and appends clickable sources to the chat.

Results are cached in `sessionStorage` for 20 minutes. No research API key is needed. Search queries and page URLs are sent to `r.jina.ai`, `html.duckduckgo.com`, and `en.wikipedia.org`; the research brief and your sheet context are sent to your AI provider.

## 🧮 Features

### Spreadsheet Engine
- A1 cell references (A1, B5, Z100, AA1, etc.)
- Range references (A1:A10, B2:D5)
- Formula bar with live editing
- Multiple sheets/tabs with dirty indicators
- Keyboard navigation (arrows, Tab, Enter)
- Double-click to edit cells inline
- Cycle detection (#CYCLE) and divide-by-zero protection (#DIV/0!)
- Auto-save on page unload
- Offline-first: auto-saves to IndexedDB

### Functions (22+)
SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, IF, AND, OR, NOT, ROUND, TEXT, TODAY, CONCATENATE, UPPER, LOWER, LEN, TRIM, ABS, INT

### Data & Persistence
- Offline-first: auto-saves to IndexedDB
- Auto-save on beforeunload
- Import/Export: .xlsx and .csv — import reads both header-row files and this app's own export layout, and asks before replacing a non-empty sheet
- PWA: installable as desktop/mobile app

### AI Integration
- **Key pool**: several keys per provider, tried in order, then the other providers — one exhausted free tier does not stop the assistant
- **Write permission**: every AI change — table, value, or formula — arrives as a permission slip in the margin. Nothing reaches the sheet until you press **Write to sheet**; **Keep in chat** leaves it in the transcript with a retry link.
- **AI Chat**: ask questions about your data in natural language
- **AI Formula**: describe what you want, get a formula proposed for the selected cell
- **AI Write**: AI can propose values/formulas for cells (`WRITE:CELL=VALUE`), applied only after you approve
- **AI Tables**: an approved Markdown table becomes real spreadsheet cells, with styled headers
- **New result sheet**: if the selected area is occupied, the table goes to its own sheet named from your prompt
- **Live web research**: sourced answers with inline `[n]` citations and clickable links
- **Quick Commands**: Sum column, Average, Get insights, Top stocks
- **Context-aware**: AI sees your current sheet data (limited to 50 cells for token efficiency)

## Example AI Commands
- "Make a table of the top 10 Indian stocks by market capitalisation, with rank, company, market cap and sector"
- "Sum column B and put the total in B10"
- "Calculate average of column C"
- "What insights can you draw from this data?"
- "Create a formula to categorize sales as High or Low"
- "Clean up duplicate entries in column A"

## ⚠️ Security

API keys are stored only in your browser's `localStorage`, in one list per provider. They are sent only to that provider's API directly from your browser — never to any other server. Web research sends your prompt-derived query and page URLs to the reader services listed above. Don't use confidential sheet data with free public endpoints.
