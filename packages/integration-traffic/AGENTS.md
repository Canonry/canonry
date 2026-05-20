# integration-traffic

## Purpose

Provider-neutral traffic classifier and rollup. Takes `NormalizedTrafficRequest` events (from any traffic adapter — Cloud Run today, WordPress/Cloudflare/Vercel later) and produces hourly crawler / AI-referral buckets plus a debugging probe report. Lives between the raw adapters and the future DB persistence layer.

## Key Files

| File | Role |
|------|------|
| `src/rules.ts` | Bundled AI crawler UA patterns and known AI-referrer host rules |
| `src/classifier.ts` | `classifyCrawler` / `classifyAiUserFetch` / `classifyAiReferral` — three disjoint matchers. `classifyCrawler` matches UA rules with `purpose !== 'user-agent'` (GPTBot, OAI-SearchBot, …). `classifyAiUserFetch` matches UA rules with `purpose === 'user-agent'` (ChatGPT-User, Perplexity-User) so per-user fetches stay separate from bulk crawl. `classifyAiReferral` matches referer host or `utm_source` against known AI domains. All return `claimed_unverified` until IP verification promotes to `verified`. |
| `src/rollup.ts` | `buildTrafficProbeReport` — aggregates classified events into hourly buckets + top-N summaries |
| `src/types.ts` | Bucket shapes (`CrawlerEventHourlyBucket`, `AiReferralEventHourlyBucket`), classifier output types, probe report shape |
| `src/index.ts` | Re-exports public API |

## Patterns

- **Pure functions, no I/O.** Adapters fetch and normalize; this package only classifies and rolls up. Unit-testable end-to-end with fixture events.
- **Three evidence channels.** Bulk crawl via UA where `purpose !== 'user-agent'` (`crawler_events_hourly`); per-user AI fetches via UA where `purpose === 'user-agent'` (`ai_user_fetch_events_hourly`); human AI referrals via referer/UTM (`ai_referral_events_hourly`). Never collapse them — each answers a different question: "is AI training on me?" vs. "is AI reading me for a user right now?" vs. "are users clicking through from AI?"
- **Verification status tiers.** UA-only matches stay `claimed_unverified`. Promotion to `verified` requires IP/rDNS verification, which is not yet implemented. The `unknown_ai_like` bucket is reserved for behavioral heuristics.
- **Path normalization.** Rollups key on the normalized path so query-string variants don't fragment the bucket counts.
- **Bounded sample tail.** `buildTrafficProbeReport` keeps a small sample slice for classifier debugging; the durable signal is the hourly bucket counts.

## Common Mistakes

- **Adding I/O here.** Network/file/DB calls belong in adapters or service code. Keep this package pure.
- **Treating UA-only matches as verified.** Anyone can spoof a user agent. Until IP/rDNS verification is wired, never promote UA-only matches above `claimed_unverified`.
- **Mixing crawler and referral signals into one bucket.** They answer different questions (machine activity vs human clicks); keep them in separate tables and separate API surfaces.

## See Also

- `packages/contracts/src/traffic.ts` — `NormalizedTrafficRequest` input contract
- `packages/integration-cloud-run/` — first raw-event adapter feeding this package
- `plans/server-side-ai-traffic-ingestion.md` — table layout, classifier tiers, surface plan
- `plans/cloud-run-traffic-source-model-review.md` — raw-event vs aggregate-bucket model rationale
