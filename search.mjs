import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";

const RESULTS_FILE = "results.json";
const NOTIFIED_FILE = "notified.json";
const SOURCES_FILE = "sources.json";
const SEEN_FILE = "seen.json";
const UNIVERSITIES_FILE = "universities.json";
const ARCHIVE_FILE = "archive.json";
const BLOCKED_FILE = "blocked.json";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CLEANUP_ONLY = String(process.env.CLEANUP_ONLY || "").toLowerCase() === "true";

// ============================================================================
// TUNABLE BUDGETS
// ============================================================================
function envInt(name, fallback) {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}
function envBool(name, fallback) {
  const v = String(process.env[name] || "").toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

const CFG = {
  MAX_PAGES:               envInt("MAX_PAGES", 120),
  TIER3_MAX_PAGES:         envInt("TIER3_MAX_PAGES", 40),
  // Budgets now apply to NEW / CHANGED pages only (already-reviewed pages are skipped).
  AI_REVIEW_BUDGET:        envInt("AI_REVIEW_BUDGET", 24),
  AI_REVIEW_BUDGET_TIER3:  envInt("AI_REVIEW_BUDGET_TIER3", 8),
  QUERIES_EU:              envInt("QUERIES_EU", 24),
  QUERIES_TIER3:           envInt("QUERIES_TIER3", 8),
  EXTRACTION_BATCH_SIZE:   Math.max(1, envInt("EXTRACTION_BATCH_SIZE", 4)),
  PAGE_TEXT_CHARS:         envInt("PAGE_TEXT_CHARS", 3200),
  SEARCH_RESULTS_PER_QUERY: Math.max(1, envInt("SEARCH_RESULTS_PER_QUERY", 8)),
  FETCH_CONCURRENCY:       Math.max(1, envInt("FETCH_CONCURRENCY", 6)),
  AI_CALL_GAP_MS:          envInt("AI_CALL_GAP_MS", 25000),
  AI_MAX_ATTEMPTS:         Math.max(1, envInt("AI_MAX_ATTEMPTS", 4)),
  AI_RETRY_BASE_DELAY_MS:  envInt("AI_RETRY_BASE_DELAY_MS", 20000),
  IELTS_LOOKUP_ENABLED:    envBool("IELTS_LOOKUP_ENABLED", false),
  IELTS_LOOKUP_MIN_SCORE:  envInt("IELTS_LOOKUP_MIN_SCORE", 90),
  IELTS_LOOKUP_MAX_PER_RUN: envInt("IELTS_LOOKUP_MAX_PER_RUN", 3),
  // Search API
  SEARCH_DEPTH:            String(process.env.SEARCH_DEPTH || "basic").toLowerCase(),      // basic = 1 credit, advanced = 2
  SEARCH_TIME_RANGE:       String(process.env.SEARCH_TIME_RANGE || "month").toLowerCase(), // day|week|month|year|none
  SEARCH_RAW_CONTENT:      envBool("SEARCH_RAW_CONTENT", true),                            // page text straight from the search API (bypasses 403s)
  // Review cache
  RECHECK_DAYS:            envInt("RECHECK_DAYS", 45),
  BACKLOG_PER_RUN:         envInt("BACKLOG_PER_RUN", 40),
  PRESCREEN_MIN_THEME:     envInt("PRESCREEN_MIN_THEME", 3),
  // Scoring gates (fit = topic+politics+design+methods, 0-80)
  MIN_FIT:                 envInt("MIN_FIT", 36),
  MIN_TOPIC:               envInt("MIN_TOPIC", 8),
  MIN_OVERALL:             envInt("MIN_OVERALL", 50)
};

// ============================================================================
// PROVIDER CONFIGURATION
// ============================================================================
function envValue(name) { return String(process.env[name] || "").trim(); }

function detectFormat(baseUrl, kind) {
  const url = baseUrl.toLowerCase();
  if (kind === "search") {
    if (url.includes("serper")) return "serper";
    if (url.includes("brave")) return "brave";
    return "tavily";
  }
  if (url.includes("generativelanguage.googleapis.com") && !url.includes("/openai")) return "gemini";
  return "openai";
}

function readProviderConfig(prefix, { kind = "ai", defaultName }) {
  const baseUrl = envValue(`${prefix}_BASE_URL`);
  const apiKey = envValue(`${prefix}_API_KEY`);
  // *_MODEL may be a comma-separated list: calls are spread round-robin across the models,
  // so per-model rate limits are shared instead of exhausted one by one.
  const models = envValue(`${prefix}_MODEL`).split(",").map(s => s.trim()).filter(Boolean);
  const model = models[0] || "";
  const missing = [];
  if (!baseUrl) missing.push(`${prefix}_BASE_URL (variable)`);
  if (kind === "ai" && !model) missing.push(`${prefix}_MODEL (variable)`);
  if (!apiKey) missing.push(`${prefix}_API_KEY (secret)`);
  return {
    prefix, kind,
    name: envValue(`${prefix}_NAME`) || defaultName,
    baseUrl, apiKey, model, models,
    format: (envValue(`${prefix}_FORMAT`) || detectFormat(baseUrl, kind)).toLowerCase(),
    missing,
    configured: missing.length === 0
  };
}

const SEARCH_REVIEW = readProviderConfig("SEARCH_REVIEW", { kind: "ai", defaultName: "Search+Review AI" });
const SEARCH = readProviderConfig("SEARCH", { kind: "search", defaultName: "Search API" });
const REVIEW = readProviderConfig("REVIEW", { kind: "ai", defaultName: "Review AI" });
const OPENROUTER = readProviderConfig("OPENROUTER", { kind: "ai", defaultName: "OpenRouter fallback" });

function endpointURL(baseUrl, path) {
  const base = baseUrl.replace(/\/+$/, "");
  return base.toLowerCase().endsWith(path.toLowerCase()) ? base : `${base}${path}`;
}

const TODAY = new Date().toISOString().slice(0, 10);
const THIS_YEAR = Number(TODAY.slice(0, 4));
const DATE_CONTEXT = `
TODAY'S DATE IS ${TODAY}. Only positions whose application deadline is AFTER ${TODAY}
are useful. Prefer vacancies posted in the last 3 months and PhDs starting in
${THIS_YEAR} or ${THIS_YEAR + 1}. Ignore anything that closed before ${TODAY}.
`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

if (process.env.SELF_TEST !== "true" && (!SEARCH.configured || !REVIEW.configured)) {
  throw new Error(
    "The primary free pipeline requires SEARCH_* (search API) and REVIEW_* (AI reviewer). " +
    "SEARCH_REVIEW_* is optional and is used only as an AI extraction fallback.\n" +
    `Missing for SEARCH: ${SEARCH.missing.join(", ") || "nothing"}\n` +
    `Missing for REVIEW: ${REVIEW.missing.join(", ") || "nothing"}`
  );
}

function safeErrorMessage(error) {
  let message = String(error?.message || error || "Unknown error");
  for (const secret of [SEARCH_REVIEW.apiKey, SEARCH.apiKey, REVIEW.apiKey, OPENROUTER.apiKey, TELEGRAM_BOT_TOKEN]) {
    if (secret) message = message.split(secret).join("***");
  }
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

function isQuotaError(error) {
  const m = String(error?.message || error || "").toLowerCase();
  // Only hard limits (daily quota / credits / billing) disable a model for the whole run.
  // Per-minute 429 / RESOURCE_EXHAUSTED is an ordinary rate limit and is retried with backoff.
  const hard = /insufficient_quota|out of credits|billing|exceeded your current quota|per ?day|perday|daily|limit: 0/;
  const soft = /per ?minute|perminute|rate.?limit|try again in|retry in|too many requests/;
  return hard.test(m) && !soft.test(m);
}

// ============================================================================
// PROFILE / GEOGRAPHY / RULES
// ============================================================================
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
  return 4;
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
project, and a real application/vacancy page. Positions with no fixed
deadline ("open until filled", "rolling basis", "applications reviewed
continuously") are eligible — set deadline_type="rolling". Positions whose
deadline is simply not stated in the page text are also eligible — set
deadline_type="unknown" and leave "deadline" empty. Do NOT reject a good
match just because a deadline is missing.

For Canada, Australia and New Zealand, PhDs are often advertised as a funded
supervisor project or a project-linked scholarship (e.g. "HDR scholarship",
"Research Training Program stipend", "funded PhD project with Prof. X").
Accept these when the project/topic is specific and funding (stipend) is stated.
Still reject generic "apply to our PhD programme" pages without a specific project.

Always convert deadlines to ISO YYYY-MM-DD when one is given. Be careful:
Canadian pages may use month/day/year, European and Australian pages use
day/month/year.

Do not reject a position because of its language (the program detects the language itself).
`;

const URL_INTEGRITY_RULE = `
CRITICAL URL RULE:
Every page supplied to you below already has a "page_id" and a URL in its
header. Do NOT invent, guess, clean up, shorten, or normalise URLs. Your
"url" field MUST be copied character-for-character from the PAGE header
whose "page_id" you are citing. If you are not fully sure of the exact
URL, still copy the PAGE header URL verbatim — never a different one.
`;

const OUTPUT_RULES = `
Return ONLY a valid JSON array (no Markdown fences). Include one object per page that is a specific
PhD/doctoral vacancy; omit pages that are not. Use "" for anything you cannot determine. Never invent data.
{"page_id":<int>,"title":"","university":"","country":"","city":"",
 "deadline":"YYYY-MM-DD or empty","deadline_type":"dated|rolling|unknown",
 "start_date":"","funding":"<short>","supervisor":"","research_area":"<few words>",
 "topic_fit":0,"politics_fit":0,"design_fit":0,"methods_fit":0,"funding_quality":0,
 "why_it_matches":"<ONE sentence>","eligible":true,"reject_reason":""}

Each score is 0-20:
- topic_fit: 20 = core theme of the candidate; 15 = strong overlap; 10 = related but peripheral; 5 = tangential; 0 = unrelated.
- politics_fit: 20 = degrowth/post-growth/political economy is the core; 15 = strong; 10 = adjacent; 0 = absent.
- design_fit: 20 = design-led (design/service/systemic/transition/social design); 15 = design methods named; 5 = passing; 0 = none.
- methods_fit: 20 = qualitative/participatory/theoretical fits perfectly; 15 = compatible; 0 = purely quantitative/computational/experimental.
- funding_quality: 15-20 = funded, stipend/salary/duration stated; 8-10 = unclear; 0-5 = none mentioned.
A clearly unrelated position (auditing, finance, AI, health, engineering) must have topic_fit <= 4 even if "sustainability" is mentioned once.
`;

// ============================================================================
// URL / DATE HELPERS
// ============================================================================
function normalizeURL(url) {
  if (!url) return "";
  try {
    const parsed = new URL(String(url).trim());
    parsed.hash = "";
    for (const param of ["utm_source","utm_medium","utm_campaign","utm_term","utm_content"]) {
      parsed.searchParams.delete(param);
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return String(url).trim().replace(/\/$/, "");
  }
}

const MONTH_NUMBER = {
  jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,
  may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,
  sep:9,sept:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12
};

function isRealCalendarDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}
function toISODate(year, month, day) {
  return isRealCalendarDate(year, month, day)
    ? `${String(year).padStart(4,"0")}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`
    : "";
}

const DATE_NOISE = /\b(deadline|closing date|closes|close|apply by|applications? by|application|until|before|at|midnight|noon|cet|cest|eet|utc|gmt|bst|aest|aedt|nzst|local time|time)\b|\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?/gi;

function inferYear(month, day) {
  const candidate = toISODate(THIS_YEAR, month, day);
  return candidate && candidate > TODAY ? THIS_YEAR : THIS_YEAR + 1;
}

function normalizeDeadline(raw, { dayFirst = true } = {}) {
  const text = String(raw || "")
    .replace(DATE_NOISE, " ")
    .replace(/[,;()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  let m;

  if ((m = text.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/)))
    return toISODate(+m[1], +m[2], +m[3]);

  if ((m = text.match(/(\d{1,2})[-./](\d{1,2})[-./](\d{4})/))) {
    const a = +m[1], b = +m[2];
    if (a > 12) return toISODate(+m[3], b, a);
    if (b > 12) return toISODate(+m[3], a, b);
    return dayFirst ? toISODate(+m[3], b, a) : toISODate(+m[3], a, b);
  }

  if ((m = text.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?(?:\s+(\d{4}))?/))) {
    const mon = MONTH_NUMBER[m[2].toLowerCase()];
    if (mon) return toISODate(+(m[3] || inferYear(mon, +m[1])), mon, +m[1]);
  }

  if ((m = text.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?/))) {
    const mon = MONTH_NUMBER[m[1].toLowerCase()];
    if (mon) return toISODate(+(m[3] || inferYear(mon, +m[2])), mon, +m[2]);
  }

  return "";
}

function isFutureDeadline(deadline) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(deadline || ""))) return false;
  const d = new Date(`${deadline}T23:59:59`);
  return Number.isFinite(d.getTime()) && d.getTime() > Date.now();
}

const ROLLING_RE = /open until filled|until the position is filled|rolling (basis|deadline|review)|continuous (basis|intake|review)|applications? (are )?reviewed (on a )?(continuous|rolling)|no (fixed |set )?deadline|as soon as possible|ongoing recruitment|applications? (are )?welcome at any time/i;

// ============================================================================
// FETCHING
// ============================================================================
const HOST_GAP_MS = 1200;
const FETCH_CONCURRENCY = CFG.FETCH_CONCURRENCY;
const MAX_PAGES = CFG.MAX_PAGES;
const TIER3_MAX_PAGES = CFG.TIER3_MAX_PAGES;
const PAGE_TEXT_CHARS = CFG.PAGE_TEXT_CHARS;
const PAGE_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function mapPool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const hostChain = new Map();
function perHost(url, task) {
  let host;
  try { host = new URL(url).host; } catch { host = "invalid"; }
  const prev = hostChain.get(host) || Promise.resolve();
  const run = prev.then(task, task);
  hostChain.set(host, run.then(() => sleep(HOST_GAP_MS), () => sleep(HOST_GAP_MS)));
  return run;
}

function flattenLd(node, out = []) {
  if (Array.isArray(node)) node.forEach(n => flattenLd(n, out));
  else if (node && typeof node === "object") {
    out.push(node);
    if (node["@graph"]) flattenLd(node["@graph"], out);
  }
  return out;
}

function extractJobPosting(html) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      for (const node of flattenLd(JSON.parse(m[1].trim()))) {
        const t = node["@type"];
        const types = Array.isArray(t) ? t : [t];
        if (types.some(x => String(x).toLowerCase() === "jobposting")) {
          return {
            title: node.title || "",
            organization: node.hiringOrganization?.name || "",
            country: node.jobLocation?.address?.addressCountry?.name
                  || node.jobLocation?.address?.addressCountry || "",
            city: node.jobLocation?.address?.addressLocality || "",
            posted: node.datePosted || "",
            validThrough: node.validThrough || "",
            employmentType: node.employmentType || ""
          };
        }
      }
    } catch {}
  }
  return null;
}

function decodeEntities(s) {
  return s.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return " "; } })
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return " "; } });
}

function extractMainText(html) {
  let body = (html.match(/<body[\s\S]*<\/body>/i) || [html])[0];
  body = body.replace(/<(script|style|noscript|svg|nav|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
  const main = body.match(/<main[\s\S]*?<\/main>/i) || body.match(/<article[\s\S]*?<\/article>/i);
  const source = main && main[0].length > 800 ? main[0] : body;
  return decodeEntities(source.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

// Markdown returned by the search API (include_raw_content) -> plain text
function mdToText(md) {
  return String(md || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#*_>`|]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

// Compact page digest for the AI: the beginning (title / topic) + windows around deadline, funding, supervisor...
const DIGEST_ANCHORS = /deadline|closing date|closes on|apply by|application (?:deadline|period)|applications? (?:must|are due|close)|stipend|salary|gross|fully funded|funding|scholarship|start date|starting date|commencement|supervis|promotor|\bfte\b|bewerbung|frist|sluitingsdatum|solliciteren|ansökan|søknadsfrist|ansøgningsfrist|hakuaika|scadenza/ig;
function buildDigest(fullText, max) {
  const text = String(fullText || "");
  if (text.length <= max) return text;
  const headLen = Math.floor(max * 0.45);
  const parts = [text.slice(0, headLen)];
  const covered = [[0, headLen]];
  let used = headLen, windows = 0;
  const re = new RegExp(DIGEST_ANCHORS.source, "ig");
  let m;
  while ((m = re.exec(text)) && used < max && windows < 10) {
    const s = Math.max(0, m.index - 170), e = Math.min(text.length, m.index + 170);
    if (covered.some(([a, b]) => s < b && e > a)) continue;
    covered.push([s, e]);
    parts.push(text.slice(s, e));
    used += e - s;
    windows++;
  }
  return parts.join(" … ").slice(0, max);
}

const LANG_WORDS = {
  en: ["the", "and", "of", "to", "for", "with", "will", "is", "you", "our"],
  nl: ["de", "het", "een", "van", "voor", "en", "met", "wij", "je", "ons"],
  de: ["der", "die", "und", "das", "für", "mit", "wir", "ein", "sie", "ihre"],
  sv: ["och", "att", "för", "som", "med", "vi", "är", "du", "en", "det"],
  no: ["og", "å", "til", "som", "med", "vi", "er", "du", "en", "det"],
  da: ["og", "at", "til", "som", "med", "vi", "er", "du", "en", "det"],
  fi: ["ja", "on", "ole", "että", "työ", "sekä", "tai", "hakija", "ei", "kanssa"],
  it: ["il", "di", "che", "per", "con", "una", "della", "sono", "e", "dei"],
  fr: ["le", "la", "les", "des", "et", "pour", "avec", "une", "du", "est"],
  es: ["el", "los", "las", "de", "y", "para", "con", "una", "por", "del"]
};
function detectLanguage(text) {
  const words = String(text || "").slice(0, 5000).toLowerCase().replace(/[^\p{L}\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (words.length < 40) return "Unknown";
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  const score = {};
  for (const [lang, list] of Object.entries(LANG_WORDS)) score[lang] = list.reduce((a, w) => a + (freq.get(w) || 0), 0);
  const best = Object.entries(score).filter(([l]) => l !== "en").sort((a, b) => b[1] - a[1])[0];
  if (score.en >= 12 && score.en >= best[1] * 1.5) return "English";
  if (best[1] >= 12 && best[1] >= score.en * 1.5) return "Not English";
  return "Unknown";
}

function contentHash(text) {
  const norm = String(text || "").toLowerCase().replace(/\d+/g, "").replace(/[^\p{L}]+/gu, " ").slice(0, 6000);
  return createHash("sha1").update(norm).digest("hex").slice(0, 16);
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": PAGE_USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9"
      }
    });
    const finalURL = normalizeURL(response.url || url);
    const contentType = String(response.headers.get("content-type") || "");
    if (!response.ok || !contentType.includes("text")) {
      return { ok: false, url: finalURL, title: "", text: "", fullText: "", jobPosting: null, reason: `HTTP ${response.status} / ${contentType || "unknown content type"}` };
    }
    const html = await response.text();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : "";
    const jobPosting = extractJobPosting(html);
    const fullText = extractMainText(html).slice(0, 24000);
    return { ok: true, url: finalURL, title, fullText, text: buildDigest(fullText, PAGE_TEXT_CHARS), jobPosting, reason: "" };
  } finally {
    clearTimeout(timeout);
  }
}

