// PhD Radar — personalized global search
// Gemini 2.5 Flash + Google Search grounding
//
// Required GitHub Actions secret:
// GEMINI_API_KEY

const GEMINI_MODEL = "gemini-2.5-flash";
const RESULTS_FILE = "results.json";

// ============================================================
// YOUR PERSONALIZED CANDIDATE PROFILE
// ============================================================

const CANDIDATE_PROFILE = `
CANDIDATE PROFILE

The candidate is an Industrial Designer, Sustainability Educator,
University Lecturer, and Design Researcher.

Academic/professional identity, in approximate priority:
1. Sustainability researcher/educator
2. Industrial/product designer
3. University lecturer
4. Design researcher

Relevant background:
- Industrial design
- Product design
- Furniture design
- Service design
- Sustainability education
- Sustainable design
- Circular economy
- Sustainable consumption
- Product longevity
- Product attachment / psychological product lifetime
- Designer behaviour
- Design interventions for reduced consumption
- Research into consumption practices
- Design for social/ecological transformation

The candidate is comfortable moving far beyond traditional product design.

IMPORTANT RESEARCH TRAJECTORY:

PRODUCT DESIGN
→ SUSTAINABLE DESIGN
→ SUSTAINABLE CONSUMPTION
→ PRODUCT LONGEVITY
→ CONSUMPTION SYSTEMS
→ OWNERSHIP / ACCESS / SHARING
→ POST-GROWTH / DEGROWTH
→ SOCIAL + POLITICAL TRANSFORMATION

The candidate is particularly interested in how design can contribute
to changing systems rather than merely making existing products
incrementally more environmentally efficient.
`;

// ============================================================
// WHAT THE CANDIDATE WANTS TO RESEARCH
// ============================================================

const RESEARCH_PRIORITIES = `
VERY HIGH PRIORITY:

- Degrowth
- Post-growth
- Post-consumerism
- Sustainable consumption
- Consumption practices
- Consumer culture
- Political economy of consumption
- Economic growth and sustainability
- Alternative economic systems
- Alternative ownership
- Collective ownership
- Shared ownership
- Access instead of ownership
- Commons
- Commoning
- Sufficiency
- Social/ecological transformation
- Socio-technical transformation
- Transition design
- Transformative design
- Social design
- Design and society
- Design for systemic change
- Sustainability transitions
- Participatory/community-led transformation
- Social innovation
- Democratic design
- Design justice
- Governance and sustainability
- Public policy connected to consumption/sustainability
- Alternative futures
- Post-capitalist or post-growth futures
- Solidarity/alternative economies
- Community resilience
- Grassroots innovation

HIGH PRIORITY:

- Product longevity
- Repair
- Reuse
- Maintenance
- Product attachment
- Sustainable behaviour
- Behaviour change
- Social practices
- Practice theory
- Circular economy when connected to social/systemic change
- Circular consumption
- Product-service systems
- Sharing systems
- Collaborative consumption
- Service design for sustainability
- Systems design
- Transition management
- Ecological transition
- Climate justice
- Social sustainability
- Resource democracy
- Community-based sustainability

MEDIUM PRIORITY:

- Industrial design
- Product design
- Furniture design
- Sustainable manufacturing
- Sustainable production
- Life-cycle thinking
- LCA when used as a supporting method
- STS
- Sociology
- Political science
- Political economy
- Environmental humanities
- Innovation studies
- Urban/spatial design
`;

// ============================================================
// ACCEPTABLE ACADEMIC DISCIPLINES
// ============================================================

