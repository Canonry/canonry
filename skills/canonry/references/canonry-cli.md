# Canonry CLI Reference

The CLI is invoked as `cnry` (short form) or `canonry` — both ship with the `@canonry/canonry` npm package and behave identically. This reference uses `cnry`.

## Server Management

```bash
cnry bootstrap                                 # local config/database; providers optional
cnry init                                      # optional interactive provider/OAuth setup
cnry start                                     # start daemon
cnry stop                                      # stop daemon
cnry serve                                     # foreground mode
cnry serve --host 0.0.0.0 --port 4100
cnry serve --embed --embed-allow-origin https://app.example.com   # read-only embed mode (#716)
cnry --version
```

`cnry bootstrap` is the provider-free Page Health path. It stores state under
`$CANONRY_CONFIG_DIR` when set, otherwise `~/.canonry`, and prints a new API key
once. `cnry init` is the optional interactive path when provider/OAuth setup is
wanted at the same time. An agent must ask the operator to run either
secret-bearing command in a private terminal without pasting the output back.

### Read-only embed mode (#716)

Opt-in, OFF by default. Renders the dashboard "chromeless" (no nav/topbar/settings) so it can be iframed read-only, and emits a fail-closed framing contract. With `--embed` absent, served HTML + headers are byte-for-byte unchanged.

```bash
cnry serve --embed --embed-allow-origin https://app.example.com [--embed-allow-origin https://b.example] [--embed-view overview]
cnry start --embed --embed-allow-origin https://app.example.com   # daemon form (forwards flags to serve)
# Env equivalents (env overrides config.yaml `embed:`):
#   CANONRY_EMBED=1   CANONRY_EMBED_ORIGINS=https://a.com,https://b.com   CANONRY_EMBED_VIEWS=overview,project
```

- **Framing:** emits `Content-Security-Policy: frame-ancestors <origins>` on the SPA document, **failing CLOSED to `frame-ancestors 'none'`** when no valid origins are configured (so a misconfigured embed is un-framable, not open to everyone). Origins must be bare `scheme://host[:port]` — paths, wildcards (`*.host`), and non-http(s) schemes are rejected. No `X-Frame-Options` is emitted (CSP is the single source of truth).
- **Read-only is server-enforced:** embed mode adds NO write surface; the read-only API-key gate (403 on POST/PUT/PATCH/DELETE) is unchanged.
- **Cross-origin auth caveat:** the `SameSite=Lax` session cookie is NOT sent in a cross-site iframe and the shipped bundle has no API key. v1 works for a **same-origin** embed (cookie flows) OR a self-hosted build with a read-only `VITE_API_KEY` baked in (then client-visible). Do not loosen the cookie to `SameSite=None`.

Production managed by PM2:
```bash
pm2 status
pm2 logs canonry
pm2 restart canonry
```

## Project Management

```bash
cnry project list                              # list all projects
cnry project create <name> --domain <url> --country US --language en
cnry project show <name>                       # project detail
cnry project update <name>                     # update project settings
cnry project delete <name>                     # delete a project
cnry project delete <name> --dry-run           # preview cascade impact (GET /delete-preview) without writing
cnry status <project>                          # mention + citation summary + domain info
```

### Brand aliases

`spec.brandAliases: string[]` on the project (set via `cnry apply` or the dashboard) widens the mention detector. Use it when the answer text says "Meta" but the canonical brand is "Facebook", or for product variants ("AcmeCloud", "Acme Cloud", "AcmeCloud Pro"). Aliases are case-insensitive and match the same answer-text scan that powers `answerMentioned`.

## Surgical Reads — `cnry get`

```bash
cnry get <project> scores.mentionShare.value
cnry get <project> scores.mentionCoverage.value
cnry get <project> scores.citationCoverage.value
cnry get <project> insights[0].severity
cnry get <project> latestRun.status
cnry get <project> --from report scores.citationCoverage.value   # pick a registered source
cnry get <project> <path> --format json                          # raw JSON output
```

Resolves a dot/bracket path against the project's overview (default `--from overview`) or any registered source — `report`, `traffic`, `discovery`, etc. Returns the scalar (or sub-tree) at the path so an agent can lift a single number without pulling a 30 KB JSON payload. Use `--from <source> .` to see the available top-level keys for that source.

### Locations

Projects support multi-region location context for geographically-aware sweeps:

```bash
cnry project add-location <name> --label "NYC" --city "New York" --region NY --country US
cnry project locations <name>                  # list configured locations
cnry project set-default-location <name> <label>
cnry project remove-location <name> <label>
```

## Sweeps

```bash
cnry snapshot "Acme Corp" --domain acme.example.com      # one-shot sales snapshot
cnry snapshot "Acme Corp" --domain acme.example.com --md          # save markdown report
cnry snapshot "Acme Corp" --domain acme.example.com --output report.md  # custom path
cnry snapshot "Acme Corp" --domain acme.example.com --pdf         # save PDF report
cnry snapshot "Acme Corp" --domain acme.example.com --format json

cnry run <project>                             # sweep all configured providers
cnry run <project> --provider gemini           # single provider only
cnry run <project> --query "alpha" --query "beta"  # scope sweep to a subset of tracked queries (repeatable)
cnry run <project> --wait                      # block until complete
cnry run <project> --location <label>          # run with specific location context
cnry run <project> --all-locations             # run for every configured location
cnry run <project> --no-location               # explicitly skip location context
cnry run <project> --probe --provider openai --query "..."  # operator/agent test run — snapshot is inspectable but EXCLUDED from dashboard, analytics, intelligence, report, and notifications. Use for verification / "did this fix work?" / regression hypothesis testing.
cnry run --all --wait                          # all projects
cnry run cancel <project> [run-id]             # force-cancel stuck runs
cnry runs <project> --limit 10                 # list recent runs (includes both real and probe runs; filter on `trigger` if you only want one)
cnry run show <id>                             # show run details
```

Run statuses: `queued` → `running` → `completed` / `failed` / `partial`

`partial` = some providers failed (usually rate limits) — successful snapshots are still saved.

### Probe vs real runs

| Trigger | Source | Feeds dashboard/analytics | Runs intelligence | Fires notifications | Wakes Aero |
|---|---|---|---|---|---|
| `manual` | `cnry run <project>` | ✅ | ✅ | ✅ | ✅ |
| `scheduled` | cron schedule | ✅ | ✅ | ✅ | ✅ |
| `config-apply` | `cnry apply` after queries change | ✅ | ✅ | ✅ | ✅ |
| `backfill` | `cnry backfill ...` | partial (historical) | ✅ | — | — |
| **`probe`** | `cnry run --probe ...` | ❌ | ❌ | ❌ | ❌ |

After explicit approval for the exact provider/query (or a bounded batch), use
`--probe` for verification rather than producing data the user/dashboard will
consume. A probe still costs provider quota and writes a snapshot; approval for
one probe does not authorize repeats.

`snapshot` does not create a project or write to the DB. It generates category queries, runs providers, and produces a report for prospecting.

## Mention + Citation Data

Two independent signals per (query × provider): **mention** (`answerMentioned` — brand named in the answer text; the **primary** read) and **citation** (`cited`/`citedDomains` — domain in the grounding sources; **secondary**). Read mention first. Never compute one from the other; never coerce `answerMentioned` null → false (null = "not checked").

```bash
cnry evidence <project>                        # per-query [C/c][M/m] cell + Mentioned: X / Y / Cited: X / Y
cnry evidence <project> --format json          # JSON output
cnry history <project>                         # audit trail
cnry export <project> --include-results        # export as YAML
cnry backfill answer-mentions                  # recompute answerMentioned (primary) from stored answers (honors brandAliases)
cnry backfill answer-mentions --dry-run
cnry backfill answer-visibility                # recompute citationState (secondary) from stored answers
cnry backfill answer-visibility --dry-run      # preview which snapshots would change
cnry backfill insights <project>               # recompute insights for completed runs
cnry backfill insights <project> --since 2026-04-01 --dry-run
```

Output uses a two-glyph cell per (query × provider): `[C/c][M/m]` — uppercase = present, lowercase = absent, `–` = no snapshot. **C/c = cited** (secondary), **M/m = mentioned** (primary). Always print the legend before the table; never collapse the two signals into one cell.

```
Legend: [C/c][M/m]  C=cited c=not-cited  M=mentioned m=not-mentioned  –=no snapshot

[C][M]  acme corp ny       ← mentioned AND cited
[c][M]  best crm for smb    ← mentioned, not cited (mention win, citation gap)
[C][m]  crm pricing         ← cited, not mentioned (citation without share of voice)
[c][m]  free crm tools      ← neither
```

Summary: `Mentioned: X / Y` (primary) and `Cited: X / Y` (secondary) are reported independently — a query can be one, both, or neither.

## Reports

```bash
cnry report <project>                          # write canonry-report-<project>-YYYY-MM-DD.html
cnry report <project> --period 14              # time window: 7|14|30|90 days (default 30) — scopes GSC/GA/server-activity + period-over-period deltas
cnry report <project> --output dist/aeo.html   # custom path
cnry report <project> --format json            # raw report payload to stdout
```

One-command client-facing AEO report. Bundles the latest visibility sweep, competitor landscape, AI citation sources, GSC + GA4 performance, social and AI referrals, indexing health, citations trend, prioritized insights, and recommended next steps into a self-contained HTML file (inline CSS + SVG charts, no network dependencies). Backed by `GET /api/v1/projects/<name>/report` and the `canonry_report` MCP tool.

Behavior to know when narrating numbers from the report:
- `executiveSummary.citationRate` is **per-query** — `citedQueryCount / totalQueryCount`, with a query counted as cited if any provider in the run cited it. The rate is invariant to provider count, so a gemini-only run and a 4-provider run can be compared honestly. The same definition powers `citationsTrend[].citationRate` so trend deltas track real movement, not provider-mix variance.
- `citationsTrend` excludes partial runs to avoid skew. A project with only one completed run gets `trend: "unknown"` and the finding "No prior run to compare against." — not "Flat compared to the previous run."
- Project ownership uses subdomain-aware matching against `project.canonicalDomain` plus any configured `ownedDomains`. `blog.example.com` and `brand.io` count as the project, not as external sources, when those rules apply.
- Competitor tagging in `aiSourceOrigin.topDomains` uses the same subdomain-aware match — `blog.rival.com` is `isCompetitor: true` when `rival.com` is tracked.
- AI referral totals dedupe overlapping GA4 attribution dimensions (`session` / `first_user` / `manual_utm`) by picking the largest dimension per `(date, source, medium)`. Two 10-session rows for the same tuple report 10 sessions, not 20.
- GSC top-query CTR and avgPosition are impression-weighted, matching GSC's own metric semantics across multi-row queries.

## Results Export (historical observations)

```bash
cnry results export <project>                          # versioned JSON artifact → canonry-results-<project>-YYYY-MM-DD.json in cwd
cnry results export <project> --format csv             # flat spreadsheet representation of the same records
cnry results export <project> --format json --output - # stream the artifact to stdout (agent-friendly)
cnry results export <project> --since 2026-06-01 --until 2026-06-30   # inclusive run-creation window (date-only until covers the whole UTC day)
cnry results export <project> --include-probes         # opt IN to probe runs (excluded by default)
```