const DOCTORAL_RE = /phd|ph\.d|doctoral|doctorate|doctor of philosophy|higher degree by research|\bhdr\b|promotion|promovend|doktorand|doktorgrad|stipendiat|doctorant|dottorat|tohtori|väitös|predoctoral|early.stage researcher|\besr\b/i;

// Hosts that block datacenter IPs (GitHub Actions): use the text delivered by the search API instead of fetching.
const RAW_FIRST_HOSTS = /(^|\.)(findaphd\.com|jobs\.ac\.uk|jobbnorge\.no|academicpositions\.[a-z.]+|universityaffairs\.ca)$/;
const hostFailStreak = new Map();
const fetchStats = { raw_used: 0, circuit_skipped: 0 };
function hostOf(url) { try { return new URL(url).host.toLowerCase(); } catch { return "invalid"; } }

function pageFromRaw(hit) {
  const fullText = mdToText(hit.raw).slice(0, 24000);
  if (fullText.length < 300) return null;
  return { ok: true, url: hit.url, title: hit.title || "", fullText, text: buildDigest(fullText, PAGE_TEXT_CHARS), jobPosting: null, reason: "", fromRaw: true };
}

async function loadPage(hit) {
  const host = hostOf(hit.url);
  const raw = hit.raw ? pageFromRaw(hit) : null;
  const streak = hostFailStreak.get(host) || 0;
  const strip = { raw: undefined };
  if (raw && (RAW_FIRST_HOSTS.test(host) || streak >= 3)) { fetchStats.raw_used++; return { ...hit, ...raw, ...strip }; }
  if (!raw && streak >= 3) { fetchStats.circuit_skipped++; return { ...hit, ...strip, ok: false, reason: "host blocks automated fetches (circuit open)" }; }
  try {
    const page = await fetchPage(hit.url);
    if (page.ok && page.fullText.length >= 300) { hostFailStreak.set(host, 0); return { ...hit, ...page, ...strip }; }
    hostFailStreak.set(host, streak + 1);
    if (raw) { fetchStats.raw_used++; return { ...hit, ...raw, ...strip }; }
    return { ...hit, ...page, ...strip, ok: false, reason: page.reason || "page too short" };
  } catch (e) {
    hostFailStreak.set(host, streak + 1);
    if (raw) { fetchStats.raw_used++; return { ...hit, ...raw, ...strip }; }
    return { ...hit, ...strip, ok: false, reason: safeErrorMessage(e) };
  }
}

const NON_VACANCY_TITLE_RE = /\b(what is|how to apply|abstract book|conference abstracts?|conference programme|programme catalogue|catalog(?:ue)?|search results?|scholarships? for|funding opportunities|lecturer|postdoc(?:toral)?|professor|senior research lead|career opportunities|jobs and career opportunities|how to)\b/i;
const GENERIC_PAGE_TITLE_RE = /^(about|news|search results?|careers?|jobs and career opportunities|scholarships for international students|funding opportunities)\b/i;

