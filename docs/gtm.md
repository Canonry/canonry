# Canonry GTM Launch Plan

> **Scope:** launch-oriented sequencing, success metrics, and per-agent distribution. The canonical product roadmap remains `docs/roadmap.md`. This doc is the launch view; roadmap is the feature view.

## Launch Thesis

Canonry is **CLI/API-first, any-agent**. AGENTS.md is explicit: MCP is allowed only as an adapter over the public API client, not as a parallel surface, and must not introduce capabilities unavailable through API/CLI. Aero is a **convenience** — one built-in agent for users who don't already have one. The real win is that Claude Code, Codex, Hermes, OpenClaw, or any custom agent can drive canonry natively through the CLI + API, with MCP available for clients where a tool catalog is the natural integration path.

That reframes the GTM feature set: the question isn't "what can Aero do?" It's **"how fast can any agent become productive with canonry?"** Everything below is oriented around that.

**Lead investment:** the citation-driven content opportunity engine — `canonry content targets → content brief (JSON) → external agent draft → content publish-payload → optional wordpress create-draft`. It is the launch headliner, the demo moment, and the feature that closes the loop from observation to outcome. **Drafting itself is out of scope for canonry** (external agent only); the rest of the ladder is.

## Target Users & Agents

- **Target users:** solo AEO analysts, SEO consultants, in-house SEO at SaaS companies.
- **Target agents (first-class skill install support):** Claude Code, Codex, Hermes, OpenClaw. Generic fallback for anything else.
- **Marketing domain:** `canonry.ai`. Backend telemetry stays on `ainyc.ai`.

---

## The three originally-proposed features — validated & reframed

### 1. Easy setup — extend the existing UI wizard, mirror in CLI for agents

**Status — corrected:** the dashboard already has a 5-step setup wizard at `apps/web/src/pages/SetupPage.tsx:21` (system check → create project → keywords → competitors → first run). Empty installs are auto-redirected to `/setup` (`apps/web/src/router/routes.tsx:46-48`), and `build-dashboard.ts:1153,1167` already surfaces empty-state CTAs. **The wizard exists; the gap is what it covers.**

The existing wizard:
- Only *checks* providers in step 1 (system check) and links out to `/settings` to add them — provider entry is not inline.
- Has no GSC / GA4 / Bing / WordPress integration steps.
- Has no "connect your AI editor" step.
- Is one-shot: once a project exists, `routes.tsx:108-113` redirects users away from `/setup` permanently — there is no persistent setup checklist for half-finished setups.

**Two paths, same destination:**

#### Path A — extend the existing UI wizard (primary, most users)

Build on `SetupPage.tsx`, don't replace it.

