---
name: orchestration
description: Workflow recipes — baseline, regression response, weekly review, content gap analysis. Read when planning a multi-step task or recurring review.
---

# Orchestration Workflows

**Read the mention signal first in every workflow.** Compute and compare **mention rate + mention share** before cited rate. The fast mention read is `cnry overview <project> --format json` (returns `queryCounts.mentionRate`, `scores.mention`, `scores.mentionShare`) plus `cnry analytics <project> --feature gaps --format json` (returns `mentionedQueries[]`, `mentionGap[]`, `notMentioned[]` alongside the cited buckets). Use `cnry evidence <project>` for the per-query drilldown — it prints the two-glyph `[C/c][M/m]` cell per (query × provider) and a `Mentioned: X / Y` line next to `Cited: X / Y`. Mention and citation are independent — never derive one from the other. Treat `answerMentioned = null` as "not checked," never as not-mentioned.

## Workflow 1: New Client Baseline

Trigger: First sweep completes for a new project

Steps:
1. `cnry overview <project> --format json` → mention read first: `queryCounts.mentionRate`, `scores.mention`, `scores.mentionShare`. Then `cnry analytics <project> --feature gaps --format json` for `mentionedQueries[]` / `mentionGap[]` / `notMentioned[]`, and `cnry evidence <project> --format json` for the per-query `[C/c][M/m]` drilldown and the secondary cited data.
2. Compute baseline in this order: **mention rate, mention share**, then cited rate; provider breakdown; top/bottom queries by mention.
3. `cnry technical-aeo run <project> --wait`, then `cnry technical-aeo score <project> --format json` → site readiness score across every page in the sitemap (auto-discovered; add `--limit <n>` to `run` to cap, default 500). Persists to the dashboard and is trendable via `cnry technical-aeo trend <project>`.
4. Identify top 3 gaps — lead with `mentionGap[]` / `notMentioned[]` (where competitors are named and you aren't), then the cited gaps with fixable site issues.
5. Generate onboarding report with baseline + action plan
6. Store baseline metrics in memory (include mention rate + mention share, not just cited rate)

## Workflow 2: Regression Response

Trigger: Comparison shows decline or webhook fires regression.detected

Steps:
1. `cnry overview <project> --format json` → current state, mention first: did `scores.mention` / `scores.mentionShare` move? Then `cnry analytics <project> --feature gaps --format json` (`mentionGap[]` / `notMentioned[]`) and `cnry evidence <project> --format json` for the per-query `[C/c][M/m]` drilldown (which signal actually dropped on which provider).
2. `cnry history <project>` → trend for affected query
3. Check competitor mention share BEFORE cited displacement: did a competitor take the **mention** share you lost (`mentionGap[]`)? Only then ask whether a competitor gained the **citation** you lost.
4. Check indexing: `cnry google coverage <project>` → is the page still indexed? (a deindexed/thin page starves both signals)
5. Audit the page: `npx @ainyc/aeo-audit "<page-url>" --format json`
6. Diagnose cause: indexing issue / content issue / competitive displacement (mention-share loss first, citation loss second)
7. Recommend fix with evidence — lead with what restores the mention
8. If content fix: generate diff (schema, llms.txt, or content changes)
9. Update memory with regression event + diagnosis (record which signal regressed: mention, citation, or both)

**Want to verify the regression is real / reproducible before reporting?** Use a probe run instead of a real sweep:

```
cnry run <project> --probe --provider <p> --query "<regressed-query>"
```

Then `cnry runs get <id>` to inspect the snapshot. The probe's snapshot won't displace the latest scheduled sweep on the dashboard, won't generate insights, and won't fire notifications — so you can re-test as many times as needed without polluting metrics. Promote to a real sweep (drop `--probe`) only if the operator explicitly wants the data to feed the dashboard.

## Workflow 3: Weekly Review

Trigger: Scheduled (weekly, or on-demand)

Steps:
1. `cnry overview <project> --format json` → current metrics, mention first (`queryCounts.mentionRate`, `scores.mention`, `scores.mentionShare`); `cnry analytics <project> --feature gaps --format json` for the mention gaps; `cnry evidence <project> --format json` for the per-query `[C/c][M/m]` drilldown
2. Compare to baseline/prior week from memory — mention rate + mention share first, cited rate second
3. Compute deltas: mentions gained/lost/stable (primary), then citations gained/lost/stable (secondary)
4. Flag any new regressions not yet addressed (lead with lost mentions)
5. Check competitor movement — mention share swing first, then cited-domain displacement
6. Generate summary with key changes + recommended next steps

## Workflow 4: Content Gap Analysis

Trigger: User asks "why aren't we mentioned/cited for X?" or multiple not-mentioned / uncited queries detected

Steps:
1. `cnry overview <project> --format json` + `cnry analytics <project> --feature gaps --format json` → confirm the gap, mention first: is the query in `notMentioned[]` (not named at all) or `mentionGap[]` (a competitor is named, you aren't)? Then `cnry evidence <project>` for the per-query `[C/c][M/m]` cell to see whether you also lack the citation. Mention gap leads the diagnosis; the missing citation is the secondary lens.
2. Check if a relevant page exists on the domain
3. If no page: recommend content creation (topic, target queries) — give the engine a reason to name you
4. If page exists: `npx @ainyc/aeo-audit "<page-url>"` → diagnose why neither mentioned nor cited
5. Check schema completeness, llms.txt coverage, indexing status
6. Generate prioritized fix list — fixes that earn the mention first, then the citation