function isLikelyVacancyPage(page) {
  const title = String(page.jobPosting?.title || page.title || "").trim();
  const early = String(page.fullText || page.text || "").slice(0, 1400);
  const combined = title + " " + early;
  if (NON_VACANCY_TITLE_RE.test(title) || GENERIC_PAGE_TITLE_RE.test(title)) return false;
  if (page.jobPosting) return DOCTORAL_RE.test(String(page.jobPosting.title || "") + " " + early);
  const titleIsDoctoral = DOCTORAL_RE.test(title);
  const earlyIsDoctoral = DOCTORAL_RE.test(early);
  const hasVacancySignal = /\b(position|vacancy|studentship|doctoral researcher|research fellow|phd candidate|funded phd|stipendiat|promovend|doktorand|doctorant)\b/i.test(combined);
  const isPdf = /\.pdf(?:$|[?#])/i.test(page.url) || /\.pdf$/i.test(title);
  if (isPdf) return titleIsDoctoral && hasVacancySignal && FUNDING_RE.test(combined);
  return titleIsDoctoral || (earlyIsDoctoral && hasVacancySignal);
}

function isClearlyExpiredPage(page) {
  const structured = normalizeDeadline(page.jobPosting?.validThrough || "");
  if (structured && structured < TODAY) return true;
  const inferred = inferDeadlineFromText(String(page.fullText || "").slice(0, 6000));
  return Boolean(inferred.deadline && inferred.deadline < TODAY);
}

async function fetchHitPages(hits, maxPages, seen, tier3 = false) {
  const unique = [];
  const keys = new Set();
  for (const hit of hits) {
    const u = normalizeURL(hit.url);
    const k = urlKey(u);
    if (!u || keys.has(k)) continue;
    keys.add(k);
    unique.push({ ...hit, url: u, key: k });
  }

  // Do not keep hammering URLs that failed recently, unless the search API already gave us their text.
  const candidates = unique.filter(h => {
    const e = seen[h.key];
    if (!e || h.raw) return true;
    return !(String(e.outcome || "").startsWith("skipped") && ageDays(e.last_checked) < 14);
  });
  const skippedRecently = unique.length - candidates.length;

  const scored = candidates.map(hit => {
    const e = seen[hit.key];
    if (!e) return { hit, rank: 0 };
    if (e.outcome === "pending") return { hit, rank: 0.5 };
    if (e.outcome === "result") return { hit, rank: 1 + ageDays(e.last_checked) / 1000 };
    return { hit, rank: 3 + ageDays(e.last_checked) / 1000 };
  });
  scored.sort((a, b) => a.rank - b.rank);

  const queue = scored.slice(0, maxPages * 3).map(s => s.hit);
  const fetched = await mapPool(queue, FETCH_CONCURRENCY, hit =>
    (hit.raw && RAW_FIRST_HOSTS.test(hostOf(hit.url)))
      ? loadPage(hit)
      : perHost(hit.url, () => loadPage(hit))
  );

  const pages = [], skipped = [];
  for (const p of fetched) {
    if (!p.ok || !p.fullText || p.fullText.length < 300) {
      skipped.push({ ...p, reason: p.reason || "page too short" });
      continue;
    }
    if (!isLikelyVacancyPage(p)) {
      skipped.push({ ...p, reason: "not a specific doctoral vacancy page" });
      continue;
    }
    if (isClearlyExpiredPage(p)) {
      skipped.push({ ...p, reason: "clearly expired deadline" });
      continue;
    }
    pages.push({ ...p, isTier3: tier3 });
    if (pages.length >= maxPages) break;
  }
  return { pages, skipped, skippedRecently };
}

async function gatherPages(mainHits, tier3Hits, mainMax, seen) {
  const main = await fetchHitPages(mainHits, mainMax, seen, false);
  const mainKeys = new Set(main.pages.map(p => p.key));
  const tier3 = await fetchHitPages(tier3Hits.filter(h => !mainKeys.has(urlKey(h.url))), TIER3_MAX_PAGES, seen, true);
  const pages = [...main.pages, ...tier3.pages].map((page, index) => ({ ...page, id: index + 1 }));
  return {
    pages, skipped: [...main.skipped, ...tier3.skipped],
    tier3Count: tier3.pages.length,
    skippedRecently: main.skippedRecently + tier3.skippedRecently
  };
}

// ============================================================================
// PRE-SCREEN
// ============================================================================
const THEME_WEIGHTS = [
  [/degrowth|post-?growth|post-?consumer|sufficiency|consumption corridor|doughnut economic|wellbeing economy|eco-?social|social-ecological|planetary boundar/gi, 7],
  [/sustainable consumption|consumption practice|product longevity|repair|reuse|circular econom|right to repair|discard studies|voluntary simplicity/gi, 5],
  [/transition design|social design|design justice|co-?design|participatory design|service design|product-?service system|design fiction|speculative design|more-than-human|pluriverse|systemic design/gi, 5],
  [/commons|sharing econom|access-?based|ownership model|collaborative consumption|platform cooperativ/gi, 4],
  [/socio-?technical transition|transition studies|sustainability transition|just transition|social practice theor|political ecolog|political econom/gi, 4],
  // local-language equivalents (Nordic, DACH, NL, IT, FR)
  [/postwachstum|wachstumskritik|suffizienz|nachhaltige[nr]? konsum|degroei|duurzame consumptie|hållbar konsumtion|bærekraftig forbruk|bæredygtigt forbrug|kestävä kulutus|consumo sostenibile|decrescita|consommation durable|décroissance/gi, 6],
  [/transformationsdesign|nachhaltigkeitstransformation|sozial-ökologische transformation|politische ökonomie|transitieontwerp|politieke economie|omställning|omstilling|kestävyysmurros|politisk økonomi|politisk ekonomi/gi, 4],
  [/sustainab\w+|governance|public policy|lifestyle|nachhaltigkeit|duurzaamheid|hållbarhet|bærekraft|bæredygtighed/gi, 1]
];
const ANTI_WEIGHTS = [
  [/machine learning|deep learning|neural network|large language model/gi, -6],
  [/catalys|nanomaterial|polymer synthesis|finite element|computational fluid|crystallograph/gi, -6],
  [/clinical trial|randomised controlled|oncolog|epidemiolog/gi, -5]
];
const FUNDING_RE = /fully funded|stipend|salary|scholarship|tariff|collective labour|tv-?l|studentship|tax-?free|per annum|gross monthly/i;

function themeScore(page) {
  const text = `${page.title || ""} ${page.fullText || page.text || ""}`;
  let score = 0;
  for (const [re, w] of [...THEME_WEIGHTS, ...ANTI_WEIGHTS]) {
    score += Math.min(3, (text.match(re) || []).length) * w;
  }
  return score;
}

function prescreen(page, theme = themeScore(page)) {
  const text = `${page.title || ""} ${page.fullText || page.text || ""}`;
  let score = theme;
  if (FUNDING_RE.test(text)) score += 4;
  if (page.jobPosting?.validThrough) score += 4;
  return score;
}

function rankByPrescreen(pages) {
  return pages
    .map(p => { const theme = themeScore(p); return { ...p, theme, prescreen: prescreen(p, theme) }; })
    .sort((a, b) => b.prescreen - a.prescreen);
}

// ============================================================================
// QUERY GENERATOR
// ============================================================================
const THEMES = [
  "degrowth", "post-growth", "sustainable consumption", "sufficiency",
  "product longevity", "repair and reuse", "circular economy", "sharing economy",
  "access-based consumption", "commons", "social practices", "sustainable lifestyles",
  "transition design", "social design", "design justice", "participatory design",
  "product-service systems", "systemic design", "sustainability transitions",
  "political economy of sustainability", "consumption governance", "social innovation",
  // added: themes that produced the best matches so far or sit on the candidate's trajectory
  "consumption corridors", "doughnut economics wellbeing economy", "eco-social policy",
  "just transition", "design fictions speculative design", "more-than-human design",
  "pluriverse decolonial design", "energy poverty housing consumption", "discard studies waste",
  "right to repair", "voluntary simplicity downshifting", "macromarketing critical consumer research",
  "platform cooperativism", "design for sufficiency", "service design public services",
  "sustainable fashion textiles longevity", "living labs urban transitions", "design anthropology"
];

const AGGREGATORS = ["academictransfer.com", "jobs.ac.uk", "euraxess.ec.europa.eu", "findaphd.com", "jobbnorge.no", "academicpositions.com"];
const TIER3_AGG = ["findaphd.com", "universityaffairs.ca"];

const FRAMES = [
  t => `fully funded PhD position ${t}`,
  t => `PhD vacancy ${t} ${THIS_YEAR + 1}`,
  t => `doctoral researcher position ${t} deadline`,
  t => `PhD studentship fellowship ${t} stipend`
];

// Local-language vacancy words: many Tier-1 ads are not written in English.
const LOCAL = {
  de: { jobs: ["Promotionsstelle", "Doktorand*in wissenschaftliche Mitarbeit"], themes: ["Postwachstum nachhaltiger Konsum", "Transformationsdesign Nachhaltigkeit", "Suffizienz politische Ökonomie"] },
  nl: { jobs: ["promovendus PhD-positie"], themes: ["duurzame consumptie", "transitie ontwerp duurzaamheid", "degroei"] },
  sv: { jobs: ["doktorand doktorandtjänst"], themes: ["hållbar konsumtion", "design omställning hållbarhet"] },
  da: { jobs: ["ph.d.-stipendiat"], themes: ["bæredygtigt forbrug", "design bæredygtig omstilling"] },
  no: { jobs: ["stipendiat doktorgrad"], themes: ["bærekraftig forbruk", "design bærekraft omstilling"] },
  fi: { jobs: ["tohtorikoulutettava väitöskirjatutkija"], themes: ["kestävä kulutus", "muotoilu kestävyysmurros"] },
  it: { jobs: ["borsa di dottorato"], themes: ["consumo sostenibile", "design sostenibilità transizione"] },
  fr: { jobs: ["contrat doctoral doctorant"], themes: ["consommation durable", "design transition écologique"] }
};

// Always-on core queries (job boards only, last month) so the best themes are covered every run.
const CORE_QUERIES = [
  { q: "PhD doctoral researcher degrowth post-growth sufficiency political economy consumption", domains: AGGREGATORS, time_range: "month" },
  { q: "PhD doctoral sustainable consumption product longevity repair circular economy design", domains: AGGREGATORS, time_range: "month" },
  { q: "PhD doctoral transition design social design service design systemic design participatory", domains: AGGREGATORS, time_range: "month" },
  { q: "PhD doctoral sustainability transitions social practices governance policy design justice", domains: AGGREGATORS, time_range: "month" }
];

// A new slot every 3.5 days, so a Tue + Sat schedule never repeats the same rotating queries.
function runSlot() {
  return Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / (3.5 * 86400000));
}

function rotate(pool, count) {
  if (!pool.length || count <= 0) return [];
  const start = (runSlot() * count) % pool.length;
  return Array.from({ length: Math.min(count, pool.length) }, (_, i) => pool[(start + i) % pool.length]);
}

function mainQueryPool() {
  const pool = [];
  THEMES.forEach((t, i) => {
    pool.push({ q: FRAMES[i % FRAMES.length](t) });                         // open web
    pool.push({ q: `PhD doctoral position ${t}`, domains: AGGREGATORS });    // job boards (include_domains, not site:)
  });
  for (const spec of Object.values(LOCAL)) {
    for (const job of spec.jobs) for (const theme of spec.themes) pool.push({ q: `${job} ${theme}` });
  }
  return pool;
}

function queriesForRun(count) {
  return [...CORE_QUERIES, ...rotate(mainQueryPool(), Math.max(0, count - CORE_QUERIES.length))];
}

function tier3QueriesForRun(count) {
  const pool = [];
  for (const t of THEMES) {
    pool.push({ q: `funded PhD project ${t} Australia HDR scholarship` });
    pool.push({ q: `PhD scholarship ${THIS_YEAR + 1} ${t} Canada university` });
    pool.push({ q: `funded PhD ${t} New Zealand`, });
    pool.push({ q: `PhD ${t}`, domains: TIER3_AGG });
  }
  return rotate(pool, count);
}

// ============================================================================
// AI CALLS
// ============================================================================
const failedThisRun = new Set();   // providers considered dead for this run
const deadModels = new Set();     // `${prefix}::${model}` disabled by a hard (daily/credit) quota
const failStreak = new Map();     // consecutive fully-retried failures per provider
const rrIndex = new Map();
const AI_STREAK_LIMIT = 3;        // provider is only abandoned after this many consecutive failed calls

function liveModels(provider) {
  const all = provider.models?.length ? provider.models : [provider.model];
  return all.filter(m => !deadModels.has(`${provider.prefix}::${m}`));
}
function pickModel(provider) {
  const models = liveModels(provider);
  if (!models.length) return null;
  const i = rrIndex.get(provider.prefix) || 0;
  rrIndex.set(provider.prefix, i + 1);
  return models[i % models.length];
}
function backoffMs(error, attempt) {
  if (Number(error.retryAfterMs) > 0) return Math.min(Number(error.retryAfterMs) + 1500, 180000);
  const message = String(error?.message || error || "");
  const retryIn = message.match(/(?:try again|retry|wait)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s)\b/i);
  if (retryIn) return Math.min(Math.ceil(Number(retryIn[1]) * 1000) + 1500, 180000);
  const base = CFG.AI_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  return Math.min(base + Math.floor(Math.random() * 0.25 * base), 180000);
}

async function aiGenerate(provider, prompt, { useSearch = false, allowEmpty = false, json = false } = {}) {
  if (!provider.configured) throw new Error(`${provider.name} is not configured (missing: ${provider.missing.join(", ")}).`);
  if (failedThisRun.has(provider.prefix)) {
    throw new Error(`${provider.name} already failed earlier this run — skipping.`);
  }
  let lastError;
  for (let attempt = 1; attempt <= CFG.AI_MAX_ATTEMPTS; attempt++) {
    const model = pickModel(provider);
    if (!model) break;
    const p = { ...provider, model };
    const call = p.format === "gemini"
      ? () => geminiFormatGenerate(p, prompt, useSearch, allowEmpty, json)
      : p.format === "openai"
      ? () => openaiFormatGenerate(p, prompt, allowEmpty)
      : null;
    if (!call) throw new Error(`${provider.prefix}_FORMAT "${provider.format}" is not supported.`);
    try {
      const out = await call();
      failStreak.set(provider.prefix, 0);
      return { ...out, model };
    } catch (error) {
      lastError = error;
      if (isQuotaError(error)) {
        deadModels.add(`${provider.prefix}::${model}`);
        console.error(`[${provider.name}] ${model}: hard quota reached — model disabled for this run.`);
        continue; // try another model (if any) on the next attempt
      }
      if (!error.retryable || attempt === CFG.AI_MAX_ATTEMPTS) break;
      const wait = backoffMs(error, attempt);
      console.warn(`[${provider.name}] ${model} attempt ${attempt}/${CFG.AI_MAX_ATTEMPTS} failed (${safeErrorMessage(error)}); retrying in ${Math.round(wait / 1000)}s...`);
      await sleep(wait);
    }
  }
  if (!liveModels(provider).length) {
    failedThisRun.add(provider.prefix);
    console.error(`[${provider.name}] all models hit a hard quota — provider disabled for this run.`);
  } else {
    const streak = (failStreak.get(provider.prefix) || 0) + 1;
    failStreak.set(provider.prefix, streak);
    if (streak >= AI_STREAK_LIMIT) {
      failedThisRun.add(provider.prefix);
      console.error(`[${provider.name}] ${streak} consecutive failed calls — provider disabled for this run.`);
    }
  }
  throw lastError || new Error(`${provider.name}: no usable model.`);
}

function apiError(message, retryable, retryAfterMs = 0) {
  const e = new Error(message);
  e.retryable = retryable;
  e.retryAfterMs = retryAfterMs;
  return e;
}
const isRetryableStatus = s => s === 429 || s >= 500;

async function geminiFormatGenerate(provider, prompt, useSearch, allowEmpty, json = false) {
  const base = provider.baseUrl.replace(/\/+$/, "");
  const endpoint = /:generatecontent$/i.test(base)
    ? base
    : `${base}/models/${encodeURIComponent(provider.model)}:generateContent`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    ...(useSearch ? { tools: [{ google_search: {} }] } : {}),
    generationConfig: { temperature: 0.1, responseMimeType: (json && !useSearch) ? "application/json" : "text/plain" }
  };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": provider.apiKey },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = data?.error?.message || `${provider.name} HTTP ${response.status}`;
    const retryAfter = Number(response.headers.get("retry-after") || 0);
    throw apiError(msg, isRetryableStatus(response.status), retryAfter > 0 ? retryAfter * 1000 : 0);
  }
  const text = (data?.candidates || []).flatMap(c => c?.content?.parts || []).map(p => p?.text || "").join("\n").trim();
  if (!text && !allowEmpty) {
    const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || "no reason given";
    throw apiError(`${provider.name} returned no text (reason: ${reason}).`, true);
  }
  return { text, data };
}

async function openaiFormatGenerate(provider, prompt, allowEmpty) {
  const endpoint = endpointURL(provider.baseUrl, "/chat/completions");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Authorization": `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: provider.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = data?.error?.message || `${provider.name} HTTP ${response.status}`;
    const retryAfter = Number(response.headers.get("retry-after") || 0);
    throw apiError(msg, isRetryableStatus(response.status), retryAfter > 0 ? retryAfter * 1000 : 0);
  }
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text && !allowEmpty) {
    const reason = data?.choices?.[0]?.finish_reason || "no reason given";
    throw apiError(`${provider.name} returned no text (reason: ${reason}).`, true);
  }
  return { text, data };
}