const DISCIPLINES = `
The PhD does NOT need to be located in an Industrial Design department.

Strongly suitable disciplines include:

- Industrial Design
- Product Design
- Design Research
- Design Studies
- Design for Sustainability
- Transition Design
- Social Design
- Design & Society
- Sustainability Studies
- Sustainability Transitions
- Service Design
- Systems Design
- Innovation Studies
- STS
- Environmental Humanities
- Political Economy
- Political Science
- Sociology
- Geography
- Social Sciences
- Environmental Social Science
- Public Policy
- Governance

A PhD outside design can be an excellent match if the research problem
and methods are strongly aligned with the candidate.

A highly relevant sociology, sustainability, governance or political
economy PhD should NOT be rejected merely because it does not contain
the word "design".

Conversely, a PhD called "Sustainable Design" should be rejected or
strongly penalized if its actual work is primarily materials science,
engineering, manufacturing optimization, chemistry, or technical LCA.
`;

// ============================================================
// METHODS
// ============================================================

const METHODS = `
METHOD PREFERENCES

The candidate is especially comfortable with:

- qualitative research
- interviews
- ethnography
- participant observation
- participatory design
- co-design
- design workshops
- speculative design
- design fiction
- prototyping
- service/system mapping
- behavioural research
- policy analysis
- discourse analysis
- theoretical research
- case studies
- action research
- living labs
- community-based research

The candidate is also open to quantitative methods.

Do NOT reject a project because it is theoretical.

Traditional academic PhDs and practice-based/design PhDs are BOTH acceptable.

The candidate is particularly interested in qualitative and participatory
approaches but has no strict methodological exclusion.
`;

// ============================================================
// HARD EXCLUSIONS
// ============================================================

const EXCLUSIONS = `
HARD EXCLUSIONS

Reject positions primarily focused on:

- Materials science
- Materials chemistry
- Polymer science
- Composite materials
- Nanomaterials
- Battery materials
- Chemical engineering
- Mechanical engineering
- Structural engineering
- Robotics
- Manufacturing engineering
- Manufacturing optimization
- Industrial process optimization
- Materials testing
- Materials development
- Pure computational modelling
- AI development
- Computer science
- Purely technical engineering
- Pure LCA research
- Pure environmental chemistry
- Laboratory-based material development

LCA is acceptable ONLY when it is a supporting component of a broader
social/design/sustainability research question.

Manufacturing is acceptable when secondary to broader questions about
sustainability, consumption, systems or social transformation.

A project involving sustainable materials is NOT automatically relevant.

Example of BAD MATCH:
"Development of recyclable polymer composites for circular furniture."

Example of GOOD MATCH:
"How product longevity and repair practices can support post-growth
consumption."

Example of GOOD MATCH:
"Alternative ownership models for sustainable consumption."

Example of GOOD MATCH:
"Community-led design for socio-ecological transformation."
`;

// ============================================================
// GEOGRAPHY
// ============================================================

const GEOGRAPHY = `
GEOGRAPHIC STRATEGY

Search globally.

The following countries receive a geographic PRIORITY BONUS, but are
NOT the only countries searched.

TIER 1:
Netherlands
Belgium
Sweden
Denmark
Norway
Finland
United Kingdom
Germany
Italy
Switzerland
Austria

TIER 2:
France
Ireland
Spain
Portugal
Luxembourg
Iceland

TIER 3:
All other countries worldwide may be considered if the academic match
is strong.

Potentially relevant countries include, but are not limited to:
Canada, Australia, New Zealand, Japan, South Korea, Singapore, Taiwan,
Hong Kong, Estonia, Latvia, Lithuania, Poland, Czechia, Slovenia,
Croatia and other European countries.

CRITICAL EXCLUSION:

United States / USA / US

Do NOT return PhD positions located in the United States.

Do not exclude a country merely because it is outside Europe.
Academic/research fit is more important than geography.

Geography should affect the score, but should NEVER compensate for a
poor research match.
`;

// ============================================================
// FUNDING
// ============================================================

