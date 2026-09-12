---
name: site-health
description: Diagnose Site Health scores, page findings, crawl coverage, internal links, and scan changes while preserving run provenance and incomplete-data limits.
---

# Site Health diagnosis

Site Health is the product label for the `technical-aeo` audit and crawl
surface. It measures technical readiness. Mention coverage and citation
coverage come from answer-engine measurements; neither is derived from an
audit score, link score, or graph position.

## Start with stored evidence

Read `canonry_site_health_overview` for the selected or latest crawl's root,
run identity, completeness, counts, budgets, versions, termination, and
dead-link check state. Pair it with `canonry_technical_aeo_score` for the
aggregate score, factor distributions, issues, and prioritized fixes. Pin
the score and subsequent reads to the returned run when available. Overview
is crawl metadata, not the scorecard. Older scorecard-only audits can lack
a graph; report the available scores and missing crawl evidence separately.

Use `canonry_technical_aeo_pages` for low-scoring or failed pages and
`canonry_site_health_page_audit` for one page's exact factor scores, finding
codes/messages, recommendations, and critical defects. Prefer a returned
`nodeKey`; use the exact URL when no node key is available. The chat does not
receive the selected graph node, so resolve the requested page or ask for it.

## Choose a bounded investigation

| Question | Read |
|---|---|
| Which URLs were discovered and audited? | `canonry_technical_aeo_crawl_pages`; filter audit/fetch/indexability state and follow its cursor |
| How is the site organized? | `canonry_technical_aeo_structure` for one path level |
| What links to/from this page? | `canonry_technical_aeo_link_neighbors`; inbound and outbound truncation are independent |
| What is around this page? | `canonry_site_health_subgraph`; refocus or expand only as needed |
| Can the root reach this page? | `canonry_site_health_path` for a directed followable path |
| Which editorial or template links exist? | `canonry_technical_aeo_internal_links` with supported filters |
| What changed between scans? | `canonry_site_health_changes` for compatible complete snapshots |
| Were broken links checked? | `canonry_technical_aeo_dead_links` |
| How have scores moved? | `canonry_technical_aeo_trend`, then inspect the relevant runs and coverage |

Use semantic reads rather than requesting the full interactive graph or
inferring importance from visualization coordinates. Defaults for subgraphs
are 25 nodes and 50 edges; a bounded neighborhood is not the whole site.

## Interpret states before findings

- `hasData: false`, no crawl, details unavailable, page not found, and page
  not audited are different states. None means a zero score or a passing
  page. `scores-only` permits discussing scores but not inventing findings.
- `complete: false` and `termination` qualify conclusions. A budget-limited
  scan does not establish site-wide coverage. Raw found/checked/failed
  counts are not a completion percentage when total discovery is unknown.
- Subgraph `countAccuracy: lower-bound` means counts are minimums. An
  unreachable or truncated path in an incomplete crawl does not prove a
  site-wide orphan. Absence from a bounded result is not absence from the site.
- Crawler-derived indexability is technical eligibility, not Google index
  coverage. Verify Google indexing with its own stored integration evidence.
- Link score indicates structural importance, not an audit failure. Pair
  important pages with their actual audit findings when prioritizing fixes.
- Dead-link checks are opt-in. `disabled` means unchecked, not zero broken
  links. A listed dead link requires a recorded HTTP 4xx/5xx. Fetch failures
  such as timeouts can be `unverified`; do not label them broken URLs.
- Link template classification carries `templateSource` and scan-level
  `templateDetection`. An empty content-only result under unmeasured
  classification cannot establish that the site has no editorial links.
  Different classification rules are not equivalent measurements.

## Compare scans and prioritize

Use the changes tool's resolved run IDs and filters; keep them fixed when
paging. Its first page carries the exact summary; continuation pages omit
summary/total. Retain that first summary and do not treat its absence on later
pages as zero. Inspect API and Aero truncation markers before claiming a
complete list. Reject/refusal states do not justify joining partial or
incompatible scans manually.

Before attributing a score delta to fixes, check root/scope, completeness,
audited-page population, effective budgets, and scoring/crawl versions. A
changed sample can move an aggregate without any page improving. Explain
page-level before/after evidence where available and qualify remaining gaps.

For Simple portfolios, relate findings to the requested site or pages. For
Advanced portfolios, read `portfolio-analysis` and resolve each Property's
Target/URL scope from its plan. The project-wide score is not a Property
score. Label a filtered page sample as such, preserve the Property and market
context, and do not invent a Property aggregate. Shared paths can affect
multiple Properties; avoid counting the same finding as independent proof
for each one.

Rank persisted critical defects and fixes using severity and affected-page
evidence, with business or link importance where available. State the run,
scope, finding, affected page(s), and supported next step. A technical issue
can be a hypothesis for an AI-visibility gap, but the crawl alone cannot prove
why an answer engine omitted a Property. Join the corresponding answer
evidence before making that connection.

Read existing data first. If absent or stale, propose an explicitly bounded
`canonry_technical_aeo_run` when a new audit is needed. Existing authorization
for that run remains valid; a diagnostic question alone does not authorize
a crawl. Dead-link checks remain off unless requested. After an approved
run, follow its returned ID with `canonry_run_get`, then inspect that run's
crawl and score rather than silently switching to another scan.
