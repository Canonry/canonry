# Canonry CLI Reference

The CLI is invoked as `cnry` (short form) or `canonry` — both ship with the `@ainyc/canonry` npm package and behave identically. This reference uses `cnry`.

## Server Management

```bash
cnry init                                      # interactive setup
cnry bootstrap                                 # non-interactive setup from env vars
cnry start                                     # start daemon
cnry stop                                      # stop daemon
cnry serve                                     # foreground mode
cnry serve --host 0.0.0.0 --port 4100
cnry --version
```

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

Use `--probe` whenever you're testing on your own initiative — verifying a fix landed, reproducing a regression, sanity-checking a query — rather than producing data the user/dashboard will consume.

`snapshot` does not create a project or write to the DB. It generates category queries, runs providers, and produces a report for prospecting.

## Citation Data

```bash
cnry evidence <project>                        # per-query cited/not-cited + mentioned/not-mentioned
cnry evidence <project> --format json          # JSON output
cnry history <project>                         # audit trail
cnry export <project> --include-results        # export as YAML
cnry backfill answer-visibility                # recompute citationState from stored answers
cnry backfill answer-visibility --dry-run      # preview which snapshots would change
cnry backfill answer-mentions                  # recompute answerMentioned from stored answers (honors brandAliases)
cnry backfill answer-mentions --dry-run
cnry backfill insights <project>               # recompute insights for completed runs
cnry backfill insights <project> --since 2026-04-01 --dry-run
```

Output uses a two-glyph cell per (query × provider): `[C/c][M/m]` — uppercase = present, lowercase = absent, `–` = no snapshot. Always print the legend before the table; never collapse the two signals into one cell.

Summary: `Cited: X / Y` and `Mentioned: X / Y` are reported independently — a query can be one, both, or neither.

## Reports

```bash
cnry report <project>                          # write canonry-report-<project>-YYYY-MM-DD.html
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

## Analytics

```bash
cnry analytics <project>                       # default analytics view
cnry analytics <project> --feature metrics     # citation rate trends
cnry analytics <project> --feature gaps        # brand gap analysis (cited/gap/uncited)
cnry analytics <project> --feature sources     # source breakdown by category
cnry analytics <project> --window 7d           # time window: 7d, 30d, 90d, all
```

## Intelligence

```bash
cnry insights <project>                        # list active insights (regressions, gains, opportunities)
cnry insights <project> --dismissed            # include dismissed insights
cnry insights <project> --format json          # JSON output
cnry insights dismiss <project> <id>           # dismiss an insight
cnry health <project>                          # latest citation health snapshot
cnry health <project> --history                # health trend over time
cnry health <project> --history --limit 10     # limit history entries
cnry health <project> --format json            # JSON output
cnry backfill insights <project>              # backfill insights for all completed runs
cnry backfill insights <project> --from-run <id> --to-run <id>  # backfill a range
```

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

## Scheduling & Notifications

```bash
cnry schedule set <project> --preset daily     # or: weekly, twice-daily, daily@09
cnry schedule set <project> --cron "0 9 * * *" --timezone America/New_York
cnry schedule set <project> --kind data-refresh --preset daily   # refresh all connected GSC/Bing/GA/GBP integrations (no --source)
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

## Google Search Console

```bash
cnry google connect <project>                          # initiate OAuth flow
cnry google disconnect <project>                       # disconnect GSC
cnry google status <project>                           # connection status
cnry google properties <project>                       # list available properties
cnry google set-property <project> <url>               # set GSC property URL
cnry google set-sitemap <project> <url>                # set sitemap URL
cnry google list-sitemaps <project>                    # list submitted sitemaps
cnry google discover-sitemaps <project> --wait         # auto-discover and inspect

cnry google sync <project>                             # sync GSC data
cnry google sync <project> --days 30 --full --wait     # full sync with wait

cnry google coverage <project>                         # index coverage summary
cnry google refresh <project>                         # force-fetch fresh GSC coverage data
cnry google performance <project>                      # search performance data
cnry google performance <project> --days 30 --keyword "term" --page "/url"

cnry google inspect <project> <url>                    # inspect specific URL
cnry google inspect-sitemap <project> --wait           # bulk inspect all sitemap URLs
cnry google inspections <project>                      # inspection history
cnry google inspections <project> --url <url>          # filter by URL
cnry google deindexed <project>                        # pages that lost indexing

cnry google request-indexing <project> <url>           # push URL to Google
cnry google request-indexing <project> --all-unindexed # push all unknown pages
```

