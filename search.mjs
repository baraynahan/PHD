import {
  existsSync,
  readFileSync,
  writeFileSync
} from "node:fs";

const GEMINI_MODEL = "gemini-2.5-flash";
const RESULTS_FILE = "results.json";
const NOTIFIED_FILE = "notified.json";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is not configured.");
}

/* ============================================================
   CANDIDATE PROFILE
   ============================================================ */

const CANDIDATE_PROFILE = `
The candidate is an Industrial Design graduate, university lecturer,
sustainability educator, and design researcher.

Academic/professional identity priority:
1. Sustainability researcher/educator
2. Industrial/product designer
3. University lecturer
4. Design researcher

The candidate is willing to move completely away from product design
for a PhD. A theoretical PhD is acceptable, including projects with
little or no making.

The candidate is particularly interested in the intersection of:

design
+
sustainability
+
consumption
+
systems
+
social transformation
+
post-growth / degrowth
+
alternative futures

The candidate's intellectual trajectory is:

PRODUCT DESIGN
→ SUSTAINABLE DESIGN
→ SUSTAINABLE CONSUMPTION
→ PRODUCT LONGEVITY
→ CONSUMPTION SYSTEMS
→ OWNERSHIP / ACCESS
→ POST-GROWTH / DEGROWTH
→ SOCIAL + POLITICAL TRANSFORMATION

The candidate is especially interested in research connecting design
with wider social, economic, political and ecological systems.
`;

/* ============================================================
   RESEARCH PRIORITIES
   ============================================================ */

const RESEARCH_PRIORITIES = `
Ranked research priorities:

1. Degrowth / post-growth
2. Political economy
3. Social and ecological transformation
4. Post-consumerism / consumer culture
5. Alternative ownership / access / commons
6. Governance / public policy
7. Sustainable consumption
8. Product longevity
9. Repair / reuse

Very strong themes:

- degrowth
- post-growth
- post-consumerism
- sustainable consumption
- alternative consumption systems
- alternative ownership
- access over ownership
- commons
- sharing
- sufficiency
- social practices
- political economy
- ecological transformation
- social transformation
- transition design
- social design
- design justice
- participatory design
- co-design
- public-sector design
- governance
- policy
- sustainable lifestyles
- consumption systems
- service systems
- systems change
- transition studies
- alternative futures
- speculative futures
- critical design
`;

/* ============================================================
   DISCIPLINES
   ============================================================ */

const DISCIPLINES = `
The candidate is comfortable applying to:

- Design Research
- Industrial Design
- Product Design
- Service Design
- Design Studies
- Design for Sustainability
- Transition Design
- Social Design
- Design & Society
- Sustainability Studies
- Innovation Studies
- STS
- Political Science
- Political Economy
- Sociology
- Environmental Humanities
- Urban / Spatial Design
- Social Practice Research
- Transition Studies
- Consumption Studies
- Environmental Social Science

A position does NOT need to contain "design" in its title.

A sociology, political economy, sustainability, environmental humanities,
STS, transition studies, or related PhD can be an excellent match if the
research topic strongly fits the candidate.

Do NOT reject a position simply because the academic department is not
design.

Conversely, a position with "sustainable design" in its title should be
rejected if it is primarily materials science, engineering, chemistry,
manufacturing, or technical LCA.
`;

/* ============================================================
   METHODS
   ============================================================ */

const METHODS = `
The candidate is comfortable with:

- qualitative research
- interviews
- ethnography
- participant observation
- participatory research
- participatory design
- co-design
- workshops
- speculative design
- design fiction
- prototyping
- service design
- system mapping
- behavioural research
- policy analysis
- discourse analysis
- theoretical research
- case studies
- action research
- living labs
- community-based research
- social practice research
- mixed methods
- quantitative methods when appropriate

The candidate is particularly comfortable with qualitative research.

LCA can be used as a supporting method.

The candidate prefers to avoid projects where the central work is:

- materials science
- chemistry
- advanced engineering
- manufacturing engineering
- computational modelling
- data science
- AI
- technical optimisation
`;

