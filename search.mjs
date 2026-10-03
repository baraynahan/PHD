import {
  existsSync,
  readFileSync,
  writeFileSync
} from "node:fs";

const RESULTS_FILE = "results.json";
const NOTIFIED_FILE = "notified.json";
const SOURCES_FILE = "sources.json";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ============================================================================
// PROVIDER CONFIGURATION
// Nothing about WHICH company/API is used is written in this file. Every
// provider is described only by GitHub Variables + Secrets, so switching
// provider = change the variables/secret, no code edits.
//
// There are three provider slots:
//
//   SEARCH_REVIEW_*  one AI that searches the web itself AND reviews the pages
//                    (pipeline 1)
//   SEARCH_*         a search-only API that returns links (pipeline 2, step 1)
//   REVIEW_*         an AI that only reviews/scores the pages found by SEARCH_*
//                    (pipeline 2, step 2)
//
// Per slot:
//   <SLOT>_NAME      label shown on the dashboard / Telegram (any text)
//   <SLOT>_BASE_URL  API link (base URL or the full endpoint URL)
//   <SLOT>_MODEL     model name (AI slots only)
//   <SLOT>_FORMAT    optional: how to talk to the API. Auto-detected from the
//                    link when empty.
//                      AI slots:    "gemini" (Google native API, with Google
//                                   Search grounding) or "openai"
//                                   (any OpenAI-compatible /chat/completions API)
//                      Search slot: "tavily", "serper" or "brave"
//   <SLOT>_API_KEY   secret
// ============================================================================

function envValue(name) {
  return String(process.env[name] || "").trim();
}

function detectFormat(baseUrl, kind) {
  const url = baseUrl.toLowerCase();
  if (kind === "search") {
    if (url.includes("serper")) return "serper";
    if (url.includes("brave")) return "brave";
    return "tavily";
  }
  // Google's own API (not its /openai compatibility endpoint) uses the native format.
  if (url.includes("generativelanguage.googleapis.com") && !url.includes("/openai")) return "gemini";
  return "openai";
}

function readProviderConfig(prefix, { kind = "ai", defaultName }) {
  const baseUrl = envValue(`${prefix}_BASE_URL`);
  const apiKey = envValue(`${prefix}_API_KEY`);
  const model = envValue(`${prefix}_MODEL`);
  const missing = [];
  if (!baseUrl) missing.push(`${prefix}_BASE_URL (variable)`);
  if (kind === "ai" && !model) missing.push(`${prefix}_MODEL (variable)`);
  if (!apiKey) missing.push(`${prefix}_API_KEY (secret)`);
  return {
    prefix,
    kind,
    name: envValue(`${prefix}_NAME`) || defaultName,
    baseUrl,
    apiKey,
    model,
    format: (envValue(`${prefix}_FORMAT`) || detectFormat(baseUrl, kind)).toLowerCase(),
    missing,
    configured: missing.length === 0
  };
}

const SEARCH_REVIEW = readProviderConfig("SEARCH_REVIEW", { kind: "ai", defaultName: "Search+Review AI" });
const SEARCH = readProviderConfig("SEARCH", { kind: "search", defaultName: "Search API" });
const REVIEW = readProviderConfig("REVIEW", { kind: "ai", defaultName: "Review AI" });

// Joins a base URL with an API path, unless the full endpoint was already given.
function endpointURL(baseUrl, path) {
  const base = baseUrl.replace(/\/+$/, "");
  return base.toLowerCase().endsWith(path.toLowerCase()) ? base : `${base}${path}`;
}

// The models don't know today's date on their own (they often think it's
// ~2024/2025), so they happily surface closed vacancies. Tell them explicitly.
const TODAY = new Date().toISOString().slice(0, 10);
const THIS_YEAR = Number(TODAY.slice(0, 4));
const DATE_CONTEXT = `
TODAY'S DATE IS ${TODAY}. Only positions whose application deadline is AFTER ${TODAY}
are useful. Prefer vacancies posted in the last 3 months and PhDs starting in
${THIS_YEAR} or ${THIS_YEAR + 1}. Ignore anything that closed before ${TODAY}.
`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

if (!SEARCH_REVIEW.configured && !(SEARCH.configured && REVIEW.configured)) {
  throw new Error(
    "No provider is fully configured. Set the SEARCH_REVIEW_* variables + secret, " +
    "and/or the SEARCH_* and REVIEW_* variables + secrets.\n" +
    `Missing for search+review provider: ${SEARCH_REVIEW.missing.join(", ") || "nothing"}\n` +
    `Missing for search provider: ${SEARCH.missing.join(", ") || "nothing"}\n` +
    `Missing for review provider: ${REVIEW.missing.join(", ") || "nothing"}`
  );
}

