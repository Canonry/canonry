# GoAnyAPI Google AI Overview

[GoAnyAPI's Google AI Overview API](https://goanyapi.com/docs/google-ai-overview-api) (`POST https://api.goanyapi.com/api/v1/google-ai-overview`) returns the AI Overview Google actually showed for a query, together with the pages Google lists beside it. Canonry runs it through the shared [search answer services](../answer-services.md) layer, so everything on that page applies here: it is never selected implicitly, only complete answers are measured, and unknown counts and costs stay unknown.

Unlike the other registered services, this surface is a capture of Google's own answer, not a text model's reply — so it measures the answer engine most shoppers see, without simulating it.

## Setup

Sign up on [goanyapi.com](https://goanyapi.com), create an API key, and save it once:

```bash
cnry settings provider goanyapi --api-key <key>
```

`GOANYAPI_API_KEY` is read by `cnry bootstrap`. A key is verified with `GET /api/v1/credits/balance`, which GoAnyAPI documents as free, so a saved key shows as connected without spending anything. Saving a key never sends one to another endpoint: the base URL is fixed by the descriptor.

Then name the profile wherever you choose engines. The bare `goanyapi` connection is not an engine.

```bash
cnry research run my-site --provider goanyapi:ai-overview --query "best roofer in springfield"
cnry project update my-site --provider gemini --provider goanyapi:ai-overview
```

## Profiles

| Route | Surface | Deadline per request | Workflows |
|---|---|---|---|
| `goanyapi:ai-overview` | Google AI Overview | 120 seconds | research, snapshot, visibility sweep |

GoAnyAPI does not publish latency for the endpoint. The deadline is Canonry's limit, not a GoAnyAPI figure. A request that reaches its deadline is not sent again, because a completed search is billed as a new one on retry.

## What is sent

```json
{ "query": "<the tracked query, unchanged>", "output": "json" }
```

With a location, Canonry adds `"country": "us"` (GoAnyAPI documents a two-letter code). GoAnyAPI takes a country and nothing finer, so a city location is stored as `partial` and the row does not claim the answer was measured from that city. No `language`, `device`, `page_token`, `html`, `json_restrictor` or `no_cache` is ever sent. Queries are capped at GoAnyAPI's documented limit of 8192 UTF-8 bytes; Canonry counts characters, so a query heavy in multi-byte characters can still exceed the byte cap and come back as an unbilled 400.

## Evidence

| GoAnyAPI response | Stored as |
|---|---|
| `data.result.content.results[].text` | The answer: the first result that carries overview text. An empty answer is a failed query. |
| `search_parameters.feature_available: false` | A failed query. Google showed no AI Overview for the query — a legitimate, billed outcome with nothing to measure. It is never stored as an empty answer, and the completion keeps `upstreamStatus: feature_available:false`. |
| `data.result.content.results[].links[]` | Sources with the relationship `answer-support`: Google lists them as the pages beside the overview it wrote from them, with no markers in the text. They feed cited domains. `title` and `url` are mapped; the rest stays in the raw response. A URL repeated across results is collapsed to its first occurrence. |
| `data.costCredits` | The billed unit, verbatim: `billedUnits: [{ unit: 'credit', quantity: <costCredits>, basis: 'reported' }]`. Cost stays unknown — credits are not USD and the credit price depends on the pack bought, so no USD figure is derived here. |
| `code` | The upstream status (`ok` on success). |
| (nothing) | The served model. The response names no model, and Google does not disclose which one wrote the overview, so `servedModel` stays empty. Token, search and page-read counts are unknown. |

`format` is always requested as `json`. A response in another documented format (`md`, `html+br+base64`) is a failed query — Canonry does not turn Markdown or HTML into answer text.

## Errors and retries

Error bodies carry `code` and `message` in the same envelope as a success. The failure message keeps GoAnyAPI's message and code, and adds a plain explanation for an empty account (`insufficient_credits` on HTTP 402), rejected parameters (`invalid_params` on HTTP 400), an upstream failure or timeout (`request_failed` on 502, `request_timeout` on 504) and an unconfigured service (`service_not_configured` on 503).

HTTP 429, 502, 503 and 504 are retried, at most twice, honoring `Retry-After`: GoAnyAPI documents that validation, authentication and operational failures are never billed. 400, 401, 402 and 403 need a fix first. Re-running an already-completed search is a new billed request, which is also why a request that reaches its deadline is not sent again.

The `goanyapi` connection uses Canonry's default limits (2 at a time, 10 a minute, 1,000 a day). Change them with `cnry settings provider goanyapi --max-per-minute <n>`.

## Not used

The other GoAnyAPI endpoints (SERP, keywords, backlinks, traffic, Ads Transparency, the ChatGPT/Gemini scrapers), `page_token` pagination (a short-lived token Canonry never requests), `html`/`md` output formats, `json_restrictor` field filtering, `zero_trace` and `no_cache` are outside this adapter. Fixtures in `packages/provider-answer-services/test/services/goanyapi/` follow the documented response shapes; they were not captured from live responses.
