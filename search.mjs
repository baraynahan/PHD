import {
  existsSync,
  readFileSync,
  writeFileSync
} from "node:fs";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const RESULTS_FILE = "results.json";
const NOTIFIED_FILE = "notified.json";
const SOURCES_FILE = "sources.json";

// "both" (default) runs Gemini and ChatGPT at the same time and keeps both
// sets of results. "gemini" or "apmix" run just one provider (handy for testing).
const AI_PROVIDER = String(process.env.AI_PROVIDER || "both").toLowerCase();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const APMIX_API_KEY = process.env.APMIX_API_KEY;

// ChatGPT is reached through the apmix.ai API provider.
const APMIX_MODEL = process.env.APMIX_MODEL || "gpt-5.6-luna-free";

// Off by default. If you turn this on and apmix's endpoint doesn't support
// a web-search tool on chat/completions, the code below catches the error
// and silently retries without it — it will not break your run either way.
const APMIX_USE_WEB_SEARCH = String(process.env.APMIX_USE_WEB_SEARCH || "false").toLowerCase() === "true";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Labels stored in results.json / shown on the dashboard.
const LABEL_GEMINI = "Gemini";
const LABEL_CHATGPT = "ChatGPT";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

if (!["both", "gemini", "apmix"].includes(AI_PROVIDER)) {
  throw new Error('AI_PROVIDER must be "both", "gemini" or "apmix".');
}

// Error text ends up in sources.json, which is published on GitHub Pages,
// so never let an API key or a wall of response JSON leak into it.
function safeErrorMessage(error) {
  let message = String(error?.message || error || "Unknown error");
  for (const secret of [GEMINI_API_KEY, APMIX_API_KEY, TELEGRAM_BOT_TOKEN]) {
    if (secret) message = message.split(secret).join("***");
  }
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

const CANDIDATE_PROFILE = `
The candidate is an Industrial Design graduate, university lecturer,
sustainability educator, and design researcher.

The candidate's trajectory is:
PRODUCT DESIGN → SUSTAINABLE DESIGN → SUSTAINABLE CONSUMPTION →
PRODUCT LONGEVITY → CONSUMPTION SYSTEMS → OWNERSHIP / ACCESS →
POST-GROWTH / DEGROWTH → SOCIAL + POLITICAL TRANSFORMATION.

Strong interests include degrowth, post-growth, political economy,
sustainable consumption, alternative ownership/access, commons,
sufficiency, social practices, ecological/social transformation,
transition design, social design, design justice, participatory/co-design,
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
Prioritise Netherlands, Belgium, Sweden, Denmark, Norway, Finland,
United Kingdom, Germany, Italy, Switzerland and Austria.
Then consider France, Ireland, Spain, Portugal, Luxembourg and Iceland,
plus strong opportunities elsewhere. Geography is a preference, not a
research-fit filter. Exclude the United States.
`;

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

Score 0-100 using research-topic fit, degrowth/political/social fit,
sustainability, design compatibility, consumption/ownership/systems,
methods, candidate background and funding quality. Return only scores 60+.

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
  "ai_provider": "Gemini | ChatGPT"
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
    for (const param of [
      "utm_source", "utm_medium", "utm_campaign", "utm_term",
      "utm_content", "ref", "source"
    ]) {
      parsed.searchParams.delete(param);
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return String(url).trim().replace(/\/$/, "");
  }
}

function isFutureDeadline(deadline) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(deadline || ""))) return false;
  const date = new Date(`${deadline}T23:59:59`);
  return Number.isFinite(date.getTime()) && date.getTime() > Date.now();
}

// Maps any provider spelling (including the old "APMix" label already stored
// in results.json) to one of the two dashboard labels. "" = unknown/legacy.
function providerLabelOf(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "gemini") return LABEL_GEMINI;
  if (["chatgpt", "apmix", "openai", "gpt"].includes(v)) return LABEL_CHATGPT;
  return "";
}