// Error text ends up in sources.json, which is published on GitHub Pages,
// so never let an API key or a wall of response JSON leak into it.
function safeErrorMessage(error) {
  let message = String(error?.message || error || "Unknown error");
  for (const secret of [SEARCH_REVIEW.apiKey, SEARCH.apiKey, REVIEW.apiKey, TELEGRAM_BOT_TOKEN]) {
    if (secret) message = message.split(secret).join("***");
  }
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

const CANDIDATE_PROFILE = `
The candidate is an Industrial Design graduate, university lecturer in
service design, sustainability educator, and design researcher.

The candidate's trajectory is:
PRODUCT DESIGN → SUSTAINABLE DESIGN → SUSTAINABLE CONSUMPTION →
PRODUCT LONGEVITY → CONSUMPTION SYSTEMS → OWNERSHIP / ACCESS →
POST-GROWTH / DEGROWTH → SOCIAL + POLITICAL TRANSFORMATION.

Strong interests include degrowth, post-growth, political economy,
sustainable consumption, alternative ownership/access, commons,
sufficiency, social practices, ecological/social transformation,
transition design, social design, service design, product-service
systems (PSS), systemic design, design justice, participatory/co-design,
governance, policy, sustainable lifestyles, consumption systems,
service systems, transition studies, alternative futures and critical design.

The candidate is comfortable with qualitative, theoretical, policy,
participatory and mixed-method research. A PhD does not need to be in
design and may be housed in sociology, political science, sustainability,
STS, environmental humanities or related fields.

Avoid projects whose central work is materials science, chemistry,
advanced engineering, manufacturing engineering, computational modelling,
data science, AI, technical optimisation or pure technical LCA.
`;

const GEOGRAPHY = `
Geography is a preference, not a research-fit filter:
- Tier 1 (highest priority): Netherlands, Belgium, Sweden, Denmark, Norway,
  Finland, United Kingdom, Germany, Italy, Switzerland and Austria.
- Tier 2: France, Ireland, Spain, Portugal, Luxembourg, Iceland and other
  European countries.
- Tier 3 (also wanted): Canada, Australia and New Zealand.
NEVER include positions in the United States.
`;

// Country -> tier, computed in code so the preference never depends on the model.
const TIER1 = ["netherlands","belgium","sweden","denmark","norway","finland","united kingdom","uk","england","scotland","wales","northern ireland","germany","italy","switzerland","austria"];
const TIER3 = ["canada","australia","new zealand"];
const EUROPE_OTHER = ["france","ireland","spain","portugal","luxembourg","iceland","estonia","latvia","lithuania","poland","czech republic","czechia","slovenia","slovakia","hungary","greece","croatia","malta","cyprus","romania","bulgaria","liechtenstein"];

function isUnitedStates(country) {
  const c = String(country || "").toLowerCase().replace(/\./g, "").trim();
  return /\b(united states|usa|us|america)\b/.test(c) && !/south america|latin america/.test(c);
}

function geoTier(country) {
  const c = String(country || "").toLowerCase().trim();
  const has = list => list.some(x => new RegExp(`\\b${x}\\b`).test(c));
  if (has(TIER1)) return 1;
  if (has(TIER3)) return 3;
  if (has(EUROPE_OTHER) || c.includes("europe")) return 2;
  return 4; // anywhere else (still allowed, lowest priority)
}

const SEARCH_STRATEGY = `
Search broadly rather than only for industrial design PhDs. Search
combinations involving design, sustainability, sustainable consumption,
degrowth, post-growth, post-consumerism, political economy, alternative
ownership, access, commons, sharing, sufficiency, transition design,
social design, design justice, governance, public policy, consumption
systems, service systems, product longevity, repair/reuse, sustainable
lifestyles, social practices, circular economy and societal/ecological
transformation.

Prioritise official university career/vacancy pages and official doctoral
position pages. The result must be a specific open PhD/doctoral vacancy,
not a generic programme.
`;

const RULES = `
Every result must be currently open, fully funded, have a specific PhD
project, a real application/vacancy page, and a verifiable future deadline.
Reject expired, self-funded, tuition-only, unclear-funding, generic,
unverifiable or United States positions.

For Canada, Australia and New Zealand, PhDs are often advertised as a funded
supervisor project or a project-linked scholarship (e.g. "HDR scholarship",
"Research Training Program stipend", "funded PhD project with Prof. X").
Accept these when the project/topic is specific, funding (stipend) is stated
and a dated application/scholarship deadline is given. Still reject generic
"apply to our PhD programme" pages without a specific project.

Always convert deadlines to ISO YYYY-MM-DD. Be careful: Canadian pages may use
month/day/year, European and Australian pages use day/month/year.

Score 0-100 using research-topic fit, degrowth/political/social fit,
sustainability, design compatibility, consumption/ownership/systems,
methods, candidate background and funding quality. Return only scores 60+.
Be strict: a position whose core topic is unrelated to the profile (e.g. auditing,
finance, AI/organisational studies, health, engineering) must score below 60 even if
it mentions sustainability once. Reserve 85+ for genuinely central fits.

IMPORTANT LANGUAGE AND IELTS RULES:
1. Determine the actual language of the PhD position/application.
2. Do NOT reject or filter a position because of its language.
3. If the position is not in English, explicitly mark it as "Not English".
4. If it is in English, mark it as "English".
5. If the language cannot be verified, mark it as "Unknown".
6. Search the university's official website for English-language / IELTS /
   English proficiency requirements for applicants to this PhD or the
   relevant doctoral programme.
7. Only report an IELTS requirement when it is supported by an official
   university source. Do not guess or infer a score.
8. If an official university source does not specify IELTS, write
   "Not specified on official university website".
9. Include the official university page URL used for the IELTS information
   when one was found.
10. An IELTS requirement is informational only and must never affect the
    score or eligibility filtering.
`;

const URL_INTEGRITY_RULE = `
CRITICAL URL RULE:
The "url" field must be copied EXACTLY, character-for-character, from the
specific search result / page you actually used for that listing. Do not
"clean up", shorten, guess, reconstruct, or normalise it into what you
think the university's vacancy page pattern usually looks like. Do not
substitute the university's generic careers homepage if you are not
certain it is the exact vacancy page. If you are not fully sure of the
exact URL, lower your confidence in that result rather than inventing or
tidying the URL.
`;

const OUTPUT_RULES = `
Return ONLY a valid JSON array. Every object MUST contain:
{
  "title": "...",
  "university": "...",
  "country": "...",
  "city": "...",
  "deadline": "YYYY-MM-DD",
  "url": "...",
  "funding": "...",
  "overall_score": 0,
  "why_it_matches": "...",
  "strategic_fit": "...",
  "application_language": "English | Not English | Unknown",
  "language_source_url": "...",
  "ielts_requirement": "...",
  "ielts_source_url": "...",
  "ai_provider": "...",
  "original_text": "The cleaned text captured directly from the vacancy page used for this result."
}

Use an empty string for source URLs when no official source was found.
The application/vacancy URL must be the real position page. Do not invent
information, dates, IELTS scores, language status or URLs.
`;

function normalizeURL(url) {
  if (!url) return "";
  try {
    const parsed = new URL(String(url).trim());
    parsed.hash = "";
    // Only strip tracking params. "ref"/"source" are left alone because some
    // vacancy portals use them as the actual vacancy ID.
    for (const param of [
      "utm_source", "utm_medium", "utm_campaign", "utm_term",
      "utm_content"
    ]) {
      parsed.searchParams.delete(param);
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return String(url).trim().replace(/\/$/, "");
  }
}

const MONTH_NUMBER = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};

function isRealCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function toISODate(year, month, day) {
  return isRealCalendarDate(year, month, day)
    ? `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    : "";
}

// We ask the model for YYYY-MM-DD, but real vacancy pages state dates in all
// sorts of formats, and a model won't always convert one perfectly. This is a
// safety net: it recognizes the ISO format we asked for, plus the handful of
// formats vacancy pages actually use, and normalizes them all to ISO. Text
// that isn't a real calendar date in a recognizable shape returns "" (the
// same as if no deadline were given at all).
function normalizeDeadline(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";

  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return toISODate(+m[1], +m[2], +m[3]);

  m = text.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/); // 31.01.2027 / 31/01/2027 (day-month-year, the common EU order)
  if (m) return toISODate(+m[3], +m[2], +m[1]);

  m = text.match(/^(\d{4})[./](\d{1,2})[./](\d{1,2})$/); // 2027/01/31
  if (m) return toISODate(+m[1], +m[2], +m[3]);

  m = text.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]+)\.?[\s,-]+(\d{4})$/); // 31 January 2027 / 31 Jan 2027
  if (m && MONTH_NUMBER[m[2].toLowerCase()]) return toISODate(+m[3], MONTH_NUMBER[m[2].toLowerCase()], +m[1]);

  m = text.match(/^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/); // January 31, 2027 / Jan 31 2027
  if (m && MONTH_NUMBER[m[1].toLowerCase()]) return toISODate(+m[3], MONTH_NUMBER[m[1].toLowerCase()], +m[2]);

  return "";
}

function isFutureDeadline(deadline) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(deadline || ""))) return false;
  const date = new Date(`${deadline}T23:59:59`);
  return Number.isFinite(date.getTime()) && date.getTime() > Date.now();
}


const SEARCH_REVIEW_ANGLES = [
  `Find currently open, funded PhD/doctoral vacancies (Europe first, see geography below) matching this profile:
${CANDIDATE_PROFILE}
Search broadly across ALL of these themes in one comprehensive Google Search pass:
degrowth, post-growth, post-consumerism, political economy, sustainable consumption,
product longevity, repair/reuse, circular economy, sustainable lifestyles, social practices,
consumption systems, alternative ownership/access, commons, sharing systems, sufficiency,
service systems, product-service systems, transition design, social design, design justice,
participatory/co-design, systemic design, critical design, alternative futures, governance,
public policy, transition studies, sustainability science, STS, sociology, political science
and environmental humanities where relevant. ${GEOGRAPHY}
Prioritise official university vacancy pages. Exclude generic programmes and expired positions.`,
  `Run a second independent search pass for currently open, funded PhD/doctoral vacancies matching this profile
(Europe first, see geography below):
${CANDIDATE_PROFILE}
Actively vary the search terms and look for opportunities that the first broad pass may miss,
especially positions using less obvious terminology around societal transformation, sustainable
lifestyles, consumption practices, ownership/access, commons, service systems, governance,
policy, social innovation and ecological transition. ${GEOGRAPHY}
Prioritise official university vacancy pages. Exclude generic programmes and expired positions.`
];

// Dedicated pass for Tier 3, so Europe results can't crowd these out.
const SEARCH_REVIEW_TIER3_ANGLES = [
  `Find currently open, funded PhD/doctoral projects or project-linked PhD scholarships in
CANADA, AUSTRALIA and NEW ZEALAND only (never the United States) matching this profile:
${CANDIDATE_PROFILE}
Themes: degrowth, post-growth, sustainable consumption, sufficiency, circular economy,
product longevity, repair/reuse, sharing/access-based consumption, commons, social practices,
transition design, social/service/systemic design, design justice, co-design, governance,
public policy, sustainability transitions, STS, sociology, political economy.
In Australia look for HDR / Research Training Program funded projects; in Canada look for
funded supervisor-advertised PhD projects and studentships.
Prioritise official university pages. Exclude generic programmes and expired positions.`,
  `Second pass for CANADA, AUSTRALIA and NEW ZEALAND only (never the United States): find funded
PhD projects/scholarships in sociology, geography, environmental studies, sustainability,
design, planning or political science departments on sustainable consumption, circular
economy, degrowth, sufficiency, social practices, sharing/commons, transitions or social design.
Include listings on findaphd.com, universityaffairs.ca, and official university HDR/graduate
scholarship pages. Exclude generic programmes and expired positions.`
];

const SEARCH_REVIEW_MAX_PAGES = 32;      // Europe-first pages
const TIER3_MAX_PAGES = 12;       // extra pages reserved for Canada/Australia/NZ
const PAGE_TEXT_CHARS = 24000;
const EXTRACTION_BATCH_SIZE = 8;
const SEARCH_REVIEW_CALL_GAP_MS = 6500;
const PAGE_USER_AGENT = "Mozilla/5.0 (compatible; PhD-Radar/1.0)";

// A search-only API takes literal search queries (not free-form instructions
// like an AI with its own search tool), so this is a fixed query list covering
// the same ground as SEARCH_STRATEGY + GEOGRAPHY.
const SEARCH_QUERIES = [
  "fully funded PhD position sustainable consumption",
  `PhD vacancy ${THIS_YEAR + 1} start sustainability consumption degrowth`,
  `doctoral position ${THIS_YEAR + 1} sustainability transitions social science Europe`,
  "open PhD vacancy degrowth post-growth Europe",
  "PhD position circular economy ownership access commons",
  "doctoral position sufficiency social practices sustainability",
  "PhD vacancy transition design social design justice",
  "fully funded PhD political economy sustainability transformation",
  "doctoral position product longevity repair reuse consumption",
  "PhD position service systems product-service systems sustainability",
  "open doctoral vacancy participatory co-design governance policy",
  "fully funded PhD Netherlands Sweden Denmark sustainability design",
  "PhD vacancy Germany UK Switzerland Austria sustainable consumption",
  "open PhD position alternative futures critical design sustainability",
  "fully funded PhD sustainable lifestyles social design Europe",
  "PhD vacancy sharing economy access-based consumption research",
  "doctoral vacancy systemic design service design sustainability",
  "PhD position societal transformation ecological transition Europe"
];

// Tier 3 queries (Canada / Australia / New Zealand), searched separately.
const SEARCH_TIER3_QUERIES = [
  `PhD scholarship ${THIS_YEAR + 1} sustainability consumption Australia findaphd`,
  `PhD position ${THIS_YEAR + 1} sustainability transitions Canada findaphd`,
  `funded PhD ${THIS_YEAR + 1} design sustainability Australia university scholarship closing date`,
  `PhD opportunity ${THIS_YEAR + 1} sustainability social science Canada universityaffairs.ca`,
  "funded PhD scholarship sustainable consumption Australia",
  "HDR scholarship degrowth circular economy sustainability Australia",
  "PhD project transition design social design Australia university",
  "funded PhD position sustainability transitions Canada",
  "PhD studentship sustainable consumption circular economy Canada university",
  "funded PhD social innovation design justice Canada",
  "PhD scholarship sustainability transitions consumption New Zealand"
];

const SEARCH_MAX_RESULTS_PER_QUERY = 10;
const SEARCH_CALL_GAP_MS = 600;
const REVIEW_MAX_PAGES = 32;
const REVIEW_CALL_GAP_MS = 3000;

async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal,
      headers: { "User-Agent": PAGE_USER_AGENT, "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8" } });
    const finalURL = normalizeURL(response.url || url);
    const contentType = String(response.headers.get("content-type") || "");
    if (!response.ok || !contentType.includes("text"))
      return { ok:false, url:finalURL, title:"", text:"", reason:`HTTP ${response.status} / ${contentType || "unknown content type"}` };
    const html = await response.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi," ").replace(/<svg[\s\S]*?<\/svg>/gi," ")
      .replace(/<[^>]+>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"')
      .replace(/&#39;/gi,"'").replace(/\s+/g," ").trim();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim() : "";
    return { ok:true, url:finalURL, title, text:text.slice(0,PAGE_TEXT_CHARS), reason:"" };
  } finally { clearTimeout(timeout); }
}

async function fetchHitPages(hits, maxPages = SEARCH_REVIEW_MAX_PAGES) {
  const pages=[], skipped=[], seen=new Set();
  for (const hit of hits) {
    const rawURL=normalizeURL(hit.url); if (!rawURL || seen.has(rawURL)) continue; seen.add(rawURL);
    try {
      const page=await fetchPage(rawURL);
      if (!page.ok || page.text.length<300) { skipped.push({...hit,reason:page.reason||"page too short"}); continue; }
      if (!/phd|ph\.d|doctoral|doctorate|doctor of philosophy|higher degree by research|\bhdr\b/i.test(page.text)) { skipped.push({...hit,reason:"not obviously doctoral"}); continue; }
      pages.push({...hit,...page,url:page.url||rawURL});
      if (pages.length>=maxPages) break;
    } catch(error) { skipped.push({...hit,reason:safeErrorMessage(error)}); }
  }
  return {pages,skipped};
}

// Fetches Europe-first pages and Tier 3 pages with separate budgets, so
// Canada/Australia/NZ always get a fair share of the reading budget.
async function gatherPages(mainHits, tier3Hits, mainMax) {
  const main = await fetchHitPages(mainHits, mainMax);
  const seen = new Set(main.pages.map(p => normalizeURL(p.url)));
  const tier3 = await fetchHitPages(tier3Hits.filter(h => !seen.has(normalizeURL(h.url))), TIER3_MAX_PAGES);
  const pages = [...main.pages, ...tier3.pages].map((page, index) => ({ ...page, id: index + 1 }));
  return { pages, skipped: [...main.skipped, ...tier3.skipped], tier3Count: tier3.pages.length };
}

// Attaches the page text and marks the URL as grounded when the model's URL
// matches a page we actually fetched (previously url_grounded was never set,
// so it was always false).
function attachPageData(items, batch) {
  return items.map(item => {
    const page = batch.find(p => normalizeURL(p.url) === normalizeURL(item.url));
    return { ...item, original_text: page?.text || "", url_grounded: Boolean(page) };
  });
}

// ---------------------------------------------------------------------------
// Generic AI call. Which API is used depends only on the provider config
// (BASE_URL / MODEL / FORMAT / API_KEY), never on code.
// ---------------------------------------------------------------------------
async function aiGenerate(provider, prompt, { useSearch = false } = {}) {
  if (!provider.configured) throw new Error(`${provider.name} is not configured (missing: ${provider.missing.join(", ")}).`);
  if (provider.format === "gemini") return geminiFormatGenerate(provider, prompt, useSearch);
  if (provider.format === "openai") return openaiFormatGenerate(provider, prompt);
  throw new Error(`${provider.prefix}_FORMAT "${provider.format}" is not supported. Use "gemini" or "openai".`);
}

// Google's native API. useSearch turns on Google Search grounding.
async function geminiFormatGenerate(provider, prompt, useSearch) {
  const base = provider.baseUrl.replace(/\/+$/, "");
  const endpoint = /:generatecontent$/i.test(base)
    ? base
    : `${base}/models/${encodeURIComponent(provider.model)}:generateContent`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    ...(useSearch ? { tools: [{ google_search: {} }] } : {}),
    generationConfig: { temperature: 0.1, responseMimeType: "text/plain" }
  };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": provider.apiKey },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `${provider.name} HTTP ${response.status}`);
  const text = (data?.candidates || []).flatMap(c => c?.content?.parts || []).map(p => p?.text || "").join("\n").trim();
  if (!text) throw new Error(`${provider.name} returned no text.`);
  return { text, data };
}

// Any OpenAI-compatible API (DeepSeek, OpenRouter, Groq, Mistral, apmix,
// Perplexity, OpenAI, Gemini's /openai endpoint, ...).
async function openaiFormatGenerate(provider, prompt) {
  const endpoint = endpointURL(provider.baseUrl, "/chat/completions");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `${provider.name} HTTP ${response.status}`);
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text) throw new Error(`${provider.name} returned no text.`);
  return { text, data };
}

// Pulls the real web pages an AI's built-in search used, whatever API shape
// the provider returns them in.
function collectGroundingHits(data) {
  const hits = [];
  const add = (url, title) => { if (url) hits.push({ title: String(title || url), url: String(url) }); };
  // Gemini native: grounding metadata
  for (const candidate of data?.candidates || []) {
    for (const chunk of candidate?.groundingMetadata?.groundingChunks || []) add(chunk?.web?.uri, chunk?.web?.title);
  }
  // OpenAI-compatible search models (e.g. Perplexity, OpenAI search models)
  for (const item of data?.search_results || []) add(item?.url, item?.title);
  for (const item of data?.citations || []) typeof item === "string" ? add(item) : add(item?.url, item?.title);
  for (const choice of data?.choices || []) {
    for (const ann of choice?.message?.annotations || []) add(ann?.url_citation?.url || ann?.url, ann?.url_citation?.title || ann?.title);
  }
  return hits;
}

async function searchReviewDiscover(angles = SEARCH_REVIEW_ANGLES, tag = "Europe-first") {
  console.log(`[${SEARCH_REVIEW.name}] web search discovery starting (${tag})...`);
  const allHits = [], seen = new Set();
  for (let i = 0; i < angles.length; i++) {
    if (i > 0) await sleep(SEARCH_REVIEW_CALL_GAP_MS);
    const prompt = `You are the discovery stage of a PhD vacancy radar.
${angles[i]}
${SEARCH_STRATEGY}
${RULES}
${DATE_CONTEXT}
Return a list of at least 20 relevant, CURRENTLY OPEN vacancy pages you found. Do not invent URLs.
The program will take URLs only from your web search tool's source metadata, not from your text.`;
    const { data } = await aiGenerate(SEARCH_REVIEW, prompt, { useSearch: true });
    for (const hit of collectGroundingHits(data)) {
      const url = normalizeURL(hit.url); if (!url || seen.has(url)) continue;
      seen.add(url); allHits.push({ ...hit, url });
    }
    console.log(`[${SEARCH_REVIEW.name}] ${tag} angle ${i + 1}/${angles.length}: ${allHits.length} unique hits so far`);
  }
  return allHits;
}

