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
cnry serve --embed --embed-allow-origin https://app.example.com   # read-only embed mode (#716)
cnry --version
```

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

Use `--probe` whenever you're testing on your own initiative — verifying a fix landed, reproducing a regression, sanity-checking a query — rather than producing data the user/dashboard will consume.

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

Per-query mention (answer-text) and citation (source-list) **counts with a sample size**, pooled across many answer-visibility runs — the data to compute a confidence-aware proportion (e.g. Wilson) or detect drift without fetching every run. Backed by `GET /api/v1/projects/<name>/visibility-stats` and the `canonry_visibility_stats` MCP tool. Probe runs and non-`answer-visibility` runs are excluded; only completed/partial runs count. `--share-of-voice` adds a pooled head-to-head vs tracked competitors (`project / (project + competitor)` brand mentions) — the primitive for a month-over-month client report: call it with `--month <this>` and `--month <last>` and compare.

```bash
cnry visibility-stats <project>                                   # all runs; per-query cited/total + mentioned/checked + pooled TOTAL
cnry visibility-stats <project> --last-runs 10                    # most recent 10 runs (mutually exclusive with --since/--until/--month)
cnry visibility-stats <project> --since 2026-06-01 --until 2026-06-30   # ISO date/time window on run createdAt
cnry visibility-stats <project> --month 2026-06                    # a whole calendar month (YYYY-MM), expanded to that month's UTC bounds
cnry visibility-stats <project> --by-provider                     # per-provider breakdown (counts sum to the pooled counts)
cnry visibility-stats <project> --month 2026-06 --share-of-voice   # pooled share of voice vs competitors for the month (the m/m report primitive)
cnry visibility-stats <project> --format jsonl                    # stream one record per query, stamped with project + runCount
```

- **Tri-state aware:** `checked` counts only snapshots where `answerMentioned` was recorded — `null` ("not checked") is **excluded**, never counted as not-mentioned. So `checked` is the correct `n` for a mention proportion. `mentionRate = mentioned/checked`; `citedRate = cited/total` (citation_state is always populated, so the citation `n` is `total`). Both rates are `null` when their denominator is 0 (undefined over no samples).
- **Date-only window:** `--since`/`--until` accept a full ISO instant or a bare `YYYY-MM-DD`. A date-only `--until 2026-06-30` covers the **whole** UTC day (through 23:59:59.999), so same-day runs are included; a date-only `--since` is that day's start.
- **Unbounded by default:** with no `--since`/`--until`/`--last-runs`, every completed/partial run is pooled (`window.runCount` reports how many). For a recent sample, bound it with `--last-runs N`.
- **`groupBy` in the payload:** present (`"provider"`) only with `--by-provider`; omitted otherwise (absent = no breakdown) — the generated SDK types it `groupBy?: 'provider'`.
- **mention vs cited stay independent** — a model can do either, both, or neither. Don't read one from the other.

## Technical AEO (site audit)

Site-wide technical audit (structured data, AI-readable content, AI-crawler access, content depth/freshness/extractability, …) powered by `@ainyc/aeo-audit`'s `runSitemapAudit`. Runs as the `site-audit` run kind — crawls the project's `sitemap.xml` and scores every reachable page, then rolls up into one 0–100 site score. Pure HTTP, no LLM cost; a large site can take minutes, so it runs in the background.

```bash
cnry technical-aeo run <project> --wait                 # crawl + audit; --wait polls to terminal. Idempotent: returns the in-flight run if one is active.
cnry technical-aeo run <project> --sitemap-url <url> --limit 200   # override the sitemap / cap pages (highest <priority> first; default 500, max 2000)
cnry technical-aeo score <project> [--format json]      # site score + per-factor scorecard (avg + pass/partial/fail per page) + delta vs the previous audit
cnry technical-aeo pages <project> [--status error] [--sort score-asc|score-desc|url] [--format json|jsonl]   # per-page breakdown of the latest run (worst-first by default)
cnry technical-aeo trend <project> [--format json|jsonl] # aggregate-score history across past audits
cnry schedule set <project> --kind site-audit --preset weekly   # keep it fresh
```

- The score is only available after at least one audit runs — `score` returns `hasData: false` until then.
- Reads reflect the latest **completed/partial** site-audit run; probe runs are excluded.

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

## Scheduling & Notifications

```bash
cnry schedule set <project> --preset daily     # or: weekly, twice-daily, daily@09
cnry schedule set <project> --cron "0 9 * * *" --timezone America/New_York
cnry schedule set <project> --kind data-refresh --preset daily   # refresh all connected GSC/Bing/GA/GBP integrations (no --source)
cnry schedule set <project> --kind backlinks-sync --preset weekly # re-probe Common Crawl; sync only when a newer rolling window is published (no --source/--provider)
cnry schedule set <project> --kind site-audit --preset weekly     # Technical AEO: crawl the sitemap + audit every page (no --source/--provider)
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
cnry key list                                  # table: NAME / PREFIX / SCOPES / CREATED / LAST USED / STATUS
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
cnry discover run <project> --icp "..." --dedup-threshold 0.95  # tune cosine threshold (default 0.95)
cnry discover run <project> --icp "..." --max-probes 100         # per-session probe budget (default 100, hard cap 500)
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

