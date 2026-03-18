---
name: canonry
description: AEO citation monitoring and analysis using canonry CLI. Use when: running visibility sweeps across AI providers (Gemini, OpenAI, Claude), checking citation status for a project, interpreting sweep results, diagnosing citation drops or gains, comparing competitor visibility, managing Google/Bing indexing for AEO, or onboarding a new client project into canonry. This is Aero's primary instrument — use it for any task involving AI citation data.
---

# Canonry

Canonry is the CLI-native AEO monitoring tool. It runs prompts against AI providers and tracks which keywords earn citations for a client's domain.

## Core Principle

**Canonry is an observability tool, not an instant feedback loop.** Sweeps show citation state at that moment. Site changes don't immediately appear — AI models re-index on unknown schedules (days to months). Run sweeps regularly to track trends; never promise that a fix will show up in the next sweep.

## Quick Reference

```bash
canonry project list                    # list all projects
canonry status <project>                # citation summary
canonry evidence <project>              # per-keyword citation detail
canonry run <project>                   # run a sweep (costs money — confirm first)
canonry runs <project> --limit 5        # recent run history
canonry settings                        # configured providers + quotas
canonry --version                       # current version
```

**Always confirm with the user before running a sweep.** Sweeps consume provider API quota.

## Interpreting Results

See [references/aeo-analysis.md](references/aeo-analysis.md) for:
- What cited vs. not-cited means
- How to spot regressions and wins
- Competitor citation patterns
- What to recommend when visibility is low

## CLI Reference

See [references/canonry-cli.md](references/canonry-cli.md) for full command syntax, flags, and output formats.

## Indexing Workflows

See [references/indexing.md](references/indexing.md) for:
- Google Indexing API (`canonry google request-indexing`)
- GSC coverage checks (`canonry google coverage`)
- Bing Webmaster Tools setup and IndexNow submission
- When to use each tool

## Project Onboarding

```bash
# Check if project exists
canonry project list

# View settings and providers
canonry settings

# Run first evidence check (no sweep needed)
canonry evidence <project>
```

If a project doesn't exist, it must be created via the canonry UI or API before sweeps can run.

## Infrastructure

- Production server: `https://agent-node.tail3c94a0.ts.net/canonry/` (Tailscale only)
- Local port: `4100`, managed by PM2
- Config: `~/.canonry/` — treat as sacred, never write here during testing
- `apiUrl` in config must include basePath: `http://localhost:4100/canonry`
- Deploy: `git pull → pnpm build → npm install -g ./packages/canonry → pm2 restart canonry`

## Safety

- Never run `canonry run` without explicit user confirmation
- Never write to `~/.canonry/` during PR testing (use isolated config dir + port 4201)
- Use `git worktree` for testing PRs — never build in the main workspace
