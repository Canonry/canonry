---
name: canonry-setup
description: Install, configure, and operate canonry — an open-source AEO monitoring CLI. Use when setting up canonry from scratch, running visibility sweeps, interpreting citation results, managing projects/keywords/competitors, troubleshooting errors, or performing competitive analysis. Triggers on phrases like "set up canonry", "run a sweep", "check citations", "AEO monitoring", "canonry install", "canonry status", "track AI visibility".
---

# Canonry

Open-source AEO monitoring CLI. Tracks how AI answer engines (ChatGPT, Gemini, Claude) cite or omit a domain for target keywords.

**Repo:** github.com/AINYC/canonry | **npm:** `@ainyc/canonry`

## Install

### From npm (users)

```bash
npm install -g @ainyc/canonry
canonry --version
```

### From source (contributors/agents)

```bash
cd <canonry-repo>
pnpm install
pnpm -r run build    # required — dist/ doesn't exist until built
npm install -g ./packages/canonry
canonry --version
```

If global install fails with EACCES, set a user prefix:
```bash
mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"  # add to ~/.bashrc
```

Before committing changes: `pnpm typecheck && pnpm lint && pnpm test` — all three must pass.

## Configure

### Non-interactive (preferred for agents/CI)

```bash
canonry init --gemini-key <KEY> --openai-key <KEY> --claude-key <KEY>
```

Or via environment variables:
```bash
GEMINI_API_KEY=... OPENAI_API_KEY=... ANTHROPIC_API_KEY=... canonry init
```

### Interactive (humans)

```bash
canonry init
```

Prompts for each provider key. Press Enter to skip a provider.

### Verify

```bash
canonry settings
canonry settings --format json
```

At least one provider must be configured.

## Server

The server must be running for most commands.

```bash
canonry start              # background daemon
canonry stop               # stop daemon
canonry serve              # foreground (for debugging)
canonry serve --host 0.0.0.0 --port 4100  # expose on network
```

If commands fail with "fetch failed" → the server isn't running.

## Core Workflow

### 1. Create a project

```bash
canonry project create <name> --domain <domain>
canonry project list
canonry project show <name>
```

### 2. Add keywords

```bash
canonry keyword add <project> "phrase one" "phrase two"
canonry keyword generate <project> --provider gemini --count 10 --save
canonry keyword list <project>
canonry keyword import <project> keywords.txt
```

Choose keywords that match how real users query AI — natural language questions and short phrases. Include variations (word order matters: "NYC AEO Agency" ≠ "AEO Agency NYC").

### 3. Add competitors

```bash
canonry competitor add <project> competitor1.com competitor2.com
canonry competitor list <project>
```

### 4. Run a sweep

```bash
canonry run <project> --wait          # all providers, block until done
canonry run <project> --provider gemini --wait  # single provider
canonry run --all --wait              # all projects
```

Without `--wait`, returns a run ID immediately. Check with `canonry run show <id>`.

Sweeps send each keyword to each provider's web search API and record whether the canonical domain appears in citations/grounding sources. Typical runtime: 1-3 minutes for 5 keywords × 3 providers.

### 5. View results

```bash
canonry status <project>              # summary
canonry evidence <project>            # per-keyword breakdown
canonry runs <project>                # run history
canonry run show <id>                 # single run detail with snapshots
```

All commands support `--format json` for machine-readable output.

### 6. Interpret results

Each snapshot has a `citationState`:
- **cited** — the domain appeared in the provider's grounding sources or answer citations
- **not-cited** — the provider answered but didn't cite the domain

Key fields in JSON output:
- `citedDomains` — all domains the provider cited
- `competitorOverlap` — which tracked competitors appeared
- `answerText` — the full AI-generated answer

**Patterns to look for:**
- Provider variance: cited on Claude but not Gemini = different knowledge bases
- Keyword sensitivity: longer/more specific phrases often cite more readily
- Competitor dominance: if a competitor appears in most snapshots, they have stronger signals
- Run-to-run variance: AI answers are non-deterministic — single sweeps aren't conclusive, track trends over multiple runs

## Scheduling & Notifications

```bash
canonry schedule set <project> --preset daily     # or: weekly, twice-daily, daily@09
canonry schedule set <project> --cron "0 9 * * *" --timezone America/New_York
canonry schedule show <project>
canonry schedule enable <project>
canonry schedule disable <project>

canonry notify add <project> --webhook <url> --events citation.lost,citation.gained
canonry notify events          # list all available event types
canonry notify list <project>
canonry notify test <project> <id>
```

Available events: `citation.lost`, `citation.gained`, `run.completed`, `run.failed`

## Provider Settings & Quotas

```bash
canonry settings provider gemini --api-key <KEY> --model gemini-2.5-flash
canonry settings provider openai --max-per-day 1000 --max-per-minute 20
```

Quota flags: `--max-concurrent`, `--max-per-minute`, `--max-per-day`

If a provider hits rate limits (429 errors), the run completes as `partial`. Reduce concurrency or increase time between sweeps.

## Config as Code

```bash
canonry export <project> --include-results > project.yaml
canonry apply project.yaml
```

## Troubleshooting

| Error | Fix |
|-------|-----|
| `fetch failed` | Server not running. Run `canonry start` |
| `Config not found` | Run `canonry init` |
| `canonry: command not found` | Check PATH includes npm global bin dir |
| `429 rate_limit_error` | Provider quota hit. Wait or reduce sweep frequency |
| `No providers configured` | Run `canonry settings` — add at least one API key |
| `Daily quota exceeded` | Wait for next UTC day or increase `--max-per-day` |
| Run status `partial` | Some providers failed (usually rate limits). Successful snapshots are still saved |
| `ERR_MODULE_NOT_FOUND dist/cli.js` | Source install without build. Run `pnpm -r run build` |
