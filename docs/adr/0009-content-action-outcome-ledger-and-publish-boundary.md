# ADR 0009: Content Action Outcome Ledger + Publish Transformer/Adapter Boundary

## Status

Proposed. This ADR captures three intertwined product contracts surfaced during the Wave-0 content engine design (`docs/gtm.md` §3a). Adoption is gated on the GTM doc landing.

## Context

Canonry has been observational since v1: it tracks AI citations across providers and surfaces "you're cited" / "competitor X is cited instead." The `integration-wordpress/` package is the one exception, modelling a "manual-assist" pattern (generate payload, leave the final mutation to the operator/agent — see `docs/wordpress-setup.md:44-54`).

The Wave-0 GTM plan introduces a **citation-driven content opportunity engine** as the lead investment for the v1 launch. Three design decisions in that work define product contracts that will shape canonry's surface for years:

1. **What canonry generates and what it deliberately doesn't.** Briefs vs drafts, evidence ledgers vs body retrieval, payloads vs mutations.
2. **How recommended actions are executed across diverse CMS targets** without canonry becoming a multi-CMS API client.
3. **How recommended actions are tracked across their full lifecycle** so outcome data accumulates and future ranker iterations can learn from observed per-domain results.

These warrant ADR-level memorialization because they cross both API stability and conceptual product framing — they are not just implementation choices.

## Problem

### A. Generation boundary

Without explicit boundaries, "content recommendations" naturally drifts toward "content generator" and from there toward "content scraper" (reading competitor bodies for source material, fetching user pages for verification, etc.). That drift would:

- Violate AGENTS.md's agent-first thesis ("canonry surfaces, agent acts").
- Expose canonry to ToS / scraping concerns at scale.
- Make the recommendations indistinguishable from generic AI writing tools.
- Enable hallucination — the LLM filling in gaps with invented facts (competitor word counts, H2 structures, etc.) presented as if grounded.

### B. Publish execution

Canonry could implement live API clients for every CMS (WordPress, Ghost, Webflow, Sanity, Contentful, ...) but each adds:

- Credential storage + keychain integration per provider.
- Auth refresh logic (OAuth, app passwords, token rotation).
- Rate-limit + retry handling.
- API drift maintenance forever.
- Error handling per provider's quirks.

External agents (Claude Code, Codex, etc.) already have HTTP + credential capabilities. Duplicating this in canonry is out-of-thesis maintenance burden.

### C. Recommendation lifecycle

Without persistence beyond the brief artifact, every recommendation is forgotten the moment the brief is generated. Canonry can never answer "did `add-schema` work better than `expand` for this site?" — the foundational question for any future ranker improvement. Building this ledger AFTER actions are already shipping means losing the most valuable training data: early-adopter outcomes.

## Proposed Decision

### Decision 1 — Generation boundary (the ladder)

```
1. content targets         → ranked actions (no prose)
2. content sources         → evidence map (URLs/titles/counts)
3. content brief json      → canonical structured brief w/ evidence ledger
4. content brief md        → renderer of the JSON
5. (drafting)              → OUT OF SCOPE — external agent only
6. content publish-payload → CMS-shaped payload (no mutation)
7. wordpress create-draft  → EXPLICIT MUTATION (WP only, audit-logged)
```

- **Drafting is never a canonry surface.** External agents fetch the brief's cited URLs (their own WebFetch / browser tool / rate-limit obligations) and produce the draft.
- **The brief carries explicit `unknownFields[]`** listing facts the LLM was instructed not to invent (e.g., `competitor_h2_structure`, `competitor_word_count`). This is the load-bearing anti-hallucination guarantee — testable per-field, not aspirational.
- **Canonry never reads competitor *or* user page bodies.** Body retrieval is the agent's job. The boundary is uniform.

### Decision 2 — Publish via pure transformers; one full adapter

- **Transformers are pure functions** (`(brief, draft, targetMeta) → ContentPublishPayloadDto`) with no HTTP, no auth, no runtime deps. New `packages/publish-transformers/` package ships `wordpress`, `ghost`, `next-mdx`, `generic` transformers at v1 launch.
- **WordPress is the one full adapter** because (a) `integration-wordpress/` already exists, (b) the target audience (solo AEO analysts, SEO consultants, in-house SEO) has heavy WP overlap, (c) the marginal cost to keep it is near zero. `canonry wordpress create-draft` is the only mutation in the content surface.
- **All other CMSes** receive the payload with credential placeholders (e.g., `${GHOST_ADMIN_KEY}`); the agent substitutes credentials from its env and executes the HTTP call. Canonry never sees non-WP secrets.
- Webflow, Hugo, Sanity, Contentful added on user request only — never speculatively.

