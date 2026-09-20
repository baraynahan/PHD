import {
  existsSync,
  readFileSync,
  writeFileSync
} from "node:fs";

const GEMINI_MODEL = "gemini-2.5-flash";
const RESULTS_FILE = "results.json";
const NOTIFIED_FILE = "notified.json";
const SOURCES_FILE = "sources.json";

const AI_PROVIDER = String(process.env.AI_PROVIDER || "gemini").toLowerCase();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const APMIX_API_KEY = process.env.APMIX_API_KEY;
const APMIX_MODEL = process.env.APMIX_MODEL || "deepseek-v4.1-flash-free";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (AI_PROVIDER === "gemini" && !GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is not configured.");
}

if (["apmix", "both"].includes(AI_PROVIDER) && !APMIX_API_KEY) {
  throw new Error("APMIX_API_KEY is not configured.");
}

if (["gemini", "both"].includes(AI_PROVIDER) && !GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is not configured.");
}

if (!["gemini", "apmix", "both"].includes(AI_PROVIDER)) {
  throw new Error('AI_PROVIDER must be "gemini", "apmix", or "both".');
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
  "ielts_source_url": "...",
  "ai_provider": "Gemini | APMix"
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
      ai_provider: ["Gemini", "APMix"].includes(String(item.ai_provider || ""))
        ? String(item.ai_provider)
        : "Gemini",
      verification_status: ["Verified", "Not verified"].includes(String(item.verification_status || ""))
        ? String(item.verification_status)
        : "Not verified",
      verification_checked_at: String(item.verification_checked_at || "").trim(),
      verification_note: String(item.verification_note || "").trim(),
      verification_url: normalizeURL(item.verification_url)
    });
  }

  cleaned.sort((a, b) =>
    b.overall_score - a.overall_score ||
    new Date(a.deadline) - new Date(b.deadline)
  );

  return cleaned;
}


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
      .split(/\\W+/)
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

async function callGemini() {
  console.log(`AI provider: Gemini`);
  console.log(`AI model: ${GEMINI_MODEL}`);
  console.log(`Gemini API key configured: ${Boolean(GEMINI_API_KEY)}`);

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

${true
  ? `Use Google Search extensively. For IELTS and language information,
prefer official university sources. Search the position page and, when
needed, the university's official admissions/doctoral English-language
requirements page. Do not use third-party summaries for IELTS claims.

Return only verified current opportunities.`
  : `You are being tested through APMix using an OpenAI-compatible API.
There is no Google Search tool available in this request. Do not invent
URLs, deadlines or positions. Use only information you actually know.
If you cannot reliably identify a current vacancy, return fewer results
rather than fabricating one.

Return only opportunities you can identify with high confidence.`}
`;

  {
    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    async function requestGemini(generationConfig) {
      const body = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig
      };

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(`Gemini API error ${response.status}: ${JSON.stringify(data)}`);
      }

      return data;
    }

    console.log("Gemini is searching Google...");

    let data = await requestGemini({ temperature: 0.2 });
    let groundingResponses = [data];

    let text = data?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("") || "";

    if (!text) {
      const candidate = data?.candidates?.[0];
      console.warn(
        "Gemini returned no text on the first attempt.",
        JSON.stringify({
          finishReason: candidate?.finishReason,
          finishMessage: candidate?.finishMessage,
          tokenCount: candidate?.tokenCount,
          hasGrounding: Boolean(candidate?.groundingMetadata),
          groundingChunks: candidate?.groundingMetadata?.groundingChunks?.length || 0,
          webSearchQueries: candidate?.groundingMetadata?.webSearchQueries || [],
          promptFeedback: data?.promptFeedback
        })
      );

      data = await requestGemini({
        temperature: 0.2,
        thinkingConfig: { thinkingBudget: 0 }
      });
      groundingResponses.push(data);

      text = data?.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join("") || "";
    }

    if (!text) {
      console.error(JSON.stringify(data, null, 2));
      throw new Error("Gemini returned no usable text after retry.");
    }

    const results = extractJSON(text);
    const sources = groundingResponses
      .flatMap(response => response?.candidates || [])
      .flatMap(candidate => candidate?.groundingMetadata?.groundingChunks || [])
      .map(chunk => chunk?.web)
      .filter(web => web?.uri)
      .map(web => ({
        title: String(web.title || "").trim(),
        url: normalizeURL(web.uri)
      }))
      .filter(source => source.url);
    const uniqueSources = Array.from(
      new Map(sources.map(source => [source.url, source])).values()
    );
    console.log(`Gemini grounding sources captured: ${uniqueSources.length}`);
    return { results, sources: uniqueSources };
  }

  const endpoint = "https://api.apmix.ai/v1/chat/completions";

  console.log(`APMix model: ${APMIX_MODEL}`);
  console.log("APMix test mode: no Google Search grounding is attached to this request.");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${APMIX_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: APMIX_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`APMix API error ${response.status}: ${JSON.stringify(data)}`);
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

  return { results: extractJSON(text), sources: [] };
}


async function callAPMix() {
  console.log("AI provider: APMix");
  console.log(`APMix model: ${APMIX_MODEL}`);
  console.log(`APMix API key configured: ${Boolean(APMIX_API_KEY)}`);

  const prompt = buildPrompt("apmix");
  const endpoint = "https://api.apmix.ai/v1/chat/completions";

  console.log("APMix is searching its model knowledge (no Google Search grounding).");

  console.log("APMix checking models available to this API key...");
  try {
    const modelsResponse = await fetch("https://api.apmix.ai/v1/models", {
      headers: { "Authorization": "Bearer " + APMIX_API_KEY }
    });
    const modelsData = await modelsResponse.json();
    console.log("APMix /v1/models HTTP status:", modelsResponse.status);
    if (modelsResponse.ok) {
      const models = Array.isArray(modelsData?.data) ? modelsData.data : [];
      const ids = models.map(model => String(model?.id || "")).filter(Boolean);
      console.log("APMix accessible models:", ids.length);
      console.log("APMix target model available:", ids.includes(APMIX_MODEL));
      if (ids.length > 0) console.log("APMix model IDs:", ids.join(", "));
    } else {
      console.error("APMix /v1/models error:", JSON.stringify(modelsData, null, 2));
    }
  } catch (error) {
    console.error("APMix model availability check failed:", String(error?.message || error));
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${APMIX_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: APMIX_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 12000
    })
  });

  const requestId = response.headers.get("x-request-id") || response.headers.get("request-id") || "not provided";
  console.log("APMix HTTP status:", response.status);
  console.log("APMix request ID:", requestId);

  const data = await response.json();
  if (!response.ok) {
    console.error("APMix API error body:", JSON.stringify(data, null, 2));
    throw new Error(`APMix API error ${response.status}: ${JSON.stringify(data)}`);
  }

  const choice = data?.choices?.[0];
  const text = choice?.message?.content || "";
  console.log("APMix request succeeded at HTTP level.");
  console.log("APMix response text length:", text.length);
  if (text) console.log("APMix response preview:", text.slice(0, 1000));
  console.log("APMix finish reason:", choice?.finish_reason || "unknown");
  if (data?.usage) console.log("APMix usage:", JSON.stringify(data.usage));

  if (!text) {
    console.error("APMix returned no usable content. Full response:", JSON.stringify(data, null, 2));
    return { results: [], sources: [], provider: "APMix" };
  }

  try {
    return { results: extractJSON(text), sources: [], provider: "APMix" };
  } catch (error) {
    console.error("APMix returned non-JSON text:", text.slice(0, 2000));
    console.error(error);
    return { results: [], sources: [], provider: "APMix" };
  }
}

function buildPrompt(provider) {
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

================ OUTPUT ================
${OUTPUT_RULES}

${provider === "gemini"
  ? `Use Google Search extensively. For IELTS and language information,
prefer official university sources. Search the position page and, when
needed, the university's official admissions/doctoral English-language
requirements page. Do not use third-party summaries for IELTS claims.

Return only verified current opportunities.`
  : `There is no Google Search tool available in this APMix request.
Do not invent URLs, deadlines or positions. Use only information you
actually know. If you cannot reliably identify a current vacancy,
return fewer results rather than fabricating one.

Return only opportunities you can identify with high confidence.`}
`;
}

