import {
  existsSync,
  readFileSync,
  writeFileSync
} from "node:fs";

const GEMINI_MODEL = "gemini-2.5-flash";
const RESULTS_FILE = "results.json";
const NOTIFIED_FILE = "notified.json";
const VERIFICATION_TIMEOUT_MS = 15000;
const MAX_PAGE_TEXT = 180000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is not configured.");
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
  "ielts_source_url": "..."
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

function cleanResults(results) {
  if (!Array.isArray(results)) return [];
  const seen = new Set();
  const cleaned = [];

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
    if (seen.has(url)) continue;
    seen.add(url);

    const language = ["English", "Not English", "Unknown"].includes(
      String(item.application_language || "")
    ) ? String(item.application_language) : "Unknown";

    cleaned.push({
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
      verified: item.verified === true,
      verification_reason: String(item.verification_reason || "").trim(),
      verified_url: normalizeURL(item.verified_url || item.url),
      verified_at: String(item.verified_at || "").trim()
    });
  }

  cleaned.sort((a, b) =>
    b.overall_score - a.overall_score ||
    new Date(a.deadline) - new Date(b.deadline)
  );

  return cleaned;
}

function extractJSON(text) {
  let cleaned = String(text || "")
    .trim()
    .replace(/^\`\`\`json\s*/i, "")
    .replace(/^\`\`\`\s*/i, "")
    .replace(/\s*\`\`\`$/, "")
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

  throw new Error("Could not extract valid JSON from Gemini response.");
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

function normalizeText(text) {
  return String(text || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^{}()|[\]\\]/g, "\\$&");
}

function titleTokens(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(token => token.length >= 4 && ![
      "with", "from", "this", "that", "phd", "doctoral", "position",
      "research", "project", "candidate", "university"
    ].includes(token));
}

function dateVariants(isoDate) {
  const match = String(isoDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return [];
  const [, year, month, day] = match;
  const date = new Date(`${isoDate}T12:00:00Z`);
  const monthName = date.toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
  const shortMonth = date.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });

  return [
    `${year}-${month}-${day}`,
    `${day}/${month}/${year}`,
    `${day}-${month}-${year}`,
    `${month}/${day}/${year}`,
    `${month}-${day}-${year}`,
    `${day} ${monthName} ${year}`,
    `${monthName} ${day}, ${year}`,
    `${day} ${shortMonth} ${year}`,
    `${shortMonth} ${day}, ${year}`
  ].map(value => value.toLowerCase());
}

function officialUniversityDomain(url, university) {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const universityTokens = String(university || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter(token => token.length >= 5 && ![
        "university", "universiteit", "universita", "universitys",
        "college", "school", "institute", "institution"
      ].includes(token));

    return universityTokens.some(token => hostname.includes(token));
  } catch {
    return false;
  }
}

function hasDeadlineEvidence(text, deadline) {
  const variants = dateVariants(deadline);
  if (variants.some(date => text.includes(date))) return true;

  const match = String(deadline || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;

  const [, year, month, day] = match;
  const monthName = new Date(`${deadline}T12:00:00Z`).toLocaleString("en-GB", {
    month: "long",
    timeZone: "UTC"
  }).toLowerCase();
  const shortMonth = new Date(`${deadline}T12:00:00Z`).toLocaleString("en-GB", {
    month: "short",
    timeZone: "UTC"
  }).toLowerCase();

  const deadlineContext = text.match(/.{0,180}(deadline|closing date|apply by|applications? (?:close|due)|apply before).{0,240}/g) || [];
  return deadlineContext.some(context => {
    const hasYear = context.includes(year);
    const hasMonth = context.includes(month) || context.includes(monthName) || context.includes(shortMonth);
    const hasDay = new RegExp(`(?:^|\\D)${Number(day)}(?:st|nd|rd|th)?(?:\\D|$)`).test(context);
    return hasYear && hasMonth && hasDay;
  });
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFICATION_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "PHD-Radar/1.0 (+https://github.com/baraynahan/PHD)"
      }
    });

    const contentType = response.headers.get("content-type") || "";
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      finalUrl: normalizeURL(response.url || url),
      contentType,
      body
    };
  } finally {
    clearTimeout(timeout);
  }
}

function verifyPageContent(position, page) {
  if (!page.ok) {
    return { verified: false, reason: `HTTP ${page.status}` };
  }

  if (!/^text\/(html|plain)/i.test(page.contentType)) {
    return { verified: false, reason: `Unsupported content type: ${page.contentType || "unknown"}` };
  }

  const text = normalizeText(page.body).slice(0, MAX_PAGE_TEXT);
  if (text.length < 300) {
    return { verified: false, reason: "Page returned too little readable content." };
  }

  const phdTerms = [
    "phd", "ph.d", "doctoral", "doctorate", "doctoral researcher",
    "doctoral candidate", "ph.d. candidate"
  ];
  const vacancyTerms = [
    "apply", "application", "deadline", "closing date", "vacancy",
    "position", "funded", "salary", "stipend"
  ];

  const hasPhD = phdTerms.some(term => text.includes(term));
  const vacancyHits = vacancyTerms.filter(term => text.includes(term)).length;
  const universityHit = text.includes(String(position.university || "").toLowerCase());
  const titleHit = titleTokens(position.title).filter(token =>
    text.includes(token)
  ).length;

  if (!hasPhD) {
    return { verified: false, reason: "Page does not appear to describe a PhD/doctoral position." };
  }

  if (vacancyHits < 2) {
    return { verified: false, reason: "Page does not contain enough vacancy/application evidence." };
  }

  if (!universityHit && titleHit < 2) {
    return { verified: false, reason: "Page does not sufficiently match the university or position title." };
  }

  const deadlineMatches = hasDeadlineEvidence(text, position.deadline);
  if (!deadlineMatches) {
    return {
      verified: false,
      reason: `The page does not contain sufficient evidence for the reported deadline ${position.deadline}.`
    };
  }

  return {
    verified: true,
    reason: "Live page returned successfully and contains PhD, vacancy, identity and deadline evidence."
  };
}

async function verifyPosition(position) {
  const candidateURL = normalizeURL(position.url);
  if (!candidateURL) {
    return { ...position, verified: false, verification_reason: "Missing URL." };
  }

  try {
    const page = await fetchPage(candidateURL);
    const contentCheck = verifyPageContent(position, page);

    if (!contentCheck.verified) {
      return {
        ...position,
        verified: false,
        verification_reason: contentCheck.reason,
        verified_url: page.finalUrl || candidateURL,
        verified_at: new Date().toISOString()
      };
    }

    const pageText = normalizeText(page.body).slice(0, MAX_PAGE_TEXT);
    const universityHit = pageText.includes(String(position.university || "").toLowerCase());
    const titleHit = titleTokens(position.title).filter(token => pageText.includes(token)).length;
    const officialDomain = officialUniversityDomain(page.finalUrl, position.university);

    // University vacancy systems often use a short domain or an ATS subdomain
    // that does not contain the university's full name (e.g. jobs.tue.nl).
    // The live-page content check is therefore the primary identity check.
    if (!officialDomain && !universityHit && titleHit < 2) {
      return {
        ...position,
        verified: false,
        verification_reason: "The live page does not sufficiently identify the reported university or position.",
        verified_url: page.finalUrl || candidateURL,
        verified_at: new Date().toISOString()
      };
    }

    return {
      ...position,
      url: page.finalUrl || candidateURL,
      verified_url: page.finalUrl || candidateURL,
      verified: true,
      verification_reason: contentCheck.reason,
      verified_at: new Date().toISOString()
    };
  } catch (error) {
    return {
      ...position,
      verified: false,
      verification_reason: `URL fetch failed: ${error?.message || "unknown error"}`,
      verified_url: candidateURL,
      verified_at: new Date().toISOString()
    };
  }
}

async function verifyIELTSSource(position) {
  const sourceURL = normalizeURL(position.ielts_source_url);
  if (!sourceURL) {
    return {
      ...position,
      ielts_source_url: "",
      ielts_requirement: "Not specified on official university website"
    };
  }

  try {
    const page = await fetchPage(sourceURL);
    if (!page.ok) {
      return {
        ...position,
        ielts_source_url: "",
        ielts_requirement: "Not specified on official university website"
      };
    }

    const text = normalizeText(page.body).slice(0, MAX_PAGE_TEXT);
    if (!officialUniversityDomain(page.finalUrl || sourceURL, position.university)) {
      return {
        ...position,
        ielts_source_url: "",
        ielts_requirement: "Not specified on official university website"
      };
    }

    const mentionsEnglish = /(ielts|english language|english proficiency|language requirement|english requirement)/i.test(text);
    if (!mentionsEnglish) {
      return {
        ...position,
        ielts_source_url: "",
        ielts_requirement: "Not specified on official university website"
      };
    }

    return {
      ...position,
      ielts_source_url: page.finalUrl || sourceURL
    };
  } catch {
    return {
      ...position,
      ielts_source_url: "",
      ielts_requirement: "Not specified on official university website"
    };
  }
}

async function verifyLanguageSource(position) {
  const sourceURL = normalizeURL(position.language_source_url);
  if (!sourceURL) return position;

  try {
    const page = await fetchPage(sourceURL);
    if (!page.ok || !officialUniversityDomain(page.finalUrl || sourceURL, position.university)) {
      return { ...position, language_source_url: "" };
    }
    return { ...position, language_source_url: page.finalUrl || sourceURL };
  } catch {
    return { ...position, language_source_url: "" };
  }
}

async function verifyResults(results) {
  console.log(`Verifying ${results.length} candidate positions against live pages...`);
  const verified = [];

  for (const position of results) {
    const checked = await verifyPosition(position);

    if (!checked.verified) {
      console.log(`  ✗ ${position.title} — ${checked.verification_reason}`);
      continue;
    }

    const withLanguage = await verifyLanguageSource(checked);
    const withIELTS = await verifyIELTSSource(withLanguage);
    verified.push(withIELTS);
    console.log(`  ✓ ${withIELTS.title} — verified`);
  }

  return cleanResults(verified).filter(position => position.verified === true);
}

async function callGemini() {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const prompt = `
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

================ OUTPUT ================
${OUTPUT_RULES}

Use Google Search extensively. For IELTS and language information,
prefer official university sources. Search the position page and, when
needed, the university's official admissions/doctoral English-language
requirements page. Do not use third-party summaries for IELTS claims.

The URL and deadline will be independently checked by the program after
your response. Never fabricate a plausible URL or deadline. Only return
a candidate when you found evidence for it through web search.

Return only verified current opportunities.
`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ googleSearch: {} }],
    generationConfig: { temperature: 0.2 }
  };

  console.log("Searching Gemini + Google Search...");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const candidate = data?.candidates?.[0];
  const text = candidate?.content?.parts
    ?.map(part => part.text || "")
    .join("") || "";

  if (!text) {
    console.error(JSON.stringify(data, null, 2));
    throw new Error("Gemini returned no usable text.");
  }

  const groundingChunks = candidate?.groundingMetadata?.groundingChunks || [];
  const groundingURLs = groundingChunks
    .map(chunk => chunk?.web?.uri)
    .filter(Boolean);

  console.log(`Google grounding returned ${groundingURLs.length} source URLs.`);
  return extractJSON(text);
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

function formatTelegramMessage(position) {
  const languageLine = position.application_language === "Not English"
    ? "⚠️ Language: Not English"
    : `🗣️ Language: ${position.application_language || "Unknown"}`;

  return [
    `⭐ EXCEPTIONAL PhD MATCH — ${position.overall_score}/100`,
    "",
    `🎓 ${position.title}`,
    "",
    `🏛️ ${position.university}`,
    `🌍 ${position.country}${position.city ? ` · ${position.city}` : ""}`,
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
    "🔗 Apply:",
    position.url
  ].join("\n");
}

async function notifyExceptionalMatches(results) {
  const notified = loadJSON(NOTIFIED_FILE, {});
  let changed = false;

  for (const position of results.filter(x => Number(x.overall_score) >= 90 && x.verified)) {
    const url = normalizeURL(position.url);
    const previousScore = Number(notified[url]?.score || 0);

    if (previousScore >= Number(position.overall_score)) continue;

    if (await sendTelegramMessage(formatTelegramMessage(position))) {
      notified[url] = {
        score: Number(position.overall_score),
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
  console.log(`Existing active positions before verification: ${existingResults.length}`);

  console.log("Running new search...");
  const rawSearchResults = cleanResults(await callGemini());
  console.log(`Gemini returned ${rawSearchResults.length} structurally valid positions.`);

  const combined = [...existingResults, ...rawSearchResults];
  const deduplicated = cleanResults(
    Array.from(
      new Map(combined.map(result => [normalizeURL(result.url), result])).values()
    )
  );

  const verifiedResults = await verifyResults(deduplicated);
  saveJSON(RESULTS_FILE, verifiedResults);

  console.log(`Saved ${verifiedResults.length} verified active positions.`);
  console.log(`Removed ${deduplicated.length - verifiedResults.length} unverified/stale positions.`);

  await notifyExceptionalMatches(verifiedResults);

  console.log("\nTop verified matches:");
  for (const result of verifiedResults.slice(0, 10)) {
    console.log(
      `${result.overall_score}/100 | ${result.title} | ${result.university} | ${result.country} | VERIFIED`
    );
  }

  console.log("\nRadar complete.");
}

main().catch(error => {
  console.error("\nRADAR FAILED");
  console.error(error);
  process.exit(1);
});