### Decision 3 — Content Action Outcome Ledger

Every recommended action becomes a **tracked experiment** persisted in a new `content_actions` table:

- **Identity:** `actionId`, `query`, `action ∈ {create|expand|refresh|add-schema}`, `targetPage?`, `state`
- **Promotion context (frozen at creation):** `scoreAtPromotion`, `driversAtPromotion[]`, `sourceRunId`
- **Baseline (frozen at creation):** `baselineCitedRate`, `baselineProviderBreakdown`, `baselineGscStats { impressions, position, ctr }`, `baselineCompetitorOverlap[]`, `baselineObservationSet { providers[], models[], locations[] }`
- **Lifecycle artifacts:** `briefId?`, `payloadGeneratedAt?`, `wpDraftId?`, `wpDraftUrl?`, `draftCreatedAt?`, `publishedUrl?`, `publishedAt?`, `dismissedAt?`, `dismissedReason?`
- **Outcome (computed lazily, refined as runs accumulate):** `firstMeasurement` (after first eligible post-publish run) + `result ∈ {improved|unchanged|regressed|inconclusive}` + `citationGained[]`, `citationLost[]`, `providersImproved[]`, `competitorDisplacement`, `timeToFirstCitation`, `newEvidence[]` (post-baseline observation expansions, surfaced separately)

State machine:

```
proposed → briefed → payload-generated → draft-created (WP only) → published → validated
                                              ↓
                                          published (non-WP path: mark-published or agent)
                                              ↓
                                      dismissed (terminal, any state)
```

`draft-created` is a WP-only intermediate state — a WordPress draft is not published content, just a draft sitting in WP admin awaiting user review. WP poll watches for `status: publish` before transitioning the action to `published`. Non-WP paths skip `draft-created` entirely.

**Validation threshold:** `published → validated` only fires after ≥3 eligible post-publish runs OR ≥14 days, whichever first. Until threshold, `result = 'inconclusive'` with `firstMeasurement` populated. AI citation results are noisy; a single post-publish snapshot is not enough evidence to call an action validated — and the ledger is training data, so false positives would corrupt future per-domain ranking. Eligible runs = those whose observation set has non-empty intersection with `baselineObservationSet`.

**Like-for-like outcome comparison:** outcome computation only considers post-publish runs whose observation set (providers × models × locations) intersects the frozen `baselineObservationSet`. New providers/locations/models added after publish are surfaced separately as `newEvidence[]`, never folded into the result (would be a category error).

**Idempotency contract:** at most one in-progress action per `(projectId, query, action, targetPage)` triple. `content brief --target-ref` reuses an existing in-progress action if one exists. `content targets` hides in-progress actions by default; `--include-in-progress` shows them annotated with `existingAction: { actionId, state, lastUpdated }`.

