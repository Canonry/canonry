---
name: orchestration
description: Workflow recipes — baseline, regression response, weekly review, content gap analysis. Read when planning a multi-step task or recurring review.
---

# Orchestration Workflows

## Workflow 1: New Client Baseline

Trigger: First sweep completes for a new project

Steps:
1. `canonry evidence <project> --format json` → get initial citation data
2. Compute baseline: cited rate, provider breakdown, top/bottom keywords
3. `npx @ainyc/aeo-audit "<domain>" --format json` → site readiness score
4. Identify top 3 gaps (uncited keywords with fixable site issues)
5. Generate onboarding report with baseline + action plan
6. Store baseline metrics in memory

## Workflow 2: Regression Response

Trigger: Comparison shows decline or webhook fires regression.detected

Steps:
1. `canonry evidence <project> --format json` → current state
2. `canonry history <project> --keyword "<keyword>"` → trend for affected keyword
3. Check indexing: `canonry google coverage <project>` → is the page still indexed?
4. Check competitor: did a competitor gain the citation we lost?
5. Audit the page: `npx @ainyc/aeo-audit "<page-url>" --format json`
6. Diagnose cause: indexing issue / content issue / competitive displacement
7. Recommend fix with evidence
8. If content fix: generate diff (schema, llms.txt, or content changes)
9. Update memory with regression event + diagnosis

## Workflow 3: Weekly Review

Trigger: Scheduled (weekly, or on-demand)

Steps:
1. `canonry evidence <project> --format json` → current metrics
2. Compare to baseline/prior week from memory
3. Compute deltas: citations gained, lost, stable
4. Flag any new regressions not yet addressed
5. Check competitor movement
6. Generate summary with key changes + recommended next steps

## Workflow 4: Content Gap Analysis

Trigger: User asks "why aren't we cited for X?" or multiple uncited keywords detected

Steps:
1. `canonry evidence <project> --keyword "<keyword>"` → confirm uncited
2. Check if a relevant page exists on the domain
3. If no page: recommend content creation (topic, target keywords)
4. If page exists: `npx @ainyc/aeo-audit "<page-url>"` → diagnose why uncited
5. Check schema completeness, llms.txt coverage, indexing status
6. Generate prioritized fix list
