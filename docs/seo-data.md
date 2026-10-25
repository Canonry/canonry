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
- **Searches.** One refresh runs one search per distinct search text and location, at most 1,000; markets sharing a search reuse its result. Each search checks `depth` organic results (10 to 100, in steps of 10) on the chosen `device`. The live price scales with depth, and location and device do not change it.
- **Profile rules.** Market rankings sit in their own profile with exactly one Target, which must be one of the project's own domains, and no keywords. Tracked competitors (up to 20) are looked for in the same results.

```bash
canonry seo market-rankings example --profile-id market-rankings --format json
canonry seo market-rankings example --profile-id market-rankings --region north-metro --limit 100 --format json
```

A row's `rankOrganic` is the best organic position of the Target within `depth`; null means the site was not in the checked results, never that the search failed (a failed search writes no row). `regionKey` and `regionLabel` name the market's top-level group. Rows read in region, market and search-text order. The web SEO tab shows the latest refresh by query and market; market-rankings profiles are set up through the API, CLI or MCP for now, and the web editor keeps their settings when editing other fields.

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
