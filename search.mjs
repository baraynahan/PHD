import {
  existsSync,
  readFileSync,
  writeFileSync
} from "node:fs";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const RESULTS_FILE = "results.json";
const NOTIFIED_FILE = "notified.json";
const SOURCES_FILE = "sources.json";

const AI_PROVIDER = "gemini";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Labels stored in results.json / shown on the dashboard.
const LABEL_GEMINI = "Gemini";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

if (AI_PROVIDER !== "gemini") {
  throw new Error('AI_PROVIDER must be "gemini".');
}

// Error text ends up in sources.json, which is published on GitHub Pages,
// so never let an API key or a wall of response JSON leak into it.
function safeErrorMessage(error) {
  let message = String(error?.message || error || "Unknown error");
  for (const secret of [GEMINI_API_KEY, TELEGRAM_BOT_TOKEN]) {
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
  "ai_provider": "Gemini"
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

// Same checks cleanResults applies, but reports WHY each raw item was
// dropped instead of just dropping it. Used only for the one-line diagnostic
// printed when a provider returns items but none survive cleaning, so a
// silent "0 passed validation" always comes with a reason on the next run.
function explainRejection(item) {
  if (!item || typeof item !== "object") return "not an object";
  if (!String(item.title || "").trim()) return "missing title";
  if (!String(item.university || "").trim()) return "missing university";
  if (!String(item.country || "").trim()) return "missing country";
  if (!normalizeURL(item.url)) return "missing/invalid url";
  const deadline = normalizeDeadline(item.deadline);
  if (!deadline) return `deadline not a recognizable date (got: ${JSON.stringify(item.deadline ?? "")})`;
  if (!isFutureDeadline(deadline)) return `deadline already passed (${deadline})`;
  const score = Number(item.overall_score);
  if (!Number.isFinite(score)) return `overall_score is not a number (got: ${JSON.stringify(item.overall_score ?? "")})`;
  if (score < 60) return `overall_score ${score} is below 60`;
  return "passes";
}

function providerLabelOf(value) {
  return String(value || "").trim().toLowerCase() === "gemini" ? LABEL_GEMINI : "";
}

function cleanResults(results) {
  if (!Array.isArray(results)) return [];
  // vacancy, each provider keeps its own entry so both results are shown.
  const byKey = new Map();

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
  return cleanResults(loadJSON(RESULTS_FILE, [])).filter(result => result.ai_provider === LABEL_GEMINI);
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
    if (i > 0) await sleep(GEMINI_CALL_GAP_MS);
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

const PROVIDERS = [
  {
    id: "gemini",
    label: LABEL_GEMINI,
    model: GEMINI_MODEL,
    apiKey: GEMINI_API_KEY,
    call: callGemini
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
  console.log(`AI provider: ${selected[0].label} (${selected[0].model})`);
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

  console.log("Running new search (all providers at the same time)...");
  const runs = await callAllProviders();

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

  for (const label of [LABEL_GEMINI]) {
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
