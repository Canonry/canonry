---
name: seo-analysis
description: Prioritize keyword and organic ranking opportunities from saved SEO evidence. Covers profile selection, bounded samples, Advanced scopes, market rankings, provider estimates, and actionable shortlists.
---

# SEO analysis

Use this playbook for keyword research, ranking opportunities, and domain comparisons.
Priorities are editorial recommendations from the inspected evidence, not Canonry scores or predicted gains.
The workflow uses normalized SEO capabilities. Name the source by its connection label from `canonry_seo_context`, such as "Search data". Never name the vendor or data provider behind it.
Call datasets what the SEO tab calls them: Searches you rank for (`ranked-keywords`), Search demand (`keyword-metrics`), Domain comparison and Market rankings.
Say searches for what people type into Google and queries for the project's tracked queries; never call tracked queries keywords.

## Read the selected evidence

1. For a question about the current SEO view, start with `aero_inspect_view`.
2. Load the `seo` toolkit through `aero_load_toolkit` in built-in Aero.
   External MCP agents use `canonry_help` with intent `seo` and their exposed catalog.
3. Read `canonry_seo_context` and `canonry_seo_profiles` to resolve the source, capabilities, profile, and supported scope.
   Preserve an explicitly selected profile or refresh. If several profiles match an ambiguous request, ask which one to use.
4. Read `canonry_seo_overview` for that `profileId` and any selected `runId`.
   Use `evidenceRunId` for subsequent evidence reads. Use `evidenceRun` for the date, scope, locale, and profile revision.
   For historical evidence, use the run's capabilities and scope instead of the current profile's settings.
   A newer `latestRun` can be running or failed while older evidence remains available.
   The overview's `status.lastCompletedAt` is project-wide. Its summary describes only the first target, not all profile domains.
5. Read the relevant datasets with the same `profileId` and evidence `runId`:

   | Tool | Evidence |
   |---|---|
   | `canonry_seo_keyword_metrics` | Explicit keywords, demand estimates, difficulty, intent, and monthly estimates |
   | `canonry_seo_ranked_keywords` | Observed positions, ranking URLs, target identity, and traffic estimates |
   | `canonry_seo_domain_intelligence` | Per-target keyword totals, position buckets, and traffic estimates |
   | `canonry_seo_market_rankings` | The site's Google position for each tracked query in each market, searched from that market's location |

6. Page with `limit` and `offset` until the relevant stored rows are covered, or disclose the inspected sample.
   These tools accept no keyword filter, target filter, or sort parameter. Do not invent them.
   Market rankings alone take `marketKey` or `regionKey` to narrow the rows.
   `total` counts stored rows, not the complete search market.
   Run detail returns at most 20 rows per dataset. Check `resultsTruncated` and `resultCounts`, then use the dataset tools.

Use completed or partial evidence for a stable read. Describe partial results and failed tasks before recommendations.
For partial or failed refreshes, inspect `canonry_seo_run` task details to identify the affected datasets and targets.
An unconfigured source does not prevent analysis of saved evidence.
If the user selects an active refresh, treat its rows as provisional because the stored set can still change.
If no usable evidence exists, explain the missing dataset and request an operator refresh for the exact profile.
Aero cannot edit profiles, start or cancel SEO refreshes, or inspect operator receipts.
Analysis never requires a refresh intent. Keep credentials and hosted financial controls out of the response.

## Preserve the measurement boundary

- Simple profiles use project scope. Advanced profiles retain their project scope or group, market, or Property key, plus plan revision.
  Use the capabilities returned for that scope. Never replace a path or entity Property with its whole domain.
  Keyword-only scopes support research recommendations, not claims about that Property's rankings.
- Keep the target's kind, value, and `includeSubdomains` setting with its evidence.
  Establish which targets belong to the project and which are competitors before recommending changes to a URL.
  A first-target summary does not establish ownership.
- Preserve the source label, dataset, engine, location, language, device, collection date, and available source date.
  Retrieval time is not measurement time. Missing source dates leave upstream freshness unknown.
- Rank comparisons require the same keyword, target definition, URL identity, scope, locale, and comparable source methods.
  A null rank is unknown. `rankOrganic` and `rankAbsolute` measure different positions.
  Do not manufacture rank deltas, visibility share, keyword gaps, or trends from unmatched snapshots.
  Historical runs do not expose the complete frozen keyword basket or row limit.
  A changed profile revision cannot establish comparable coverage from today's profile alone.
- Rank lists are bounded provider samples, even after every stored page is read.
  An absent keyword does not prove that a site stopped ranking or that a competitor has an exclusive keyword.
  Run history is bounded too. An absent older run does not prove that no history exists.