/* ============================================================
   EXCLUSIONS
   ============================================================ */

const EXCLUSIONS = `
Reject or heavily penalize:

1. Materials science as the main research topic
2. Chemistry as the main research topic
3. Engineering-heavy sustainability
4. Manufacturing engineering
5. Pure technical LCA
6. Battery/material development
7. Polymer/material chemistry
8. Mechanical engineering
9. Pure energy engineering
10. AI/computational research as the main topic
11. Purely technical optimisation
12. Projects with no meaningful connection to the candidate's interests
13. Projects requiring a highly specialised engineering degree
14. Self-funded PhDs
15. Tuition-only PhDs
16. Funding that is unclear or cannot reasonably be verified
17. Positions whose deadline has already passed
18. Positions without a real, verifiable application page
19. Positions that are merely generic PhD programmes with no specific
    funded position currently open
20. United States / USA positions

The United States must be excluded regardless of research fit.
`;

/* ============================================================
   GEOGRAPHY
   ============================================================ */

const GEOGRAPHY = `
Geographic priorities:

TIER 1:
- Netherlands
- Belgium
- Sweden
- Denmark
- Norway
- Finland
- United Kingdom
- Germany
- Italy
- Switzerland
- Austria

TIER 2:
- France
- Ireland
- Spain
- Portugal
- Luxembourg
- Iceland

TIER 3:
- all other countries worldwide

Strong opportunities in Canada, Australia, New Zealand, Japan,
South Korea, Singapore, Taiwan, Hong Kong, Eastern Europe and elsewhere
should still be considered.

Geography is a preference only.

A weaker research fit must NOT receive a high score merely because
the university is in a preferred country.
`;

/* ============================================================
   FUNDING
   ============================================================ */

const FUNDING_RULES = `
Funding is mandatory.

Accept only positions where the PhD is:

- fully funded
- salaried
- funded through a doctoral contract
- funded through a scholarship that clearly covers the PhD

Reject:

- self-funded PhDs
- tuition-only positions
- positions where funding is unclear
- generic programmes where the student must independently find funding

Prefer positions where salary/stipend and funding are explicitly stated.
`;

/* ============================================================
   VALIDITY
   ============================================================ */

const VALIDITY_RULES = `
Every result MUST be a real, currently open PhD / doctoral position.

The position must have:

- a specific PhD/doctoral research topic
- a university/research institution
- a real application page
- a verifiable future deadline
- clear funding
- enough information to judge research fit

Do NOT include:

- expired positions
- positions with deadlines in the past
- generic programme pages with no open project
- old job advertisements
- blog posts
- funding databases without a specific open position
- articles discussing PhD opportunities
- speculative future positions
- positions that cannot be verified

The current date is the date on which the search runs.
Use the actual current date when evaluating deadlines.
`;

/* ============================================================
   SEARCH STRATEGY
   ============================================================ */

const SEARCH_STRATEGY = `
Search broadly across many conceptual clusters.

Do NOT only search for "industrial design PhD".

Search combinations around:

1. design + sustainability
2. design + degrowth
3. design + post-growth
4. design + sustainable consumption
5. design + post-consumerism
6. design + political economy
7. design + alternative ownership
8. design + commons
9. design + sharing
10. design + access instead of ownership
11. design + social transformation
12. design + ecological transformation
13. transition design
14. social design
15. design justice
16. design + governance
17. design + public policy
18. design + consumption systems
19. service design + sustainability
20. service systems + consumption
21. product longevity
22. repair and reuse
23. sustainable lifestyles
24. social practices + consumption
25. environmental sociology + consumption
26. political economy + sustainability
27. degrowth + consumption
28. post-growth + society
29. post-growth + policy
30. alternative economic systems
31. sufficiency
32. commons
33. sharing economy
34. access economy
35. social innovation
36. transition studies
37. ecological transition
38. societal transformation
39. alternative futures
40. speculative futures
41. critical design
42. design fiction
43. sustainable consumption systems
44. ownership models
45. circular economy + society
46. circular economy + consumption
47. circular economy + policy

Search official university career pages and official PhD vacancy pages
whenever possible.

Search across the candidate's priority countries first, then globally.

Look beyond titles.

For example, a PhD titled:

"Changing Consumption Practices in Post-Growth Societies"

may be an excellent result even if it does not contain the word design.

Likewise:

"Political Economy of Sustainable Lifestyles"

could be an excellent result.

However:

"Advanced Sustainable Polymer Materials"

should be rejected even though it contains sustainability.
`;