const FUNDING_RULES = `
FUNDING REQUIREMENT

Only return genuinely funded PhD positions.

Preferred:
- salaried PhD researcher positions
- fully funded PhD positions
- funded doctoral researcher contracts
- positions where tuition and living costs are clearly covered

Reject:
- self-funded PhDs
- tuition-only scholarships
- positions where funding is uncertain
- generic PhD programmes without a specific funded position
- opportunities requiring the candidate to find their own funding

If funding is unclear, do not assume it is funded.
`;

// ============================================================
// POSITION VALIDITY
// ============================================================

const VALIDITY_RULES = `
POSITION VALIDITY

Only return REAL, CURRENTLY OPEN PhD/doctoral positions.

Every result MUST have:

1. identifiable university/research institution
2. identifiable PhD/doctoral position
3. official application/job page or highly reliable academic source
4. exact application deadline
5. deadline still in the future
6. clear funding information

Do NOT return:

- expired positions
- archived positions
- closed positions
- generic PhD programmes
- speculative future projects
- "you could contact this professor" suggestions
- general department pages
- positions with no identifiable application route
- positions whose deadline cannot be verified

Prefer official university job pages.

Source priority:

1. Official university job/vacancy page
2. Official research institute/project page
3. EURAXESS
4. Academic Positions
5. FindAPhD
6. Other reputable academic sources

IMPORTANT:
Verify the deadline from the actual source.
Do not infer a deadline from search snippets.
`;

// ============================================================
// SEARCH STRATEGY
// ============================================================

const SEARCH_STRATEGY = `
SEARCH STRATEGY

Do NOT perform only a simple "sustainable design PhD" search.

Search across multiple conceptual clusters.

CLUSTER 1 — DESIGN + SUSTAINABILITY
design sustainability PhD
design for sustainability doctoral position
sustainable design PhD
design ecological transition PhD

CLUSTER 2 — POST-GROWTH
degrowth PhD
post-growth PhD
post-growth society doctoral position
design degrowth PhD
degrowth consumption PhD
post-growth consumption PhD

CLUSTER 3 — CONSUMPTION
sustainable consumption PhD
consumption practices doctoral position
consumer culture sustainability PhD
reducing consumption PhD
sufficiency consumption PhD

CLUSTER 4 — OWNERSHIP
alternative ownership PhD
shared ownership sustainability PhD
collective ownership doctoral position
access instead of ownership PhD
commons commoning sustainability PhD
sharing economy critical PhD

CLUSTER 5 — POLITICAL ECONOMY
political economy consumption PhD
political economy sustainability doctoral position
capitalism consumption sustainability PhD
economic growth sustainability PhD
alternative economies PhD
post-capitalist futures PhD

CLUSTER 6 — SOCIAL TRANSFORMATION
social ecological transformation PhD
socio-ecological transformation doctoral position
transformative design PhD
social innovation sustainability PhD
systemic change design PhD

CLUSTER 7 — TRANSITION DESIGN
transition design PhD
design transitions doctoral position
sustainability transitions design PhD
transition studies design PhD

CLUSTER 8 — SOCIAL DESIGN
social design PhD
design society doctoral position
design justice sustainability PhD
community design sustainability PhD
participatory design ecological transition

CLUSTER 9 — LONGEVITY / REPAIR
product longevity PhD
repair reuse PhD design
product attachment sustainability PhD
maintenance repair consumption PhD
design for longevity doctoral position

CLUSTER 10 — SERVICE / SYSTEMS
service design sustainability PhD
systems design sustainability doctoral position
product service systems sustainability PhD
sharing systems design PhD
alternative consumption systems PhD

CLUSTER 11 — POLICY / GOVERNANCE
sustainability governance design PhD
public policy sustainable consumption PhD
design policy sustainability doctoral position
governing consumption transitions PhD
policy post-growth PhD

CLUSTER 12 — SOCIAL PRACTICES
social practices consumption PhD
practice theory sustainability PhD
everyday consumption sustainability doctoral position
behaviour change sustainable consumption PhD

CLUSTER 13 — RADICAL / ALTERNATIVE FUTURES
alternative futures sustainability PhD
post-consumer society PhD
post-capitalist design PhD
alternative economic systems sustainability PhD
commons sustainability doctoral position
democratic economy sustainability PhD

IMPORTANT:
Also search for conceptually related terminology that is NOT explicitly
listed above.

The goal is semantic discovery, not keyword matching.
`;