Bulk download of every persisted answer-visibility query × provider observation — one record per snapshot, ordered by run then snapshot. This is the raw-history primitive; use `visibility-stats` for aggregates and `visibility-compare` for month-over-month claims.

Behavior to know:
- **Citation and mention stay independent** per record: `citationState`/`cited` describe source-list attribution; `answerMentioned`/`mentionState` describe answer-text presence. `answerMentioned: null` means "not evaluated" (legacy snapshot), never not-mentioned.
- `query` is the snapshot-time text, so removed tracked queries keep their history; `queryId` is null for them.
- Includes completed, partial, and failed answer-visibility runs. Probe runs and other run kinds (site-audit etc.) are excluded unless `--include-probes`.
- CSV cells are spreadsheet-injection-safe (leading `=`, `+`, `-`, `@` neutralized) and JSON-array columns (`cited_domains_json`, …) are embedded JSON strings.
- Raw provider payloads and credentials are never included; grounding sources and issued search queries are.
- Backed by `GET /api/v1/projects/<name>/results/export` (`?format=json|csv&since&until&includeProbes`). Not exposed as an MCP tool by design — bulk attachments don't fit a context window; agents needing slices should use the paginated snapshot reads or this CLI with `--output -`.
- Distinct from `cnry export <project>`, which exports project CONFIGURATION as YAML, not results.

## Analytics

```bash
cnry analytics <project>                       # default analytics view
cnry analytics <project> --feature metrics     # mention + citation rate trends (BrandMetricsDto: mentionTrend primary, trend secondary)
cnry analytics <project> --feature gaps        # brand gap analysis — mention buckets (mentionedQueries[]/mentionGap[]/notMentioned[]) primary, cited buckets (cited[]/gap[]/uncited[]) secondary
cnry analytics <project> --feature sources     # source breakdown by category
cnry analytics <project> --window 7d           # time window: 7d, 30d, 90d, all
```

### Cited-source rankings (`cnry sources`)

"Where do AI engines get the facts they cite?" — the full, per-provider, classified ranking of cited domains. Backed by `GET /api/v1/projects/<name>/analytics/sources` and the `canonry_analytics_sources` MCP tool. All counts/shares/classification are computed server-side; the CLI only renders.

```bash
cnry sources <project>                          # surface-class roll-up (own / direct-competitor / ota-aggregator / editorial-media / other)
cnry sources <project> --rank                   # full ranked cited-domain list, each tagged with category + surface class
cnry sources <project> --rank --limit 20        # top 20 domains; an explicit long-tail rollup preserves the totals
cnry sources <project> --by-provider            # per-provider cited-domain mix + each provider's total cited slots
cnry sources <project> --window 30d --format json   # window-filterable; --format json emits the SourceBreakdownDto directly
cnry sources <project> --rank --format jsonl    # stream the ranked domains, one self-contained record per line
```

- **Surface class** is deterministic (no LLM): `own` = the project's `canonicalDomain`/`ownedDomains`; `direct-competitor` = a tracked competitor; `ota-aggregator` = directories/marketplaces (Yelp, Booking.com, Tripadvisor, Amazon…); `editorial-media` = news/blogs/reference; `other` = everything else. When discovery has run, its stored per-domain classifications (`domain_classifications`) enrich recall for niche OTAs/regional media the static allow-list misses — `own` and tracked competitors always stay authoritative. Running `cnry discover run` improves coverage.
- The ranked list is **not truncated** by default (the old top-5-per-category cap is gone). Pass `--limit N` to cap each list; the response carries `truncatedDomainCount` / `truncatedCitedSlots` so totals always reconcile.
- Counts are **cited slots** (grounding citations), so a domain cited 3× in one answer counts 3. Probe runs are excluded.

### Aggregated visibility stats (`cnry visibility-stats`)

Per-query mention (answer-text) and citation (source-list) **counts with a sample size**, pooled across many answer-visibility runs — the data to compute a confidence-aware proportion (e.g. Wilson) or detect drift without fetching every run. Backed by `GET /api/v1/projects/<name>/visibility-stats` and the `canonry_visibility_stats` MCP tool. Probe runs and non-`answer-visibility` runs are excluded; only completed/partial runs count. `--share-of-voice` adds a head-to-head vs tracked competitors (`project / (project + competitor)` brand mentions) — the primitive for a month-over-month client report: call it with `--month <this>` and `--month <last>` and compare. **It is scoped to NON-BRAND queries by default and the response echoes `queryClass`.** A branded query hands the model your name, so you are mentioned on ~all of them and a competitor structurally cannot be; a pooled figure therefore reports brand recall as category placement (measured: one basket read 42% / rank 1 pooled and 3% / rank LAST non-brand). Pass `--query-class branded` for the recall figure. There is no "all" — the two never share a denominator.

```bash
cnry visibility-stats <project>                                   # all runs; per-query cited/total + mentioned/checked + pooled TOTAL
cnry visibility-stats <project> --last-runs 10                    # most recent 10 runs (mutually exclusive with --since/--until/--month)
cnry visibility-stats <project> --since 2026-06-01 --until 2026-06-30   # ISO date/time window on run createdAt
cnry visibility-stats <project> --month 2026-06                    # a whole calendar month (YYYY-MM), expanded to that month's UTC bounds
cnry visibility-stats <project> --by-provider                     # per-provider breakdown (counts sum to the pooled counts)
cnry visibility-stats <project> --month 2026-06 --share-of-voice   # share of voice vs competitors, NON-BRAND queries (the m/m report primitive)
cnry visibility-stats <project> --month 2026-06 --share-of-voice --query-class branded   # brand recall: are you named when asked about by name?
cnry visibility-stats <project> --format jsonl                    # stream one record per query, stamped with project + runCount

# Month-over-month comparison (the statistically honest m/m primitive — use this, not two --month calls diffed by hand):
cnry visibility-compare <project> --from 2026-05 --to 2026-06     # SoV-led, Wilson intervals, within-noise/moved verdict, model-continuity gated
cnry visibility-compare <project> --from 2026-05 --to 2026-06 --format json
```

