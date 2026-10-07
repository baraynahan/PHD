import {
  existsSync,
  readFileSync,
  writeFileSync
} from "node:fs";

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
  const v = Number(process.env[name]);
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
  AI_REVIEW_BUDGET:        envInt("AI_REVIEW_BUDGET", 25),
  AI_REVIEW_BUDGET_TIER3:  envInt("AI_REVIEW_BUDGET_TIER3", 12),
  QUERIES_EU:              envInt("QUERIES_EU", 24),
  QUERIES_TIER3:           envInt("QUERIES_TIER3", 8),
  EXTRACTION_BATCH_SIZE:   envInt("EXTRACTION_BATCH_SIZE", 6),
  PAGE_TEXT_CHARS:         envInt("PAGE_TEXT_CHARS", 7000),
  SEARCH_RESULTS_PER_QUERY: envInt("SEARCH_RESULTS_PER_QUERY", 10),
  FETCH_CONCURRENCY:       envInt("FETCH_CONCURRENCY", 10),
  IELTS_LOOKUP_ENABLED:    envBool("IELTS_LOOKUP_ENABLED", false),
  IELTS_LOOKUP_MIN_SCORE:  envInt("IELTS_LOOKUP_MIN_SCORE", 90),
  IELTS_LOOKUP_MAX_PER_RUN: envInt("IELTS_LOOKUP_MAX_PER_RUN", 3)
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
  const model = envValue(`${prefix}_MODEL`);
  const missing = [];
  if (!baseUrl) missing.push(`${prefix}_BASE_URL (variable)`);
  if (kind === "ai" && !model) missing.push(`${prefix}_MODEL (variable)`);
  if (!apiKey) missing.push(`${prefix}_API_KEY (secret)`);
  return {
    prefix, kind,
    name: envValue(`${prefix}_NAME`) || defaultName,
    baseUrl, apiKey, model,
    format: (envValue(`${prefix}_FORMAT`) || detectFormat(baseUrl, kind)).toLowerCase(),
    missing,
    configured: missing.length === 0
  };
}

const SEARCH_REVIEW = readProviderConfig("SEARCH_REVIEW", { kind: "ai", defaultName: "Search+Review AI" });
const SEARCH = readProviderConfig("SEARCH", { kind: "search", defaultName: "Search API" });
const REVIEW = readProviderConfig("REVIEW", { kind: "ai", defaultName: "Review AI" });

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

if (!SEARCH_REVIEW.configured && !(SEARCH.configured && REVIEW.configured)) {
  throw new Error(
    "No provider is fully configured. Set the SEARCH_REVIEW_* variables + secret, " +
    "and/or the SEARCH_* and REVIEW_* variables + secrets.\n" +
    `Missing for search+review provider: ${SEARCH_REVIEW.missing.join(", ") || "nothing"}\n` +
    `Missing for search provider: ${SEARCH.missing.join(", ") || "nothing"}\n` +
    `Missing for review provider: ${REVIEW.missing.join(", ") || "nothing"}`
  );
}