// ============================================================
// SCORING
// ============================================================

const SCORING = `
SCORING

Score each position out of 100.

1. Research-topic fit — 25 points
How closely does the actual research question match the candidate's
interests?

2. Post-growth / political-social transformation — 20 points
Does it address degrowth, post-growth, political economy, power,
inequality, alternative systems, social transformation, etc.?

3. Sustainability — 15 points
How central is genuine environmental/social sustainability?

4. Design compatibility — 15 points
How meaningfully can the candidate's design background contribute?

5. Consumption / ownership / systems — 10 points
Does it concern consumption, ownership, access, sharing, repair,
longevity, practices, or alternative systems?

6. Methodological compatibility — 5 points
Does the research approach suit the candidate?

7. Candidate background — 5 points
Does the candidate's existing education, teaching and research provide
a credible foundation?

8. Funding — 5 points
Fully funded/salaried = full points.

GEOGRAPHIC PRIORITY BONUS:
Do NOT add geography as an independent score that can distort academic
fit. Instead use geography as a small strategic modifier inside the
overall assessment.

INTERPRETATION:

90–100 = Exceptional match
80–89 = Very strong match
70–79 = Strong match
60–69 = Interesting strategic wildcard

Only return positions scoring 60 or higher.

IMPORTANT:
A position with weak traditional "design fit" can still score very highly
if it strongly matches post-growth, sustainable consumption, alternative
systems, social transformation and the candidate's broader trajectory.

Do not reward a position merely because it contains the word
"sustainability".

Do not reward generic "circular economy" if the work is primarily
engineering or materials science.
`;

// ============================================================
// OUTPUT FORMAT
// ============================================================

const OUTPUT_RULES = `
OUTPUT

Return ONLY a JSON array.

No markdown.
No explanation before or after the JSON.

Each object must contain exactly these fields:

{
  "title": "",
  "university": "",
  "country": "",
  "city": "",
  "department": "",
  "deadline": "YYYY-MM-DD",
  "funding": "",
  "supervisor": "",
  "url": "",
  "design_score": 0,
  "sustainability_score": 0,
  "political_score": 0,
  "consumption_score": 0,
  "methods_score": 0,
  "background_score": 0,
  "research_group_score": 0,
  "funding_score": 0,
  "overall_score": 0,
  "classification": "",
  "research_area": "",
  "why_it_matches": "",
  "why_it_is_not_perfect": "",
  "strategic_fit": "",
  "evidence": ""
}

IMPORTANT:
- overall_score must be your actual considered score.
- deadline MUST be YYYY-MM-DD.
- url MUST point to the actual position/application page.
- evidence should briefly explain what source evidence confirms the
  position, deadline and funding.
- Do not invent supervisors.
- If supervisor is not identified, use "".
- Do not invent funding.
- Do not include positions that cannot be verified.
`;

// ============================================================
// BUILD PROMPT
// ============================================================

const SYSTEM_PROMPT = `
You are an expert European and international academic recruitment
researcher specializing in design, sustainability, social sciences,
transition studies and doctoral positions.

Your task is to find CURRENTLY OPEN, FULLY FUNDED PhD positions that
are genuinely relevant to the candidate described below.

${CANDIDATE_PROFILE}

${RESEARCH_PRIORITIES}

${DISCIPLINES}

${METHODS}

${EXCLUSIONS}

${GEOGRAPHY}

${FUNDING_RULES}

${VALIDITY_RULES}

${SEARCH_STRATEGY}

${SCORING}

${OUTPUT_RULES}

Think broadly and semantically.

The candidate is willing to undertake a highly theoretical PhD.
The candidate is willing to move completely beyond furniture and
traditional product design.
The candidate is willing to study consumption, economic systems,
governance, social transformation and post-growth futures.
However, design/sustainability must remain meaningfully connected to
the candidate's profile.

Do not artificially restrict the search to positions containing
"industrial design".

At the same time, do not turn this into a generic sustainability,
economics or sociology search.

The ideal result sits somewhere in the intellectual space between:

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
post-growth / alternative futures.

Search broadly, verify carefully, and rank ruthlessly.
`;

