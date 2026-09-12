---
name: portfolio-analysis
description: Interpret Simple and Advanced portfolios, compare Properties and markets, trace answer evidence, and qualify missing or incompatible measurements.
---

# Portfolio analysis

## Establish the measurement

Use `canonry_project_get` and `canonry_measurement_plan_get` to establish the
project and active plan. A Simple portfolio uses the standard project flow;
an Advanced portfolio uses a versioned measurement plan. "Multiportfolio"
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
questions and state the returned scope. Keep branded recall separate. An
explicit request for all classes permits a combined coverage read, not an
invented combined share-of-voice ratio.

## Choose the read

| Question | Stored evidence |
|---|---|
| How is a Simple portfolio doing? | `canonry_project_overview`, `canonry_visibility_stats`; preserve sample sizes and returned class |
| Which Advanced Properties are strongest or weakest? | `canonry_measurement_portfolio_summary`; use `mentionRanking.strongest`, `.weakest`, and `.excluded` |
| What is measured for one Property or market? | `canonry_measurement_overview` with `scope: property` / `targetKey` or `scope: group` / `groupKey` |
| Which questions explain a Property's gaps? | `canonry_measurement_property_questions`, then `canonry_measurement_question_result` with a returned `resultId` |
| What was mentioned or linked in individual answers? | `canonry_measurement_property_evidence` with `shape: answers` |
| Who appeared instead? | `canonry_measurement_property_competitors`; report stored replacement names as observations |
| Did performance change? | `canonry_measurement_changes` for Advanced; `canonry_visibility_compare` for Simple month comparisons |
| Can these results support a conclusion? | `canonry_measurement_data_quality` for Advanced completeness, capture, retrieval, and comparability |

For schema-v1 plans use `canonry_measurement_report` pinned to the requested
revision. Do not assume v2 Property/question-class reads are supported or
change the plan to make a read work.

## Interpret the denominator

- Quote the server's numerator and denominator with a rate. Mention and
  citation are independent signals; `mentioned: null` or
  `answerMentioned: null` means unchecked, not a measured miss.
- An empty result with `measurement.state: not_measured` means no
  measurement. An unavailable aggregate does not invalidate available
  Property metrics. Report ranked Properties and list excluded Properties
  with the returned reasons, including ambiguous identity.
- `mentionRanking` ranks all eligible Properties before applying its limit.
  Do not recompute a best/worst ranking from one overview page. Tied rates
  are ties; stable label/key order does not establish a unique winner or
  statistical significance.
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

Carry the displayed run and the supported filters into follow-up reads.
Reuse cursors unchanged with the same scope, class, sort, shape, and filters.
A revision or evidence change can invalidate a cursor; restart that read
without merging pages from incompatible snapshots. Overview search narrows
displayed rows without changing metric denominators.

Tool output can be trimmed. Inspect `__truncated`, `__omittedRows`, and
`__omittedRowsByField` as well as API pagination metadata. Request a smaller
page or narrower scope before treating the returned rows as exhaustive.

Lead the answer with the scoped result, give numerator/denominator and the
evidence explaining it, state missing data or comparison limits, then suggest
an action supported by that evidence. Reads do not authorize a new sweep,
probe, draft publication, or recurring measurement.
