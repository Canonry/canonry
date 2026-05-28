---
name: orchestration
description: Workflow recipes — baseline, regression response, weekly review, content gap analysis. Read when planning a multi-step task or recurring review.
---

# Orchestration Workflows

## Workflow 1: New Client Baseline

Trigger: First sweep completes for a new project

Steps:
1. `cnry evidence <project> --format json` → get initial citation data
2. Compute baseline: cited rate, provider breakdown, top/bottom queries
3. `npx @ainyc/aeo-audit "<domain>" --sitemap --format json` → site readiness score across every page in the sitemap (auto-discovered; add `--limit <n>` to cap, default 200)
4. Identify top 3 gaps (uncited queries with fixable site issues)
5. Generate onboarding report with baseline + action plan
6. Store baseline metrics in memory

## Workflow 2: Regression Response

Trigger: Comparison shows decline or webhook fires regression.detected

Steps:
1. `cnry evidence <project> --format json` → current state
2. `cnry history <project>` → trend for affected query
3. Check indexing: `cnry google coverage <project>` → is the page still indexed?
4. Check competitor: did a competitor gain the citation we lost?
5. Audit the page: `npx @ainyc/aeo-audit "<page-url>" --format json`
6. Diagnose cause: indexing issue / content issue / competitive displacement
7. Recommend fix with evidence
8. If content fix: generate diff (schema, llms.txt, or content changes)
9. Update memory with regression event + diagnosis

**Want to verify the regression is real / reproducible before reporting?** Use a probe run instead of a real sweep:

```
cnry run <project> --probe --provider <p> --query "<regressed-query>"
```

Then `cnry runs get <id>` to inspect the snapshot. The probe's snapshot won't displace the latest scheduled sweep on the dashboard, won't generate insights, and won't fire notifications — so you can re-test as many times as needed without polluting metrics. Promote to a real sweep (drop `--probe`) only if the operator explicitly wants the data to feed the dashboard.

## Workflow 3: Weekly Review

Trigger: Scheduled (weekly, or on-demand)

Steps:
1. `cnry evidence <project> --format json` → current metrics
2. Compare to baseline/prior week from memory
3. Compute deltas: citations gained, lost, stable
4. Flag any new regressions not yet addressed
5. Check competitor movement
6. Generate summary with key changes + recommended next steps

## Workflow 4: Content Gap Analysis

Trigger: User asks "why aren't we cited for X?" or multiple uncited queries detected

Steps:
1. `cnry evidence <project>` → confirm uncited
2. Check if a relevant page exists on the domain
3. If no page: recommend content creation (topic, target queries)
4. If page exists: `npx @ainyc/aeo-audit "<page-url>"` → diagnose why uncited
5. Check schema completeness, llms.txt coverage, indexing status
6. Generate prioritized fix list