// ============================================================
// HELPERS
// ============================================================

function normalizeURL(url) {
  if (!url || typeof url !== "string") return "";

  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url.trim().replace(/\/$/, "");
  }
}

function parseDeadline(value) {
  if (typeof value !== "string") return null;

  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const date = new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3])
    )
  );

  if (Number.isNaN(date.getTime())) return null;

  return date;
}

function isFutureDeadline(deadline) {
  const date = parseDeadline(deadline);
  if (!date) return false;

  const now = new Date();

  const todayUTC = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );

  return date.getTime() >= todayUTC;
}

function cleanResults(results) {
  if (!Array.isArray(results)) return [];

  const seen = new Set();
  const cleaned = [];

  for (const item of results) {
    if (!item || typeof item !== "object") continue;

    const title = String(item.title || "").trim();
    const university = String(item.university || "").trim();
    const url = normalizeURL(item.url);
    const deadline = String(item.deadline || "").trim();

    if (!title || !university || !url) continue;

    // Must have a real exact future deadline.
    if (!isFutureDeadline(deadline)) continue;

    // Must have a meaningful score.
    const score = Number(item.overall_score);
    if (!Number.isFinite(score) || score < 60) continue;

    // Deduplicate by URL.
    if (seen.has(url)) continue;
    seen.add(url);

    cleaned.push({
      title,
      university,
      country: String(item.country || "").trim(),
      city: String(item.city || "").trim(),
      department: String(item.department || "").trim(),
      deadline,
      funding: String(item.funding || "").trim(),
      supervisor: String(item.supervisor || "").trim(),
      url,

      design_score: Number(item.design_score) || 0,
      sustainability_score: Number(item.sustainability_score) || 0,
      political_score: Number(item.political_score) || 0,
      consumption_score: Number(item.consumption_score) || 0,
      methods_score: Number(item.methods_score) || 0,
      background_score: Number(item.background_score) || 0,
      research_group_score: Number(item.research_group_score) || 0,
      funding_score: Number(item.funding_score) || 0,
      overall_score: score,

      classification: String(item.classification || "").trim(),
      research_area: String(item.research_area || "").trim(),
      why_it_matches: String(item.why_it_matches || "").trim(),
      why_it_is_not_perfect: String(item.why_it_is_not_perfect || "").trim(),
      strategic_fit: String(item.strategic_fit || "").trim(),
      evidence: String(item.evidence || "").trim()
    });
  }

  cleaned.sort((a, b) => {
    if (b.overall_score !== a.overall_score) {
      return b.overall_score - a.overall_score;
    }

    return a.deadline.localeCompare(b.deadline);
  });

  return cleaned.slice(0, 100);
}

// ============================================================
// ROBUST JSON EXTRACTION
// ============================================================

function extractJSON(text) {
  if (!text || typeof text !== "string") {
    throw new Error("Gemini returned empty text.");
  }

  // Remove markdown fences if Gemini adds them.
  let cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  // First attempt: entire response.
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
  } catch {}

  // Find the first JSON array.
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");

  if (start !== -1 && end !== -1 && end > start) {
    const candidate = cleaned.slice(start, end + 1);

    try {
      const parsed = JSON.parse(candidate);

      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch (error) {
      console.error("JSON candidate could not be parsed.");
      console.error(error.message);
    }
  }

  throw new Error(
    "Could not extract a valid JSON array from Gemini response."
  );
}

