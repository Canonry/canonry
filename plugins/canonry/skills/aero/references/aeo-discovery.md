---
name: aeo-discovery
description: How to operate the tracked-basket discovery pipeline. Read when an operator asks to expand a project's basket, audit its competitive surface, or you wake unprompted on `aeo-discover-probe.completed`.
---

# AEO Discovery (Tracked-Basket Expansion)

Discovery turns an ideal customer profile (ICP) into candidate queries and probes the deduplicated queries with Gemini. The three buckets use the source domains in each probe.

- **cited** — the answer cites a project domain.
- **wasted-surface** — a tracked competitor domain appears in the sources, and every project domain is absent.
- **aspirational** — the answer cites neither a project domain nor a tracked competitor domain.

The competitor map ranks cited domains outside the project's own domains. Each domain counts once per probe. Report a project mention separately from the probe's `answerMentioned` field. A null value means that the probe did not measure the mention.

After probing, Canonry uses the configured domain classifier to assign a `competitorType` to each cited domain. Gemini is the default classifier.

- **direct-competitor** — a business competing for the same customers (another hotel, another tool in the category). The only type promoted by default.
- **ota-aggregator** — OTAs, marketplaces, directories, review aggregators (expedia.com, booking.com, g2.com). Suppressed from competitor tracking.
- **editorial-media** — news, blogs, "best of" round-ups (timeout.com, a personal blog). A *channel* to earn placement in, not a competitor — suppressed by default.
- **other** — government sites, social platforms, off-topic domains. Suppressed.
- **unknown** — classification failed, or a session that pre-dates classification. Excluded from the default promote.

## When discovery is the right move

- Operator says "expand my tracked queries", "audit my basket", "what am I missing", "find competitors I should track".
- Recurring `wasted-surface` shows up in regression analysis — the project keeps losing on queries adjacent to its tracked basket.
- A new ICP is being onboarded and the operator only has a domain + tagline, no curated query list.

## Triggering a session

Discovery uses provider quota. State the proposed ICP, seed providers, and
probe budget. After the operator approves the session, run the CLI command or
call the exposed tool.

```bash
cnry discover run <project> --icp "..." --wait
```

`canonry_discover_run_start` accepts `{ project, request }` in an external MCP
host. Built-in Aero passes `{ request }` for its current project. Set
`icpDescription` in `request` to override the stored ICP. The tool
returns `runId`, `sessionId`, and `status: "running"`. Poll
`canonry_discover_session_get` for `completed` or `failed`.

ICP fallback: if the request omits `icpDescription`, the route uses `projects.icp_description` if set. Surface a clear "needs an ICP" prompt if neither is available.

## Cost + budget

The default limit is 100 probes per session. `--max-probes` (MCP
`request.maxProbes`) accepts up to 500. The session also uses provider calls
for seed generation, embeddings, and domain classification. Use configured
pricing to assess cost.

## Reading the result

`canonry_discover_session_get` returns:

- At session level, read `seedCountRaw`, `seedCount`, bucket counts, and
  `competitorMap`. Map entries carry `hits` and `competitorType`.
- Per probe, read the query, bucket, `citationState`, cited domains, and `answerMentioned`.

Things to call out without being asked:

- **High wasted-surface ratio** (≥ 40% of probes, or > cited count at ≥ 20%) → the project is missing from its own competitive space. The auto-written `discovery.basket-divergence` insight flags this as `high` severity.
- **Recurring `direct-competitor` domains** in `competitorMap` that aren't already in the project's tracked competitor list → `cnry discover promote` adopts `direct-competitor` domains with at least 2 hits automatically alongside the queries; or add them à la carte with `cnry competitor add <project> <domain>`. Domains classified `ota-aggregator` / `editorial-media` / `other` are surfaced but **not** promoted by default — flag a recurring `editorial-media` site as a placement opportunity, not a competitor.
- **Aspirational queries** can suggest content opportunities. Use the individual probe's mention field before making claims about brand presence.

## Promoting a session into the tracked basket

Once a session is `completed`, preview first unless the operator has already approved the write:

```bash
cnry discover promote preview <project> <session-id>
```

Or use `canonry_discover_promote_preview`. Pass `{ project, sessionId }` in an
external MCP host and `{ sessionId }` in built-in Aero.

The preview returns every bucket so you can explain the tradeoff:

- `cited` — the sources include at least one project domain.
- `aspirational` — greenfield ICP-fit opportunities, safe to track as a growth basket.
- `wasted-surface` — competitor-cited but project-missing. Treat as content-planning evidence first; do not add it to the weekly tracked basket unless the operator explicitly wants those off-ICP competitor gaps tracked.
- `suggestedCompetitors`: recurring competitors (≥ 2 probes) not already tracked, of **every** classified type, each tagged with `competitorType` and stored as its registrable domain, with the cited hosts merged into it under `sources` (`offers.rival.example` promotes as `rival.example`). The default promote adopts only the `direct-competitor` ones; the others are shown so you can recommend a `--competitor-types` widening.
- `skippedCompetitors`: eligible competitors a promote leaves out, each with a `reason` and a `message`: `already-tracked`, `project-domain` (the project's own site), `shared-host` (cited as two or more different subdomains of one possibly shared host; add it by hand if they are one competitor), or `claimed-by-alias` (another competitor's curated alias names it; fix the alias first).