Discovery requires Gemini configured (API key today; Vertex-mode embeddings are deferred). The pipeline writes a `discovery_sessions` row, a `runs` row (kind `aeo-discover-probe`), and one `discovery.basket-divergence` insight when the session completes. `discover harvest` is a separate read-only view over a completed session: it reads the search queries the answer engine actually issued to answer each probe (Gemini's `groundingMetadata.webSearchQueries` fan-out, already stored in the probe's `raw_response`) back out — no new model call — runs a mandatory quality gate (drops navigational/phone lookups, over-specific outliers, off-subject acronym collisions, exact already-tracked matches, and — via an embedding cosine pass over your tracked queries — semantic duplicates like paraphrases/synonyms that exact match can't see) and returns the survivors ranked by how many distinct probes issued each one. The output's `semanticNoveltyApplied` reports whether the embedding pass ran (it falls back to exact-match when no Gemini key is configured). These are a third signal — *issued retrieval queries*, neither "mention" nor "cited" — and carry no demand of their own; they are candidate seeds, so review them and add the good ones with `cnry query add`. Use `--min-probe-hits` to require recurrence and `--no-anchor` to allow new-subject discovery on a well-scoped project. Seed generation is location-aware: a project with locations configured (or a `--locations` label subset) geo-constrains the seed prompt so generated queries stay inside the service area, and a multi-location project gets a per-area seed quota so one area cannot dominate — `--locations` labels must match the project's configured locations or the run is rejected; projects with no locations are unaffected. After probing, one Gemini call classifies every recurring cited domain as `direct-competitor`, `ota-aggregator`, `editorial-media`, or `other` (a failed/legacy classification leaves domains `unknown`). Aero wakes unprompted with the bucket-count payload so the operator can act without polling. `discover promote` defaults to cited + aspirational queries and `direct-competitor` domains only — aggregators and editorial media are suppressed; pass `--competitor-types` to widen the merge (or to recover legacy `unknown` entries) and `--bucket wasted-surface` for off-ICP competitor gaps. Promotion is add-only and idempotent — queries/domains already tracked are reported as skipped, never inserted twice — and only works on `completed` sessions; promoted rows carry `provenance="discovery:<sessionId>"`.

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

## OpenAI ads (ChatGPT ads)

Paid-surface data for the project's connected OpenAI ad account. Ads render only in the ChatGPT consumer UI (never in API answers), so the Advertiser API is the only window into the paid layer. Money is integer micros in all stored/JSON data; insights `ctr`/`cpcMicros` are derived server-side and `null` on zero denominators. Paid metrics are "paid"/"sponsored" — never conflate with organic `cited`/`mentioned`.

```
cnry ads connect <project> --api-key <sdk-key>   # mint the key in OpenAI Ads Manager; validated upstream, stored in ~/.canonry/config.yaml
cnry ads status <project>
cnry ads sync <project>                          # ads-sync run: entity snapshots + daily rollups
cnry ads campaigns <project> --format jsonl      # snapshots incl. context hints (newline-separated example queries)
cnry ads insights <project> --level campaign --from 2026-06-01 --format jsonl
cnry ads summary <project>                       # campaign-level totals only (no double counting)
cnry ads disconnect <project>
cnry schedule set <project> --kind ads-sync --preset daily
```

`ads sync` runs report `completed` / `partial` (some campaigns failed; per-campaign errors on the run) / `failed`. Doctor checks: `ads.auth.connection`, `ads.data.recent-sync` (both skipped when not connected).


## Backlinks (source-aware: Common Crawl + Bing Webmaster)

Backlinks are **source-aware** — every read takes a `--source commoncrawl|bing-webmaster` filter (default `commoncrawl`) and rows are tagged with their source:

- **Common Crawl** — free public hyperlink graph, ~monthly. Workspace-level release sync + per-project extract. Requires DuckDB (install once with `cnry backlinks install`). Releases download once per workspace and reuse across projects.
- **Bing Webmaster** — live first-party inbound links from a connected Bing account (`cnry bing connect <project> --api-key <key>`). Per-project; pull with `cnry backlinks bing-sync`.

Common Crawl publishes the hyperlink graph as **rolling, monthly-stepped, overlapping 3-month windows** named by the window's first month's year: `cc-main-YYYY-<mon>-<mon>-<mon>` (e.g. `cc-main-2026-mar-apr-may`). Omit `--release` to auto-discover the newest published window. Bing windows are synthetic per-UTC-day snapshots (`bing-YYYY-MM-DD`).

```bash
cnry backlinks install                         # install bundled DuckDB binary (Common Crawl only)
cnry backlinks doctor                          # show install + plugin status
cnry backlinks status                          # latest workspace Common Crawl release sync
cnry backlinks releases                        # list cached releases on disk
cnry backlinks releases latest                 # probe Common Crawl for the newest published rolling window
cnry backlinks sync                            # Common Crawl: auto-discover + download + query the newest release (workspace-wide)
cnry backlinks sync --release cc-main-2026-mar-apr-may --wait   # pin a window, block until ready/failed
cnry backlinks sources <project>               # per-source availability (connected / has-data / latest window / freshness)
cnry backlinks sources <project> --exclude-crawlers   # availability counts drop crawler/proxy hosts (matches the dashboard)
cnry backlinks bing-sync <project>             # Bing: pull live inbound links for the project (needs Bing connected)
cnry backlinks bing-sync <project> --wait      # block until the sync run completes
cnry backlinks list <project>                  # top linking domains (Common Crawl, default)
cnry backlinks list <project> --source bing-webmaster   # top linking domains from Bing inbound links
cnry backlinks list <project> --limit 100 --release <id>
cnry backlinks extract <project> --release <id> --wait  # Common Crawl: re-extract against a ready release
cnry backlinks cache prune --release <id>      # delete cached release files from disk
```

All commands support `--format json`; collection commands (`list`, `sources`, `releases`) also support `--format jsonl`. A Common Crawl release sync has statuses `queued` → `downloading` → `querying` → `ready` / `failed`. Per-project extract / Bing-sync runs use the standard run statuses (`queued` → `running` → `completed` / `failed`). Projects with `autoExtractBacklinks` enabled get a Common Crawl extract enqueued automatically when a release sync transitions to `ready`; Bing-connected projects with a `backlinks-sync` schedule get a Bing pull each tick.

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

`jsonl` is supported by every **collection** command — one whose primary output is a list: `insights`, `runs`, `evidence`, `history`, `query/keyword/competitor list`, `notify list/events`, `google` reads (`performance`, `performance-daily`, `inspections`, `coverage-history`, `deindexed`, `status`, `properties`, `list-sitemaps`), `bing` reads (`coverage-history`, `inspections`, `performance`, `sites`), `ga` reads (`ai-referral-history`, `social-referral-history`, `session-history`, `coverage`), `traffic events/sources/status`, `discover list/show`, `content targets/sources/gaps/map`, `backlinks list/releases`, `project list/locations`, `key list`, `agent memory list`, `agent providers`, `sources` (streams the ranked cited-domain list), and `doctor`. (`content brief` is an object command — `jsonl` degrades to its JSON document.)

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
| `cnry visibility-stats <p> [--since <iso>] [--until <iso>] [--month <YYYY-MM>] [--last-runs N] [--by-provider] [--share-of-voice]` | `VisibilityStatsDto{ project, groupBy, window{since,until,lastRuns,runCount}, totals, byProvider?[], queries[], shareOfVoice? }` @ `contracts/visibility-stats.ts`. Each query / provider / totals entry = `{ total, checked, mentioned, cited, mentionRate, citedRate }` (+ `query`/`queryId`/`firstObserved`/`lastObserved` on queries, + `provider`/observed on provider entries). `checked`=snapshots with non-null `answerMentioned` (tri-state n for mention); `mentionRate=mentioned/checked`, `citedRate=cited/total`, both `null` on a 0 denominator. `byProvider`/per-query `providers` present only with `--by-provider`; counts sum to pooled. `--month YYYY-MM` echoes the resolved `window.since`/`until`. `shareOfVoice` present only with `--share-of-voice` = `{ percent, projectMentions, competitorMentions, snapshotsWithAnswerText, perCompetitor[{domain,mentions}] }`; `percent` (0-100) = `projectMentions/(projectMentions+competitorMentions)`, `null` when no competitors configured. | ✅ streams `queries` one / line as `{project, runCount, …query}` (envelope-only `shareOfVoice` not in the jsonl rows) |
| `cnry google coverage <p>` (index coverage) | `{ summary{total,indexed,notIndexed,deindexed,percentage}, lastInspectedAt, lastSyncedAt, indexed[], notIndexed[], deindexed[], reasonGroups[] }` — `GscCoverageSummaryDto` @ `contracts/google.ts`. `indexed[]`/`notIndexed[]`=`GscUrlInspectionDto`, `deindexed[]`=`GscDeindexedRowDto`. | → degrades to the `json` document. The single-array reads `google inspections` / `coverage-history` / `deindexed` **stream** `jsonl`. |
| `cnry ga traffic <p> [--window …]` | Object summary — `GA4TrafficSummaryDto` / `GaTrafficResponse` @ `contracts/ga.ts`: `{ totalSessions, totalOrganicSessions, totalDirectSessions, totalUsers, aiSessionsDeduped, aiUsersDeduped, aiSessionsBySession, aiUsersBySession, socialSessions, socialUsers, channelBreakdown{organic,social,direct,ai,other→{sessions,sharePct,sharePctDisplay}}, *SharePct (+ `*Display`), topPages[], aiReferrals[], aiReferralLandingPages[], socialReferrals[], lastSyncedAt, periodStart, periodEnd }`. | → degrades to the `json` document |
| `cnry ga attribution <p> [--trend]` | Object — a **renamed projection** of `GaTrafficResponse` (⚠️ field names differ from the DTO): `aiSessions`(←`aiSessionsDeduped`), `organicSessions`(←`totalOrganicSessions`), `directSessions`(←`totalDirectSessions`), plus `totalSessions, totalUsers, aiUsers, aiSessionsBySession, aiUsersBySession, socialSessions, socialUsers, {ai,social,organic,direct}SharePct (+ `*Display`), otherSessions, otherSharePct, channelBreakdown, aiReferrals[], aiReferralLandingPages[], socialReferrals[], periodStart, periodEnd`. With `--trend`: drops `periodStart/End`, adds `trend` (`GaAttributionTrendResponse`). Assembled inline in `commands/ga.ts`. | → degrades to the `json` document |
| `cnry key list` / `key create` / `key revoke <id>` | `list`: `{ keys[] }` — each `ApiKeyDto{ id, name, keyPrefix, scopes[], createdAt, lastUsedAt, revokedAt }` (SAFE metadata, never the hash or plaintext). `create`: `CreatedApiKeyDto` = `ApiKeyDto` **plus a one-time `key`** (the plaintext `cnry_…` token, shown once). `revoke`: the `ApiKeyDto` with `revokedAt` set. @ `contracts/api-keys.ts` | `key list` streams one key / line; `create` / `revoke` degrade to the `json` document |
| `cnry gbp summary <p> [--location …]` | `{ scope{locationName,locationCount}, performance{totals,recent7d,prior7d,deltaPct} (metric-keyed maps; keys are raw `BUSINESS_*` / `WEBSITE_CLICKS` tokens — label via `formatGbpMetricLabel`), freshness{dataThroughDate,latestStoredDate,pendingDays}, timeseries[], keywords{total,thresholdedCount,thresholdedPct}, placeActions{total,hasReservationCta,hasBookingCta,hasDirectMerchantCta}, lodging{lodgingLocationCount,populatedLodgingCount,emptyLodgingCount}, profileCompleteness{locationCount,withSecondaryCategories,secondaryCategoryTotal,withDescription,withServiceArea,withHours,withPrimaryPhone,permanentlyClosed,temporarilyClosed} }` — `GbpSummaryDto` @ `contracts/gbp.ts`; `emptyLodgingCount` means 0 readable Lodging API groups, a verify signal rather than proof the Hotel details panel is empty. `timeseries[]`=`{date,pending,metrics}`. | → degrades to the `json` document |
