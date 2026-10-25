# SEO data

Phase one adds stored keyword metrics, ranked keywords and domain intelligence through a provider-neutral adapter contract. DataForSEO Labs is the first adapter. Refresh is manual; this does not add Lighthouse, performance audits, a crawler or scheduled rank tracking.

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

## Scope and metrics

Simple projects use project scope. Advanced profiles pin `expectedPlanRevision` and a project, group, market or Property key from the context response. The server freezes that plan lineage, rejects stale revisions and never widens a path Property into a domain. Scope selection does not invent targets or keywords.

DataForSEO domain intelligence requires a domain with subdomains included. Exact-host ranked keywords and keyword-only profiles for path/entity Properties are separate supported cases.

Overview metrics describe the first target in the profile. They do not sum overlapping targets or competitors. Rows preserve provider, dataset, engine, locale, collection date and available source date. Null means unavailable; zero remains zero. Page totals count stored rows, not the entire keyword universe.

Search volume, difficulty, CPC and traffic are vendor estimates. CPC and estimated traffic value are SEO research metrics; their currency is unrelated to execution costs. Search Console observations, analytics and AI citation and mention coverage retain their own metrics and denominators.

## Aero analysis

Aero can prioritize keyword and ranking opportunities from saved evidence with the
[SEO analysis playbook](../skills/aero/references/seo-analysis.md).
It recommends page inspections, content research, or missing-data checks with supporting evidence and scope limits.
Priorities are qualitative recommendations, not opportunity scores or traffic forecasts.
Aero cannot edit SEO profiles or start paid SEO refreshes.

## Execution and recovery

Admission reserves the bounded task set atomically against account and project policy. Durable tasks record submission before HTTP work. Exact retries do not dispatch again. Partial results, failed tasks, cancellation and unknown outcomes remain distinct. A refresh keeps previous completed or partial evidence visible.

Only documented rejection permits retry. Explicit zero-cost provider refusals release their reservations. Ambiguous paid responses retain the reservation and block that account until a host operator verifies the upstream receipt. If a received result cannot be saved temporarily, the runtime retains it and retries persistence without another provider call; losing that process before persistence still requires reconciliation. Restart recovery does not resubmit accepted work. Deleting project or run history does not erase outstanding liability.

Operator receipt endpoints require a direct bearer key ID listed in host-only `CANONRY_OPERATOR_KEY_IDS`. Reconciliation also requires `seo.run`. Customer roles, wildcard scope alone, browser sessions, delegated tokens and project keys cannot grant operator authority. Operator tools are excluded from Aero; ordinary audit events contain safe identifiers only.

Phase one does not synthesize visibility share, rank movement, keyword gaps, backlink coverage or SERP-feature opportunity scores. Those require their own data and comparable snapshots. Existing Search Console, backlinks and Site Health surfaces remain the sources for their current metrics.
