---
name: memory-patterns
description: When to remember vs. re-query — project state lives in canonry, only durable user-scoped facts go in Aero memory. Read when unsure whether to call remember or look up.
---

# Memory Patterns

Canonry is the source of truth for project state. Do **not** maintain a parallel copy of project facts in Aero memory — it will drift from the DB and mislead the next session.

Aero now ships with a built-in durable notes store — the `remember`, `forget`, and `recall` tools — backed by the `agent_memory` table. The N most-recently-updated notes are injected into the system prompt at every session start, so you usually see relevant memory without calling `recall`.

## What belongs where

| Scope | Examples | Home |
|---|---|---|
| **Project state** | Baselines, historical regressions, citation rates per keyword/provider, recent insights, sweep history, audit trail | Canonry DB — query via CLI / API / read tools |
| **Operator facts** | Personal preferences, non-observable context ("content lead is Sarah", "migrating off Webflow next quarter"), tone/voice preferences the operator confirmed | Aero memory (`remember`) |
| **Session scratch** | "I just tried X and it failed", intermediate reasoning, turn-local state | Nowhere — let it die with the session |

## How to read project state from canonry

Prefer Aero's read tools (`get_status`, `get_health`, `get_timeline`, `get_insights`, `list_keywords`, `list_competitors`, `get_run`) over shelling out, but the CLI exists for operators too:

```bash
canonry status <project> --format json
canonry health <project> --format json
canonry timeline <project> --since <YYYY-MM-DD> --format json
canonry insights <project> --format json
canonry evidence <project> --format json
canonry audit <project> --format json
```

If the data you need isn't reachable with a single read tool or CLI call, that's a bug in canonry's API surface — file it rather than working around it in memory.

## Regenerate, don't remember

Derived interpretations (trend summaries, correlations between events) are cheap to recompute from the underlying DB rows. Prefer running the analysis again on fresh data over recalling what you concluded last session — conclusions age, the data doesn't.

## Using `remember` / `forget` / `recall`

- `remember(key, value)` — upsert a project-scoped note. Capped at 2 KB per value. Same key replaces the prior value, so use stable keys (e.g. `operator-pref.reporting-tone`, not `note-2026-04-17`).
- `forget(key)` — remove a single note. Returns `status: missing` when the key never existed (non-fatal).
- `recall(limit?)` — read notes newest-first. Usually unnecessary — the top 20 are already in the system prompt under `<memory>`. Reach for it when you need older context or the full value of a note that's been summarized.

**Reserved prefix.** Keys starting with `compaction:` are reserved for LLM-summarized transcript slices. `remember` and `forget` both reject them. Compaction notes are pruned automatically — you can `recall` them but never write or delete them by hand.

**CLI parity.** Operators can manage memory without talking to you:

```bash
canonry agent memory list <project> --format json
canonry agent memory set <project> --key <k> --value <v>
canonry agent memory forget <project> --key <k>
```

## Good remember candidates

- Operator-confirmed facts canonry can't observe (team names, migration plans, vendor lock-in, upcoming content bets).
- Stable preferences the operator has validated at least once ("report weekly", "prefer Claude over GPT for prose", "never auto-dismiss insights").
- Non-obvious decisions made mid-investigation that a future turn would re-derive wastefully ("confirmed competitor X is out of scope").

## Bad remember candidates

- Anything canonry already tracks (runs, insights, citation rates, schedules). Query it.
- Turn-local state that's useful for one follow-up and then noise ("user just asked about keyword Y").
- Raw evidence or long transcripts — persist a conclusion, not a dump.
- Unvalidated guesses. Memory isn't a place to think aloud; it's a place to record things you're willing to act on next session.