/* ============================================================
   SCORING
   ============================================================ */

const SCORING = `
Score every position from 0 to 100.

Use these weights:

Research-topic fit:                  25
Degrowth / political / social fit:   20
Sustainability fit:                  15
Design compatibility:                15
Consumption / ownership / systems:   10
Methods compatibility:                5
Candidate background:                 5
Funding quality:                      5

Interpretation:

90-100 = Exceptional match
80-89  = Very strong match
70-79  = Strong match
60-69  = Wildcard / potentially relevant
Below 60 = reject

A high score requires genuine intellectual alignment.

Do NOT inflate scores because of university prestige,
country preference, or the presence of the word "sustainability".

A position about sustainable materials should score poorly if the
candidate's interests are not central to the project.

A position about degrowth, sustainable consumption, alternative
ownership, political economy, social transformation or transition
design can score extremely highly even if the project is housed in
sociology, political science, environmental studies, or another
non-design department.
`;

/* ============================================================
   OUTPUT
   ============================================================ */

const OUTPUT_RULES = `
Return ONLY valid JSON.

Return an array of objects.

Each object MUST contain:

{
  "title": "...",
  "university": "...",
  "country": "...",
  "deadline": "YYYY-MM-DD",
  "url": "...",
  "funding": "...",
  "overall_score": 0,
  "why_it_matches": "...",
  "strategic_fit": "..."
}

Rules:

- deadline must be an actual future deadline
- overall_score must be an integer from 0 to 100
- URL must be the actual application/vacancy page
- explain why the project fits the candidate specifically
- strategic_fit should explain how the project fits the candidate's
  long-term trajectory
- do not invent information
- if funding cannot be verified, reject the position
- if deadline cannot be verified, reject the position
- if the position is expired, reject it
- only return positions scoring 60 or higher
- prioritize quality over quantity
- return as many genuinely strong matches as you can verify
`;

/* ============================================================
   HELPERS
   ============================================================ */

function normalizeURL(url) {
  if (!url) return "";

  try {
    const parsed = new URL(url.trim());

    parsed.hash = "";

    const trackingParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "ref",
      "source"
    ];

    for (const param of trackingParams) {
      parsed.searchParams.delete(param);
    }

    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.trim().replace(/\/$/, "");
  }
}

function isFutureDeadline(deadline) {
  if (!deadline) return false;

  const date = new Date(`${deadline}T23:59:59`);

  if (Number.isNaN(date.getTime())) return false;

  return date.getTime() > Date.now();
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
    const deadline = String(item.deadline || "").trim();
    const url = normalizeURL(item.url);

    const score = Number(item.overall_score);

    if (!title || !university || !url) continue;

    if (!isFutureDeadline(deadline)) continue;

    if (!Number.isFinite(score)) continue;

    if (score < 60) continue;

    if (seen.has(url)) continue;

    seen.add(url);

    cleaned.push({
      title,
      university,
      country,
      deadline,
      url,
      funding: String(item.funding || "").trim(),
      overall_score: Math.round(score),
      why_it_matches: String(
        item.why_it_matches || item.fit_reason || ""
      ).trim(),
      strategic_fit: String(
        item.strategic_fit || ""
      ).trim()
    });
  }

  cleaned.sort(
    (a, b) =>
      b.overall_score - a.overall_score ||
      new Date(a.deadline) - new Date(b.deadline)
  );

  return cleaned;
}

