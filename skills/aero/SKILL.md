---
name: aero
description: "Interpret Canonry AI visibility, Advanced multi-property portfolios, and Site Health evidence. Use when comparing Properties or markets, explaining mention or citation changes, diagnosing crawl or page findings, preparing client reports, or analyzing a completed `cnry` sweep or site audit. Preserves measurement scope, missing-data states, and comparison limits. Use the canonry skill for setup and operations."
metadata:
  homepage: https://canonry.ai
  repository: https://github.com/AINYC/aero
---

# Aero Orchestration Skill

Use Canonry's stored evidence to explain AI visibility and site readiness. In
built-in Aero, call the available `canonry_*` tools directly. Project-scoped
tools use the session's project; they do not accept a different project from
the model. External agents can use connected MCP or `cnry <command> --format
json`. CLI examples in the references are for hosts with a shell; built-in
Aero should use the corresponding exposed tool, not invent shell access.

Canonry is the source of truth for runs, measurement plans, Property evidence,
Site Health audits, integrations, and history. Read stored page audits before
proposing fresh `aeo-audit` work. New crawls and provider work require approval
covering that work; an existing explicit authorization remains valid.

## Choose the evidence scope

- **Simple portfolio:** use project overview, visibility statistics, and stored
  answer evidence. **Advanced portfolio:** read the active plan and use the
  measurement tools. Preserve Property/Target identity, market, plan revision,
  run, provider/model, location, and query class. Read
  `references/portfolio-analysis.md` before ranking Properties or comparing
  Advanced results.
- **Site Health:** read `references/site-health.md` before diagnosing scores,
  crawl coverage, internal links, or page findings. Technical readiness is a
  separate signal from measured mentions and citations.
- Missing runs, `not_measured`, unavailable metrics, and unchecked signals
  are not zero. Use returned numerators, denominators, and availability
  reasons; do not average Property percentages or sum overlapping markets.
- The dashboard chat supplies the project and message, not its selected
  Property, market, filters, or graph page. Resolve explicit names/URLs from
  stored data. If "this Property" or "this page" remains ambiguous, ask which
  one before making a scoped claim. State the scope used for broad questions.
- Read `references/agent-operations.md` for shared vocabulary, evidence,
  comparison, and authority rules. Its MCP onboarding instructions apply to
  external hosts; built-in Aero already has its tool catalog and skill-doc
  readers. Tool descriptions define the parameters actually available.

Persist only *user-scoped* context (operator preferences, communication style) in your platform's native memory. Project-scoped facts live in canonry and must be read back, not remembered.

**Two signals, not one.** Every (query × provider) snapshot tracks **mentioned** (brand in answer text) and **cited** (domain in source links) independently. Lead with **Mention Coverage** when narrating AI visibility and report **Citation Coverage** as the secondary signal. Never compute one from the other, and never collapse them into a single "visibility" headline. For Site Health questions, lead with the requested audit or crawl evidence.

When a project has GA4 connected, traffic is a first-class signal alongside
mentions and citations. Use `cnry ga traffic` and `cnry ga attribution --trend`
for the current snapshot. Use the GA referral-history commands for daily series.
Before you quote GA4 data, make sure that `cnry ga status` has a recent
`lastSyncedAt`. If it is stale, get approval before you run `cnry ga sync`.

For Cloud Run, WordPress, Vercel, or Cloudflare, use `cnry traffic status` and
`cnry traffic events` for crawler and AI-referral evidence. Read the Cloudflare
`deliveryMode` before you recommend an action. Direct push does not use
`traffic sync`. Queue pull freshness requires an enabled `traffic-sync`
schedule. Run the `traffic.source.*` doctor checks. Inspect
`traffic.source.queue-backlog` before you quote current Queue data. If more than
1,000 messages remain, report that one default tick cannot drain the backlog.
Get approval before you run a manual sync or change the schedule. The full
command reference is in the co-installed
`canonry/references/canonry-cli.md`.

**Diagnosing a stuck Vercel/Cloud Run source:** if `cnry traffic status` shows `status=error` with a recent `lastError` of `refusing to advance` or `ExceedsBillingLimitError`, the source's `lastSyncedAt` has aged past the upstream retention boundary and every sync now throws. Recovery: `cnry traffic reset <project> --source <id> --advance-to-now`. This advances `lastSyncedAt` to NOW and resumes going-forward syncs — historical events in the gap are unrecoverable from the sync path; run `cnry traffic backfill --days N` separately if any of that history is needed (capped at retention).

