---
name: memory-patterns
description: What to persist vs. re-query — project state lives in canonry, only user-scoped facts go in agent memory. Read when unsure whether to remember or look up.
---

# Memory Patterns

Canonry is the source of truth for project state. Do **not** maintain a parallel copy of project facts in agent memory — it will drift from the DB and mislead the next session.

## What belongs where

| Scope | Examples | Home |
|---|---|---|
| **Project state** | Baselines, historical regressions, citation rates per keyword/provider, recent insights, sweep history, audit trail | Canonry DB — query via CLI / API |
| **User preferences** | How the operator likes reports framed, tone, comms style, tools they already use | Platform-native memory (Claude Code auto-memory, Codex thread metadata, etc.) |
| **Session scratch** | "I just tried X and it failed", intermediate reasoning | Platform-native memory (dies with the session) |

## How to read project state from canonry

Always use `--format json` for structured output:

```bash
# Current health + latest run summary
canonry status <project> --format json
canonry health <project> --format json

# Historical trend
canonry timeline <project> --since <YYYY-MM-DD> --format json
canonry history <project> --format json

# Insights already surfaced (don't regenerate — query)
canonry insights <project> --format json

# Raw evidence from the most recent sweep
canonry evidence <project> --format json

# Audit log — who changed what and when
canonry audit <project> --format json
```

If the data you need isn't reachable with a single CLI call, that's a bug in canonry's API surface — file it rather than working around it in memory.

## Regenerate, don't remember

Derived interpretations (trend summaries, correlations between events) are cheap to recompute from the underlying DB rows. Prefer running the analysis again on fresh data over recalling what you concluded last session — conclusions age, the data doesn't.

The one exception: if the operator gave you a *fact* that canonry can't observe ("the content lead is named Sarah", "they're migrating off Webflow next quarter"), persist it in platform-native memory as user-scoped context.
