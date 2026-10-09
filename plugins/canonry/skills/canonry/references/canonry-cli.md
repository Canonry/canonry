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
cnry project update <name> --dispatch-mode claude=batch   # scheduled sweeps batch this provider (repeatable; see Batch mode below)
cnry project update <name> --clear-dispatch-mode claude   # back to sync
cnry project update <name> --negative-review-max-stars 2   # review.negative for 1-2 star Google reviews only (1-4, or "default" for 3)
cnry project update <name> --site-audit-max-pages 2500   # Site Health page budget for scans that set none (1-50000, or "full" for the full site); create takes it too, spec.siteAuditMaxPages in apply
cnry project update <name> --competitor-auto-aliases apply   # store answer-derived competitor names after each sweep (off | preview | apply; default preview logs only); spec.competitorAutoAliases in apply
cnry project update <name> --add-qualified-alias "Acme NYC"      # sentiment treats this existing alias as the brand's own name (see Brand aliases)
cnry project update <name> --remove-qualified-alias "Acme NYC"   # repeatable; create takes --qualified-alias
cnry project delete <name>                     # delete a project
cnry project delete <name> --dry-run           # preview cascade impact (GET /delete-preview) without writing
cnry status <project>                          # mention + citation summary + domain info; says when the next sweep is refused or skips providers
```

### Brand aliases

`spec.aliases: string[]` on the project (set via `cnry apply`, `cnry project update <name> --add-alias <name>`, or the dashboard) widens the mention detector. Use it when the answer text says "Meta" but the canonical brand is "Facebook", or for a product or former name ("AcmeCloud Pro"). Matching ignores case, spacing and punctuation, so "AcmeCloud" already matches "Acme Cloud"; it is the same answer-text scan that powers `answerMentioned`.

`spec.qualifiedAliases: string[]` (experimental sentiment only; `--add-qualified-alias` / `--remove-qualified-alias` on update, `--qualified-alias` on create) marks aliases the sentiment evaluator is told are the brand's own names, with their exact spelling, for example a former name or a spaced spelling of one. Each must already be an alias, must not be a spelling of the display name, needs a brand key of at least four characters, and must not be a competitor's name (its domain label or a curated competitor alias); a rejected entry is a 400 naming the reason. It changes neither `answerMentioned` nor query classes. An omitted field keeps the stored list (minus names that no longer qualify: a removed alias, a spelling of the display name, or a competitor's name) and `[]` clears it. Adding a competitor drops a qualified alias it shares a brand key with. It applies to runs dispatched afterward only; recorded answers are not rescored.

## Surgical Reads — `cnry get`

```bash
cnry get <project> scores.mentionShare.value
cnry get <project> scores.mentionCoverage.value
cnry get <project> scores.citationCoverage.value
cnry get <project> insights[0].severity
cnry get <project> latestRun.status
cnry get <project> --from overview scores.citationCoverage.value   # pick a registered source
cnry get <project> <path> --format json                          # raw JSON output
```

Resolves a dot/bracket path against the project's overview (default `--from overview`) or any registered source: `overview`, `doctor`, `runs`, `queries`, or `competitors` Returns the scalar (or sub-tree) at the path so an agent can lift a single number without pulling a 30 KB JSON payload. Use `--from <source> .` to see the available top-level keys for that source.

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
cnry snapshot "Acme Corp" --domain acme.example.com --provider gemini --format json  # repeat --provider to select several
cnry snapshot "Acme Corp" --domain acme.example.com --provider-mode api  # all configured API providers
cnry snapshot "Acme Corp" --domain acme.example.com --provider-mode browser --queries "best widget suppliers"

cnry run <project>                             # sweep all configured providers
cnry run <project> --provider gemini           # single provider only
cnry run <project> --query "alpha" --query "beta"  # scope sweep to a subset of tracked queries (repeatable)
cnry run <project> --wait                      # block until complete (a batch run: until batch-pending, then exit 0); exit 2 if the run failed
cnry run <project> --location <label>          # run with specific location context
cnry run <project> --all-locations             # run for every configured location
cnry run <project> --no-location               # explicitly skip location context
cnry run <project> --probe --provider openai --query "..."  # operator/agent test run — snapshot is inspectable but EXCLUDED from dashboard, analytics, intelligence, report, and notifications. Use for verification / "did this fix work?" / regression hypothesis testing.
cnry run <project> --dispatch-mode batch       # send every eligible provider to its batch API (half-price tokens; answers can take up to the deadline)
cnry run <project> --force                     # call every provider, even ones that keep failing on their accounts (see PROVIDERS_FAILING below)
cnry run --all --wait                          # all projects
cnry run cancel <project> [run-id]             # force-cancel stuck runs
cnry run completeness <run-id>                 # answered vs missing answers per provider, and whether a fill is allowed
cnry run fill <run-id> --dry-run               # what a fill would record, without spending quota
cnry run fill <run-id> [--provider claude] --wait  # record a partial run's missing answers under the SAME run id
cnry runs <project> --limit 10                 # list recent runs (includes both real and probe runs; filter on `trigger` if you only want one)
cnry run show <id>                             # show run details
```

Run statuses: `queued` → `running` → `completed` / `failed` / `partial`

`partial` = some providers failed (usually rate limits) — successful snapshots are still saved.

`--wait` exit code (`run <project>`, `--all-locations`, and `--all`): the run detail, location table, or JSON prints in full first, then the exit code reports the final status.

- `failed` → exit `2`: every provider call failed (for example an invalid API key), so fix the cause and retry. stderr carries `{ "error": { "code": "RUN_FAILED", "message", "details": { "waitedRunCount", "failedRuns": [{ "runId", "project", "location"?, "error" }] } } }`; stdout is unchanged.
- `--all --wait` and `--all-locations --wait` exit `2` when any waited run failed. A project whose trigger returned an `error` row has no run to wait on and does not count.
- `completed`, `partial`, and `cancelled` → exit `0`. A partial run kept its answers, so finish it with `cnry run fill` instead of re-running the sweep. A cancelled run was stopped by an operator.
- A batch-pending run (see Batch mode below) still reads `running`, so `--wait` stops there and exits `0`.
- Without `--wait` the command exits `0` once the run is queued; read the outcome with `cnry run show <id>`.

A provider that failed on its account in each of its last 10 runs that called it, with a rejected key or denied access (`PROVIDER_AUTH`) or no credit left (`PROVIDER_BILLING`), is held back. A narrower run (`--provider`, a probe) neither resets nor extends the other providers' counts.

- When only some of a run's providers are held back, the run is queued without them. `skippedProviders` on the run names each with its code, streak and `retryAfter`; the run calls the rest and ends `partial`, and `error.providers.<name>` has `skipped: true`. `cnry run` and `cnry run show` print a `Skipped:` line for each.
- When every provider it would call is held back, the run is refused before it starts, exit `1` with `PROVIDERS_FAILING`. `details.providers` names each provider's code, as does `error.providers.<name>.code` on each failed run. Scheduled sweeps skip their slots instead: the first skipped slot writes a `run.refused` row to `cnry history <project>`.
- `cnry status <project>` reports whether sweeps would be refused or which providers they would skip. `admission` on `GET /projects/<name>/runs/latest` (or `latestRun.admission` on the overview) uses the schedule's providers; `manualAdmission` uses the project's providers, as a manual full sweep does. Both use a published plan's frozen providers. Read these when sweeps look stalled: a refused sweep leaves no run.

Another call would only fail the same way, so fix the key, access or billing in the provider's console or settings, then:

