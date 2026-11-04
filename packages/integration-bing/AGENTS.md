# integration-bing

## Purpose

Bing Webmaster Tools integration. It is the API client for every Bing Webmaster read: URL info, daily traffic, weekly query and page stats, query and page drill-downs, crawl stats and issues, sitemaps, submission quotas, site settings (blocks, parameters, geo-targeting, crawl settings), Fetch as Bingbot, inbound links, and keyword research. It also covers URL submission.

## Key Files

| File | Role |
|------|------|
| `src/bing-client.ts` | Bing Webmaster API client: every read method, URL submission, WCF date parsing (`parseBingDate`, `bingDateToDay`) and the keyword market helper (`bingKeywordMarket`). |
| `src/types.ts` | Type definitions and `BingApiError` custom error class |
| `src/constants.ts` | API URLs, timeouts |
| `src/index.ts` | Re-exports public API |

## Patterns

- **API key auth**: Uses a Bing Webmaster API key stored in `~/.canonry/config.yaml`.
- **Shapes come from captured responses.** `test/fixtures/*.json` are live Bing responses, anonymised (hosts, queries and pages replaced) but otherwise byte-for-byte, `__type` included. Add a new method by capturing its real response first. Microsoft's .NET docs list property names but not always the JSON shape (the `Verified` / `IsVerified` bug came from trusting a type over a response).
- **Bing quirks the types document:** `QueryStats.Query` holds the PAGE URL for `GetPageStats` / `GetQueryPageStats`; query and page stats are WEEKLY buckets; `AvgClickPosition` is `-1` for "no value" even on rows with clicks; dates are WCF `/Date(ms)/` strings (use `parseBingDate` / `bingDateToDay`); `GetChildrenUrlInfo` is a read that only accepts POST (sent with `idempotent: true` so it retries like a GET); `GetConnectedPages` / `GetSiteRoles` return `ErrorCode 14 NotAuthorized` for a key that is not the site owner's; `GetUrlSubmissionQuota` reports what is LEFT, not the allowance.
- **Not in the API:** Bing's AI Performance report (Copilot citations, grounding queries, Topics Portfolio). Probing showed none of 68 plausible method names exist (an unknown method returns 404, a real one 400 `InvalidApiKey` without a key).
- **Error handling**: Uses `BingApiError` for API-specific errors.
- **Retry lives here, and only here.** `bingFetch` wraps `bingFetchOnce` in `withRetry` (`BING_MAX_RETRIES`, `Retry-After` aware, throttle-aware via `BingApiError.isThrottle`). Callers must NOT add a second retry layer — layers multiply: a driver retrying 4 times around this client's 5 attempts issued 20 HTTP requests for one throttled URL.
- **Throttle cooldown.** A call that exhausts its retry budget and is STILL throttled opens a `BING_THROTTLE_COOLDOWN_MS` window for that API key, during which `bingFetch` fails fast without touching the network. Bing's throttle is on the **account** (`ErrorCode 4 ThrottleUser`) as well as the host (`ErrorCode 5 ThrottleHost`), and measurement showed it outlasting the run by over an hour — a site untouched for six days was still refused with nothing in flight. Continued requests are what hold it open, so backing off entirely is the only thing that helps. Keyed by a digest, never the raw key. `__resetBingThrottleCooldownForTest(now?)` clears it and pins the clock; because the state is module-level (deliberately — the limit is per account, not per call site), any suite touching this client should reset it in `beforeEach`.

## Common Mistakes

- **Storing API keys in the database** — credentials belong in `~/.canonry/config.yaml`.
- **Adding retry at the call site** — it is already here, and stacking multiplies load against an API that is refusing you.
- **Treating a throttle as per-site** — one key serves every project on the instance, so one project's burst throttles all of them.

## See Also

- `docs/bing-webmaster-setup.md` — user-facing setup guide
- `packages/api-routes/src/bing.ts` — API routes that use this client
