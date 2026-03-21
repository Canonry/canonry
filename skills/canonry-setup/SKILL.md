---
name: canonry-setup
description: Install, configure, and operate canonry — an open-source AEO monitoring CLI. Use when setting up canonry from scratch, running visibility sweeps, interpreting citation results, managing projects/keywords/competitors, troubleshooting errors, performing competitive analysis, managing Google/Bing indexing, browser-based provider queries, or analytics. Triggers on phrases like "set up canonry", "run a sweep", "check citations", "AEO monitoring", "canonry install", "canonry status", "track AI visibility", "why am I not being cited", "check indexing", "canonry analytics", or any task involving AI citation data.
---

# Canonry

Open-source AEO monitoring CLI. Tracks how AI answer engines (ChatGPT, Gemini, Claude, Perplexity) cite or omit a domain for target keywords.

**Repo:** github.com/AINYC/canonry | **npm:** `@ainyc/canonry`

## Core Principle

**Canonry is an observability tool, not an instant feedback loop.** Sweeps show citation state at that moment. Site changes don't immediately appear in results — AI models re-index on unknown schedules (days to months). Run sweeps regularly to track trends; never promise a fix will show up in the next sweep.

**Always confirm with the user before running a sweep.** Sweeps consume provider API quota.

## Install

### From npm

```bash
npm install -g @ainyc/canonry
canonry --version
```

### From source

```bash
cd <canonry-repo>
pnpm install && pnpm -r run build
npm install -g ./packages/canonry
canonry --version
```

If `EACCES`: `mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global` and add to PATH.

Before committing: `pnpm typecheck && pnpm lint && pnpm test` — all three must pass.

## Configure

```bash
canonry init --gemini-key <KEY> --openai-key <KEY> --claude-key <KEY>
canonry settings        # verify providers
```

The server must be running for most commands:
```bash
canonry start           # background daemon
canonry serve           # foreground (debugging)
```

## Core Workflow

```bash
canonry project list                    # see all projects
canonry status <project>                # citation summary
canonry evidence <project>              # per-keyword cited/not-cited
canonry run <project> --wait            # run a sweep (confirm cost first)
canonry runs <project> --limit 5        # recent run history
canonry analytics <project>             # citation trends and gaps
```

### Setup a new project

```bash
canonry project create <name> --domain <domain>
canonry keyword add <project> "phrase one" "phrase two"
canonry competitor add <project> competitor1.com
```

## Interpreting Results

See [references/aeo-analysis.md](references/aeo-analysis.md) for:
- What cited vs. not-cited means
- Diagnosing content gaps vs. indexing gaps vs. competitive gaps
- Using analytics (metrics, gaps, sources) for trend analysis
- Trend interpretation and what to recommend

## Full CLI Reference

See [references/canonry-cli.md](references/canonry-cli.md) for all commands, flags, scheduling, notifications, analytics, locations, browser provider, and provider quota management.

## Indexing Workflows

See [references/indexing.md](references/indexing.md) for:
- Google Indexing API (`canonry google request-indexing`)
- GSC coverage, sync, and performance (`canonry google coverage/sync/performance`)
- Bing Webmaster Tools, IndexNow, and Bing indexing submission
- Sitemap discovery and bulk URL inspection

## Troubleshooting

| Error | Fix |
|-------|-----|
| `fetch failed` | Server not running — `canonry start` |
| `Config not found` | Run `canonry init` |
| `canonry: command not found` | Check PATH includes npm global bin |
| `429 rate_limit_error` | Provider quota hit — wait or reduce sweep frequency |
| `ERR_MODULE_NOT_FOUND dist/cli.js` | Source install without build — `pnpm -r run build` |
| Run status `partial` | Some providers failed (rate limits) — successful snapshots still saved |
| "Server restarted while run was in progress" | Server killed mid-run (not a provider error) |
| CDP connection refused | Chrome not running with `--remote-debugging-port` |
