# SEO data

Phase one adds stored keyword metrics, ranked keywords and domain intelligence through a provider-neutral adapter contract. DataForSEO Labs is the first adapter. Market rankings add the project's Google position for its tracked queries, searched from each market's location (DataForSEO's live Google results). Refresh runs on request or on a project schedule; this does not add Lighthouse, performance audits or a crawler.

## Host configuration

Credentials and financial policy live in the host config file and reload when it changes. A temporary read or validation failure pauses dispatch without cancelling queued refreshes. Neither credentials nor financial policy appears in customer API, CLI, MCP, browser or Aero responses. Hosted administrators cannot change this policy.

```yaml
seo:
  enabled: true
  fundingMode: hosted # self-hosted also uses host-local policy
  connections:
    search:
      provider: dataforseo
      label: Search data
      enabled: true
      login: your-api-login
      password: your-api-password
  policy:
    maxRunCostMicros: 250000
    accountDailyLimitMicros: 2000000
    accountMonthlyLimitMicros: 10000000
    projectMonthlyLimitMicros: 2000000
```

Amounts are integer microUSD: 1,000,000 equals one US dollar. These are example host limits, not pricing promises. Connections using the same funding account share one ledger.

The dashboard and Aero name a source by its connection `label`, never by the vendor behind it. Provider ids and vendor dataset prefixes stay in API, CLI and MCP provenance for operators; choose the label you want clients to read.

The SEO tab and Aero call the datasets Searches you rank for (`ranked-keywords`), Search demand (`keyword-metrics`), Domain comparison (`domain-intelligence`) and Market rankings (`market-rankings`). A term people type into Google is a search there, never a keyword, so it does not read as one of the project's tracked queries. Wire names stay as they are.

## Profile and refresh

Read `canonry seo context <project> --format json` for connection IDs and supported scopes. Save an explicit locale and target:

```json
{
  "name": "US organic search",
  "connectionId": "search",
  "capabilities": ["keyword-metrics", "domain-intelligence", "ranked-keywords"],
  "targets": [{"kind": "domain", "value": "example.com", "includeSubdomains": true}],
  "keywords": ["example category"],
  "locationCode": 2840,
  "languageCode": "en",
  "limit": 100,
  "scope": {"kind": "project"}
}
```

```bash
canonry seo profile set example us-organic --file seo-profile.json --format json
canonry seo refresh-intent example us-organic --format json
canonry seo sync example --intent-token '<returned token>' --idempotency-key '<unique key>' --format json
canonry seo run show example '<run id>' --format json
canonry seo overview example --profile-id us-organic --format json
canonry seo ranked-keywords example --profile-id us-organic --run-id '<evidence run id>' --limit 50 --offset 0 --format json
```

Reuse the same intent and key when retrying a submission. Each intent admits at most one refresh, even when retried with a different key. Changed identity conflicts. An expired intent cannot start a new job; an accepted exact replay returns its saved receipt. Deleted history cannot make an accepted intent reusable. Profile edits and evidence reads never start provider work.

The `seo` MCP toolkit mirrors the CLI through the public API. Use `canonry_help` with intent `seo`. A narrow `seo.run` grant refreshes and cancels; `seo.write` manages profiles. Neither grants general writes. Read-only credentials can inspect data and prepare a local intent but cannot submit it.

## Scheduled refresh

A `seo-sync` schedule refreshes every saved profile of the project on its own cadence. Each refresh is stored, so keyword metrics, ranked keywords and domain intelligence build a history, one snapshot per refresh. Monthly suits most projects: provider volumes update monthly and ranking snapshots are often weeks old.

```bash
canonry schedule set example --kind seo-sync --cron '0 7 2 * *' --timezone UTC --format json
canonry schedule show example --kind seo-sync --format json
canonry schedule disable example --kind seo-sync
```

The schedule is the standing approval for that paid work, so creating, changing or enabling one requires `seo.run` and, for a signed-in person, an administrator account. Disabling or removing one needs only ordinary write access. It needs at least one saved profile.

Each firing admits one refresh per profile under the same host policy as a manual refresh, with an idempotency key built from the schedule, the firing minute and the profile, so a repeated firing returns the earlier receipt instead of paying twice. A firing is skipped while a `seo-sync` run for the project is queued or running. A profile that cannot be admitted (policy limit, stale Advanced scope, source not configured) leaves a failed `seo-sync` run with the reason; `canonry runs <project> --kind seo-sync` shows it. Profile edits apply from the next firing.

## Scope and metrics

Simple projects use project scope. Advanced profiles pin `expectedPlanRevision` and a project, group, market or Property key from the context response. The server freezes that plan lineage, rejects stale revisions and never widens a path Property into a domain. Scope selection does not invent targets or keywords.

DataForSEO domain intelligence requires a domain with subdomains included. Exact-host ranked keywords and keyword-only profiles for path/entity Properties are separate supported cases.

Overview metrics describe the first target in the profile. They do not sum overlapping targets or competitors. Rows preserve provider, dataset, engine, locale, collection date and available source date. Null means unavailable; zero remains zero. Page totals count stored rows, not the entire keyword universe.

Search volume, difficulty, CPC and traffic are vendor estimates. CPC and estimated traffic value are SEO research metrics; their currency is unrelated to execution costs. Search Console observations, analytics and AI citation and mention coverage retain their own metrics and denominators.

## Market rankings

Market rankings report where the project's site ranks on Google for its own tracked non-brand queries, the same queries AI visibility measures, with each query searched from its market's location. They never use a separate keyword list, so a market's rankings and its AI answers describe the same queries.

```json
{
  "name": "Market rankings",
  "connectionId": "search",
  "capabilities": ["market-rankings"],
  "targets": [{"kind": "domain", "value": "example.com", "includeSubdomains": true}],
  "keywords": [],
  "locationCode": 2840,
  "languageCode": "en",
  "limit": 100,
  "scope": {"kind": "project", "expectedPlanRevision": 12},
  "rankings": {
    "locations": [
      {"key": "north-metro", "locationCode": 200623, "label": "Dallas-Ft. Worth, TX"},
      {"key": "south-metro", "locationCode": 200618, "label": "Houston, TX"}
    ],
    "depth": 50,
    "device": "mobile",
    "searchText": "query-without-market-region"
  }
}
```

- **Markets.** Advanced projects use the plan's markets in the selected project, group or market scope; a plan without markets is one project-wide market. Simple projects use their configured locations, or one project-wide market when they have none. Property scope does not support market rankings.
- **Locations.** `locations[].key` names an Advanced market or one of its groups: a market searches from the first match among itself, its group and that group's parents, so one entry per metro covers every market under it. Simple projects key locations by location label. Only the project-wide market falls back to the profile's `locationCode`. Every other market must resolve a location, or the profile is refused with the markets that lack one. Location codes come from the provider's location list (DataForSEO: metro areas, cities and neighborhoods).
- **Search text.** `query` searches each tracked query as written. `query-without-market-region` drops a trailing ", <region>" that repeats the market label's region (the part after its last comma), so "best apartments in Dallas, Dallas-Fort Worth" in the market "Dallas, Dallas-Fort Worth" is searched as "best apartments in Dallas". Every row keeps the tracked `queryText` beside the `searchText` actually searched.
- **Searches.** One refresh runs one search per distinct search text and location, at most 1,000; markets sharing a search reuse its result. Each search checks `depth` organic results (10 to 100, in steps of 10) on the chosen `device`. The live price scales with depth, and location and device do not change it. A search text containing a search operator DataForSEO surcharges (`site:`, `inurl:`, `intitle:` and others, matched anywhere, ignoring case) is priced at five times the rate, and the refresh reserves that price.
- **Competitors.** Each row lists the competitors tracked for its query in its market that appear in the checked results, at their best organic position: the project's competitors, plus, in an Advanced plan, those pinned to the groups whose Properties ask the query, the same competitors its AI answers are scored against. A pin never appears in another market's row, even when two markets share one search. No tracked competitor is dropped.
- **Profile rules.** Market rankings sit in their own profile with exactly one Target, which must be one of the project's own domains, and no keywords. Tracked competitors (up to 20) are looked for in the same results.

```bash
canonry seo market-summary example --profile-id market-rankings --format json
canonry seo market-summary example --profile-id market-rankings --region north-metro --format json
canonry seo market-rankings example --profile-id market-rankings --outcome needs-work --sort=rank --format json
canonry seo market-rankings example --profile-id market-rankings --region north-metro --search "pet friendly" --limit 100 --format json
```

### Reading the results by outcome

Every row says where its query landed (`outcome`):

| Outcome | Meaning |
|---|---|
| `page-1` | Google rank 1 to 10 |
| `ranks-11-20` | Rank 11 to 20, the closest to page 1 |
| `ranks-21-plus` | Rank 21 to `depth` |
| `not-ranked` | Searched, and the site is not in the results checked |
| `failed` | The search returned no results page |
| `not-run` | The search never ran: the refresh was cancelled or reached a spending limit first |

`rivalAhead` is true when a tracked competitor ranks above the site, or ranks while the site is not in the checked results. `needs-work` is the filter for ranks 11 and deeper plus not ranked: everything off page 1 that came back.

`canonry seo market-summary` (`GET /projects/:name/seo/market-rankings/summary`, MCP `canonry_seo_market_summary`) counts the rows by outcome. The outcome counts add up to `queries`; `needsWork` and `rivalAhead` overlap them. With no region or market it adds one group per region (a market without a region stands alone); with `--region` one group per market; with `--market` none. Groups come in needs-work order: most ranks 11-20, then most ranks 21 and deeper, then name. `regionLabel` and `marketLabel` name the selected region and market, and `depth` is the results each search checks.

`canonry seo market-rankings` (`GET /projects/:name/seo/market-rankings`, MCP `canonry_seo_market_rankings`) returns the rows. `--market` and `--region` narrow them (both apply when given), `--outcome` takes one outcome, `needs-work` or `rival-ahead`, and `--search` (`q`) matches the query, the searched text or the market label, ignoring case. `--sort` orders them: `market` (the default) by region, market and searched text; `rank` best first, then rows not in the results with the strongest rival first, then searches with no result; `-rank` rows not in the results first, then the worst rank; `query` and `-query` by query text. Write a dash-led order as `--sort=-rank`.

A row's `rankOrganic` is the best organic position of the Target within the checked results; null means the site was not in them. `checkedDepth` is how deep the results were checked: `depth` for a whole results page, fewer when the source returned only some of its pages (`searchStatus: "partial"`, read as "not in the top 30" rather than 50), and 0 for a search with no result. A failed or unsearched query keeps its row, with no rank, no competitors and null `provenance`, so a missing result is never a missing row. `regionKey` and `regionLabel` name the market's top-level group.

### Failed searches and the retry

When the source fails a search and invites a fresh attempt (DataForSEO task status 40101 or 40103), the refresh runs that search once more after its other searches, as a new paid request with its own hold under the same run and account limits. A retry that no longer fits the limits is declined and the search stays failed. A retry is never retried, and cancelling a refresh drops retries it still owes. Reads, counts and run status use each search's latest attempt, so a retry that succeeds replaces the failure. A results page the source returns only in part (task status 40106, charged for the pages returned) is kept, ranked within the pages that came back.

### Dashboard

The web SEO tab leads with the refresh line (`Updated` date, the next scheduled refresh from the project's `seo-sync` schedule, and a caveat such as "2 searches failed" with its sentence in a tooltip), then the Google rank counts, a table of regions or markets five at a time that opens each one (`seoRegion` and `seoMarket` in the URL), and the queries ten at a time. The queries open on Needs work, closest to page 1 first; Show picks another outcome, Find a query searches, and the Query and Google rank headers re-sort. Each row's Details holds the ranking page, the searched text and location, the position on the page, the tracked competitors and the source. Every count, filter and order is the API's. Market-rankings profiles are set up through the API, CLI or MCP for now, and the web editor keeps their settings when editing other fields.

A refresh runs its searches one at a time, so a large one takes a while. Restarting the server mid-search leaves that search for operator reconciliation, as with any paid request; avoid restarts while a market-rankings refresh runs.

## Aero analysis

Aero can prioritize keyword and ranking opportunities from saved evidence with the
[SEO analysis playbook](../skills/aero/references/seo-analysis.md).
It recommends page inspections, content research, or missing-data checks with supporting evidence and scope limits.
Priorities are qualitative recommendations, not opportunity scores or traffic forecasts.
Aero cannot edit SEO profiles, start paid SEO refreshes or schedule them.

## Execution and recovery

Admission reserves the bounded task set atomically against account and project policy. Durable tasks record submission before HTTP work. Exact retries do not dispatch again. Partial results, failed tasks, cancellation and unknown outcomes remain distinct. A refresh keeps previous completed or partial evidence visible.

Only documented rejection permits retry. Explicit zero-cost provider refusals release their reservations. Ambiguous paid responses retain the reservation and block that account until a host operator verifies the upstream receipt. If a received result cannot be saved temporarily, the runtime retains it and retries persistence without another provider call; losing that process before persistence still requires reconciliation. Restart recovery does not resubmit accepted work. Deleting project or run history does not erase outstanding liability.

Operator receipt endpoints require a direct bearer key ID listed in host-only `CANONRY_OPERATOR_KEY_IDS`. Reconciliation also requires `seo.run`. Customer roles, wildcard scope alone, browser sessions, delegated tokens and project keys cannot grant operator authority. Operator tools are excluded from Aero; ordinary audit events contain safe identifiers only.

Phase one does not synthesize visibility share, rank movement, keyword gaps, backlink coverage or SERP-feature opportunity scores. Those require their own data and comparable snapshots; market rankings store each refresh so rank movement can be compared later. Existing Search Console, backlinks and Site Health surfaces remain the sources for their current metrics.
