---
name: reporting
description: Weekly and monthly report templates with metric tables, regression/gain sections, and recommended-actions structure. Read when asked to produce a client-facing summary.
---

# Reporting Templates

## Month-over-month AEO (do this right)

For Advanced Property or market reports, read `portfolio-analysis.md` first.
For a calendar-month comparison of a Property, group or market, call
`canonry_visibility_compare` with that `scope` and `scopeKey` (or `marketKey`);
use `canonry_measurement_changes` for compatible stored-run comparisons of
changed Properties. Do not substitute a project-wide month comparison for
Property-scoped data.
For Site Health reports, read `site-health.md` and keep crawl and audit
provenance separate from answer-visibility periods.

For project-wide month-over-month AEO claims, use `canonry_visibility_compare`
(CLI: `cnry visibility-compare <project> --from <YYYY-MM> --to <YYYY-MM>`),
never diff two `visibility-stats --month` calls by hand. It returns the
statistically honest comparison. **Share of voice is less exposed to an engine's broad naming propensity than an absolute rate**, and is computed over non-brand queries only (see the branded caveat below), but it does **not** bypass model continuity. The comparison is restricted to the query/provider PAIRS present in BOTH months, then to providers with one known, identical configured model id in both months. Every figure carries a Wilson interval and a `verdict`:

- **`within-noise`** — the periods' intervals overlap. **No confirmed change; never report it as a rise or a decline.**
- **`moved`** — disjoint intervals; a real directional move (the point sign is the direction).
- **`model-discontinuous` / `model-unknown`** — the engine's configured model changed, was mixed within a month, or is unrecorded (legacy rows). **No directional call is made for that comparison; never attribute the swing to the site.** Read `continuity` (its `status` plus the per-provider evidence) for what was excluded and why — `continuity` is the enforcement decision, `modelChanges` is advisory context only.

A silent upstream version bump under an unchanged configured id is undetectable; the tool does not pretend otherwise. Honor `lowRunCount` (a month under 5 sweeps → intervals too wide to resolve a move; recommend raising the sweep schedule). Report the point with its interval, not a bare number.

The class rates (`mention-rate-branded`, `mention-rate-non-brand`, and their `cited-rate-*` pairs) are separate instruments with their own denominators; `classification-unavailable` means no split was possible, never a zero. On an Advanced project without a scope, those class rates come from the frozen frame in `classComparison`: judge them by `classComparison.continuity`, basket and run counts, not by the top-level `continuity`, which gates the four original metrics only. A Property, group or market scope answers entirely from the frozen frame.

## Branded and non-brand questions are different instruments

Never pool them into one headline. A branded question ("<brand> reviews") measures demand the brand already created: the answer names the brand because the question did, so a near-100% mention rate is the expected floor, not an achievement. A non-brand question ("best <category> for <use case>") measures demand to win, and it is the number that says whether the work is landing. A pooled figure mostly measures how famous the brand already is and hides whether anything moved.

**This matters most for share of voice.** `visibility-stats --share-of-voice`, `visibility-compare`, the project overview's Mention Share card and its breakdown chart default to NON-BRAND queries. Historical competitor landscapes require explicit `queryClass: "non-brand"` (CLI: `--query-class non-brand`) for competitive percentages. Omitting the class or requesting `all` returns pooled counts and null shares. Keep the returned class (`queryClass` / `scope`) beside each figure; request branded evidence separately for brand recall.

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

## Build summaries from stored evidence

Use the project overview for current state, `canonry_visibility_compare` for
calendar-month comparisons, and scoped measurement tools for Advanced
Properties and markets. Read `canonry_organic_evidence` for the stored GSC,
GA4, and server-traffic evidence ladder. The dedicated HTML Report surface has
been retired; generate the requested document from these existing sources.

For complete server-traffic totals and breakdowns, use
`canonry_traffic_analytics` (CLI: `cnry traffic analytics <project> --period 30
--format json`). Select 7, 14, 30, or 90 days, preserve its returned dates and
prior-window counts, and keep paid, organic, and unclassified arrivals separate.
Server sessions and GA sessions measure different evidence. Review
`canonry_traffic_referral_assessment` for the same dates before attributing
candidate bursts to people; an adjusted count is an estimate.

Keep mention and citation signals independent. Use the scoped tool's numerator,
denominator, and query class rather than recreating retired report metrics.
Retain missing evidence and partial-sweep qualifications. Preparing a summary
never authorizes a new sweep, provider read, or sync.

Content reads honor saved addressed recommendations. Inspect those records with
`canonry_content_dismissals` (CLI `cnry content dismissals <project>`). Saving
or removing one uses `canonry_content_dismiss` or `canonry_content_restore`
and requires explicit approval; preparing a summary does not authorize it.

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
