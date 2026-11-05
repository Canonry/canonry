# cloro

[cloro](https://cloro.dev/?utm_source=canonry&utm_medium=byok) (`POST https://api.cloro.dev/v1/monitor/<surface>`) returns the answer that a logged-out visitor sees on ChatGPT, Gemini or Google AI Mode, with its inline citations and sources. Canonry runs it through the shared [search answer services](../answer-services.md) layer, so everything on that page applies here: it is never selected implicitly, only complete answers are measured, and unknown counts and costs stay unknown.

## Setup

Get a key at [dashboard.cloro.dev/api-keys](https://dashboard.cloro.dev/api-keys?utm_source=canonry&utm_medium=byok). The Free plan includes 500 credits a month. Save the key once:

```bash
cnry settings provider cloro --api-key <key>
```

`CLORO_API_KEY` is read by `cnry bootstrap`. Saving a key never sends a request, so a saved key shows as "saved, not verified" until the first real query.

Then name a profile wherever you choose engines. The bare `cloro` connection is not an engine.

```bash
cnry research run my-site --provider cloro:chatgpt --query "best roofer in springfield"
cnry project update my-site --provider gemini --provider cloro:aimode
```

## Profiles

Each profile calls one cloro endpoint. Results are stored under the route, so two profiles never share history. Credits are cloro's prices for a sync request: the base cost plus 2 credits for every `/v1/monitor/*` call. cloro charges only for a `200` response.

| Route | Endpoint | Credits per query | Workflows |
|---|---|---|---|
| `cloro:chatgpt` | `/v1/monitor/chatgpt` | 7 (5 + 2) | research, snapshot, visibility sweep |
| `cloro:gemini` | `/v1/monitor/gemini` | 6 (4 + 2) | research, snapshot, visibility sweep |
| `cloro:aimode` | `/v1/monitor/aimode` | 6 (4 + 2) | research, snapshot, visibility sweep |

cloro asks for a client timeout of at least 5 minutes: it starts no new attempt after 5 minutes, but an attempt that is running can still finish and be charged. Each request waits up to 6 minutes and is not sent again after its deadline.

## What is sent

```json
{ "prompt": "<the tracked query, unchanged>", "country": "US" }
```

The key goes in `Authorization: Bearer`. cloro requires `country` (an uppercase ISO 3166-1 alpha-2 code). With a location, Canonry sends its country in upper case; cloro takes a country and nothing finer here, so a city location is stored as `partial`. Without a location, Canonry sends `US` and records it as the service default. cloro answers `400` for a country that a surface does not serve. No `include`, `state` (+2 credits), `legacy`, `disableWebSearch` or multi-turn prompt is sent. A query longer than 10,000 characters is refused before any request and never shortened.

## Evidence

| cloro response | Stored as |
|---|---|
| `result.text` | The answer. A response without it, or with empty text, is a failed query. |
| `result.citationPills[]` | Sources with the relationship `explicit-citation`, one per URL, with the first non-empty `label` as title. They feed cited domains. Pill ids, positions, domains and descriptions stay in the raw response. |
| `result.sources[]` | Sources with the relationship `answer-support`: cloro describes them as the pages the surface used or shows for the answer. They feed cited domains. ChatGPT's `footnote` and every `description` stay in the raw response. A ChatGPT answer often has no pills, so its cited domains come from `sources` only. |
| `datePublished` (ChatGPT only) | The source's published date, as sent. |
| `result.model` (ChatGPT only) | The disclosed model, recorded as `servedModel`. It is empty or `null` on ChatGPT's mobile-web format, and then no model is recorded. |
| `X-Request-ID` header | The upstream request id. |
| (nothing) | Search queries, cost, tokens, searches and page reads. Gemini and AI Mode return no search queries, and ChatGPT returns them only with the paid `include.searchQueries`, which Canonry does not send. The body carries no amount, so cost stays unknown, never zero. The `X-Credits-Charged` header is not read. |

A `200` response carries the whole answer, so it is either complete or a failed query. cloro documents that a surface sometimes returns a short canned message with no sources. Canonry stores it as a complete answer, as cloro returns it.

## Errors and retries

Error bodies carry `success: false` and `error` with `code`, `message` and, for validation errors, `details` per field. The failure message keeps cloro's message, field details and code, and adds a plain explanation for a missing or invalid key (`MISSING_API_KEY`, `INVALID_API_KEY_FORMAT`, `INVALID_OR_EXPIRED_API_KEY`) and credits (`INSUFFICIENT_CREDITS` on HTTP 403).

Only HTTP 429 and 503 are retried, at most twice, honoring `Retry-After` (cloro sends it on 503 only). Errors are not billed. HTTP 500 is not retried, because cloro has already retried up to 5 attempts before it returns one. 400, 401 and 403 need a fix first.

The `cloro` connection allows 1 request at a time, the Free plan's concurrency limit, plus Canonry's defaults of 10 a minute and 1,000 a day, shared by every cloro profile. On a paid plan, raise it with `cnry settings provider cloro --max-concurrent <n>`.

## Not used

The async task API, `include` add-ons (HTML, Markdown, raw response, shopping, ads, ChatGPT search queries), `state` targeting, AI Mode's `location`, `uule`, `gl`, `hl` and `device`, multi-turn ChatGPT prompts, Google Search, Google News and Grok (retired by cloro) are outside this adapter. Fixtures in `packages/provider-answer-services/test/services/cloro/` follow cloro's documented response shapes; their field shapes were checked against live responses, but their content is invented.
