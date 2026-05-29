---
name: regression-playbook
description: Detection → triage → diagnosis → response for lost citations. Read when investigating why a query lost its citation.
---

# Regression Playbook

## Detection

A regression is detected when a citation is lost between consecutive completed runs for the same project. Specifically: a query+provider pair that was cited in run N is no longer cited in run N+1.

## Triage

Classify the regression by severity:

| Severity | Criteria |
|---|---|
| **Critical** | Branded term lost on any provider |
| **High** | Top-performing query lost on primary provider |
| **Medium** | Non-branded query lost on one provider |
| **Low** | Query lost that was only marginally cited |

## Diagnosis

For each regression, check causes in order:

1. **Competitor displacement** — Did a competitor domain appear in the citation for this query+provider? Check current run snapshots.
2. **Indexing loss** — Is the page still indexed? Check Google Search Console integration or HTTP status.
3. **Content change** — Did the page content change significantly? Compare content hashes if available.
4. **Provider behavior change** — Did the provider change its response pattern for this query type?
5. **Unknown** — No clear cause identified. Flag for manual investigation.

## Response

1. Alert the client with specific data (query, provider, dates, evidence)
2. Recommend diagnostic steps based on suspected cause
3. If actionable: generate fix (schema update, content suggestion, indexing resubmission)
4. Set monitoring flag to track if the regression resolves
5. Update memory with the regression event and diagnosis

## Local (Google Business Profile) insights

A `gbp-sync` run produces a separate family of **location-scoped** insights (`provider = 'gbp'`, the location's display name in `query`). They're point-in-time, not run-to-run citation transitions, so triage them on their own terms:

| Type | Meaning | Response |
|---|---|---|
| `gbp-lodging-gap` (high) | Lodging-capable location with an empty structured-attribute profile, no Places evidence available | AI engines have no amenities to cite — recommend populating Lodging attributes (pool, wifi, pets, parking, …) in the Business Profile. Highest-signal local AEO fix for hotels. |
| `gbp-listing-discrepancy` (high) | Empty GBP profile **plus** a Places snapshot proving the public listing advertises specific amenities (#648) | The evidence-backed lodging gap — it names the exact amenities (breakfast, parking, pet-friendly, …) the public listing shows but the structured profile doesn't back. Quote them when recommending the fix; supersedes `gbp-lodging-gap`. Requires a Places API key (`gbp.places.api-key` doctor check). |
| `gbp-cta-gap` (medium) | Place actions present but only aggregator/OTA booking links | Recommend adding a direct (merchant-owned) booking/reservation link as the preferred place action so AI surfaces the property's own site, not an OTA. |
| `gbp-metric-drop` (high/medium) | A headline conversion metric (direction requests, website clicks, call clicks) fell sharply week-over-week | Investigate profile/category edits, suspensions, or new local competition; correlate with any recent profile changes. |
| `gbp-keyword-drop` (high/medium) | A head local search term's impressions fell month-over-month | Check whether the property still ranks for the term; refresh the profile / categories. Needs ≥2 accumulated months of `gbp_keyword_monthly` history. |

These flow through the same notification + proactive wake-up path as visibility insights, so you'll see them in the post-`gbp-sync` follow-up. Dismissals are location-scoped (one location's gap can be dismissed without silencing the same gap at a sibling location).

**Calibrating `gbp-listing-discrepancy` (don't over-claim).** The Places cross-reference only sees a narrow, schema-bound amenity subset; the broader rendered hotel module (wifi, pool, room service, room rates) lives in Google Hotel Center, which the Places API can't read. Run live against a real hotel, it surfaced exactly **one** amenity (`wheelchair accessibility`). So quote the named amenities as concrete proof, but frame the discrepancy as a **floor** ("the public listing advertises at least X that your profile doesn't"), not a full inventory. The converse also holds: a thin or empty `gbp places` result is NOT evidence the public listing is bare; it means Places carries little structured data for that place. Either way the recommendation is the same and unchanged by the count: the owner controls the structured GBP attributes AI engines cite, so any amenity the profile fails to assert is a gap worth closing.
