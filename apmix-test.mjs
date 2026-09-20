const API_KEY = process.env.APMIX_API_KEY;
const MODEL = process.env.APMIX_MODEL || "gpt-5.6-luna-free";
const ENDPOINT = "https://api.apmix.ai/v1/chat/completions";

if (!API_KEY) {
  console.error("APMIX_API_KEY is not configured.");
  process.exit(1);
}

console.log("======================================");
console.log("APMIX STANDALONE TEST");
console.log("======================================");
console.log("Model:", MODEL);
console.log("API key configured:", Boolean(API_KEY));

const response = await fetch(ENDPOINT, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${API_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    model: MODEL,
    messages: [
      {
        role: "user",
        content: "Reply with exactly: OK"
      }
    ],
    temperature: 0,
    max_tokens: 10
  })
});

const requestId =
  response.headers.get("x-apmix-request-id") ||
  response.headers.get("x-request-id") ||
  response.headers.get("request-id") ||
  "not provided";

const raw = await response.text();

console.log("HTTP status:", response.status);
console.log("APMix request ID:", requestId);
console.log("Raw response:");
console.log(raw);

if (!response.ok) {
  console.error("APMix returned an HTTP error.");
  process.exit(1);
}

try {
  const data = JSON.parse(raw);
  const choice = data?.choices?.[0];

  console.log("Parsed message content:", JSON.stringify(choice?.message?.content ?? null));
  console.log("Finish reason:", choice?.finish_reason ?? "unknown");
  console.log("Usage:", JSON.stringify(data?.usage ?? null));

  if (choice?.message?.content === "OK") {
    console.log("\nRESULT: APMix model is responding normally.");
  } else if (choice?.message?.content === "") {
    console.log("\nRESULT: HTTP succeeds, but the model returned EMPTY content.");
    console.log("This points to an APMix/model-side response issue, not authentication or model availability.");
  } else {
    console.log("\nRESULT: Model responded, but not with the expected exact output.");
  }
} catch (error) {
  console.error("Could not parse APMix JSON:", error);
  process.exit(1);
}
