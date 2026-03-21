---
name: canonry
slug: canonry
homepage: https://ainyc.ai
description: Open-source AEO monitoring CLI. Track how AI answer engines cite your domain across ChatGPT, Gemini, Claude, and Perplexity.
---

# Canonry

Open-source AEO (Answer Engine Optimization) monitoring CLI by [AINYC](https://ainyc.ai). Tracks how AI answer engines cite or omit a domain for target keywords.

- **Website:** [ainyc.ai](https://ainyc.ai)
- **GitHub:** [github.com/AINYC/canonry](https://github.com/AINYC/canonry)
- **npm:** `@ainyc/canonry`

## When to Use

Use this skill when setting up canonry, running visibility sweeps, interpreting citation results, managing projects/keywords/competitors, troubleshooting errors, performing competitive analysis, managing Google/Bing indexing, or working with analytics.

## Quick Start

```bash
npm install -g @ainyc/canonry
canonry init --gemini-key <KEY> --openai-key <KEY> --claude-key <KEY>
canonry start
canonry project create mysite --domain example.com
canonry keyword add mysite "best widget maker" "how to build widgets"
canonry run mysite --wait
canonry evidence mysite
```

## Key Concepts

- **Sweeps** query AI providers and record whether your domain was cited
- **Evidence** shows per-keyword cited/not-cited results
- **Analytics** tracks citation trends, gaps, and source breakdowns over time
- Canonry is an **observability tool** — site changes take days/months to appear in AI responses

**Always confirm with the user before running a sweep.** Sweeps consume provider API quota.

## Reference

| Topic | File |
|-------|------|
| Full CLI commands | [references/canonry-cli.md](references/canonry-cli.md) |
| Interpreting results | [references/aeo-analysis.md](references/aeo-analysis.md) |
| Indexing workflows | [references/indexing.md](references/indexing.md) |

## Common Errors

| Error | Fix |
|-------|-----|
| `fetch failed` | Server not running — `canonry start` |
| `Config not found` | Run `canonry init` |
| `canonry: command not found` | Check PATH includes npm global bin |
| `429 rate_limit_error` | Provider quota hit — wait or reduce sweep frequency |
| Run status `partial` | Some providers failed — successful snapshots still saved |
| CDP connection refused | Chrome not running with `--remote-debugging-port` |
