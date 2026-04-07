# Canonry CLI Reference

## Server Management

```bash
canonry init                                      # interactive setup
canonry bootstrap                                 # non-interactive setup from env vars
canonry start                                     # start daemon
canonry stop                                      # stop daemon
canonry serve                                     # foreground mode
canonry serve --host 0.0.0.0 --port 4100
canonry --version
```

Production managed by PM2:
```bash
pm2 status
pm2 logs canonry
pm2 restart canonry
```

## Project Management

```bash
canonry project list                              # list all projects
canonry project create <name> --domain <url> --country US --language en
canonry project show <name>                       # project detail
canonry project update <name>                     # update project settings
canonry project delete <name>                     # delete a project
canonry status <project>                          # citation summary + domain info
```

### Locations

Projects support multi-region location context for geographically-aware sweeps:

```bash
canonry project add-location <name> --label "NYC" --city "New York" --region NY --country US
canonry project locations <name>                  # list configured locations
canonry project set-default-location <name> <label>
canonry project remove-location <name> <label>
```

## Sweeps

```bash
canonry snapshot "Acme Corp" --domain acme.example.com      # one-shot sales snapshot
canonry snapshot "Acme Corp" --domain acme.example.com --md          # save markdown report
canonry snapshot "Acme Corp" --domain acme.example.com --output report.md  # custom path
canonry snapshot "Acme Corp" --domain acme.example.com --pdf         # save PDF report
canonry snapshot "Acme Corp" --domain acme.example.com --format json

canonry run <project>                             # sweep all configured providers
canonry run <project> --provider gemini           # single provider only
canonry run <project> --wait                      # block until complete
canonry run <project> --location <label>          # run with specific location context
canonry run <project> --all-locations             # run for every configured location
canonry run <project> --no-location               # explicitly skip location context
canonry run --all --wait                          # all projects
canonry run cancel <project> [run-id]             # force-cancel stuck runs
canonry runs <project> --limit 10                 # list recent runs
canonry run show <id>                             # show run details
```

Run statuses: `queued` → `running` → `completed` / `failed` / `partial`

`partial` = some providers failed (usually rate limits) — successful snapshots are still saved.

`snapshot` does not create a project or write to the DB. It generates category queries, runs providers, and produces a report for prospecting.

## Citation Data

```bash
canonry evidence <project>                        # per-keyword cited/not-cited
canonry evidence <project> --format json          # JSON output
canonry history <project>                         # audit trail
canonry export <project> --include-results        # export as YAML
canonry backfill answer-visibility                # recompute answer visibility from stored answers
canonry backfill answer-visibility --project <name> --format json
```

Output shows:
- `✓ cited` — domain appeared in AI response for that keyword
- `✗ not-cited` — domain did not appear
- Summary: `Cited: X / Y`

## Analytics

```bash
canonry analytics <project>                       # default analytics view
canonry analytics <project> --feature metrics     # citation rate trends
canonry analytics <project> --feature gaps        # brand gap analysis (cited/gap/uncited)
canonry analytics <project> --feature sources     # source breakdown by category
canonry analytics <project> --window 7d           # time window: 7d, 30d, 90d, all
```

## Intelligence

```bash
canonry insights <project>                        # list active insights (regressions, gains, opportunities)
canonry insights <project> --dismissed            # include dismissed insights
canonry insights <project> --format json          # JSON output
canonry insights dismiss <project> <id>           # dismiss an insight
canonry health <project>                          # latest citation health snapshot
canonry health <project> --history                # health trend over time
canonry health <project> --history --limit 10     # limit history entries
canonry health <project> --format json            # JSON output
canonry backfill insights <project>              # backfill insights for all completed runs
canonry backfill insights <project> --from-run <id> --to-run <id>  # backfill a range
```

## Keywords & Competitors

```bash
canonry keyword add <project> "phrase one" "phrase two"
canonry keyword remove <project> "phrase"
canonry keyword list <project>
canonry keyword import <project> keywords.txt
canonry keyword generate <project> --provider gemini --count 10 --save

canonry competitor add <project> competitor1.com competitor2.com
canonry competitor list <project>
```

## Scheduling & Notifications

```bash
canonry schedule set <project> --preset daily     # or: weekly, twice-daily, daily@09
canonry schedule set <project> --cron "0 9 * * *" --timezone America/New_York
canonry schedule show <project>
canonry schedule enable <project>
canonry schedule disable <project>
canonry schedule remove <project>

canonry notify add <project> --webhook <url> --events citation.lost,citation.gained
canonry notify events                             # list all available event types
canonry notify list <project>
canonry notify remove <project> <id>
canonry notify test <project> <id>
```

Available events: `citation.lost`, `citation.gained`, `run.completed`, `run.failed`

## Provider Settings & Quotas