function cleanResults(results) {
  if (!Array.isArray(results)) return [];
  // Keyed by provider + URL: if Gemini and ChatGPT both find the same
  // vacancy, each provider keeps its own entry so both results are shown.
  const byKey = new Map();

  for (const item of results) {
    if (!item || typeof item !== "object") continue;

    const title = String(item.title || "").trim();
    const university = String(item.university || "").trim();
    const country = String(item.country || "").trim();
    const city = String(item.city || "").trim();
    const deadline = String(item.deadline || "").trim();
    const url = normalizeURL(item.url);
    const score = Number(item.overall_score);

    if (!title || !university || !country || !url) continue;
    if (!isFutureDeadline(deadline)) continue;
    if (!Number.isFinite(score) || score < 60) continue;

    const language = ["English", "Not English", "Unknown"].includes(
      String(item.application_language || "")
    ) ? String(item.application_language) : "Unknown";

    const provider = providerLabelOf(item.ai_provider) || "Unknown";

    const candidate = {
      title,
      university,
      country,
      city,
      deadline,
      url,
      funding: String(item.funding || "").trim(),
      overall_score: Math.round(score),
      why_it_matches: String(item.why_it_matches || item.fit_reason || "").trim(),
      strategic_fit: String(item.strategic_fit || "").trim(),
      why_it_is_not_perfect: String(item.why_it_is_not_perfect || "").trim(),
      supervisor: String(item.supervisor || "").trim(),
      classification: String(item.classification || "").trim(),
      research_area: String(item.research_area || "").trim(),
      application_language: language,
      language_source_url: normalizeURL(item.language_source_url),
      ielts_requirement: String(
        item.ielts_requirement || "Not specified on official university website"
      ).trim(),
      ielts_source_url: normalizeURL(item.ielts_source_url),
      ai_provider: provider,
      // Left empty for older entries that never recorded a model.
      ai_model: String(item.ai_model || "").trim(),
      // Informational only, same philosophy as verification below: this is
      // a label for you to weigh, it never removes a result.
      url_grounded: item.url_grounded === true
        ? true
        : (item.url_grounded === false ? false : null), // null = unknown (ChatGPT has no grounding source list)
      verification_status: ["Verified", "Not verified"].includes(String(item.verification_status || ""))
        ? String(item.verification_status)
        : "Not verified",
      verification_checked_at: String(item.verification_checked_at || "").trim(),
      verification_note: String(item.verification_note || "").trim(),
      verification_url: normalizeURL(item.verification_url)
    };

    const key = `${provider}|${url}`;
    const previous = byKey.get(key);
    if (previous && previous.overall_score >= candidate.overall_score) continue;
    byKey.set(key, candidate);
  }

  const cleaned = Array.from(byKey.values());

  cleaned.sort((a, b) =>
    b.overall_score - a.overall_score ||
    new Date(a.deadline) - new Date(b.deadline)
  );

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

    const phdSignal = /phd|ph\.d|doctoral|doctorate/.test(text);
    const vacancySignal = /vacancy|position|fellowship|scholarship|researcher|job opening|apply/.test(text);
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

function loadExisting() {
  return cleanResults(loadJSON(RESULTS_FILE, []));
}

// Prompt for ChatGPT (via apmix). Gemini builds its own prompts, see below.
function buildChatGPTPrompt() {
  const chatgptInstructions = `You are being queried through apmix.ai as ChatGPT (${APMIX_MODEL}).
${APMIX_USE_WEB_SEARCH
    ? `A web-search tool may be available to you in this request — use it
whenever you can to find and confirm real, currently open vacancy pages.`
    : `There is no web-search tool attached to this request.`}
Do not invent URLs, deadlines or positions. Use only information you
actually know with high confidence, and prefer well-known, large,
well-documented funding programmes where you are more likely to be
right. If you cannot reliably identify a current vacancy and its exact
URL, return fewer results rather than fabricating one.`;

  return `
You are an expert PhD opportunity researcher.

Find currently open, fully funded PhD positions that are exceptionally
well aligned with this candidate.

================ CANDIDATE ================
${CANDIDATE_PROFILE}

================ GEOGRAPHY ================
${GEOGRAPHY}

================ SEARCH STRATEGY ================
${SEARCH_STRATEGY}

================ RULES ================
${RULES}

${URL_INTEGRITY_RULE}

================ OUTPUT ================
${OUTPUT_RULES}

${chatgptInstructions}

Today's date is ${todayISO()}. Only return positions whose deadline is after this date.
`;
}

// ---------------------------------------------------------------------------
// Gemini pipeline: the model never writes a URL.
//   1. DISCOVER  - Gemini + Google Search finds pages. We keep only the search
//                  metadata (the pages it actually found), not the URLs it types.
//   2. FETCH     - this script opens each of those pages itself and reads the text.
//   3. EXTRACT   - Gemini reads the page text and fills in deadline/funding/score.
//                  The URL saved is the address this script fetched.
// ---------------------------------------------------------------------------

const GEMINI_DISCOVERY_ANGLES = [
  "degrowth, post-growth, post-consumerism, political economy, commons, sufficiency, and social and ecological transformation",
  "sustainable consumption, product longevity, repair and reuse, circular economy, sustainable lifestyles, social practices and consumption systems",
  "alternative ownership and access, sharing, service systems, transition design, social design, design justice, participatory and co-design, critical design",
  "governance, public policy, transition studies, sustainability science, STS, sociology or political science PhDs about consumption and sustainability"
];
const GEMINI_MAX_PAGES = Number(process.env.GEMINI_MAX_PAGES) || 30;
const PAGE_TEXT_CHARS = 9000;
const EXTRACTION_BATCH_SIZE = 4;
const PAGE_USER_AGENT = "Mozilla/5.0 (compatible; PhD-Radar/1.0; +https://github.com/baraynahan/PHD)";

// Words that suggest a doctoral vacancy, including common non-English ones
// (language is never a reason to drop a position).
const DOCTORAL_SIGNAL = /phd|ph\.d|doctoral|doctorate|doctorant|doctorat|doctorado|dottorato|promotie|promovend|promotion|doktorand|doktor|avhandling|forskarutbildning/i;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

async function geminiRequest({ prompt, tools, generationConfig }, isRetry = false) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig
  };
  if (tools) body.tools = tools;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 429 && !isRetry) {
      const retryInfo = data?.error?.details?.find(
        d => d["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
      );
      const match = String(retryInfo?.retryDelay || "").match(/^(\d+(?:\.\d+)?)s?$/);
      const waitMs = Math.min(match ? Number(match[1]) * 1000 : 15000, 60000) + 1000;
      console.warn(`[Gemini] 429 (rate/quota limited). Waiting ${Math.round(waitMs / 1000)}s and retrying once...`);
      await sleep(waitMs);
      return geminiRequest({ prompt, tools, generationConfig }, true);
    }
    const err = new Error(`Gemini API error ${response.status}: ${JSON.stringify(data)}`);
    err.status = response.status;
    throw err;
  }
  return data;
}