## Discovery (Tracked-Basket Expansion)

```bash
cnry discover run <project> --icp "..." --wait --format json    # full pipeline: seed → embed → cluster → probe → bucket
cnry discover run <project> --icp "..." --dedup-threshold 0.85  # tune cosine threshold (default 0.85)
cnry discover run <project> --icp "..." --max-probes 100         # per-session probe budget (default 100, hard cap 500)
cnry discover run <project> --icp-angle "angle 1" --icp-angle "angle 2" --wait  # multi-angle: one session per ICP angle, useful for hyperlocal/niche businesses
cnry discover run <project> --icp "..." --locations michigan,florida  # geo-constrain seed generation to a subset of project locations (omit = all project locations)

cnry discover list <project>                                     # newest-first session list
cnry discover show <project> <session-id>                        # per-query probe rows + buckets + classified competitor domains
cnry discover promote preview <project> <session-id>             # preview bucketed candidates + recurring suggested competitors of every classified type (read-only)
cnry discover promote <project> <session-id>                     # adopt cited + aspirational queries + direct-competitor domains
cnry discover promote <project> <session-id> --competitor-types direct-competitor,editorial-media   # widen the competitor merge to other classified types
cnry discover promote <project> <session-id> --bucket aspirational --no-competitors   # scope to a bucket subset / skip competitor merge
```

Discovery requires Gemini configured (API key today; Vertex-mode embeddings are deferred). The pipeline writes a `discovery_sessions` row, a `runs` row (kind `aeo-discover-probe`), and one `discovery.basket-divergence` insight when the session completes. Seed generation is location-aware: a project with locations configured (or a `--locations` label subset) geo-constrains the seed prompt so generated queries stay inside the service area, and a multi-location project gets a per-area seed quota so one area cannot dominate — `--locations` labels must match the project's configured locations or the run is rejected; projects with no locations are unaffected. After probing, one Gemini call classifies every recurring cited domain as `direct-competitor`, `ota-aggregator`, `editorial-media`, or `other` (a failed/legacy classification leaves domains `unknown`). Aero wakes unprompted with the bucket-count payload so the operator can act without polling. `discover promote` defaults to cited + aspirational queries and `direct-competitor` domains only — aggregators and editorial media are suppressed; pass `--competitor-types` to widen the merge (or to recover legacy `unknown` entries) and `--bucket wasted-surface` for off-ICP competitor gaps. Promotion is add-only and idempotent — queries/domains already tracked are reported as skipped, never inserted twice — and only works on `completed` sessions; promoted rows carry `provenance="discovery:<sessionId>"`.

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

## Google Analytics 4

GA4 integration uses service account authentication (no OAuth). The service account must have Viewer access on the GA4 property. `ga sync` writes to four DB tables (`gaTrafficSnapshots`, `gaAiReferrals`, `gaSocialReferrals`, `gaTrafficSummaries`); every subsequent read command queries the local store rather than re-fetching from GA4, so reads are fast and quotaless. AI-referral rows are tracked across 10 known providers (chatgpt, perplexity, claude, gemini, openai, anthropic, copilot, phind, you.com, meta.ai), three GA4 attribution dimensions (`session` / `first_user` / `manual_utm`), and joined to landing pages. Social referrals are split Organic vs Paid via GA4's `sessionDefaultChannelGroup`. All commands support `--format json`.

