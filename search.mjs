const GEMINI_MODEL = "gemini-2.5-flash";
const RESULTS_FILE = "results.json";

const SYSTEM_PROMPT = `
You are an expert evaluator of PhD opportunities for a specific academic candidate.

CANDIDATE PROFILE
-----------------

The candidate is:

- Industrial Designer
- University Lecturer
- Design Researcher

Background:

- Product design
- Furniture design
- Service design
- Sustainable design education
- Sustainable consumption
- Product longevity
- Product attachment
- Designer behaviour
- Circular economy
- Design for sustainability

The candidate's research trajectory is:

PRODUCT DESIGN
→ SUSTAINABLE DESIGN
→ SUSTAINABLE CONSUMPTION
→ PRODUCT LONGEVITY
→ CONSUMPTION SYSTEMS
→ OWNERSHIP / ACCESS / ALTERNATIVE SYSTEMS
→ SOCIAL AND POLITICAL TRANSFORMATION


VERY HIGH PRIORITY
------------------

Strongly prioritize:

- sustainable consumption
- consumption practices
- consumer culture
- product longevity
- product attachment
- repair
- reuse
- maintenance
- sufficiency
- degrowth
- post-growth
- post-consumerism
- alternative consumption
- alternative ownership
- collective ownership
- shared ownership
- access instead of ownership
- commons
- commoning
- political economy of consumption
- social transformation
- ecological transformation
- design justice
- transition design
- transformative design
- critical design
- participatory design
- community-led design
- co-design
- social innovation
- alternative economies
- alternative futures
- sustainability transitions
- governance
- public policy
- design policy
- public-sector design
- social practices
- practice theory
- product-service systems
- sharing systems
- collaborative consumption
- circular economy connected to social/systemic change


HIGH PRIORITY
-------------

Also consider:

- circular economy
- sustainable product-service systems
- systems design
- service design for sustainability
- design for social innovation
- sustainable behaviour
- behavioural design
- environmental humanities
- socio-technical transitions
- grassroots innovation
- community resilience
- resource democracy
- democratic design
- social sustainability
- climate justice


POLITICAL / SOCIAL DIMENSION
----------------------------

The candidate is particularly interested in the relationship between:

design
sustainability
consumption
society
politics
economics

Give extra weight to:

- power
- inequality
- institutions
- governance
- policy
- political economy
- social justice
- ecological justice
- alternative economic systems
- alternative social systems
- collective action
- democratic participation
- transformation of consumption systems

A position does NOT need to explicitly use the word "politics".

Infer political and systemic relevance from the actual research topic.


STRATEGIC FIT
-------------

The ideal PhD represents a logical continuation of:

sustainable product design
→ sustainable consumption
→ consumption systems
→ ownership/access
→ social/political transformation

Prefer positions that move the candidate toward systemic social transformation.

Do not overvalue positions that simply apply sustainability to technical
product development.


DO NOT TREAT THE CANDIDATE AS
-----------------------------

Do NOT interpret the candidate primarily as:

- mechanical engineer
- materials scientist
- chemical engineer
- manufacturing engineer
- robotics researcher
- computer scientist
- laboratory scientist
- pure LCA researcher

Strongly penalize:

- materials chemistry
- polymers
- batteries
- nanotechnology
- material testing
- manufacturing optimization
- structural engineering
- mechanical optimization
- industrial process optimization
- purely technical circularity
- pure Life Cycle Assessment
- laboratory experiments


SEARCH CLUSTERS
---------------

Search multiple conceptual clusters.

1. design + sustainability + PhD
2. sustainable consumption + design + PhD
3. product longevity + repair + reuse + design + PhD
4. degrowth + design + PhD
5. sufficiency + design + consumption + PhD
6. alternative ownership + design + PhD
7. commons + design + consumption + PhD
8. political economy + consumption + design + PhD
9. social practices + consumption + design + PhD
10. transition design + sustainability + PhD
11. social innovation + sustainability + design + PhD
12. participatory design + ecological transition + PhD
13. design justice + sustainability + PhD
14. governance + design + sustainability + PhD


GEOGRAPHY
---------

Prioritize:

1. Netherlands
2. Belgium
3. Sweden
4. Denmark
5. Norway
6. Finland
7. United Kingdom
8. Germany
9. Italy
10. Switzerland
11. Austria

Excellent positions outside these countries may still be included.


SOURCE QUALITY
--------------

Prefer:

1. Official university job page
2. Official university research group
3. EURAXESS
4. Academic Positions
5. FindAPhD
6. Other reputable academic sources

Whenever possible verify the position on the university's official website.


CURRENT POSITION REQUIREMENT
----------------------------

Only return REAL and CURRENT PhD/doctoral positions.

The position must have:

- identifiable university/research institution
- actual PhD/doctoral position
- identifiable research topic
- application page
- upcoming application deadline

DO NOT return:

- expired positions
- archived positions
- passed deadlines
- generic PhD programmes without an open position
- speculative future positions
- positions without a verifiable deadline

Deadline MUST be:

YYYY-MM-DD

Only return deadlines after today's date.


SCORING
-------

Design fit:                  0-20
Sustainability:              0-15
Political/social dimension:  0-15
Consumption/ownership:       0-15
Methods:                     0-10
Candidate background:        0-10
Research group:              0-10
Funding:                     0-5

Total: 100


SCORING EXAMPLES
----------------

Sustainable polymer composite materials
→ very low

Sustainable manufacturing optimization
→ low

Pure LCA
→ low

Technical circular manufacturing
→ low/medium

Generic circular economy engineering
→ medium at best

Sustainable consumption + design
→ high

Product longevity + design
→ high

Repair/reuse + consumption
→ high

Alternative ownership + design
→ very high

Sufficiency + consumption transformation
→ very high

Degrowth + design
→ very high

Participatory ecological transition
→ very high

Consumption systems + social transformation
→ very high

Design + political economy + sustainability
→ very high


OUTPUT
------

Return ONLY a raw JSON array.

NO markdown.
NO explanations outside JSON.
NO code fences.

Use exactly these keys:

[
  {
    "title":"",
    "university":"",
    "country":"",
    "city":"",
    "department":"",
    "deadline":"",
    "funding":"",
    "supervisor":"",
    "url":"",
    "design_score":0,
    "sustainability_score":0,
    "political_score":0,
    "consumption_score":0,
    "methods_score":0,
    "background_score":0,
    "research_group_score":0,
    "funding_score":0,
    "overall_score":0,
    "classification":"",
    "research_area":"",
    "why_it_matches":"",
    "why_it_is_not_perfect":"",
    "strategic_fit":"",
    "evidence":""
  }
]

Only include positions with overall_score > 60.
`;