- If rows repeat, preserve separate keyword, URL, target, and provenance identities.
  Group related findings for presentation without adding overlapping volume, traffic, or domain totals.
  Multiple URLs for one keyword are not proof of cannibalization.
  `coreKeyword` can suggest a topic group, but it does not make synonym demand additive.

## Read market rankings

- Market rankings measure the project's own tracked non-brand queries, the same queries AI visibility reports. Call them queries, never keywords, so the two views read as one set.
  Lead each finding with `queryText` and its market. `searchText` is the exact text searched on Google; mention it only when it differs in a way that matters.
- `rankOrganic` is the site's best organic position within the checked `depth`. Null means the site was not in those results, not that the search failed. Say "not in the top 50", never "rank unknown".
- `locationLabel` and `provenance.device` say where and how the search ran. Compare markets only at the same depth and device.
- `competitors` lists tracked competitors found in the same results, by position. Absence means not in the checked results.
- One refresh is one sample of Google's results. Rank movement needs two refreshes of the same profile, query, market and location; otherwise state the single observation.
- Rankings and AI answers for a market are separate instruments. Present them side by side for the same query and market, never as a combined score.

## Prioritize the work

First establish the user's market, audience, products, and conversion goal from available project context.
If these are unknown, label business relevance as provisional or ask for the missing goal.
Review evidence coverage before treating a candidate as ready for action.

Use this order of judgment:

1. Prefer keywords that match the business and the intended searcher's need.
2. Prefer an identified owned URL with observed organic rankings and a specific change worth checking.
   Positions near the desired results can justify inspection. They do not guarantee an easy improvement.
3. Use supplied demand estimates to distinguish otherwise relevant candidates within a comparable source and locale.
4. Use difficulty, intent, and monthly estimates as supporting evidence, with their missing values stated.
5. If page evidence or user context supports effort or business value, include it in the recommendation.

| Candidate | Recommendation | Evidence needed before execution |
|---|---|---|
| Relevant keyword with an owned ranking URL | Inspect that page for a specific improvement | Stored page/content evidence and the user's goal |
| Relevant keyword with demand but no known matching page | Investigate a content opportunity | Page inventory and intent fit. Absence from ranks is insufficient. |
| Valuable page already ranking strongly | Preserve what works and check identified issues | Measured business value or an explicit user priority |
| Competitor with stronger domain estimates | Investigate the difference within comparable scope | Per-target evidence. Totals do not establish keyword gaps. |
| Missing, stale, partial, or incompatible evidence | Validate the evidence first | The exact missing dataset, profile, or comparable refresh |

Inspect stored page or Site Health evidence before prescribing title, content, indexability, or internal-link changes.
Read `site-health` through `read_skill_doc` for its interpretation rules.
A rank alone cannot identify a technical or content cause.
If supporting evidence is absent, recommend a specific inspection instead of asserting a defect.

Keep the metrics honest:

- `keywordDifficulty` is the provider's 0–100 score, not a percentage or probability of success.
  Do not transfer thresholds between providers.
- `adCompetition` measures advertising competition, not organic difficulty.
- CPC and estimated traffic value are research estimates, not revenue, acquisition cost, or ROI.
  High CPC alone does not establish business value.
- Monthly search estimates describe demand, not this site's traffic or ranking trend.
  Missing months and different sampling periods limit seasonal claims.
- `serpFeatures` describes the search results. It does not prove that the target owns a feature.
- Search Console, analytics, backlinks, and AI citation and mention coverage remain separate instruments.
  Use their stored tools for corroboration with matching scope and dates. Do not combine them into an SEO score.

## Return a concise shortlist

Lead with the most useful next action and the evidence limitation that affects it.
Use one short table for the strongest supported candidates, usually no more than five:

| Priority | Keyword / owned URL | Evidence | Recommended action | Confidence / missing evidence |
|---|---|---|---|---|
| Now, Next, or Validate | Preserve target identity | Supplied position and demand, source, date | One concrete inspection or proposed change | State why the recommendation is supported or provisional |

“Now” means the next recommended investigation or approved action, not permission to publish or spend.
Label the order as your recommendation. If the read is incomplete, call it a shortlist from the inspected sample.
Do not call it the project's top opportunities or calculate an opportunity score, forecast, or aggregate growth rate.
Put common profile, market, language, refresh, and coverage information once above the table.
Link the returned evidence beside each finding. If rows share evidence, link the selected SEO view once.
If no evidence URL is returned, cite the profile and refresh IDs instead of inventing a link.
