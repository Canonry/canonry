---
name: reporting
description: Weekly and monthly report templates with metric tables, regression/gain sections, and recommended-actions structure. Read when asked to produce a client-facing summary.
---

# Reporting Templates

## Month-over-month AEO (do this right)

For ANY month-over-month AEO claim, use `cnry visibility-compare <project> --from <YYYY-MM> --to <YYYY-MM>` — never diff two `visibility-stats --month` calls by hand. It returns the statistically honest comparison: **share of voice is the primary, drift-robust metric that carries the directional call** (it cancels engine model changes; the absolute mention/cited rate is context only). Every metric has a Wilson interval and a `verdict` — **`within-noise` means no confirmed change, so do not report it as a rise or a decline.** Honor `modelChanges` (a provider's model changed → an absolute rate move is not attributable to the site) and `lowRunCount` (a month under 5 sweeps → intervals too wide to resolve a move; recommend raising the sweep schedule). Report the point with its interval, not a bare number.

## One-Command HTML Report

When a client asks for a "current state" or "AEO report" without a specific custom narrative, prefer the bundled report instead of hand-rolling sections:

```bash
cnry report <project>                          # writes canonry-report-<project>-YYYY-MM-DD.html in cwd
cnry report <project> --output dist/aeo.html   # custom path
cnry report <project> --format json            # raw payload, useful for narrating in chat
```

The HTML is self-contained (inline CSS + SVG charts, no network dependencies) and leads visually with mention coverage (the primary gauge), then covers: executive summary, per-query × per-provider matrix (mention + citation), competitor landscape, AI citation sources, GSC + GA4 performance, social and AI referrals, indexing health, trend, prioritized insights, and recommended next steps. Same payload is available via `GET /api/v1/projects/<name>/report` and the `canonry_report` MCP tool — use `--format json` when you want to summarize specific numbers in a thread instead of attaching the file.

Behaviors worth knowing before narrating numbers from the report:
- **Mention is the primary metric; citation is secondary.** Narrate the mention figures first. `executiveSummary.mentionRate` is **per-query** — `mentionedQueryCount / totalQueryCount`, where a query counts as mentioned if any provider's answer text named the brand in the run. The report leads visually with mention coverage, but the machine field backing that headline is not confirmed in the CLI docs — [confirm field name against `cnry report --format json` / `ProjectReportDto`] before quoting it as the headline; `executiveSummary.mentionRate` / `mentionedQueryCount` are the confirmed per-query mention fields.
- `executiveSummary.citationRate` is the **secondary**, per-query citation signal — `citedQueryCount / totalQueryCount`, where a query counts as cited if any provider in the run cited it. The denominator is total tracked queries (not (query × provider) pairs), so the rate stays comparable when provider count varies between runs. Use `citedQueryCount` / `totalQueryCount` directly when narrating ratios. Mention and citation are independent — never compute one from the other.
- The same per-query definition powers every `citationsTrend[].citationRate` so trend deltas reflect real movement, not provider-mix variance.
- `citationsTrend` excludes partial runs. A project with only one completed run shows `trend: "unknown"` — never claim a comparison that isn't there.
- Project ownership and competitor tagging use subdomain-aware matching: `blog.example.com` counts as the project when `example.com` is the canonical domain or in `ownedDomains`; `blog.rival.com` is tagged `isCompetitor: true` when `rival.com` is tracked.
- AI referral totals dedupe overlapping GA4 attribution dimensions (`session` / `first_user` / `manual_utm`).

The hand-rolled templates below are still the right call when the user wants a focused weekly/monthly digest with custom regression and gain narratives that the bundled report doesn't surface.

## Weekly Report

```
# Weekly AEO Report: <project> (<date range>)

## Summary
- Mention rate: <X>% (Δ<+/-Y>% from last week)        ← primary KPI
- Mention share: <X>% (Δ<+/-Y>% from last week)       ← AI share-of-voice vs competitors
- Cited rate: <X>% (Δ<+/-Y>% from last week)          ← secondary signal
- Regressions: <N> new, <N> resolved (lead with lost mentions; note lost citations second)
- Gains: <N> new mentions / <N> new citations
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
| Mention rate (primary) | <X>% | <Y>% | <Δ>% |
| Mention share (primary) | <X>% | <Y>% | <Δ>% |
| Cited rate (secondary) | <X>% | <Y>% | <Δ>% |
| Queries monitored | <N> | <N> | <Δ> |
| Active regressions | <N> | <N> | <Δ> |

## Provider Breakdown
| Provider | Mention Rate | Mention Trend | Cited Rate | Cited Trend |
|----------|--------------|---------------|-----------|-------------|
| <provider> | <X>% | ↑/↓/→ | <X>% | ↑/↓/→ |

## Fixes Deployed
| Date | Fix | Status | Impact |
|------|-----|--------|--------|
| <date> | <description> | Monitoring/Confirmed | <result> |

## Next Month Priorities
1. <priority>
2. <priority>
3. <priority>
```
