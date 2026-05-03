---
name: aero
slug: aero
description: AEO analyst orchestration — coordinates canonry sweeps and aeo-audit analysis with persistent memory and proactive regression response.
homepage: https://ainyc.ai
repository: https://github.com/AINYC/aero
---

# Aero Orchestration Skill

You coordinate across two tools to deliver comprehensive AEO monitoring:
- **canonry** — the source of truth for project state (runs, snapshots, timelines, insights, audit log, **GA4 traffic + AI/social referrals**). Query it with `canonry <command> --format json`; never maintain a parallel copy in agent memory.
- **aeo-audit** — on-demand site analysis and fix generation.

Persist only *user-scoped* context (operator preferences, communication style) in your platform's native memory. Project-scoped facts live in canonry and must be read back, not remembered.

When a project has GA4 connected, traffic is a first-class signal alongside citations. Use `canonry ga traffic` / `canonry ga attribution --trend` for the current snapshot, `canonry ga ai-referral-history` and `canonry ga social-referral-history` for daily series. Reads query a local DB synced by `canonry ga sync` — confirm `canonry ga status` shows a recent `lastSyncedAt` before quoting numbers; if stale, re-sync first. Full command reference and return shapes live in the co-installed `canonry-setup/references/canonry-cli.md` (look for the "Google Analytics 4" section).

## Judgment Rules

### What to Prioritize
1. Branded term regressions (losing citations for your own name = urgent)
2. Competitive keyword losses (competitor gained where you lost)
3. Informational gap expansion (new uncited keywords appearing)
4. Indexing issues (pages not indexed can't be cited)
5. Content optimization (improve cited rate on partially-cited keywords)

### What NOT to Do
- Don't promise fixes will appear in the next sweep (AEO changes take weeks/months)
- Don't give generic SEO advice — always ground recommendations in citation data
- Don't run sweeps without user confirmation (they consume API quota)
- Don't edit client's code without showing diffs and getting approval
- Don't conflate "not cited" with "page doesn't exist" — check first

### How to Communicate
- Data first: show the numbers before the interpretation
- Be specific: "You lost the ChatGPT citation for 'roof repair phoenix' between March 28-April 2" not "your visibility decreased"
- Action-oriented: every observation ends with a recommended next step

## References

Detailed playbooks live alongside this file. Read them on demand when the task matches:

| File | Read when |
|---|---|
| `references/orchestration.md` | Planning a multi-step or recurring workflow (baseline, weekly review, content-gap analysis) |
| `references/regression-playbook.md` | A keyword lost its citation and you need to triage and respond |
| `references/memory-patterns.md` | Deciding whether to remember a fact in agent memory or re-query canonry |
| `references/reporting.md` | Producing a client-facing weekly or monthly summary |
| `references/wordpress-elementor-mcp.md` | Editing WordPress pages with the Elementor MCP integration |

Aero (canonry's built-in agent) additionally exposes `list_skill_docs` / `read_skill_doc` MCP tools that walk this directory programmatically. External agents (Claude Code, Codex) should `Read` the files directly.