function geminiText(data) {
  return (data?.candidates || [])
    .flatMap(candidate => candidate?.content?.parts || [])
    .map(part => part.text || "")
    .join("");
}

// The pages Google Search actually found. Each uri is normally a
// vertexaisearch.cloud.google.com redirect that leads to the real page.
function geminiSearchHits(data) {
  return (data?.candidates || [])
    .flatMap(candidate => candidate?.groundingMetadata?.groundingChunks || [])
    .map(chunk => chunk?.web)
    .filter(web => web?.uri)
    .map(web => ({ title: String(web.title || "").trim(), uri: String(web.uri).trim() }));
}

function buildDiscoveryPrompt(angle) {
  return `
You are an expert PhD opportunity researcher. Today's date is ${todayISO()}.

Use Google Search to find currently open, fully funded PhD positions for this
candidate, focusing on: ${angle}.

${CANDIDATE_PROFILE}
${GEOGRAPHY}

Search for individual vacancy pages (official university career/vacancy/doctoral
pages first; EURAXESS, jobs.ac.uk, AcademicTransfer and similar boards are also
fine), not general listings or programme overviews. Run several different
searches with different keywords and countries.

Reply with a short bullet list of the specific vacancies you found (title and
university). Do not write JSON.
`;
}

async function geminiDiscover() {
  const hits = [];
  let succeeded = 0;
  let lastError = null;

  // Sequential on purpose: keeps us inside free-tier requests-per-minute limits.
  for (const [index, angle] of GEMINI_DISCOVERY_ANGLES.entries()) {
    console.log(`[Gemini] search ${index + 1}/${GEMINI_DISCOVERY_ANGLES.length}: ${angle.slice(0, 55)}...`);
    try {
      const request = { prompt: buildDiscoveryPrompt(angle), tools: [{ googleSearch: {} }] };
      let data = await geminiRequest({ ...request, generationConfig: { temperature: 0.2 } });
      let found = geminiSearchHits(data);

      if (!found.length && !geminiText(data)) {
        // Empty response (seen before with thinking models): retry once without thinking.
        console.warn("[Gemini] empty response, retrying once without thinking...");
        data = await geminiRequest({
          ...request,
          generationConfig: { temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } }
        });
        found = geminiSearchHits(data);
      }
      succeeded++;
      hits.push(...found);
      console.log(`[Gemini]   -> ${found.length} search hits`);
    } catch (error) {
      lastError = error;
      console.warn(`[Gemini] search ${index + 1} failed: ${safeErrorMessage(error)}`);
    }
  }

  if (!succeeded) throw lastError || new Error("All Gemini searches failed.");
  return Array.from(new Map(hits.map(hit => [hit.uri, hit])).values());
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?(br|p|div|li|ul|ol|h[1-6]|tr|td|th|section|article|header|footer)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&(euro|pound|ndash|mdash|lsquo|rsquo|ldquo|rdquo|hellip|copy);/gi, (_, name) => (
      { euro: "€", pound: "£", ndash: "–", mdash: "—", lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', hellip: "…", copy: "©" }
    )[name.toLowerCase()])
    .replace(/&#(\d+);/g, (_, code) => {
      try { return String.fromCodePoint(Number(code)); } catch { return " "; }
    })
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function pageTitleOf(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? htmlToText(match[1]).slice(0, 200) : "";
}

