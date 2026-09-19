# discovery

Tracked-basket discovery: `routes.ts` (HTTP) and `orchestrate.ts` (`executeDiscovery`). Request parameters here follow the identity-vs-tuning rule in `packages/api-routes/AGENTS.md`.

## Discovery routes

`src/discovery/routes.ts` — tracked-basket discovery routes:

- `POST /projects/:name/discover/run` (writes `discovery_sessions` + `runs` rows and fires the injected `onDiscoveryRunRequested` callback):
  - Concurrent duplicates consolidate onto the in-flight session, whose identity is (project, `icpDescription`, `buyerDescription`, resolved `locations`, canonical `seedProviders` — explicit `['gemini']` normalizes to the omitted default) — buyer changes seed semantics so a different/absent buyer never reuses another buyer's session, while `dedupThreshold` / `maxProbes` / `probeConcurrency` are tuning and are dropped on reuse; any NEW request field must be classified identity-or-tuning the same way (see "Request parameters: identity vs tuning" above).
  - Returns `{ runId, sessionId, status: "running" }` immediately; resolves the request's optional `locations` label override against the project's configured locations via `resolveLocations` — unknown label → 400 — and forwards the resolved `LocationContext[]` on the callback so seed generation is geo-constrained.
- `GET /projects/:name/discover/sessions` (list), `GET /projects/:name/discover/sessions/:id` (detail + per-query probes).
- `GET /projects/:name/discover/sessions/:id/harvest` (read-only — reads the issued search-query fan-out, e.g. Gemini `groundingMetadata.webSearchQueries`, back out of the session's stored probe `raw_response` via the injected `harvestSearchQueries` seam, then runs the mandatory `gateHarvestedSearchQueries` lexical gate followed by `applyHarvestSemanticNovelty` — an embedding cosine pass over the tracked queries via the injected `embedQueries` seam (the Gemini embedder, same as discovery seeds) that drops paraphrase/synonym duplicates exact-match can't see; degrades to exact-match when embeddings are unavailable, reported as `semanticNoveltyApplied`. Returns candidate seeds ranked by probe recurrence + per-reason rejection stats incl. `semanticDuplicate`; `minProbeHits`/`anchor` query params; issue #713).
- `GET /projects/:name/discover/sessions/:id/promote` (read-only preview of bucketed queries + recurring suggested competitor domains of **every** classified type so the operator can see what `competitorTypes` would unlock).
- `POST /projects/:name/discover/sessions/:id/promote` (adopt a completed session's cited + aspirational queries plus recurring competitor domains classified `direct-competitor` into the project by default, tagged `provenance="discovery:<sessionId>"` — add-only, idempotent, single transaction + audit log; `buckets` / `includeCompetitors` / `competitorTypes` request fields scope it).
- `parseCompetitorMap` normalizes legacy competitor-map JSON (no `competitorType`) to `unknown`; `selectEligibleCompetitors` filters by hit floor + optional type set.

## Discovery orchestration

`src/discovery/orchestrate.ts`: `executeDiscovery` is pure orchestration with injected `DiscoveryDeps` (seed/embed/probe/classifyDomains).

- It persists `discovery_sessions` status transitions (`seeding` → `probing` → `completed`/`failed`).
- It embeds + clusters via `clusterByCosine` (default threshold `DISCOVERY_DEFAULT_DEDUP_THRESHOLD`, calibrated so single-link chaining cannot bridge distinct intents) and picks shortest-string representatives.
- It records a session `warning` via `seedCollapseWarning` when dedup degenerately collapses the seed set (measured before the probe-budget slice).
- It classifies each probe into cited / aspirational / wasted-surface and persists the probe's `answerMentioned` (the answer-text mention signal the dep computes, independent of citation; nullable for legacy rows), then runs one best-effort `classifyDomains` call to type every recurring cited domain (`direct-competitor` / `ota-aggregator` / `editorial-media` / `other`; failures fall back to `unknown`) and aggregates the typed competitor map.
- It caps probe budget at 100 default / 500 absolute.
- When 2+ seed providers ran, dedup uses a MONOTONIC multi-provider merge (`pickCanonicalsWithStats` with a `primaryMask`): it anchors on the primary provider's own clustering (identical to a single-provider run over that subset) and only ADDS novel secondary candidates, so adding a provider can never reduce the canonical count below a single-primary run (guaranteed floor; proven by a property test). Single-provider sessions are byte-identical to the pooled path.
- Probes run through a bounded worker pool (`probeConcurrency`, default 1 = serial, cap `DISCOVERY_PROBE_CONCURRENCY_CAP` = 8) whose results are collected by canonical index and batch-inserted in canonical order in one transaction — concurrency never changes row order, bucket counts, or failure semantics (the first probe error fails the session).
- It also persists the seed dep's optional raw-candidate source split onto `discovery_sessions.seed_from_answer_count` / `seed_from_grounding_count` (diagnostics only). Migration 92 widens the diagnostics into full seed provenance: `seed_raw_candidates` (the pre-filter candidate list — every live session becomes a replayable fixture for filter/dedup changes) plus `dedup_cluster_min_sims` / `dedup_band_pair_fraction` / `dedup_pairs_total` (per-cluster cohesion and the ambiguous 0.90-0.97 band mass, the calibration data for any future threshold/linkage decision).
- It forwards the optional `locations` (resolved `LocationContext[]`) to `deps.seed` so a location-aware seed implementation can geo-constrain its queries, and passes the FIRST resolved location to every `deps.probe` call as the probe geo context (the provider renders it exactly like a sweep location), so probes measure from the buyer's service area instead of nowhere; location-free sessions probe unchanged.
- Pure helpers (`classifyProbeBucket`, `buildCompetitorMap` — accepts an optional classification map, `pickCanonicals`, `markSessionFailed`) allow unit testing without spinning up the network.

## Discovery replay suite (quality regression)

`test/discovery-replay.test.ts` replays the deterministic seed pipeline (brand filter → exact dedup → cosine clustering → representative pick → collapse warning) against REAL captured sessions in `test/fixtures/discovery-replay/` — five ICP shapes, each with raw candidates + embedding vectors + golden expectations. CI makes zero provider calls. Two assertion tiers: GOLDEN exact equality (a deliberate pipeline change regenerates fixtures via `scripts/capture-discovery-replay-fixtures.ts` in the same PR — never loosen an assertion to pass) and INVARIANTS (canonicals >= the platform gate floor of 8, no collapse warning, branded raw candidates <= 20%). Refresh cost ~$0.50 total; see the capture script header for the procedure.