Promote with one of these paths:

```bash
cnry discover promote <project> <session-id>                                          # cited + aspirational buckets + direct-competitor domains
cnry discover promote <project> <session-id> --bucket aspirational                    # scope to a bucket subset (repeatable / comma-separated)
cnry discover promote <project> <session-id> --bucket wasted-surface                  # explicitly track off-ICP competitor gaps
cnry discover promote <project> <session-id> --competitor-types direct-competitor,editorial-media   # widen the competitor merge to other classified types
cnry discover promote <project> <session-id> --no-competitors                         # queries only, skip the competitor merge
```

For the MCP equivalent, call `canonry_discover_promote`. In an external MCP
host, include the project. Built-in Aero uses the current project.

```json
{ "project": "<project>", "sessionId": "<session-id>" }
```

That default request promotes `cited` + `aspirational` queries and `direct-competitor` domains. For scoped writes, pass `request`:

```json
{ "project": "<project>", "sessionId": "<session-id>", "request": { "buckets": ["aspirational"], "competitorTypes": ["direct-competitor", "editorial-media"], "includeCompetitors": false } }
```

- **Default is cited + aspirational.** `wasted-surface` queries are off-ICP competitor gaps; promote them only when the operator explicitly wants those tracked in the weekly basket.
- **Competitor types.** By default, promotion includes direct competitors cited in at least two probes. To include editorial sites alongside direct competitors, pass both `direct-competitor` and `editorial-media` in `competitorTypes` (CLI `--competitor-types`). An explicit list replaces the default filter.
- **Add-only and idempotent.** Queries and competitor domains already tracked are returned under `skipped`, never inserted twice. Re-running a promote is safe. Competitors left out for any other reason are listed there too, with the reason in `competitorDetails`; the rest of the promote still lands.
- **Completed sessions only.** Promoting a `queued`/`seeding`/`probing`/`failed` session is rejected — the buckets aren't final.
- Promoted rows carry `provenance="discovery:<sessionId>"`, so a tracked query can always be traced back to the session that surfaced it.

## When you wake on `aeo-discover-probe.completed`

The follow-up payload `RunCoordinator` queues for you includes:

```
[system] Discovery run <runId> completed for project <name> (session <sessionId>).
Buckets — cited:<n>, wasted-surface:<n>, aspirational:<n> (<probeCount> probes; seed provider: <seedProvider>).
Top recurring competitor domains: <domain1>(<hits>), <domain2>(<hits>), …
```

Respond with:

1. A one-line headline naming the dominant bucket.
2. The top 2-3 wasted-surface queries (call `canonry_discover_session_get` to fetch them — don't guess).
3. The top 1-2 recurring `direct-competitor` domains worth tracking, ignoring one-hit domains unless the operator asks for the full long tail. If a recurring `editorial-media` domain stands out, mention it separately as a placement opportunity — not a competitor.
4. A single recommended next step. Examples: "preview and promote cited + aspirational findings (`cnry discover promote preview`, then `cnry discover promote`)", "the wasted-surface set warrants a content plan around X before tracking", "the aspirational set is greenfield — pick the 3 with highest commercial intent and write content".

Do not recommend "promote everything" as the default. The safe path is: inspect session detail, preview promotion candidates, then promote the default cited + aspirational set. Escalate `wasted-surface` to tracking only when the operator deliberately chooses that tradeoff.

Keep it tight. The operator wakes to a short, decision-ready summary, not a full report.

## Seed providers and probe scope

- Gemini generates seeds by default. Select Gemini, OpenAI, or both via
  `--seed-provider` or MCP `request.seedProviders`.
- Gemini runs every probe. With multiple resolved locations, the probes use
  the first, with the project's default first if selected.
- Each session has its own query basket. Compare the selected queries and
  scope before comparing session counts.

## Failure modes

- **Gemini not configured.** Configure Gemini before starting discovery.
  The embeddings step requires a Gemini API key, including on a Vertex-only installation.
- **ICP missing** → route returns 400 with `VALIDATION_ERROR`. Ask the operator for the ICP description in plain language.
- **Seed collapse.** Read the session's `warning` field and compare the raw and canonical seed counts. Similar wording and intent can collapse many raw candidates into a few queries.

  **Remediation:** break the ICP into 3-5 distinct purchase-intent angles and run one session per angle via `--icp-angle`:

  ```bash
  cnry discover run <project> \
    --icp-angle "romantic anniversary stay in Harborline Beach" \
    --icp-angle "best rooftop bars and dining hotels near Harborline" \
    --icp-angle "walkable Harborline Beach hotels near Kettle Row" \
    --icp-angle "design-forward boutique hotels for creative professionals" \
    --wait
  ```

  Each angle creates a session with its own candidates and probe budget. The `--wait` output identifies each session. Compare their previews before selecting queries to promote.

## Memory hygiene

After a discovery session, store a one-liner in `agent_memory` if the operator validates a non-obvious call. Examples:

- `discovery:icp-style` — phrasing they responded well to
- `discovery:competitor-watchlist` — domains they explicitly accepted/rejected from the suggested list

Skip routine results — only memory-worthy material is what would help a future session avoid re-asking the same question.