- Saving a new key, model or endpoint in the provider's settings (`cnry settings provider <name> --api-key <key>`) releases it at once. A quota-only edit, or a change to the project's own model override, does not.
- Otherwise (a billing top-up, an edited `config.yaml`) the provider is called again 24 hours after its newest failure finished (its `retryAfter`; a refusal's `details.retryAfter` is the earliest).
- `cnry run <project> --probe` is never held back, and a probe that succeeds clears the provider's streak: use it to check a fix.
- `--force` (`"force": true` on the API, `request.force` over MCP) calls every provider now. Use it only when the user asks to run anyway.
- `cnry run fill <run-id>` calls a skipped provider's missing answers too: a fill is an explicit request for them.

A partial run of a published measurement plan can be finished with `cnry run fill <run-id>`: it asks only the questions that have no answer yet, writes them into the same run, and marks the run `completed` once every expected answer exists. The run keeps its id, timestamps and place in history, so reports show one sweep, never two. It is refused (with a reason code) when the plan was republished since, the run started more than 24 hours ago (for a run that used batch mode: finished more than 24 hours ago), a newer sweep exists, or a missing answer has no frozen model. A provider that fails 3 times in a row is stopped for that fill; fill again once its limit lifts. Do not re-run the whole sweep to recover a few failed answers.

### Batch mode

Scheduled sweeps can send a provider's answers to its asynchronous batch API
(Claude today) at half the token price. It needs `providers.<name>.batch.enabled:
true` in `config.yaml` and the project's `--dispatch-mode <provider>=batch`.
Manual runs stay sync unless given `--dispatch-mode batch`, which is refused
(exit 1, `details.ineligible` names each provider's reason) when no provider can
batch. Only a full sweep of a published plan batches: planless runs, slices and
probes always run sync. While a batch is outstanding the run stays `running`,
`cnry run show <id>` prints `waiting on provider batch: ...`, and the project's
next scheduled sweep is skipped. `--wait` (also with `--all` and
`--all-locations`) never waits for a batch to end: once the run is
batch-pending (a batch `submitted` or `ended`) it stops polling and exits 0.
Text output adds `Waiting on provider batch(es): <provider> — N requests,
submitted <t>, deadline <t>; check with canonry run show <id>` per
batch-pending run. With `--format json`, `cnry run <project> --wait` prints the
run detail unchanged (`status: running`, outstanding `providerBatches`), and
`--all-locations --wait` prints each location's trigger row merged with its
run detail. `cnry run --all --wait --format json` prints only
`{ project, runId, status, location }` rows (plus `error`): a batch-pending
run reads `status: running` with no `providerBatches`, so read those with
`cnry run show <runId> --format json`. Treat that as success, not a timeout,
and read the outcome later with `cnry run show <id>`; re-triggering gets
`RUN_IN_PROGRESS`. Missing answers
after the deadline make the run `partial`; fill them with `cnry run fill` (sync
price, 24 hours after the run finalized). `cnry run show` also prints tokens,
searches and estimated cost per provider and tier (a priced cost under $0.00005
prints `<$0.0001`; only a real zero prints `$0.0000`); `--format json` is the
API response (`dispatchModes`,
`providerBatches`, `usage`). Batch mode is not zero-data-retention eligible on
Anthropic, so keep it off on deployments that need ZDR.

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

`--provider <name>...` and `--provider-mode all|api|browser` constrain both answers
and analysis calls. Omit both to use every configured provider. A named provider
must be configured and match the selected mode. Browser-only selection requires
manual `--queries` and uses no API provider for analysis. API:
`POST /api/v1/snapshot` with optional `providers` and `providerMode`. MCP:
`canonry_snapshot` in the discovery toolkit; unavailable to read-only connections
because generation spends provider quota.

## Mention + Citation Data

Two independent signals per (query × provider): **mention** (`answerMentioned` — brand named in the answer text; the **primary** read) and **citation** (`cited`/`citedDomains` — domain in the grounding sources; **secondary**). Read mention first. Never compute one from the other; never coerce `answerMentioned` null → false (null = "not checked").

```bash
cnry evidence <project>                        # per-query [C/c][M/m] cell + Mentioned: X / Y / Cited: X / Y
cnry evidence <project> --format json          # JSON output
cnry history <project>                         # audit trail
cnry export <project> --include-results        # export as YAML
cnry backfill answer-mentions                  # recompute answerMentioned (primary) from stored answers (honors aliases)
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
cnry sources <project> --query-class non-brand --run-id <run-id> --rank   # sources behind the non-brand answers of one sweep
cnry sources <project> --include-by-query false --format json             # drop the large per-query breakdown (byQuery)
```

- **Surface class** is deterministic (no LLM): `own` = the project's `canonicalDomain`/`ownedDomains`; `direct-competitor` = a tracked competitor; `ota-aggregator` = directories/marketplaces (Yelp, Booking.com, Tripadvisor, Amazon…); `editorial-media` = news/blogs/reference; `other` = everything else. When discovery has run, its stored per-domain classifications (`domain_classifications`) enrich recall for niche OTAs/regional media the static allow-list misses — `own` and tracked competitors always stay authoritative. Running `cnry discover run` improves coverage.
- The ranked list is **not truncated** by default (the old top-5-per-category cap is gone). Pass `--limit N` to cap each list; the response carries `truncatedDomainCount` / `truncatedCitedSlots` so totals always reconcile.
- Counts are **cited slots**: one per (answer, cited domain) pair, so a domain cited 3× in one answer counts once. Probe runs are excluded.
- Without `--run-id` every run in the window is pooled (the scope line and `runCount` say how many); without `--query-class` branded and non-brand answers are pooled, and branded queries inflate your own domain. `--query-class branded|non-brand` takes the class from an active v2 measurement plan, otherwise from the project's brand name/aliases (a project with neither is refused). Answers the class filter cannot place are excluded and counted in `unclassifiedAnswers`. `--include-by-query` defaults to the server's `true`.

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
cnry visibility-compare <project> --from 2026-05 --to 2026-06 --provider openai --location none   # narrow every frame (case-insensitive)
cnry visibility-compare <project> --from 2026-05 --to 2026-06 --scope property --scope-key <target>   # Advanced: one Property's frozen frame
```

- **Use `visibility-compare` for any month-over-month AEO claim.** It leads with **share of voice** (less exposed to an engine's broad naming propensity than an absolute rate, `driftRobust: true`), pools rates per-snapshot (invariant to sweep count), restricts to the query/provider PAIRS present in BOTH months, then to providers with one known, identical configured model id in both months, and attaches a Wilson 95% interval + a `verdict` to every metric. Verdicts: **`within-noise`** = NO confirmed change (never report it as a decline); **`moved`** = a real directional move; **`model-discontinuous` / `model-unknown`** = the engine's configured model changed, was mixed within a month, or is unrecorded, so no directional call is made (do not attribute the swing to the site). Read `continuity` (`status` + per-provider evidence) for what was excluded — `continuity` is the gate, `modelChanges` is advisory. A silent upstream version bump under an unchanged configured id remains undetectable. `lowRunCount` flags a month under 5 sweeps, where intervals are too wide to resolve a move.
- **Class rates:** `mention-rate-branded`, `cited-rate-branded`, `mention-rate-non-brand` and `cited-rate-non-brand` never pool the classes; a missing split reads `classification-unavailable`, and `excludedUnknown` counts rows without that metric's own signal. On an Advanced project without `--scope`/`--market-key`, the four original metrics keep the project frame while the class rates come from the frozen frame in **`classComparison`**: read `classComparison.continuity` (and its `basket`/run counts) as the gate for those four rates, not the top-level `continuity`. `--scope`/`--market-key` answer entirely from the frozen frame at the top level and are refused when a month holds unreconstructable schema-v1 runs.

- **Tri-state aware:** `checked` counts only snapshots where `answerMentioned` was recorded — `null` ("not checked") is **excluded**, never counted as not-mentioned. So `checked` is the correct `n` for a mention proportion. `mentionRate = mentioned/checked`; `citedRate = cited/total` (citation_state is always populated, so the citation `n` is `total`). Both rates are `null` when their denominator is 0 (undefined over no samples).
- **Date-only window:** `--since`/`--until` accept a full ISO instant or a bare `YYYY-MM-DD`. A date-only `--until 2026-06-30` covers the **whole** UTC day (through 23:59:59.999), so same-day runs are included; a date-only `--since` is that day's start.
- **Unbounded by default:** with no `--since`/`--until`/`--last-runs`, every completed/partial run is pooled (`window.runCount` reports how many). For a recent sample, bound it with `--last-runs N`.
- **`groupBy` in the payload:** present (`"provider"`) only with `--by-provider`; omitted otherwise (absent = no breakdown) — the generated SDK types it `groupBy?: 'provider'`.
- **mention vs cited stay independent** — a model can do either, both, or neither. Don't read one from the other.

## Site Health (technical-aeo compatibility)

Site-wide technical audit (structured data, AI-readable content, AI-crawler access, content depth/freshness/extractability, …) powered by `@canonry/aeo-audit`'s `runSiteCrawl`. Runs as the `site-audit` run kind — discovers in-scope URLs from the project root, sitemaps, and internal links; stores the URL/link graph; audits eligible HTML pages; and rolls the results into one 0–100 site score. Pure HTTP, no LLM cost; a large site can take minutes, so it runs in the background. `site-health` is the operator-facing CLI name; `technical-aeo` remains compatible.

```bash
cnry technical-aeo run <project> --wait                 # full crawl + audit; without --max-pages uses the project's saved page budget, else the full site (up to 50,000 pages); edges derived from the page count unless --max-edges is set; --wait polls up to 15 minutes, so follow a longer scan with technical-aeo progress
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
- Reads without `--run-id` use the newest scan that published a crawl, including one that stopped at its page budget (`complete: false`, `termination: max-pages`). A failed, cancelled, or still-running scan never replaces it. `changes` compares complete crawls only.
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

### Content-target dismissals

```bash
cnry content targets <project> --format json
cnry content dismissals <project> --format json
cnry content dismiss <project> <targetRef> --addressed-url https://example.com/page --note "Addressed" --format json
cnry content restore <project> <targetRef> --format json
```

Use a `targetRef` from the content-target response. Dismissal records remain
project-scoped and hide that recommendation on later content reads. Listing
uses `GET /projects/:name/content/dismissals`; dismiss uses `POST` with
`targetRef` and optional `addressedUrl` and `note`. Re-dismissing updates those
optional values and the dismissal time. Restore uses
`DELETE /projects/:name/content/dismissals/:targetRef` and returns HTTP 204; CLI and
MCP acknowledge it as `{ targetRef, restored: true }`. A missing record returns
the API's not-found error.

All three commands support `json` and `jsonl`. The list JSON envelope is
`{ dismissals: [...] }`; JSONL streams its records. Dismiss and restore return
one document. MCP equivalents are `canonry_content_dismissals` (read),
`canonry_content_dismiss` (write), and `canonry_content_restore` (write), in the
`monitoring` toolkit. Dismiss and restore require write authority and explicit
approval; reading a recommendation does not authorize either action.

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
cnry competitor add <project> spoketuneworks.example --alias TuneSpoke   # one domain; repeat --alias for more names
cnry competitor list <project>                       # text shows each competitor's aliases and auto names; JSON rows carry `aliases`, `autoAliases`, `blockedAliases`
cnry competitor aliases <project> qvx.example                      # read one competitor's curated, auto-detected (with evidence) and blocked names
cnry competitor aliases <project> qvx.example --set QVX            # exact list (repeat --set); --clear empties it
cnry competitor aliases <project> qvx.example --add "QVX Stores"   # appends server-side in one call
cnry competitor aliases <project> qvx.example --remove qvx         # read, edit, write back (a concurrent edit can be overwritten)
cnry competitor aliases <project> spoketuneworks.example --block "Spoke Crew"   # never auto-apply this name (removes it if auto)
cnry competitor aliases <project> spoketuneworks.example --unblock "Spoke Crew" # release it to detection again
cnry competitor aliases detect <project> --format json             # dry run: names the stored answers tie to each site, with evidence
cnry competitor aliases detect <project> --apply                   # run detection now and store it, in any mode (after each sweep the project's mode decides)
cnry competitor landscape <project> --query-class non-brand --window 30d --format json
```

### Competitor aliases

A competitor is stored as its registrable domain, and every competitor mention matcher derives a name from the domain label (only when that label has 4 or more letters or digits). A competitor whose answers name it differently ("TuneSpoke" for `spoketuneworks.example`, "Ravenwood Cycling" for `ravenwoodbikeinc.example`) or whose brand is 3 letters (`QVX` for `qvx.example`) is never counted until you give it curated aliases. Without them, mention share overstates the project.

- Rules: trimmed, deduplicated case-insensitively (first spelling kept), at most 10 per competitor, 80 characters each, at least 3 letters or digits. Rejected with a 400 naming each alias and the name it overlaps: a brand key (letters and digits, case and punctuation folded) that contains, or sits inside, one of the project's own names or written hosts ("Acme", "Cycles", `acmecycles.example`, `shop.acmecycles.example` or "Acme Cycles Outlet" for the project "AcmeCycles" at `acmecycles.example`), or a name another tracked competitor answers to (its aliases, domain label or written host). Answers split and join the words of a name freely, so "Tune" cannot belong to one competitor while another answers to "Tune Spoke", "TuneSpoke" or `tunespoke.example`: an answer writing "Tune Spoke" would count both. Joined-word lookalikes ("Tune" and "Tuner") are refused too; pick a longer alias.
- A new competitor whose domain name overlaps another competitor's alias that way (adding `tunespoke.example` or `spoketuneworks.example` while another competitor carries "Tune", or `tune.example` while one carries "Tune Spoke") is rejected on `competitor add` and apply until you remove or restate that alias; discovery promote leaves it out with reason `claimed-by-alias`. No surface starts tracking the project's own site, a subdomain of it, or a parent of an owned domain. A project identity change that claims a competitor alias drops it, audited as `droppedCompetitorAliases`.
- Advanced markets: a competitor an active or draft market pins counts as another competitor, and so does one a superseded revision pins when the project's runs were measured under that revision (`supersededRevision`), since those runs are still scored with it. An alias overlapping its names is rejected (`market-competitor`, naming the `markets`), a stored one is dropped and audited, and a new competitor whose domain name a pin's label or curated alias claims is rejected (`claimed-by-alias`, naming the `markets`) until you remove that name from the pin. The other way round, pinning a competitor (or giving a pin a new name) fails with `claimed-by-alias` when a curated alias already answers to it, and with `other-competitor` when its label or alias overlaps a tracked competitor's own domain label or host; `pin-competitor`, `upsert-competitor`, `upsert-group` and draft publish all check the pins they add or rename.
- Not checked: two names that only share a part ("Tune Spoke" and "Spoke Works" both match the phrase "Tune Spoke Works"), and an alias equal to a subdomain label of another competitor's host. Avoid such pairs by hand.
- Any spelling of a tracked domain (`www.`, a subdomain, or a row an older build's discovery promote stored as a subdomain) finds its stored row; discovery promote now stores the registrable domain. A competitor stored as two rows refuses alias edits; the error names both rows and the aliases to restate: `competitor remove` (which removes every row of it), then `competitor add <project> <domain> --alias ...`.
- Matching is exact brand identity over answer prose (complete words, case and punctuation variants), never fuzzy. Aliases add to mention matching only; citations stay domain-based.
- Read time: mention share (overview card, trend buckets, `visibility-stats --share-of-voice`, `visibility-compare`), the competitor landscape, mention gaps, and run/history competitor signals reinterpret stored answers as soon as aliases change. The stored `competitorOverlap` / `recommendedCompetitors` columns are recomputed in the background; the project's own `answerMentioned` is never touched by an alias edit.
- Frozen: a Simple run freezes the competitor identity it dispatched with (domain label plus aliases), so the AI Visibility report keeps each run's own identity; only runs dispatched after the edit use new aliases. A names change does not break the comparison with the previous sweep: the definition identity behind it covers the project's own coverage and leaves competitor names out. Advanced plan revisions keep their own frozen competitor names (`measurement-plan advanced ... draft-action` with `upsert-competitor`); pinning a tracked competitor into a market by domain alone copies its curated aliases into the draft.
- REST: `PUT /api/v1/projects/{name}/competitors/{domain}/aliases` with `{ "aliases": [...] }` (exact set, idempotent, audited as `competitors.aliases-updated`); `POST /competitors` accepts `{ domain, aliases }` entries (aliases are added). `PUT /competitors` (domain replace) keeps the aliases of domains that stay. Deletes record the discarded aliases on the audit row. MCP: `canonry_competitors_aliases_set` and `canonry_competitors_add` with `{ domain, aliases }` entries (setup toolkit).
- Config-as-code: a `spec.competitors` entry is a domain string or `{ domain, aliases }`. A string keeps that competitor's stored aliases (no opinion); an object sets them exactly, and `aliases: []` clears them. `cnry export` writes aliased competitors as objects, so export then apply round-trips. Auto-detected and blocked names are not part of a config spec: apply keeps them for competitors that stay.

### Answer-derived auto aliases

Canonry also learns competitor names from the project's own stored answers, never from a competitor's website and never with a live call. The local server queues a pass after every completed or partial sweep (probes excluded), when a competitor is added (REST, apply or discovery promote), when a name is unblocked, and when a market pin write changes the pins; a curated alias edit, a competitor removal, a block and a project edit queue none. What the pass does follows the project's `competitorAutoAliases` mode (`cnry project update <project> --competitor-auto-aliases <mode>`, `spec.competitorAutoAliases` in apply, shown by `project show`):

- `preview` (every project's default, existing ones included): the pass scores the answers and logs what it would add or remove, and stores nothing. `detect` (dry run) shows the same evidence.
- `apply`: the pass stores the names that qualify.
- `off`: no pass runs.
- `cnry competitor aliases detect <project> --apply` stores one pass's result in every mode (a one-off apply). Switching to `apply` takes effect at the next queued pass (the next sweep, competitor add, unblock or pin change); `detect --apply` stores now. Switching to `preview` or `off` never deletes names already stored; block them to remove them.
- Restatement: the read-time competitor matchers use the names the project has now, so a names change restates every period they read, months already reported included. Frozen names are not restated: a Simple definition keeps the names it froze at dispatch, and Advanced measurement reports read each revision's own names. The competitor landscape, project-frame `visibility-compare` and analytics metrics responses carry `competitorIdentityChangedAt` (null if never): the newest change to a tracked competitor's curated or stored auto names (a block counts only when it removes a stored name), a detection pass that stores or removes a market-only competitor's learned names, a write that claims, releases or drops a market-only competitor's learned names (project edit, apply, competitor add, alias edit, block, unblock or removal, discovery promote, market pin write), or a published revision that renames a market pin. The landscape reads all of these names; `visibility-compare` share of voice and analytics mention share read only tracked competitors' names, so a pin or learned-name change moves the time without changing them. A scoped `visibility-compare` (a group, market or property scope, or a `marketKey`) reads frozen plan history and has no such field. A figure quoted before that time may differ from the same period read now.

- Evidence: a direct pair is an answer tying a name to the competitor's site: a provider citation anchoring the text that names it to a page on the domain (OpenAI annotations, Claude citations, Gemini grounding supports, Perplexity `[N]` markers), a named link `[TuneSpoke](https://spoketuneworks.example/...)`, or `TuneSpoke (spoketuneworks.example)` / `TuneSpoke - spoketuneworks.example`. A co-occurrence (the answer cites the site and lists the name elsewhere) is reported but never enough on its own. An answer names a candidate only where it writes it outside the competitor's longer names (its domain label, a curated alias, a longer stored name, and for a market-only competitor its plan label and aliases): an answer that writes only "Lark Bay Suites" does not name "Lark Bay". Of the scanned answers that name it: precision is the share citing the competitor's site; lift is how many times more often they cite it than the answers that do not name it (smoothed); name casing is how many write it capitalized as a name. Lift and casing are what reject generic phrases: a much-cited competitor gives any phrase near it a high precision, but naming a phrase barely moves its citation rate, and answers write a phrase in lowercase.
- Applied when: direct pairs in at least 2 answers from at least 2 sweeps (runs started together, one multi-location sweep, count once); at least 3 answers name it; precision at least 10%; lift at least 3; written as a name in at least 75% of them; it reads as a business name (at most 6 capitalized words, no `% + ? : / |`, no host, not a heading such as "Why ..." or "Top ...", a leading number only before a capitalized singular word such as "1 Spoke Lane", and not written as a place: "Larkfield, CO", "Larkfield, Colorado", "Oakvale County", "Metro Larkfield", "Downtown Larkfield", "West LA"); a brand key of at least 4 letters or digits; this competitor has at least twice the pairs of any other tracked competitor; and it visibly belongs to the domain. That tie holds when consecutive whole words of the name spell the domain label ("Spoke Garage Bikes" for `spokegarage.example`); when a name of two or more words opens the label whole, at its start or right after a lead word (my, the, get, try, go, use, hey, join, shop, visit), and covers at least half of it ("SpokeIQ" for `myspokeiq.example`); when two or more of its words sit back to back in the label from that opening and cover at least half of it, one of them 4 or more letters long and inside fewer than two tracked identity labels (the project's and every competitor's), so a shared industry word such as "roofing" proves nothing ("TuneSpoke" for `spoketuneworks.example`); or when a name of two or more words is an in-order abbreviation of the label that opens like it, with the same first 4 letters or a first word of 3 or more letters the label starts with ("FoamSeal" for `foamandsealworks.example`). One shared word never ties a name to the domain unless it is the whole label: a city the label opens or ends with ("Larkfield" for `larkfieldroofing.example`), a neighbour sharing the label's first word ("Rim Doctor" for `doctorspokes.example`) and a one-word brand shorter than its label ("Acme" for `acmecycles.example`) all go to review.
- Review: a candidate that passes everything except that tie (`no-label-affinity`) or the 4-character floor (`needs-approval`) is listed as `review` only, after checks at the 3-character floor against the project's names and hosts, other competitors' domain labels, hosts and curated aliases, market pins of another domain, blocks, and the competitor's own names and planned auto names. Unlike applied names, review names are not checked against other competitors' auto-detected names, so a name another competitor stores can still be listed. Such lists still mix the competitor's real names with its partners, rivals and services, and a one-word city or a longer region name has no place shape and can appear, so check that the name refers to that competitor in the answers, then add it with `--add` (never `--set`, which replaces the curated list).
- Never applied: a blocked name; a name the competitor's own identity already matches as complete words (`already-matched`: its domain label, a curated alias, a kept auto name, or a name of its own active or draft Advanced pin, so "Velo Hub Springfield" is not learned under the pin "Velo Hub"; a superseded revision's pin does not count); a name overlapping the project, another competitor's curated identity, or the names of an Advanced market pin of another domain (active, draft, or a superseded revision the project's runs were measured under) (curated always wins); a longer variant of an applied name (`subsumed`: blocking the short name frees the longer ones). At most 10 auto names per competitor: stored names first, then new names strongest evidence first (`over-limit` for the rest).
- Stored names are sticky: one is removed only when blocked; claimed by identity (the competitor's own curated aliases or domain label already cover it, `already-matched`; it overlaps the project's names or hosts, `project-brand`; or it overlaps another competitor's domain label, host or curated alias, a market pin of another domain, or, after an identity change, another competitor's stored auto name that resolves first (tracked competitors before market-only ones, each in domain order), `other-competitor`); replaced by an accepted shorter name it is built on (`subsumed`); or contradicted by the scanned answers: named in 3+ with precision under 5%, lift under 1.5, or written as a name in under half; another tracked competitor now pairing it in at least 2 answers and at least twice as often as this one (`other-competitor-dominates`); or no tie to the domain label left, judged on the stored spelling (`no-label-affinity`). A tracked competitor's own pin never removes a stored name; a market-only competitor's active pin names are its curated names and do (`already-matched`).
- Blocking: `--block` removes a stored auto name and keeps it out of detection. The block outlives the row: `competitor remove` keeps it, and the next `competitor add` of that domain (or an apply that re-adds it, or a market-only pin promoted to a competitor) starts with it. A curated alias cannot be blocked (remove it with `--remove`), and neither can a name the measurement plan's own pin of that competitor carries (active revision or pending draft): the pin keeps counting it, so change the pin's names in a measurement draft.
- Scan: the newest 60 completed or partial answer-visibility runs (probes excluded) and at most 6000 snapshots, stopping inside a run when the cap falls there. One pass per project at a time: an apply-now waits for a running storing pass and runs after it. A names change is audited (`competitors.auto-aliases-updated`, actor `system`; an apply-now that changed names also writes `competitors.auto-aliases-apply-requested` with who asked) and recomputes the stored competitor columns in the background. Matchers and frozen Simple definitions (for runs dispatched afterward) use curated + auto minus blocked. An Advanced pin by domain alone copies only the curated aliases; auto and learned names are layered onto it when answers are read, never frozen into a revision, so a later block can still take them back.
- Advanced: a competitor the active plan pins in a market without tracking it project-wide is detected from that market's answers only, its plan label and aliases count as its curated names, and its learned names apply only where a run's plan revision pins it (never as a project competitor). `detect` lists it with `(Advanced markets: ...)` and `marketKeys` in JSON; `--block` / `--unblock` work on it by domain, and on a domain a later revision stopped pinning while its learned or blocked names are still stored. `competitor aliases <project> <domain>` without a flag reads project competitors only; for a market-only competitor use `detect`.
- Aero can run the dry run (`canonry_competitors_auto_aliases_detect`) but never applies: `canonry_competitors_auto_aliases_apply` is not in its catalog, and it cannot change a project's `competitorAutoAliases` mode. Applying and switching a project to `apply` stay operator actions.
- REST: `GET` / `POST /api/v1/projects/{name}/competitor-auto-aliases` (dry run / apply), `POST /api/v1/projects/{name}/competitors/{domain}/aliases/block` and `/unblock` with `{ "aliases": [...] }`. MCP: `canonry_competitors_auto_aliases_detect` (read), `canonry_competitors_auto_aliases_apply`, `canonry_competitors_aliases_block`, `canonry_competitors_aliases_unblock` (setup toolkit). `detect` is a reserved word after `competitor aliases`.

```yaml
spec:
  competitors:
    - ravenwood.example
    - domain: spoketuneworks.example
      aliases: [TuneSpoke]
```

Historical competitor landscapes require explicit `--query-class non-brand`
for competitive percentages (REST `queryClass=non-brand`, MCP
`queryClass: "non-brand"`). Omitted class or `all` returns pooled counts and
null shares. Request branded evidence separately for brand recall.

## Target Measurement Plans

```bash
cnry measurement-plan discover <project> --sitemap-url https://example.com/sitemap.xml --rule discovery-rule.yaml
cnry measurement-plan discover <project> --sitemap-url https://example.com/sitemap.xml --rule discovery-rule.json --max-urls 500
cnry measurement-plan show <project>                    # active immutable revision
cnry measurement-plan show <project> --revision 2       # one historical revision
cnry measurement-plan versions <project>
cnry measurement-plan publish <project> plan.yaml       # legacy schema v1 only; refuses over an active v2 plan (use: measurement-plan advanced <project> draft-action)
cnry measurement-plan report <project> --revision 2     # stored evidence only; never starts provider work; a schema v2 revision reads non-brand unless --query-class branded|all; a schema v1 revision reads every answer and refuses --query-class non-brand or branded
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
cnry doctor <project> --check site.reachability   # probe the homepage now; the server also probes every 10 min and pages health.degraded after two failed passes
cnry schedule set <project> --kind site-audit --preset weekly     # Technical AEO: bounded full-site crawl and audit (no --source/--provider)
cnry schedule show <project>
cnry schedule list <project> --format json      # all configured schedule kinds
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
cnry settings provider gemini --api-key <KEY> --model gemini-flash-latest
cnry settings provider openai --max-per-day 1000 --max-per-minute 20
cnry settings provider perplexity --api-key <KEY> --model fast
cnry settings provider muse --api-key <KEY> --model muse-spark-1.3
```

Perplexity runs on its Agent API. `--model` takes a preset (`fast` default, `low`, `medium`, `high`, `xhigh`) or a `vendor/model` slug such as `perplexity/sonar`. Retired Sonar names still work and run as their replacement (`sonar` → `fast`, `sonar-pro` → `low`).

Quota flags: `--max-concurrent`, `--max-per-minute`, `--max-per-day`

Available providers: `gemini`, `openai`, `claude`, `perplexity`, `muse`, `local`, `cdp`

Set `MUSE_API_KEY` before `cnry bootstrap` or `cnry init` to store the key. Setup also accepts `MUSE_MODEL` and `MUSE_BASE_URL`. `cnry init --muse-key <KEY>` stores a key directly. Muse uses Meta's Standard `muse-spark-1.3` by default. Contributor model IDs require an explicit model override; Meta permits training on their prompts and completions. See [the Muse provider guide](https://github.com/Canonry/canonry/blob/main/docs/providers/muse.md).

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
cnry google query-totals <project> --start 2026-06-01 --end 2026-06-30
cnry google query-totals <project> --window 90d --limit 500 --offset 500
# One row per named query over the window: clicks, impressions, CTR, position
# weighted by impressions, and `days` (the dates the query appeared). Ordered
# clicks desc, impressions desc, query asc; page with --limit/--offset until
# `truncated` is false. `source` marks rows that use the legacy page table for
# some days (`page-summed` or `mixed`: impressions over-count). Google leaves
# rare queries out, so never sum these rows for a property total, use
# `cnry google performance-daily`. Reads stored data only, never calls Google.
# `window.earliestDataDate` is the first stored per-query day: a window that
# starts before it is only partly covered (unsynced days, not zero traffic).

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

Discovery requires Gemini configured (API key today; Vertex-mode embeddings are deferred). The pipeline writes a `discovery_sessions` row, a `runs` row (kind `aeo-discover-probe`), and one `discovery.basket-divergence` insight when the session completes. `discover harvest` is a separate read-only view over a completed session: it reads the search queries the answer engine actually issued to answer each probe (Gemini's `groundingMetadata.webSearchQueries` fan-out, already stored in the probe's `raw_response`) back out — no new model call — runs a mandatory quality gate (drops navigational/phone lookups, over-specific outliers, off-subject acronym collisions, exact already-tracked matches, and — via an embedding cosine pass over your tracked queries — semantic duplicates like paraphrases/synonyms that exact match can't see) and returns the survivors ranked by how many distinct probes issued each one. The output's `semanticNoveltyApplied` reports whether the embedding pass ran (it falls back to exact-match when no Gemini key is configured). These are a third signal — *issued retrieval queries*, neither "mention" nor "cited" — and carry no demand of their own; they are candidate seeds, so review them and add the good ones with `cnry query add`. Use `--min-probe-hits` to require recurrence and `--no-anchor` to allow new-subject discovery on a well-scoped project. Seed generation is location-aware: a project with locations configured (or a `--locations` label subset) geo-constrains the seed prompt so generated queries stay inside the service area, and a multi-location project gets a per-area seed quota so one area cannot dominate — `--locations` labels must match the project's configured locations or the run is rejected; projects with no locations are unaffected. After probing, one Gemini call classifies every recurring cited domain as `direct-competitor`, `ota-aggregator`, `editorial-media`, or `other` (a failed/legacy classification leaves domains `unknown`). Aero wakes unprompted with the bucket-count payload so the operator can act without polling. `discover eval` (quality-regression panel vs committed baseline, exit 1 on regression, --update-baseline to capture), `discover promote` defaults to cited + aspirational queries and `direct-competitor` domains only — aggregators and editorial media are suppressed; pass `--competitor-types` to widen the merge (or to recover legacy `unknown` entries) and `--bucket wasted-surface` for off-ICP competitor gaps. Promotion is add-only and idempotent — queries/domains already tracked are reported as skipped, never inserted twice — and only works on `completed` sessions; promoted rows carry `provenance="discovery:<sessionId>"`. Cited hosts are grouped into the registrable domain a competitor is stored as (`offers.rival.example` promotes as `rival.example`, shown with its source hosts) before the hit floor and the cap, counting each probe once. A competitor that is the project's own site, was cited as two or more different subdomains of one possibly shared host (`shared-host`), or whose name another competitor's alias claims (`claimed-by-alias`) is left out with a reason (`skippedCompetitors` in the preview, `competitorDetails` in the result) while the rest of the promote proceeds.

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
cnry traffic analytics <project> --period 30 --format json    # complete 7|14|30|90-day totals, prior-period changes and breakdowns
cnry traffic events <project> --source <source-id> --format json
cnry traffic referral-assessment <project> --start-date 2026-08-01 --end-date 2026-08-31 --burst-threshold 100 --ratio-threshold 3 --limit 100 --format json

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

`traffic referral-assessment` is a DB-only diagnostic, also available as MCP
`canonry_traffic_referral_assessment`. Date bounds are inclusive UTC dates, at
most 366 days. `--source` optionally selects one source. Thresholds tune only
the read; `--limit` caps candidate details, never totals. JSON and JSONL both
return the full assessment object.

Raw counts and existing headlines stay unchanged. The separate adjusted
estimate excludes every hit in a candidate burst group (one source, product,
normalized path and UTC hour), not proven automation.
The default 100-hit threshold is an uncalibrated review trigger. Normalized
paths may combine multiple pages, and sources may overlap. Simple and Advanced
projects use project/source scope; Property, Target and market attribution are
unavailable and unsupported filters are rejected.

`observedRatio` is a descriptive server/GA quotient, rounded to 2 decimals,
when GA sessions are positive and server rows exist.
`observedRatioAboveThreshold` compares that rounded value with
`--ratio-threshold`; it is not a quality verdict. Complete matching coverage and
the GA timezone are unknown. Server and GA observation states distinguish
missing evidence from an observed zero: server rows that are all redirects or
subresources are observed zero, and GA is observed zero only when the window
lies inside the latest GA sync window and that sync stored no AI row for it.
The silent `report.ai-referral-bursts` doctor check warns only when candidate
bursts exist, reports `candidateGroups`, and carries these limits in its
details. Keep GA evidence; this assessment does not establish a replacement
human-visit count.

`traffic analytics` reads complete stored server-traffic aggregates through
`GET /api/v1/projects/<name>/traffic/analytics?period=30` and the
`canonry_traffic_analytics` MCP tool. JSON preserves `{ activity }` unchanged;
JSONL emits the same document. With no non-archived source, `activity` is null.
Connected sources without events return zero stored aggregate counts; those
zeros do not prove measurement coverage or a successful source sync. Retain
`coverageStart` (the earliest stored project observation, or null) and
`priorWindowComplete` (whether it reaches the prior window's start). Incomplete
prior recording withholds all headline, arrival-class, and operator `deltaPct`
values while preserving current and prior counts. These fields do not prove
continuous collection or matching source coverage across the two windows.
It retains crawler
verification, user fetches, paid/organic/unclassified arrivals, redirect hops,
operators, crawled paths, referral products, landing paths, daily history, and
equal prior-window changes. It does not start a sync or provider work. The
scope is project-wide for Simple and Advanced portfolios; there is no Property,
Target, or market attribution. Server sessions and GA sessions remain separate.

## Google Analytics 4

GA4 integration supports service-account auth and OAuth (`canonry google connect <project> --type ga4`). With OAuth, `ga properties` lists the readable properties so the numeric id `ga connect --property-id` needs can be discovered without leaving canonry. The service account must have Viewer access on the GA4 property. `ga sync` writes the traffic tables (`gaTrafficSnapshots`, `gaAiReferrals`, `gaSocialReferrals`, `gaTrafficSummaries`) plus the GA4 Search Console landing-page snapshot (`gaSearchLandingWindows`, `gaSearchLandingPages`); every subsequent read command queries the local store rather than re-fetching from GA4, so reads are fast and quotaless. AI-referral rows are tracked across 10 known providers (chatgpt, perplexity, claude, gemini, openai, anthropic, copilot, phind, you.com, meta.ai), three GA4 attribution dimensions (`session` / `first_user` / `manual_utm`), and joined to landing pages. Social referrals are split Organic vs Paid via GA4's `sessionDefaultChannelGroup`. All commands support `--format json`.

```bash
cnry ga connect <project> --property-id <id> --key-file ./sa-key.json
                                                  # connect via service account (auth method = service_account)
cnry ga disconnect <project>                  # disconnect; deletes all synced rows for the project
cnry ga status <project>                      # connected, propertyId, authMethod, lastSyncedAt
cnry ga properties <project>                  # list GA4 properties the connected account can read,
                                                  # with their numeric ids. OAuth connections only —
                                                  # the id cannot be derived from the domain or the grant
cnry ga sync <project> [--days 30] [--only traffic|ai|social|search-landing]
                                                  # refresh from GA4 → DB; --only restricts which slice is replaced
                                                  # (search-landing = the Search Console landing-page snapshot)
                                                  # returns: synced, rowCount, aiReferralCount, socialReferralCount,
                                                  #          measurement.searchLandingPages{status, windows[], rowCount,
                                                  #          error?}, syncedComponents (lists search-landing only
                                                  #          when its snapshot was stored), syncedAt
cnry ga measurement-analysis <project> [--window 30d|60d|90d]
    [--host-scope marketing|all] [--path-prefix /blog] [--limit 100]
                                                  # fixed 30-day cohorts across native GA4 channels,
                                                  # configured lead events, branded/non-brand GSC demand,
                                                  # ranked landing pages/queries, and independent freshness/errors
                                                  # for acquisition and leads; leads.aiEngines splits lead events
                                                  # by AI engine (ChatGPT, Perplexity, Gemini, ...) with the same
                                                  # engine's sessions and lead rate per cohort, organic and paid
                                                  # clicks apart
cnry ga search-landing-pages <project> [--window 7d|28d|90d] [--limit 50] [--offset 0]
                                                  # GA4's "Google organic search traffic: Landing page + query
                                                  # string" report (needs GA4's Search Console link): clicks,
                                                  # impressions, CTR, average position and active users per
                                                  # landing page for the 7/28/90 days ending YESTERDAY in the
                                                  # property time zone (28d = GA4's default). `total` is GA4's
                                                  # own Total row, never a sum of `rows`. status: never-synced |
                                                  # ready | unavailable (GA4 refused the Search Console metrics)
                                                  # | error; a failed refresh keeps the last snapshot. No
                                                  # --start/--end: every figure is GA4-computed per window
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

Every read command queries persisted DB rows, so a stale `lastSyncedAt` means the response is stale — always check `ga status` before drawing conclusions, and re-`ga sync` if the data is older than the analysis window. Use `--only ai`, `--only social` or `--only search-landing` to refresh just one slice when iterating.

`ga search-landing-pages` reads GA4's Search Console collection, not Canonry's own GSC sync: its clicks come through the GA4 property's Search Console link and can differ from `google performance` for the same days. Active users is GA4's plain `activeUsers` from the same request, which is what GA4's report shows (not limited to Google organic sessions). Search Console data reaches GA4 about two days late, so the last days of each window are thin, exactly as in GA4. A property without a Search Console link is expected to read `unavailable` with Google's message in `error` (inferred, not yet observed from a live unlinked property); the previous snapshot stays readable beside that status.

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
cnry gbp reviews <project> [--location locations/{n}] [--negative] [--limit N]
                                                   # stored reviews newest first, plus each location's Business Profile
                                                   # review access (ok / unavailable + reason / error) and latest rating.
                                                   # --negative keeps reviews at or below the project's threshold
                                                   # (the review.negative threshold, 3 stars by default);
                                                   # each review carries its webhook alertState
cnry gbp summary <project> [--location locations/{n}]
                                                   # composite scorecard: performance totals + recent-vs-prior 7d
                                                   # deltas (deltaPct null when prior=0), keyword coverage,
                                                   # place-action CTA presence flags, Lodging API readable-group counts,
                                                   # owner-content profile completeness (secondary categories /
                                                   # description / service area / hours / phone + closed-status counts)
```

`gbp sync` produces a run with the standard statuses (`completed` / `partial` / `failed`); `partial` means some selected locations synced and others errored (the per-location errors are on the run). Non-lodging locations are skipped cleanly (Google answers the lodging call with HTTP 400, not 404). The Q&A API was retired (2025-11-03).

Reviews sync from the v4 Reviews API when Google has enabled it for the Cloud project. Most projects get `403 SERVICE_DISABLED`, which never fails the run: `gbp reviews` shows it per location, and the `gbp.reviews.access` doctor check explains how to request access. Without v4 access, locations fall back to the public Places listing when Places runs on the `atmosphere` tier with a key: the overall rating and at most five reviews chosen by relevance, so a new review can be missed. That fallback is at most one Place Details call per location per day, billed at Enterprise + Atmosphere.

Review webhooks: subscribe with `cnry notify add <project> --webhook <url> --events review.negative,review.rating-dropped`. `review.negative` is sent once per new or edited review at or below the project's threshold, 3 stars by default (`cnry project update <project> --negative-review-max-stars <1-4|default>`, or `spec.negativeReviewMaxStars` in `canonry apply`); `review.rating-dropped` when a location's public rating falls (Places fallback only). Lowering the threshold also stops alerts already queued; raising it applies to new and edited reviews only. A location's first sync records a baseline and sends nothing, a review older than 30 days never alerts, and nothing is held for a webhook added later. Discord and Slack URLs get a formatted message.

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
cnry telemetry status --target server --format json  # connected server, effective state and override reason
cnry telemetry disable --target server --format json # requires settings.write
```

## Feedback

Send feedback about Canonry itself to the Canonry team. Agents: when you uncover a struggle (a failure, confusing output, a workaround) or a concrete improvement, tell the user and send one report per issue. Be specific about the command, error code, and what you did instead. Never include secrets or customer data; credentials are redacted before sending. The anonymous install id is attached only while telemetry is enabled.

```bash
cnry feedback "run fails with RATE_LIMITED on a free Gemini key" --kind struggle --command "cnry run acme" --error-code RATE_LIMITED
cnry feedback "let me skip competitors from the CLI setup" --kind improvement --area setup
cnry feedback "<summary>" --kind bug --details "<what happened, what you expected>" --format json
```

Kinds: `struggle`, `bug`, `improvement`, `other` (default). MCP equivalent: `canonry_feedback`.

## Operational diagnostics

`cnry logs [--level trace|debug|info|warn|error|fatal] [--module <name>]
[--run-id <id>] [--project-id <id>] [--actor <user:id|api-key:id>]
[--request-id <id>] [--since <ISO>] [--until <ISO>]
[--limit <1..200>] [--cursor <cursor>] --format json`
returns `{entries,nextCursor,truncated,dropped,retention,retentionPolicy,captureErrors,observedAt}`.
`jsonl` preserves this object envelope. It requires an instance-wide `logs.read`
grant (or wildcard); project-scoped credentials are rejected. Only allowlisted
diagnostic metadata and sanitized messages are exposed, including application
and HTTP failures. File-backed hosts retain logs across restarts, capped at
10,000 events and seven days; in-memory hosts report process retention. Raw
request/response bodies, headers, cookies, provider payloads, and stacks are
excluded. Cursors bind the store and filters; expired or mismatched cursors
return a validation error. Inspect retention/loss counters before assuming
coverage. Use `history` for durable audit
events, with `--limit 1..500 --offset <n>` for traversal. Offset pages are not a
concurrent-write snapshot.

Google setup and telemetry default to local configuration. Pass `--target server`
to use the connected server; settings reads always describe the server.
Configured providers accept model/quota-only edits without resending secrets.
`cnry notify events --target server` discovers the remote event catalog while
the default remains the offline catalog. HTTP 4xx errors (including 429 policy
limits) retain exit 1; HTTP 5xx errors retain exit 2. Server-provided retry timing
and request IDs are exposed when available; no mutation is automatically retried.

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

# Select a specific provider / model (otherwise auto-detected from config).
cnry agent ask <project> "<prompt>" --provider claude
cnry agent ask <project> "<prompt>" --provider zai
cnry agent ask <project> "<prompt>" --provider openai
cnry agent ask <project> "<prompt>" --provider gemini

# Restrict the tool surface. Default is --scope all (full read+write surface).
# --scope read-only matches the dashboard bar default so pasted "Copy as CLI"
# commands can't enable writes the UI turn couldn't perform.
# On an install that manages answer-visibility sweeps, even --scope all cannot
# start, fill or cancel a sweep, or change a schedule.
cnry agent ask <project> "<prompt>" --scope read-only
cnry agent ask <project> "<prompt>" --scope all

# Carry the selected view (also included by dashboard Copy as CLI).
cnry agent ask <project> "Explain this Property" --scope read-only --context '{"view":"property","selection":{"scope":"property","scopeKey":"hotel","queryClass":"non-brand","runId":"run-3"}}'
cnry agent ask <project> "Explain this page" --scope read-only --context '{"view":"site-health","page":{"runId":"scan-1","nodeKey":"page-2"}}'
cnry agent ask <project> "Top insights" --max-tool-calls 15 --timeout-ms 120000

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

**Provider detection order** when `--provider` is omitted: `claude` →
`openai` → `gemini` → `zai`, whichever has an API key present first (from
`~/.canonry/config.yaml` providers block, or the matching env var
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `ZAI_API_KEY`).
The `deepinfra` provider was removed; pin one of the four above.

Conversations **persist per project** — `cnry agent ask` continues the
active conversation each invocation. Use `cnry agent conversations list <project>`
to list saved conversations, `new <project>` to save the current one and start
fresh, `show <project> --id <id>` to read one, `resume <project> --id <id>` to
continue it, and `delete <project> --id <id>` to remove it permanently. All support
`--format json`; list accepts `--limit 1..100` and `--offset` from `nextOffset`.
Creation accepts `--id <uuid>` for retry-safe callers (otherwise the CLI generates
one). `agent ask --conversation <id>` rejects a stale selection.

The dashboard exposes New conversation and History, with a separate delete
confirmation. Shared project notes survive; compaction summaries follow their
conversation and are deleted with it. One conversation is active per project,
shared across administrators. Older transcripts erased by the legacy reset
cannot be recovered. `agent reset`/`clear` retain their legacy destructive behavior.

Aero starts with core tools and loads authorized toolkits as needed. The
`ads-operator` profile keeps its explicit narrow catalog. Loading tools never
changes the caller's scope. Defaults are 30 tool calls and 180,000 ms of agent
execution; overrides allow 1–100 calls and 1,000–600,000 ms. The SSE/JSON stream
includes `aero_turn_status` with reason, call counts, duration, and limits.
Invalid context is rejected before generation. Context is per turn; it is not
an authorization grant or a persistent filter.

Stop with Ctrl-C in the CLI or Stop in the dashboard. Partial messages persist;
an action already dispatched may still finish. Inspect the transcript before
repeating a write. The dashboard offers Retry for read-only turns and prompt
review for write-capable turns. Unexpected stream EOF is an error.

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

**Update notice.** When a newer canonry is published, the CLI writes one line to **stderr** before the command runs (stdout is never touched): `[canonry] UPDATE_AVAILABLE: ...` in text mode, or `{"notice":{"code":"UPDATE_AVAILABLE","current":"…","latest":"…","installMethod":"npm|homebrew|docker","upgradeCommand":"…","url":"…"}}` with `--format json|jsonl`. Tell the operator, or run the `upgradeCommand` (it already matches how canonry was installed) and restart `canonry serve`. `cnry doctor --check canonry.version.current` reports the same for the running server (`version.outdated` warns). Silence with `CANONRY_DISABLE_UPDATE_CHECK=1`. Over MCP the same notice arrives in the initialize instructions and as `updateAvailable` in `canonry_help`.

`jsonl` is supported by every **collection** command — one whose primary output is a list: `insights`, `runs`, `evidence`, `history`, `query/keyword/competitor list`, `notify list/events`, `google` reads (`performance`, `performance-daily`, `query-totals`, `inspections`, `coverage-history`, `deindexed`, `status`, `properties`, `list-sitemaps`), `bing` reads (`coverage-history`, `inspections`, `performance`, `sites`), `ga` reads (`ai-referral-daily`, `ai-referral-history`, `social-referral-history`, `session-history`, `coverage`, `search-landing-pages`), `google-ads` customer/snapshot reads, `gtm` account/container/workspace/snapshot reads, conversion-tracking contracts and integrity findings, `ads geo search` and `ads conversions` reads, `traffic events/sources/status`, `discover list/show`, `content targets/sources/gaps/map`, `backlinks list/releases`, `project list/locations`, `key list`, `agent memory list`, `agent providers`, `sources` (streams the ranked cited-domain list), and `doctor`. (`content brief` is an object command — `jsonl` degrades to its JSON document.)

Each `jsonl` line re-injects the envelope context it would otherwise lose, so a line lifted out still self-describes:

- project-scoped lists stamp `{ "project": "<name>", …row }`;
- `ga *-history` also stamps `window`; `ga search-landing-pages` stamps `window`/`windowStart`/`windowEnd`; `traffic events` stamps `windowStart`/`windowEnd`; `backlinks list` stamps `release`/`targetDomain`; `discover show` stamps `sessionId`; `content targets` stamps `latestRunId`; `project locations` stamps `isDefault`;
- global lists whose rows already self-identify (`project list`, `notify events`, `backlinks releases`) emit bare rows.

Empty collection → **no output** (the exit code still conveys success, so "no records" stays distinct from "failure"). On failure a command prints its records (if any), then exits non-zero — branch on the **exit code**, never on parsing stderr. JSON field names and the `{ "error": { "code", "message" } }` envelope are a public contract.

**Composite** commands return a single aggregate object (not a list), so there is nothing to stream — on them `--format jsonl` **degrades to the same JSON document** as `--format json`; it never falls through to decorated human text. So `--format jsonl` is safe to pass to *any* command: collection commands stream their records, every other command emits its JSON document. Composite shapes are below.

## Output schema per command

Compact reference for the composite / keyed commands agents read most (shapes can drift — the linked DTO source file is the source of truth; collection commands simply emit their primary array, see each command's own section above).

| Command | JSON output shape (top-level keys → DTO) | `jsonl` |
|---|---|---|
| `cnry doctor [--project p] [--all] [--report-month YYYY-MM]` | `{ scope, project, reportMonths?, generatedAt, durationMs, summary{total,ok,warn,fail,skipped}, checks[] }` — `DoctorReportDto` @ `contracts/doctor.ts`. `checks[]` = `CheckResultDto{ id, category, scope, title, status(ok\|warn\|fail\|skipped), notificationPolicy?(health\|silent), code, summary, remediation?, details?, durationMs }`. `report.*` checks are silent report-readiness advisories: they never page or change health state. `--report-month` picks the month they grade (default: the current month, plus the closed month through day 3, when only the closed month is graded). With `--all`: an object keyed by `__global__` + each project name, each value a full report. | ✅ one check / line as `{project, …check}`; still exits non-zero if any `fail` |
| `cnry analytics <p> [--feature metrics\|gaps\|sources] [--window 7d\|30d\|90d\|all]` | Object **keyed by feature**: `{ metrics?, gaps?, sources? }` (all three present with no `--feature`; one with `--feature X`). `metrics`=`BrandMetricsDto{ window, buckets[], overall, byProvider, trend, mentionTrend, queryChanges[] }`; `gaps`=`GapAnalysisDto{ cited[], gap[], uncited[], mentionedQueries[], mentionGap[], notMentioned[], runId, window }` (each `[]`=`GapQuery`); `sources`=`SourceBreakdownDto` (same shape as `cnry sources`, below). @ `contracts/analytics.ts` | → degrades to the `json` document |
| `cnry sources <p> [--rank] [--limit N] [--by-provider] [--window …]` | `SourceBreakdownDto{ overall[], byQuery, ranked, byProvider, runId, window, limit }` @ `contracts/analytics.ts`. `ranked`/each `byProvider[name]` = `RankedSourceList{ totalCitedSlots, domainTotal, entries[], truncatedDomainCount, truncatedCitedSlots, bySurfaceClass[] }`; `entries[]`=`SourceRankEntry{ domain, count, percentage, category, label, surfaceClass }`; `bySurfaceClass[]`=`SurfaceClassCount{ surfaceClass, label, count, percentage, domainCount }`. `surfaceClass` ∈ own \| direct-competitor \| ota-aggregator \| editorial-media \| other. | ✅ streams `ranked.entries` one / line as `{project, …entry}` |
| `cnry visibility-stats <p> [--since <iso>] [--until <iso>] [--month <YYYY-MM>] [--last-runs N] [--by-provider] [--share-of-voice] [--query-class branded\|non-brand]` | `VisibilityStatsDto{ project, groupBy, window{since,until,lastRuns,runCount}, totals, byProvider?[], queries[], shareOfVoice? }` @ `contracts/visibility-stats.ts`. Each query / provider / totals entry = `{ total, checked, mentioned, cited, mentionRate, citedRate }` (+ `query`/`queryId`/`firstObserved`/`lastObserved` on queries, + `provider`/observed on provider entries). `checked`=snapshots with non-null `answerMentioned` (tri-state n for mention); `mentionRate=mentioned/checked`, `citedRate=cited/total`, both `null` on a 0 denominator. `byProvider`/per-query `providers` present only with `--by-provider`; counts sum to pooled. `--month YYYY-MM` echoes the resolved `window.since`/`until`. `shareOfVoice` present only with `--share-of-voice` = `{ queryClass, percent, projectMentions, competitorMentions, snapshotsWithAnswerText, perCompetitor[{domain,mentions}] }`; `percent` (0-100) = `projectMentions/(projectMentions+competitorMentions)`, `null` when no competitors configured. `queryClass` is what was actually served: `non-brand` (the default), `branded` (via `--query-class`), or `pooled` — which appears ONLY when the project has no usable brand alias to split by, never as a default. Branded and non-brand never share a denominator. | ✅ streams `queries` one / line as `{project, runCount, …query}` (envelope-only `shareOfVoice` not in the jsonl rows) |
| `cnry google coverage <p>` (index coverage) | `{ summary{total,indexed,notIndexed,deindexed,percentage}, lastInspectedAt, lastSyncedAt, indexed[], notIndexed[], deindexed[], reasonGroups[] }` — `GscCoverageSummaryDto` @ `contracts/google.ts`. `indexed[]`/`notIndexed[]`=`GscUrlInspectionDto`, `deindexed[]`=`GscDeindexedRowDto`. | → degrades to the `json` document. The single-array reads `google inspections` / `coverage-history` / `deindexed` **stream** `jsonl`. |
| `cnry google query-totals <p> [--start …] [--end …] [--window …] [--limit N] [--offset N]` | `GscQueryTotalsDto{ rows[], totalMatching, truncated, window }` @ `contracts/google.ts`. Each row = `{ query, clicks, impressions, ctr, position, days, source(google\|page-summed\|mixed) }`; `window` = `GscWindowRange{ startDate, endDate, latestDataDate, daysSinceLatestData }` plus `earliestDataDate` (first stored per-query date, `null` with none; a window starting before it is only partly covered). Named queries only: the rows do not add up to the property total. | Streams one line per query, each tagged with `project` and `window`. |
| `cnry ga measurement-analysis <p> [--window 30d\|60d\|90d] [--host-scope marketing\|all] [--path-prefix /…]` | `GaMeasurementAnalysisDto` @ `contracts/measurement.ts`: fixed 30-day `acquisition.periods/channels/pages`, configured-event `leads.periods/channels` with explicit attribution/filter scope, `leads.aiEngines{ leadRateAvailable, leadRateUnavailableReason, organic, paid }`, each class `{ periods[], engines[{ engine, label, sources[], periods[] }], unattributed{ sources[], periods[] } }` (lead events per AI engine from GA4 `sessionSource` via the shared `aiEngineForReferralSource` mapping, split by `classifyAiReferralTrafficClass` so tagged ad clicks never pool with organic, with the landing page left out on both sides when leads are channel-scoped; each cohort has `eventCount`, same-source same-class `sessions` under the same host/path filters, and `leadRate` = eventCount / sessions as a fraction, `null` on 0 sessions or when `leadRateAvailable` is false; `leadRateUnavailableReason` is `no-data`, `sync-not-ready` (latest acquisition or lead sync failed), `channel-leads-unfiltered` (channel-scoped leads cannot follow the host/path filters), `paid-split-needs-landing-page` (channel-scoped leads, and some AI sessions were paid only by landing-page utm tags, so they count as organic), `sessions-behind-leads` (leads stored past the last acquisition date) or `sessions-missing-on-lead-days` (a day in the window has leads but no stored acquisition rows); `unattributed` is GA4 `AI Assistant` channel rows matching no engine; a class's `periods[]` is its engines plus `unattributed`), and `searchDemand.periods/queries/pages` with property totals, reported branded/non-brand rows, and unreported residuals. Each GA component carries independent status/error/sync freshness. | → degrades to the `json` document |
| `cnry ga search-landing-pages <p> [--window 7d\|28d\|90d] [--limit N] [--offset N]` | `GaSearchLandingPagesResponse` @ `contracts/ga.ts`: `{ source, status(never-synced\|ready\|unavailable\|error), error, syncedAt, attemptedAt, window, windowStart, windowEnd, windowDays, timeZone, subjectToThresholding, dataLossFromOtherRow, total, reportRowCount, rowsCapped, totalRows, limit, offset, rows[] }`. `total` and each `rows[]` entry = `{ organicGoogleSearchClicks, organicGoogleSearchImpressions, organicGoogleSearchClickThroughRate (0..1, null with no impressions), organicGoogleSearchAveragePosition (null with no impressions), activeUsers }` (+ `landingPage`, GA4's raw `landingPagePlusQueryString`, on rows). `total` is GA4's TOTAL row and null with no snapshot. `rowsCapped` = GA4 reported `reportRowCount` pages and only the top 10,000 by clicks, then impressions, were stored. | ✅ streams `rows` one / line as `{project, window, windowStart, windowEnd, …row}` (the Total is in `json` only) |
| `cnry ga traffic <p> [--window …]` | Object summary — `GA4TrafficSummaryDto` / `GaTrafficResponse` @ `contracts/ga.ts`: `{ totalSessions, totalOrganicSessions, totalDirectSessions, totalUsers, aiSessionsDeduped, paidAiSessionsDeduped, organicAiSessionsDeduped, aiSessionsBySession, paidAiSessionsBySession, organicAiSessionsBySession, socialSessions, socialUsers, channelBreakdown{organic,social,direct,ai,other→{sessions,sharePct,sharePctDisplay}}, *SharePct (+ `*Display`), topPages[], aiReferrals[], aiReferralLandingPages[], socialReferrals[], lastSyncedAt, periodStart, periodEnd }`. **AI referrals are sessions only.** The six `ai*Users*` fields and the `users` on `aiReferrals[]` / `aiReferralLandingPages[]` were withdrawn in 4.135.0 — GA reports users as a COUNT DISTINCT at the grain requested, so the stored column re-counted one visitor per landing page, medium, channel and date, and no un-dimensioned AI-referral fetch exists to supply a correct figure. `totalUsers` and `socialUsers` are unaffected. | → degrades to the `json` document |
| `cnry ga attribution <p> [--trend]` | Object — a **renamed projection** of `GaTrafficResponse` (⚠️ field names differ from the DTO): `aiSessions`(←`aiSessionsDeduped`), `organicSessions`(←`totalOrganicSessions`), `directSessions`(←`totalDirectSessions`), plus `totalSessions, totalUsers, paidAiSessions, organicAiSessions, aiSessionsBySession, paidAiSessionsBySession, organicAiSessionsBySession, socialSessions, socialUsers, {ai,social,organic,direct}SharePct (+ `*Display`), otherSessions, otherSharePct, channelBreakdown, aiReferrals[], aiReferralLandingPages[], socialReferrals[], periodStart, periodEnd`. With `--trend`: drops `periodStart/End`, adds `trend` (`GaAttributionTrendResponse`). Assembled inline in `commands/ga.ts`. | → degrades to the `json` document |
| `cnry key list` / `key create` / `key revoke <id>` | `list`: `{ keys[] }` — each `ApiKeyDto{ id, name, keyPrefix, scopes[], projectId, projectName, readOnly, createdAt, lastUsedAt, revokedAt }` (SAFE metadata, never the hash or plaintext). `create`: `CreatedApiKeyDto` = `ApiKeyDto` **plus a one-time `key`** (the plaintext `cnry_…` token, shown once). `revoke`: the `ApiKeyDto` with `revokedAt` set. @ `contracts/api-keys.ts` | `key list` streams one key / line; `create` / `revoke` degrade to the `json` document |
| `cnry gbp summary <p> [--location …]` | `{ scope{locationName,locationCount}, performance{totals,recent7d,prior7d,deltaPct} (metric-keyed maps; keys are raw `BUSINESS_*` / `WEBSITE_CLICKS` tokens — label via `formatGbpMetricLabel`), freshness{dataThroughDate,latestStoredDate,pendingDays}, timeseries[], keywords{total,thresholdedCount,thresholdedPct}, placeActions{total,hasReservationCta,hasBookingCta,hasDirectMerchantCta}, lodging{lodgingLocationCount,populatedLodgingCount,emptyLodgingCount}, profileCompleteness{locationCount,withSecondaryCategories,secondaryCategoryTotal,withDescription,withServiceArea,withHours,withPrimaryPhone,permanentlyClosed,temporarilyClosed} }` — `GbpSummaryDto` @ `contracts/gbp.ts`; `emptyLodgingCount` means 0 readable Lodging API groups, a verify signal rather than proof the Hotel details panel is empty. `timeseries[]`=`{date,pending,metrics}`. | → degrades to the `json` document |
| `cnry ads account <p>` | `AdsAccountDto{ id, name, status, currencyCode, timezone, url, reviewStatus, integrityReviewStatus, integrityDecision }` @ `contracts/ads.ts`. This is live provider state, not a synced snapshot. | → degrades to the `json` document |
| `cnry ads geo search <p> --query <text>` | `AdsGeoSearchResponse{ count, query, results[] }` @ `contracts/ads.ts`; each location has `{ id, type, canonicalName, countryCode, name, regionCode }`. | ✅ one result / line as `{project, query, …location}` |
| `cnry ads conversions pixels <p>` / `event-settings <p>` | `{ pixels[] }` / `{ eventSettings[] }` @ `contracts/ads.ts`. Event settings include the conversion event, attribution window, source IDs/details, archive state, and version. | ✅ one pixel/event setting / line as `{project, …row}` |

## Experimental sentiment

```bash
canonry sentiment settings <project> --format json
canonry sentiment configure <project> --enabled true --format json
canonry sentiment <project> --run-id <run> --query-class non-brand --format json
canonry sentiment <project> --run-id <run> --query-class non-brand --include assessments,locations --query-limit 50 --format json
canonry sentiment evidence <project> --run-id <run> --query-class non-brand --query-id <query> --evaluation-definition-id <definition> --format json
canonry sentiment evidence <project> --run-id <run> --query-class non-brand --assessment-id <assessment> --provider <engine> --model <served-model> --format json
canonry sentiment evidence <project> --query-class non-brand --outcome mixed,unfavorable --format json
canonry sentiment evidence <project> --query-class branded --scope property --scope-key <property> --outcome mixed,unfavorable --format json
canonry sentiment compare <project> --from-run-id <before> --to-run-id <after> --format json
canonry sentiment backfill <project> --preview --query-class non-brand --run-id <run> --format json
canonry sentiment backfill <project> --preview --query-class branded --from <ISO-date-time> --to <ISO-date-time> --format json
canonry sentiment backfill <project> --preview-token <returned-token> --idempotency-key <key> --format json
canonry sentiment jobs <project> --format jsonl
canonry sentiment job <project> <job-id> --attempt-limit 50 --format json
```

Reads are stored-only. Install and project switches default off; the install key is
configured locally, never through remote commands. Configure and backfill submission
require install administrator authority. Enabling processes future complete runs;
preview/submit is the explicit historical workflow. Preview requires --query-class branded|non-brand; backfill each class with its own preview and submission. A repeated key with the same
preview returns the same job; changed payloads conflict. Initial settings only
control enablement; there are no theme presets or custom themes.

Summary, evidence, comparison and preview accept run/revision, mode, query class, query ID,
scope/scope key, market key, provider/model, location and evaluation definition.
Advanced `--scope property --scope-key <key> --market-key <key>` preserves exact
frozen usage edges. Keep every selection field and the returned evaluator ID while
following `--cursor`. Branded and non-brand are supported with separate denominators;
select the class explicitly (the default remains branded). Summary includes
server-computed per-query scores, 25 rows per page by default (`--query-limit`
1..500; follow `Next query cursor` / `queryPage.nextCursor` with `--query-cursor`).
Advanced rows are per execution node (`executionNodeKey`; `--execution-node-key`
narrows any read to one node). `--include assessments,locations` adds per-location
scores and `queries[].assessments` with exact engine verdicts, requested/served
models, source IDs, subject, location, state and exclusions; a named `--query-id`
includes both by default. Unclassified sources have no verdict; absent subjects are
not unfavorable. Evidence-only `--assessment-id` selects one returned assessment
within the other filters; retain it with the evaluator and scope when following
a cursor. Evidence-only `--outcome` (comma-separated or repeated) keeps only those
outcomes and is echoed as `selection.outcome`; it never changes scoring. Keep it
when following a cursor. `--model` matches the served source model. For a grouped read, summary and
evidence accept `--run-ids <first> --run-ids <second>` instead of `--run-id`.
Backfill retains repeated `--run-id` for its historical selection. JSON equals the HTTP DTO;
evidence JSONL is one complete page document so empty state and cursor survive.
Jobs JSONL streams one project-stamped job summary (with `attemptCount`) per line; `sentiment job` pages attempt receipts newest first (`--attempt-limit`, `--attempt-cursor`). Favorable rates use judged
assessments; mixed gets no partial credit, absent subjects are excluded, and
partial scores cannot establish improvement or decline. A Simple subject carries the
project's qualified aliases frozen at dispatch as `subject.qualifiedAliases` (see Brand
aliases); earlier runs keep their list (empty before opting in) and are not rescored.
Every change to the list (first set, edit, or clear) starts a new subject boundary at
the first run captured afterward: a pooled read or comparison across it is refused, so
read from the most recent change onward.

Sentiment is a branded figure: non-brand answers name the brand almost only to
recommend it, so read non-brand as exceptions with `--outcome mixed,unfavorable`.
`canonry overview` text prints the branded headline (`Sentiment: <x> favorable ·
branded queries` plus favorable / judged); JSON keeps `sentiment.branded`,
`nonBrand` and `overall` unchanged. A branded summary spanning more than one
Property carries `criticizedProperties` (`total`, and `keys`: the first 5 property
breakdown keys, most mixed plus unfavorable first). Text output lists them under
`Most criticized properties: N of total` with favorable, mixed and unfavorable
counts; read one with `--scope property --scope-key <key> --outcome mixed,unfavorable`
(in a market view, pass that market as `--market-key`).