**Mutation boundary — two layers:**
- **External mutation** (writes outside canonry): only `wordpress create-draft`. WP-only, audit-logged.
- **Local ledger mutation** (writes to canonry's own DB): `content brief`, `content publish-payload`, `content mark-published`, `content dismiss`. These are durable lifecycle tracking, not boundary violations.

The boundary canonry preserves is "no silent external mutation." Internal ledger writes are how the system stays accountable to the user.

**Publish-state confirmation:**

| Path | Determinism |
|---|---|
| `wordpress create-draft` → `draft-created`, then WP poll detects `status: publish` → `published` | **Deterministic** (canonry knows the WP post ID) |
| Agent calls `content mark-published` as last workflow step | **Deterministic** (agent-mediated; non-WP path skips `draft-created`) |
| `content mark-published --url` (user-initiated) | **Deterministic** (manual fallback) |
| Sitemap-inspection diff finds matching slug | **Heuristic** — surfaces dashboard candidate "is this you?", never auto-transitions state |

## Why

### Generation boundary
- Aligns 1:1 with AGENTS.md ("canonry surfaces, agent acts").
- `unknownFields[]` makes the anti-hallucination guarantee testable per-field, not just aspirational copy.
- Body-reading prohibition is uniform (competitor + user pages alike), avoiding a confusing "we read sometimes" rule that would be easy to violate.
- Drafting being external preserves the open ecosystem: any agent that can generate prose can complete the loop, not just Aero.

### Transformer/adapter boundary
- Avoids becoming a multi-CMS HTTP client — out-of-thesis maintenance burden on the order of multiple integration-wordpress-equivalents.
- Pure transformers are 100% unit-testable with golden fixtures (no live API mocking, no auth setup).
- WP earns the adapter exception because the integration already exists and the audience overlap is high; other CMSes don't earn it speculatively.
- No off-the-shelf library covers this space (Micropub coverage too narrow for our targets — no Ghost/Webflow/core-WP; headless-CMS libraries like Contentlayer face inward, not outward). Composing `remark`/`rehype` + per-target transformers (~100-150 LOC each) is the right build (researched).

### Outcome ledger
- Without it, every recommendation is forgotten and no learning data accumulates.
- Building the ledger AFTER actions are already shipping means losing the most valuable training data (early-adopter validated outcomes).
- The state machine makes the closed loop visible to the user (lifecycle timeline in the dashboard) and to future ranker iterations (per-action-type outcome rates per domain).
- No ML in v1 — just deterministic before/after computation. ML becomes an option once enough rows accumulate per-domain.
- "Watching for publish" is honestly framed as deterministic-where-possible, suggest-with-confirmation otherwise — no false claims of automatic content-alignment verification.

## Tradeoffs / Costs

| Cost | Mitigation |
|---|---|
| Two new DB tables (`contentBriefs`, `content_actions`) + migrations | Standard Drizzle pattern; covered by AGENTS.md schema rules |
| New `packages/publish-transformers/` package | Sibling to `integration-wordpress/`; ~500 LOC total for 4 transformers at launch |
| Outcome computation needs post-publish snapshot data | Computed lazily on read; no eager pipeline overhead |
| Heuristic publish detection (sitemap diff) is suggest-only, not auto-confirm | Documented constraint; user confirms with one tap, or runs `mark-published` for full determinism |
| No drafting in canonry might disappoint users expecting AI-generated content | Doc emphasizes the brief is the artifact; demo loop showcases brief → external agent draft → measured outcome |
| WP exceptionalism (one full adapter) creates an asymmetry | Doc explicitly frames WP as "first publishing integration"; other CMSes never speculatively built |
| `unknownFields[]` discipline requires careful prompt engineering | Ship criteria force schema-first, prompt-second; tests assert no inferred values leak into `knownFields` |
| Ledger introduces lifecycle complexity (state machine + transitions) | State machine is small (5 states + dismissed); transitions are well-defined and testable |

## Explicitly Not Decided

- Future ML-based ranker that weights action types by observed per-domain outcome — opt-in, requires sufficient validated rows per domain.
- Whether `content publish-payload` should support batch (multiple briefs → one payload).
- Eager vs lazy outcome computation. Default lazy unless dashboard latency forces a change.
- Whether `add-schema` extends beyond WP audit data via a generic `inspect-schema` HTTP fetch + JSON-LD parse on the user's own pages (~50 LOC, universal). Likely yes as a follow-up; v1 is WP-only schema audit.
- Whether competitor-schema comparison ever ships. Would require body retrieval, which the boundary forbids — would need a separate ADR to revisit.

## Open Questions

1. Should the heuristic publish-candidate UX (sitemap diff suggesting "did you publish this?") fire only when site inventory is enabled, or is it a v1.5 follow-up?
2. Does `content publish-payload` need a `--dry-run` mode? (`payload-generated` is already non-mutating, so possibly redundant.)
3. Should outcome computation include sentiment changes (per Phase 2.5 sentiment work) once that ships, or stay citation-only in v1?
4. For non-WP users with no agent integration and no sitemap, what's the friendliest reminder pattern to mark-publish? In-dashboard nag, email, or nothing?
5. Where do `mark-published` and `dismiss` live — separate API endpoints, or query params on a generic `PATCH /content/actions/:actionId`?

## Next Step

Discuss, revise, then accept or reject in tandem with the GTM plan landing. Nothing implements until this ADR and `docs/gtm.md` are both Accepted.

## See Also

- `docs/gtm.md` §3a — full product spec with command surface, DTOs, state transitions, and detection-vs-verification framing
- `docs/roadmap.md` — "Citation-Driven Content Opportunities + Action Outcome Ledger" entry (the lead Wave-0 investment)
- `AGENTS.md` (root) — agent-first contract, UI/CLI parity, error handling, JSON parsing, schema-migration rules
- `docs/wordpress-setup.md` — the existing WP integration patterns this work builds on
- `ADR 0008` — package split (the new `packages/publish-transformers/` slots into the same monorepo seam)
