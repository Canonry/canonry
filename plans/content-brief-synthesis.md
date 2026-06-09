# Content Briefs: Winnability Gate and LLM Brief Synthesis

## Context

canonry already surfaces content opportunities deterministically. `@ainyc/canonry-intelligence` builds three row sets from a single `OrchestratorInput`:

- `buildContentTargetRows` (`packages/intelligence/src/content-targets.ts:107`): per-query targets with `demandSource`, a `ContentAction`, action confidence, and the winning competitor.
- `buildContentGapRows`: queries only competitors are cited for.
- `buildContentSourceRows`: the cited-source breakdown.

A narrow LLM layer already exists on top. `POST /projects/:name/content/recommendations/:targetRef/analyze` (`packages/api-routes/src/content.ts`) calls an injected `ExplainContentRecommendationFn`, implemented by `createRecommendationExplainer` (`packages/canonry/src/agent/recommendation-explainer.ts`). It uses pi-ai `complete()` at the `analyze` capability tier, is multi-provider, and caches by `(projectId, targetRef, promptVersion)` in `recommendation_explanations` (`packages/db/src/schema.ts:830`). Its system prompt explains, in 3 to 5 bullets and under 600 characters, why a single target matters.

Two gaps separate that output from a content brief an operator can act on:

1. **No winnability signal.** A target whose cited surface is owned by aggregators or editorial media (a head term the site cannot realistically win with its own content) is presented the same as a differentiated query the site can own. Operators make that call by hand today. The signal already exists but is siloed: discovery classifies every recurring cited domain as `direct-competitor | ota-aggregator | editorial-media | other | unknown` (prompt at `packages/canonry/src/discovery-run.ts:281`; OTAs and booking or review platforms are explicitly `ota-aggregator`, listicles and blogs `editorial-media`). content-targets only consumes `competitorDomains`, so it knows "a competitor is cited" but not "the surface is an aggregator we should not chase."
2. **Explain, not brief.** The LLM layer explains why a target matters. It does not synthesize the brief: the angle, the why-winnable rationale, and the schema or markup hookup.

Net: the judgment "defend the ownable queries, do not chase the ceded head terms" plus the brief itself happen manually, outside the tool.

## Goal

Two surgical extensions that keep determinism deciding **what** and the LLM deciding only **how to write**:

1. A deterministic `winnabilityClass` (ownable vs ceded) on every content target, reusing the discovery classifier. No new LLM calls.
2. A `brief` mode on the existing content explainer that synthesizes a structured brief, reusing the same provider plumbing, capability tier, and prompt-version cache, gated to ownable targets.

## Non-goals

- No new provider or LLM plumbing. Reuse the `recommendation-explainer.ts` pattern.
- The LLM never invents targets. It only renders briefs for targets the deterministic layer already surfaced and gated.
- No content is published. The output is a brief; a human acts on it.

## Plan

### Step 1: Make the domain classification queryable per domain

The classifier result is written into the discovery session `competitor_map` (`packages/api-routes/src/discovery/orchestrate.ts`), keyed to a session, not to a `(project, domain)` lookup. content-targets runs on every report and sweep and cannot run a discovery probe, so it needs a cheap per-domain lookup. Two options:

- **1a (no migration):** read the latest `completed` discovery session for the project and index its `competitor_map` by domain. Simplest, but the gate only works once discovery has run, and it reflects the last session's view.
- **1b (small migration, preferred):** add a `domain_classifications` table keyed by `(projectId, domain)` carrying the latest `competitorType` plus provenance (`sessionId`, `classifiedAt`). Upsert it when a discovery session completes in `orchestrate.ts`. Decoupled from session retention and cheap to join.

Recommend 1b. Either way, treat missing or stale classifications as `unknown` (see the Step 2 fail-open rule).

### Step 2: winnabilityClass gate on content targets (deterministic, the moat)

- `packages/intelligence/src/content-targets.ts`: in `buildContentTargetRows`, look up the class of the domains actually cited for each query (from Step 1) and derive:
  - cited surface dominated by `ota-aggregator` or `editorial-media` gives `winnabilityClass: 'ceded'`.
  - cited surface that is `direct-competitor`, the own domain, `other`, `unknown`, or has no citation gives `winnabilityClass: 'ownable'` (fail open: when in doubt, it is worth a brief).
  - "Dominated" means the combined aggregator and editorial share of the cited domains for that query crosses a documented threshold. Start conservative, for example a majority, and unit-test the boundary.