- **Insert a "Connect a provider" step** before the existing system-check, with inline forms for Gemini / OpenAI / Claude / Perplexity / Local. Validate keys inline (test call); save via existing settings API. Removes the `/settings` round-trip and the "at least one provider" `INIT_PROVIDER_REQUIRED` failure path (`packages/canonry/src/commands/init.ts:218-229`).
- **Insert a skippable "Connect integrations" step** after competitors — GSC OAuth, GA4 service account, Bing key, WordPress app password. All optional with clear "do this later" CTAs.
- **Insert a final "Connect your AI editor" step** after the first run launches. Lists Claude Code, Codex, Hermes, OpenClaw, generic as cards (browser can't auto-detect, so show all). Each card shows copy-paste install command backed by `canonry skill install --for <agent>`.
- **Persistent setup checklist component** that surfaces in the sidebar/topbar even after the redirect kicks in — shows "provider ready / project / GSC / agent", links back to the relevant step. Lives independently of the one-shot wizard so users can finish skipped items later.
- **Empty states everywhere** that say what to do, not just what's missing. The dashboard already does this for projects (`build-dashboard.ts:1167-1174`); extend the same pattern to insights / runs / GSC / etc.
- **Aero is right there** in the bottom AeroBar as the convenience option for users who haven't wired up an external agent.

#### Path B — CLI/agent setup (power users, agent-driven)

Same capabilities exposed for users who say "Claude, install canonry and set me up for example.com."

- **`canonry skill install [--for claude-code|codex|cursor|generic]`** — drops the canonry-setup skill into the right location (`~/.claude/skills/`, Codex config, Cursor rules, or prints markdown for a generic README).
- **`canonry init` handoff step:** after setup, detect installed agent tooling and print the one-line install. "Claude Code detected — run `canonry skill install --for claude-code` to give it full context."
- **`canonry agent-guide`** — prints a compact markdown doc (domain overview, common CLI invocations, `--format json` contract, error codes) that an agent can drop into its system prompt.
- **Example workflow docs:** "Using canonry with Claude Code to audit & fix your site" — `canonry run` → Claude Code reads insights → Claude Code applies schema fixes in the user's repo → `canonry run` to verify. Same doc for Codex/Cursor/custom.

**Parity rule:** anything the wizard does, the CLI must do too (per AGENTS.md UI/CLI parity). Project create, provider add, integration connect, first run — all single-call CLI commands with `--format json`. The wizard is just a friendly chrome over them.

**Why this wins:** non-terminal users get a polished install-and-go path. Agent users get the lean CLI flow. Both routes converge on the same project state, and both surfaces teach the agent-integration story.

### 2. Codebase integration — extend the WordPress manual-assist pattern

**Status:** Canonry is observational. `integration-wordpress` is the one exception, and it already models exactly the right pattern for agent-driven code changes — *generate the payload, leave the final mutation to the operator/agent.* See `docs/wordpress-setup.md:44-54` ("What Stays Manual") and `packages/integration-wordpress/src/schema-templates.ts:1` (schema.org templates).

**Reframed for agent-first:** don't invent a new `packages/site-adapters/*` tree. Extend the existing manual-assist pattern with framework-aware emitters that any agent can pipe into the user's repo.

- **Generalize the pattern:** the WordPress commands `wordpress set-schema`, `wordpress set-llms-txt` already do "generate payload + next steps." Lift the schema-template helpers out of `integration-wordpress/` (or add a sibling `packages/site-emitters/`) so they're framework-agnostic.
- **New CLI commands that emit fix artifacts:**
  - `canonry fix schema <project> --page /pricing --format patch|jsonld` → JSON-LD snippet (or unified diff for a detected framework).
  - `canonry fix llms-txt <project> --format file` → full `llms.txt` content.
  - `canonry fix meta <project> --page /pricing --format json` → title/description/OG recommendations.
- **Framework awareness as a flag, not a package:** `--framework next|astro|hugo|html|wordpress`. Start with HTML + Next.js (biggest audience); WordPress already exists. Add others as demand shows up. Each framework just changes the emitted format.
- **Agent workflow:** Claude Code / Codex reads `canonry insights list --format json`, picks an issue, runs `canonry fix schema --format patch`, applies the patch in the user's repo, commits, pushes. Canonry stays out of git — the agent already has repo permissions.
- **Defer:** a `packages/integration-github-app/` for non-agent users (opens a PR for them). Only build if traction shows users want canonry to touch git directly.

**Why this wins:** the WordPress integration already proves the pattern works. Generalizing is a smaller lift than inventing a new package tree, and it stays consistent with how canonry already thinks about side effects (generate + advise, never silently mutate).

### 3. Packaged (macOS first, one-click)

**Status:** npm-only (`@ainyc/canonry@2.0.0`). Dockerfile exists. No Homebrew, no .dmg, no desktop bundle.

- **`npx @ainyc/canonry init`** — verify this works end-to-end for zero-install trial. This is the lowest-friction entry for any npm-capable user.
- **Homebrew tap** (small lift, big reach): `brew install ainyc/tap/canonry`. Wraps the npm install + `canonry init` shim.
- **macOS signed/notarized .pkg installer:** bundles Node runtime + canonry + optional launchd agent for background `canonry serve`. Click → menu-bar app showing serve status + quick-open dashboard. Removes "install Node first" from the funnel.
- **Tauri desktop shell (defer):** full GUI wrapping the SPA. Only pursue if a non-CLI audience shows up.
- Keep npm as canonical for power users and CI.

### 3a. Content recommendations & generation — close the loop from observation to action (LEAD FEATURE)

**Status:** canonry already tracks a very rich signal. Per-query snapshots (`QuerySnapshotDto` in `packages/contracts/src/run.ts:57-77`) carry:
- `citedDomains: string[]` — which domains the LLM credited
- `groundingSources: { uri, title }[]` — the **specific URLs with titles** the LLM used to generate its answer (not just domains)
- `searchQueries: string[]` — the internal queries the LLM fired (related angles to cover)
- `competitorOverlap: string[]` — competitor domains cited alongside the query
- `matchedTerms: string[]` — which of the tracked keyword terms appeared in the answer

Plus the `competitors` table (`packages/db/src/schema.ts:32`), `competitorOverlap` / `recommendedCompetitors` on health snapshots (lines 68-69), and the intelligence package (`packages/intelligence/src/regressions.ts`, `gains.ts`, `causes.ts`) which already computes *why* citations move.

This is **URL-level competitive intel, not just domain-level.** Canonry knows not only "competitor-a.com is cited for [topic]," but "the LLM pulled from `competitor-a.com/guides/[topic]` with title X, and also searched for these related queries." **What's missing is turning that signal into "here's what to write next."**

This is the highest-leverage feature on the list, for two reasons:
1. AEO buyers ultimately want **outcomes** (more citations), not observation. Content is the lever that moves the metric.
2. It's the perfect agent-driven loop: canonry says what to write → agent (Claude Code / Codex / Aero) drafts it → user publishes → next sweep measures the impact. Closes the observation-to-action loop that incumbent paid AEO observability tools leave open.

**Product framing:** Canonry identifies **citation-driven content *opportunities*** and packages them as actionable briefs. The unit of value is a **recommended action on a specific page or query**, not a topic. Drafting is deliberately not the product — briefs are.

**New CLI commands (extend the manual-assist pattern from #2):**
- `canonry content gaps <project> [--provider <p>] --format json` — queries where competitors are cited but you're not. Pure DB query, no LLM.
- `canonry content sources <project> [--query "..."] [--competitor <domain>] --format json` — the grounding URLs the LLM used, grouped by query and cited domain. URL-level competitive map. Pure DB query, no LLM, no third-party fetch (canonry surfaces URLs; the agent decides whether to read them).
- `canonry content targets <project> [--sort score] [--limit N] [--include-in-progress] --format json` — **the ranked action-typed opportunity list.** Each row: `{query, action ∈ create|expand|refresh|add-schema, ourBestPage?, winningCompetitor, score, scoreBreakdown, drivers[], demandSource, actionConfidence, existingAction?}`. Deterministic scorer, additive two-branch (GSC demand + competitor evidence) so zero-GSC `create` opportunities still rank. No reasoning prose — auditable score breakdowns only.

  **Existing-action awareness:** if a target already has an in-flight action (`briefed`, `payload-generated`, `draft-created`, or `published-not-yet-validated`) for the same `(query, action, targetPage)` triple, the row carries `existingAction: { actionId, state, lastUpdated }`. **By default the CLI/UI hides these rows** (so users don't keep seeing work they already started); `--include-in-progress` includes them annotated. `dismissed` and `validated` actions never reappear by default; pass `--include-validated` for retrospection.

  **Classifier is AEO-first**, not SEO-first: AI citation status is checked before SEO rank. A page ranking #25 in Google but cited by an LLM is a *win* (`add-schema` to lock it in), not an `expand` candidate. SEO rank acts only as triage when AEO is failing.

  | Page state | Action |
  |---|---|
  | No page (or page ranks > 30) | `create` |
  | Cited by LLM, no schema | `add-schema` (lock in the win) |
  | Cited by LLM, has schema | skip (already winning) |
  | Not cited, ranks ≤ 10 in GSC | `refresh` (SEO works, AEO doesn't — restructure for LLM consumption) |
  | Not cited, ranks 11–30 in GSC | `expand` (thin/stale on both fronts) |

  `add-schema` fires only on first-party schema audit evidence (WordPress audit today; a generic `inspect-schema` HTTP fetch + JSON-LD parse can extend this universally later, ~50 LOC). Competitor-schema comparison is deferred until a retrieval layer exists.
- `canonry content brief <project> --target-ref <id> [--format json|md]` (preferred) **or** `--topic "<q>"` (exploratory, degraded) — **JSON canonical, structured brief with explicit known/unknown fields and an evidence ledger.** Markdown is a renderer of the JSON, never the source of truth (don't edit md and re-import). Single LLM call. Persisted to `contentBriefs` and assigned a stable `briefId`.

  **Two modes:**
  - **`--target-ref <id>` (evidence-grounded, default path):** the brief inherits the full scored context, evidence ledger, and confidence rating from `content targets`. `briefMode = 'evidence-grounded'`.
  - **`--topic "<q>"` (exploratory, degraded):** for queries the user has in mind that haven't yet ranked or been classified. The command first attempts to resolve the topic to an existing target — if a match exists, behaves identically to `--target-ref`. Otherwise emits an `briefMode = 'exploratory'` brief with `actionConfidence: 'low'`, an enlarged `unknownFields[]`, and an empty `evidenceLedger.gscEvidence`. The brief explicitly warns that it lacks ranking/citation grounding. **This is the only path to brief generation without an evidence-backed target — and it's marked as such.**

  **Action ledger integration:** generating a brief creates (or reuses) a tracked action in `content_actions` and returns its `actionId` alongside the `briefId`. The action is the durable unit; the brief is its first artifact. See "Content Action Outcome Ledger" below.

  `ContentBriefDto` shape:
  - **Lifecycle:** `briefId` (stable handle), `actionId` (the parent action — durable across the whole experiment), `targetRef` (nullable in exploratory mode), `sourceRunId` (the `runs.id` whose data backed this brief), `generatedAt` (ISO timestamp), `briefMode ∈ { 'evidence-grounded' | 'exploratory' }`
  - **Content:** `primaryQuery`, `secondaryQueries[]`, `pageType`, `searchIntent`, `recommendedAction`, `schemaRecommendation`
  - **`evidenceLedger`:** `{ winningCompetitorUrls[], gscEvidence, citationHistory }` — provenance for every claim; URLs/titles preserved byte-identical from `content sources`
  - **`knownFields`:** values derived from canonry's own data (counts, URLs, GSC stats, citation rates)
  - **`unknownFields[]`:** fields the LLM was instructed *not* to invent (e.g., `competitor_h2_structure`, `competitor_word_count`) — `null` with a `whyUnknown` reason rather than guessed. **Load-bearing anti-hallucination guarantee.**
  - **`acceptanceCriteria[]`:** measurable bars ("covers entities X, Y, Z", "includes FAQPage schema", "≥ 1500 words")
  - **`requiredSections[]`:** `[{ heading, mustCoverEntities[] }]`
  - **`risks[]`:** short labels ("competitor page is 5,000 words — depth match is significant", "highly contested SERP")
  - **`successMetric`:** `{ target, baseline, measuredBy }`

  **No drafting in canonry, ever.** Brief generation is the ceiling of canonry's content surface. See "Generation boundary" below.
- `canonry content publish-payload <project> --action-id <id> --content-file draft.md --target wordpress|ghost|next-mdx|generic [--format json]` — emits a `ContentPublishPayloadDto` keyed to a specific tracked action. The payload is tied to the action's brief, evidence ledger, sourceRunId, and recommendedAction; a payload generated against action v1 cannot be confused with one against action v2 even if the target query is unchanged. **Pure payload generation, no mutation.** Updates action state to `payload-generated`. Returns `{ actionId, briefId, target, execution: { method, url, headers, body }, metadata: { evidenceLedger, sourceRunId, generatedAt }, credentialHints, nextSteps, successValidation }`. See "Content Action Outcome Ledger" + "Generation boundary" + "Publish boundary" below.

**Composite API contract (up-front):** routes live in `packages/api-routes/src/content.ts`; scorer lives in `packages/intelligence/src/content-targets.ts`. CLI/UI/Aero all consume the same DTOs byte-for-byte.

| Route | DTO |
|---|---|
| `GET /projects/:name/content/gaps` | `ContentGapsResponseDto` |
| `GET /projects/:name/content/sources` | `ContentSourcesResponseDto` |
| `GET /projects/:name/content/targets` | `ContentTargetsResponseDto` (with `ContentTargetRowDto[]`) |
| `POST /projects/:name/content/briefs` | `ContentBriefDto` (creates/reuses action; returns `briefId` + `actionId`; idempotent by `(query, action, targetPage)`) |
| `POST /projects/:name/content/publish-payload` | `ContentPublishPayloadDto` (no mutation; updates action state to `payload-generated`) |
| `GET  /projects/:name/content/actions` | `ContentActionsResponseDto` — list tracked actions, filterable by state/action |
| `GET  /projects/:name/content/actions/:actionId` | `ContentActionDto` — single action + computed outcome |
| `POST /projects/:name/content/actions/:actionId/mark-published` | mutation: records `publishedUrl` + `publishedAt`; transitions to `published` |
| `POST /projects/:name/content/actions/:actionId/dismiss` | mutation: terminal state |
| `POST /projects/:name/wordpress/create-draft` | mutation: returns `WordpressDraftCreatedDto`; transitions action state to `published`. The only WP-touching mutation in the surface. |

**New Aero tools:**
- **Read-only, always-on** (DB reads): `get_content_gaps`, `get_grounding_sources`, `get_content_targets`, `list_content_actions` (filter by state/action), `get_content_action` (single action + outcome)
- **Write, explicit invocation:** `generate_content_brief` (spends LLM tokens; auto-creates the action), `dismiss_content_action` (terminal state change)

Drafting is deliberately *not* an Aero tool. `mark_published` is also intentionally CLI/API-only — agents typically don't know the user's published URL; that's a user-side fact.

**How competitor data drives recommendations:** competitor signal is the primary lever distinguishing canonry's content engine from generic SEO content tools. We use it four ways:

1. **Demand inference** — the `competitor_score` branch fires when GSC has zero impressions, so `create` opportunities still rank for queries Google doesn't yet recognize as demand. This is what unblocks the recommendation engine for early-stage / niche / emerging-topic queries.
2. **Page-type and intent inference** — competitor URL patterns and titles (`/compare/`, `/best-`, `/vs/`, `/guides/`, `/glossary/`) populate `pageType` and `searchIntent` in the brief without an LLM call.
3. **The evidence map (`winningCompetitorUrls[]`)** — every brief carries the exact competitor URLs + titles + citation counts the agent needs to read, beat, or differentiate against. Canonry surfaces; the agent fetches via its own WebFetch.
4. **Trend signals** — newly-appearing competitor citations (`recommendedCompetitors`, recent-run deltas) feed `recent_miss_rate` and surface as `drivers[]` (e.g., "competitor X gained citation in last 30 days"). Catches rising threats before they consolidate.

**What canonry never reads:** competitor *page bodies*. Only URLs, titles, citation patterns, and per-provider citation history. Body content is the agent's job (its WebFetch tool, its bandwidth, its rate-limit obligations). Keeps canonry firmly on the signal side.

**Content Action Outcome Ledger (V1):** every recommended action becomes a **tracked experiment** with a durable lifecycle and computed outcome. This is what turns canonry from "recommendation generator" into "recommendation system that learns from its own past advice." It is the foundation for future per-domain action ranking — *no ML required in v1*, just the data that would eventually feed it.

**The lifecycle states** (persisted in `content_actions` table):

```
proposed → briefed → payload-generated → draft-created → published → validated
                                                ↓             ↓
                                              published      (skip draft-
                                              (non-WP path:   created — was
                                              mark-published  always going
                                              or agent)       direct)
                                                ↓
                                          dismissed (terminal, any state)
```

`proposed` is optional (a user "claiming" a target before generating a brief); the common path begins at `briefed`. **`draft-created` is a WP-only intermediate state** — a WordPress draft is *not* published content; it's a draft sitting in WP admin awaiting user review. Non-WP paths skip it entirely (going directly `payload-generated → published` via `mark-published` or agent confirmation).

**Each action record carries:**
- **Identity:** `actionId` (stable handle), `projectId`, `query`, `action ∈ {create|expand|refresh|add-schema}`, `targetPage?` (nullable for `create` actions), `state`, `createdAt`, `updatedAt`
- **Promotion context:** `scoreAtPromotion`, `driversAtPromotion[]`, `sourceRunId` (the run whose data justified this action) — frozen at creation
- **Baseline (frozen at creation):** `baselineCitedRate`, `baselineProviderBreakdown`, `baselineGscStats { impressions, position, ctr }`, `baselineCompetitorOverlap[]`, **`baselineObservationSet { providers[], models[], locations[] }`** — the "before" snapshot, plus the exact observation surface that produced it
- **Lifecycle artifacts:** `briefId?`, `payloadGeneratedAt?`, **`wpDraftId?`, `wpDraftUrl?`, `draftCreatedAt?`** (WP only), `publishedUrl?`, `publishedAt?`, `dismissedAt?`, `dismissedReason?`
- **Outcome (computed lazily after publish, refined as more runs accumulate):** `outcomeResult ∈ {improved|unchanged|regressed|inconclusive}` + `firstMeasurement` (computed on first post-publish run) + full computed payload — see below

**Outcome computation** (pure given action + post-publish snapshots; lives in `intelligence/`):

```
// Comparison happens only over the intersection of baseline observation set
// AND post-publish observation set — like-for-like, never cross-category.
observationSet         = intersect(baselineObservationSet, postPublishObservationSet)

citationRateBefore     = baselineCitedRate over observationSet
citationRateAfter      = latest-run cited rate over observationSet
citationGained[]       = (provider, model) pairs where we became cited post-publish (within observationSet only)
citationLost[]         = (provider, model) pairs where we lost (within observationSet only)
providersImproved[]    = providers in observationSet with cited-rate increase
competitorDisplacement = competitors that lost share for this query post-publish
timeToFirstCitation    = days from publishedAt to first cited snapshot in observationSet
newEvidence[]          = providers/models/locations added AFTER publish — surfaced separately,
                          NOT folded into result (would be a category error)
result                 = 'improved' | 'unchanged' | 'regressed' | 'inconclusive'
```

**Validation threshold** (when `published → validated` fires): the transition only happens when ≥ **3 eligible post-publish runs** OR ≥ **14 days** have elapsed since `publishedAt` (whichever comes first). Until then, the action stays in `published` with `firstMeasurement` populated and `result = 'inconclusive'`. AI citation results are noisy; a single post-publish snapshot is not enough evidence to call an action validated — and the ledger is training data, so false positives would corrupt future per-domain ranking. Eligible runs are those whose observation set has non-empty intersection with `baselineObservationSet`.

**Idempotency contract:** at most one *in-progress* (non-`dismissed`, non-`validated`) action per `(projectId, query, action, targetPage)` triple. `content brief --target-ref <id>` creates a new action OR reuses an existing in-progress one for the same triple. Re-running `content targets` does not duplicate actions.

**New CLI commands for the ledger:**
- `canonry content actions <project> [--state ...] [--action ...] [--limit N] --format json` — list tracked actions; filter by lifecycle state and/or action type
- `canonry content action <project> <action-id> --format json` — single action, includes computed outcome if `published`
- `canonry content mark-published <project> --action-id <id> --url <published-url> [--published-at <iso-date>]` — explicit publish confirmation; transitions to `published`. Records URL + timestamp; does not mutate baseline or evidence.
- `canonry content dismiss <project> --action-id <id> [--reason <text>]` — terminal dismissal; excludes from future `content targets` ranking by default

**State transitions and the surrounding commands:**

| Command / signal | State transition | External mutation? | Determinism | Notes |
|---|---|---|---|---|
| `content brief --target-ref <id>` | `(none)` → `briefed` (creates action) **OR** reuses existing in-progress action | No (local ledger only) | Deterministic | Idempotent per `(query, action, targetPage)` |
| `content publish-payload --action-id <id>` | `briefed` → `payload-generated` | No (local ledger only) | Deterministic | Records `payloadGeneratedAt` |
| `wordpress create-draft --action-id <id>` | `payload-generated` → `draft-created` (WP only) | **Yes** (creates WP draft post) | Deterministic | Records `wpDraftId`, `wpDraftUrl`, `draftCreatedAt`. **Does not transition to `published`** — a WP draft is not published content, just a draft awaiting user review. Audit-logged. |
| WP poll detects `wpDraftId` status changed to `publish` | `draft-created` → `published` | No (canonry observing WP) | Deterministic | Only fires when WP API confirms the draft is now `status: publish`. Records `publishedUrl` + `publishedAt` from WP response. |
| Agent calls `content mark-published` as last workflow step | `payload-generated` → `published` | No (local ledger only) | Deterministic | Agent-mediated zero-friction path (Claude Code, Codex). Skips `draft-created` — non-WP path doesn't have a draft state. |
| `content mark-published --action-id <id>` (user-initiated) | `payload-generated` or `draft-created` → `published` | No (local ledger only) | Deterministic | Explicit fallback. From `draft-created`: confirms the WP draft was promoted to publish without waiting for poll. |
| Sitemap-inspection diff finds a new URL whose slug overlaps with the action's `primaryQuery` | (no state change — surfaces a candidate prompt) | No | **Heuristic — surfaces in dashboard for user confirmation, never auto-transitions** | Slug match alone cannot prove the new URL is the post we briefed. Dashboard shows "looks like you published X — confirm?" with one-tap yes/no. |
| `content dismiss --action-id <id>` | any → `dismissed` | No (local ledger only) | Deterministic | Terminal; excluded from default `content targets` ranking |
| (post-publish runs accumulate) | `published` → `validated` | No (local ledger only) | Deterministic (outcome) | **Threshold:** ≥3 eligible post-publish runs OR ≥14 days since `publishedAt`, whichever first. Eligible run = its observation set intersects `baselineObservationSet`. Until threshold, stays in `published` with `result = 'inconclusive'` and `firstMeasurement` populated. **Not a publish-detection signal** — outcome only fires once `publishedAt` is already set. |

**Detection vs verification (load-bearing distinction):** canonry does **not** verify that a published post matches the brief. We don't read user page bodies any more than we read competitor page bodies — the body-reading boundary holds for both. What canonry does:

- **Deterministic detection** (WP poll, agent-mediated, manual): records the URL with confidence
- **Heuristic candidate suggestion** (sitemap diff): surfaces "is this you?" in the dashboard, requires user confirmation
- **Outcome measurement** (citation appearance, displacement, time-to-first-citation): computed deterministically from snapshot history *after* publish is confirmed

What canonry does *not* do:
- ❌ Fetch the user's published URL and check entities
- ❌ Auto-mark `published` on slug match alone
- ❌ Treat citation appearance as evidence the user *published* (it's evidence of *outcome*, two different states)

The honest UX: WP and agent flows are zero-effort end-to-end; pure-manual users either tap a confirmation in the dashboard when canonry surfaces a candidate, or run `mark-published` explicitly. No persona is asked to "remember to come back to canonry."

**Why this matters (and why it's V1, not deferred):** without this ledger, canonry can generate good briefs but cannot answer "did `add-schema` work better than `expand` for this site?" With it, the next iteration of the ranker can weight action types by observed per-domain outcome — the foundation for learning, without ML in v1. Building the ledger AFTER actions are already shipping means losing the training data we'd most want.

**Generation boundary (the ladder):** every layer below has a single canonical artifact. Higher layers consume lower-layer output verbatim; canonry never invents to fill gaps. Each step is also a state transition in the action ledger above.

| # | Surface | Produces | Mutation? |
|---|---|---|---|
| 1 | `content targets` | Ranked actions (no prose) | none |
| 2 | `content sources` | Evidence map (URLs/titles/counts only) | none |
| 3 | `content brief --format json` | Canonical structured brief w/ evidence ledger | none |
| 4 | `content brief --format md` | Human-readable render of the JSON | none |
| 5 | (drafting) | **Out of scope. External agent only.** | n/a |
| 6 | `content publish-payload` | CMS-shaped payload, credential placeholders | none |
| 7 | `wordpress create-draft` | **Explicit external mutation** — creates WP draft post (`payload-generated → draft-created`); does **not** mark as published | yes (WP only) |
| 8 | WP poll OR `mark-published` | Records `publishedUrl` + `publishedAt`, transitions to `published` | no (canonry observes / records) |

**Drafting is explicitly not a canonry surface.** External agents fetch the brief's cited URLs (their own WebFetch / browser tool / rate-limit obligations), produce the draft, and either commit it to the user's repo or hand it back to canonry's payload/mutation layers. This boundary is what prevents canonry from hallucinating source material it never fetched. The brief's `unknownFields[]` makes this contract enforceable per-field.

**Mutation gate — two layers, not one:**

- **External mutation** (writes to systems outside canonry): `wordpress create-draft` is the **only** command in the content surface that touches external state. Renamed from `publish-draft` to make this explicit. WP-only, gated, audit-logged via existing audit-log infrastructure.
- **Local ledger mutation** (writes to canonry's own DB): `content brief`, `content publish-payload`, `content mark-published`, `content dismiss` all create or transition rows in the `content_actions` and `contentBriefs` tables. These are not external mutations — they're durable lifecycle tracking inside canonry.

The boundary canonry preserves is "no silent external mutation." Internal ledger writes are how the system stays accountable to the user, not a violation of the boundary. Conflating the two would either let canonry silently mutate external systems (bad) or stop tracking the recommendation lifecycle entirely (also bad).

**Publish boundary — transformers, not adapters:** the agent takes a brief + draft and publishes. Canonry's role ends at **preparing a CMS-shaped payload**; the agent calls the CMS's API with its own credentials.

- **Transformers are pure functions** in a new `packages/publish-transformers/`: `(brief, draft, targetMeta) → ContentPublishPayloadDto`. No HTTP, no auth, no runtime deps. 100% unit-testable. Ship `wordpress`, `ghost`, `next-mdx`, `generic` at launch; add Webflow/Hugo/Sanity/Contentful on user demand.
- **WordPress stays as the one full adapter.** `integration-wordpress/` already owns auth + live execution + audit. `canonry wordpress create-draft` (the mutation gate, see "Generation boundary" above) is a thin wrapper: run the WP transformer → call the existing `createPage({status: 'draft'})`. Earns its keep because the target audience (solo AEO analysts, SEO consultants, in-house SEO) has heavy WP overlap. **Gutenberg quirk:** WP's block editor auto-converts pasted markdown, so the WP transformer can emit minimal block JSON + a `core/html` fallback and let Gutenberg do the rest — dramatically shrinks the transformer's surface.
- **Other CMSes: transformer only.** Agent substitutes credentials from its env (placeholders like `${GHOST_ADMIN_KEY}` in the payload) and executes the HTTP call itself. Canonry never sees non-WP secrets.
- **No adapter maintenance treadmill.** The agent already has HTTP + credential resolution; canonry adding a live client per CMS duplicates that work and exposes us to auth/rate-limit/API-drift churn.

**Why this is the right boundary:** aligns 1:1 with AGENTS.md ("canonry surfaces, agent acts"). Keeps canonry's unique value concentrated on what only it can do — producing CMS-shaped payloads from the brief schema, page type, and metadata. Research confirmed no off-the-shelf library covers this space (Micropub has limited CMS coverage — no Ghost/Webflow/core-WP; headless-CMS libraries like Contentlayer face inward to the user's own site); composing `remark`/`rehype` + per-target transformers (~100–150 LOC each) is the right build.

**Demo synergy:** `canonry demo` and the hosted sandbox should highlight this loop. "Watch canonry tell you exactly what blog post to write next based on what your competitors are getting cited for" is a much stronger demo moment than a static dashboard tour. Bake this into the Wave 1 demo script.

**Why this is a GTM differentiator:**
- Incumbent paid AEO tools observe; they don't generate. This closes the loop.
- URL-level grounding-source intel is a signal most AEO tools don't expose — "here's the exact page your competitor wrote that earned the citation" beats "your competitor is cited more than you."
- Aligns 1:1 with the agent-first thesis: agents are excellent at writing; canonry is excellent at signal. Don't blur the lines.
- Has SEO value beyond AEO — the same gap analysis helps with traditional Google search.
- Creates a measurable feedback loop: "you wrote this; here's what happened to your citations next sweep" — a unique data story competitors can't tell.

---

## Critical additions the audit surfaced

### 4. Demo mode / no-API-key experience (HIGH GTM IMPACT)

Today users must bring Gemini/OpenAI/Claude keys *before* seeing anything. Huge funnel drop.

- **`canonry demo`** — installs a sample project (e.g. a generic SaaS company tracking a payment-processing topic) with pre-recorded snapshots, fake citations, populated insights. Users see the dashboard before paying any provider cost.
- **Hosted sandbox** at a public URL — read-only public dashboard so prospects click around without installing. Same data as `canonry demo`.
- **`packages/provider-mock/`** — deterministic replayable provider for CI, demos, and offline dev. Half-implied by `provider-local`; formalize it.

### 5. Credential encryption at rest — full scope (BLOCKER for paid/business users)

Plaintext-in-`~/.canonry/config.yaml` covers far more than provider keys. Buyer-blocking surface area in `packages/canonry/src/config.ts`:

- `apiKey` — local server bearer token (line 101)
- `providers[].apiKey` — every provider key (line 10)
- `providers[].vertexCredentials` — service-account JSON path (line 19)
- `google.clientSecret` (line 43) + `google.connections[].accessToken` / `refreshToken` (lines 33-34)
- `bing.apiKey` and `bing.connections[].apiKey` (lines 49, 56)
- `ga4.connections[].privateKey` — GA4 service-account private key (line 64)
- `wordpress.connections[].appPassword` — explicitly called out as plaintext at `docs/wordpress-setup.md:71`

Wave 0 must cover **all** of the above, not just a "provider keys + Google OAuth" subset. A partial migration leaves the most embarrassing vectors (GA4 private keys, WordPress app passwords) exposed.

- OS keychain via `keytar` (macOS Keychain, Linux libsecret, Windows Credential Manager).
- Config.yaml keeps references (e.g. `apiKey: keychain:wordpress:mysite-app-password`), not secrets.
- Upgrade migration: scan all known secret fields, move to keychain, redact yaml. Idempotent; safe across re-runs.
- Per-secret-type tests so future fields can't slip back into plaintext.

### 6. CLI/API contract hardening — the agent surface itself

The agent-first promise lives or dies on CLI/API predictability. Audit should confirm **every** command and endpoint meets the contract in AGENTS.md.

- Every command supports `--format json` — write a test that asserts this for all commands in `packages/canonry/src/commands/`.
- JSON errors to stderr with stable `code` fields; exit codes follow 0/1/2.
- Composite read endpoints for common questions (AGENTS.md already documents `/projects/:name/runs/latest` and `/projects/:name/search?q=term` — verify they exist and are exercised).
- Publish an **agent-targeted changelog** that highlights breaking CLI/API changes explicitly. Regular changelog buries them.
- Record every new command/endpoint as "agent-safe" in a machine-readable manifest (simple JSON) so agents can discover surface at runtime.

### 6a. Agent-docs accuracy audit (BLOCKER for "any agent fast" pitch)

Shipped agent guidance is stale enough that an agent following it hits dead ends. The most visible: `canonry timeline` is referenced in `packages/canonry/assets/agent-workspace/AGENTS.md:32,64` and `skills/aero/references/memory-patterns.md:28`, but it is not a registered CLI command (verified — no match in `packages/canonry/src/cli-commands.ts` or `packages/canonry/src/cli-commands/*.ts`). An agent told to run `canonry timeline` gets "command not found." That alone breaks the GTM pitch on day one.

- Cross-reference every CLI invocation in `packages/canonry/assets/agent-workspace/`, `skills/aero/`, and `skills/canonry-setup/` against the registered command list. Fail-fast in CI.
- Either ship the missing commands (`timeline` is the obvious one — there's already a `/timeline` API route the UI uses) or update every doc that references them.
- Add a CI lint that greps doc files for `canonry <verb>` invocations and asserts each one is registered.
- This is **Wave 0**, not polish: the agent-first story dies if the docs are wrong.

### 7. Marketing surface

Only a GitHub README today. `ainyc.ai` is referenced but there's no landing, no docs site. **GTM marketing site lives at `canonry.ai`** (separate from `ainyc.ai` which remains the telemetry/backend domain).

- Landing page at `canonry.ai`: positioning, one-line install, categorical comparison vs incumbent paid AEO observability tools and SEO-suite AEO add-ons (no per-vendor name-and-shame).
- **"How to use canonry with Claude Code, Codex, Hermes, OpenClaw"** — dedicated pages per agent. This is the distribution story.
- "Compete vs X" SEO pages — eat branded search.
- 90-second Loom showing agent-driven workflow end-to-end, leading with the content-loop demo (#3a).
- Discord or GitHub Discussions for community.

### 8. Onboarding analytics

Telemetry exists (`https://ainyc.ai/api/telemetry` — backend stays on ainyc.ai; marketing moves to canonry.ai), no funnel dashboard. Without it you'll iterate blind.

- Instrument: `init_started`, `init_provider_added`, `init_completed`, `first_project_created`, `first_run_completed`, `first_insight_viewed`, `skill_installed`, `agent_external_used_cli` (detect via CLI invocation heuristics / env var).
- Build the dashboard before launch.

### 9. Polish blockers from the audit

Would embarrass, not block:
- Migration robustness (`packages/db/src/migrate.ts` silently swallows duplicate column errors).
- Provider error wrapping (raw 429s leaking into snapshots).
- Empty/loading states (skeletons, TanStack Query states).
- Troubleshooting + FAQ docs (none exist).
- Node version mismatch (README ≥22.14, Dockerfile 20).

---

## Wave Sequencing

### Wave 0 — Content engine (start here) + launch hardening — 2–3 weeks

Content is the lead investment. It's the differentiator, the demo headliner, and the feature that closes the loop from observation to outcome. Everything else in Wave 0 is supporting hardening that runs in parallel.

**Lead — content engine (#3a, full scope):**

*PR 1 — deterministic read layer (no LLM, no persistence):*
- **`canonry content gaps / sources / targets`** — DB-only reads; `targets` is the ranked action-typed opportunity list (additive two-branch scorer so `create` opportunities with zero GSC still rank).
- **Contracts:** `ContentTargetRowDto` + response DTOs in `packages/contracts/src/content.ts` (canonical for CLI + API + UI).
- **API routes:** `/projects/:name/content/{gaps,sources,targets}` — composite reads so agents never client-side-join.
- **Scorer + action classifier:** `packages/intelligence/src/content-targets.ts` — pure function, unit-tested with fixture snapshots.
- **Aero read tools:** `get_content_gaps`, `get_grounding_sources`, `get_content_targets`.

*PR 3 — brief + transformers + publish loop:*
- **`canonry content brief --target-ref <id>`** — structured JSON (canonical) with markdown renderer. Single LLM call. `POST /content/briefs` idempotent by `(query, action, targetPage)`. **Auto-creates / reuses a tracked action** (see ledger below); returns `{ briefId, actionId, ... }`.
- **`canonry content publish-payload --action-id <id>`** — emits `ContentPublishPayloadDto`; ships `wordpress`, `ghost`, `next-mdx`, `generic` transformers at launch. **Pure payload generation, no mutation.** Transitions action state to `payload-generated`.
- **`canonry wordpress create-draft --action-id <id>`** — **explicit external mutation**: runs the WP transformer + calls existing `createPage({status:'draft'})`. Records `wpDraftId`, `wpDraftUrl`, `draftCreatedAt` on the action; transitions state to **`draft-created`** (NOT `published` — a WP draft is awaiting user review, not yet live). Audit-logged. WP poll then watches the draft for status change to `publish`, transitioning to `published` only at that point.
- **`canonry content actions / action / mark-published / dismiss`** — action ledger CLI surface (see "Content Action Outcome Ledger" in §3a).
- **Content Action Outcome Ledger** — new `content_actions` table + state machine + outcome computation (lazy, post-publish). The durable lifecycle is the unit of value, not just the brief.
- **Aero write tool:** `generate_content_brief`, `dismiss_content_action`. Plus read tools: `list_content_actions`, `get_content_action`.
- **New package:** `packages/publish-transformers/` — pure per-target transformers (`remark`/`rehype`-backed), no runtime deps.
- **Persistence:** `contentBriefs` table (artifacts) + `content_actions` table (durable lifecycle) + outcome computation in `packages/intelligence/src/content-outcomes.ts`.

*PR 2 — UI surfacing (moves to Wave 1 under content surfacing below).*

*Demo fixtures highlight the content loop* — sample project's `canonry demo` data shows "competitor wins query X via URL Y → here's the action-typed target → here's the brief → agent publishes via transformer payload" end-to-end.

**Parallel — launch hardening:**
- **Credential encryption — full secret scope** (#5): provider keys, Vertex creds, Google OAuth + tokens, Bing keys, GA4 private keys, WordPress app passwords, local API key.
- **Agent-docs accuracy audit + CI lint** (#6a): fix `canonry timeline` references and any other dead invocations; ship the `timeline` CLI wrapper around the existing API route; add the lint.
- **`canonry demo` + sample fixtures + mock provider** (#4): "see value before keys"; demo data wired to showcase the content loop end-to-end.
- Migration robustness fix (#9).
- CLI/API contract audit: every command `--format json`, consistent errors, exit codes (#6).
- Minimal troubleshooting doc.

### Wave 1 — Onboarding & distribution — 2–4 weeks

- **Extend the existing `/setup` wizard** (#1, Path A): inline provider step before system check, integrations step (GSC/GA4/Bing/WordPress), final "Connect your AI editor" step.
- **Persistent setup checklist** independent of the one-shot wizard (since `routes.tsx:108-113` redirects users away once a project exists) (#1, Path A).
- **Content surfacing in the dashboard** (content engine PR 2) — gaps/sources/targets results visible in the project page, consuming the same DTOs as the CLI. Action-type filters (`create|expand|refresh|add-schema`) and score-driver chips. Same UI/CLI parity rule as the rest of the dashboard.
- **Empty-state polish** sweep across remaining dashboard views (#1, Path A).
- `canonry skill install --for <agent>` + agent-guide doc surface (#1, Path B) — backs the UI panel and the CLI path.
- `canonry init` detects + recommends agent integration (#1, Path B).
- **Hosted demo sandbox** at a `canonry.ai` subdomain — public read-only dashboard with the content-loop fixtures.
- "Using canonry with Claude Code, Codex, Hermes, OpenClaw" docs (#1, #7).
- Homebrew tap (#3).
- Verified `npx @ainyc/canonry init` zero-install path (#3).
- Landing page at `canonry.ai` with agent-workflow demo video — **lead with the content loop** (#7).
- Onboarding telemetry events + funnel dashboard (#8).

### Wave 2 — Polish & expansion — 4–8 weeks

- `canonry fix` commands extending the WordPress manual-assist pattern, HTML + Next.js first (#2).
- macOS .pkg installer (#3).
- Additional `--framework` emitters (Astro, Hugo) (#2).
- "Compete vs X" SEO pages (#7).

### Deferred

- Tauri desktop GUI
- GitHub App for users without an agent
- Multi-tenant SaaS / Stripe
- Aero-specific polish — it works; investing here doesn't move GTM

---

## Success Metrics

Track against a funnel dashboard powered by `packages/canonry/src/telemetry.ts`:

- Install count (npm + Homebrew + .pkg).
- `init_completed` rate (vs `init_started`).
- `first_run_completed` rate (vs `init_completed`).
- `skill_installed` rate (which agent breakdown).
- `content_action_promoted` rate — first time a target is brought into the ledger (when brief is generated).
- `content_brief_generated` rate (per-action; one event per brief artifact).
- `content_publish_payload_generated` rate (agent-driven publish flows).
- `wp_draft_created` rate (WP-specific mutation; transitions to `draft-created`).
- `wp_draft_published` rate (WP poll detects draft → publish; transitions to `published`).
- `content_published_marked` rate — explicit user confirmation via `mark-published`.
- `content_action_first_measured` rate — first post-publish run with eligible snapshot data; `firstMeasurement` populated, `result` still `inconclusive`.
- `content_action_validated` rate — outcome reached the validation threshold (≥3 eligible runs OR ≥14 days); `result` resolved.
- `content_action_dismissed` rate.
- `external_publish_confirmed` rate — derived from transitions into `published` state. **Confirmation paths, ordered by determinism:**
  - **Deterministic auto (two-step for WP):** `wordpress create-draft` transitions action to `draft-created` (not `published`). WP poll watches the draft's `wpDraftId` for `status: publish`. When it flips, action transitions to `published`. Two distinct events: `wp_draft_created` and `wp_draft_published`.
  - **Deterministic agent-mediated** — agent (Claude Code, Codex) calls `canonry content mark-published` as the last step of its workflow. Skips the WP draft state for non-WP flows.
  - **Deterministic manual** — user runs `canonry content mark-published --url <u>` (or clicks the equivalent in the dashboard).
  - **Heuristic candidate (NOT auto-confirm)** — sitemap-inspection diff finds a new URL with slug overlap to the action's `primaryQuery`. Surfaces in the dashboard as "looks like you published X — confirm?" Requires one-tap user confirmation; never transitions state on its own. Slug match alone cannot prove the URL is the post we briefed.

  **Outcome confirmation is a separate signal** — citation appearance in `groundingSources` is OUTCOME evidence (`published → validated`), not publish evidence. It only fires once `publishedAt` is already set via one of the paths above.

  v1 ships the WP-auto, agent-mediated, and manual paths. The heuristic candidate UI lands once site-inventory diffing is wired up (PR 1 inventory layer feeds this). Outcome computation lands in PR 3.
- **Per-action-type outcome rates** — `improved | unchanged | regressed | inconclusive` rates broken down by `action ∈ {create|expand|refresh|add-schema}`. The training data for future per-domain ranker improvements.
- 7-day retention on dashboard.
- Demo → install conversion (hosted sandbox to local install).

## Go/No-Go Criteria

### Wave 0 ship gate
- [ ] All `canonry content` subcommands ship with `--format json` parity and tests.
- [ ] **`ContentBriefDto` JSON schema exists in `packages/contracts/` before any prompt-template work begins** (schema-first, prompt-second).
- [ ] **Every generated brief includes a populated `evidenceLedger` with provenance for each grounded field.**
- [ ] **`unknownFields[]` is non-empty whenever any LLM-inferable field could not be grounded; tests assert no inferred values leak into `knownFields`.**
- [ ] **Tests assert grounding URLs + titles survive byte-identical from `content sources` → `content brief.evidenceLedger` → `content publish-payload.metadata.evidenceLedger`.** Body content may be transformed (markdown links, HTML encoding); the structured-metadata ledger is the preservation contract.
- [ ] **`wordpress create-draft` is the only command that mutates *external* systems (WP API write); test via a network-call interceptor that no other content command opens an outbound HTTP socket to a CMS.** All other lifecycle commands (`brief`, `publish-payload`, `mark-published`, `dismiss`) mutate only canonry's local ledger (DB rows in `content_actions` / `contentBriefs`).
- [ ] **`content_actions` table exists with all required columns**: identity, baseline (frozen at creation), promotion context, lifecycle artifacts, outcome (lazy).
- [ ] **Idempotency test passes:** generating a brief twice for the same `(query, action, targetPage)` reuses the existing in-progress action; re-running `content targets` does not duplicate in-progress actions.
- [ ] **`mark-published` records URL + timestamp without modifying baseline, evidenceLedger, scoreAtPromotion, or driversAtPromotion** (test via diff of action record before/after).
- [ ] **State machine precision:** `wordpress create-draft` transitions to `draft-created`, never directly to `published`. WP poll detecting `status: publish` (or `mark-published`) is the only path from `draft-created` to `published`. Test asserts these transitions in isolation.
- [ ] **Validation threshold enforced:** `published → validated` only fires after ≥3 eligible post-publish runs OR ≥14 days. Test fixture verifies that 1 post-publish run leaves the action in `published` with `result='inconclusive'` + `firstMeasurement` populated; 3 runs (or 14d) transitions it to `validated` with full result.
- [ ] **Observation-set scoping:** baseline records `baselineObservationSet { providers, models, locations }`. Outcome compares like-for-like only; providers/models/locations added after publish are surfaced in `newEvidence[]` separately, not folded into the result. Test fixture covers both cases.
- [ ] **Outcome computation test:** given an action in `published` state and a fixture run dated after `publishedAt` with snapshot data, `firstMeasurement` and `outcomeResult` are populated correctly. After threshold, action transitions to `validated`.
- [ ] **`content targets` hides in-progress actions by default:** test asserts a query with an existing `briefed` action does not appear in the default `content targets` response, but appears with `existingAction: { state: 'briefed', ... }` when `--include-in-progress` is passed.
- [ ] **Dismissed actions are excluded from `content targets` default ranking** (assertable in fixture test).
- [ ] Telemetry distinguishes the full action-lifecycle events: `content_action_promoted`, `brief_generated`, `publish_payload_generated`, `wp_draft_created`, `content_published_marked`, `content_action_validated`, `content_action_dismissed`, `external_publish_confirmed` — distinct events, not collapsed.
- [ ] All seven secret types in `config.ts` migrated to keychain. Zero plaintext secrets in fresh `~/.canonry/config.yaml`.
- [ ] CI lint asserts every doc-referenced `canonry <verb>` invocation is registered. `canonry timeline` ships or all references removed.
- [ ] `canonry demo` boots a working sample project with content-loop data on a clean machine in under 60 seconds.
- [ ] CLI contract test passes: every command exposes `--format json`, follows 0/1/2 exit codes, structured stderr errors.

### Wave 1 ship gate
- [ ] `/setup` wizard covers provider, integrations, agent-connect.
- [ ] Persistent setup checklist surfaces post-redirect.
- [ ] Content gaps/sources/targets visible in dashboard with API/CLI parity.
- [ ] `canonry skill install` works for Claude Code, Codex, Hermes, OpenClaw.
- [ ] Hosted sandbox live at canonry.ai subdomain with demo fixtures.
- [ ] Landing page at canonry.ai with content-loop demo video.
- [ ] Telemetry funnel dashboard live and capturing all instrumented events.

### Wave 2 ship gate
- [ ] `canonry fix` supports schema/llms-txt/meta for HTML + Next.js + WordPress.
- [ ] macOS .pkg installer signed, notarized, and downloadable from canonry.ai.

---

## Per-Agent Distribution Plan

### Claude Code

- **Install:** `canonry skill install --for claude-code` drops skill into `~/.claude/skills/`.
- **Example prompt:** "Use canonry to find queries where my competitors are cited but I'm not, then write a brief for the highest-priority topic."
- **Expected workflow:** `canonry content targets --sort score --limit 5 --format json` (defaults hide already-in-progress actions) → pick a `targetRef` → `canonry content brief --target-ref <id> --format json` (returns `briefId` + `actionId`; action now `briefed`) → Claude Code fetches the brief's `evidenceLedger.winningCompetitorUrls` via WebFetch, drafts the post in the user's repo → `canonry content publish-payload --action-id <id> --content-file draft.md --target wordpress|next-mdx|...` (action now `payload-generated`) → agent applies the payload, then either:
  - **WP users:** `canonry wordpress create-draft --action-id <id>` → action `draft-created` (WP draft sits in admin awaiting user review). User publishes in WP. Canonry polls and auto-transitions to `published`. **Or** the agent calls `canonry content mark-published` to skip the polling delay.
  - **Other:** `canonry content mark-published --action-id <id> --url <published-url>` → action `published`.

  After publish: each subsequent `canonry run` accumulates evidence. After ≥3 eligible runs OR ≥14 days, action auto-transitions `published → validated` with computed outcome (`improved | unchanged | regressed | inconclusive`). Until then, `firstMeasurement` populated and `result = 'inconclusive'`.

### Codex

- **Install:** `canonry skill install --for codex` writes Codex-format config.
- **Example prompt:** "Audit this site against canonry's latest sweep and apply schema fixes."
- **Expected workflow:** `canonry insights list --format json` → Codex picks issues → `canonry fix schema --page <url> --format patch` → Codex applies patch in repo → re-run.

### Hermes

- **Install:** `canonry skill install --for hermes` writes Hermes-format guidance.
- **Example prompt:** "Plan a content roadmap based on canonry's competitive intel for this domain."
- **Expected workflow:** `canonry content targets --sort score --limit 10 --format json` → Hermes synthesizes editorial calendar → user approves → Hermes drives `canonry content brief --target-ref <id>` per target and drafts into the user's repo.

### OpenClaw

- **Install:** `canonry skill install --for openclaw` writes OpenClaw skill bundle.
- **Example prompt:** "Set up canonry for example.com and run the first sweep."
- **Expected workflow:** OpenClaw drives `canonry init` → `canonry project create` → `canonry keyword add` → `canonry run` → `canonry insights list` end-to-end.

### Generic fallback

- **Install:** `canonry agent-guide` prints a markdown brief any agent can ingest.
- **Example prompt:** "Read this canonry CLI guide and use it to analyze citation gaps for example.com."
- **Expected workflow:** Agent reads the guide, drives the CLI directly using `--format json` for every read.

---

## Critical files for the implementation waves

| Wave | Area | Files |
|------|------|-------|
| 0 (lead, PR 1) | Content targets + gaps + sources (read layer) | new `packages/contracts/src/content.ts` (`ContentTargetRowDto`, `ContentTargetsResponseDto`, `ContentGapsResponseDto`, `ContentSourcesResponseDto`); new `packages/intelligence/src/content-targets.ts` (scorer + action classifier, pure); new `packages/api-routes/src/content.ts` (composite `/content/{gaps,sources,targets}` routes); new `packages/canonry/src/commands/content.ts` + `cli-commands/content.ts`; new Aero read tools in `packages/canonry/src/agent/tools.ts`; reads `groundingSources` + `competitorOverlap` via `rawResponse`, `gscSearchData`, `gaTrafficSnapshots` (per-page organic only — no per-page AI, see note), project-level `gaAiReferrals` |
| 0 (lead, PR 3) | Content brief + publish transformers + **action ledger** | extend `packages/canonry/src/commands/content.ts` (brief, publish-payload, actions, action, mark-published, dismiss subcommands); new `packages/intelligence/src/content-prompts.ts` (must include `unknownFields` discipline); new `packages/intelligence/src/content-outcomes.ts` (pure outcome computation); **new `packages/publish-transformers/` package** with `wordpress`, `ghost`, `next-mdx`, `generic` transformers; **new `contentBriefs` + `content_actions` tables + migrations** (see DB rules in `AGENTS.md`); extend `packages/canonry/src/agent/tools.ts` with `generate_content_brief`, `list_content_actions`, `get_content_action`, `dismiss_content_action`; new `canonry wordpress create-draft` mutation command (renamed from `publish-draft`) wraps the WP transformer + existing `createPage()` in `packages/integration-wordpress/src/wordpress-client.ts`, audit-logged, transitions action state |
| 0 | Credential encryption | `packages/canonry/src/config.ts` (all secret fields lines 10, 19, 33-34, 43, 49, 56, 64, 80, 101), `packages/canonry/src/commands/init.ts`, new `packages/canonry/src/keychain.ts`, migration in `packages/canonry/src/config-migrate.ts` |
| 0 | Agent-docs accuracy | `packages/canonry/assets/agent-workspace/AGENTS.md`, `skills/aero/references/memory-patterns.md`, `skills/canonry-setup/`, new CI lint comparing doc invocations to `packages/canonry/src/cli-commands.ts` |
| 0 | `canonry timeline` CLI wrapper | new `packages/canonry/src/commands/timeline.ts` wrapping the existing `/timeline` API route, register in `packages/canonry/src/cli-commands/run.ts` (or new `cli-commands/timeline.ts`) |
| 0 | Demo mode (highlights content loop) | new `packages/canonry/src/commands/demo.ts`, new `packages/canonry/fixtures/demo-project/` (with grounding-source data wired for the content demo), new `packages/provider-mock/` |
| 0 | Migration fix | `packages/db/src/migrate.ts` |
| 0 | CLI contract audit | new `packages/canonry/test/cli-contract.test.ts`, all `packages/canonry/src/commands/*.ts` |
| 1 | UI wizard extensions | extend `apps/web/src/pages/SetupPage.tsx` (add provider step, integrations step, agent-connect step), update step labels in `SETUP_STEPS` (line 21) |
| 1 | UI content surfacing | new `apps/web/src/components/project/ContentGapsSection.tsx`, `ContentSourcesSection.tsx`, `ContentSuggestionsSection.tsx`; consume the same API endpoints the CLI hits |
| 1 | UI persistent setup checklist | new `apps/web/src/components/shared/SetupChecklist.tsx`, surface in topbar/sidebar; reuse `buildSetupModel` from `health-helpers.ts` |
| 1 | UI empty-state sweep | extend pattern from `build-dashboard.ts:1167-1174` to insights / runs / GSC / analytics / content views |
| 1 | Skill install (CLI) | new `packages/canonry/src/commands/skill.ts`, existing `skills/canonry-setup/` |
| 1 | Agent-guide surface (CLI) | new `packages/canonry/src/commands/agent-guide.ts` (prints compact markdown) |
| 1 | Init handoff (CLI) | `packages/canonry/src/commands/init.ts` |
| 1 | Hosted demo sandbox | new ops/deployment for a public read-only canonry instance at a `canonry.ai` subdomain using the same fixtures as `canonry demo` |
| 1 | Homebrew | new `homebrew-tap` repo + formula referencing the npm tarball |
| 1 | Telemetry events | `packages/canonry/src/telemetry.ts` (server) + new instrumentation in `apps/web/src/pages/SetupPage.tsx` |
| 2 | Fix commands | new `packages/canonry/src/commands/fix.ts`, generalize `packages/integration-wordpress/src/schema-templates.ts` into a framework-agnostic emitter (in-place or new `packages/site-emitters/`); start with `--framework html|next` |

---

## Relationship to other docs

- **`docs/roadmap.md`** — feature-level product priority (stays canonical for what to build). This doc is the launch view.
- **`docs/architecture.md`** — current system topology.
- **`AGENTS.md` (root)** — agent-first contract, surface priority, UI/CLI parity rules. This GTM plan operationalizes those rules.