function extractJSON(text) {
  let cleaned = String(text || "").trim();

  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const firstArray = cleaned.indexOf("[");
  const lastArray = cleaned.lastIndexOf("]");

  if (firstArray !== -1 && lastArray !== -1) {
    const possibleJSON = cleaned.slice(
      firstArray,
      lastArray + 1
    );

    try {
      return JSON.parse(possibleJSON);
    } catch {}
  }

  throw new Error(
    "Could not extract valid JSON from Gemini response."
  );
}

/* ============================================================
   FILE STORAGE
   ============================================================ */

function loadExisting() {
  if (!existsSync(RESULTS_FILE)) {
    return [];
  }

  try {
    const parsed = JSON.parse(
      readFileSync(RESULTS_FILE, "utf8")
    );

    return cleanResults(parsed);
  } catch (error) {
    console.error(
      "Could not read results.json:",
      error.message
    );

    return [];
  }
}

function saveResults(results) {
  writeFileSync(
    RESULTS_FILE,
    JSON.stringify(results, null, 2) + "\n"
  );
}

function loadNotified() {
  if (!existsSync(NOTIFIED_FILE)) {
    return {};
  }

  try {
    return JSON.parse(
      readFileSync(NOTIFIED_FILE, "utf8")
    );
  } catch {
    return {};
  }
}

function saveNotified(notified) {
  writeFileSync(
    NOTIFIED_FILE,
    JSON.stringify(notified, null, 2) + "\n"
  );
}

/* ============================================================
   GEMINI
   ============================================================ */