function safeErrorMessage(error) {
  let message = String(error?.message || error || "Unknown error");
  for (const secret of [SEARCH_REVIEW.apiKey, SEARCH.apiKey, REVIEW.apiKey, TELEGRAM_BOT_TOKEN]) {
    if (secret) message = message.split(secret).join("***");
  }
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

function isQuotaError(error) {
  const m = String(error?.message || error || "").toLowerCase();
  return /quota exceeded|resource_exhausted|resource exhausted|insufficient_quota|out of credits|billing|exceeded your current quota/.test(m);
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

IMPORTANT LANGUAGE RULES:
1. Determine the actual language of the PhD position/application from the
   supplied page text.
2. Do NOT reject or filter a position because of its language.
3. If the position is not in English, mark it as "Not English".
4. If it is in English, mark it as "English".
5. If the language cannot be verified, mark it as "Unknown".
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
Return ONLY a valid JSON array. Every object MUST contain:
{
  "page_id": <integer — the PAGE number from the header you used>,
  "title": "...",
  "university": "...",
  "country": "...",
  "city": "...",
  "deadline": "YYYY-MM-DD (or empty if the deadline is rolling or not stated)",
  "deadline_type": "dated | rolling | unknown",
  "start_date": "...",
  "url": "... (copy verbatim from the PAGE header)",
  "funding": "...",
  "supervisor": "...",
  "classification": "...",
  "research_area": "...",
  "application_language": "English | Not English | Unknown",
  "overall_score": 0,
  "topic_fit": 0,
  "politics_fit": 0,
  "design_fit": 0,
  "methods_fit": 0,
  "funding_quality": 0,
  "why_it_matches": "...",
  "strategic_fit": "...",
  "why_it_is_not_perfect": "...",
  "eligible": true,
  "reject_reason": ""
}

SCORING — read carefully:
- "overall_score" is 0-100. It should equal the sum of the five sub-scores below.
- Each sub-score is 0-20. Use these anchors consistently:
    topic_fit:       20 = the vacancy IS one of the candidate's core themes;
                     15 = strongly overlaps; 10 = related but peripheral;
                     5 = tangential mention only; 0 = unrelated topic.
    politics_fit:    20 = degrowth/post-growth/political-economy is the core;
                     15 = strong presence; 10 = adjacent framing; 0 = absent.
    design_fit:      20 = design-led project (design/service/systemic/transition/
                     social design); 15 = design methods named explicitly;
                     5 = design mentioned only in passing; 0 = no design dimension.
    methods_fit:     20 = qualitative / participatory / theoretical methods
                     perfectly match; 15 = strongly compatible; 0 = purely
                     quantitative / computational / experimental.
    funding_quality: 15-20 = fully funded, stipend + duration stated; 8-10 =
                     funding mentioned but unclear; 0-5 = no funding mentioned.
- A genuinely central fit should total 80+. A clearly unrelated position
  (auditing, finance, AI/organisational studies, health, engineering) must
  total below 60 even if "sustainability" appears once on the page.

Use an empty string for any field you could not determine from the page text.
Do not invent information, dates, IELTS scores, language status or URLs.
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

function extractMainText(html) {
  const main = html.match(/<main[\s\S]*?<\/main>/i)
    || html.match(/<article[\s\S]*?<\/article>/i)
    || html.match(/<div[^>]+(?:id|class)=["'][^"']*(?:content|vacanc|job|main)[^"']*["'][\s\S]*?<\/div>/i);
  const source = main ? main[0] : html;
  return source
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ").trim();
}

function keywordWindow(text, max) {
  if (text.length <= max) return text;
  const lower = text.toLowerCase();
  const anchors = ["deadline", "closing date", "apply", "application", "funding", "stipend", "salary", "supervisor"];
  let best = 0;
  for (const a of anchors) {
    const i = lower.indexOf(a);
    if (i !== -1 && (best === 0 || i < best)) best = i;
  }
  const start = Math.max(0, best - Math.floor(max / 4));
  return text.slice(start, start + max);
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
      return { ok: false, url: finalURL, title: "", text: "", jobPosting: null, reason: `HTTP ${response.status} / ${contentType || "unknown content type"}` };
    }
    const html = await response.text();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
    const jobPosting = extractJobPosting(html);
    const text = keywordWindow(extractMainText(html), PAGE_TEXT_CHARS);
    return { ok: true, url: finalURL, title, text, jobPosting, reason: "" };
  } finally {
    clearTimeout(timeout);
  }
}

const DOCTORAL_RE = /phd|ph\.d|doctoral|doctorate|doctor of philosophy|higher degree by research|\bhdr\b|promotion|promovend|doktorand/i;

async function fetchHitPages(hits, maxPages, seen) {
  const unique = [];
  const seenURLs = new Set();
  for (const hit of hits) {
    const u = normalizeURL(hit.url);
    if (!u || seenURLs.has(u)) continue;
    seenURLs.add(u);
    unique.push({ ...hit, url: u });
  }

  const scored = unique.map(hit => {
    const entry = seen[hit.url];
    if (!entry) return { hit, rank: 0 };
    const ageDays = (Date.now() - Date.parse(entry.last_checked || 0)) / 86400000;
    if (entry.outcome === "result") return { hit, rank: 1 + ageDays / 1000 };
    if (String(entry.outcome || "").startsWith("skipped")) return { hit, rank: 2 + ageDays / 1000 };
    return { hit, rank: 3 + ageDays / 1000 };
  });
  scored.sort((a, b) => a.rank - b.rank);

  const queue = scored.slice(0, maxPages * 3).map(s => s.hit);
  const fetched = await mapPool(queue, FETCH_CONCURRENCY, hit =>
    perHost(hit.url, async () => {
      try { return { ...hit, ...(await fetchPage(hit.url)) }; }
      catch (e) { return { ...hit, ok: false, reason: safeErrorMessage(e) }; }
    })
  );

  const pages = [], skipped = [];
  for (const p of fetched) {
    if (!p.ok || !p.text || p.text.length < 300) {
      skipped.push({ ...p, reason: p.reason || "page too short" });
      continue;
    }
    if (!DOCTORAL_RE.test(p.text) && !p.jobPosting) {
      skipped.push({ ...p, reason: "not obviously doctoral" });
      continue;
    }
    pages.push(p);
    if (pages.length >= maxPages) break;
  }
  return { pages, skipped };
}

async function gatherPages(mainHits, tier3Hits, mainMax, seen) {
  const main = await fetchHitPages(mainHits, mainMax, seen);
  const seenURLs = new Set(main.pages.map(p => normalizeURL(p.url)));
  const tier3 = await fetchHitPages(tier3Hits.filter(h => !seenURLs.has(normalizeURL(h.url))), TIER3_MAX_PAGES, seen);
  const pages = [...main.pages, ...tier3.pages].map((page, index) => ({ ...page, id: index + 1 }));
  return { pages, skipped: [...main.skipped, ...tier3.skipped], tier3Count: tier3.pages.length };
}

// ============================================================================
// PRE-SCREEN
// ============================================================================
const THEME_WEIGHTS = [
  [/degrowth|post-?growth|post-?consumer|sufficiency/gi, 7],
  [/sustainable consumption|consumption practice|product longevity|repair|reuse|circular econom/gi, 5],
  [/transition design|social design|design justice|co-?design|participatory design|service design|product-?service system/gi, 5],
  [/commons|sharing econom|access-?based|ownership model|collaborative consumption/gi, 4],
  [/socio-?technical transition|transition studies|social practice theor|political ecolog|political econom/gi, 4],
  [/sustainab\w+|governance|public policy|lifestyle/gi, 1]
];
const ANTI_WEIGHTS = [
  [/machine learning|deep learning|neural network|large language model/gi, -6],
  [/catalys|nanomaterial|polymer synthesis|finite element|computational fluid|crystallograph/gi, -6],
  [/clinical trial|randomised controlled|oncolog|epidemiolog/gi, -5]
];
const FUNDING_RE = /fully funded|stipend|salary|scholarship|tariff|collective labour|tv-?l|studentship|tax-?free|per annum|gross monthly/i;

function prescreen(page) {
  const text = `${page.title || ""} ${page.text || ""}`;
  let score = 0;
  for (const [re, w] of [...THEME_WEIGHTS, ...ANTI_WEIGHTS]) {
    score += Math.min(3, (text.match(re) || []).length) * w;
  }
  if (FUNDING_RE.test(text)) score += 4;
  if (page.jobPosting?.validThrough) score += 4;
  return score;
}

function rankByPrescreen(pages) {
  return pages
    .map(p => ({ ...p, prescreen: prescreen(p) }))
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
  "political economy of sustainability", "consumption governance", "social innovation"
];

const FRAMES = [
  t => `fully funded PhD position ${t}`,
  t => `PhD vacancy ${t} ${THIS_YEAR + 1}`,
  t => `doctoral researcher position ${t} deadline`,
  t => `PhD studentship ${t} stipend`
];

const SITES = [
  "academictransfer.com", "jobs.ac.uk", "euraxess.ec.europa.eu",
  "findaphd.com", "jobbnorge.no", "academicpositions.com"
];

const TIER3_SITES = ["findaphd.com", "universityaffairs.ca"];

function weekIndex() {
  const start = Date.UTC(THIS_YEAR, 0, 1);
  return Math.floor((Date.now() - start) / (7 * 86400000));
}

function queriesForRun(count) {
  const all = [];
  for (const t of THEMES) for (const f of FRAMES) all.push(f(t));
  for (const t of THEMES) for (const s of SITES) all.push(`site:${s} PhD ${t}`);
  const start = (weekIndex() * count) % all.length;
  return Array.from({ length: Math.min(count, all.length) }, (_, i) => all[(start + i) % all.length]);
}

function tier3QueriesForRun(count) {
  const all = [];
  for (const t of THEMES) {
    all.push(`fully funded PhD ${t} Australia findaphd`);
    all.push(`PhD scholarship ${THIS_YEAR + 1} ${t} Canada university`);
    for (const s of TIER3_SITES) all.push(`site:${s} PhD ${t}`);
  }
  const start = (weekIndex() * count) % all.length;
  return Array.from({ length: Math.min(count, all.length) }, (_, i) => all[(start + i) % all.length]);
}

// ============================================================================
// AI CALLS
// ============================================================================
const AI_MAX_ATTEMPTS = 2;
const failedThisRun = new Set();

async function aiGenerate(provider, prompt, { useSearch = false, allowEmpty = false } = {}) {
  if (!provider.configured) throw new Error(`${provider.name} is not configured (missing: ${provider.missing.join(", ")}).`);
  if (failedThisRun.has(provider.prefix)) {
    throw new Error(`${provider.name} already failed earlier this run — skipping.`);
  }

  const call = provider.format === "gemini"
    ? () => geminiFormatGenerate(provider, prompt, useSearch, allowEmpty)
    : provider.format === "openai"
    ? () => openaiFormatGenerate(provider, prompt, allowEmpty)
    : null;
  if (!call) throw new Error(`${provider.prefix}_FORMAT "${provider.format}" is not supported.`);

  let lastError;
  for (let attempt = 1; attempt <= AI_MAX_ATTEMPTS; attempt++) {
    try {
      return await call();
    } catch (error) {
      lastError = error;
      if (isQuotaError(error)) {
        failedThisRun.add(provider.prefix);
        console.error(`[${provider.name}] quota exhausted — marking provider dead for this run.`);
        throw error;
      }
      if (!error.retryable || attempt === AI_MAX_ATTEMPTS) {
        if (error.retryable) failedThisRun.add(provider.prefix);
        break;
      }
      const wait = 4000 * attempt;
      console.warn(`[${provider.name}] attempt ${attempt}/${AI_MAX_ATTEMPTS} failed (${safeErrorMessage(error)}); retrying in ${wait / 1000}s...`);
      await sleep(wait);
    }
  }
  throw lastError;
}

function apiError(message, retryable) {
  const e = new Error(message);
  e.retryable = retryable;
  return e;
}
const isRetryableStatus = s => s === 429 || s >= 500;

async function geminiFormatGenerate(provider, prompt, useSearch, allowEmpty) {
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
  if (!response.ok) {
    const msg = data?.error?.message || `${provider.name} HTTP ${response.status}`;
    throw apiError(msg, isRetryableStatus(response.status));
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
    throw apiError(msg, isRetryableStatus(response.status));
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
const REVIEW_CALL_GAP_MS = 3000;
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
        body: JSON.stringify({ api_key: SEARCH.apiKey, query, search_depth: "advanced", max_results: n, include_answer: false, include_raw_content: false, time_range: "year" })
      });
      pick = d => (d.results || []).map(r => ({ title: r.title, url: r.url }));
    } else if (SEARCH.format === "serper") {
      response = await fetch(endpointURL(SEARCH.baseUrl, "/search"), {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-API-KEY": SEARCH.apiKey },
        body: JSON.stringify({ q: query, num: n, tbs: "qdr:y" })
      });
      pick = d => (d.organic || []).map(r => ({ title: r.title, url: r.link }));
    } else if (SEARCH.format === "brave") {
      const url = new URL(endpointURL(SEARCH.baseUrl, "/res/v1/web/search"));
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(Math.min(n, 20)));
      url.searchParams.set("freshness", "py");
      response = await fetch(url, { signal: controller.signal, headers: { "Accept": "application/json", "X-Subscription-Token": SEARCH.apiKey } });
      pick = d => (d.web?.results || []).map(r => ({ title: r.title, url: r.url }));
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

async function searchDiscover(queries, tag = "Europe-first") {
  if (!SEARCH.configured) throw new Error(`${SEARCH.name} is not configured (missing: ${SEARCH.missing.join(", ")}).`);
  console.log(`[${REVIEW.name}] ${SEARCH.name} search discovery starting (${tag})...`);
  const allHits = [], seenURLs = new Set();
  for (let i = 0; i < queries.length; i++) {
    if (i > 0) await sleep(SEARCH_CALL_GAP_MS);
    const query = queries[i];
    const results = await webSearch(query);
    for (const item of results) {
      const url = normalizeURL(item.url);
      if (!url || seenURLs.has(url)) continue;
      seenURLs.add(url);
      allHits.push({ title: String(item.title || url).trim(), url });
    }
    if ((i + 1) % 10 === 0) console.log(`[${REVIEW.name}] ${tag} query ${i + 1}/${queries.length}: ${allHits.length} unique hits so far`);
  }
  return allHits;
}

// ============================================================================
// EXTRACTION PROMPT
// ============================================================================
function buildExtractionPrompt(pages) {
  const pageBlocks = pages.map(page => {
    const jp = page.jobPosting
      ? `STRUCTURED DATA (schema.org JobPosting):\n${JSON.stringify({
          title: page.jobPosting.title,
          organization: page.jobPosting.organization,
          country: page.jobPosting.country,
          city: page.jobPosting.city,
          posted: page.jobPosting.posted,
          validThrough: page.jobPosting.validThrough
        }, null, 2)}\n`
      : "";
    return `--- PAGE ${page.id} ---
URL: ${page.url}
${jp}CONTENT:
${page.text}
--- END PAGE ${page.id} ---`;
  }).join("\n\n");

  return `You are the extraction and verification stage of a funded PhD vacancy radar (Europe first, plus Canada, Australia and New Zealand; never the United States).

${CANDIDATE_PROFILE}
${GEOGRAPHY}
${RULES}
${URL_INTEGRITY_RULE}
${OUTPUT_RULES}

Use the supplied page contents as primary evidence. If STRUCTURED DATA is present, prefer its
"validThrough" over any date mentioned in prose. A page is eligible when it describes one
specific PhD/doctoral vacancy (or a Canada/Australia/NZ funded PhD project / project-linked
scholarship), funding is clearly stated, and either (a) the deadline is explicitly stated and
in the future (after ${TODAY}), or (b) the position is explicitly rolling / open until filled,
or (c) the deadline is simply not stated on the page (set deadline_type="unknown").

${DATE_CONTEXT}

Do not turn a generic programme, news article, lab page or directory into a vacancy.

For "url", copy the URL from the PAGE header you cite in "page_id" — character for character.

Return ONLY a JSON array. Do not use Markdown fences.

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

async function extractWithFallback(primary, fallback, pages) {
  const attempts = [primary];
  if (fallback && fallback.configured && fallback.prefix !== primary.prefix) attempts.push(fallback);
  let lastError;
  for (const provider of attempts) {
    if (failedThisRun.has(provider.prefix)) {
      console.warn(`[${provider.name}] unavailable for this run; skipping extraction fallback attempt.`);
      continue;
    }
    try {
      const { text } = await aiGenerate(provider, buildExtractionPrompt(pages));
      const parsed = extractJSON(text);
      if (!Array.isArray(parsed)) throw new Error(`${provider.name} extraction response was not an array.`);
      return { items: parsed, provider };
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

function subScoreOf(item) {
  const keys = ["topic_fit", "politics_fit", "design_fit", "methods_fit", "funding_quality"];
  const present = keys.map(k => toScore(item?.[k])).filter(Number.isFinite);
  if (present.length === 0) return null;
  const sum = present.reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;
  return Math.round(sum);
}

// Prefer a complete sub-score sum; otherwise fall back to whatever the model
// put in overall_score. Either path is fine — the prompt asks for both.
function computeScore(item) {
  const sub = subScoreOf(item);
  if (sub !== null) return sub;
  const overall = toScore(item.overall_score);
  return Number.isFinite(overall) ? Math.round(overall) : null;
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
  return /not (a )?(phd|doctoral|vacancy|position)|generic (phd )?program|phd programme|not funded|unfunded|no funding|funding absent|unrelated|irrelevant|wrong (country|location)|united states|usa|closed|expired|past deadline|not a specific (phd|doctoral) project/.test(reason);
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
  if (score < 60) return `score ${score} is below 60`;
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
  if (!String(merged.verification_note || "").trim()) merged.verification_note = String(other.verification_note || "").trim();
  if (!String(merged.verification_url || "").trim()) merged.verification_url = normalizeURL(other.verification_url);
  if (!String(merged.ielts_source_url || "").trim()) merged.ielts_source_url = normalizeURL(other.ielts_source_url);
  return merged;
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
    if (score === null || score < 60) continue;

    const dinfo = deadlineInfoOf(item);
    if (dinfo.kind === "invalid") continue;

    const language = ["English", "Not English", "Unknown"].includes(String(item.application_language || ""))
      ? String(item.application_language) : "Unknown";
    const provider = providerLabelsOf(item._extracted_by || item.ai_provider).join(" + ") || "Unknown";

    const candidate = {
      title, university, country, city, url,
      deadline: dinfo.stored,
      deadline_type: dinfo.kind,
      start_date: String(item.start_date || "").trim(),
      geo_tier: geoTier(country),
      score_basis: String(item.score_basis || "ai").trim() || "ai",
      funding: String(item.funding || "").trim(),
      overall_score: Math.round(score),
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
      ai_model: String(item.ai_model || "").trim(),
      url_grounded: item.url_grounded === true,
      first_seen: String(item.first_seen || new Date().toISOString()),
      verification_status: ["Verified", "Not verified", "Closed"].includes(String(item.verification_status || "")) ? String(item.verification_status) : "Not verified",
      verification_checked_at: String(item.verification_checked_at || "").trim(),
      verification_note: String(item.verification_note || "").trim(),
      verification_url: normalizeURL(item.verification_url)
    };

    const identity = resultIdentity(candidate);
    const previous = byIdentity.get(identity);
    byIdentity.set(identity, previous ? mergeResultRecords(previous, candidate) : candidate);
  }

  const cleaned = Array.from(byIdentity.values());
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
const VERIFY_FRESH_DAYS = 3;

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
    return page
      ? { ...item, url: page.url, original_text: page.text, url_grounded: true }
      : { ...item, url_grounded: false };
  });
}

// ============================================================================
// SEEN CACHE
// ============================================================================
let seenCache = {};
function loadSeen() { seenCache = loadJSON(SEEN_FILE, {}) || {}; }
function saveSeen() { saveJSON(SEEN_FILE, seenCache); }
function updateSeen(pages, skipped, results) {
  const now = new Date().toISOString();
  for (const p of pages) {
    const u = normalizeURL(p.url);
    const prev = seenCache[u] || { first_seen: now, checks: 0 };
    seenCache[u] = { ...prev, last_checked: now, checks: (prev.checks || 0) + 1, outcome: "reviewed-no-result" };
  }
  for (const s of skipped) {
    const u = normalizeURL(s.url);
    if (!u) continue;
    const prev = seenCache[u] || { first_seen: now, checks: 0 };
    seenCache[u] = { ...prev, last_checked: now, checks: (prev.checks || 0) + 1, outcome: `skipped:${(s.reason || "unknown").slice(0, 80)}` };
  }
  for (const r of results) {
    const u = normalizeURL(r.url);
    if (!u) continue;
    const prev = seenCache[u] || { first_seen: now, checks: 0 };
    seenCache[u] = { ...prev, last_checked: now, checks: (prev.checks || 0) + 1, outcome: "result" };
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
  const blockedFilteredMain = filterBlocked(mainHits, blocked);
  const blockedFilteredTier3 = filterBlocked(tier3Hits, blocked);
  const hits = [...blockedFilteredMain, ...blockedFilteredTier3];
  console.log(`[${label}] ${hits.length} distinct ${hitsLabel}. Opening the pages...`);
  stats.hits_total = hits.length;

  const { pages, tier3Count, skipped } = await gatherPages(blockedFilteredMain, blockedFilteredTier3, mainMax, seenCache);
  console.log(`[${label}] ${pages.length} readable PhD-related pages (${tier3Count} Canada/Australia/NZ) of ${hits.length} hits.`);
  stats.pages_read = pages.length;
  stats.fetch_skipped = tally(skipped.map(s => s.reason));

  const ranked = rankByPrescreen(pages);
  const tier3Pages = ranked.filter(p => geoTier(p.country) === 3);
  const mainPages = ranked.filter(p => geoTier(p.country) !== 3);
  const toReview = [
    ...mainPages.slice(0, AI_REVIEW_BUDGET),
    ...tier3Pages.slice(0, CFG.AI_REVIEW_BUDGET_TIER3)
  ];
  stats.prescreen_dropped = ranked.length - toReview.length;
  stats.sent_to_ai = toReview.length;

  const results = [];
  const failedPages = [];
  let failedBatches = 0;
  let batches = 0;
  for (let i = 0; i < toReview.length; i += EXTRACTION_BATCH_SIZE) {
    if (i > 0) await sleep(gapMs);
    batches++;
    const batch = toReview.slice(i, i + EXTRACTION_BATCH_SIZE);
    try {
      const extracted = await extract(batch);
      const raw = Array.isArray(extracted) ? extracted : extracted.items;
      const extractedBy = Array.isArray(extracted) ? label : extracted.provider?.name || label;
      results.push(...attachPageData(raw, batch).map(item => ({
        ...item,
        _extracted_by: extractedBy,
        _ai_model: Array.isArray(extracted) ? providerModelForLabel(label) : (extracted.provider?.model || "")
      })));
    } catch (error) {
      failedBatches++;
      failedPages.push(...batch);
      console.warn(`[${label}] could not read pages ${batch[0].id}-${batch[batch.length - 1].id}: ${safeErrorMessage(error)}`);
    }
  }
  stats.batches_failed = failedBatches;
  stats.ai_returned = results.length;

  if (batches > 0 && failedBatches === batches) {
    throw new Error(`${label} found pages but could not read any of them.`);
  }

  updateSeen(pages, skipped, results);
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
    extract: pages => extractWithFallback(SEARCH_REVIEW, REVIEW, pages),
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
    extract: pages => extractWithFallback(REVIEW, SEARCH_REVIEW, pages),
    hitsLabel: `${SEARCH.name} hits`, blocked, stats
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

    // Diagnostic: if every grounded result was rejected, print WHY and a
    // sample of what the model actually returned, so the next run is debuggable.
    if (grounded.length > 0 && run.results.length === 0) {
      console.log(`[${provider.label}] all ${grounded.length} grounded results were rejected. Reasons:`);
      for (const [reason, n] of Object.entries(run.stats.rejected)) {
        console.log(`  ${n}× ${reason}`);
      }
      const sample = grounded[0];
      console.log(`[${provider.label}] sample raw AI result (first of ${grounded.length}):`);
      console.log(JSON.stringify({
        title: sample.title,
        university: sample.university,
        country: sample.country,
        deadline: sample.deadline,
        deadline_type: sample.deadline_type,
        overall_score: sample.overall_score,
        topic_fit: sample.topic_fit,
        politics_fit: sample.politics_fit,
        design_fit: sample.design_fit,
        methods_fit: sample.methods_fit,
        funding_quality: sample.funding_quality,
        eligible: sample.eligible,
        reject_reason: sample.reject_reason
      }, null, 2));
    }
  } catch (error) {
    run.status = "failed";
    run.error = safeErrorMessage(error);
    console.error(`[${provider.label}] FAILED: ${run.error}`);
  }
  return run;
}

async function callAllProviders(blocked) {
  console.log(`AI providers: ${PROVIDERS.map(p => `${p.label} (${p.model})`).join(", ")}`);
  const runs = await Promise.all(PROVIDERS.map(p => runProvider(p, blocked)));
  if (!runs.some(r => r.status === "ok")) {
    throw new Error("No AI provider succeeded: " + runs.map(r => `${r.label}: ${r.error || r.status}`).join(" | "));
  }
  return runs;
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
    if (previousScore >= Number(best.overall_score)) continue;
    if (await sendTelegramMessage(formatTelegramMessage(best, providers))) {
      notified[url] = { score: Number(best.overall_score), notified_at: new Date().toISOString() };
      changed = true;
    }
  }
  if (changed) saveJSON(NOTIFIED_FILE, notified);
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
    console.log(`Running new search across ${PROVIDERS.map(p => p.label).join(" + ")}...`);
    runs = await callAllProviders(blocked);
  }

  const sourcesByProvider = new Map(runs.map(run => [run.id, run.sources || []]));
  const allSourcesMap = new Map();
  for (const sources of sourcesByProvider.values()) {
    for (const source of sources) if (source?.url) allSourcesMap.set(source.url, source);
  }

  saveJSON(SOURCES_FILE, {
    searched_at: new Date().toISOString(),
    budgets: CFG,
    failed_providers: [...failedThisRun],
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
      `- Providers failed this run: \`${[...failedThisRun].join(", ") || "none"}\``,
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

main().catch(error => {
  console.error("RADAR FAILED");
  console.error(error?.stack || error);
  process.exitCode = 1;
});