// ============================================================
// GEMINI
// ============================================================

async function callGemini(apiKey) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${GEMINI_MODEL}:generateContent`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `
Find the best currently OPEN, fully funded PhD positions for this
candidate.

Today is ${new Date().toISOString().slice(0, 10)}.

Search broadly across the world according to the geographic strategy.
The United States MUST be excluded.

Use Google Search extensively.

Search multiple conceptual clusters rather than relying on one query.

Verify each promising position using the actual source page whenever
possible.

Pay particular attention to:
- exact future deadline
- actual funding
- actual PhD vacancy
- research topic
- department/research group
- candidate fit

Return only the final JSON array.

${SYSTEM_PROMPT}
`
          }
        ]
      }
    ],
    tools: [
      {
        googleSearch: {}
      }
    ]
  };

  console.log("Searching with Gemini + Google Search...");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify(body)
  });

  const raw = await response.text();

  if (!response.ok) {
    throw new Error(
      `Gemini API error ${response.status}: ${raw}`
    );
  }

  const data = JSON.parse(raw);

  const candidates =
    data?.candidates
      ?.map(candidate =>
        candidate?.content?.parts
          ?.map(part => part?.text || "")
          .join("")
      )
      .filter(Boolean) || [];

  const text = candidates.join("\n");

  if (!text) {
    console.error("Gemini response:");
    console.error(JSON.stringify(data, null, 2));

    throw new Error("Gemini returned no usable text.");
  }

  console.log("Gemini response received.");

  return extractJSON(text);
}

// ============================================================
// LOAD EXISTING RESULTS
// ============================================================

async function loadExisting() {
  try {
    const file = Bun.file(RESULTS_FILE);

    if (!(await file.exists())) {
      return [];
    }

    const text = await file.text();

    if (!text.trim()) {
      return [];
    }

    const parsed = JSON.parse(text);

    return cleanResults(parsed);
  } catch (error) {
    console.warn("Could not load existing results:", error.message);
    return [];
  }
}

// ============================================================
// SAVE
// ============================================================

async function saveResults(results) {
  await Bun.write(
    RESULTS_FILE,
    JSON.stringify(results, null, 2) + "\n"
  );
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is missing. Add it to GitHub Actions Secrets."
    );
  }

  console.log("==========================================");
  console.log("PH.D. RADAR");
  console.log("==========================================");

  const existing = await loadExisting();

  console.log(`Existing valid positions: ${existing.length}`);

  // Remove expired positions immediately.
  const existingValid = cleanResults(existing);

  console.log(
    `After removing expired/invalid positions: ${existingValid.length}`
  );

  const discovered = await callGemini(apiKey);

  console.log(
    `Gemini discovered ${discovered.length} candidate positions.`
  );

  const newResults = cleanResults(discovered);

  const existingURLs = new Set(
    existingValid.map(item => normalizeURL(item.url))
  );

  let newCount = 0;

  for (const result of newResults) {
    const url = normalizeURL(result.url);

    if (!existingURLs.has(url)) {
      existingValid.push(result);
      existingURLs.add(url);
      newCount++;
    }
  }

  const finalResults = cleanResults(existingValid);

  await saveResults(finalResults);

  console.log("------------------------------------------");
  console.log(`New positions added: ${newCount}`);
  console.log(`Total active positions: ${finalResults.length}`);
  console.log("------------------------------------------");

  if (newCount > 0) {
    console.log("\nNEW POSITIONS:");

    for (const item of newResults) {
      if (existingURLs.has(normalizeURL(item.url))) {
        console.log(
          `- ${item.overall_score}/100 | ${item.title} | ${item.university}`
        );
      }
    }
  }

  console.log("\nResults saved to results.json.");
}

main().catch(error => {
  console.error("\nPH.D. RADAR FAILED");
  console.error(error);
  process.exit(1);
});