```bash
cnry ga connect <project> --property-id <id> --key-file ./sa-key.json
                                                  # connect via service account (auth method = service_account)
cnry ga disconnect <project>                  # disconnect; deletes all synced rows for the project
cnry ga status <project>                      # connected, propertyId, authMethod, lastSyncedAt
cnry ga sync <project> [--days 30] [--only traffic|ai|social]
                                                  # refresh from GA4 → DB; --only restricts which slice is replaced
                                                  # returns: synced, rowCount, aiReferralCount, socialReferralCount,
                                                  #          syncedComponents, syncedAt
cnry ga traffic <project>                     # current-period rollup; returns: totalSessions,
                                                  # totalOrganicSessions/totalDirectSessions/totalUsers,
                                                  # organicSharePct/aiSharePct/socialSharePct/directSharePct,
                                                  # topPages[], aiReferrals[], aiReferralLandingPages[],
                                                  # aiSessionsDeduped, aiUsersBySession, socialReferrals[]
cnry ga attribution <project> [--trend]       # unified channel breakdown (organic / ai / social / direct
                                                  # sessions + raw and display share %s); --trend adds 7d/30d
                                                  # direction per channel + biggest mover
cnry ga ai-referral-history <project>         # daily array of {date, source, medium, attribution,
                                                  # sessions, users}; one row per (day × source × dimension)
cnry ga social-referral-history <project>     # daily array of {date, source, medium, channel,
                                                  # sessions, users}; channel ∈ {Organic Social, Paid Social}
cnry ga social-referral-summary <project> [--trend]
                                                  # one-line social rollup: socialSessions, socialUsers,
                                                  # socialSharePct, topSources[]; --trend adds 7d/30d direction
cnry ga session-history <project>             # daily totals: {date, sessions, organicSessions, users}
cnry ga coverage <project>                    # per-page overlay: {landingPage, sessions,
                                                  # organicSessions, users}
```

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
                                                   # populatedGroupCount + syncedAt; empty profiles are an AEO gap, not an error
cnry gbp summary <project> [--location locations/{n}]
                                                   # composite scorecard: performance totals + recent-vs-prior 7d
                                                   # deltas (deltaPct null when prior=0), keyword coverage,
                                                   # place-action CTA presence flags, lodging completeness counts
```

`gbp sync` produces a run with the standard statuses (`completed` / `partial` / `failed`); `partial` means some selected locations synced and others errored (the per-location errors are on the run). Non-lodging locations are skipped cleanly (Google answers the lodging call with HTTP 400, not 404). Reviews are **not** synced — the v4 Reviews API is producer-restricted by Google and unavailable on most projects; the Q&A API was retired (HTTP 501).

## Backlinks (Common Crawl)

Workspace-level Common Crawl release sync + per-project backlink extraction. Requires DuckDB; install once with `cnry backlinks install`. Releases are downloaded once per workspace and reused across all projects.

```bash
cnry backlinks install                         # install bundled DuckDB binary
cnry backlinks doctor                          # show install + plugin status
cnry backlinks status                          # latest workspace release sync
cnry backlinks releases                        # list cached releases on disk
cnry backlinks sync --release <id>             # download + query a release (workspace-wide)
cnry backlinks sync --release <id> --wait      # block until ready/failed
cnry backlinks list <project>                  # top linking domains for the project
cnry backlinks list <project> --limit 100 --release <id>
cnry backlinks extract <project>               # re-extract this project against the latest ready release
cnry backlinks extract <project> --release <id> --wait
cnry backlinks cache prune --release <id>      # delete cached release files from disk
```

All commands support `--format json`. A release sync has statuses `queued` → `downloading` → `querying` → `ready` / `failed`. Per-project extract runs use the standard run statuses (`queued` → `running` → `completed` / `failed`). Projects with the `autoExtractBacklinks` setting enabled get an extract run enqueued automatically when a release sync transitions to `ready`.

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
`openai` → `google` → `zai`, whichever has an API key present first
(from `~/.canonry/config.yaml` providers block, or the matching env var
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `ZAI_API_KEY`).

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

Most commands support `--format json` for machine-readable output.
