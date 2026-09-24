---
name: portfolio-analysis
description: Interpret Simple and Advanced portfolios, compare Properties and markets, trace answer evidence, and qualify missing or incompatible measurements.
---

# Portfolio analysis

## Establish the measurement

Use `canonry_project_get` to establish the project. When the system prompt
carries a "Project shape:" line, it already names the portfolio type and plan
revision: skip `canonry_measurement_plan_get` and read metrics from
`canonry_measurement_portfolio_summary` and `canonry_measurement_overview`.
Without that line, call `canonry_measurement_plan_get` to establish the active
plan. The plan is structure only, with no metrics, and can be very large;
never list, rank, or group Properties from it. A Simple portfolio uses the
standard project flow; an Advanced portfolio uses a versioned measurement
plan. "Multiportfolio"
may mean Properties within one project or several projects. Built-in Aero's
project-scoped tools operate on the current session's project. Do not present
one project's results as an account-wide comparison.

Resolve Property and market names to returned stable keys. A Property is
addressed by `targetKey`; a reporting group by `groupKey`. Preserve these
keys alongside labels, plan revision, displayed run, provider, requested and
served model when available, location, date window, and query class. A market
group and provider location are distinct scopes. Use only the filters exposed
by each tool; never invent a model or market parameter.

The chat does not inherit dashboard selections. Resolve names and URLs from
the request; ask for the selection when a reference such as "this market"
cannot be resolved. For an unqualified portfolio ranking, use non-brand
queries and state the returned scope. Keep branded recall separate. An
explicit request for all classes permits a combined coverage read, not an
invented combined share-of-voice ratio.

## Choose the read

| Question | Stored evidence |
|---|---|
| How is a Simple portfolio doing? | `canonry_project_overview`, `canonry_visibility_stats`; preserve sample sizes and returned class |
| Which Advanced Properties are strongest or weakest? | `canonry_measurement_portfolio_summary`; use `mentionRanking.strongest`, `.weakest`, and `.excluded`, plus `tiedAtWeakest`. It returns at most 4 rows, with or without `groupKey`; pass `groupKey` for one metro's weakest, or page `canonry_measurement_overview` for more |
| Which metros have the biggest gaps? | The portfolio summary's `markets` (every metro, worst-first, whatever the limit) and `tiedAtWeakest.byMetro`; `groupKey` lists one metro's submarkets |
| What is measured for one Property or market? | `canonry_measurement_overview` with `scope: property` / `targetKey` or `scope: group` / `groupKey` |
| Which questions explain a Property's gaps? | `canonry_measurement_property_questions`, then `canonry_measurement_question_result` with a returned `resultId` |
| What was mentioned or linked in individual answers? | `canonry_measurement_property_evidence` with `shape: answers` |
| Who appeared instead of one Property? | `canonry_measurement_property_competitors`, or `namedInsteadInAnswerText` on a weakest row; these names were written in the answer text, not cited |
| Who do answers name instead across the portfolio? | `canonry_competitor_landscape` with `queryClass` and `runId: latest`; `tiedAtWeakest.namedInstead` for the weakest tie. Per-Property lists are samples of weak Properties, never a portfolio ranking |
| Where do engines get these answers? | For one Property, `citedDomains` from `canonry_measurement_property_competitors`. Project-wide, `canonry_analytics_sources` with `queryClass` and `runId: latest`, since without them it pools both classes and every sweep. `weakestAnswerSources` pools the weakest rows and the tie; never present it as one Property's sources |
| Did performance change? | `canonry_measurement_changes` once per class for changed Properties (Advanced): rows come largest move first, `distribution` counts every Property, `withinNoise` marks noise. `populations[].comparison` from `canonry_visibility_report` for the displayed selection's headline; `canonry_visibility_compare` for Simple month comparisons |
| Is the sweep complete, or is anything unreliable? | `canonry_measurement_data_quality`: quote completeness `expected`, `executed` and `missing`, plus `unattributedByClass` (per class, never pooled) and `latestFill`. Then `canonry_run_completeness` with `run.displayedRunId` for missing answers per engine. A Healthy run status and `canonry_doctor` are not completeness checks |