// Opens a page like a browser would and returns where it really lives plus its text.
async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": PAGE_USER_AGENT, "Accept": "text/html,application/xhtml+xml" }
    });
    const finalURL = normalizeURL(response.url || url);
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}`, url: finalURL };

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!/text\/html|application\/xhtml|text\/plain/.test(contentType)) {
      return { ok: false, reason: `unsupported content type (${contentType || "unknown"})`, url: finalURL };
    }
    const html = (await response.text()).slice(0, 400000);
    return { ok: true, url: finalURL, title: pageTitleOf(html), text: htmlToText(html) };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === "AbortError" ? "timed out" : `fetch failed (${String(error?.message || error).slice(0, 80)})`,
      url: normalizeURL(url)
    };
  } finally {
    clearTimeout(timeout);
  }
}

// Turns the search hits into real, readable pages (deduplicated by final URL).
async function fetchHitPages(hits) {
  const pages = new Map();
  const skipped = { unreachable: 0, notReadable: 0, notDoctoral: 0, duplicate: 0 };

  for (let i = 0; i < hits.length; i += 5) {
    const batch = hits.slice(i, i + 5);
    const fetched = await Promise.all(batch.map(hit => fetchPage(hit.uri)));
    fetched.forEach((page, j) => {
      if (!page.ok) {
        skipped.unreachable++;
        console.log(`[Gemini]   skip (${page.reason}): ${batch[j].title || page.url}`);
      } else if (page.text.length < 400) {
        skipped.notReadable++;
        console.log(`[Gemini]   skip (almost no text, probably needs JavaScript): ${page.url}`);
      } else if (!DOCTORAL_SIGNAL.test(page.text) && !DOCTORAL_SIGNAL.test(page.title)) {
        skipped.notDoctoral++;
        console.log(`[Gemini]   skip (no PhD/doctoral wording): ${page.url}`);
      } else if (pages.has(page.url)) {
        skipped.duplicate++;
      } else {
        pages.set(page.url, page);
      }
    });
  }
  return { pages: Array.from(pages.values()), skipped };
}

function buildExtractionPrompt(batch) {
  const pageBlocks = batch.map(page => `=== PAGE ${page.id} ===