// --- Search-only API + review-only AI -------------------------------------
// The search API plays the same role the search+review AI's built-in search
// plays above: it turns queries into candidate URLs. Those URLs then go
// through the same fetchHitPages(), so the review AI reads real page text,
// not just a search snippet.

// Each search format returns its results in a different shape; all are
// normalised to [{ title, url }].
async function webSearch(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const n = SEARCH_MAX_RESULTS_PER_QUERY;
  try {
    let response, pick;
    if (SEARCH.format === "tavily") {
      response = await fetch(endpointURL(SEARCH.baseUrl, "/search"), {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SEARCH.apiKey}` },
        body: JSON.stringify({
          api_key: SEARCH.apiKey, query, search_depth: "advanced", max_results: n,
          include_answer: false, include_raw_content: false, time_range: "year"
        })
      });
      pick = data => (data.results || []).map(r => ({ title: r.title, url: r.url }));
    } else if (SEARCH.format === "serper") {
      response = await fetch(endpointURL(SEARCH.baseUrl, "/search"), {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-API-KEY": SEARCH.apiKey },
        body: JSON.stringify({ q: query, num: n, tbs: "qdr:y" })
      });
      pick = data => (data.organic || []).map(r => ({ title: r.title, url: r.link }));
    } else if (SEARCH.format === "brave") {
      const url = new URL(endpointURL(SEARCH.baseUrl, "/res/v1/web/search"));
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(Math.min(n, 20)));
      url.searchParams.set("freshness", "py");
      response = await fetch(url, {
        signal: controller.signal,
        headers: { "Accept": "application/json", "X-Subscription-Token": SEARCH.apiKey }
      });
      pick = data => (data.web?.results || []).map(r => ({ title: r.title, url: r.url }));
    } else {
      throw new Error(`SEARCH_FORMAT "${SEARCH.format}" is not supported. Use "tavily", "serper" or "brave".`);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.warn(`[${SEARCH.name}] error for query "${query}": ${response.status} ${safeErrorMessage(JSON.stringify(data))}`);
      return [];
    }
    return pick(data).filter(r => r.url);
  } catch (error) {
    if (String(error?.message || "").includes("SEARCH_FORMAT")) throw error;
    console.warn(`[${SEARCH.name}] request failed for query "${query}": ${safeErrorMessage(error)}`);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function searchDiscover(queries = SEARCH_QUERIES, tag = "Europe-first") {
  if (!SEARCH.configured) throw new Error(`${SEARCH.name} is not configured (missing: ${SEARCH.missing.join(", ")}).`);
  console.log(`[${REVIEW.name}] ${SEARCH.name} search discovery starting (${tag})...`);
  const allHits = [], seen = new Set();
  for (let i = 0; i < queries.length; i++) {
    if (i > 0) await sleep(SEARCH_CALL_GAP_MS);
    const query = queries[i];
    const results = await webSearch(query);
    for (const item of results) {
      const url = normalizeURL(item.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      allHits.push({ title: String(item.title || url).trim(), url });
    }
    console.log(`[${REVIEW.name}] ${tag} query ${i + 1}/${queries.length} ("${query}"): ${allHits.length} unique hits so far`);
  }
  return allHits;
}

// hasSearchTool=false swaps out the "you may use web search" line for one
// telling the review-only AI it only has the supplied page text.
function buildExtractionPrompt(pages, { hasSearchTool = true } = {}) {
  const pageBlocks=pages.map(page=>`--- PAGE ${page.id} ---
TITLE: ${page.title||""}
URL: ${page.url}
CONTENT:
${page.text}
--- END PAGE ${page.id} ---`).join("\n\n");

  const languageNote = hasSearchTool
    ? `For language and IELTS fields, prefer official university sources. You may use web search
if necessary to locate the relevant official university English/IELTS page, but never invent
a URL or IELTS score. If no official IELTS requirement can be established, use the required fallback.`
    : `For language and IELTS fields, prefer official university sources. You do not have web
search access beyond the page contents supplied below — do not guess or invent an IELTS
score or a source URL. If the supplied page content does not state an official IELTS
requirement, use the required fallback rather than guessing.`;

  return `You are the extraction and verification stage of a funded PhD vacancy radar (Europe first, plus Canada, Australia and New Zealand; never the United States).

${CANDIDATE_PROFILE}
${GEOGRAPHY}
${RULES}
${URL_INTEGRITY_RULE}
${OUTPUT_RULES}

Use the supplied page contents as primary evidence. A page is eligible only if it describes
one specific PhD/doctoral vacancy, doctoral research position or (Canada/Australia/NZ) a specific
funded PhD project / project-linked scholarship, funding is clearly stated,
and the application deadline is explicitly stated and still in the future (after ${TODAY}).
${DATE_CONTEXT}
Do not turn a generic programme, news article, lab page or directory into a vacancy.

For "url", copy the URL from the supplied PAGE header exactly.
${languageNote}

Return ONLY a JSON array. Do not use Markdown fences.

${pageBlocks}`;
}

async function extractBatch(pages) {
  const { text } = await aiGenerate(SEARCH_REVIEW, buildExtractionPrompt(pages, { hasSearchTool: true }), { useSearch: true });
  const parsed = extractJSON(text);
  if (!Array.isArray(parsed)) throw new Error(`${SEARCH_REVIEW.name} extraction response was not an array.`);
  return parsed;
}

async function extractReviewBatch(pages) {
  const { text } = await aiGenerate(REVIEW, buildExtractionPrompt(pages, { hasSearchTool: false }));
  const parsed = extractJSON(text);
  if (!Array.isArray(parsed)) throw new Error(`${REVIEW.name} extraction response was not an array.`);
  return parsed;
}


// Same checks cleanResults applies, but reports WHY each raw item was
// dropped instead of just dropping it. Used only for the one-line diagnostic
// printed when a provider returns items but none survive cleaning, so a
// silent "0 passed validation" always comes with a reason on the next run.
function explainRejection(item) {
  if (!item || typeof item !== "object") return "not an object";
  if (!String(item.title || "").trim()) return "missing title";
  if (!String(item.university || "").trim()) return "missing university";
  if (!String(item.country || "").trim()) return "missing country";
  if (isUnitedStates(item.country)) return "United States (excluded)";
  if (!normalizeURL(item.url)) return "missing/invalid url";
  const deadline = normalizeDeadline(item.deadline);
  if (!deadline) return `deadline not a recognizable date (got: ${JSON.stringify(item.deadline ?? "")})`;
  if (!isFutureDeadline(deadline)) return `deadline already passed (${deadline})`;
  const score = Number(item.overall_score);
  if (!Number.isFinite(score)) return `overall_score is not a number (got: ${JSON.stringify(item.overall_score ?? "")})`;
  if (score < 60) return `overall_score ${score} is below 60`;
  return "passes";
}

// Provider labels are whatever names are set in the variables, so any name
// works (old results keep the label they were saved with).
function providerLabelsOf(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const labels = raw.split(/\s+\+\s+/)
    .map(part => part.trim())
    .filter(part => part && part.toLowerCase() !== "unknown");
  return [...new Set(labels)];
}

function providerLabelOf(value) {
  return providerLabelsOf(value)[0] || "";
}

function mergeProviderLabels(a, b) {
  const labels = [...providerLabelsOf(a), ...providerLabelsOf(b)];
  return [...new Set(labels)].join(" + ") || "Unknown";
}

function normalizeIdentityText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^phd\s+(position|project|studentship|in)[:\-]?\s*/i, "")
    .replace(/\b(position|project|studentship|vacancy|doctoral|phd)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function resultIdentity(item) {
  const title = normalizeIdentityText(item.title);
  const university = normalizeIdentityText(item.university);
  const deadline = normalizeDeadline(item.deadline);
  return title && university && deadline
    ? `${university}|${title}|${deadline}`
    : normalizeURL(item.url);
}

function chooseBetterResult(a, b) {
  const scoreA = Number(a?.overall_score || 0);
  const scoreB = Number(b?.overall_score || 0);
  const verifiedA = a?.verification_status === "Verified";
  const verifiedB = b?.verification_status === "Verified";

  if (verifiedA !== verifiedB) return verifiedB ? b : a;
  if (scoreB > scoreA) return b;
  if (scoreA > scoreB) return a;

  const textA = String(a?.original_text || "");
  const textB = String(b?.original_text || "");
  return textB.length > textA.length ? b : a;
}

function mergeResultRecords(a, b) {
  const better = chooseBetterResult(a, b);
  const other = better === a ? b : a;
  const merged = {
    ...other,
    ...better,
    ai_provider: mergeProviderLabels(a.ai_provider, b.ai_provider),
    ai_model: [a.ai_model, b.ai_model].map(v => String(v || "").trim()).filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(" + "),
    original_text: String(better.original_text || other.original_text || "").trim(),
    url_grounded: Boolean(a.url_grounded || b.url_grounded),
    verification_status: a.verification_status === "Verified" || b.verification_status === "Verified" ? "Verified" : "Not verified"
  };
  if (!String(merged.verification_note || "").trim()) merged.verification_note = String(other.verification_note || "").trim();
  if (!String(merged.verification_url || "").trim()) merged.verification_url = normalizeURL(other.verification_url);
  if (!String(merged.ielts_source_url || "").trim()) merged.ielts_source_url = normalizeURL(other.ielts_source_url);
  if (!String(merged.language_source_url || "").trim()) merged.language_source_url = normalizeURL(other.language_source_url);
  return merged;
}

function cleanResults(results) {
  if (!Array.isArray(results)) return [];
  const byIdentity = new Map();

  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const title = String(item.title || "").trim();
    const university = String(item.university || "").trim();
    const country = String(item.country || "").trim();
    const city = String(item.city || "").trim();
    const deadline = normalizeDeadline(item.deadline);
    const url = normalizeURL(item.url);
    const score = Number(item.overall_score);
    if (!title || !university || !country || !url) continue;
    if (isUnitedStates(country)) continue; // hard block, never trust the prompt alone
    if (!isFutureDeadline(deadline)) continue;
    if (!Number.isFinite(score) || score < 60) continue;

    const language = ["English", "Not English", "Unknown"].includes(String(item.application_language || ""))
      ? String(item.application_language) : "Unknown";
    const provider = providerLabelsOf(item.ai_provider).join(" + ") || "Unknown";
    const candidate = {
      title, university, country, city, deadline, url,
      geo_tier: geoTier(country),
      funding: String(item.funding || "").trim(),
      overall_score: Math.round(score),
      why_it_matches: String(item.why_it_matches || item.fit_reason || "").trim(),
      original_text: String(item.original_text || "").trim(),
      strategic_fit: String(item.strategic_fit || "").trim(),
      why_it_is_not_perfect: String(item.why_it_is_not_perfect || "").trim(),
      supervisor: String(item.supervisor || "").trim(),
      classification: String(item.classification || "").trim(),
      research_area: String(item.research_area || "").trim(),
      application_language: language,
      language_source_url: normalizeURL(item.language_source_url),
      ielts_requirement: String(item.ielts_requirement || "Not specified on official university website").trim(),
      ielts_source_url: normalizeURL(item.ielts_source_url),
      ai_provider: provider,
      ai_model: String(item.ai_model || "").trim(),
      url_grounded: item.url_grounded === true,
      verification_status: ["Verified", "Not verified"].includes(String(item.verification_status || "")) ? String(item.verification_status) : "Not verified",
      verification_checked_at: String(item.verification_checked_at || "").trim(),
      verification_note: String(item.verification_note || "").trim(),
      verification_url: normalizeURL(item.verification_url)
    };
    const identity = resultIdentity(candidate);
    const previous = byIdentity.get(identity);
    byIdentity.set(identity, previous ? mergeResultRecords(previous, candidate) : candidate);
  }

  const cleaned = Array.from(byIdentity.values());
  // Highest score first; on equal scores Europe (tier 1, then 2) beats tier 3.
  cleaned.sort((a, b) =>
    b.overall_score - a.overall_score ||
    a.geo_tier - b.geo_tier ||
    new Date(a.deadline) - new Date(b.deadline));
  return cleaned;
}
// Unchanged on purpose: verification stays informational-only. Nothing here
// removes a result, it only labels it so you can judge for yourself.
async function verifyPosition(position) {
  const checkedAt = new Date().toISOString();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(position.url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "PhD-Radar/1.0 vacancy-check"
      }
    });
    clearTimeout(timeout);

    const finalURL = normalizeURL(response.url || position.url);
    const contentType = String(response.headers.get("content-type") || "");
    const body = contentType.includes("text/")
      ? (await response.text()).slice(0, 250000)
      : "";
    const text = body.toLowerCase();

    const phdSignal = /phd|ph\.d|doctoral|doctorate|doctor of philosophy|higher degree by research|\bhdr\b/.test(text);
    const vacancySignal = /vacancy|position|fellowship|scholarship|studentship|stipend|researcher|job opening|apply/.test(text);
    const titleWords = String(position.title || "")
      .toLowerCase()
      .split(/\W+/)
      .filter(word => word.length >= 5)
      .slice(0, 8);
    const titleSignal = titleWords.length === 0 ||
      titleWords.filter(word => text.includes(word)).length >= Math.min(2, titleWords.length);

    if (response.ok && phdSignal && vacancySignal && titleSignal) {
      return {
        verification_status: "Verified",
        verification_checked_at: checkedAt,
        verification_note: `HTTP ${response.status}; page contains PhD/doctoral and vacancy/position signals`,
        verification_url: finalURL
      };
    }

    return {
      verification_status: "Not verified",
      verification_checked_at: checkedAt,
      verification_note: response.ok
        ? "Page is reachable, but the automated content check could not confirm that it is a PhD vacancy page."
        : `HTTP ${response.status}`,
      verification_url: finalURL
    };
  } catch (error) {
    return {
      verification_status: "Not verified",
      verification_checked_at: checkedAt,
      verification_note: error?.name === "AbortError"
        ? "Verification timed out."
        : `Could not fetch page: ${String(error?.message || error)}`,
      verification_url: normalizeURL(position.url)
    };
  }
}

async function verifyResults(results) {
  console.log(`Verifying ${results.length} results (informational only; no results will be removed)...`);
  const verified = [];
  for (let i = 0; i < results.length; i += 5) {
    const batch = results.slice(i, i + 5);
    const checked = await Promise.all(batch.map(verifyPosition));
    for (let j = 0; j < batch.length; j++) {
      verified.push({ ...batch[j], ...checked[j] });
      console.log(
        `${checked[j].verification_status === "Verified" ? "✓" : "?"} ${batch[j].title}`
      );
    }
  }
  return verified;
}

function extractJSON(text) {
  let cleaned = String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const first = cleaned.indexOf("[");
  const last = cleaned.lastIndexOf("]");
  if (first !== -1 && last !== -1) {
    try {
      return JSON.parse(cleaned.slice(first, last + 1));
    } catch {}
  }

  throw new Error("Could not extract valid JSON from AI response.");
}

function loadJSON(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJSON(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

// Keep every provider's prior results (cleanResults already keys each entry
// by vacancy identity, so rows from different providers merge cleanly).
function loadExisting() {
  return cleanResults(loadJSON(RESULTS_FILE, []));
}

// Shared by both pipelines: open the pages, then have an AI review them.
async function reviewPages({ label, mainHits, tier3Hits, mainMax, gapMs, extract, hitsLabel }) {
  const hits = [...mainHits, ...tier3Hits];
  console.log(`[${label}] ${hits.length} distinct ${hitsLabel}. Opening the pages...`);

  const { pages, tier3Count } = await gatherPages(mainHits, tier3Hits, mainMax);
  console.log(`[${label}] ${pages.length} readable PhD-related pages (${tier3Count} Canada/Australia/NZ) of ${hits.length} hits; reading them now...`);

  const results = [];
  let failedBatches = 0;
  let batches = 0;
  for (let i = 0; i < pages.length; i += EXTRACTION_BATCH_SIZE) {
    if (i > 0) await sleep(gapMs);
    batches++;
    const batch = pages.slice(i, i + EXTRACTION_BATCH_SIZE);
    try {
      results.push(...attachPageData(await extract(batch), batch));
    } catch (error) {
      failedBatches++;
      console.warn(`[${label}] could not read pages ${batch[0].id}-${batch[batch.length - 1].id}: ${safeErrorMessage(error)}`);
    }
  }
  if (batches > 0 && failedBatches === batches) {
    throw new Error(`${label} found pages but could not read any of them.`);
  }

  const detail = `${hits.length} ${hitsLabel}, ${pages.length} readable pages, ` +
    `${results.length} qualified` +
    (failedBatches ? `, ${failedBatches}/${batches} read batches failed` : "");
  console.log(`[${label}] ${detail}`);

  return {
    results,
    sources: pages.map(page => ({ title: page.title || page.url, url: page.url })),
    detail
  };
}

// Pipeline 1: one AI searches the web itself and reviews the pages.
async function callSearchReviewProvider() {
  const mainHits = await searchReviewDiscover(SEARCH_REVIEW_ANGLES, "Europe-first");
  await sleep(SEARCH_REVIEW_CALL_GAP_MS);
  const tier3Hits = await searchReviewDiscover(SEARCH_REVIEW_TIER3_ANGLES, "Canada/Australia/NZ");
  if (!mainHits.length && !tier3Hits.length) {
    throw new Error(`${SEARCH_REVIEW.name} returned no web sources. This slot needs an AI with built-in web search.`);
  }
  return reviewPages({
    label: SEARCH_REVIEW.name, mainHits, tier3Hits, mainMax: SEARCH_REVIEW_MAX_PAGES,
    gapMs: SEARCH_REVIEW_CALL_GAP_MS, extract: extractBatch, hitsLabel: "search hits"
  });
}

// Pipeline 2: search-only API finds pages, review-only AI reviews them.
async function callSearchThenReviewProvider() {
  const mainHits = await searchDiscover(SEARCH_QUERIES, "Europe-first");
  const tier3Hits = await searchDiscover(SEARCH_TIER3_QUERIES, "Canada/Australia/NZ");
  if (!mainHits.length && !tier3Hits.length) throw new Error(`${SEARCH.name} search returned no results.`);
  return reviewPages({
    label: REVIEW.name, mainHits, tier3Hits, mainMax: REVIEW_MAX_PAGES,
    gapMs: REVIEW_CALL_GAP_MS, extract: extractReviewBatch, hitsLabel: `${SEARCH.name} hits`
  });
}

const PROVIDERS = [
  {
    id: "search_review",
    label: SEARCH_REVIEW.name,
    model: SEARCH_REVIEW.model,
    configured: SEARCH_REVIEW.configured,
    missing: SEARCH_REVIEW.missing,
    call: callSearchReviewProvider
  },
  {
    id: "search_then_review",
    label: REVIEW.name,
    model: `${REVIEW.model || "?"} (search: ${SEARCH.name})`,
    configured: SEARCH.configured && REVIEW.configured,
    missing: [...SEARCH.missing, ...REVIEW.missing],
    call: callSearchThenReviewProvider
  }
];

// Runs one provider and never throws: a failure is recorded on the returned
// object so the other provider's results are still kept.
async function runProvider(provider) {
  const run = {
    id: provider.id,
    label: provider.label,
    model: provider.model,
    status: "ok",
    error: "",
    returned: 0,
    detail: "",
    results: [],
    sources: []
  };

  if (!provider.configured) {
    run.status = "skipped";
    run.error = `not configured (missing: ${provider.missing.join(", ")})`;
    console.warn(`[${provider.label}] skipped: ${run.error}`);
    return run;
  }

  console.log(`[${provider.label}] starting (model: ${provider.model})`);
  try {
    const response = await provider.call();
    const rawResults = Array.isArray(response.results) ? response.results : [];
    run.returned = rawResults.length;
    run.sources = Array.isArray(response.sources) ? response.sources : [];
    run.detail = String(response.detail || "");
    run.results = cleanResults(
      rawResults.map(result => ({ ...result, ai_provider: provider.label }))
    );
    console.log(`[${provider.label}] returned ${run.returned} results, ${run.results.length} passed validation.`);
    if (run.returned > 0 && run.results.length === 0) {
      const reasons = rawResults.map(explainRejection);
      const tally = new Map();
      for (const reason of reasons) tally.set(reason, (tally.get(reason) || 0) + 1);
      console.log(`[${provider.label}] why none passed: ` +
        Array.from(tally, ([reason, count]) => `${count}x ${reason}`).join("; "));
    }
  } catch (error) {
    run.status = "failed";
    run.error = safeErrorMessage(error);
    console.error(`[${provider.label}] FAILED: ${run.error}`);
  }
  return run;
}

// Runs the selected providers at the same time.
async function callAllProviders() {
  const selected = PROVIDERS;
  console.log(`AI providers: ${selected.map(p => `${p.label} (${p.model})`).join(", ")}`);
  const runs = await Promise.all(selected.map(runProvider));

  if (!runs.some(run => run.status === "ok")) {
    throw new Error(
      "No AI provider succeeded: " +
      runs.map(run => `${run.label}: ${run.error || run.status}`).join(" | ")
    );
  }
  return runs;
}

async function sendTelegramMessage(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram secrets are not configured. Skipping Telegram.");
    return false;
  }
  const endpoint =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      disable_web_page_preview: false
    })
  });
  const data = await response.json();
  if (!data.ok) {
    console.error("Telegram API error:", JSON.stringify(data, null, 2));
    return false;
  }
  console.log("Telegram notification sent.");
  return true;
}

function formatTelegramMessage(position, foundBy = [position.ai_provider]) {
  const languageLine = position.application_language === "Not English"
    ? "⚠️ Language: Not English"
    : `🗣️ Language: ${position.application_language || "Unknown"}`;

  const groundingLine = position.url_grounded === false
    ? "⚠️ URL not confirmed in search results — double-check before applying\n"
    : "";

  return [
    `⭐ EXCEPTIONAL PhD MATCH — ${position.overall_score}/100`,
    "",
    `🎓 ${position.title}`,
    "",
    `🏛️ ${position.university}`,
    `🌍 ${position.country}${position.city ? ` · ${position.city}` : ""}`,
    `🤖 Found by: ${foundBy.filter(Boolean).join(" + ") || "Unknown"}`,
    languageLine,
    `📚 IELTS: ${position.ielts_requirement || "Not specified"}`,
    `📅 Deadline: ${position.deadline || "Not specified"}`,
    "",
    "💰 Funding:",
    position.funding || "Not specified",
    "",
    "🎯 Why it matches:",
    position.why_it_matches || "Strong match with your research profile.",
    "",
    "🧭 Strategic fit:",
    position.strategic_fit || "Strong alignment with your research trajectory.",
    "",
    groundingLine + "🔗 Apply:",
    position.url
  ].join("\n");
}

async function notifyExceptionalMatches(results) {
  const notified = loadJSON(NOTIFIED_FILE, {});
  let changed = false;

    const byURL = new Map();
  for (const position of results.filter(x => Number(x.overall_score) >= 90)) {
    const url = normalizeURL(position.url);
    const entry = byURL.get(url) || { best: position, providers: [] };
    if (Number(position.overall_score) > Number(entry.best.overall_score)) entry.best = position;
    if (!entry.providers.includes(position.ai_provider)) entry.providers.push(position.ai_provider);
    byURL.set(url, entry);
  }

  for (const [url, { best, providers }] of byURL) {
    const previousScore = Number(notified[url]?.score || 0);
    if (previousScore >= Number(best.overall_score)) continue;

    if (await sendTelegramMessage(formatTelegramMessage(best, providers))) {
      notified[url] = {
        score: Number(best.overall_score),
        notified_at: new Date().toISOString()
      };
      changed = true;
    }
  }

  if (changed) saveJSON(NOTIFIED_FILE, notified);
}

async function main() {
  console.log("======================================");
  console.log("PH D RADAR");
  console.log("======================================");

  const existingResults = loadExisting();
  console.log(`Existing active positions: ${existingResults.length}`);

  console.log(`Running new search across ${PROVIDERS.map(p => p.label).join(" + ")}...`);
  const runs = await callAllProviders();

  const sourcesByProvider = new Map(runs.map(run => [run.id, run.sources]));
  const allSourcesMap = new Map();
  for (const sources of sourcesByProvider.values()) {
    for (const source of sources) {
      if (source?.url) allSourcesMap.set(source.url, source);
    }
  }

  saveJSON(SOURCES_FILE, {
    searched_at: new Date().toISOString(),
    runs: runs.map(run => ({
      provider: run.label,
      model: run.model,
      status: run.status,
      error: run.error,
      returned: run.returned,
      valid: run.results.length,
      detail: run.detail,
      sources: run.sources.length
    })),
    sources: Array.from(allSourcesMap.values())
  });
  console.log(`Saved ${allSourcesMap.size} search sources across ${runs.length} provider(s).`);

  // Merge existing and new results by vacancy identity. When multiple
  // search systems find the same vacancy, they become one record and
  // ai_provider records all systems that found it.
  const merged = new Map();
  for (const result of existingResults) {
    const identity = resultIdentity(result);
    const previous = merged.get(identity);
    merged.set(identity, previous ? mergeResultRecords(previous, result) : result);
  }
  for (const run of runs) {
    for (const result of run.results) {
      const identity = resultIdentity(result);
      const previous = merged.get(identity);
      merged.set(identity, previous ? mergeResultRecords(previous, result) : result);
    }
  }
  const mergedResults = cleanResults(Array.from(merged.values()));

  // Verification stays informational-only: nothing is ever removed from
  // results.json based on verification_status or url_grounded. Both are
  // labels for you (and the site UI) to weigh.
  const verifiedResults = await verifyResults(mergedResults);
  saveJSON(RESULTS_FILE, verifiedResults);
  console.log(`Saved ${verifiedResults.length} active positions. Verification and grounding checks are informational only; no results were removed.`);

  await notifyExceptionalMatches(verifiedResults);

  for (const label of PROVIDERS.map(p => p.label)) {
    const mine = verifiedResults.filter(result => providerLabelsOf(result.ai_provider).includes(label));
    if (!mine.length && !runs.some(run => run.label === label)) continue;
    console.log(`\nTop matches — ${label}:`);
    for (const result of mine.slice(0, 10)) {
      const groundFlag = result.url_grounded === true ? "" : " [unconfirmed url]";
      console.log(
        `${result.overall_score}/100 | ${result.title} | ${result.university} | ${result.country} (tier ${result.geo_tier})${groundFlag}`
      );
    }
  }

  const failed = runs.filter(run => run.status !== "ok");
  if (failed.length) {
    console.warn(`\nNOTE: ${failed.map(run => `${run.label} ${run.status} (${run.error})`).join("; ")}`);
  }

  console.log("\nRadar complete.");
}

main().catch(error => {
  console.error("\nRADAR FAILED");
  console.error(error);
  process.exit(1);
});
