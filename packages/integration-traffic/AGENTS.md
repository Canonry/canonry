# integration-traffic

## Purpose

Provider-neutral traffic classifier and rollup. Takes `NormalizedTrafficRequest` events (from any traffic adapter — Cloud Run today, WordPress/Cloudflare/Vercel later) and produces hourly crawler / AI-referral buckets plus a debugging probe report. Lives between the raw adapters and the future DB persistence layer.

## Key Files

| File | Role |
|------|------|
| `src/rules.ts` | Bundled AI crawler UA patterns and known AI-referrer host rules |
| `src/classifier.ts` | `classifyCrawler` / `classifyAiUserFetch` / `classifyAiReferral` — three disjoint matchers. `classifyCrawler` matches UA rules with `purpose !== 'user-agent'` (GPTBot, OAI-SearchBot, …). `classifyAiUserFetch` matches UA rules with `purpose === 'user-agent'` (ChatGPT-User, Perplexity-User) so per-user fetches stay separate from bulk crawl. `classifyAiReferral` matches referer host or `utm_source` against known AI domains **and** stamps a paid/organic `trafficClass` via `classifyAiReferralTrafficClassFromEvent`, which reads `utm_medium`/`utm_campaign`/`utm_content`/`utm_term` off both the request and referer query strings through the shared `classifyAiReferralTrafficClass` (contracts). The class is orthogonal to `evidenceType` (which only identifies the engine): the referer host says WHO sent the click, the UTM tags say whether it was PAID. `organic` means "no paid evidence", never "confirmed unpaid" — an untagged ad click is indistinguishable. There is no server-side equivalent of GA4's `channelGroup`, so the UTM tokens are the only discriminator. Crawler/user-fetch matchers return `claimed_unverified` until IP verification promotes to `verified`. |
| `src/ip-range-manifest.ts` | Strict, full-string IPv4/IPv6/CIDR parsing, pure publisher-manifest validation, and canonical prefix-content hashing. The refresh script and runtime verifier share this fail-closed boundary. |
| `src/ip-verify.ts` | Maps classifier rules to vendored publisher manifests and returns the verification decision with exact manifest provenance. |
| `src/rollup.ts` | `buildTrafficProbeReport` — aggregates classified events into hourly buckets + top-N summaries. Verified crawler/user-fetch bucket identity includes the publisher manifest id, and each bucket carries that manifest provenance. AI-referral buckets carry `paidHits` / `organicHits` alongside `hits` (`paidHits + organicHits === hits`); a session is paid when ANY hit in its window is paid (the ad UTMs ride the landing request; the follow-up sub-resources carry none, so a later tag-less hit must not downgrade it). |
| `src/journey.ts` | AI visitor journeys, pure core. `extractJourneyRequests` keeps a batch's browser requests (no crawlers, AI user fetches, self traffic, non-browser clients, static assets, HEAD/OPTIONS), normalizes times to UTC ISO, cuts queries to `utm_*` and keeps click ids by presence only. `maskJourneyPath` masks secret-like path segments. `sessionizeJourneyRequests` groups one visitor's requests into 30-minute visits (`placeRequest` applies the in-order rules, so a late request joins or heads the right visit) and keeps requests within 30 days after an AI touch plus the rest of a kept visit, capped per visitor per UTC day. A same-site, sign-in or payment referer is a step; an AI engine seen only on a same-site utm counts as a touch only without an AI touch in the lookback; a background data call never opens a visit. A late request does not merge two stored visits, and push requests dropped before the AI landing arrives are not recovered. Keying and storage live in `api-routes/src/journeys.ts`. |
| `src/types.ts` | Bucket shapes (`CrawlerEventHourlyBucket`, `AiReferralEventHourlyBucket`), classifier output types, probe report shape |
| `src/index.ts` | Re-exports public API |

## Patterns

- **Pure functions, no I/O.** Adapters fetch and normalize; this package only classifies and rolls up. Unit-testable end-to-end with fixture events.
- **Three evidence channels.** Bulk crawl via UA where `purpose !== 'user-agent'` (`crawler_events_hourly`); per-user AI fetches via UA where `purpose === 'user-agent'` (`ai_user_fetch_events_hourly`); human AI referrals via referer/UTM (`ai_referral_events_hourly`). Never collapse them — each answers a different question: "is AI training on me?" vs. "is AI reading me for a user right now?" vs. "are users clicking through from AI?"
- **Verification status tiers.** A UA-only match stays `claimed_unverified`; it is promoted to `verified` only when the source IP falls in the operator's published range (see `ip-verify.ts`). `verifyIpForRuleDecision` also returns the exact vendored manifest consulted; its id combines source, publisher version, and a canonical SHA-256 prefix-content digest so stale publisher versions cannot merge different snapshots. Classifier results and hourly buckets preserve it as `verificationManifest`, including rejected decisions, so historical rollups remain attributable when publishers change their ranges. User-fetch agents are a caveat: an on-device fetch egresses from the user's own IP, so a genuine user fetch can stay `claimed_unverified` permanently. The `unknown_ai_like` bucket is reserved for behavioral heuristics.
- **Reviewed, low-churn publisher snapshots.** Runtime classification never fetches the network. `.github/workflows/refresh-crawler-ip-ranges.yml` checks every official source weekly and opens one fixed-branch PR only when canonical prefix content or the canonical source URL changes. Publisher timestamp/order-only changes preserve the existing snapshot. A partial source failure exits nonzero and opens no PR. Amazon's official HTML pages are normalized into the same validated manifest shape by `scripts/refresh-ip-ranges.ts`.
- **Self-traffic exclusion.** `buildTrafficProbeReport` drops events whose UA matches `SELF_TRAFFIC_USER_AGENT_PATTERNS` (Canonry's own tooling, e.g. `AINYC-AEO-Audit/` from `aeo-audit --sitemap`) before any rollup. Our own measurement crawls a client's sitemap/robots/llms.txt/pages and is not a real visitor or third-party crawler, so it must never inflate a client's crawler / unknown / total counts or pollute the sample tail. The dropped count is surfaced as `totals.selfTrafficExcluded` (never silent). `isSelfTraffic(event)` is the shared predicate; keep its patterns specific so a real UA that merely mentions the brand is not swept up.
- **Path normalization.** Rollups key on the normalized path so query-string variants don't fragment the bucket counts.
- **Journeys stay generic.** Journey logic reads only `NormalizedTrafficRequest` fields, so every adapter feeds it the same way. No site-specific paths, goals or snippets. A request from a different outside source starts a new visit; a same-site referer is a step inside one.
- **Bounded sample tail.** `buildTrafficProbeReport` keeps a small sample slice for classifier debugging; the durable signal is the hourly bucket counts.

## Common Mistakes

- **Adding I/O here.** Network/file/DB calls belong in adapters or service code. Keep this package pure.
- **Treating UA-only matches as verified.** Anyone can spoof a user agent. Promote above `claimed_unverified` only when `verifyIpForRuleDecision` confirms the source IP against the operator's published range. Keep `verifyIpForRule` only for callers that need the legacy boolean result.
- **Mixing crawler and referral signals into one bucket.** They answer different questions (machine activity vs human clicks); keep them in separate tables and separate API surfaces.

## See Also

- `packages/contracts/src/traffic.ts` — `NormalizedTrafficRequest` input contract
- `packages/integration-cloud-run/` — first raw-event adapter feeding this package