TITLE: ${page.title}
TEXT:
${page.text.slice(0, PAGE_TEXT_CHARS)}
=== END PAGE ${page.id} ===`).join("\n\n");

  return `
You are an expert PhD opportunity researcher. Today's date is ${todayISO()}.

Below are web pages that this program has ALREADY fetched. Read each page and
decide whether it describes ONE specific, currently open PhD/doctoral position
that suits the candidate.

================ CANDIDATE ================
${CANDIDATE_PROFILE}

================ GEOGRAPHY ================
${GEOGRAPHY}

================ RULES ================
- Use ONLY facts written on the page. Never guess or fill gaps from memory.
- "qualifies" is true only if the page is one specific PhD/doctoral vacancy
  (not a listing, news item, programme overview, blog post or a closed call),
  the funding is clearly stated as covering the PhD (salary, stipend or
  scholarship), and it is not in the United States.
- "deadline" must be a deadline stated on the page, written as YYYY-MM-DD.
  Leave it "" if none is stated or it has already passed.
- Score 0-100 from research-topic fit, degrowth/political/social fit,
  sustainability, design compatibility, consumption/ownership/systems, methods,
  candidate background and funding quality.
- "application_language" is the language the vacancy/application is written in:
  "English", "Not English" or "Unknown". Never reject a position because of its
  language.
- Only fill "ielts_requirement" when this page itself states an English-language
  or IELTS requirement, and set "ielts_stated_on_page" to true. Otherwise leave
  it "" and use false. Never guess a score.
- Do NOT output any URL. The program already knows each page's address.

================ OUTPUT ================
Return ONLY a JSON array with one object per page, in this shape:
{
  "page_id": 1,
  "qualifies": true,
  "title": "...",
  "university": "...",
  "country": "...",
  "city": "...",
  "deadline": "YYYY-MM-DD",
  "funding": "...",
  "overall_score": 0,
  "why_it_matches": "...",
  "strategic_fit": "...",
  "why_it_is_not_perfect": "...",
  "supervisor": "...",
  "application_language": "English | Not English | Unknown",
  "ielts_requirement": "",
  "ielts_stated_on_page": false
}
For a page that does not qualify, return only {"page_id": N, "qualifies": false}.