```bash
canonry settings                                  # show config: providers, apiUrl, db path
canonry settings --format json
canonry settings provider gemini --api-key <KEY> --model gemini-2.5-flash
canonry settings provider openai --max-per-day 1000 --max-per-minute 20
canonry settings provider perplexity --api-key <KEY>
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
canonry google connect <project>                          # initiate OAuth flow
canonry google disconnect <project>                       # disconnect GSC
canonry google status <project>                           # connection status
canonry google properties <project>                       # list available properties
canonry google set-property <project> <url>               # set GSC property URL
canonry google set-sitemap <project> <url>                # set sitemap URL
canonry google list-sitemaps <project>                    # list submitted sitemaps
canonry google discover-sitemaps <project> --wait         # auto-discover and inspect

canonry google sync <project>                             # sync GSC data
canonry google sync <project> --days 30 --full --wait     # full sync with wait

canonry google coverage <project>                         # index coverage summary
canonry google refresh <project>                         # force-fetch fresh GSC coverage data
canonry google performance <project>                      # search performance data
canonry google performance <project> --days 30 --keyword "term" --page "/url"

canonry google inspect <project> <url>                    # inspect specific URL
canonry google inspect-sitemap <project> --wait           # bulk inspect all sitemap URLs
canonry google inspections <project>                      # inspection history
canonry google inspections <project> --url <url>          # filter by URL
canonry google deindexed <project>                        # pages that lost indexing

canonry google request-indexing <project> <url>           # push URL to Google
canonry google request-indexing <project> --all-unindexed # push all unknown pages
```

## Bing Webmaster Tools

```bash
canonry bing connect <project> --api-key <key>   # connect Bing WMT
canonry bing disconnect <project>                # disconnect
canonry bing status <project>                    # connection status
canonry bing sites <project>                     # list verified sites
canonry bing set-site <project> <url>            # set active site URL
canonry bing coverage <project>                  # URL coverage data
canonry bing refresh <project>                  # force-fetch fresh Bing coverage data
canonry bing inspect <project> <url>             # inspect specific URL
canonry bing inspections <project>               # inspection history
canonry bing request-indexing <project> <url>    # submit URL for indexing
canonry bing request-indexing <project> --all-unindexed  # submit all unindexed
canonry bing performance <project>               # search performance data
```

## WordPress Integration

```bash
canonry wordpress connect <project> --url <url> --user <user>   # connect (prompts for app password)
canonry wordpress disconnect <project>                          # disconnect
canonry wordpress status <project>                              # connection status
canonry wordpress pages <project> [--live|--staging]            # list pages
canonry wordpress page <project> <slug>                         # show page detail
canonry wordpress create-page <project> --title <t> --slug <s> --content <c>  # create page
canonry wordpress update-page <project> <slug> --content <c>   # update page
canonry wordpress set-meta <project> <slug> --title <t>        # set SEO meta (single page)
canonry wordpress set-meta <project> --from <file>              # bulk set SEO meta from JSON
canonry wordpress schema <project> <slug>                       # read page JSON-LD
canonry wordpress schema deploy <project> --profile <file>      # deploy schema from profile
canonry wordpress schema status <project>                       # schema status per page
canonry wordpress set-schema <project> <slug>                   # manual schema handoff
canonry wordpress audit <project>                               # audit pages for SEO issues
canonry wordpress diff <project> <slug>                         # compare live vs staging
canonry wordpress staging status <project>                      # staging config status
canonry wordpress staging push <project>                        # manual staging push handoff
canonry wordpress llms-txt <project>                            # read /llms.txt
canonry wordpress set-llms-txt <project>                        # manual llms.txt handoff
canonry wordpress onboard <project> --url <url> --user <user>  # full onboarding workflow
```

**Onboard** runs: connect → audit → set-meta → schema deploy → Google submit → Bing submit. Use `--skip-schema` or `--skip-submit` to skip steps. `--profile <file>` provides business data and page-to-schema mapping for schema deployment.

## Google Analytics 4

GA4 integration uses service account authentication (no OAuth). The service account must have Viewer access on the GA4 property.

```bash
canonry ga connect <project> --property-id <id> --key-file ./sa-key.json  # connect GA4
canonry ga disconnect <project>                  # disconnect
canonry ga status <project>                      # connection status
canonry ga sync <project> [--days 30]            # pull traffic + AI referral data
canonry ga traffic <project>                     # landing pages + AI referral sources
canonry ga coverage <project>                    # indexed pages with traffic overlay
```

## CDP / Browser Provider

The CDP (Chrome DevTools Protocol) provider enables browser-based queries against AI chat interfaces (e.g., ChatGPT). This gives more accurate results than API-based providers for some use cases.

```bash
canonry cdp connect --host localhost --port 9222  # connect to Chrome CDP
canonry cdp status                                # show connection status
canonry cdp targets                               # list available targets (ChatGPT, etc.)
canonry cdp screenshot <query> --targets chatgpt  # screenshot a query result
```

**Requires:** Chrome running with `--remote-debugging-port=9222`

## Telemetry

```bash
canonry telemetry status                          # show telemetry status
canonry telemetry enable                          # enable anonymous telemetry
canonry telemetry disable                         # disable telemetry
```

## Config as Code

```bash
canonry apply project.yaml                        # apply declarative config
canonry apply file1.yaml file2.yaml               # multiple files
canonry export <project> --include-results > project.yaml
canonry sitemap inspect <project>
```

## Output Formats

Most commands support `--format json` for machine-readable output.