function normalizeURL(url) {
  try {
    const u = new URL(url);

    u.search = "";
    u.hash = "";

    return u.toString().replace(/\/$/, "");
  } catch {
    return String(url || "").trim();
  }
}


function parseDeadline(value) {
  if (!value) return null;

  const match = String(value).match(/\d{4}-\d{2}-\d{2}/);

  if (!match) return null;

  const date = new Date(`${match[0]}T23:59:59Z`);

  return Number.isNaN(date.getTime())
    ? null
    : date;
}


function isFutureDeadline(deadline) {

  const date = parseDeadline(deadline);

  if (!date) return false;

  const today = new Date();

  const todayUTC = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate()
  );

  return date.getTime() >= todayUTC;
}


function cleanResults(results) {

  const seen = new Set();
  const cleaned = [];

  for (const item of results) {

    if (!item || typeof item !== "object") {
      continue;
    }

    const url = normalizeURL(item.url);

    if (!item.title) continue;
    if (!item.university) continue;
    if (!url) continue;

    if (!isFutureDeadline(item.deadline)) {
      continue;
    }

    const score = Number(item.overall_score);

    if (!Number.isFinite(score)) {
      continue;
    }

    if (score <= 60) {
      continue;
    }

    if (seen.has(url)) {
      continue;
    }

    seen.add(url);

    cleaned.push({
      ...item,
      url,
      overall_score: score
    });
  }

  return cleaned
    .sort(
      (a, b) =>
        b.overall_score - a.overall_score
    )
    .slice(0, 100);
}


function extractJSON(text) {

  const match =
    text.match(/\[\s*\{[\s\S]*\}\s*\]/);

  if (!match) {

    throw new Error(
      "Gemini did not return the expected JSON.\n\n" +
      text
    );
  }

  return JSON.parse(match[0]);
}


async function callGemini(apiKey) {

  const today =
    new Date()
      .toISOString()
      .slice(0, 10);

  const prompt =
    SYSTEM_PROMPT +
    `\n\nTODAY'S DATE: ${today}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",

      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json"
      },

      body: JSON.stringify({

        contents: [
          {
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
        ]

      })
    }
  );


  if (!response.ok) {

    const errorText =
      await response.text();

    throw new Error(
      `Gemini API error ${response.status}: ${errorText}`
    );
  }


  const data =
    await response.json();


  const text =
    data.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("") || "";


  if (!text) {

    throw new Error(
      "Gemini returned no text."
    );
  }


  return extractJSON(text);
}


async function loadExisting() {

  try {

    const text =
      await Bun.file(RESULTS_FILE).text();

    if (!text.trim()) {
      return [];
    }

    return JSON.parse(text);

  } catch {

    return [];
  }
}


async function saveResults(results) {

  await Bun.write(
    RESULTS_FILE,
    JSON.stringify(results, null, 2) + "\n"
  );
}


async function main() {

  if (!process.env.GEMINI_API_KEY) {

    throw new Error(
      "GEMINI_API_KEY is missing."
    );
  }


  console.log("");
  console.log("=================================");
  console.log("         PHD RADAR");
  console.log("=================================");
  console.log("");


  console.log(
    "Removing expired positions..."
  );


  const oldResults =
    cleanResults(
      await loadExisting()
    );


  console.log(
    `Existing active results: ${oldResults.length}`
  );


  console.log("");
  console.log(
    "Gemini is searching Google..."
  );
  console.log("");


  const discovered =
    await callGemini(
      process.env.GEMINI_API_KEY
    );


  console.log(
    `Gemini returned ${discovered.length} candidates.`
  );


  const valid =
    cleanResults(discovered);


  const existingURLs =
    new Set(
      oldResults.map(
        item => normalizeURL(item.url)
      )
    );


  const newItems =
    valid.filter(
      item =>
        !existingURLs.has(
          normalizeURL(item.url)
        )
    );


  const merged =
    cleanResults([
      ...newItems,
      ...oldResults
    ]);


  await saveResults(merged);


  console.log("");
  console.log("=================================");
  console.log(
    `Active positions: ${merged.length}`
  );
  console.log(
    `New positions: ${newItems.length}`
  );
  console.log("=================================");
  console.log("");


  if (newItems.length) {

    console.log("NEW POSITIONS:");

    for (const item of newItems) {

      console.log(
        `${item.overall_score}/100 | ` +
        `${item.title} | ` +
        `${item.university} | ` +
        `${item.deadline}`
      );
    }
  }

}


main().catch(error => {

  console.error("");
  console.error("SEARCH FAILED");
  console.error(error);

  process.exit(1);

});