- **Use `visibility-compare` for any month-over-month AEO claim.** It leads with **share of voice** (less exposed to an engine's broad naming propensity than an absolute rate, `driftRobust: true`), pools rates per-snapshot (invariant to sweep count), restricts to the query/provider PAIRS present in BOTH months, then to providers with one known, identical configured model id in both months, and attaches a Wilson 95% interval + a `verdict` to every metric. Verdicts: **`within-noise`** = NO confirmed change (never report it as a decline); **`moved`** = a real directional move; **`model-discontinuous` / `model-unknown`** = the engine's configured model changed, was mixed within a month, or is unrecorded, so no directional call is made (do not attribute the swing to the site). Read `continuity` (`status` + per-provider evidence) for what was excluded — `continuity` is the gate, `modelChanges` is advisory. A silent upstream version bump under an unchanged configured id remains undetectable. `lowRunCount` flags a month under 5 sweeps, where intervals are too wide to resolve a move.

- **Tri-state aware:** `checked` counts only snapshots where `answerMentioned` was recorded — `null` ("not checked") is **excluded**, never counted as not-mentioned. So `checked` is the correct `n` for a mention proportion. `mentionRate = mentioned/checked`; `citedRate = cited/total` (citation_state is always populated, so the citation `n` is `total`). Both rates are `null` when their denominator is 0 (undefined over no samples).
- **Date-only window:** `--since`/`--until` accept a full ISO instant or a bare `YYYY-MM-DD`. A date-only `--until 2026-06-30` covers the **whole** UTC day (through 23:59:59.999), so same-day runs are included; a date-only `--since` is that day's start.
- **Unbounded by default:** with no `--since`/`--until`/`--last-runs`, every completed/partial run is pooled (`window.runCount` reports how many). For a recent sample, bound it with `--last-runs N`.
- **`groupBy` in the payload:** present (`"provider"`) only with `--by-provider`; omitted otherwise (absent = no breakdown) — the generated SDK types it `groupBy?: 'provider'`.
- **mention vs cited stay independent** — a model can do either, both, or neither. Don't read one from the other.

## Site Health (technical-aeo compatibility)

Site-wide technical audit (structured data, AI-readable content, AI-crawler access, content depth/freshness/extractability, …) powered by `@canonry/aeo-audit`'s `runSiteCrawl`. Runs as the `site-audit` run kind — discovers in-scope URLs from the project root, sitemaps, and internal links; stores the URL/link graph; audits eligible HTML pages; and rolls the results into one 0–100 site score. Pure HTTP, no LLM cost; a large site can take minutes, so it runs in the background. `site-health` is the operator-facing CLI name; `technical-aeo` remains compatible.

```bash
cnry technical-aeo run <project> --wait                 # full crawl + audit; defaults to 1,000 pages / 100,000 edges; waits for terminal state
cnry technical-aeo run <project> --sitemap-url <url> --max-pages 5000 --max-edges 250000 --max-depth 12   # optional crawl seeds and custom budgets; hard caps are 50,000 pages / 1,000,000 edges
cnry technical-aeo run <project> --check-dead-links --wait   # opt in to dead-link checks; they are off by default
cnry technical-aeo progress <project> --run-id <id> [--format json] # exact durable phase and pages found / checked / failed counters; never a synthesized percentage
cnry technical-aeo crawl <project> [--run-id <id>] [--format json]   # crawl metadata, budgets, completeness, and termination
cnry site-health overview <project> [--run-id <id>] [--format json] # operator-facing alias for crawl metadata
cnry site-health page-audit <project> (--node-key <key>|--url <url>) [--run-id <id>] [--format json] # exact audit score, factor findings, recommendations, and crawl provenance for one graph page
cnry site-health subgraph <project> [--node-key <key>|--url <url>] [--hops <n>] [--max-nodes <n>] [--max-edges <n>] [--format json] # focused semantic graph (MCP defaults to 25 nodes / 50 edges)
cnry site-health path <project> (--to-node-key <key>|--to-url <url>) [--from-node-key <key>|--from-url <url>] [--max-depth <n>] [--format json] # directed shortest followable-link path
cnry site-health changes <project> [--from-run-id <id>] [--to-run-id <id>] [--scope all|pages|links] [--change all|added|removed|changed] [--cursor <cursor>] [--limit <n>] [--format json|jsonl] # canonical scan diff; either scan ID is optional; JSONL begins with scan/cursor/filter metadata
cnry technical-aeo changes <project> [--from-run-id <id>] [--to-run-id <id>] [--scope all|pages|links] [--change all|added|removed|changed] [--cursor <cursor>] [--limit <n>] [--format json|jsonl] # compatibility alias with the same independently optional scan IDs
cnry technical-aeo crawl-pages <project> [--fetch-state <state>] [--indexability-state <state>] [--sort url|path|score-asc|score-desc] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]   # bounded URL inventory with depth and link score
cnry technical-aeo page-audit <project> (--node-key <key>|--url <url>) [--run-id <id>] [--format json] # compatibility alias for one page's exact audit evidence
cnry technical-aeo structure <project> [--parent-path <path>] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]   # one level of the path hierarchy
cnry technical-aeo links <project> [--source-url <url>] [--target-url <url>] [--followable|--nofollow] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]   # bounded internal-link edges
cnry technical-aeo links neighbors <project> (--node-key <key>|--url <url>) [--limit <n>] [--format json]   # bounded inbound/outbound neighborhood
cnry technical-aeo dead-links <project> [--cursor <cursor>] [--limit <n>] [--format json|jsonl]   # disabled unless the run opted in
cnry technical-aeo score <project> [--format json]      # site score + per-factor scorecard (avg + pass/partial/fail per page) + delta vs the previous audit
cnry technical-aeo pages <project> [--status error] [--sort score-asc|score-desc|url] [--format json|jsonl]   # audited-page compatibility view (worst-first by default)
cnry technical-aeo trend <project> [--format json|jsonl] # aggregate-score history across past audits
cnry schedule set <project> --kind site-audit --preset weekly   # keep it fresh
```

For agent site readiness, begin with `cnry technical-aeo score <project> --format json`. Use `cnry site-health overview <project>` only to add crawl metadata; it never replaces the score. Use `cnry site-health page-audit` (MCP: `canonry_site_health_page_audit`) to tie a selected graph page's audit score to exact findings and fixes. Link score is importance, not an audit verdict. Then request a focused neighborhood, a shortest path, or scan-to-scan changes. Do not ask an agent to materialize the interactive graph: it can exceed the MCP tool-result limit. The matching traversal tools are `canonry_site_health_subgraph`, `canonry_site_health_path`, and `canonry_site_health_changes`; the subgraph tool defaults to a small focused result and should be expanded only when needed.

- The score is only available after at least one audit runs — `score` returns `hasData: false` until then.
- A failed, cancelled, or budget-terminated attempt stays inspectable but never replaces the latest complete crawl graph.
- Graph reads are server-paged and bounded. Use `--run-id` to inspect a specific retained run.
- A subgraph with `countAccuracy: "lower-bound"` hit a traversal cap: totals and omissions are minimums, not site-wide counts. Its `complete` and `termination` fields apply to every observation.
- Treat an `unreachable` or `truncated` path from `complete: false` as limited to persisted crawl observations; use `termination` to explain that qualification.
- `changes` returns its resolved filters and an exact post-filter summary only on its first page. JSONL headers retain `filters`, `summaryState`, nullable `summary`/`total`, and `nextCursor`; continuation records remain safe to stream without recomputing totals.

## Intelligence

```bash
cnry insights <project>                        # list active insights (regressions, gains, opportunities)
cnry insights <project> --type gbp-*           # filter by insight type; trailing * = prefix (e.g. only GBP insights)
cnry insights <project> --type gbp-description-missing   # exact type match
cnry insights <project> --severity high        # minimum severity (high returns high + critical)
cnry insights <project> --limit 10             # cap to the newest N
cnry insights <project> --dismissed            # include dismissed insights
cnry insights <project> --format json          # JSON output
cnry insights dismiss <project> <id>           # dismiss an insight
cnry health <project>                          # latest citation health snapshot (citation-only — see known gap below)
cnry health <project> --history                # health trend over time
cnry health <project> --history --limit 10     # limit history entries
cnry health <project> --format json            # JSON output
cnry backfill insights <project>              # backfill insights for all completed runs
cnry backfill insights <project> --from-run <id> --to-run <id>  # backfill a range
```

> **Known gap (mention-first read):** `cnry health` is **citation-only** today — it has no mention dimension. For the primary mention-first read, use `cnry overview` and `cnry get <project> scores.mentionCoverage.value` / `cnry get <project> scores.mentionShare.value` until health is extended.

## Queries & Competitors

```bash
cnry query add <project> "phrase one" "phrase two"
cnry query replace <project> "phrase one" "phrase two"   # set the basket to exactly this list
cnry query replace <project> "..." --dry-run             # preview adds/removes via /queries/replace-preview
cnry query remove <project> "phrase"
cnry query list <project>
cnry query import <project> queries.txt
cnry query generate <project> --provider gemini --count 10 --save

cnry competitor add <project> competitor1.com competitor2.com
cnry competitor list <project>
```

## Target Measurement Plans

```bash
cnry measurement-plan discover <project> --sitemap-url https://example.com/sitemap.xml --rule discovery-rule.yaml
cnry measurement-plan discover <project> --sitemap-url https://example.com/sitemap.xml --rule discovery-rule.json --max-urls 500
cnry measurement-plan show <project>                    # active immutable revision
cnry measurement-plan show <project> --revision 2       # one historical revision
cnry measurement-plan versions <project>
cnry measurement-plan publish <project> plan.yaml       # legacy schema v1 only; refuses over an active v2 plan (use: measurement-plan advanced <project> draft-action)
cnry measurement-plan report <project> --revision 2     # stored evidence only; never starts provider work
cnry measurement-plan retire <project> <stable-key>
```

`discover` fetches a public sitemap and applies an operator-supplied deterministic
route rule to project-owned URLs. It returns explicit proposed, alias, shared, unmatched, and excluded
buckets; it does not infer queries or publish a plan. A rule file uses this
shape:

```yaml
primary:
  host: example.com
  pathTemplate: /locations/{slug}
aliases:
  - host: directory.example
    pathTemplate: /{slug}
excludedSlugSuffixes:
  - blog
```

Review discovery output, author the plan, and publish it as a separate action.
`report` is pinned to one immutable revision and reads stored run evidence. It
does not execute providers.

## Scheduling & Notifications

```bash
cnry schedule set <project> --preset daily     # or: weekly, twice-daily, daily@09
cnry schedule set <project> --cron "0 9 * * *" --timezone America/New_York
cnry schedule set <project> --kind data-refresh --preset daily   # refresh all connected GSC/Bing/GA/GBP integrations (no --source)
cnry schedule set <project> --kind backlinks-sync --preset weekly # re-probe Common Crawl; sync only when a newer rolling window is published (no --source/--provider)
cnry schedule set <project> --kind site-audit --preset weekly     # Technical AEO: bounded full-site crawl and audit (no --source/--provider)
cnry schedule show <project>
cnry schedule enable <project>
cnry schedule disable <project>
cnry schedule remove <project>

cnry notify add <project> --webhook <url> --events citation.lost,citation.gained
cnry notify events                             # list all available event types
cnry notify list <project>
cnry notify remove <project> <id>
cnry notify test <project> <id>
```

Available events: `citation.lost`, `citation.gained`, `run.completed`, `run.failed`, `insight.critical`, `insight.high`

`insight.critical` and `insight.high` fire when the intelligence engine generates critical- or high-severity insights after a sweep completes.

> **No mention events yet.** Notification events cover the citation signal only — there are **no** `mention.lost` / `mention.gained` events today. For mention-first monitoring, read `scores.mentionCoverage` / `scores.mentionShare` via `cnry overview` (or the `insight.*` events, which can be driven by mention-side insights); do not wire automation to mention events that aren't emitted.

## Provider Settings & Quotas

```bash
cnry settings                                  # show config: providers, apiUrl, db path
cnry settings --format json
cnry settings provider gemini --api-key <KEY> --model gemini-2.5-flash
cnry settings provider openai --max-per-day 1000 --max-per-minute 20
cnry settings provider perplexity --api-key <KEY>
```

Quota flags: `--max-concurrent`, `--max-per-minute`, `--max-per-day`

Available providers: `gemini`, `openai`, `claude`, `perplexity`, `local`, `cdp`

If a provider hits rate limits (429 errors), the run completes as `partial`. Reduce concurrency or increase time between sweeps.

### Gemini Vertex AI

Gemini supports Vertex AI as an alternative to API key authentication. Use GCP Application Default Credentials (ADC) or a service account JSON key file:

```bash
# Via env vars (recommended for servers)
export GEMINI_VERTEX_PROJECT=my-gcp-project
export GEMINI_VERTEX_REGION=us-central1            # optional, defaults to us-central1
export GEMINI_VERTEX_CREDENTIALS=/path/to/sa.json  # optional, falls back to ADC

# Or in canonry.yaml config
# vertexProject, vertexRegion, vertexCredentials fields under provider config
```

When Vertex AI is configured, no `GEMINI_API_KEY` is required. The provider uses the `@google-cloud/vertexai` SDK with `googleAuthOptions` for credential handling.

## API Keys

Mint, list, and revoke the `cnry_…` bearer tokens stored in the `api_keys` table. Keys are stored as a sha256 hash, never in plaintext.

```bash
cnry key list                                  # table: NAME / PREFIX / SCOPES / REACH / CREATED / LAST USED / STATUS
cnry key list --format json|jsonl              # jsonl streams one key per line
cnry key create --name ci-bot                  # mint a full-access key (scopes default to *)
cnry key create --name reader --read-only      # read-only key: scopes=['read'], denied every write HTTP method
cnry key create --name reader --scope read     # narrower key; repeat --scope or comma-separate (--scope a,b)
cnry key create --name ci-bot --format json    # JSON output includes the plaintext key
cnry key revoke <id>                           # revoke (does not delete); effective on the next request
cnry key whoami [--format json]                # introspect the CURRENT key (name, scopes, readOnly, status)
```

- **`--read-only` keys can read everything but write nothing.** The server denies every mutating method (POST/PUT/PATCH/DELETE) for a read-only key (`403 FORBIDDEN`); GET/HEAD pass. `--read-only` is sugar for `--scope read` and cannot be combined with `--scope`. The key DTO carries a derived `readOnly: boolean`. Point `canonry-mcp` at a read-only key and it auto-restricts to read tools.

- **Create returns the plaintext key exactly once.** It is shown with a "Save this now — it will not be shown again." warning (and is included in the JSON under `key`). It cannot be recovered later, so persist it on receipt.
- **List never exposes the hash or plaintext** — only safe metadata (id, name, prefix, scopes, created / last-used / revoked timestamps).
- **Mutations are gated by the `keys.write` scope.** The default key from `cnry init` carries `*`, which satisfies it. A narrower key needs `keys.write` to mint or revoke.
- **Revoke is not delete.** It sets `revokedAt`; the auth layer rejects the key on the next request. Revoking an already-revoked key is a no-op. You cannot revoke the key you are currently authenticating with (use a different key).

## Google Search Console

```bash
cnry google connect <project>                          # initiate OAuth flow
cnry google disconnect <project>                       # disconnect GSC
cnry google status <project>                           # connection status
cnry google properties <project>                       # list available properties
cnry google set-property <project> <url>               # set GSC property URL
cnry google set-sitemap <project> <url>                # set sitemap URL
cnry google list-sitemaps <project>                    # list submitted sitemaps
cnry google submit-sitemap <project> <url...>           # submit up to 50 explicit sitemap URLs
cnry google submit-sitemap <project> --configured       # submit Canonry's saved default
cnry google submit-sitemap <project> --all              # prefer sitemap indexes (fallback: top-level files)
cnry google submit-sitemap <project> --all-files        # include top-level files and index children (batched by 50)
cnry google discover-sitemaps <project> --wait         # auto-discover and inspect

cnry google sync <project>                             # sync GSC data
cnry google sync <project> --days 30 --full --wait     # full sync with wait
# `--full` re-fetches 480 days (GSC's 16-month retention ceiling) and is also the
# BACKFILL path: it repopulates the accurate per-query totals (`dimensions:
# ['date','query']`, no `page` fan-out) and the property daily totals for the
# whole retained window, not just recent days. Run it once per project after
# upgrading to pick up accurate history; a normal sync only covers its own window.

cnry google coverage <project>                         # index coverage summary
cnry google refresh <project>                         # force-fetch fresh GSC coverage data
cnry google performance <project>                      # search performance data
cnry google performance <project> --days 30 --keyword "term" --page "/url"
cnry google performance <project> --start 2026-06-01 --end 2026-06-30
cnry google performance <project> --order-by impressions --limit 2000 --offset 2000
# Rows are ordered by clicks descending by default; --order-by date|impressions
# changes the ranking. --days and --start/--end are mutually exclusive.
# One page, not the whole set: the response reports the total number of matching
# rows, and the CLI prints how many of them you are looking at. Never sum these
# rows for a property total, use `cnry google performance-daily`.
cnry google performance-daily <project>                # per-day series + property-level window totals
cnry google top-pages <project>                        # pages ranked by clicks, aggregated in SQL
cnry google top-pages <project> --start 2026-06-01 --end 2026-06-30 --limit 20

cnry google inspect <project> <url>                    # inspect specific URL
cnry google inspect-sitemap <project> --wait           # bulk inspect all sitemap URLs
cnry google inspections <project>                      # inspection history
cnry google inspections <project> --url <url>          # filter by URL
cnry google deindexed <project>                        # pages that lost indexing

cnry google request-indexing <project> <url>           # push URL to Google
cnry google request-indexing <project> --all-unindexed # push all unknown pages
```

**The dimensioned search-data table is valid for RANKING and invalid for TOTALS.** Read
any clicks/impressions total from the property-level daily figures (`performance-daily`
totals, or the `totals` block on `top-pages`), never by summing per-query or per-page rows.

Why: Google withholds rare/anonymised queries, so the dimensioned sum UNDER-counts clicks,
and one impression fans out across every query x page x country x device combination, so it
OVER-counts impressions. Measured on one real property-month: 792 summed clicks against
1,142 actual (31% under) and 45,266 summed impressions against 34,916 actual (30% over).
`top-pages` labels its total `totalsSource: "property-daily"` and returns `null` when no
property-level figure covers the window: a missing total, not a wrong one.

## Discovery (Tracked-Basket Expansion)

```bash
cnry discover run <project> --icp "..." --wait --format json    # full pipeline: seed → embed → cluster → probe → bucket
cnry discover run <project> --icp "..." --dedup-threshold 0.95  # tune cosine threshold (default 0.95)
cnry discover run <project> --icp "..." --max-probes 100         # per-session probe budget (default 100, hard cap 500)
cnry discover run <project> --icp "..." --probe-concurrency 3    # parallel probe workers (default 1 = serial, hard cap 8); probe rows stay in canonical order
cnry discover run <project> --icp-angle "angle 1" --icp-angle "angle 2" --wait  # multi-angle: one session per ICP angle, useful for hyperlocal/niche businesses
cnry discover run <project> --icp "..." --locations michigan,florida  # geo-constrain seed generation to a subset of project locations (omit = all project locations)

cnry discover list <project>                                     # newest-first session list
cnry discover show <project> <session-id>                        # per-query probe rows + buckets + classified competitor domains
cnry discover harvest <project> <session-id>                     # gated candidate seeds from the model's issued search-query fan-out (read-only; nothing is probed/tracked/promoted)
cnry discover harvest <project> <session-id> --min-probe-hits 2 --no-anchor   # raise the recurrence floor / disable the subject anchor
cnry discover promote preview <project> <session-id>             # preview bucketed candidates + recurring suggested competitors of every classified type (read-only)
cnry discover promote <project> <session-id>                     # adopt cited + aspirational queries + direct-competitor domains
cnry discover promote <project> <session-id> --competitor-types direct-competitor,editorial-media   # widen the competitor merge to other classified types
cnry discover promote <project> <session-id> --bucket aspirational --no-competitors   # scope to a bucket subset / skip competitor merge
```

Discovery requires Gemini configured (API key today; Vertex-mode embeddings are deferred). The pipeline writes a `discovery_sessions` row, a `runs` row (kind `aeo-discover-probe`), and one `discovery.basket-divergence` insight when the session completes. `discover harvest` is a separate read-only view over a completed session: it reads the search queries the answer engine actually issued to answer each probe (Gemini's `groundingMetadata.webSearchQueries` fan-out, already stored in the probe's `raw_response`) back out — no new model call — runs a mandatory quality gate (drops navigational/phone lookups, over-specific outliers, off-subject acronym collisions, exact already-tracked matches, and — via an embedding cosine pass over your tracked queries — semantic duplicates like paraphrases/synonyms that exact match can't see) and returns the survivors ranked by how many distinct probes issued each one. The output's `semanticNoveltyApplied` reports whether the embedding pass ran (it falls back to exact-match when no Gemini key is configured). These are a third signal — *issued retrieval queries*, neither "mention" nor "cited" — and carry no demand of their own; they are candidate seeds, so review them and add the good ones with `cnry query add`. Use `--min-probe-hits` to require recurrence and `--no-anchor` to allow new-subject discovery on a well-scoped project. Seed generation is location-aware: a project with locations configured (or a `--locations` label subset) geo-constrains the seed prompt so generated queries stay inside the service area, and a multi-location project gets a per-area seed quota so one area cannot dominate — `--locations` labels must match the project's configured locations or the run is rejected; projects with no locations are unaffected. After probing, one Gemini call classifies every recurring cited domain as `direct-competitor`, `ota-aggregator`, `editorial-media`, or `other` (a failed/legacy classification leaves domains `unknown`). Aero wakes unprompted with the bucket-count payload so the operator can act without polling. `discover eval` (quality-regression panel vs committed baseline, exit 1 on regression, --update-baseline to capture), `discover promote` defaults to cited + aspirational queries and `direct-competitor` domains only — aggregators and editorial media are suppressed; pass `--competitor-types` to widen the merge (or to recover legacy `unknown` entries) and `--bucket wasted-surface` for off-ICP competitor gaps. Promotion is add-only and idempotent — queries/domains already tracked are reported as skipped, never inserted twice — and only works on `completed` sessions; promoted rows carry `provenance="discovery:<sessionId>"`.

## Bing Webmaster Tools

```bash
cnry bing connect <project> --api-key <key>   # connect Bing WMT
cnry bing disconnect <project>                # disconnect
cnry bing status <project>                    # connection status
cnry bing sites <project>                     # list verified sites
cnry bing set-site <project> <url>            # set active site URL
cnry bing coverage <project>                  # URL coverage data
cnry bing refresh <project>                  # force-fetch fresh Bing coverage data
cnry bing inspect <project> <url>             # inspect specific URL
cnry bing inspect-sitemap <project>           # discover sitemap URLs and inspect each via Bing
cnry bing inspect-sitemap <project> --sitemap-url <url> --wait  # explicit sitemap, wait for run
cnry bing inspections <project>               # inspection history
cnry bing request-indexing <project> <url>    # submit URL for indexing
cnry bing request-indexing <project> --all-unindexed  # submit all unindexed
cnry bing performance <project>               # search performance data
```

## WordPress Integration

```bash
cnry wordpress connect <project> --url <url> --user <user>   # connect (prompts for app password)
cnry wordpress disconnect <project>                          # disconnect
cnry wordpress status <project>                              # connection status
cnry wordpress pages <project> [--live|--staging]            # list pages
cnry wordpress page <project> <slug>                         # show page detail
cnry wordpress create-page <project> --title <t> --slug <s> --content <c>  # create page
cnry wordpress update-page <project> <slug> --content <c>   # update page
cnry wordpress set-meta <project> <slug> --title <t>        # set SEO meta (single page)
cnry wordpress set-meta <project> --from <file>              # bulk set SEO meta from JSON
cnry wordpress schema <project> <slug>                       # read page JSON-LD
cnry wordpress schema deploy <project> --profile <file>      # deploy schema from profile
cnry wordpress schema status <project>                       # schema status per page
cnry wordpress set-schema <project> <slug>                   # manual schema handoff
cnry wordpress audit <project>                               # audit pages for SEO issues
cnry wordpress diff <project> <slug>                         # compare live vs staging
cnry wordpress staging status <project>                      # staging config status
cnry wordpress staging push <project>                        # manual staging push handoff
cnry wordpress llms-txt <project>                            # read /llms.txt
cnry wordpress set-llms-txt <project>                        # manual llms.txt handoff
cnry wordpress onboard <project> --url <url> --user <user>  # full onboarding workflow
```

**Onboard** runs: connect → audit → set-meta → schema deploy → Google submit → Bing submit. Use `--skip-schema` or `--skip-submit` to skip steps. `--profile <file>` provides business data and page-to-schema mapping for schema deployment.

## Server-Side Traffic

Cloudflare supports direct push and Queue pull. Run Cloudflare connect only from
the local host that owns the Canonry configuration and Wrangler profile. This
operation is not available through MCP because it uses local credentials.

```bash
# Direct push to a stable public Canonry HTTPS receiver:
cnry traffic connect cloudflare <project> \
  --delivery-mode direct-push \
  --zone-id <zone-id> --account-id <account-id> \
  --deploy --confirm-route --confirm-fail-open

# Create the Queue and enable its HTTP pull consumer first:
wrangler queues create canonry-traffic-<project>
# Workers Paid only: use this command to change the four-day default.
wrangler queues update canonry-traffic-<project> \
  --message-retention-period-secs <seconds>
wrangler queues info canonry-traffic-<project>
wrangler queues consumer http add canonry-traffic-<project>

# Queue pull keeps the API token in the local Canonry credential store:
cnry traffic connect cloudflare <project> \
  --delivery-mode queue-pull \
  --zone-id <zone-id> --account-id <account-id> \
  --queue-id <queue-id> --queue-name canonry-traffic-<project> \
  --api-token-file <mode-0600-token-file> \
  --retention-seconds <actual-queue-retention-seconds> \
  --deploy --confirm-route --confirm-fail-open
```

Workers Free retention is fixed at `86400` seconds. Workers Paid defaults to
`345600` seconds. If you change paid retention with `wrangler queues update`,
pass the same value to Canonry. The Canonry flag does not change the Queue.

Both commands deploy an unattached Worker. Attach the exact site route in the
Cloudflare Dashboard. Then set its request-limit failure mode to **Fail open**.
Do not put the Queue API token on the command line or in an agent transcript.

```bash
# If connect reports activationRequired, activate after the route is live:
cnry traffic activate <project> --source <source-id>
cnry traffic sync <project> --source <source-id>      # pull adapters, including Cloudflare Queue pull
cnry traffic sources <project> --format json
cnry traffic status <project> --format json
cnry traffic events <project> --source <source-id> --format json

cnry doctor --project <project> --check 'traffic.source.*' --format json
cnry schedule show <project> --kind traffic-sync --format json
cnry schedule set <project> --kind traffic-sync \
  --source <source-id> --cron "*/10 * * * *"
```

A first source becomes active automatically. A staged source stays paused until
the explicit activation command. Activation pauses sibling sources and moves the
one `traffic-sync` schedule for the project. Direct push rejects `traffic sync` and
does not use this schedule.

Queue pull drains at most 1,000 messages in one default sync. The doctor warns
when the remaining backlog is more than 1,000 messages. If the operator approves
a manual drain, run a manual sync. If the backlog recurs, get approval to shorten
the schedule interval.

Read the [server-side traffic guide](server-side-traffic.md) for token safety,
route checks, activation order, smoke tests, rollback, and troubleshooting.

## Google Analytics 4

GA4 integration supports service-account auth and OAuth (`canonry google connect <project> --type ga4`). With OAuth, `ga properties` lists the readable properties so the numeric id `ga connect --property-id` needs can be discovered without leaving canonry. The service account must have Viewer access on the GA4 property. `ga sync` writes to four DB tables (`gaTrafficSnapshots`, `gaAiReferrals`, `gaSocialReferrals`, `gaTrafficSummaries`); every subsequent read command queries the local store rather than re-fetching from GA4, so reads are fast and quotaless. AI-referral rows are tracked across 10 known providers (chatgpt, perplexity, claude, gemini, openai, anthropic, copilot, phind, you.com, meta.ai), three GA4 attribution dimensions (`session` / `first_user` / `manual_utm`), and joined to landing pages. Social referrals are split Organic vs Paid via GA4's `sessionDefaultChannelGroup`. All commands support `--format json`.

```bash
cnry ga connect <project> --property-id <id> --key-file ./sa-key.json
                                                  # connect via service account (auth method = service_account)
cnry ga disconnect <project>                  # disconnect; deletes all synced rows for the project
cnry ga status <project>                      # connected, propertyId, authMethod, lastSyncedAt
cnry ga properties <project>                  # list GA4 properties the connected account can read,
                                                  # with their numeric ids. OAuth connections only —
                                                  # the id cannot be derived from the domain or the grant
cnry ga sync <project> [--days 30] [--only traffic|ai|social]
                                                  # refresh from GA4 → DB; --only restricts which slice is replaced
                                                  # returns: synced, rowCount, aiReferralCount, socialReferralCount,
                                                  #          syncedComponents, syncedAt
cnry ga measurement-analysis <project> [--window 30d|60d|90d]
    [--host-scope marketing|all] [--path-prefix /blog] [--limit 100]
                                                  # fixed 30-day cohorts across native GA4 channels,
                                                  # configured lead events, branded/non-brand GSC demand,
                                                  # ranked landing pages/queries, and independent freshness/errors
                                                  # for acquisition and leads
cnry ga traffic <project> [--window 30d] [--start YYYY-MM-DD] [--end YYYY-MM-DD]
                                                  # current-period rollup; returns: totalSessions,
                                                  # totalOrganicSessions/totalDirectSessions/totalUsers,
                                                  # organicSharePct/aiSharePct/socialSharePct/directSharePct,
                                                  # topPages[], aiReferrals[], aiReferralLandingPages[],
                                                  # aiSessionsDeduped, aiSessionsBySession, socialReferrals[]
                                                  # (sessions only — the AI-referral user counts were withdrawn
                                                  #  in 4.135.0; GA counts users distinct per grain)
cnry ga attribution <project> [--trend]       # unified channel breakdown (organic / ai / social / direct
                                                  # sessions + raw and display share %s); --trend adds 7d/30d
                                                  # direction per channel + biggest mover
cnry ga ai-referral-daily <project> [--window 30d] [--start YYYY-MM-DD] [--end YYYY-MM-DD]
                                                  # AI sessions per day and per source: days[] with
                                                  # {date, sessions, paidSessions, organicSessions,
                                                  # bySource[]} + window totals. Landing pages summed inside
                                                  # ONE attribution dimension, never across dimensions, so
                                                  # totalSessions equals aiSessionsDeduped from `ga traffic`.
                                                  # Use this for any AI session COUNT. Sessions only: GA
                                                  # counts users DISTINCT per grain, so an AI-referral user
                                                  # count cannot be summed from these rows or fetched.
cnry ga ai-referral-history <project> [--window 30d] [--start YYYY-MM-DD] [--end YYYY-MM-DD]
                                                  # RAW DETAIL, one row per (day × source × dimension ×
                                                  # landing page): {date, source, medium, attribution,
                                                  # landingPage, sessions, users}. Rows are fragments of a
                                                  # day, commonly worth 1 session each. Never collapse them
                                                  # into a total; read ai-referral-daily instead.
cnry ga social-referral-history <project> [--window 30d] [--start YYYY-MM-DD] [--end YYYY-MM-DD]
                                                  # daily array of {date, source, medium, channel,
                                                  # sessions, users}; channel ∈ {Organic Social, Paid Social}
cnry ga social-referral-summary <project> [--trend]
                                                  # one-line social rollup: socialSessions, socialUsers,
                                                  # socialSharePct, topSources[]; --trend adds 7d/30d direction
cnry ga session-history <project> [--window 30d] [--start YYYY-MM-DD] [--end YYYY-MM-DD]
                                                  # daily totals: {date, sessions, organicSessions, users}
cnry ga coverage <project>                    # per-page overlay: {landingPage, sessions,
                                                  # organicSessions, users}
```

`--window` is rolling from now, so it can never name a calendar month. Pass `--start` / `--end` (inclusive, `YYYY-MM-DD`) for a calendar range; explicit dates win over `--window`. An unrecognised `--window` value is now REJECTED with a validation error rather than silently returning the full history under the label the caller asked for.

Every read command queries persisted DB rows, so a stale `lastSyncedAt` means the response is stale — always check `ga status` before drawing conclusions, and re-`ga sync` if the data is older than the analysis window. Use `--only ai` or `--only social` to refresh just one slice when iterating.

## Google Business Profile (Local AEO)

GBP integration tracks how AI engines see a business's local presence — search-keyword impressions, daily performance metrics, hotel lodging attributes, and booking CTAs. It reuses the **Google OAuth client** (same `google.clientId`/`clientSecret` as GSC; the connection is stored under the `gbp` connection type). **Hard prerequisite:** the Google Cloud project must be approved through Google's Business Profile API Basic Access form, or every call returns HTTP 403 at 0 QPM. See `references/google-business-profile.md` for the full GCP-setup + access-request playbook, the reviews/Q&A gating, and real-world data-shape quirks.

Like GA4, `gbp sync` writes to local DB tables and every read command queries the local store — reads are fast and quotaless; a stale sync means stale reads. All commands support `--format json`.

```bash
cnry gbp connect <project> [--public-url <url>]   # OAuth connect (reuses the Google client)
cnry gbp disconnect <project>                      # remove the GBP connection + ALL synced GBP data
cnry gbp accounts <project>                        # list GBP accounts this connection can access
                                                   # (account selection is per project — pick one below)
cnry gbp locations discover <project> [--account accounts/{n}] [--switch-account] [--no-select-new]
                                                   # discover a chosen account's locations; --account targets a
                                                   # specific account (omit = the account the project already tracks,
                                                   # else the first visible one); --switch-account opts into the
                                                   # destructive re-point to a different account; selects all new by default
cnry gbp locations <project> [--selected-only]     # list discovered locations + selection state
cnry gbp locations select   <project> --location locations/{n}
cnry gbp locations deselect <project> --location locations/{n}
                                                   # only SELECTED locations are synced
cnry gbp sync <project> [--location locations/{n}] [--days N] [--months N] [--wait]
                                                   # fires the gbp-sync run: daily metrics + keyword impressions
                                                   # + place-action links + lodging snapshot per selected location;
                                                   # --wait polls to a terminal run status
cnry gbp metrics <project> [--location locations/{n}] [--metric <DailyMetric>]
                                                   # stored daily metrics + totals-by-metric
cnry gbp keywords <project> [--location locations/{n}]
                                                   # stored search-keyword impressions over the synced
                                                   # periodStart..periodEnd window; renders exact counts and
                                                   # <N thresholded floors + a thresholdedPct fidelity stat
cnry gbp place-actions <project> [--location locations/{n}]
                                                   # booking / reservation / order CTAs per location, with
                                                   # placeActionType, providerType (MERCHANT vs AGGREGATOR), isPreferred, uri
cnry gbp lodging <project> [--location locations/{n}]
                                                   # latest hotel-attribute snapshot per location (snapshot-on-change):
                                                   # populatedGroupCount + syncedAt; populatedGroupCount=0 means the Lodging
                                                   # API returns no structured attributes (common even for complete hotels;
                                                   # verify the "Hotel details" panel), a verify signal, not a confirmed gap
cnry gbp places <project> [--location locations/{n}]
                                                   # latest Places-API rendered-listing snapshot per location: the
                                                   # server-derived `amenities` the public listing advertises (#648 cross-reference).
                                                   # Needs a Places API key (places.apiKey / GOOGLE_PLACES_API_KEY)
cnry gbp summary <project> [--location locations/{n}]
                                                   # composite scorecard: performance totals + recent-vs-prior 7d
                                                   # deltas (deltaPct null when prior=0), keyword coverage,
                                                   # place-action CTA presence flags, Lodging API readable-group counts,
                                                   # owner-content profile completeness (secondary categories /
                                                   # description / service area / hours / phone + closed-status counts)
```

`gbp sync` produces a run with the standard statuses (`completed` / `partial` / `failed`); `partial` means some selected locations synced and others errored (the per-location errors are on the run). Non-lodging locations are skipped cleanly (Google answers the lodging call with HTTP 400, not 404). Reviews are **not** synced — the v4 Reviews API is producer-restricted by Google and unavailable on most projects; the Q&A API was retired (2025-11-03).

## Google Ads + Google Tag Manager conversion integrity

`google-ads` and `gtm` are separate first-class namespaces. **`ads` remains
OpenAI / ChatGPT Ads**; do not use it for Google Ads. Canonry v1 only reads
provider state: it never changes a Google Ads campaign/conversion action/goal,
and it never edits or publishes GTM.

```bash
# OAuth is an explicit same-browser operator flow. Start and confirm it from
# the project's Conversion Integrity dashboard; the CLI does not print OAuth URLs.

cnry google-ads status <project>                 # local connection + selection/freshness only
cnry google-ads customers <project> --format jsonl
cnry google-ads select <project> --customer <customer-id> [--login-customer <manager-id>]
cnry google-ads sync <project>                   # bounded read-only queries (GET + SearchStream POST) + redacted snapshots
cnry google-ads snapshots <project> --format jsonl
cnry google-ads snapshot <project> <snapshot-id>
cnry google-ads disconnect <project>             # removes private credential; retains redacted evidence

cnry gtm status <project>                         # local connection + selection/freshness only
cnry gtm accounts <project> --format jsonl
cnry gtm containers <project> --account <account-id> --format jsonl
cnry gtm workspaces <project> --account <account-id> --container <container-id> --format jsonl
cnry gtm select <project> --account <account-id> --container <container-id> [--workspace <workspace-id>]
cnry gtm sync <project>                           # bounded provider GETs + redacted live/draft snapshots
cnry gtm snapshots <project> --format jsonl
cnry gtm snapshot <project> <snapshot-id>
cnry gtm disconnect <project>                     # removes private credential; retains redacted evidence

# One contract joins business meaning to the selected Google Ads action and GTM graph.
cnry conversion-tracking contracts <project> --format jsonl
cnry conversion-tracking contracts get <project> <contract-id>
cnry conversion-tracking contracts create <project> --input contract.json
cnry conversion-tracking contracts update <project> <contract-id> --input contract.json
cnry conversion-tracking contracts delete <project> <contract-id>
cnry conversion-tracking contracts integrity <project> <contract-id> --format jsonl
```

Use this purchase contract as `contract.json`:

```json
{
  "name": "Purchase completed",
  "eventName": "purchase",
  "googleAds": {
    "customerId": "1234567890",
    "conversionActionId": "987654321",
    "conversionId": "AW-1234567890",
    "conversionLabel": "purchase_label",
    "campaignIds": [],
    "requireBiddableGoal": true,
    "requirePrimaryAction": true
  },
  "gtm": {
    "accountId": "123456",
    "containerId": "654321",
    "tagId": "42",
    "triggerIds": ["17"],
    "variableIds": ["21", "22", "23"]
  },
  "runtime": {
    "verificationRequired": true,
    "requireTransactionId": true,
    "requireValue": true,
    "requireCurrency": true,
    "productionHosts": ["example.com"]
  }
}
```

Replace every example ID with a canonical ID from the current snapshots. Use
the Ads customer ID without dashes, the conversion-action `id`, and each GTM
resource `id`. Do not use GTM resource paths or the public `GTM-...` container
ID.

Empty campaign, trigger, or variable arrays disable their corresponding
assertions. Canonry checks `requireBiddableGoal` only for listed campaigns. If
you do not know the exact GTM-facing values, omit `conversionId` and
`conversionLabel`. Do not supply server-owned IDs or timestamps.

Use the
[Google Marketing setup guide](https://github.com/Canonry/canonry/blob/main/docs/google-marketing.md)
for the operator workflow.

Stored snapshot and contract reads are local, redacted, and quota-free. Customer,
account, container, and workspace discovery plus sync are live Google reads; the
caller needs `google-marketing.read-live` in addition to normal write authority
for a sync. `google-ads sync` captures conversion actions and the **effective
per-campaign goal graph**; `gtm sync` captures sanitized live and selected-draft
configuration graphs. They do not prove a browser event fired or that Google Ads
recorded a conversion.

The integrity result is intentionally monotonic:

- `configured` means a contract exists but its static graph is unproven or inconsistent.
- `statically-consistent` means the stored Ads and GTM evidence agrees.
- `runtime-unverified` means the static graph agrees but runtime proof is missing.
- `observed` means static and trusted runtime evidence are both present.

The default Canonry runtime does not store runtime evidence in version 1. A
runtime-required contract therefore stops at `runtime-unverified`.

A selected GTM draft workspace produces stored draft evidence. Integrity uses
the live container graph and does not assess the draft graph.

Treat unrecognized GTM custom HTML/templates as `unknown` / needs-review, never
as a pass. An Ads action's `primaryForGoal` flag is not proof that a campaign
effectively bids toward it; inspect the effective campaign goal evidence.

`--format jsonl` streams one record per line for Google Ads customers and
snapshots, GTM accounts/containers/workspaces and snapshots, and
conversion-tracking contracts. Each line is stamped with `project`; live
discovery rows also include `fetchedAt`. Integrity JSONL streams deterministic
findings, each stamped with `project`, `contractId`, `integrityStatus`, and
`evaluatedAt`. Status, sync, one-snapshot, one-contract, connect/select, and
disconnect commands emit their normal JSON document when passed `--format
jsonl`.

## OpenAI ads (ChatGPT ads)

Paid-surface data for the project's connected OpenAI ad account. Ads render only in the ChatGPT consumer UI (never in API answers), so the Advertiser API is the only window into the paid layer. Money is integer micros in all stored/JSON data; insights `ctr`/`cpcMicros` are derived server-side and `null` on zero denominators. Paid metrics are "paid"/"sponsored" — never conflate with organic `cited`/`mentioned`.

```
cnry ads connect <project> --api-key <sdk-key>   # mint the key in OpenAI Ads Manager; validated upstream, stored in ~/.canonry/config.yaml
cnry ads status <project>
cnry ads account <project>                        # live account identity, currency/timezone, status, and integrity review
cnry ads geo search <project> --query "New York" --limit 20 --format jsonl
cnry ads conversions pixels <project> --format jsonl
cnry ads conversions event-settings <project> --format jsonl
cnry ads image upload <project> --input image.json
cnry ads campaign create <project> --input campaign.json
cnry ads campaign update <project> <campaign-id> --input update.json
cnry ads campaign pause <project> <campaign-id> --input pause.json
cnry ads ad-group create <project> --input group.json
cnry ads ad-group update <project> <ad-group-id> --input update.json
cnry ads ad-group pause <project> <ad-group-id> --input pause.json
cnry ads ad create <project> --input ad.json
cnry ads ad update <project> <ad-id> --input update.json
cnry ads ad pause <project> <ad-id> --input pause.json
cnry ads operation <project> <operation-key>     # inspect one durable mutation receipt
cnry ads operations unresolved <project> --limit 100 --format json
                                                   # list pending/unknown/reconciling receipts before new writes
cnry ads operations unresolved <project> --cursor <nextCursor> --limit 100 --format json
                                                   # advance past permanent rows with the opaque keyset cursor
cnry ads operation reconcile <project> --operation-key <key>
                                                   # verify nonactivation provider state; never retries the mutation
cnry ads operation resume-activation <project> --operation-key <key>
                                                   # exact-executor recovery for an existing activation receipt; no body
cnry ads activation-grant create <project> --input grant.json
                                                   # human approval for one exact tree + executor key + expiry
cnry ads activation-grant revoke <project> <grant-id>
                                                   # revoke only while the grant is unused
cnry ads campaign activate-tree <project> <campaign-id> --input activate.json
                                                   # executor consumes the exact approved grant
cnry ads sync <project>                          # ads-sync run: entity snapshots + daily rollups
cnry ads campaigns <project> --format jsonl      # lifecycle timestamps, location IDs, context hints, creative file IDs
cnry ads insights <project> --level campaign --from 2026-06-01 --format jsonl
cnry ads summary <project>                       # campaign-level totals only (no double counting)
cnry ads delivery-diagnostics <project>          # stored snapshot provenance, configuration facts, historical campaign activity
cnry ads live-delivery <project> --campaign <id> # LIVE provider read + stored-snapshot delta (read-only, bounded, 1/min per project)
cnry ads disconnect <project>
cnry schedule set <project> --kind ads-sync --preset daily
```

`ads sync` runs report `completed` / `partial` (some campaigns failed; per-campaign errors on the run) / `failed`. Doctor checks: `ads.auth.connection`, `ads.data.recent-sync` (both skipped when not connected).

The stored rollups include the ad account's CURRENT local day while it is still
running, so the newest date is a partial figure that grows on every sync. Do not
compare it against a finished day, and do not fold it into a period total
without saying so. Every read that can reach it says which date it is:
`ads insights` flags the row (`inProgress: true`), and `ads summary` /
`ads delivery-diagnostics` carry `window.inProgressDate` (null when the window
holds only closed days). "Current" means current in the ACCOUNT's timezone, not
yours.

One number on that row is not just partial, it is missing: conversions. OpenAI
will not report a conversion count for a day that is still open, so the current
day always shows 0 conversions no matter what actually happened. The real
figure lands on the first sync after the day closes. Impressions, clicks, and
spend are live on that row as usual.

`ads account`, `ads geo search`, and both `ads conversions` commands read the
live OpenAI Advertiser API rather than the local synced snapshot. Use `account`
to verify the connected advertiser and review state, `geo search` to resolve
campaign `locationIds` from provider-issued IDs, and the conversion reads to
verify the available pixel/CAPI sources, event goal, and attribution window
before launch. Geo search defaults to 20 results and accepts 1-100. Its JSONL
rows carry `{ project, query, ...location }`; conversion rows carry
`{ project, ...pixel }` or `{ project, ...eventSetting }`.

`ads delivery-diagnostics` reads stored snapshot provenance, stored
configuration, and historical campaign activity only. It is never a live OpenAI
serving or eligibility verdict. Agents must branch on `snapshot.status` /
`issue` and `assessment.state`; partial or unavailable structure must not be
treated as current provider state.

`ads live-delivery` is the opposite lane: it calls the provider RIGHT NOW and
returns the provider's current status and metrics per campaign / ad group / ad,
unaggregated and in the provider's own units, next to the stored snapshot values
and an explicit per-entity delta. Reach for it when the stored snapshot is
contradicted by the advertiser UI, not for routine checks: it is read-only but
it spends a third-party call budget, so one project may issue at most one live
read per minute (`429` with `retryAfterMs` otherwise). The attempt is counted as
soon as the provider is called, so a `502` still costs the interval: on an
upstream failure wait out `retryAfterMs` instead of retrying straight away. Read
`bounds.truncated` before concluding anything about entities you did not see,
and treat `presence: "stored-only"` as "absent upstream" ONLY on an untruncated,
error-free read. In `metricDeltas`, every date except the account's current
local day compares whole days on both sides, so a difference there is real; the
current local day is still accruing live while the stored side stopped at the
last sync, so a difference on it is snapshot staleness. `--lookback-days` (1-30,
default 7) sizes the metrics window; `--campaign` scopes the walk.

Lifecycle inputs are JSON files, or `--input -` for stdin. Every request carries
a unique `operationKey`. Identical replays return the stored receipt without a
second upstream request. Before issuing new lifecycle writes, run `ads
operations unresolved`; if a receipt is `pending`, `unknown`, or `reconciling`,
do not retry with a different key. Branch on `kind`: use `ads operation
resume-activation` for `campaign_tree_activate`, and generic `ads operation
reconcile` for other supported receipts. Generic reconciliation only reads and
verifies provider state. It never re-sends the mutation or accepts a
caller-selected provider entity. Canonry resolves a generic receipt only when
the provider ID was durably checkpointed and its live state matches the stored
safe fields on the receipt-bound account. An uncheckpointed create remains
unresolved because mutable-field equality cannot prove which request created an
entity. A pending generic receipt must be idle for five minutes before either a
human or the sweeper may claim it, so recovery cannot race a request that is
still returning from the provider. Automatic inconclusive inspections back off
from a five-minute base; explicit operator requests may inspect sooner, but
every generic path stops after five attempts. The receipt then remains visible
as `unknown` with `ADS_RECONCILIATION_QUARANTINED` and requires manual provider
remediation. JSON list responses return `nextCursor`; pass it back unchanged
with the same project and state filter to continue.
Creates are always paused. Updates require the entity to
already be paused and `expectedUpdatedAt` to equal the latest
`upstreamUpdatedAt` from `ads campaigns` after a sync. Canonry exposes pause as
the kill switch and deliberately omits archive and direct entity activation.
A human can instead approve one exact campaign tree for a different executor
key. The short-lived grant pins every campaign/ad-group/ad ID and
`expectedUpdatedAt`; execution rechecks the account and ad review gates, then
activates ads first, ad groups second, and the campaign last. Each step is
durably checkpointed. A failure rolls back the campaign before its children,
and an ambiguous outcome fails closed for manual remediation.

`biddingType` and `conversionEventSettingIds` are separate decisions.
`biddingType` is what the account is BILLED for (`clicks`, or the legacy
`impressions` default) and the provider makes it immutable after creation. Each
child ad group must then set `billingEventType` to `click` under a `clicks`
campaign, and Canonry rejects any ad-group billing mode that does not match its
live parent campaign before writing to the provider.
`conversionEventSettingIds` is what delivery OPTIMIZES toward: pass exact values
returned by `ads conversions event-settings` to get a conversion-optimized
campaign. A `clicks` campaign may omit them: click billing without conversion
tracking is a supported configuration. Canonry rejects duplicate conversion IDs.
Omit both fields to preserve the legacy impressions/impression mode.

Campaign updates may omit `locationIds` to preserve current geo targeting or
pass a non-empty list to replace it. The guarded operator cannot pass `null` or
an empty list to clear targeting. OpenAI documents that clearing targeting can
make the campaign eligible for all available locations, so an intentional
all-location change remains a human action in Ads Manager. See
[Campaign Targeting](https://developers.openai.com/ads/campaign-targeting) and
the [campaign update contract](https://developers.openai.com/ads/api-reference/campaigns#update-a-campaign).

### Guarded operator release gates

Default external automation to a project-scoped API key with exactly `read`,
`ads.write`, and `ads.activate`; never hand an external operator an unscoped
key:

```bash
canonry key create --name ads-operator --project <project> \
  --scope read --scope ads.write --scope ads.activate
canonry key create --name ads-approver --project <project> \
  --scope read --scope ads.approve
```

Keep the plaintext keys separate. The human approval request must authenticate
with the `ads-approver` key and name the operator key's ID as
`executorApiKeyId`; Canonry refuses a grant whose approver and executor IDs are
the same. Approval create/revoke exist in REST and CLI only. MCP and Aero expose
`activate-tree` plus bodyless recovery of its existing receipt, so the ads
operator cannot mint, replace, or widen its own grant.

The grant request is strict JSON. Its entity arrays must be uniquely sorted by
provider ID so the manifest has one canonical hash:

```json
{
  "manifest": {
    "campaign": {
      "id": "cmpn_...",
      "expectedUpdatedAt": 1780868842,
      "adGroups": [{
        "id": "adgrp_...",
        "expectedUpdatedAt": 1780864410,
        "ads": [{ "id": "ad_...", "expectedUpdatedAt": 1781139491 }]
      }]
    }
  },
  "executorApiKeyId": "key_...",
  "expiresAt": "2026-07-18T18:00:00.000Z"
}
```

The approval response returns `grant.id` and `grant.manifestHash`. Pass those
unchanged to the operator:

```json
{
  "operationKey": "launch:campaign:2026-07-18:1",
  "grantId": "grant_...",
  "manifestHash": "64-lowercase-hex-characters"
}
```

Before enabling spend on an advertiser account, run a paused, disposable
live-provider smoke test and capture sanitized raw responses for campaign get,
create, and pause. For every response, verify and record the exact case and type
of `status`, plus the type and exact returned value of `updated_at`. The
captured responses must agree with the typed client and fixtures without
coercion. After explicit budget approval, repeat the check through one minimal
grant-bound activate-tree execution and immediate campaign pause; verify every
activation response reports exact `active` plus an integer `updated_at`.

The receipt lifecycle is safe across concurrent writers: an atomic claim picks
one upstream sender and losers replay the canonical receipt. A leased generic
reconciler settles supported stale `pending` / `unknown` rows by verifying
provider state. Exact credential/account verification is cached for five
minutes, keyed by a one-way credential fingerprint plus the project and stored
account identity; credential rotation or account rebinding misses the cache
immediately. Activation receipts keep their grant and ordered step ledger
authoritative: only the exact bound executor may call the bodyless resume route,
which cannot substitute a manifest, grant, account, or campaign. When another
worker owns reconciliation or activation recovery, callers wait and read the
canonical receipt instead of starting a second pass.

## Backlinks (Common Crawl)

Canonry actively ingests backlinks from **Common Crawl**, a free public hyperlink graph that refreshes about monthly. The workspace-level release sync downloads each release once and reuses it across projects; per-project extraction requires DuckDB (install once with `cnry backlinks install`).

Databases created by older Canonry versions can retain historical `source=bing-webmaster` rows. Read filters remain compatible with those inert rows, but Canonry no longer fetches or refreshes them.

Common Crawl publishes the hyperlink graph as **rolling, monthly-stepped, overlapping 3-month windows** named by the window's first month's year: `cc-main-YYYY-<mon>-<mon>-<mon>` (e.g. `cc-main-2026-mar-apr-may`). Omit `--release` to auto-discover the newest published window.

```bash
cnry backlinks install                         # install bundled DuckDB binary
cnry backlinks doctor                          # show install + plugin status
cnry backlinks status                          # latest workspace Common Crawl release sync
cnry backlinks releases                        # list cached releases on disk
cnry backlinks releases latest                 # probe Common Crawl for the newest published rolling window
cnry backlinks sync                            # Common Crawl: auto-discover + download + query the newest release (workspace-wide)
cnry backlinks sync --release cc-main-2026-mar-apr-may --wait   # pin a window, block until ready/failed
cnry backlinks sources <project>               # active readiness + retained source data
cnry backlinks sources <project> --exclude-crawlers   # counts drop crawler/proxy hosts (matches the dashboard)
cnry backlinks list <project>                  # top Common Crawl linking domains
cnry backlinks list <project> --limit 100 --release <id>
cnry backlinks extract <project> --release <id> --wait  # Common Crawl: re-extract against a ready release
cnry backlinks cache prune --release <id>      # delete cached release files from disk
```

All commands support `--format json`; collection commands (`list`, `sources`, `releases`) also support `--format jsonl`. A Common Crawl release sync has statuses `queued` → `downloading` → `querying` → `ready` / `failed`. Per-project extracts use the standard run statuses (`queued` → `running` → `completed` / `failed`). Projects with `autoExtractBacklinks` enabled get an extract enqueued automatically when a release sync transitions to `ready`.

**`jsonl` output schema:** `backlinks list` streams `rows` (each `{ project, release, targetDomain, linkingDomain, numHosts, source }`); `backlinks sources` streams the per-source availability list (`{ project, targetDomain, source, connected, hasData, latestRelease, totalLinkingDomains, lastSyncedAt }`); `backlinks releases` streams cached-release rows bare.

To keep backlinks fresh automatically, schedule a `backlinks-sync` kind (`cnry schedule set <project> --kind backlinks-sync --preset weekly`): each tick re-probes Common Crawl and runs the workspace release sync **only when a newer rolling window is published** (it skips when the newest `ready` sync already covers the latest release, so it never re-downloads a near-identical window).

## CDP / Browser Provider

The CDP (Chrome DevTools Protocol) provider enables browser-based queries against AI chat interfaces (e.g., ChatGPT). This gives more accurate results than API-based providers for some use cases.

```bash
cnry cdp connect --host localhost --port 9222  # connect to Chrome CDP
cnry cdp status                                # show connection status
cnry cdp targets                               # list available targets (ChatGPT, etc.)
cnry cdp screenshot <query> --targets chatgpt  # screenshot a query result
```

**Requires:** Chrome running with `--remote-debugging-port=9222`

## Telemetry

```bash
cnry telemetry status                          # show telemetry status
cnry telemetry enable                          # enable anonymous telemetry
cnry telemetry disable                         # disable telemetry
```

## Config as Code

```bash
cnry apply project.yaml                        # apply declarative config
cnry apply file1.yaml file2.yaml               # multiple files
cnry export <project> --include-results > project.yaml
cnry sitemap inspect <project>
```

## Agent

Canonry ships the built-in **Aero** agent (backed by pi-agent-core) for users
who don't already have one, plus a webhook integration for users who want to
drive Canonry from Claude Code / Codex / a custom agent.

### Built-in Aero (one-shot CLI)

```bash
# One-shot turn — Aero picks its own tools, streams events to stdout.
cnry agent ask <project> "<prompt>"
cnry agent ask <project> "<prompt>" --format json      # JSON event stream
cnry agent ask --all "<prompt>"                        # fan out the same prompt across every project
cnry agent ask <project> "<prompt>" --trace            # emit tool-execution detail for debugging

# Select a specific provider / model (otherwise auto-detected from config).
cnry agent ask <project> "<prompt>" --provider anthropic --model claude-opus-4-7
cnry agent ask <project> "<prompt>" --provider zai      --model glm-5.1
cnry agent ask <project> "<prompt>" --provider openai
cnry agent ask <project> "<prompt>" --provider google
cnry agent ask <project> "<prompt>" --provider deepinfra --model zai-org/GLM-5.2   # Western-hosted GLM/DeepSeek (key: DEEPINFRA_TOKEN)

# Restrict the tool surface. Default is --scope all (full read+write surface).
# --scope read-only matches the dashboard bar default so pasted "Copy as CLI"
# commands can't enable writes the UI turn couldn't perform.
cnry agent ask <project> "<prompt>" --scope read-only
cnry agent ask <project> "<prompt>" --scope all

# Session + provider introspection
cnry agent providers <project>                # list provider keys Aero will pick from + the resolved default
cnry agent transcript <project>               # dump the rolling transcript for the current session
cnry agent reset <project>                    # start a fresh session (drops in-memory state, keeps memory)
cnry agent clear <project>                    # delete the transcript row from the DB

# Durable project notes (the <memory> hydrate block on every new session)
cnry agent memory list <project>
cnry agent memory set <project> --key <k> --value <v>     # 2 KB cap per value
cnry agent memory forget <project> --key <k>
```

**Provider detection order** when `--provider` is omitted: `anthropic` →
`openai` → `google` → `zai` → `deepinfra`, whichever has an API key present
first (from `~/.canonry/config.yaml` providers block, or the matching env var
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `ZAI_API_KEY` /
`DEEPINFRA_TOKEN`). `deepinfra` (GLM-5.2) is a
Western-hosted OpenAI-compatible host — useful when the agent / analyze /
classify tiers must avoid PRC-hosted GLM (`zai`).

Conversations **persist per project** — `cnry agent ask` continues the
same rolling thread each invocation. Reset with `cnry agent reset <project>`
or via the dashboard bar's reset button.

### External agents (webhook)

```bash
# Wire an external agent webhook to a project
cnry agent attach <project> --url <webhook-url>        # register webhook subscription
cnry agent attach <project> --url <url> --format json  # JSON output
cnry agent detach <project>                            # remove the agent webhook
cnry agent detach <project> --format json              # JSON output
```

**Agent webhooks** fire on `run.completed`, `insight.critical`, `insight.high`, and `citation.gained`. The attach/detach pair is idempotent per project (one agent webhook per project, matched by source tag).

## Output Formats

Every command takes `--format`:

- **`text`** (default) — human-readable, decorated. Not a stable parse target.
- **`json`** — one pretty-printed JSON document (the full envelope). Stable contract.
- **`jsonl`** — newline-delimited JSON: the command's **primary collection**, one self-contained record per line. The agent-friendly machine format — no envelope key to guess (`.checks` vs `.results` vs `.rows`), no `jq` flattening, greppable line by line.

`jsonl` is supported by every **collection** command — one whose primary output is a list: `insights`, `runs`, `evidence`, `history`, `query/keyword/competitor list`, `notify list/events`, `google` reads (`performance`, `performance-daily`, `inspections`, `coverage-history`, `deindexed`, `status`, `properties`, `list-sitemaps`), `bing` reads (`coverage-history`, `inspections`, `performance`, `sites`), `ga` reads (`ai-referral-daily`, `ai-referral-history`, `social-referral-history`, `session-history`, `coverage`), `google-ads` customer/snapshot reads, `gtm` account/container/workspace/snapshot reads, conversion-tracking contracts and integrity findings, `ads geo search` and `ads conversions` reads, `traffic events/sources/status`, `discover list/show`, `content targets/sources/gaps/map`, `backlinks list/releases`, `project list/locations`, `key list`, `agent memory list`, `agent providers`, `sources` (streams the ranked cited-domain list), and `doctor`. (`content brief` is an object command — `jsonl` degrades to its JSON document.)

Each `jsonl` line re-injects the envelope context it would otherwise lose, so a line lifted out still self-describes:

- project-scoped lists stamp `{ "project": "<name>", …row }`;
- `ga *-history` also stamps `window`; `traffic events` stamps `windowStart`/`windowEnd`; `backlinks list` stamps `release`/`targetDomain`; `discover show` stamps `sessionId`; `content targets` stamps `latestRunId`; `project locations` stamps `isDefault`;
- global lists whose rows already self-identify (`project list`, `notify events`, `backlinks releases`) emit bare rows.

Empty collection → **no output** (the exit code still conveys success, so "no records" stays distinct from "failure"). On failure a command prints its records (if any), then exits non-zero — branch on the **exit code**, never on parsing stderr. JSON field names and the `{ "error": { "code", "message" } }` envelope are a public contract.

**Composite** commands return a single aggregate object (not a list), so there is nothing to stream — on them `--format jsonl` **degrades to the same JSON document** as `--format json`; it never falls through to decorated human text. So `--format jsonl` is safe to pass to *any* command: collection commands stream their records, every other command emits its JSON document. Composite shapes are below.

## Output schema per command

Compact reference for the composite / keyed commands agents read most (shapes can drift — the linked DTO source file is the source of truth; collection commands simply emit their primary array, see each command's own section above).

| Command | JSON output shape (top-level keys → DTO) | `jsonl` |
|---|---|---|
| `cnry doctor [--project p] [--all]` | `{ scope, project, generatedAt, durationMs, summary{total,ok,warn,fail,skipped}, checks[] }` — `DoctorReportDto` @ `contracts/doctor.ts`. `checks[]` = `CheckResultDto{ id, category, scope, title, status(ok\|warn\|fail\|skipped), code, summary, remediation?, details?, durationMs }`. With `--all`: an object keyed by `__global__` + each project name, each value a full report. | ✅ one check / line as `{project, …check}`; still exits non-zero if any `fail` |
| `cnry analytics <p> [--feature metrics\|gaps\|sources] [--window 7d\|30d\|90d\|all]` | Object **keyed by feature**: `{ metrics?, gaps?, sources? }` (all three present with no `--feature`; one with `--feature X`). `metrics`=`BrandMetricsDto{ window, buckets[], overall, byProvider, trend, mentionTrend, queryChanges[] }`; `gaps`=`GapAnalysisDto{ cited[], gap[], uncited[], mentionedQueries[], mentionGap[], notMentioned[], runId, window }` (each `[]`=`GapQuery`); `sources`=`SourceBreakdownDto` (same shape as `cnry sources`, below). @ `contracts/analytics.ts` | → degrades to the `json` document |
| `cnry sources <p> [--rank] [--limit N] [--by-provider] [--window …]` | `SourceBreakdownDto{ overall[], byQuery, ranked, byProvider, runId, window, limit }` @ `contracts/analytics.ts`. `ranked`/each `byProvider[name]` = `RankedSourceList{ totalCitedSlots, domainTotal, entries[], truncatedDomainCount, truncatedCitedSlots, bySurfaceClass[] }`; `entries[]`=`SourceRankEntry{ domain, count, percentage, category, label, surfaceClass }`; `bySurfaceClass[]`=`SurfaceClassCount{ surfaceClass, label, count, percentage, domainCount }`. `surfaceClass` ∈ own \| direct-competitor \| ota-aggregator \| editorial-media \| other. | ✅ streams `ranked.entries` one / line as `{project, …entry}` |
| `cnry visibility-stats <p> [--since <iso>] [--until <iso>] [--month <YYYY-MM>] [--last-runs N] [--by-provider] [--share-of-voice] [--query-class branded\|non-brand]` | `VisibilityStatsDto{ project, groupBy, window{since,until,lastRuns,runCount}, totals, byProvider?[], queries[], shareOfVoice? }` @ `contracts/visibility-stats.ts`. Each query / provider / totals entry = `{ total, checked, mentioned, cited, mentionRate, citedRate }` (+ `query`/`queryId`/`firstObserved`/`lastObserved` on queries, + `provider`/observed on provider entries). `checked`=snapshots with non-null `answerMentioned` (tri-state n for mention); `mentionRate=mentioned/checked`, `citedRate=cited/total`, both `null` on a 0 denominator. `byProvider`/per-query `providers` present only with `--by-provider`; counts sum to pooled. `--month YYYY-MM` echoes the resolved `window.since`/`until`. `shareOfVoice` present only with `--share-of-voice` = `{ queryClass, percent, projectMentions, competitorMentions, snapshotsWithAnswerText, perCompetitor[{domain,mentions}] }`; `percent` (0-100) = `projectMentions/(projectMentions+competitorMentions)`, `null` when no competitors configured. `queryClass` is what was actually served: `non-brand` (the default), `branded` (via `--query-class`), or `pooled` — which appears ONLY when the project has no usable brand alias to split by, never as a default. Branded and non-brand never share a denominator. | ✅ streams `queries` one / line as `{project, runCount, …query}` (envelope-only `shareOfVoice` not in the jsonl rows) |
| `cnry google coverage <p>` (index coverage) | `{ summary{total,indexed,notIndexed,deindexed,percentage}, lastInspectedAt, lastSyncedAt, indexed[], notIndexed[], deindexed[], reasonGroups[] }` — `GscCoverageSummaryDto` @ `contracts/google.ts`. `indexed[]`/`notIndexed[]`=`GscUrlInspectionDto`, `deindexed[]`=`GscDeindexedRowDto`. | → degrades to the `json` document. The single-array reads `google inspections` / `coverage-history` / `deindexed` **stream** `jsonl`. |
| `cnry ga measurement-analysis <p> [--window 30d\|60d\|90d] [--host-scope marketing\|all] [--path-prefix /…]` | `GaMeasurementAnalysisDto` @ `contracts/measurement.ts`: fixed 30-day `acquisition.periods/channels/pages`, configured-event `leads.periods/channels` with explicit attribution/filter scope, and `searchDemand.periods/queries/pages` with property totals, reported branded/non-brand rows, and unreported residuals. Each GA component carries independent status/error/sync freshness. | → degrades to the `json` document |
| `cnry ga traffic <p> [--window …]` | Object summary — `GA4TrafficSummaryDto` / `GaTrafficResponse` @ `contracts/ga.ts`: `{ totalSessions, totalOrganicSessions, totalDirectSessions, totalUsers, aiSessionsDeduped, paidAiSessionsDeduped, organicAiSessionsDeduped, aiSessionsBySession, paidAiSessionsBySession, organicAiSessionsBySession, socialSessions, socialUsers, channelBreakdown{organic,social,direct,ai,other→{sessions,sharePct,sharePctDisplay}}, *SharePct (+ `*Display`), topPages[], aiReferrals[], aiReferralLandingPages[], socialReferrals[], lastSyncedAt, periodStart, periodEnd }`. **AI referrals are sessions only.** The six `ai*Users*` fields and the `users` on `aiReferrals[]` / `aiReferralLandingPages[]` were withdrawn in 4.135.0 — GA reports users as a COUNT DISTINCT at the grain requested, so the stored column re-counted one visitor per landing page, medium, channel and date, and no un-dimensioned AI-referral fetch exists to supply a correct figure. `totalUsers` and `socialUsers` are unaffected. | → degrades to the `json` document |
| `cnry ga attribution <p> [--trend]` | Object — a **renamed projection** of `GaTrafficResponse` (⚠️ field names differ from the DTO): `aiSessions`(←`aiSessionsDeduped`), `organicSessions`(←`totalOrganicSessions`), `directSessions`(←`totalDirectSessions`), plus `totalSessions, totalUsers, paidAiSessions, organicAiSessions, aiSessionsBySession, paidAiSessionsBySession, organicAiSessionsBySession, socialSessions, socialUsers, {ai,social,organic,direct}SharePct (+ `*Display`), otherSessions, otherSharePct, channelBreakdown, aiReferrals[], aiReferralLandingPages[], socialReferrals[], periodStart, periodEnd`. With `--trend`: drops `periodStart/End`, adds `trend` (`GaAttributionTrendResponse`). Assembled inline in `commands/ga.ts`. | → degrades to the `json` document |
| `cnry key list` / `key create` / `key revoke <id>` | `list`: `{ keys[] }` — each `ApiKeyDto{ id, name, keyPrefix, scopes[], projectId, projectName, readOnly, createdAt, lastUsedAt, revokedAt }` (SAFE metadata, never the hash or plaintext). `create`: `CreatedApiKeyDto` = `ApiKeyDto` **plus a one-time `key`** (the plaintext `cnry_…` token, shown once). `revoke`: the `ApiKeyDto` with `revokedAt` set. @ `contracts/api-keys.ts` | `key list` streams one key / line; `create` / `revoke` degrade to the `json` document |
| `cnry gbp summary <p> [--location …]` | `{ scope{locationName,locationCount}, performance{totals,recent7d,prior7d,deltaPct} (metric-keyed maps; keys are raw `BUSINESS_*` / `WEBSITE_CLICKS` tokens — label via `formatGbpMetricLabel`), freshness{dataThroughDate,latestStoredDate,pendingDays}, timeseries[], keywords{total,thresholdedCount,thresholdedPct}, placeActions{total,hasReservationCta,hasBookingCta,hasDirectMerchantCta}, lodging{lodgingLocationCount,populatedLodgingCount,emptyLodgingCount}, profileCompleteness{locationCount,withSecondaryCategories,secondaryCategoryTotal,withDescription,withServiceArea,withHours,withPrimaryPhone,permanentlyClosed,temporarilyClosed} }` — `GbpSummaryDto` @ `contracts/gbp.ts`; `emptyLodgingCount` means 0 readable Lodging API groups, a verify signal rather than proof the Hotel details panel is empty. `timeseries[]`=`{date,pending,metrics}`. | → degrades to the `json` document |
| `cnry ads account <p>` | `AdsAccountDto{ id, name, status, currencyCode, timezone, url, reviewStatus, integrityReviewStatus, integrityDecision }` @ `contracts/ads.ts`. This is live provider state, not a synced snapshot. | → degrades to the `json` document |
| `cnry ads geo search <p> --query <text>` | `AdsGeoSearchResponse{ count, query, results[] }` @ `contracts/ads.ts`; each location has `{ id, type, canonicalName, countryCode, name, regionCode }`. | ✅ one result / line as `{project, query, …location}` |
| `cnry ads conversions pixels <p>` / `event-settings <p>` | `{ pixels[] }` / `{ eventSettings[] }` @ `contracts/ads.ts`. Event settings include the conversion event, attribution window, source IDs/details, archive state, and version. | ✅ one pixel/event setting / line as `{project, …row}` |