## Judgment Rules

### AI visibility priorities

Mention is the primary gauge (see "Two signals, not one" above); citation is the secondary signal on the same query. Rank work accordingly:

1. **Branded-term mention loss** — the engine no longer MENTIONING your brand by name is the most urgent regression. Losing the citation for your own name is the secondary signal on the same query: report it, but the mention is what moved share.
2. **Mention-share losses** — a competitor took mention share on a query where yours fell. Rank by share swing first, then by any lost citation on the same query.
3. **Neither mentioned nor cited** — new queries where you are absent on both signals (not mentioned and not cited). Mention gap leads; the missing citation is the trailing clause.
4. **Indexing issues** — pages not indexed can't be cited, and a weak/unindexed page also starves the engine of reasons to mention you. Keep this on the list; it feeds both signals.
5. **Content optimization** — improve mention rate first (give the answer a reason to name you), then cited rate on partially-covered queries.

### What NOT to Do
- Don't promise fixes will appear in the next sweep (AEO changes take weeks/months)
- Ground AI visibility recommendations in mention and citation evidence. Ground Site Health recommendations in persisted audit and crawl findings.
- Don't run sweeps, probes, syncs, audits, discovery sessions, or any other write or quota-consuming operation without explicit user approval
- Don't edit client's code without showing diffs and getting approval
- Don't conflate "not mentioned" with "page doesn't exist" — and don't conflate "not cited" with "not mentioned" either; check first. The two signals are independent (see "Two signals, not one") and are never computed from each other.
- Don't coerce `answerMentioned` null → false. Null means "not checked," not "not mentioned" — treat it as missing data, never as a negative.

### When to use `--probe` runs
When a verification would help, propose the exact probe and get explicit
approval before running it. A probe is safer for metrics than a real sweep, but
it is still a paid/quota-consuming write. After approval, use `cnry run
<project> --probe --provider <p> --query "..."`. Probe runs:
- Still cost provider API quota (same wire call)
- Write a snapshot you can inspect via `cnry runs get <id>`
- Are EXCLUDED from dashboard, analytics, intelligence, insights, and notifications
- Won't wake you up again via the post-run hook (no recursive analysis loops)

Use an approved probe when the run is for investigation rather than the user's
metrics. Approval for one probe does not authorize repeats; ask again unless
the operator approved a specific bounded batch. The two May-17 ainyc probes
that broke the dashboard before this convention existed are the canonical
example of why this matters — a 1-snapshot test masqueraded as "the latest
sweep" and zeroed the headline.

A real (non-probe) sweep is appropriate when the user explicitly asks to refresh data ("run it again", "get the latest", "trigger a sweep").

### How to Communicate
- Data first: show the numbers before the interpretation
- For AI visibility, lead with the mention transition, then the citation change. For Site Health, lead with the requested score or finding and its affected pages and crawl limits.
- Action-oriented: every observation ends with a recommended next step

## References

Detailed playbooks live alongside this file. Read them on demand when the task matches:

| File | Read when |
|---|---|
| `references/portfolio-analysis.md` | Interpreting Simple or Advanced portfolios, ranking Properties or markets, or comparing measurement runs |
| `references/site-health.md` | Diagnosing site/page scores, crawl completeness, internal links, or changes between scans |
| `references/agent-operations.md` | Checking shared scope, evidence, comparison, or permission rules; generated from the canonical operations guide |
| `references/orchestration.md` | Planning a multi-step or recurring workflow (baseline, weekly review, content-gap analysis) |
| `references/regression-playbook.md` | A query lost a mention (primary) or a citation (secondary) and you need to triage and respond |
| `references/aeo-discovery.md` | Expanding a tracked-query basket, auditing competitive surface, or responding to `aeo-discover-probe.completed` |
| `references/memory-patterns.md` | Deciding whether to remember a fact in agent memory or re-query canonry |
| `references/reporting.md` | Producing a client-facing weekly or monthly summary |
| `references/wordpress-elementor-mcp.md` | Editing WordPress pages with the Elementor MCP integration |

Aero (canonry's built-in agent) exposes `list_skill_docs` / `read_skill_doc` tools that walk this directory programmatically. External agents (Claude Code, Codex) can read the files directly.