function collectGroundingHits(data) {
  const hits = [];
  const add = (url, title) => { if (url) hits.push({ title: String(title || url), url: String(url) }); };
  for (const candidate of data?.candidates || []) {
    for (const chunk of candidate?.groundingMetadata?.groundingChunks || []) add(chunk?.web?.uri, chunk?.web?.title);
  }
  for (const item of data?.search_results || []) add(item?.url, item?.title);
  for (const item of data?.citations || []) typeof item === "string" ? add(item) : add(item?.url, item?.title);
  for (const choice of data?.choices || []) {
    for (const ann of choice?.message?.annotations || []) add(ann?.url_citation?.url || ann?.url, ann?.url_citation?.title || ann?.title);
  }
  return hits;
}

// ============================================================================
// DISCOVERY
// ============================================================================
const SEARCH_REVIEW_ANGLES = [
  `Find currently open, funded PhD/doctoral vacancies (Europe first) matching this profile:
${CANDIDATE_PROFILE}
Search broadly across ALL of these themes in one comprehensive Google Search pass:
degrowth, post-growth, post-consumerism, political economy, sustainable consumption,
product longevity, repair/reuse, circular economy, sustainable lifestyles, social practices,
consumption systems, alternative ownership/access, commons, sharing systems, sufficiency,
service systems, product-service systems, transition design, social design, design justice,
participatory/co-design, systemic design, critical design, alternative futures, governance,
public policy, transition studies, sustainability science, STS, sociology, political science
and environmental humanities where relevant. ${GEOGRAPHY}
Prioritise official university vacancy pages. Exclude generic programmes and expired positions.`
];

const SEARCH_REVIEW_TIER3_ANGLES = [
  `Find currently open, funded PhD/doctoral projects or project-linked PhD scholarships in
CANADA, AUSTRALIA and NEW ZEALAND only (never the United States) matching this profile:
${CANDIDATE_PROFILE}
Themes: degrowth, post-growth, sustainable consumption, sufficiency, circular economy,
product longevity, repair/reuse, sharing/access-based consumption, commons, social practices,
transition design, social/service/systemic design, design justice, co-design, governance,
public policy, sustainability transitions, STS, sociology, political economy.
In Australia look for HDR / Research Training Program funded projects; in Canada look for
funded supervisor-advertised PhD projects and studentships.`
];

const SEARCH_REVIEW_MAX_PAGES = MAX_PAGES;
const SEARCH_REVIEW_CALL_GAP_MS = 4000;
const SEARCH_MAX_RESULTS_PER_QUERY = CFG.SEARCH_RESULTS_PER_QUERY;
const SEARCH_CALL_GAP_MS = 400;
const REVIEW_MAX_PAGES = MAX_PAGES;
const REVIEW_CALL_GAP_MS = CFG.AI_CALL_GAP_MS;
const EXTRACTION_BATCH_SIZE = CFG.EXTRACTION_BATCH_SIZE;
const AI_REVIEW_BUDGET = CFG.AI_REVIEW_BUDGET;

async function searchReviewDiscover(angles, tag = "Europe-first") {
  console.log(`[${SEARCH_REVIEW.name}] web search discovery starting (${tag})...`);
  const allHits = [], seenURLs = new Set();
  for (let i = 0; i < angles.length; i++) {
    if (i > 0) await sleep(SEARCH_REVIEW_CALL_GAP_MS);
    if (failedThisRun.has(SEARCH_REVIEW.prefix)) {
      console.warn(`[${SEARCH_REVIEW.name}] skipping remaining ${tag} angles — provider already dead.`);
      break;
    }
    const prompt = `You are the discovery stage of a PhD vacancy radar.
${angles[i]}
${SEARCH_STRATEGY}
${RULES}
${DATE_CONTEXT}
Return a list of at least 20 relevant, CURRENTLY OPEN vacancy pages you found. Do not invent URLs.
The program will take URLs only from your web search tool's source metadata, not from your text.`;
    let data;
    try {
      ({ data } = await aiGenerate(SEARCH_REVIEW, prompt, { useSearch: true, allowEmpty: true }));
    } catch (error) {
      console.warn(`[${SEARCH_REVIEW.name}] ${tag} angle ${i + 1}/${angles.length} failed: ${safeErrorMessage(error)}`);
      if (failedThisRun.has(SEARCH_REVIEW.prefix)) break;
      continue;
    }
    for (const hit of collectGroundingHits(data)) {
      const url = normalizeURL(hit.url);
      if (!url || seenURLs.has(url)) continue;
      if (/vertexaisearch\.cloud\.google\.com|grounding-api-redirect/.test(url)) continue;
      seenURLs.add(url);
      allHits.push({ ...hit, url });
    }
    console.log(`[${SEARCH_REVIEW.name}] ${tag} angle ${i + 1}/${angles.length}: ${allHits.length} unique hits so far`);
  }
  return allHits;
}

let BLOCKED_CACHE = { domains: [], urls: [] };
const ALWAYS_EXCLUDE = ["facebook.com", "instagram.com", "linkedin.com", "youtube.com", "google.com", "tiktok.com", "x.com", "twitter.com", "pinterest.com"];
let SEARCH_QUOTA_HIT = false;

