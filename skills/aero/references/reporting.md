---
name: reporting
description: Weekly and monthly report templates with metric tables, regression/gain sections, and recommended-actions structure. Read when asked to produce a client-facing summary.
---

# Reporting Templates

## One-Command HTML Report

When a client asks for a "current state" or "AEO report" without a specific custom narrative, prefer the bundled report instead of hand-rolling sections:

```bash
canonry report <project>                          # writes canonry-report-<project>-YYYY-MM-DD.html in cwd
canonry report <project> --output dist/aeo.html   # custom path
canonry report <project> --format json            # raw payload, useful for narrating in chat
```

The HTML is self-contained (inline CSS + SVG charts, no network dependencies) and covers: executive summary, per-query × per-provider citation matrix, competitor landscape, AI citation sources, GSC + GA4 performance, social and AI referrals, indexing health, citations trend, prioritized insights, and recommended next steps. Same payload is available via `GET /api/v1/projects/<name>/report` and the `canonry_report` MCP tool — use `--format json` when you want to summarize specific numbers in a thread instead of attaching the file.

Behaviors worth knowing before narrating numbers from the report:
- `executiveSummary.citationRate` is always sourced from the latest visibility run (completed **or** partial), so it tracks the scorecard table even when the latest sweep had a flaky provider.
- `citationsTrend` excludes partial runs. A project with only one completed run shows `trend: "unknown"` — never claim a comparison that isn't there.
- Project ownership and competitor tagging use subdomain-aware matching: `blog.example.com` counts as the project when `example.com` is the canonical domain or in `ownedDomains`; `blog.rival.com` is tagged `isCompetitor: true` when `rival.com` is tracked.
- AI referral totals dedupe overlapping GA4 attribution dimensions (`session` / `first_user` / `manual_utm`).

The hand-rolled templates below are still the right call when the user wants a focused weekly/monthly digest with custom regression and gain narratives that the bundled report doesn't surface.

## Weekly Report

```
# Weekly AEO Report: <project> (<date range>)

## Summary
- Cited rate: <X>% (Δ<+/-Y>% from last week)
- Regressions: <N> new, <N> resolved
- Gains: <N> new citations
- Providers monitored: <N>

## Key Changes
- <most important change with data>
- <second most important>
- <third>

## Regressions
| Query | Provider | Status | Suspected Cause |
|-------|----------|--------|-----------------|
| <query> | <provider> | New/Investigating/Resolved | <cause> |

## Gains
| Query | Provider | Position | Page |
|-------|----------|----------|------|
| <query> | <provider> | <N> | <url> |

## Competitor Watch
- <competitor>: <trend>

## Recommended Actions
1. <action with rationale>
2. <action>
3. <action>
```

## Monthly Report

```
# Monthly AEO Report: <project> (<month year>)

## Executive Summary
<2-3 sentence overview of the month>

## Metrics
| Metric | Start of Month | End of Month | Change |
|--------|---------------|--------------|--------|
| Overall cited rate | <X>% | <Y>% | <Δ>% |
| Queries monitored | <N> | <N> | <Δ> |
| Active regressions | <N> | <N> | <Δ> |

## Provider Breakdown
| Provider | Cited Rate | Trend |
|----------|-----------|-------|
| <provider> | <X>% | ↑/↓/→ |

## Fixes Deployed
| Date | Fix | Status | Impact |
|------|-----|--------|--------|
| <date> | <description> | Monitoring/Confirmed | <result> |

## Next Month Priorities
1. <priority>
2. <priority>
3. <priority>
```
