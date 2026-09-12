---
name: reporting
description: Weekly and monthly report templates with metric tables, regression/gain sections, and recommended-actions structure. Read when asked to produce a client-facing summary.
---

# Reporting Templates

## Month-over-month AEO (do this right)

For Advanced Property or market reports, read `portfolio-analysis.md` first
and use `canonry_measurement_changes` for compatible stored-run comparisons.
Do not substitute a project-wide month comparison for Property-scoped data.
For Site Health reports, read `site-health.md` and keep crawl and audit
provenance separate from answer-visibility periods.

For Simple month-over-month AEO claims, use `canonry_visibility_compare`
(CLI: `cnry visibility-compare <project> --from <YYYY-MM> --to <YYYY-MM>`),
never diff two `visibility-stats --month` calls by hand. It returns the
statistically honest comparison. **Share of voice is less exposed to an engine's broad naming propensity than an absolute rate**, and is computed over non-brand queries only (see the branded caveat below), but it does **not** bypass model continuity. The comparison is restricted to the query/provider PAIRS present in BOTH months, then to providers with one known, identical configured model id in both months. Every figure carries a Wilson interval and a `verdict`:

- **`within-noise`** — the periods' intervals overlap. **No confirmed change; never report it as a rise or a decline.**
- **`moved`** — disjoint intervals; a real directional move (the point sign is the direction).
- **`model-discontinuous` / `model-unknown`** — the engine's configured model changed, was mixed within a month, or is unrecorded (legacy rows). **No directional call is made for that comparison; never attribute the swing to the site.** Read `continuity` (its `status` plus the per-provider evidence) for what was excluded and why — `continuity` is the enforcement decision, `modelChanges` is advisory context only.

A silent upstream version bump under an unchanged configured id is undetectable; the tool does not pretend otherwise. Honor `lowRunCount` (a month under 5 sweeps → intervals too wide to resolve a move; recommend raising the sweep schedule). Report the point with its interval, not a bare number.

## Branded and non-brand questions are different instruments

Never pool them into one headline. A branded question ("<brand> reviews") measures demand the brand already created: the answer names the brand because the question did, so a near-100% mention rate is the expected floor, not an achievement. A non-brand question ("best <category> for <use case>") measures demand to win, and it is the number that says whether the work is landing. A pooled figure mostly measures how famous the brand already is and hides whether anything moved.

**This matters most for share of voice, and the split is now enforced.** `visibility-stats --share-of-voice`, `visibility-compare`, the project overview's Mention Share card and its breakdown chart, and the client report's mention landscape are all scoped to NON-BRAND queries by default. Every one of them echoes the class it served (`queryClass` / `scope`), and branded is returned beside the figure rather than inside it. Pass `--query-class branded` when you want brand recall.

Why it is enforced rather than advised: on a real basket (13 queries × 4 engines, 5 branded), the subject was named in 20 of 20 branded answers and 1 of 32 category answers. Pooled, the chart put them FIRST at ~42%. Non-brand, they were LAST at ~3%, behind all seven tracked competitors. Same run, opposite conclusion, and the pooled version is the one a client would have read as category leadership.

A figure labelled `pooled` means the project has no usable brand alias, so no split was possible. That is a configuration gap to fix (set a display name or aliases), not a number to quote as competitive.

Classification does not use a new heuristic: the project's own identity (display name, aliases, domain labels) is run against the QUERY text with the same exact-identity matcher that decides whether an ANSWER mentions the brand — `compileQueryClassifier` over `packages/contracts/src/brand-matching.ts`, the same enum advanced measurement publishes. Complete-adjacent-word matching means presentation variants fold and near-misses never match, so a project whose identity is two words is not matched by a bare one-word term that belongs to someone else.

## The measured question set is versioned

Runs are stamped with a query basket revision, and the analytics payload carries `referenceBasketRevision` plus a `basketChanges` list of real add/remove events with dates. Membership is compared by normalized query text, so removing and re-adding the same question rejoins its own history instead of reading as a brand new query.

Two consequences for any report:

- **Check `basketChanges` before presenting a month-over-month delta.** If the set moved inside the window, the comparison covers only the questions present in both periods. State that in one plain sentence rather than showing a clean delta.
- **A question added mid-window is no longer silently dropped.** Analytics used to hold out any query created after a bucket started, which quietly removed real mentions from both numerator and denominator and could read as 0% on an engine that was in fact naming the brand. Reports built against older engines may show that artifact.

## A partial run is not a low reading

A sweep crippled by a provider outage captures fewer questions and looks identical to a collapse in visibility. Before narrating any drop, check whether the latest run is `partial` and what its capture count was against the project's basket size. Report a capture failure as a capture failure.

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
- Mention share (non-brand): <X>% (Δ<+/-Y>% from last week)   ← share-of-voice vs competitors; NEVER pooled with branded
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