${pageBlocks}
`;
}

async function extractBatch(batch) {
  const prompt = buildExtractionPrompt(batch);
  const config = { temperature: 0.1, responseMimeType: "application/json" };

  let data = await geminiRequest({ prompt, generationConfig: config });
  let text = geminiText(data);
  if (!text) {
    console.warn("[Gemini] empty extraction response, retrying once without thinking...");
    data = await geminiRequest({
      prompt,
      generationConfig: { ...config, thinkingConfig: { thinkingBudget: 0 } }
    });
    text = geminiText(data);
  }
  if (!text) throw new Error("Gemini returned no text for the extraction step.");

  let parsed = extractJSON(text);
  if (!Array.isArray(parsed)) {
    parsed = Array.isArray(parsed?.pages) ? parsed.pages
      : Array.isArray(parsed?.results) ? parsed.results : [];
  }

  const results = [];
  for (const item of parsed) {
    const page = batch.find(p => p.id === Number(item?.page_id));
    if (!page || item.qualifies !== true) continue;

    const ieltsStated = item.ielts_stated_on_page === true && String(item.ielts_requirement || "").trim();
    // Built field by field, so nothing the model typed (including any "url")
    // can reach the results. The URL is the page this program fetched.
    results.push({
      title: item.title,
      university: item.university,
      country: item.country,
      city: item.city,
      deadline: item.deadline,
      funding: item.funding,
      overall_score: item.overall_score,
      why_it_matches: item.why_it_matches,
      strategic_fit: item.strategic_fit,
      why_it_is_not_perfect: item.why_it_is_not_perfect,
      supervisor: item.supervisor,
      application_language: item.application_language,
      url: page.url,
      language_source_url: page.url,
      ielts_requirement: ieltsStated ? String(item.ielts_requirement).trim() : "",
      ielts_source_url: ieltsStated ? page.url : "",
      url_grounded: true,
      ai_model: GEMINI_MODEL
    });
  }
  return results;
}

async function callGemini() {
  const hits = await geminiDiscover();
  console.log(`[Gemini] ${hits.length} distinct search hits. Opening the pages...`);

  const { pages: readable, skipped } = await fetchHitPages(hits);
  const pages = readable.slice(0, GEMINI_MAX_PAGES).map((page, index) => ({ ...page, id: index + 1 }));
  console.log(`[Gemini] ${pages.length} readable PhD-related pages (of ${hits.length} hits); reading them now...`);

  const results = [];
  let failedBatches = 0;
  let batches = 0;
  for (let i = 0; i < pages.length; i += EXTRACTION_BATCH_SIZE) {
    batches++;
    const batch = pages.slice(i, i + EXTRACTION_BATCH_SIZE);
    try {
      results.push(...await extractBatch(batch));
    } catch (error) {
      failedBatches++;
      console.warn(`[Gemini] could not read pages ${batch[0].id}-${batch[batch.length - 1].id}: ${safeErrorMessage(error)}`);
    }
  }
  if (batches > 0 && failedBatches === batches) {
    throw new Error("Gemini found pages but could not read any of them.");
  }

  const detail = `${hits.length} search hits, ${pages.length} readable pages, ` +
    `${results.length} qualified` +
    (failedBatches ? `, ${failedBatches}/${batches} read batches failed` : "");
  console.log(`[Gemini] ${detail}`);

  return {
    results,
    // The real pages Gemini's search led to (not the Google redirect links).
    sources: pages.map(page => ({ title: page.title || page.url, url: page.url })),
    detail
  };
}

async function callApmix(prompt) {
  const endpoint = "https://api.apmix.ai/v1/chat/completions";
  console.log(`APMix is querying model: ${APMIX_MODEL}`);
  console.log(`APMix web-search tool requested: ${APMIX_USE_WEB_SEARCH}`);

  async function requestApmix(withTools) {
    const body = {
      model: APMIX_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2
    };
    if (withTools) {
      // Experimental: OpenAI-style web_search tool. Whether apmix actually
      // supports this on /v1/chat/completions is unconfirmed — check their
      // docs. If it's rejected, we fall back to a plain request below.
      body.tools = [{ type: "web_search" }];
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${APMIX_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) {
      const err = new Error(`APMix API error ${response.status}: ${JSON.stringify(data)}`);
      err.status = response.status;
      throw err;
    }
    return data;
  }

  let data;
  if (APMIX_USE_WEB_SEARCH) {
    try {
      data = await requestApmix(true);
    } catch (error) {
      console.warn(`APMix rejected the web_search tool (${error.message}). Retrying without it.`);
      data = await requestApmix(false);
    }
  } else {
    data = await requestApmix(false);
  }

  const text = data?.choices?.[0]?.message?.content || "";
  console.log("APMix request succeeded.");
  if (data?.usage) {
    console.log("APMix usage:", JSON.stringify(data.usage));
  } else {
    console.log("APMix did not return a usage object.");
  }

  if (!text) {
    console.error(JSON.stringify(data, null, 2));
    throw new Error("APMix returned no usable text.");
  }

  const parsed = extractJSON(text);
  const labeledResults = (Array.isArray(parsed) ? parsed : []).map(r => ({
    ...r,
    // APMix has no grounding-chunk list to check against, so we leave this
    // as null ("unknown") rather than pretending we verified it — the HTTP
    // verification step below still runs on every result regardless.
    url_grounded: null,
    ai_model: APMIX_MODEL
  }));

  return { results: labeledResults, sources: [] };
}

const PROVIDERS = [
  {
    id: "gemini",
    label: LABEL_GEMINI,
    model: GEMINI_MODEL,
    apiKey: GEMINI_API_KEY,
    call: callGemini
  },
  {
    id: "apmix",
    label: LABEL_CHATGPT,
    model: APMIX_MODEL,
    apiKey: APMIX_API_KEY,
    call: () => callApmix(buildChatGPTPrompt())
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

  if (!provider.apiKey) {
    run.status = "skipped";
    run.error = "API key not configured";
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
  } catch (error) {
    run.status = "failed";
    run.error = safeErrorMessage(error);
    console.error(`[${provider.label}] FAILED: ${run.error}`);
  }
  return run;
}

// Runs the selected providers at the same time.
async function callAllProviders() {
  const selected = PROVIDERS.filter(p => AI_PROVIDER === "both" || p.id === AI_PROVIDER);
  console.log(`AI providers: ${selected.map(p => `${p.label} (${p.model})`).join(" + ")}`);
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

  // Same vacancy found by both Gemini and ChatGPT -> one message, listing both.
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

  console.log("Running new search (all providers at the same time)...");
  const runs = await callAllProviders();

  // Grounding sources only exist for Gemini (Google Search). ChatGPT has none.
  const geminiSources = runs.find(run => run.id === "gemini")?.sources || [];

  saveJSON(SOURCES_FILE, {
    searched_at: new Date().toISOString(),
    runs: runs.map(run => ({
      provider: run.label,
      model: run.model,
      status: run.status,
      error: run.error,
      returned: run.returned,
      valid: run.results.length,
      detail: run.detail
    })),
    sources: geminiSources
  });
  console.log(`Saved ${geminiSources.length} Gemini search sources.`);

  // Merge existing + new, keyed by provider + URL so both providers' results
  // are kept side by side. Within one provider, the higher score wins.
  const keyOf = result => `${result.ai_provider}|${normalizeURL(result.url)}`;
  const merged = new Map(existingResults.map(result => [keyOf(result), result]));
  for (const run of runs) {
    for (const result of run.results) {
      const key = keyOf(result);
      const existing = merged.get(key);
      if (!existing || Number(result.overall_score) >= Number(existing.overall_score)) {
        merged.set(key, existing ? { ...existing, ...result } : result);
      }
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

  for (const label of [LABEL_GEMINI, LABEL_CHATGPT]) {
    const mine = verifiedResults.filter(result => result.ai_provider === label);
    if (!mine.length && !runs.some(run => run.label === label)) continue;
    console.log(`\nTop matches — ${label}:`);
    for (const result of mine.slice(0, 10)) {
      const groundFlag = result.url_grounded === false ? " [ungrounded]" : "";
      console.log(
        `${result.overall_score}/100 | ${result.title} | ${result.university} | ${result.country}${groundFlag}`
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
