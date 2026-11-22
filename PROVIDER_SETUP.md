# Provider configuration

PhD Radar uses two independent ordered fallback chains. Provider names, endpoints, formats and models are read from GitHub Actions Variables; API keys are read only from GitHub Actions Secrets. No provider model or API endpoint is hard-coded in `search.mjs`.

## 1. Search engines (one query at a time)

The order is strict: **Search 1 → Search 2 → Search 3**.

- Search 1 and Search 2 are intended for two independent Tavily API keys.
- Search 3 is intended for Gemini with Google Search grounding.
- A provider is skipped for the rest of the run after an invalid key, exhausted quota, repeated rate limit, network failure or server failure. The next configured search provider is then tried.
- A successful response with zero results is not treated as a provider failure.

### Search API keys — GitHub Secrets

Create these three secrets:

| Secret | Suggested service |
|---|---|
| `SEARCH_1_API_KEY` | Tavily account/key 1 |
| `SEARCH_2_API_KEY` | Tavily account/key 2 |
| `SEARCH_3_API_KEY` | Google AI Studio / Gemini key for search grounding |

### Search settings — GitHub Variables

| Variable | Suggested value |
|---|---|
| `SEARCH_1_NAME` | `Tavily 1` |
| `SEARCH_1_BASE_URL` | `https://api.tavily.com` |
| `SEARCH_1_FORMAT` | `tavily` |
| `SEARCH_2_NAME` | `Tavily 2` |
| `SEARCH_2_BASE_URL` | `https://api.tavily.com` |
| `SEARCH_2_FORMAT` | `tavily` |
| `SEARCH_3_NAME` | `Gemini Search` |
| `SEARCH_3_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta` |
| `SEARCH_3_MODEL` | `gemini-2.5-flash` |
| `SEARCH_3_FORMAT` | `gemini` |

`SEARCH_1_MODEL` and `SEARCH_2_MODEL` are not needed for Tavily. Search 3 requires a model because it uses Gemini's Google Search grounding tool.

## 2. AI reviewers (one extraction batch at a time)

The order is strict: **Reviewer 1 → Reviewer 2 → Reviewer 3**. If a reviewer fails after its configured retries or reaches quota, the same batch is sent to the next configured reviewer. A valid empty JSON array is a valid answer and does not trigger fallback.

### Reviewer API keys — GitHub Secrets

Create these three secrets:

| Secret | Suggested service |
|---|---|
| `REVIEW_1_API_KEY` | Groq |
| `REVIEW_2_API_KEY` | OpenRouter (or another OpenAI-compatible provider) |
| `REVIEW_3_API_KEY` | Google AI Studio / Gemini |

### Reviewer settings — GitHub Variables

| Variable | Suggested value |
|---|---|
| `REVIEW_1_NAME` | `Groq` |
| `REVIEW_1_BASE_URL` | `https://api.groq.com/openai/v1` |
| `REVIEW_1_MODEL` | `openai/gpt-oss-120b` |
| `REVIEW_1_FORMAT` | `openai` |
| `REVIEW_2_NAME` | `OpenRouter` |
| `REVIEW_2_BASE_URL` | `https://openrouter.ai/api/v1` |
| `REVIEW_2_MODEL` | `nvidia/nemotron-3-ultra-550b-a55b:free` |
| `REVIEW_2_FORMAT` | `openai` |
| `REVIEW_3_NAME` | `Gemini` |
| `REVIEW_3_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta` |
| `REVIEW_3_MODEL` | `gemini-2.5-flash` |
| `REVIEW_3_FORMAT` | `gemini` |

For an OpenAI-compatible provider, use its API base URL, model ID and `openai` format. For Gemini, use the Google Generative Language base URL, a Gemini model ID and `gemini` format.

## 3. Important setup notes

- `SEARCH_3_API_KEY` and `REVIEW_3_API_KEY` are separate secrets, even if both belong to the same Google account. This keeps the six credentials independent as requested.
- Search 2 and Search 3, and Review 2 and Review 3, are optional in the code; the primary pipeline requires Search 1 and Reviewer 1. Configure all six secrets to enable the complete fallback chain.
- Search 3 uses Gemini Google Search grounding. Google's current pricing page lists a free allowance for Gemini 2.5 Flash grounding, subject to daily limits; check the current quota and billing status of the Google project before enabling it.
- GitHub does not provide folders for Variables or Secrets. The consistent `SEARCH_1_`, `SEARCH_2_`, `SEARCH_3_`, `REVIEW_1_`, `REVIEW_2_`, and `REVIEW_3_` prefixes keep the entries grouped alphabetically.
- Existing non-provider tuning variables (page budgets, query counts, delays, score thresholds and Telegram settings) remain unchanged.
- The old single-provider settings (`SEARCH_API_KEY`, `SEARCH_NAME`, `SEARCH_BASE_URL`, `SEARCH_FORMAT`, `REVIEW_API_KEY`, `REVIEW_NAME`, `REVIEW_BASE_URL`, `REVIEW_MODEL`, `REVIEW_FORMAT`), plus `SEARCH_REVIEW_*` and `OPENROUTER_*`, are no longer read by this version. General tuning variables such as `SEARCH_DEPTH`, `SEARCH_TIME_RANGE` and `SEARCH_RESULTS_PER_QUERY` are still used. After adding the new settings, remove the obsolete provider entries from GitHub Settings → Secrets and variables → Actions. Keep `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