async function webSearch(spec, attempt = 1) {
  const { q: query, domains = [], time_range: timeRange } = typeof spec === "string" ? { q: spec } : spec;
  const range = (timeRange || CFG.SEARCH_TIME_RANGE || "").toLowerCase();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  const n = SEARCH_MAX_RESULTS_PER_QUERY;
  try {
    let response, pick;
    if (SEARCH.format === "tavily") {
      const body = {
        query, search_depth: CFG.SEARCH_DEPTH, max_results: n, include_answer: false,
        include_raw_content: CFG.SEARCH_RAW_CONTENT ? "markdown" : false,
        exclude_domains: [...new Set([...ALWAYS_EXCLUDE, ...BLOCKED_CACHE.domains])].slice(0, 140)
      };
      if (range && range !== "none") body.time_range = range;
      if (domains.length) body.include_domains = domains;
      response = await fetch(endpointURL(SEARCH.baseUrl, "/search"), {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SEARCH.apiKey}` },
        body: JSON.stringify(body)
      });
      pick = d => (d.results || []).map(r => ({ title: r.title, url: r.url, raw: r.raw_content || "", snippet: r.content || "" }));
    } else if (SEARCH.format === "serper") {
      const q = domains.length ? `(${domains.map(d => `site:${d}`).join(" OR ")}) ${query}` : query;
      const tbs = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" }[range];
      response = await fetch(endpointURL(SEARCH.baseUrl, "/search"), {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-API-KEY": SEARCH.apiKey },
        body: JSON.stringify({ q, num: n, ...(tbs ? { tbs } : {}) })
      });
      pick = d => (d.organic || []).map(r => ({ title: r.title, url: r.link }));
    } else if (SEARCH.format === "brave") {
      const url = new URL(endpointURL(SEARCH.baseUrl, "/res/v1/web/search"));
      url.searchParams.set("q", domains.length ? `(${domains.map(d => `site:${d}`).join(" OR ")}) ${query}` : query);
      url.searchParams.set("count", String(Math.min(n, 20)));
      const fresh = { day: "pd", week: "pw", month: "pm", year: "py" }[range];
      if (fresh) url.searchParams.set("freshness", fresh);
      response = await fetch(url, { signal: controller.signal, headers: { "Accept": "application/json", "X-Subscription-Token": SEARCH.apiKey } });
      pick = d => (d.web?.results || []).map(r => ({ title: r.title, url: r.url }));
    } else {
      throw new Error(`SEARCH_FORMAT "${SEARCH.format}" is not supported. Use "tavily", "serper" or "brave".`);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if ([432, 433].includes(response.status)) {            // Tavily: plan / pay-as-you-go limit exhausted
        SEARCH_QUOTA_HIT = true;
        console.error(`[${SEARCH.name}] plan limit reached (HTTP ${response.status}) — stopping further searches this run.`);
        return [];
      }
      if (response.status === 429 && attempt < 3) {
        const wait = Number(response.headers.get("retry-after") || 0) * 1000 || 5000 * attempt;
        await sleep(Math.min(wait, 30000));
        return webSearch(spec, attempt + 1);
      }
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

async function searchDiscover(queries, tag = "Europe-first") {
  if (!SEARCH.configured) throw new Error(`${SEARCH.name} is not configured (missing: ${SEARCH.missing.join(", ")}).`);
  console.log(`[${REVIEW.name}] ${SEARCH.name} search discovery starting (${tag}, ${queries.length} queries, depth=${CFG.SEARCH_DEPTH}, range=${CFG.SEARCH_TIME_RANGE})...`);
  const byKey = new Map();
  for (let i = 0; i < queries.length; i++) {
    if (SEARCH_QUOTA_HIT) { console.warn(`[${SEARCH.name}] skipping remaining ${tag} queries (plan limit).`); break; }
    if (i > 0) await sleep(SEARCH_CALL_GAP_MS);
    const results = await webSearch(queries[i]);
    for (const item of results) {
      const url = normalizeURL(item.url);
      if (!url) continue;
      const key = urlKey(url);
      const prev = byKey.get(key);
      if (prev) { if (!prev.raw && item.raw) prev.raw = item.raw; continue; }
      byKey.set(key, { title: String(item.title || url).trim(), url, raw: item.raw || "", snippet: item.snippet || "" });
    }
    if ((i + 1) % 10 === 0) console.log(`[${REVIEW.name}] ${tag} query ${i + 1}/${queries.length}: ${byKey.size} unique hits so far`);
  }
  return [...byKey.values()];
}

// ============================================================================
// EXTRACTION PROMPT
// ============================================================================
function buildExtractionPrompt(pages) {
  const pageBlocks = pages.map(page => {
    const jp = page.jobPosting
      ? `STRUCTURED DATA: ${JSON.stringify({
          title: page.jobPosting.title,
          organization: page.jobPosting.organization,
          country: page.jobPosting.country,
          city: page.jobPosting.city,
          validThrough: page.jobPosting.validThrough
        })}\n`
      : "";
    return `--- PAGE ${page.id} ---
URL: ${page.url}
${jp}${page.text}
--- END PAGE ${page.id} ---`;
  }).join("\n\n");

  return `You are the extraction stage of a funded PhD vacancy radar (Europe first, plus Canada, Australia, New Zealand; never the United States).

${CANDIDATE_PROFILE}
${GEOGRAPHY}
${RULES}
${URL_INTEGRITY_RULE}
${OUTPUT_RULES}
If STRUCTURED DATA is present, prefer its validThrough over dates in prose. ${DATE_CONTEXT}
A page qualifies when it describes ONE specific PhD/doctoral vacancy (or a CA/AU/NZ funded project-linked PhD), funding is stated,
and the deadline is either in the future, rolling/open-until-filled, or simply not stated (deadline_type="unknown").
Never turn a generic programme, news item, lab page or directory into a vacancy. Pages may be in any language.

${pageBlocks}`;
}

async function extractBatch(pages) {
  const { text } = await aiGenerate(SEARCH_REVIEW, buildExtractionPrompt(pages));
  const parsed = extractJSON(text);
  if (!Array.isArray(parsed)) throw new Error(`${SEARCH_REVIEW.name} extraction response was not an array.`);
  return parsed;
}

async function extractReviewBatch(pages) {
  const { text } = await aiGenerate(REVIEW, buildExtractionPrompt(pages));
  const parsed = extractJSON(text);
  if (!Array.isArray(parsed)) throw new Error(`${REVIEW.name} extraction response was not an array.`);
  return parsed;
}

function extractionResponseExcerpt(value, maxChars = 420) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

async function extractWithFallback(primary, fallback, pages) {
  const attempts = [primary, ...(Array.isArray(fallback) ? fallback : [fallback]).filter(p => p && p.configured && p.prefix !== primary.prefix)];
  let lastError;
  for (const provider of attempts) {
    if (failedThisRun.has(provider.prefix)) {
      console.warn(`[${provider.name}] unavailable for this run; skipping.`);
      continue;
    }
    try {
      const { text, model } = await aiGenerate(provider, buildExtractionPrompt(pages), { json: true });
      let parsed = extractJSON(text);
      if (!Array.isArray(parsed) && parsed && typeof parsed === "object") {
        const arr = Object.values(parsed).find(Array.isArray);
        if (arr) parsed = arr;
      }
      if (!Array.isArray(parsed)) throw new Error(`${provider.name} extraction response was not an array.`);
      // An empty array is a valid answer ("no vacancy among these pages"): never pay for a second call.
      if (parsed.length === 0) console.log(`[${provider.name}] batch contained no vacancies.`);
      return { items: parsed, provider: { ...provider, model: model || provider.model } };
    } catch (error) {
      lastError = error;
      console.warn(`[${provider.name}] extraction failed: ${safeErrorMessage(error)}`);
    }
  }
  throw lastError || new Error("No configured extraction provider was available.");
}

// ============================================================================
// IELTS CACHE
// ============================================================================
const IELTS_REFRESH_DAYS = 180;
let universitiesCache = {};

function loadUniversitiesCache() {
  try { universitiesCache = JSON.parse(readFileSync(UNIVERSITIES_FILE, "utf8")) || {}; }
  catch { universitiesCache = {}; }
}
function saveUniversitiesCache() {
  writeFileSync(UNIVERSITIES_FILE, JSON.stringify(universitiesCache, null, 2) + "\n");
}

function bestSearchAI() {
  const candidates = [SEARCH_REVIEW, REVIEW];
  for (const p of candidates) {
    if (p.configured && p.format === "gemini" && !failedThisRun.has(p.prefix)) return p;
  }
  return null;
}

async function lookupIelts(university, country) {
  const fallback = { ielts_requirement: "Not specified on official university website", ielts_source_url: "" };
  const key = String(university || "").toLowerCase().trim();
  if (!key) return fallback;

  const cached = universitiesCache[key];
  if (cached && cached.checked_at && (Date.now() - Date.parse(cached.checked_at)) / 86400000 < IELTS_REFRESH_DAYS) {
    return { ielts_requirement: cached.ielts_requirement, ielts_source_url: cached.ielts_source_url || "" };
  }
  const ai = bestSearchAI();
  if (!ai) return fallback;

  const prompt = `You are looking up the official English-language / IELTS requirement for PhD applicants at "${university}" (${country || "unknown country"}).
Use web search to find an OFFICIAL university page (e.g. a graduate school, admissions or English requirements page).
Return ONLY valid JSON with this shape:
{"ielts_requirement": "<e.g. 6.5 overall, no band below 6.0>", "ielts_source_url": "<https://...>"}
If you cannot find an official university source, return:
{"ielts_requirement": "Not specified on official university website", "ielts_source_url": ""}
Do not invent scores or URLs.`;

  try {
    const { text } = await aiGenerate(ai, prompt, { useSearch: true });
    const parsed = extractJSON(text);
    const result = {
      ielts_requirement: String(parsed?.ielts_requirement || fallback.ielts_requirement).trim(),
      ielts_source_url: normalizeURL(parsed?.ielts_source_url || "")
    };
    universitiesCache[key] = { ...result, checked_at: new Date().toISOString() };
    saveUniversitiesCache();
    return result;
  } catch (error) {
    console.warn(`IELTS lookup skipped for ${university}: ${safeErrorMessage(error)}`);
    return fallback;
  }
}

// ============================================================================
// VALIDATION HELPERS
// ============================================================================
// Extract a leading number from anything: 18, "18", "18/20", "18 out of 20",
// {score: 18, reason: "..."} → all resolve to 18. Returns NaN otherwise.
function toScore(v) {
  if (v == null) return NaN;
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v === "object") {
    if (Number.isFinite(Number(v.score))) return Number(v.score);
    if (Number.isFinite(Number(v.value))) return Number(v.value);
  }
  const m = String(v).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

const FIT_KEYS = ["topic_fit", "politics_fit", "design_fit", "methods_fit"];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Research fit only (0-80). Funding is a bonus, never a way to lift an off-topic position over the bar.
function fitScoreOf(item) {
  const vals = FIT_KEYS.map(k => toScore(item?.[k])).filter(Number.isFinite);
  if (vals.length < 2) return null;
  return Math.round(vals.reduce((a, v) => a + clamp(v, 0, 20), 0));
}

// overall = fit scaled to 90 + funding scaled to 10.
function computeScore(item) {
  const fit = fitScoreOf(item);
  if (fit !== null) {
    const funding = clamp(toScore(item.funding_quality) || 0, 0, 20);
    return Math.round(fit * 1.125 + funding / 2);
  }
  const overall = toScore(item.overall_score);
  return Number.isFinite(overall) ? Math.round(overall) : null;
}

function passesFitGate(item) {
  const fit = fitScoreOf(item);
  if (fit === null) return true;
  return fit >= CFG.MIN_FIT && clamp(toScore(item.topic_fit) || 0, 0, 20) >= CFG.MIN_TOPIC;
}

function inferDeadlineFromText(text) {
  const source = String(text || "");
  const patterns = [
    /(?:application|applications|apply|deadline|closing date|last application date|applications? close|apply by)[^.!?]{0,140}?(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?[^.!?]{0,25}?(20\d{2})?/i,
    /(?:application|applications|apply|deadline|closing date|last application date|applications? close|apply by)[^.!?]{0,140}?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?[^.!?]{0,25}?(20\d{2})?/i
  ];
  for (const re of patterns) {
    const m = source.match(re);
    if (!m) continue;
    const monthName = re === patterns[0] ? m[2] : m[1];
    const day = Number(re === patterns[0] ? m[1] : m[2]);
    const explicitYear = Number(m[3] || 0);
    const month = MONTH_NUMBER[String(monthName || "").toLowerCase()];
    if (!month || !day) continue;
    let year = explicitYear || THIS_YEAR;
    if (!explicitYear) {
      const around = source.slice(Math.max(0, (m.index || 0) - 250), Math.min(source.length, (m.index || 0) + 250));
      const nearbyYears = [...around.matchAll(/\b(20\d{2})\b/g)].map(x => Number(x[1]));
      year = nearbyYears.find(y => y >= THIS_YEAR - 1 && y <= THIS_YEAR + 1) || THIS_YEAR;
    }
    const iso = toISODate(year, month, day);
    if (iso) return { deadline: iso, deadline_type: "dated", raw: m[0].trim() };
  }
  if (ROLLING_RE.test(source)) return { deadline: "", deadline_type: "rolling", raw: "" };
  return { deadline: "", deadline_type: "unknown", raw: "" };
}

function deadlineInfoOf(item) {
  const raw = String(item?.deadline || "").trim();
  const normalized = normalizeDeadline(raw);
  const pageText = String(item?.original_text || "");
  const inferred = inferDeadlineFromText(pageText);
  const explicitType = String(item?.deadline_type || "").toLowerCase();

  if (isFutureDeadline(normalized)) return { kind: "dated", stored: normalized, raw };
  if (raw && normalized && !isFutureDeadline(normalized)) return { kind: "invalid", stored: normalized, raw };
  if (inferred.deadline) {
    if (isFutureDeadline(inferred.deadline)) return { kind: "dated", stored: inferred.deadline, raw: inferred.raw };
    return { kind: "invalid", stored: inferred.deadline, raw: inferred.raw };
  }
  if (explicitType === "rolling" || inferred.deadline_type === "rolling") {
    return { kind: "rolling", stored: "", raw };
  }
  return { kind: "unknown", stored: "", raw };
}

function hardModelReject(item) {
  if (item?.eligible !== false) return false;
  const reason = String(item.reject_reason || "").toLowerCase();
  // Only discard candidates when the model gives a clear, substantive reason.
  // Uncertainty about verification, deadline, funding detail, page content, etc.
  // should not erase a potentially useful lead; it remains visible as
  // "Not verified" so the user can inspect it manually.
  return /deadline (has )?(already )?(passed|expired)|has passed|already passed|duplicate of|not (a )?(phd|doctoral|vacancy|position)|generic (phd )?program|phd programme|not funded|unfunded|no funding|funding absent|unrelated|irrelevant|wrong (country|location)|united states|usa|closed|expired|past deadline|not a specific (phd|doctoral) project/.test(reason);
}

function explainRejection(item) {
  if (!item || typeof item !== "object") return "not an object";
  if (!String(item.title || "").trim()) return "missing title";
  if (!String(item.university || "").trim()) return "missing university";
  if (!String(item.country || "").trim()) return "missing country";
  if (isUnitedStates(item.country)) return "United States (excluded)";
  if (!normalizeURL(item.url)) return "missing/invalid url";
  if (item.eligible === false && hardModelReject(item)) return `model hard-rejected: ${item.reject_reason || "no reason"}`;
  if (item.eligible === false) return `model uncertain — retained for verification: ${item.reject_reason || "no reason"}`;
  const score = computeScore(item);
  if (score === null) return "no valid score (sub-scores and overall_score both missing/unparseable)";
  if (score < CFG.MIN_OVERALL) return `score ${score} is below ${CFG.MIN_OVERALL}`;
  if (!passesFitGate(item)) return `research fit too low (fit ${fitScoreOf(item)}/80, topic ${toScore(item.topic_fit) || 0}/20)`;
  const d = deadlineInfoOf(item);
  if (d.kind === "invalid") return `deadline is in the past or unparseable (got: ${JSON.stringify(d.raw)})`;
  return "passes";
}

function sourceQualityForURL(url) {
  let host = "";
  try { host = new URL(normalizeURL(url)).host.toLowerCase(); } catch {}
  if (!host) return { source_quality: "Unknown", source_quality_rank: 0 };
  if (host.includes("euraxess.ec.europa.eu")) return { source_quality: "EURAXESS", source_quality_rank: 4 };
  if (host.includes("academictransfer.com") || host.includes("jobs.ac.uk") || host.includes("findaphd.com") || host.includes("academicpositions.com"))
    return { source_quality: "Trusted aggregator", source_quality_rank: 3 };
  if (host.endsWith(".edu") || host.endsWith(".ac.uk") || host.endsWith(".ac.nl") || host.endsWith(".ac.de") || host.endsWith(".ac.it") || host.endsWith(".ac.ch"))
    return { source_quality: "Institutional", source_quality_rank: 5 };
  if (host.includes("linkedin.com") || host.includes("facebook.com") || host.includes("x.com"))
    return { source_quality: "Secondary / social", source_quality_rank: 1 };
  return { source_quality: "Secondary", source_quality_rank: 2 };
}

function providerLabelsOf(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  return [...new Set(raw.split(/\s+\+\s+/).map(p => p.trim()).filter(p => p && p.toLowerCase() !== "unknown"))];
}
function providerLabelOf(value) { return providerLabelsOf(value)[0] || ""; }
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

function normalizeUniversity(value) {
  return [...new Set(normalizeIdentityText(value)
    .split(" ")
    .filter(word => !["university", "of", "the", "technology", "technical", "institute", "college", "school", "tu"].includes(word)))]
    .join(" ");
}

function resultIdentity(item) {
  const url = normalizeURL(item.url);
  if (url) return "url:" + urlKey(url);
  const title = normalizeIdentityText(item.title);
  const university = normalizeUniversity(item.university);
  const deadline = normalizeDeadline(item.deadline);
  return title && university && deadline ? university + "|" + title + "|" + deadline : "";
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
  const firstSeen = [a.first_seen, b.first_seen].filter(Boolean).sort()[0] || new Date().toISOString();
  const merged = {
    ...other, ...better,
    first_seen: firstSeen,
    ai_provider: mergeProviderLabels(a.ai_provider, b.ai_provider),
    ai_model: [a.ai_model, b.ai_model].map(v => String(v || "").trim()).filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(" + "),
    original_text: String(better.original_text || other.original_text || "").trim(),
    url_grounded: Boolean(a.url_grounded || b.url_grounded),
    verification_status: a.verification_status === "Verified" || b.verification_status === "Verified" ? "Verified" : "Not verified"
  };
  const knownUniversity = [a, b].find(x => x.university && x.university !== "Unknown institution" && x.university_confidence !== "unknown");
  if (knownUniversity) {
    merged.university = knownUniversity.university;
    merged.university_confidence = knownUniversity.university_confidence || "source";
  }
  const knownCountry = [a, b].find(x => x.country && x.country !== "Unknown");
  if (knownCountry) merged.country = knownCountry.country;
  if (!String(merged.verification_note || "").trim()) merged.verification_note = String(other.verification_note || "").trim();
  if (!String(merged.verification_url || "").trim()) merged.verification_url = normalizeURL(other.verification_url);
  if (!String(merged.ielts_source_url || "").trim()) merged.ielts_source_url = normalizeURL(other.ielts_source_url);
  return merged;
}

function titleTokens(t) {
  return new Set(normalizeIdentityText(t).split(" ").filter(w => w.length > 3));
}
function acronymsOf(t) {
  return new Set((String(t || "").match(/\b[A-Z][A-Z0-9]{3,}\b/g) || []).map(s => s.toLowerCase()));
}
// Same university + near-identical title (or shared project acronym + overlapping title) = same vacancy.
function sameJob(a, b) {
  const urlA = normalizeURL(a.url), urlB = normalizeURL(b.url);
  if (urlA && urlB && urlKey(urlA) === urlKey(urlB)) return true;
  const uniA = normalizeUniversity(a.university), uniB = normalizeUniversity(b.university);
  if (!uniA || !uniB || uniA === "unknown institution" || uniB === "unknown institution") return false;
  if (uniA !== uniB) return false;
  if (a.deadline && b.deadline && a.deadline !== b.deadline) return false;
  const ta = titleTokens(a.title), tb = titleTokens(b.title);
  const inter = [...ta].filter(w => tb.has(w)).length;
  const jac = inter / (new Set([...ta, ...tb]).size || 1);
  if (jac >= 0.6) return true;
  const aa = acronymsOf(a.title), ab = acronymsOf(b.title);
  return jac >= 0.35 && [...aa].some(x => ab.has(x));
}
function dedupeSimilar(items) {
  const out = [];
  for (const item of items) {
    const i = out.findIndex(o => sameJob(o, item));
    if (i === -1) out.push(item); else out[i] = mergeResultRecords(out[i], item);
  }
  return out;
}

function cleanResults(results) {
  if (!Array.isArray(results)) return [];
  const byIdentity = new Map();

  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    if (item.eligible === false && hardModelReject(item)) continue;

    const title = String(item.title || "").trim();
    const university = String(item.university || "").trim();
    const country = String(item.country || "").trim();
    const city = String(item.city || "").trim();
    const url = normalizeURL(item.url);
    if (!title || !university || !country || !url) continue;
    if (isUnitedStates(country)) continue;

    const score = computeScore(item);
    if (score === null || score < CFG.MIN_OVERALL) continue;
    if (!passesFitGate(item)) continue;

    const dinfo = deadlineInfoOf(item);
    if (dinfo.kind === "invalid") continue;

    const language = ["English", "Not English", "Unknown"].includes(String(item.application_language || ""))
      ? String(item.application_language) : "Unknown";
    const provider = providerLabelsOf(item._extracted_by || item.ai_provider).join(" + ") || "Unknown";

    const candidate = {
      title, university, university_confidence: item.university_confidence === "unknown" ? "unknown" : "source", country, city, url,
      deadline: dinfo.stored,
      deadline_type: dinfo.kind,
      start_date: String(item.start_date || "").trim(),
      geo_tier: geoTier(country),
      score_basis: String(item.score_basis || "ai").trim() || "ai",
      funding: String(item.funding || "").trim(),
      overall_score: Math.round(score),
      fit_score: fitScoreOf(item),
      tier: score >= 75 ? "strong" : "possible",
      topic_fit: toScore(item.topic_fit) || 0,
      politics_fit: toScore(item.politics_fit) || 0,
      design_fit: toScore(item.design_fit) || 0,
      methods_fit: toScore(item.methods_fit) || 0,
      funding_quality: toScore(item.funding_quality) || 0,
      why_it_matches: String(item.why_it_matches || "").trim(),
      original_text: String(item.original_text || "").slice(0, 6000),
      strategic_fit: String(item.strategic_fit || "").trim(),
      why_it_is_not_perfect: String(item.why_it_is_not_perfect || "").trim(),
      supervisor: String(item.supervisor || "").trim(),
      classification: String(item.classification || "").trim(),
      research_area: String(item.research_area || "").trim(),
      application_language: language,
      ielts_requirement: String(item.ielts_requirement || "Not specified on official university website").trim(),
      ielts_source_url: normalizeURL(item.ielts_source_url),
      ai_provider: provider,
      ai_model: String(item.ai_model || item._ai_model || "").trim(),
      url_grounded: item.url_grounded === true,
      first_seen: String(item.first_seen || new Date().toISOString()),
      verification_status: item.university_confidence === "unknown" ? "Not verified" : (["Verified", "Not verified", "Closed"].includes(String(item.verification_status || "")) ? String(item.verification_status) : "Not verified"),
      verification_checked_at: String(item.verification_checked_at || "").trim(),
      verification_note: String(item.verification_note || "").trim(),
      verification_url: normalizeURL(item.verification_url)
    };

    const identity = resultIdentity(candidate);
    const previous = byIdentity.get(identity);
    byIdentity.set(identity, previous ? mergeResultRecords(previous, candidate) : candidate);
  }

  const cleaned = dedupeSimilar(Array.from(byIdentity.values()));
  cleaned.sort((a, b) =>
    b.overall_score - a.overall_score ||
    a.geo_tier - b.geo_tier ||
    new Date(a.deadline || "9999-12-31") - new Date(b.deadline || "9999-12-31"));
  return cleaned;
}

// ============================================================================
// VERIFICATION
// ============================================================================
const CLOSED_RE = /no longer (available|accepting)|this (vacancy|position) (is closed|has closed)|applications (are )?closed|position (has been|was) filled/i;
const VERIFY_FRESH_DAYS = 1;

async function verifyPosition(position) {
  const checkedAt = new Date().toISOString();
  if (position.verification_checked_at) {
    const ageDays = (Date.now() - Date.parse(position.verification_checked_at)) / 86400000;
    if (ageDays < VERIFY_FRESH_DAYS && position.verification_status) {
      return {
        verification_status: position.verification_status,
        verification_checked_at: position.verification_checked_at,
        verification_note: position.verification_note,
        verification_url: position.verification_url
      };
    }
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(position.url, {
      method: "GET", redirect: "follow", signal: controller.signal,
      headers: { "User-Agent": PAGE_USER_AGENT, "Accept-Language": "en-GB,en;q=0.9" }
    });
    clearTimeout(timeout);

    const finalURL = normalizeURL(response.url || position.url);
    const contentType = String(response.headers.get("content-type") || "");
    const body = contentType.includes("text/") ? (await response.text()).slice(0, 250000) : "";
    const text = body.toLowerCase();

    if (response.status === 404 || response.status === 410 || CLOSED_RE.test(text)) {
      return {
        verification_status: "Closed",
        verification_checked_at: checkedAt,
        verification_note: response.status === 404 || response.status === 410
          ? `HTTP ${response.status}`
          : "Page text indicates the position is closed.",
        verification_url: finalURL
      };
    }

    const phdSignal = DOCTORAL_RE.test(text);
    const vacancySignal = /vacancy|position|fellowship|scholarship|studentship|stipend|researcher|job opening|apply/.test(text);
    const titleWords = String(position.title || "").toLowerCase().split(/\W+/).filter(w => w.length >= 5).slice(0, 8);
    const titleSignal = titleWords.length === 0 || titleWords.filter(w => text.includes(w)).length >= Math.min(2, titleWords.length);
    const pageDeadline = inferDeadlineFromText(body);
    if (pageDeadline.deadline && !isFutureDeadline(pageDeadline.deadline)) {
      return {
        verification_status: "Closed",
        verification_checked_at: checkedAt,
        verification_note: `Application deadline ${pageDeadline.deadline} has passed.`,
        verification_url: finalURL
      };
    }
    if (CLOSED_RE.test(text)) {
      return {
        verification_status: "Closed",
        verification_checked_at: checkedAt,
        verification_note: "Page text indicates the vacancy is closed or filled.",
        verification_url: finalURL
      };
    }

    if (response.ok && phdSignal && vacancySignal && titleSignal) {
      return {
        verification_status: "Verified",
        verification_checked_at: checkedAt,
        verification_note: `HTTP ${response.status}; PhD/doctoral + vacancy signals present`,
        verification_url: finalURL
      };
    }
    return {
      verification_status: "Not verified",
      verification_checked_at: checkedAt,
      verification_note: response.ok
        ? "Page reachable, but automated content check could not confirm a PhD vacancy."
        : `HTTP ${response.status}`,
      verification_url: finalURL
    };
  } catch (error) {
    return {
      verification_status: "Not verified",
      verification_checked_at: checkedAt,
      verification_note: error?.name === "AbortError" ? "Verification timed out." : `Could not fetch page: ${String(error?.message || error)}`,
      verification_url: normalizeURL(position.url)
    };
  }
}

async function verifyResults(results) {
  console.log(`Verifying ${results.length} results (informational only)...`);
  const verified = [];
  for (let i = 0; i < results.length; i += 5) {
    const batch = results.slice(i, i + 5);
    const checked = await Promise.all(batch.map(verifyPosition));
    for (let j = 0; j < batch.length; j++) {
      const merged = { ...batch[j], ...checked[j] };
      if (merged.verification_status !== "Closed") verified.push(merged);
    }
  }
  return verified;
}

// ============================================================================
// JSON / FILE HELPERS
// ============================================================================
function extractJSON(text) {
  const cleaned = String(text || "").trim()
    .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(cleaned); } catch {}
  const first = cleaned.indexOf("[");
  const last = cleaned.lastIndexOf("]");
  if (first !== -1 && last !== -1) {
    try { return JSON.parse(cleaned.slice(first, last + 1)); } catch {}
  }
  const of = cleaned.indexOf("{");
  const ol = cleaned.lastIndexOf("}");
  if (of !== -1 && ol !== -1) {
    try { return JSON.parse(cleaned.slice(of, ol + 1)); } catch {}
  }
  throw new Error("Could not extract valid JSON from AI response.");
}

function loadJSON(file, fallback) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}
function saveJSON(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function loadExisting() { return cleanResults(loadJSON(RESULTS_FILE, [])); }

// ============================================================================
// PAGE-JOIN
// ============================================================================
function attachPageData(items, batch) {
  return items.map(item => {
    const byId = item.page_id != null ? batch.find(p => p.id === Number(item.page_id)) : null;
    const byURL = batch.find(p => normalizeURL(p.url) === normalizeURL(item.url));
    const page = byId || byURL;
    if (!page) return { ...item, url_grounded: false };
    const lang = detectLanguage(page.fullText || page.text);
    const structuredUniversity = String(page.jobPosting?.organization || "").trim();
    const university = String(item.university || structuredUniversity).trim();
    const country = String(item.country || page.jobPosting?.country || "").trim();
    return {
      ...item,
      url: page.url,
      university: university || "Unknown institution",
      university_confidence: university ? "source" : "unknown",
      country: country || "Unknown",
      city: String(item.city || page.jobPosting?.city || "").trim(),
      original_text: page.text,
      _source_page_key: page.key || seenKey(page.url),
      url_grounded: true,
      ...(lang !== "Unknown" ? { application_language: lang } : {})
    };
  });
}

// ============================================================================
// SEEN CACHE
// ============================================================================
// ---- Title fingerprints: catch the SAME vacancy published under a different URL (mirrors, aggregators) before it costs an AI call.
function cleanTitle(t) {
  let s = String(t || "").split(/\s[|—–]\s/)[0];        // drop " — University — AcademicTransfer" / " | EURAXESS"
  s = s.replace(/\s-\s[^-]*,[^-]*$/, "");               // drop trailing " - Oslo, Norway"
  return s;
}
function fpTokens(title) {
  return [...new Set(normalizeIdentityText(cleanTitle(title)).split(" ").filter(w => w.length > 3))].sort();
}
function fpSimilar(a, b) {
  if (a.length < 4 || b.length < 4) return false;        // too generic to trust ("PhD position")
  const sb = new Set(b);
  const inter = a.filter(w => sb.has(w)).length;
  return inter / (new Set([...a, ...b]).size) >= 0.8;
}

// Everything already known: pages the AI reviewed, current results, archived (closed) results.
function knownTitleIndex() {
  const idx = [];
  for (const [key, e] of Object.entries(seenCache)) {
    if (e.tfp && e.ai_reviewed_at) idx.push({ tokens: e.tfp.split(" "), key, uni: "" });
  }
  const add = r => {
    if (!r || !r.title) return;
    idx.push({ tokens: fpTokens(r.title), key: seenKey(r.url || ""), uni: normalizeUniversity(r.university) });
  };
  for (const r of loadJSON(RESULTS_FILE, [])) add(r);
  for (const r of Object.values(loadJSON(ARCHIVE_FILE, {}) || {})) add(r);
  return idx;
}
function findDuplicate(page, idx) {
  const tokens = page.tfpTokens || [];
  if (tokens.length < 4) return null;
  for (const k of idx) {
    if (k.key === page.key) continue;                    // same URL = an update of the same page, handled by the content hash
    if (!fpSimilar(tokens, k.tokens)) continue;
    // for known results we also know the university: the page must mention it, otherwise it is another institution's post
    if (k.uni.length > 2 && !normalizeUniversity(String(page.title || "") + " " + String(page.fullText || "")).includes(k.uni)) continue;
    return k;
  }
  return null;
}

let seenCache = {};

function ageDays(iso) {
  const t = Date.parse(iso || "1970-01-01T00:00:00Z");
  return Number.isFinite(t) ? (Date.now() - t) / 86400000 : 9999;
}

// Canonical key so /nl/ and /en/ AcademicTransfer pages (and EURAXESS locale variants) count as one URL.
function urlKey(url) {
  const u = normalizeURL(url);
  try {
    const p = new URL(u);
    const host = p.host.toLowerCase();
    if (host.endsWith("academictransfer.com")) {
      const m = p.pathname.match(/\/jobs\/(\d+)/);
      if (m) return `academictransfer.com/jobs/${m[1]}`;
    }
    if (host.endsWith("euraxess.ec.europa.eu")) {
      return `euraxess.ec.europa.eu${p.pathname.replace(/^\/[a-z]{2}(?=\/)/, "")}${p.search}`;
    }
    return u;
  } catch { return u; }
}
function seenKey(url) { return urlKey(url); }

function loadSeen() { seenCache = loadJSON(SEEN_FILE, {}) || {}; }
function saveSeen() {
  for (const [k, v] of Object.entries(seenCache)) {
    const age = ageDays(v.last_checked);
    const o = String(v.outcome || "");
    if (o.startsWith("skipped") && age > 45) delete seenCache[k];
    else if (o === "pending" && age > 35) v.outcome = "prescreen-low";
    else if (age > 200) delete seenCache[k];
  }
  writeFileSync(SEEN_FILE, JSON.stringify(seenCache) + "\n");   // compact: this file is large
}

function markSeen(key, patch) {
  const now = new Date().toISOString();
  const prev = seenCache[key] || { first_seen: now, checks: 0 };
  seenCache[key] = { ...prev, ...patch, last_checked: now, checks: (prev.checks || 0) + 1 };
}

// A page needs no AI call when its content is unchanged since it was last reviewed (or rejected by the pre-screen).
function isHandled(page) {
  const e = seenCache[page.key || seenKey(page.url)];
  if (!e || !e.hash || e.hash !== page.hash) return false;
  if (!(e.ai_reviewed_at || e.outcome === "prescreen-low" || e.outcome === "duplicate")) return false;
  return ageDays(e.ai_reviewed_at || e.last_checked) < CFG.RECHECK_DAYS;
}

function updateSeen({ reviewed = [], pending = [], lowTheme = [], duplicates = [], skipped = [], resultKeys = new Set() }) {
  const now = new Date().toISOString();
  for (const p of reviewed) {
    const key = p.key || seenKey(p.url);
    markSeen(key, { outcome: resultKeys.has(key) ? "result" : "reviewed-no-result", hash: p.hash, ai_reviewed_at: now, prescreen: p.prescreen, tfp: (p.tfpTokens || []).join(" ") || undefined, url: undefined, tier3: undefined });
  }
  for (const p of duplicates) {
    markSeen(p.key || seenKey(p.url), { outcome: "duplicate", hash: p.hash, prescreen: p.prescreen, duplicate_of: p.duplicateOf });
  }
  for (const p of lowTheme) {
    markSeen(p.key || seenKey(p.url), { outcome: "prescreen-low", hash: p.hash, prescreen: p.prescreen });
  }
  for (const p of pending) {
    const key = p.key || seenKey(p.url);
    markSeen(key, { outcome: "pending", hash: p.hash, prescreen: p.prescreen, url: p.url, tier3: p.isTier3 ? true : undefined });
  }
  for (const s of skipped) {
    const key = s.key || (s.url ? seenKey(s.url) : "");
    if (!key) continue;
    markSeen(key, { outcome: `skipped:${(s.reason || "unknown").slice(0, 80)}` });
  }
}

// ============================================================================
// BLOCKED
// ============================================================================
function loadBlocked() {
  const raw = loadJSON(BLOCKED_FILE, { domains: [], urls: [] });
  return {
    domains: Array.isArray(raw.domains) ? raw.domains.map(d => String(d).toLowerCase()) : [],
    urls: Array.isArray(raw.urls) ? raw.urls.map(u => normalizeURL(u)) : []
  };
}
function isBlocked(url, blocked) {
  const u = normalizeURL(url);
  if (blocked.urls.includes(u)) return true;
  try {
    const host = new URL(u).host.toLowerCase();
    return blocked.domains.some(d => host === d || host.endsWith(`.${d}`));
  } catch { return false; }
}
function filterBlocked(hits, blocked) {
  if (!blocked.domains.length && !blocked.urls.length) return hits;
  const before = hits.length;
  const kept = hits.filter(h => !isBlocked(h.url, blocked));
  if (before !== kept.length) console.log(`[blocked] ${before - kept.length} hits removed by blocked.json`);
  return kept;
}

// ============================================================================
// REVIEW + BATCHING
// ============================================================================
function tally(items) {
  const m = new Map();
  for (const item of items) m.set(item, (m.get(item) || 0) + 1);
  return Object.fromEntries(m);
}

function providerModelForLabel(label) {
  if (label === SEARCH_REVIEW.name) return SEARCH_REVIEW.model || "";
  if (label === REVIEW.name) return REVIEW.model || "";
  return "";
}

async function reviewPages({ label, mainHits, tier3Hits, mainMax, gapMs, extract, hitsLabel, blocked, stats }) {
  // 1) Pages found in earlier runs that never reached the AI (budget was full) are re-queued first.
  const backlog = Object.values(seenCache)
    .filter(e => e.outcome === "pending" && e.url)
    .sort((a, b) => (b.prescreen || 0) - (a.prescreen || 0))
    .slice(0, CFG.BACKLOG_PER_RUN);
  const toHit = e => ({ title: e.url, url: e.url });
  const blockedFilteredMain = filterBlocked([...mainHits, ...backlog.filter(e => !e.tier3).map(toHit)], blocked);
  const blockedFilteredTier3 = filterBlocked([...tier3Hits, ...backlog.filter(e => e.tier3).map(toHit)], blocked);
  const hits = [...blockedFilteredMain, ...blockedFilteredTier3];
  console.log(`[${label}] ${hits.length} distinct ${hitsLabel} (+${backlog.length} backlog). Opening the pages...`);
  stats.hits_total = hits.length;
  stats.backlog_requeued = backlog.length;

  const { pages, tier3Count, skipped, skippedRecently } = await gatherPages(blockedFilteredMain, blockedFilteredTier3, mainMax, seenCache);
  console.log(`[${label}] ${pages.length} readable PhD-related pages (${tier3Count} Canada/Australia/NZ) of ${hits.length} hits.`);
  stats.pages_read = pages.length;
  stats.fetch_skipped = tally(skipped.map(s => s.reason));
  stats.skipped_recently_failed = skippedRecently;
  stats.pages_from_search_text = fetchStats.raw_used;
  stats.fetch_circuit_skips = fetchStats.circuit_skipped;

  // 2) Split: unchanged-and-already-reviewed / off-theme / candidates for the AI.
  const ranked = rankByPrescreen(pages.map(p => ({ ...p, hash: contentHash(p.fullText) })));
  const handled = [], lowTheme = [], candidates = [];
  for (const p of ranked) {
    if (isHandled(p)) handled.push(p);
    else if (p.theme < CFG.PRESCREEN_MIN_THEME) lowTheme.push(p);
    else candidates.push(p);
  }
  const priority = p => p.prescreen + (seenCache[p.key] ? 0 : 5);          // fresh pages first
  candidates.sort((a, b) => priority(b) - priority(a));

  // 3) Same vacancy under another URL? Compare title fingerprints with everything already known
  //    (reviewed pages, current results, archive) and with higher-priority candidates of this run.
  const known = knownTitleIndex();
  const fresh = [], duplicates = [];
  for (const p of candidates) {
    p.tfpTokens = fpTokens(p.title);
    const dup = findDuplicate(p, known);
    if (dup) { p.duplicateOf = dup.key.slice(0, 120); duplicates.push(p); continue; }
    fresh.push(p);
    if (p.tfpTokens.length >= 4) known.push({ tokens: p.tfpTokens, key: p.key, uni: "" });
  }
  stats.duplicates_skipped = duplicates.length;
  const mainC = fresh.filter(p => !p.isTier3);
  const tier3C = fresh.filter(p => p.isTier3);
  const toReview = [...mainC.slice(0, AI_REVIEW_BUDGET), ...tier3C.slice(0, CFG.AI_REVIEW_BUDGET_TIER3)];
  const reviewSet = new Set(toReview);
  const pending = fresh.filter(p => !reviewSet.has(p));

  stats.already_reviewed_skipped = handled.length;
  stats.prescreen_off_theme = lowTheme.length;
  stats.sent_to_ai = toReview.length;
  stats.queued_for_next_run = pending.length;

  const results = [];
  const reviewedOK = [];
  const failedPages = [];
  let failedBatches = 0, emptyBatches = 0, batches = 0;
  const totalBatches = Math.ceil(toReview.length / EXTRACTION_BATCH_SIZE);
  for (let i = 0; i < toReview.length; i += EXTRACTION_BATCH_SIZE) {
    if (i > 0) await sleep(gapMs);
    batches++;
    const batch = toReview.slice(i, i + EXTRACTION_BATCH_SIZE);
    const batchLabel = `batch ${batches}/${totalBatches}`;
    console.log(`[${label}] ${batchLabel}: sending ${batch.length} pages to extraction:`);
    for (const page of batch) console.log(`  PAGE ${page.id} | ${String(page.title || "(untitled)").slice(0, 120)} | ${page.url}`);
    if ([REVIEW, SEARCH_REVIEW, OPENROUTER].every(p => failedThisRun.has(p.prefix) || !p.configured)) {
      // Every AI provider is dead: keep the remaining pages for the next run instead of burning attempts.
      failedBatches++;
      failedPages.push(...batch);
      continue;
    }
    try {
      const extracted = await extract(batch);
      const raw = Array.isArray(extracted) ? extracted : extracted.items;
      const extractedBy = Array.isArray(extracted) ? label : extracted.provider?.name || label;
      const extractedModel = Array.isArray(extracted) ? providerModelForLabel(label) : (extracted.provider?.model || "");
      if (raw.length === 0) emptyBatches++;
      else console.log(`[${label}] ${batchLabel}: ${raw.length} opportunities returned by ${extractedBy} (${extractedModel || "model not reported"}).`);
      const attached = attachPageData(raw, batch);
      const incompleteKeys = new Set(attached
        .filter(item => !String(item.title || "").trim() || !String(item.country || "").trim() || item.university_confidence === "unknown")
        .map(item => item._source_page_key).filter(Boolean));
      for (const page of batch) {
        if (incompleteKeys.has(page.key || seenKey(page.url))) failedPages.push(page);
        else reviewedOK.push(page);
      }
      results.push(...attached.map(item => ({ ...item, _extracted_by: extractedBy, _ai_model: extractedModel })));
    } catch (error) {
      failedBatches++;
      failedPages.push(...batch);
      console.warn(`[${label}] ${batchLabel} failed: ${safeErrorMessage(error)}`);
    }
  }
  stats.extraction_batches = batches;
  stats.batches_failed = failedBatches;
  stats.empty_batches = emptyBatches;
  stats.ai_returned = results.length;

  // Only pages that really went through the AI count as reviewed; failed ones are retried next run.
  const resultKeys = new Set(results.map(r => seenKey(r.url || "")));
  updateSeen({ reviewed: reviewedOK, pending: [...pending, ...failedPages], lowTheme, duplicates, skipped, resultKeys });

  if (batches > 0 && failedBatches === batches) {
    throw new Error(`${label}: every extraction batch failed (pages were kept for the next run).`);
  }
  return { results, sources: pages.map(p => ({ title: p.title || p.url, url: p.url })), pages };
}

// ============================================================================
// PIPELINES
// ============================================================================
async function callSearchReviewProvider(blocked, stats) {
  const mainHits = await searchReviewDiscover(SEARCH_REVIEW_ANGLES, "Europe-first");
  await sleep(SEARCH_REVIEW_CALL_GAP_MS);
  const tier3Hits = await searchReviewDiscover(SEARCH_REVIEW_TIER3_ANGLES, "Canada/Australia/NZ");
  if (!mainHits.length && !tier3Hits.length) {
    throw new Error(`${SEARCH_REVIEW.name} returned no web sources.`);
  }
  return reviewPages({
    label: SEARCH_REVIEW.name, mainHits, tier3Hits, mainMax: SEARCH_REVIEW_MAX_PAGES,
    gapMs: SEARCH_REVIEW_CALL_GAP_MS,
    extract: pages => extractWithFallback(SEARCH_REVIEW, [REVIEW, OPENROUTER], pages),
    hitsLabel: "search hits", blocked, stats
  });
}

async function callSearchThenReviewProvider(blocked, stats) {
  const mainQueries = queriesForRun(CFG.QUERIES_EU);
  const tier3Queries = tier3QueriesForRun(CFG.QUERIES_TIER3);
  const mainHits = await searchDiscover(mainQueries, "Europe-first");
  const tier3Hits = await searchDiscover(tier3Queries, "Canada/Australia/NZ");
  if (!mainHits.length && !tier3Hits.length) throw new Error(`${SEARCH.name} search returned no results.`);
  return reviewPages({
    label: REVIEW.name, mainHits, tier3Hits, mainMax: REVIEW_MAX_PAGES,
    gapMs: REVIEW_CALL_GAP_MS,
    extract: pages => extractWithFallback(REVIEW, [SEARCH_REVIEW, OPENROUTER], pages),
    hitsLabel: `${SEARCH.name} hits`, blocked, stats
  });
}

const PROVIDERS = [
  {
    id: "tavily_review",
    label: REVIEW.name,
    model: `${REVIEW.model || "?"} (search: ${SEARCH.name})`,
    configured: SEARCH.configured && REVIEW.configured,
    missing: [...SEARCH.missing, ...REVIEW.missing],
    call: callSearchThenReviewProvider
  }
];

async function runProvider(provider, blocked) {
  const run = {
    id: provider.id, label: provider.label, model: provider.model,
    status: "ok", error: "", returned: 0, detail: "",
    results: [], sources: [], stats: {}
  };
  if (!provider.configured) {
    run.status = "skipped";
    run.error = `not configured (missing: ${provider.missing.join(", ")})`;
    console.warn(`[${provider.label}] skipped: ${run.error}`);
    return run;
  }
  console.log(`[${provider.label}] starting (model: ${provider.model})`);
  try {
    const response = await provider.call(blocked, run.stats);
    const rawResults = Array.isArray(response.results) ? response.results : [];
    run.returned = rawResults.length;
    run.sources = response.sources;
    run.detail = `${run.stats.pages_read || 0} pages read, ${run.stats.sent_to_ai || 0} sent to AI`;

    const grounded = rawResults.filter(r => r.url_grounded === true);
    if (grounded.length < rawResults.length) {
      console.log(`[${provider.label}] dropped ${rawResults.length - grounded.length} ungrounded (hallucinated-url) results.`);
    }

    let ieltsBudget = CFG.IELTS_LOOKUP_ENABLED ? CFG.IELTS_LOOKUP_MAX_PER_RUN : 0;
    const withIelts = [];
    if (ieltsBudget > 0) {
      const sorted = grounded.slice().sort((a, b) => (computeScore(b) || 0) - (computeScore(a) || 0));
      for (const r of sorted) {
        const score = computeScore(r) || 0;
        let ielts = { ielts_requirement: "Not specified on official university website", ielts_source_url: "" };
        const key = String(r.university || "").toLowerCase().trim();
        const alreadyCached = universitiesCache[key];
        if (ieltsBudget > 0 && (alreadyCached || score >= CFG.IELTS_LOOKUP_MIN_SCORE) && bestSearchAI()) {
          if (!alreadyCached) ieltsBudget--;
          ielts = await lookupIelts(r.university, r.country);
        }
        withIelts.push({
          ...r,
          ielts_requirement: ielts.ielts_requirement,
          ielts_source_url: ielts.ielts_source_url,
          ai_provider: r._extracted_by || provider.label
        });
      }
    } else {
      for (const r of grounded) {
        withIelts.push({
          ...r,
          ielts_requirement: "Not specified on official university website",
          ielts_source_url: "",
          ai_provider: r._extracted_by || provider.label
        });
      }
    }

    run.results = cleanResults(withIelts);
    run.stats.ai_returned = rawResults.length;
    run.stats.rejected = tally(grounded.map(explainRejection));
    console.log(`[${provider.label}] returned ${run.returned} results, ${run.results.length} passed validation.`);

    // Per-opportunity diagnostics: show the outcome and exact validation reason
    // for every item extracted by the model. Ungrounded URLs are reported too.
    if (rawResults.length > 0) {
      console.log(`[${provider.label}] validation details for all ${rawResults.length} extracted opportunities:`);
      for (const item of rawResults) {
        const title = String(item?.title || "(missing title)").trim().slice(0, 180);
        const university = String(item?.university || "(missing university)").trim().slice(0, 120);
        const groundedUrl = item?.url_grounded === true;
        const reason = groundedUrl
          ? explainRejection(item)
          : "URL not grounded in the search sources";
        const passed = groundedUrl && reason === "passes";
        console.log(`  ${passed ? "PASSED" : "REJECTED"} | ${title} | ${university}`);
        if (!passed) console.log(`    Reason: ${reason}`);
      }
    }
  } catch (error) {
    run.status = "failed";
    run.error = safeErrorMessage(error);
    console.error(`[${provider.label}] FAILED: ${run.error}`);
  }
  return run;
}

async function callAllProviders(blocked) {
  console.log("Single discovery pipeline: " + SEARCH.name + "; primary reviewer: " + REVIEW.name + "; extraction fallbacks: " + ([SEARCH_REVIEW, OPENROUTER].filter(p => p.configured).map(p => p.name).join(" → ") || "none configured"));
  // A failed run no longer aborts early: existing results are still re-verified and saved, and an alert is sent.
  const run = await runProvider(PROVIDERS[0], blocked);
  if (run.status !== "ok") console.warn("Primary search pipeline failed: " + (run.error || run.status));
  return [run];
}

// ============================================================================
// TELEGRAM
// ============================================================================
async function sendTelegramMessage(message, attempt = 1) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram secrets are not configured. Skipping Telegram.");
    return false;
  }
  const endpoint = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, disable_web_page_preview: false })
  });
  const data = await response.json().catch(() => ({}));
  if (!data.ok) {
    if (data.error_code === 429 && attempt < 3) {
      const retryAfter = Number(data.parameters?.retry_after || 5);
      console.warn(`Telegram 429, retrying after ${retryAfter}s (attempt ${attempt})`);
      await sleep(retryAfter * 1000);
      return sendTelegramMessage(message, attempt + 1);
    }
    console.error("Telegram API error:", JSON.stringify(data, null, 2));
    return false;
  }
  console.log("Telegram notification sent.");
  return true;
}

function formatTelegramMessage(position, foundBy) {
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
    `📅 Deadline: ${position.deadline || (position.deadline_type === "rolling" ? "Rolling / open until filled" : (position.deadline_type === "unknown" ? "Not stated on page" : "Not specified"))}`,
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
  // Only notify for grounded results — hallucinated URLs should never hit Telegram.
  for (const position of results.filter(x => Number(x.overall_score) >= 90 && x.url_grounded === true)) {
    const url = normalizeURL(position.url);
    const entry = byURL.get(url) || { best: position, providers: [] };
    if (Number(position.overall_score) > Number(entry.best.overall_score)) entry.best = position;
    if (!entry.providers.includes(position.ai_provider)) entry.providers.push(position.ai_provider);
    byURL.set(url, entry);
  }

  for (const [url, { best, providers }] of byURL) {
    const previousScore = Number(notified[url]?.score || 0);
    // re-notify only on a clear improvement (+5), so a re-scoring of the same vacancy does not spam Telegram
    if (previousScore > 0 && Number(best.overall_score) < previousScore + 5) continue;
    if (previousScore >= Number(best.overall_score)) continue;
    if (await sendTelegramMessage(formatTelegramMessage(best, providers))) {
      notified[url] = { score: Number(best.overall_score), notified_at: new Date().toISOString() };
      changed = true;
    }
  }
  if (changed) saveJSON(NOTIFIED_FILE, notified);
}

let alertSent = false;
async function sendRunAlert(problems, runs) {
  alertSent = true;
  const s = runs.map(r => r.stats || {})[0] || {};
  const lines = [
    "⚠️ PhD Radar — run had problems",
    ...problems.map(p => `• ${p}`),
    "",
    `Pages read: ${s.pages_read ?? "-"} · sent to AI: ${s.sent_to_ai ?? "-"} · queued for next run: ${s.queued_for_next_run ?? "-"}`,
    "Pages that failed are kept and retried automatically on the next run."
  ];
  await sendTelegramMessage(lines.join("\n"));
}

// ============================================================================
// ARCHIVE
// ============================================================================
function updateArchive(results) {
  const archive = loadJSON(ARCHIVE_FILE, {});
  for (const r of results) {
    if (r.verification_status === "Closed") {
      archive[normalizeURL(r.url)] = { ...r, archived_at: new Date().toISOString() };
    }
  }
  saveJSON(ARCHIVE_FILE, archive);
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log("======================================");
  console.log("PHD RADAR");
  console.log("======================================");

  loadSeen();
  loadUniversitiesCache();
  const blocked = loadBlocked();
  BLOCKED_CACHE = blocked;

  console.log(`Budgets: pages≤${MAX_PAGES} (+${TIER3_MAX_PAGES} tier3), ai_review≤${CFG.AI_REVIEW_BUDGET} (+${CFG.AI_REVIEW_BUDGET_TIER3} tier3), queries≤${CFG.QUERIES_EU} (+${CFG.QUERIES_TIER3} tier3), ielts=${CFG.IELTS_LOOKUP_ENABLED ? `on (max ${CFG.IELTS_LOOKUP_MAX_PER_RUN})` : "off"}`);

  const existingResults = loadExisting();
  console.log(`Existing active positions: ${existingResults.length}`);

  let runs;
  if (CLEANUP_ONLY) {
    console.log("CLEANUP_ONLY=true: re-verifying saved results, no discovery or AI extraction.");
    runs = [{
      id: "cleanup", label: "cleanup", model: "", status: "ok",
      error: "", returned: existingResults.length, detail: "cleanup only",
      results: [], sources: [], stats: {}
    }];
  } else {
    console.log(`Running one discovery pipeline: ${SEARCH.name} search → ${REVIEW.name} review (optional extraction fallback: ${SEARCH_REVIEW.configured ? SEARCH_REVIEW.name : "off"}).`);
    runs = await callAllProviders(blocked);
  }

  const sourcesByProvider = new Map(runs.map(run => [run.id, run.sources || []]));
  const allSourcesMap = new Map();
  for (const sources of sourcesByProvider.values()) {
    for (const source of sources) if (source?.url) allSourcesMap.set(source.url, source);
  }

  const failedProviderLabels = Array.from(new Set([
    ...failedThisRun,
    ...runs.filter(run => run.status === "failed").map(run => run.label)
  ]));
  saveJSON(SOURCES_FILE, {
    searched_at: new Date().toISOString(),
    budgets: CFG,
    failed_providers: failedProviderLabels,
    runs: runs.map(run => ({
      provider: run.label, model: run.model, status: run.status, error: run.error,
      returned: run.returned, valid: run.results.length, detail: run.detail,
      sources: (run.sources || []).length, stats: run.stats || {}
    })),
    sources: Array.from(allSourcesMap.values())
  });
  console.log(`Saved ${allSourcesMap.size} search sources across ${runs.length} provider(s).`);

  const merged = new Map();
  for (const result of existingResults) {
    const id = resultIdentity(result);
    const prev = merged.get(id);
    merged.set(id, prev ? mergeResultRecords(prev, result) : result);
  }
  for (const run of runs) {
    for (const result of run.results) {
      const id = resultIdentity(result);
      const prev = merged.get(id);
      merged.set(id, prev ? mergeResultRecords(prev, result) : result);
    }
  }
  const mergedResults = cleanResults(Array.from(merged.values()));

  const verifiedResults = await verifyResults(mergedResults);
  saveJSON(RESULTS_FILE, verifiedResults);
  updateArchive(verifiedResults);
  saveSeen();
  console.log(`Saved ${verifiedResults.length} active positions.`);

  try {
    const fs = await import("node:fs");
    const lines = [
      "## PhD Radar run",
      "",
      `- Existing positions: **${existingResults.length}**`,
      `- Active positions saved: **${verifiedResults.length}**`,
      `- Providers failed this run: \`${failedProviderLabels.join(", ") || "none"}\``,
      ""
    ];
    for (const run of runs) {
      lines.push(`### ${run.label} (${run.status})`);
      if (run.error) lines.push(`Error: \`${run.error}\``);
      const s = run.stats || {};
      if (Object.keys(s).length) {
        lines.push("```");
        lines.push(JSON.stringify(s, null, 2));
        lines.push("```");
      }
      lines.push("");
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
    }
  } catch {}

  await notifyExceptionalMatches(verifiedResults);

  if (!CLEANUP_ONLY) {
    const problems = [];
    for (const run of runs) {
      const s = run.stats || {};
      if (run.status === "failed") problems.push(`${run.label}: ${run.error || "failed"}`);
      else if (s.batches_failed > 0) problems.push(`${s.batches_failed}/${s.extraction_batches} AI batches failed`);
    }
    if (failedProviderLabels.length) problems.push(`providers disabled this run: ${failedProviderLabels.join(", ")}`);
    if (SEARCH_QUOTA_HIT) problems.push("search API plan limit reached");
    if (problems.length) await sendRunAlert(problems, runs);
  }

  for (const label of PROVIDERS.map(p => p.label)) {
    const mine = verifiedResults.filter(r => providerLabelsOf(r.ai_provider).includes(label));
    if (!mine.length) continue;
    console.log(`\nTop matches — ${label}:`);
    for (const r of mine.slice(0, 10)) {
      const groundFlag = r.url_grounded === true ? "" : " [unconfirmed url]";
      console.log(`${r.overall_score}/100 | ${r.title} | ${r.university} | ${r.country} (tier ${r.geo_tier})${groundFlag}`);
    }
  }

  const failed = runs.filter(r => r.status !== "ok");
  if (failed.length === runs.length && runs.length > 0 && !CLEANUP_ONLY) {
    throw new Error(
      "No AI provider succeeded: " +
      failed.map(r => `${r.label}: ${r.error || "unknown failure"}`).join(" | ")
    );
  }

  if (failed.length) {
    console.log(
      `Completed with ${failed.length} failed provider(s); successful provider results were retained.`
    );
  } else {
    console.log("All AI providers completed successfully.");
  }
}

function runSelfTests() {
  assert.equal(
    normalizeUniversity("Delft University of Technology (TU Delft)"),
    normalizeUniversity("TU Delft"),
    "university aliases should normalize to the same key"
  );

  assert.equal(
    isLikelyVacancyPage({ title: "PhD Studentship — Sustainable Consumption", url: "https://example.org/job.pdf", fullText: "Fully funded PhD position with stipend." }),
    true,
    "a doctoral vacancy PDF should be retained"
  );
  for (const title of [
    "What Is Speculative Design? Definition and Origins",
    "Postdoctoral Research Associate in Design",
    "Lecturer in Law x6",
    "Scholarships for International Students by Country",
    "Abstract Book — 2026 Conference"
  ]) {
    assert.equal(isLikelyVacancyPage({ title, url: "https://example.org/page", fullText: "PhD research and sustainability." }), false, title + " should be filtered");
  }

  assert.equal(isClearlyExpiredPage({ url: "https://example.org/job", jobPosting: { validThrough: "2020-01-01" }, fullText: "" }), true);
  assert.equal(isClearlyExpiredPage({ url: "https://example.org/job", jobPosting: { validThrough: "2099-01-01" }, fullText: "" }), false);
  assert.ok(backoffMs({ message: "Rate limit reached. Please try again in 22.05s." }, 1) >= 23550);

  const structured = attachPageData(
    [{ page_id: 1 }],
    [{ id: 1, key: "source-key", url: "https://example.org/phd", jobPosting: { organization: "University of Zurich", country: "Switzerland" }, fullText: "doctoral vacancy", text: "doctoral vacancy" }]
  )[0];
  assert.equal(structured.university, "University of Zurich");
  assert.equal(structured.university_confidence, "source");

  const unknown = attachPageData(
    [{ page_id: 2 }],
    [{ id: 2, key: "unknown-key", url: "https://example.org/phd2", jobPosting: null, fullText: "doctoral vacancy", text: "doctoral vacancy" }]
  )[0];
  assert.equal(unknown.university, "Unknown institution");
  assert.equal(unknown.university_confidence, "unknown");

  const merged = dedupeSimilar([
    { title: "PhD position Participatory Data Governance", university: "TU Delft", url: "https://example.org/position", deadline: "2027-01-01", overall_score: 82 },
    { title: "PhD position Participatory Data Governance", university: "Delft University of Technology (TU Delft)", url: "https://example.org/position", deadline: "2027-01-01", overall_score: 74 }
  ]);
  assert.equal(merged.length, 1, "same URL should always deduplicate");
  console.log("Radar regression self-tests passed.");
}

if (process.env.SELF_TEST === "true") {
  runSelfTests();
} else {
  main().catch(async error => {
  console.error("RADAR FAILED");
  console.error(error?.stack || error);
  process.exitCode = 1;
  if (!alertSent && !CLEANUP_ONLY) {
    try { await sendRunAlert([`fatal: ${safeErrorMessage(error)}`], []); } catch {}
  }
});

}