For schema-v1 plans use `canonry_measurement_report` pinned to the requested
revision. Do not assume v2 Property/question-class reads are supported or
change the plan to make a read work.

## Interpret the denominator

- Quote the server's numerator and denominator with a rate. Mention and
  citation are independent signals; `mentioned: null` or
  `answerMentioned: null` means unchecked, not a measured miss.
- Coverage denominators count answers, one per query per engine: 8 queries
  on 3 engines is 24 answers. Label them answers, never queries.
- An empty result with `measurement.state: not_measured` means no
  measurement. An unavailable aggregate does not invalidate available
  Property metrics. Report ranked Properties and list excluded Properties
  with the returned reasons, including ambiguous identity.
- `mentionRanking` ranks all eligible Properties before applying its limit.
  Do not recompute a best/worst ranking from one overview page. Tied rates
  are ties; stable label/key order does not establish a unique winner or
  statistical significance. When `tiedAtWeakest` is set, report that many
  Properties share the weakest rates instead of calling the first rows the
  worst.
- Group Properties only by each row's `metro` and `submarkets`. Never infer a
  market from a Property's name, and never merge two metros into one group.
- Markets can share Properties and do not sum to a portfolio total. Do not
  average Property percentages, add overlapping market counts, or substitute
  project-brand performance for an individual Property's performance.
- `shape: sources` returns cited URLs. Answers without citations are absent
  from that shape, so source-row counts cannot measure answer coverage or
  prove the absence of mentions. Use `shape: answers` to explain gaps.
- Overview's omitted query class combines classes; portfolio summary defaults
  to non-brand. Pass an explicit class for a sequence of comparable reads
  and report what the response actually served.

## Compare and drill down safely

A ranking describes one snapshot. Use the comparison tool's compatibility
decision before describing a trend; a plan revision, model, assignment, or
capture change can make raw rates incomparable. Report an unavailable or
incompatible comparison with its reason instead of subtracting rates by hand.
For Simple month comparisons, honor the returned interval, continuity,
`within-noise`, and low-sample qualifications from the reporting playbook.

Between two sweeps, a Property that moved 2 answers or fewer
(`withinNoise: true`) is within noise: one answer on a 12-answer denominator
is 8.3 points. Never call it real, a trend, structural, or a regression.
Report the `distribution` (how many Properties improved, declined, moved
within noise, or did not change), and flag only moves beyond noise, or the
same move repeated over several sweeps, as worth checking.

Carry the displayed run and the supported filters into follow-up reads.
Reuse cursors unchanged with the same scope, class, sort, shape, and filters.
A revision or evidence change can invalidate a cursor; restart that read
without merging pages from incompatible snapshots. Overview search narrows
displayed rows without changing metric denominators.

Tool output can be trimmed. Inspect `__partialLists` (the first field when
present: each list the tool itself returned only part of, as shown of total),
`__truncated`, `__truncation` (the keys dropped, `k of n` items kept per list,
and under `cursors` any page cursor that now skips cut rows), `__omittedRows`,
and `__omittedRowsByField` as well as API pagination metadata: `truncated: true`,
a total (`totalProperties`, `total`, `questionTotal`) above the rows
returned, or a `nextCursor`. A text result that ends with a `__truncation:`
line and the truncation note is a partial slice. Never list, rank, count, or
group items you did not see; say how many of how many you saw, never call
the rows the biggest, strongest, all, or the full picture, then request a
smaller page or narrower scope (a `groupKey` for the portfolio summary)
before treating the returned rows as exhaustive.

Lead the answer with the scoped result, give numerator/denominator and the
evidence explaining it, state missing data or comparison limits, then suggest
an action supported by that evidence. Reads do not authorize a new sweep,
probe, draft publication, or recurring measurement.