async function callGemini() {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const prompt = `
You are an expert PhD opportunity researcher.

Your task is to find currently open, fully funded PhD positions
that are exceptionally well aligned with this specific candidate.

================ CANDIDATE PROFILE ================

${CANDIDATE_PROFILE}

================ RESEARCH PRIORITIES ================

${RESEARCH_PRIORITIES}

================ DISCIPLINES ================

${DISCIPLINES}

================ METHODS ================

${METHODS}

================ EXCLUSIONS ================

${EXCLUSIONS}

================ GEOGRAPHY ================

${GEOGRAPHY}

================ FUNDING ================

${FUNDING_RULES}

================ VALIDITY ================

${VALIDITY_RULES}

================ SEARCH STRATEGY ================

${SEARCH_STRATEGY}

================ SCORING ================

${SCORING}

================ OUTPUT ================

${OUTPUT_RULES}

Use Google Search extensively.

Search multiple conceptual clusters rather than relying on one query.

Prioritize official university and research institution pages.

The goal is not to find generic sustainability PhDs.

The goal is to find PhDs that could realistically become the next
academic step in this candidate's trajectory from sustainable design
toward sustainable consumption, systems change, degrowth, post-growth,
political economy and social/ecological transformation.

Return only verified current opportunities.
`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: prompt
          }
        ]
      }
    ],
    tools: [
      {
        googleSearch: {}
      }
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json"
    }
  };

  console.log("Searching Gemini + Google Search...");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Gemini API error ${response.status}: ${errorText}`
    );
  }

  const data = await response.json();

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("") || "";

  if (!text) {
    console.error(
      JSON.stringify(data, null, 2)
    );

    throw new Error(
      "Gemini returned no usable text."
    );
  }

  return extractJSON(text);
}

/* ============================================================
   TELEGRAM
   ============================================================ */

async function sendTelegramMessage(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log(
      "Telegram secrets are not configured. Skipping Telegram."
    );

    return false;
  }

  const endpoint =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      disable_web_page_preview: false
    })
  });

  const data = await response.json();

  if (!data.ok) {
    console.error(
      "Telegram API error:",
      JSON.stringify(data, null, 2)
    );

    return false;
  }

  console.log("Telegram notification sent.");

  return true;
}

function formatTelegramMessage(position) {
  return [
    `⭐ EXCEPTIONAL PhD MATCH — ${position.overall_score}/100`,
    "",
    `🎓 ${position.title}`,
    "",
    `🏛️ ${position.university}`,
    `🌍 ${position.country || "Country not specified"}`,
    `📅 Deadline: ${position.deadline || "Not specified"}`,
    "",
    `💰 Funding:`,
    position.funding || "Not specified",
    "",
    `🎯 Why it matches:`,
    position.why_it_matches ||
      "Strong match with your research profile.",
    "",
    `🧭 Strategic fit:`,
    position.strategic_fit ||
      "Strong alignment with your long-term research trajectory.",
    "",
    `🔗 Apply:`,
    position.url
  ].join("\n");
}

/* ============================================================
   TELEGRAM NOTIFICATION LOGIC
   ============================================================ */

async function notifyExceptionalMatches(results) {
  const notified = loadNotified();

  let changed = false;

  const exceptional = results.filter(
    result => Number(result.overall_score) >= 90
  );

  console.log(
    `Exceptional active positions: ${exceptional.length}`
  );

  for (const position of exceptional) {
    const url = normalizeURL(position.url);

    const previousNotification = notified[url];

    /*
      We notify when:

      1. This position has never been notified before
         OR
      2. Its current score is higher than the score we previously
         notified about.

      This means:

      New 93 → notify
      Existing 93 → don't notify
      Existing 85 → later becomes 93 → notify
    */

    const previousScore = Number(
      previousNotification?.score || 0
    );

    if (
      previousNotification &&
      previousScore >= Number(position.overall_score)
    ) {
      continue;
    }

    const message =
      formatTelegramMessage(position);

    const sent =
      await sendTelegramMessage(message);

    if (sent) {
      notified[url] = {
        score: Number(position.overall_score),
        notified_at: new Date().toISOString()
      };

      changed = true;
    }
  }

  if (changed) {
    saveNotified(notified);
  }
}

/* ============================================================
   MAIN
   ============================================================ */

async function main() {
  console.log("======================================");
  console.log("PH D RADAR");
  console.log("======================================");

  console.log("Loading existing results...");

  const existingResults = loadExisting();

  console.log(
    `Existing active positions: ${existingResults.length}`
  );

  console.log("Running new search...");

  const rawResults = await callGemini();

  const newSearchResults =
    cleanResults(rawResults);

  console.log(
    `Gemini returned ${newSearchResults.length} valid positions.`
  );

  /*
    Existing positions are retained only if their deadline
    is still valid because loadExisting() already removes
    expired positions.
  */

  const existingByURL = new Map();

  for (const result of existingResults) {
    existingByURL.set(
      normalizeURL(result.url),
      result
    );
  }

  /*
    If Gemini finds an existing position again, keep the newest
    information and score.
  */

  for (const result of newSearchResults) {
    const url = normalizeURL(result.url);

    const existing =
      existingByURL.get(url);

    if (!existing) {
      existingByURL.set(url, result);
      continue;
    }

    /*
      Keep the newer/better information.

      If the new search gives a higher score, use it.
      Otherwise retain the existing score.
    */

    if (
      Number(result.overall_score) >=
      Number(existing.overall_score)
    ) {
      existingByURL.set(url, {
        ...existing,
        ...result
      });
    }
  }

  const mergedResults =
    cleanResults(
      Array.from(existingByURL.values())
    );

  saveResults(mergedResults);

  console.log(
    `Saved ${mergedResults.length} active positions.`
  );

  /*
    Telegram notifications happen AFTER results are saved.

    Only 90+ results are considered.
  */

  await notifyExceptionalMatches(
    mergedResults
  );

  console.log("");
  console.log("Top matches:");

  for (
    const result of mergedResults.slice(0, 10)
  ) {
    console.log(
      `${result.overall_score}/100 | ` +
      `${result.title} | ` +
      `${result.university}`
    );
  }

  console.log("");
  console.log("Radar complete.");
}

main().catch(error => {
  console.error("");
  console.error("RADAR FAILED");
  console.error(error);
  process.exit(1);
});