async function callProviders() {
  if (AI_PROVIDER === "gemini") return await callGemini();
  if (AI_PROVIDER === "apmix") return await callAPMix();

  console.log("Running BOTH AI providers.");
  const [gemini, apmix] = await Promise.allSettled([callGemini(), callAPMix()]);
  const results = [];
  const sources = [];

  if (gemini.status === "fulfilled") {
    results.push(...gemini.value.results.map(x => ({ ...x, ai_provider: "Gemini" })));
    sources.push(...gemini.value.sources);
  } else {
    console.error("Gemini failed:", gemini.reason);
  }

  if (apmix.status === "fulfilled") {
    results.push(...apmix.value.results.map(x => ({ ...x, ai_provider: "APMix" })));
  } else {
    console.error("APMix failed:", apmix.reason);
  }

  return {
    results,
    sources: Array.from(new Map(sources.map(s => [s.url, s])).values()),
    provider: "Both"
  };
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

  for (const position of results.filter(x => Number(x.overall_score) >= 90)) {
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
  console.log(`Existing active positions: ${existingResults.length}`);
  console.log("Running new search...");

  console.log(`AI provider mode: ${AI_PROVIDER}`);
  const searchResponse = await callProviders();
  const newSearchResults = cleanResults(searchResponse.results);
  saveJSON(SOURCES_FILE, {
    searched_at: new Date().toISOString(),
    ai_provider: searchResponse.provider,
    model: searchResponse.provider === "Gemini"
      ? GEMINI_MODEL
      : searchResponse.provider === "APMix"
        ? APMIX_MODEL
        : `${GEMINI_MODEL} + ${APMIX_MODEL}`,
    sources: Array.isArray(searchResponse.sources) ? searchResponse.sources : []
  });
  console.log(`Saved ${Array.isArray(searchResponse.sources) ? searchResponse.sources.length : 0} search sources.`);
  console.log(`${searchResponse.provider} returned ${newSearchResults.length} valid positions.`);

  const byURL = new Map(existingResults.map(result => [normalizeURL(result.url), result]));

  for (const result of newSearchResults) {
    const url = normalizeURL(result.url);
    const existing = byURL.get(url);

    if (!existing || Number(result.overall_score) >= Number(existing.overall_score)) {
      byURL.set(url, existing ? { ...existing, ...result } : result);
    }
  }

  const mergedResults = cleanResults(Array.from(byURL.values()));
  const verifiedResults = await verifyResults(mergedResults);
  saveJSON(RESULTS_FILE, verifiedResults);

  console.log(`Saved ${verifiedResults.length} active positions. Verification is informational only; no results were removed.`);
  await notifyExceptionalMatches(verifiedResults);

  console.log("\nTop matches:");
  for (const result of mergedResults.slice(0, 10)) {
    console.log(
      `${result.overall_score}/100 | ${result.title} | ${result.university} | ${result.country}`
    );
  }

  console.log("\nRadar complete.");
}

main().catch(error => {
  console.error("\nRADAR FAILED");
  console.error(error);
  process.exit(1);
});
