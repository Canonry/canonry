---
name: aeo-discovery
description: How to operate the tracked-basket discovery pipeline. Read when an operator asks to expand a project's basket, audit its competitive surface, or you wake unprompted on `aeo-discover-probe.completed`.
---

# AEO Discovery (Tracked-Basket Expansion)

Discovery turns a free-text ICP description into a deduped basket of representative queries, probes each against Gemini grounding, and classifies the results into three buckets:

- **cited** — the project's canonical (or owned) domain appears in the grounding sources
- **wasted-surface** — a tracked competitor is cited but the project is not
- **aspirational** — neither the project nor a tracked competitor is cited (greenfield)

Plus a competitor map: every non-canonical domain that shows up in probe citations, ranked by hit count, so the operator can spot recurring competitors that aren't yet on the watchlist.

## When discovery is the right move

- Operator says "expand my tracked queries", "audit my basket", "what am I missing", "find competitors I should track".
- Recurring `wasted-surface` shows up in regression analysis — the project keeps losing on queries adjacent to its tracked basket.
- A new ICP is being onboarded and the operator only has a domain + tagline, no curated query list.

## Triggering a session

The operator runs:

```bash
canonry discover run <project> --icp "..." --wait
```

Or the MCP equivalent: `canonry_discover_run_start` with `{ project, request: { icpDescription, dedupThreshold?, maxProbes? } }`. The endpoint returns `{ runId, sessionId, status: "running" }` immediately and finishes the work in the background. Poll `canonry_discover_session_get` until `status` is `completed` or `failed`.

ICP fallback: if the request omits `icpDescription`, the route uses `projects.icp_description` if set. Surface a clear "needs an ICP" prompt if neither is available.

## Cost + budget

Per session: ~$1 at the default probe budget (100 queries × 1 Gemini grounded call each, plus a single batched embed call for ~$0.0002). Hard cap: 500 probes per session, enforced both client-side (Zod) and server-side. Recommend the default (100) unless the operator has a specific reason.

## Reading the result

`canonry_discover_session_get` returns:

- Session-level: `seedCountRaw` vs `seedCount` (proves embedding dedup did real work), bucket counts, `competitorMap` (top recurring non-tracked domains).
- Per-probe: query, bucket, citation state, the cited domains list.

Things to call out without being asked:

- **High wasted-surface ratio** (≥ 40% of probes, or > cited count at ≥ 20%) → the project is missing from its own competitive space. The auto-written `discovery.basket-divergence` insight flags this as `high` severity.
- **New competitor domains** in `competitorMap` that aren't already in the project's tracked competitor list → suggest adding via `canonry competitor add <project> <domain>`. PR 2's `canonry discover promote` will automate this.
- **Aspirational greenfield** queries with no tracked competitor and no canonical cite → low-friction content opportunities.

## When you wake on `aeo-discover-probe.completed`

The follow-up payload `RunCoordinator` queues for you includes:

```
[system] Discovery run <runId> completed for project <name> (session <sessionId>).
Buckets — cited:<n>, wasted-surface:<n>, aspirational:<n> (<probeCount> probes; seed provider: gemini).
Top recurring competitor domains: <domain1>(<hits>), <domain2>(<hits>), …
```

Respond with:

1. A one-line headline naming the dominant bucket.
2. The top 2-3 wasted-surface queries (call `canonry_discover_session_get` to fetch them — don't guess).
3. The top 1-2 new competitor domains worth tracking.
4. A single recommended next step. Examples: "add competitor.com to the tracked list", "the wasted-surface set warrants a content plan around X", "the aspirational set is greenfield — pick the 3 with highest commercial intent and write content".

Keep it tight. The operator wakes to a short, decision-ready summary, not a full report.

## What discovery does NOT do (yet)

- **No promotion.** PR 2 ships `canonry discover promote` which adopts queries into the project's tracked basket with `provenance='discovery:<sessionId>'`. Until then, the operator merges manually via `canonry query add` / `canonry competitor add`.
- **No multi-provider amplification.** v1 probes Gemini only. v2 will probe across Gemini + ChatGPT + Claude in one session (the schema is already shaped for it — `discovery_probes` has no `UNIQUE(session_id, query)` exactly because of this).
- **No re-run drift.** Each session is independent. Comparing sessions over time is on the PR 4 / PR 5 roadmap.

## Failure modes

- **Gemini not configured** → orchestrator throws early; `runs.status='failed'` with `Gemini provider is not configured.` Surface as "configure Gemini before running discovery" — link to `canonry init` or `~/.canonry/config.yaml`.
- **Vertex-only Gemini** → embeddings step throws (Vertex embeddings deferred). Same surface, "use a Gemini API key for now."
- **ICP missing** → route returns 400 with `VALIDATION_ERROR`. Ask the operator for the ICP description in plain language.

## Memory hygiene

After a discovery session, store a one-liner in `agent_memory` if the operator validates a non-obvious call. Examples:

- `discovery:icp-style` — phrasing they responded well to
- `discovery:competitor-watchlist` — domains they explicitly accepted/rejected from the suggested list

Skip routine results — only memory-worthy material is what would help a future session avoid re-asking the same question.
