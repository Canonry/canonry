# integration-traffic

## Purpose

Provider-neutral traffic classifier and rollup. Takes `NormalizedTrafficRequest` events (from any traffic adapter — Cloud Run today, WordPress/Cloudflare/Vercel later) and produces hourly crawler / AI-referral buckets plus a debugging probe report. Lives between the raw adapters and the future DB persistence layer.

## Key Files

| File | Role |
|------|------|
| `src/rules.ts` | Bundled AI crawler UA patterns and known AI-referrer host rules |
| `src/classifier.ts` | `classifyCrawler` / `classifyAiUserFetch` / `classifyAiReferral` — three disjoint matchers. `classifyCrawler` matches UA rules with `purpose !== 'user-agent'` (GPTBot, OAI-SearchBot, …). `classifyAiUserFetch` matches UA rules with `purpose === 'user-agent'` (ChatGPT-User, Perplexity-User) so per-user fetches stay separate from bulk crawl. `classifyAiReferral` matches referer host or `utm_source` against known AI domains **and** stamps a paid/organic `trafficClass` via `classifyAiReferralTrafficClassFromEvent`, which reads `utm_medium`/`utm_campaign`/`utm_content`/`utm_term` off both the request and referer query strings through the shared `classifyAiReferralTrafficClass` (contracts). The class is orthogonal to `evidenceType` (which only identifies the engine): the referer host says WHO sent the click, the UTM tags say whether it was PAID. `organic` means "no paid evidence", never "confirmed unpaid" — an untagged ad click is indistinguishable. There is no server-side equivalent of GA4's `channelGroup`, so the UTM tokens are the only discriminator. Crawler/user-fetch matchers return `claimed_unverified` until IP verification promotes to `verified`. |
| `src/rollup.ts` | `buildTrafficProbeReport` — aggregates classified events into hourly buckets + top-N summaries. AI-referral buckets carry `paidHits` / `organicHits` alongside `hits` (`paidHits + organicHits === hits`); a session is paid when ANY hit in its window is paid (the ad UTMs ride the landing request; the follow-up sub-resources carry none, so a later tag-less hit must not downgrade it). |
| `src/types.ts` | Bucket shapes (`CrawlerEventHourlyBucket`, `AiReferralEventHourlyBucket`), classifier output types, probe report shape |
| `src/index.ts` | Re-exports public API |

## Patterns

- **Pure functions, no I/O.** Adapters fetch and normalize; this package only classifies and rolls up. Unit-testable end-to-end with fixture events.
- **Three evidence channels.** Bulk crawl via UA where `purpose !== 'user-agent'` (`crawler_events_hourly`); per-user AI fetches via UA where `purpose === 'user-agent'` (`ai_user_fetch_events_hourly`); human AI referrals via referer/UTM (`ai_referral_events_hourly`). Never collapse them — each answers a different question: "is AI training on me?" vs. "is AI reading me for a user right now?" vs. "are users clicking through from AI?"
- **Verification status tiers.** A UA-only match stays `claimed_unverified`; it is promoted to `verified` only when the source IP falls in the operator's published range (see `ip-verify.ts`). User-fetch agents are a caveat: an on-device fetch egresses from the user's own IP, so a genuine user fetch can stay `claimed_unverified` permanently. The `unknown_ai_like` bucket is reserved for behavioral heuristics.
- **Self-traffic exclusion.** `buildTrafficProbeReport` drops events whose UA matches `SELF_TRAFFIC_USER_AGENT_PATTERNS` (Canonry's own tooling, e.g. `AINYC-AEO-Audit/` from `aeo-audit --sitemap`) before any rollup. Our own measurement crawls a client's sitemap/robots/llms.txt/pages and is not a real visitor or third-party crawler, so it must never inflate a client's crawler / unknown / total counts or pollute the sample tail. The dropped count is surfaced as `totals.selfTrafficExcluded` (never silent). `isSelfTraffic(event)` is the shared predicate; keep its patterns specific so a real UA that merely mentions the brand is not swept up.
- **Path normalization.** Rollups key on the normalized path so query-string variants don't fragment the bucket counts.
- **Bounded sample tail.** `buildTrafficProbeReport` keeps a small sample slice for classifier debugging; the durable signal is the hourly bucket counts.

## Common Mistakes

- **Adding I/O here.** Network/file/DB calls belong in adapters or service code. Keep this package pure.
- **Treating UA-only matches as verified.** Anyone can spoof a user agent. Promote above `claimed_unverified` only when `verifyIpForRule` confirms the source IP against the operator's published range.
- **Mixing crawler and referral signals into one bucket.** They answer different questions (machine activity vs human clicks); keep them in separate tables and separate API surfaces.

## See Also

- `packages/contracts/src/traffic.ts` — `NormalizedTrafficRequest` input contract
- `packages/integration-cloud-run/` — first raw-event adapter feeding this package