- Add `winnabilityClass: 'ownable' | 'ceded'` (and optionally a numeric `winnability`) to `ContentTargetRowDto` (`packages/contracts/src/content.ts`).
- `GET /projects/:name/content/targets` gains an optional `winnabilityClass` filter; default ordering surfaces `ownable` first.
- This is a pure data join over existing inputs. No LLM, no new external calls.

### Step 3: brief mode on the content explainer (LLM synthesis, reuse plumbing)

- `packages/canonry/src/agent/recommendation-explainer.ts`: add a brief template and a structured-output path beside the existing explainer. Keep the same `complete()` call, `analyze` tier, provider and api-key resolution, and cache-key shape. Add a separate `RECOMMENDATION_BRIEF_PROMPT_VERSION` so the two modes cache independently.
  - The brief prompt returns structure, not prose: `targetQuery`, `winnabilityClass`, `angle`, `whyWinnable` (must cite the gap signal and winnabilityClass verbatim from context), `schemaHookup` (the schema.org type or markup to add or extend), and the controllable-surface rationale.
- `packages/api-routes/src/content.ts`: add `mode: 'explain' | 'brief'` to `recommendationExplainRequestSchema` and branch in the route, or add a sibling `POST .../:targetRef/brief`.
  - Enforce the gate server-side: reject `brief` for a `ceded` target with a clear 4xx, so a brief is never generated for a head term we should not chase.
  - Persist the structured brief plus provider, model, and cost, mirroring `recommendation_explanations`. Either add a `mode` discriminator to that table or add `recommendation_briefs`.

### Step 4: CLI and MCP surface

There is no `cnry content` command group today; targets are API, web, report, and MCP only. Add:

- `cnry content targets <project> [--ownable] [--format json]`: deterministic targets with winnabilityClass.
- `cnry content brief <project> [--target <ref>] [--all-ownable] [--format json]`: generate or fetch briefs for ownable targets.
- `cnry content map <project>`: convenience command that prints ranked ownable targets, each with its brief. The operator-facing one-shot.
- Register an MCP tool (`packages/canonry/src/mcp/tool-registry.ts`) so agents can call it headless.
- The report content section (`packages/api-routes/src/report.ts`) can graduate from the templated recommendation string to the brief when one exists.

### Step 5: Tests and docs

- Unit tests for the winnabilityClass rule: ownable vs ceded across aggregator-dominated, editorial-dominated, competitor-cited, own-cited, and no-citation queries, plus the threshold boundary.
- Contract test for the gated brief route: ceded returns 4xx, ownable returns a cached structured brief.
- Explainer test: the brief prompt-version cache is isolated from explain mode.
- Docs: a content section under `docs/` and the CLI reference, noting the determinism-decides-what, LLM-decides-how split.

## Risks and open questions

- **Classifier coverage.** The gate is only as good as the classifications available. A project that never ran discovery has none, so every target stays `ownable`. That is acceptable: the gate adds signal where it exists and never hides a target. Document that running discovery improves the gate.
- **Freshness.** A persisted classification can lag a domain's real role. A provenance timestamp plus a refresh on each discovery completion bounds this; treat stale as `unknown` and fail open.
- **Threshold tuning.** "Dominated" is a judgment knob. Start conservative, unit-test the boundary, document the default, and consider exposing it in config later.
- **Brief grounding.** Brief quality depends on the context fields fed in. Reuse the explainer's verbatim-signal discipline: cite the gap, do not invent facts.
- **Cost.** One `analyze`-tier call per ownable target on refresh. The existing prompt-version cache already bounds repeat cost, and the gate further reduces calls by excluding ceded targets.

## Why this shape

Determinism decides which queries are worth writing for, from real citation evidence and the existing classifier, so the LLM cannot drift into generic suggestions. The LLM only renders a brief for a target the deterministic layer already surfaced and gated. The work reuses two systems that already exist (the discovery classifier and the content explainer), so it is an extension rather than a new subsystem, which keeps the blast radius small.
