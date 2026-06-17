---
name: regression-playbook
description: Detection → triage → diagnosis → response for lost mentions (primary) and lost citations (secondary). Read when investigating why a query lost a mention or a citation.
---

# Regression Playbook

## Detection

A regression is, primarily, a **lost mention**: a query+provider pair whose answer text named the brand (`answerMentioned = true`) in run N no longer does in run N+1. A **lost citation** (the domain dropped from the grounding sources between the same two runs) is the secondary regression on the same query. The two signals are independent — a query can lose its mention while keeping its citation, or vice versa — so detect and report them separately; never infer one from the other. Treat `answerMentioned = null` as "not checked," not as a lost mention.

## Triage

Classify the regression by severity. Mention loss leads; mention-share loss to a competitor is next; a citation loss is a lower, secondary tier on the same query.

| Severity | Criteria |
|---|---|
| **Critical** | Lost a branded-term MENTION on any provider (the engine stopped naming you for your own brand) |
| **High** | Mention-share loss — a competitor took mention share on a top query where yours fell; or a top-performing query lost its mention on the primary provider |
| **Medium** | Non-branded query lost its mention on one provider; or a top query lost its CITATION (secondary signal) while the mention held |
| **Low** | Query lost a mention or citation it only held marginally |

## Diagnosis

For each regression, check causes in order:

1. **Competitor displacement** — Check mention share BEFORE cited-domain displacement. First: did a competitor brand take the mention share you lost? Compare `scores.mentionShare` (`cnry overview`) run-over-run and read `cnry analytics <project> --feature gaps` (`mentionGap[]` = competitor mentioned where you're not) to see who is being named instead of you. Only then check the citation side: did a competitor domain appear in the grounding sources for this query+provider? Check current run snapshots. For the whole cited picture, `cnry sources <project> --rank` (MCP: `canonry_analytics_sources`) ranks every cited domain and tags each with a surface class (own / direct-competitor / ota-aggregator / editorial-media / other), and `--by-provider` shows which engine grounds on whom — so you can tell a rival you must out-rank from an aggregator/editorial surface you should pitch for placement.
2. **Indexing loss** — Is the page still indexed? Check Google Search Console integration or HTTP status. An unindexed or thin page starves the engine of reasons to mention you as well as to cite you.
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
| `gbp-metric-drop` (high/medium) | A headline conversion metric (direction requests, website clicks, call clicks) fell sharply week-over-week | **First rule out the ~2 to 3 day reporting lag** before treating the drop as real: confirm the window is anchored to `freshness.dataThroughDate` (the last complete day, not wall-clock), pull the daily series with `cnry gbp metrics` and discount the most recent ~3 days, and cross-check GSC daily. The lag reads falsely negative right after US holidays. Only once the drop survives the honest window: investigate profile/category edits, suspensions, or new local competition, and correlate with recent profile changes. |
| `gbp-keyword-drop` (high/medium) | A head local search term's impressions fell month-over-month | Check whether the property still ranks for the term; refresh the profile / categories. Needs ≥2 accumulated months of `gbp_keyword_monthly` history. |

These flow through the same notification + proactive wake-up path as visibility insights, so you'll see them in the post-`gbp-sync` follow-up. Dismissals are location-scoped (one location's gap can be dismissed without silencing the same gap at a sibling location).

**Calibrating `gbp-listing-discrepancy` (don't over-claim).** The Places cross-reference only sees a narrow, schema-bound amenity subset; the broader rendered hotel module (wifi, pool, room service, room rates) lives in Google Hotel Center, which the Places API can't read. Run live against a real hotel, it surfaced exactly **one** amenity (`wheelchair accessibility`). So quote the named amenities as concrete proof, but frame the discrepancy as a **floor** ("the public listing advertises at least X that your profile doesn't"), not a full inventory. The converse also holds: a thin or empty `gbp places` result is NOT evidence the public listing is bare; it means Places carries little structured data for that place. Either way the recommendation is the same and unchanged by the count: the owner controls the structured GBP attributes AI engines cite, so any amenity the profile fails to assert is a gap worth closing.
