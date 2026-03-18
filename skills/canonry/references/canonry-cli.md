# Canonry CLI Reference

## Project Management

```bash
canonry project list                          # list all projects
canonry project create <name> --domain <url> --country US --language en
canonry status <project>                      # citation summary + domain info
```

## Sweeps

```bash
canonry run <project>                         # sweep all configured providers
canonry run <project> --provider gemini       # single provider only
canonry runs <project> --limit 10             # list recent runs
canonry runs <project> --limit 1              # check latest run status
```

Run statuses: `queued` → `running` → `completed` / `failed` / `partial`

Failed runs with "Server restarted while run was in progress" = server killed mid-run, not a provider error.

## Citation Data

```bash
canonry evidence <project>                    # per-keyword cited/not-cited
canonry evidence <project> --format json      # JSON output
```

Output shows:
- `✓ cited` — domain appeared in AI response for that keyword
- `✗ not-cited` — domain did not appear
- Summary: `Cited: X / Y`

## Google Search Console

```bash
canonry google coverage <project>             # indexed vs unindexed pages
canonry google request-indexing <project> <url>   # push URL to Google Indexing API
canonry google request-indexing <project> --all-unindexed  # push all unknown pages
```

Coverage statuses:
- `indexed` — Google knows and has indexed the page
- `Discovered - currently not indexed` — Google found it, hasn't crawled yet
- `URL is unknown to Google` — never crawled, highest priority to submit

## Bing Webmaster Tools

```bash
canonry bing connect <project> --api-key <key>   # connect Bing WMT
canonry bing status <project>                     # connection status
canonry bing sites <project>                      # list verified sites
canonry bing set-site <project> <url>             # set active site URL
canonry bing coverage <project>                   # URL coverage data
canonry bing inspect <project> <url>              # inspect specific URL
```

Note: Bing coverage data takes 24–48h after verification to populate.

## Sitemap Inspection

```bash
canonry sitemap inspect <project>             # inspect sitemap URLs
```

## Settings

```bash
canonry settings                              # show config: providers, apiUrl, db path, api key
canonry settings --format json               # JSON output
```

## Output Formats

Most commands support `--format json` for machine-readable output.

## Server Management

```bash
canonry start                                 # start daemon
canonry stop                                  # stop daemon
canonry serve                                 # foreground mode
canonry --version                             # version check
```

Production is managed by PM2:
```bash
pm2 status                                    # check canonry process
pm2 logs canonry                              # tail logs
pm2 restart canonry                           # restart after upgrade
```

## Active Projects & Providers (ainyc.ai)

- Project: `ainyc` → `ainyc.ai`, US, en
- Providers: `gemini` (gemini-3-flash-preview), `openai` (gpt-5.4), `claude` (claude-opus-4-6)
- Quota per provider: 2 concurrent · 10/min · 500/day
- Keywords: 11 tracked, 4/11 cited as of 2026-03-18
