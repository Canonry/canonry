# Canonry MCP Adapters

Canonry is CLI/API-first. MCP exists to make that same public surface easier to use from MCP clients such as Claude Desktop, Codex, and custom agent shells that prefer a tool catalog over shell commands or raw HTTP.

MCP is useful here because many agent clients can discover typed tools, validate arguments, and call them without asking the user to compose `curl` or `canonry ... --format json` invocations. It is not more authoritative than the API or CLI. `canonry-mcp` is an adapter over `createApiClient()` only, so it must not expose capabilities that do not already exist through Canonry's public API/CLI.

New public API/CLI capabilities should get MCP parity by default. If a capability is intentionally not exposed as an MCP tool, classify its OpenAPI operation as `deferred` or `excluded-protocol` in `packages/canonry/src/mcp/openapi-classification.ts` and include the reason there. Credential, bearer-token, browser-session, and other high-risk operations may be deferred, but they should be explicit exceptions rather than silent omissions.

## Universal operations guidance

Connected agents start with initialization guidance and `canonry_help`, not a
skill installation. Call `canonry_help({intent: "status"})`, or use `diagnose`,
`measurement`, `integrations`, `reports`, or a short task description. The
default response is a compact route, not the full catalog:

```json
{
  "guideVersion": "v1",
  "mode": "hosted-fixed-catalog",
  "scope": "read-only",
  "workflow": "status",
  "next": ["canonry_projects_list", "canonry_project_overview"],
  "workflows": ["status", "diagnose", "measurement", "integrations", "reports"],
  "approvalBoundary": ["provider reads", "sweeps", "writes"],
  "operationsGuideUrl": "https://github.com/Canonry/canonry/blob/main/docs/agent-operations/v1.md"
}
```

The response also contains short `guidance`, `approvalRule`, and `authority`
fields. It is returned as both JSON text and MCP `structuredContent`. `next`
contains only available stored-evidence tools; it never executes them. Use
listed tool schemas for arguments and keep the server's permission boundary.

Hosted catalogs are fixed and never offer toolkit loading. Progressive stdio
may return `loadToolkits`; load one, await its response, and ask help again.
Eager stdio reports `stdio-fixed-catalog`. Set `includeCatalog: true` for the
existing scope, core-tools, loaded-toolkit, and toolkit-details fields. Default
help no longer includes that large catalog; clients that parsed `toolkits`
should opt in explicitly.

The [Operations Guide v1](agent-operations/v1.md) is the public source of truth.
`canonry://agent-operations/v1` exposes the same guide as an optional MCP
resource. Resource support, browser access, local CLI installation, and plugins
are not prerequisites: every remote agent can navigate with help alone.
Codex/Claude `SKILL.md` files are generated from that source as optional native
guidance. Guidance never grants permissions; the server enforces authority.

## Install

For a local stdio runtime, install Canonry normally. Agents using an existing
hosted MCP connection do not need this installation:

```bash
npm install -g @canonry/canonry
```

The package exposes one MCP executable:

```bash
canonry-mcp
```

`canonry-mcp` itself stays out of the main CLI to keep stdio clean — telemetry, help text, or stray logs would corrupt the protocol. The main CLI does ship two read/write *helpers* that operate on client config files only:

```bash
canonry mcp install --client claude-desktop
canonry mcp install --client cursor --read-only
canonry mcp config  --client codex            # print snippet for clients without auto-install
```

`install` merges a `canonry` MCP server entry into the client's config (creating the file if needed, backing up the original to `<config>.canonry.bak`). It is idempotent — re-running with the same flags is a no-op. `config` prints the snippet to stdout for copy-paste or use in unsupported clients (currently Codex CLI, since it uses TOML). Both helpers accept `--name <server>` to install under a custom key, `--read-only` to scope to the 148 read API tools, `--dry-run` (install only), and `--format json` for machine-readable output.

## Auth

Operational settings support uses the same API permissions: `canonry_telemetry_update`
and `canonry_provider_settings_update` require `settings.write`. The provider tool
accepts only model/quota changes for an existing configuration; credentials,
base URLs, and token creation/rotation remain in the operator setup flow.
`canonry_logs_list` requires instance-wide `logs.read` (or wildcard), and an admin
role for user sessions. It returns redacted application and HTTP runtime events
with identity/time filters, retention limits, and loss counters. File-backed
hosts retain up to 10,000 events for seven days across restarts; in-memory hosts
report process retention. This is separate from durable audit history.
Project-scoped keys cannot access it, even with a project filter. See the
[operations guide](agent-operations/v1.md#agent-operations).

`canonry-mcp` inherits the normal local config at `~/.canonry/config.yaml` through `createApiClient()`.

For a local server, use the same config created by `canonry init` and run `canonry serve`. For a remote API, set `apiUrl` and `apiKey` in `~/.canonry/config.yaml`. The stdio adapter uses that API key; hosted HTTP clients can instead use the instance's OAuth authorization flow.

### Research access

Research is an explicit `research.run` capability shared by REST, CLI, the
dashboard, and MCP. It spends provider quota and saves isolated evidence; it
does not grant tracked-query changes, sweeps, ICP discovery, settings writes,
key creation, or saving/applying query patterns. A direct research run submits
one provider/model/location context. A reviewed batch submits independently
reviewed destinations under one retry key. Both send exact final query strings:
the client expands any pattern before submission, and selecting an Advanced
market or Property only records the destination—it never rewrites queries or
automatically fans out a group.

An administrator can create a project-bound agent credential:

```sh
canonry key create --name research-agent --project demo --scope read --scope research.run --format json
```

Configure that key in the normal Canonry client config. Then use
`canonry research run demo "Which platform fits an agency?" --provider openai --format json`,
`canonry research list demo --format json`, and `canonry research show demo <run-id> --format json`.
REST uses `POST /api/v1/projects/demo/research/runs` and the matching list/detail
GET routes. Research history also returns safe provider/model choices and
`access: { canRun, dailyRunLimit }`, so agents can discover their permission
without trial runs. Model choices use the configured provider's cached catalog
or bundled defaults; listing history never triggers or waits for live model
discovery, including on a cold or expired cache.

For hosted OAuth, request `read research.run` (optionally `offline_access`) and
approve the research permission. Viewer accounts also require the deployment's
`research.allowViewers` opt-in. Re-authorize existing connections with the new
scope; a token approved for `read` remains read-only, including for admins.
Current account authority is rechecked on every request.
Each HTTP session is bound to its exact bearer token and effective scopes and
project boundary, not just the signed-in account. A replacement/refreshed token
or changed authority must initialize a new session; reuse returns HTTP 404.
Revoked or expired tokens remain rejected by authentication.

Use `/api/v1/mcp` or `/api/v1/mcp/x/discovery`. Authorized catalogs include
`canonry_research_run_start`, `canonry_research_batch_start`,
`canonry_research_runs_list`, and `canonry_research_run_get`; stdio exposes
them after loading `discovery` or with `--eager`. Narrow research credentials do
not expose unrelated mutation tools, including pattern save/apply tools.
Explicit `--read-only` and `/readonly` always remove research creation.

Limited research credentials and viewer sessions share the deployment's
per-project UTC daily cap (default 20). New keys and MCP reconnects do not reset
the cap. Idempotent retries return the existing receipt. MCP runs retain the
initiating account, and API/CLI key runs retain the key identity. Root/admin
full-authority research keeps its existing uncapped behavior; an admin OAuth
grant containing only `research.run` still uses the limited budget.

## Client Config

Claude Desktop:

```json
{
  "mcpServers": {
    "canonry": {
      "command": "canonry-mcp",
      "args": []
    }
  }
}
```

Read-only mode:

```json
{
  "mcpServers": {
    "canonry": {
      "command": "canonry-mcp",
      "args": ["--read-only"]
    }
  }
}
```

Codex-style TOML:

```toml
[mcp_servers.canonry]
command = "canonry-mcp"
args = []
```

## Hosted connections

Connect to `/api/v1/mcp` on the instance for the entire API tool catalog, available immediately: core, monitoring, setup, GSC, GA, GBP, OpenAI ads, Google Ads, GTM, conversion tracking, traffic, agent, and discovery. Use `/api/v1/mcp/readonly` to force read-only tools even with a write-capable credential. A read-only credential also stays read-only on the default endpoint.

The default connection includes visibility reports, Property rankings, stored question results and competitors, changes, data quality, and all integration and setup tools. Listing tools does not execute them or grant new permissions; each call still uses the caller’s existing authority. The full catalog includes provider-spending and write operations, subject to the approval and access rules below.

Specialist connections remain at `/api/v1/mcp/x/<toolkit>` and `/api/v1/mcp/x/<toolkit>/readonly`, exposing core plus that toolkit. Hosted catalogs are fixed at connection initialization and do not offer `canonry_load_toolkit`. After upgrading the server, refresh or re-import the connector's tools and reconnect so the client sees the expanded catalog.

## Tool Surface

`canonry_research_run_start` is for one direct context. It accepts the final
editable query text and optional saved destination/provenance; it does not
expand a pattern or a group.

`canonry_research_batch_start` accepts reviewed queries across explicit markets, Properties, or configured locations.
Its request contains a required `idempotencyKey` and at most 20 `runs`, with at most 50 total queries.
Each run specifies final query text, provider, model, and location (a configured object or `null`).
Market and Property scopes also require `expectedPlanRevision`.
If a saved pattern is used, the caller substitutes it client-side and submits
the resulting exact query text plus optional template provenance. A selected
scope records where the result belongs; it does not substitute text or create
additional destinations.
The API accepts all runs together or accepts none. Individual saved runs then complete independently.
An unchanged retry returns the same runs. A changed request with the same key conflicts.
This paid operation remains write-only and never changes tracking.
The matching CLI is `canonry research batch <project> <json-file|-> [--wait] --format json|jsonl`.
The browser offers the same [reviewed Research workflow](query-visibility.md#repeat-research-across-destinations).

The catalog is curated for client usability: 221 API tools (148 read in `--read-only`) plus two meta-tools (`canonry_help`, `canonry_load_toolkit`). It covers projects, project-overview and search composites, project and instance-wide change history (`canonry_project_history`, `canonry_history_global`), citation/mention trend analytics (`canonry_analytics_metrics`), cited-source rankings (`canonry_analytics_sources`: the full ranked + per-provider + classified cited-domain surface), aggregated per-query mention/citation stats with sample size (`canonry_visibility_stats`: confidence-aware proportions, optional per-provider), statistically honest month-over-month AEO comparison (`canonry_visibility_compare`: share-of-voice-led, Wilson intervals, within-noise verdict, drift-aware), config apply, versioned Target measurement plans (`canonry_measurement_plan_get`, `_versions`, `_version_get`, `_compile_preview`, `_diff_preview`, `_publish`, `_segment_retire`), one Property's paged evidence (`canonry_measurement_property_evidence`: `shape=sources` for one row per cited URL, `shape=answers` for one row per measured answer with its cited URLs nested, which is the only shape that shows the answers a Property was not cited in), runs, snapshots, insights, health, query generation and replacement, legacy keyword aliases, competitor add/remove, schedules, settings, safe key identity, telemetry status, and supported notification event names, GSC reads plus the sitemap-submission write tool (`canonry_gsc_sitemaps_submit`, explicit URLs or `indexes` / `all-files` modes; all-files omits parent indexes), GA reads including per-day AI referral sessions (`canonry_ga_ai_referral_daily`) and native-channel/lead/search-demand measurement analysis, GBP local-AEO reads (incl. `canonry_gbp_attributes`: owner-set Business Profile attributes across categories, and `canonry_gbp_places`: the Places rendered-listing cross-reference), Google Ads and GTM conversion evidence plus stored contract integrity, server-side traffic ingestion (Cloud Run / WordPress / Vercel connect/sync + async backfill + crawler/AI-referral rollup reads), OpenAI ads live account/integrity state, geo target lookup, conversion pixels/event settings, stored ads snapshot-provenance/configuration diagnostics plus historical campaign activity (never a provider serving or eligibility verdict), the bounded live provider read with a stored-snapshot delta (`canonry_ads_live_delivery`), paid-surface snapshots/rollups, sync, durable operation receipts, unresolved-receipt listing, safe provider-state reconciliation, exact-executor activation recovery, image upload, paused campaign/ad-group/ad create/update/pause lifecycle, and exact-grant campaign-tree activation, the doctor health-check, Site Health scans and canonical graph semantics (`canonry_site_health_overview`, exact page audit evidence via `canonry_site_health_page_audit`, focused subgraphs, directed shortest paths, cursor-paged scan changes, page inventory, structure, links, neighbors, and opt-in dead links), run trigger/cancel, schedule updates, insight dismiss, content gap/target/source analysis, the winnabilityClass gate (`canonry_content_map`: per-domain cited-surface classifications) and structured brief synthesis (`canonry_content_brief`, gated to ownable targets), source-aware backlinks (`canonry_backlinks_domains` reads either Common Crawl or Bing Webmaster via `source`; `canonry_backlinks_sources` reports per-source availability), durable Aero memory (list/set/forget), agent transcript clear, agent webhook attach/detach, the tracked-basket discovery pipeline, and saved free-form research batches (`canonry_research_run_start`, `canonry_research_runs_list`, `canonry_research_run_get`) that return model answers and sources without adding a query to tracking.

Advanced Measurement v2 spans monitoring and setup. Monitoring provides the stored portfolio summary, Property questions/results/competitors, and change and data-quality reads. Setup provides setup state, the scoped overview and Property evidence, the draft plus its paginated Targets, assignments and groups, and saved query sets/templates. Seven write tools expose one discriminated `canonry_measurement_draft_action` surface, plan deactivation, and query-set/template mutations. The draft-action input is `{ project, operation }`; `operation` is a nested discriminated union whose twenty-five branches correlate each `action` with its request and header fields. Reads return stored state and never start provider work. Draft previews also never start provider work or mutate state, but they remain branches of the write-classified draft-action tool and are therefore absent from a read-only MCP catalog.

The matching CLI bridge is `canonry measurement-plan advanced <project> <operation> [<json|->] --format json|jsonl`. It accepts a JSON file or stdin; `--format json` returns the API response unchanged. Read operations take their endpoint query object; structured writes use an envelope so request body and required headers/IDs stay explicit. `draft-action` takes the same typed `{ action, request?, etag?, idempotencyKey? }` object as its MCP `operation` field; deactivation takes `{ request, idempotencyKey }`; query-set/template get, upsert, delete, and apply take their ID plus `request`/`idempotencyKey` where required. The operations are `setup`, `overview`, `portfolio-summary`, `property-questions`, `question-result`, `property-competitors`, `changes`, `data-quality`, `draft`, `draft-targets`, `draft-assignments`, `draft-groups`, `draft-action`, `deactivate`, and query-set/template list, get, upsert, delete, and apply variants. The paged draft collections and query-set/template lists stream a metadata header then records with `--format jsonl`.

For best/worst Property mention performance, use `canonry_measurement_portfolio_summary`.
It defaults to `queryClass=non-brand`; name that class in the report. Request branded
results separately, or `all` only when a combined comparison is intended.
`mentionRanking.strongest` and `.weakest` rank available mention rates before the
list limit, independently of citation availability. `eligiblePropertyCount` is
the ranked population; `excluded` lists every excluded Property with its reason,
without being cut off by the ranked list limit. `truncated` describes the two
ranked lists. Keep numerator/denominator with each rate; rates can tie and the
stable label/key tie-break does not establish a unique winner. These are
descriptive rates from each Property's assigned questions, not matched-query or
confidence-adjusted comparisons. An unavailable portfolio aggregate does not
invalidate known Property rates. Flag ambiguous Properties separately; never
substitute citation ranking without saying the metric changed. Aggregate metrics,
the existing combined-signal `weakestProperties`, and overview pagination retain
their existing semantics.

`canonry_measurement_overview` ranks one revision-pinned run snapshot only; it does not infer a trend or compare across revisions. Its optional `sort` is `label-asc` (default), `label-desc`, `citationCoverage-asc`, `citationCoverage-desc`, `mentionCoverage-asc`, or `mentionCoverage-desc`. For coverage sorts, unavailable rows are always the first bucket, then available rates follow the selected direction. Its cursor is sort-aware and pins later pages to the active revision, displayed run, evidence snapshot, and filters even if a newer run completes: reuse it unchanged with the same sort and filters or the API rejects it. Evidence appended to a named running run also invalidates the cursor instead of silently reordering later pages. Legacy label cursors work only when `sort` is omitted; an explicit sort needs a new sort-bound cursor.

Ordinary read-only API keys intentionally may read unpublished setup and draft state for their bound project; treat those callers as authorized to see that portfolio and competitor structure. Embed mode is narrower: its explicit safe-read allowlist denies draft paths, including when a self-hosted embed uses a project-scoped key.

For an existing-draft mutation, pass the ETag returned by `canonry_measurement_draft_get` and a fresh `idempotencyKey`; reuse that key only when retrying the identical request. Omitting the ETag preserves the API's actionable `MEASUREMENT_DRAFT_ETAG_REQUIRED` response (HTTP 428), while a stale ETag preserves `MEASUREMENT_DRAFT_ETAG_STALE` (HTTP 412). Starting a draft needs an idempotency key but no ETag. Compile/diff previews need neither header. Plan deactivation and query-template apply need an idempotency key but no draft ETag. Query-set and query-template PUT/DELETE operations use their naturally idempotent HTTP methods.

`canonry_apply_config` accepts one config-as-code project document per call. For multi-document YAML or multiple project files, agents should call the tool once per project document. `canonry_queries_generate` returns suggestions only; persist accepted suggestions with `canonry_queries_add` or replace the tracked set with `canonry_queries_replace`. The `canonry_keywords_*` tools remain as legacy aliases over the same query store for older clients.

`canonry_snapshot` (discovery toolkit) generates a prospect report without creating
a project. It calls `POST /api/v1/snapshot` and spends provider quota, so it is
unavailable to read-only connections. `providers: ["gemini"]` selects configured
providers; `providerMode: "all" | "api" | "browser"` filters by transport.
Omitting both uses all configured providers. Both selectors also constrain
analysis calls. Browser-only selection requires manual `queries` and uses
deterministic analysis. Unknown providers, mode conflicts, and empty selections
fail before site fetching or provider work.

Start with `canonry_help({intent: "prospect snapshot"})`. Help offers stored
provider settings in `next` and, on progressive stdio, the discovery toolkit to
load. After loading, `actions` includes `canonry_snapshot` when this connection
permits it. Fixed catalogs offer the action immediately when available. Help
starts no provider work; execution requires approval for the selected work.

```bash
canonry snapshot "Acme" --domain acme.example --provider gemini --format json
canonry snapshot "Acme" --domain acme.example --provider-mode api --format json
canonry snapshot "Acme" --domain acme.example --provider-mode browser --queries "best widget suppliers"
```

Repeat `--provider` to select several providers. The CLI and MCP accept the same
selection as the API; a named provider must match an explicitly selected mode.

Deferred from v1: Aero ask SSE, OAuth callbacks, raw screenshots, project delete, broad admin/provider writes, Google/Bing/GA connect/sync/inspect/indexing writes, WordPress writes, CDP screenshot, generic notifications, backlinks, raw OpenAPI, and raw HTTP escape hatches.

Some write tools compose existing API calls rather than using a native atomic endpoint. The agent webhook attach/detach tools are best-effort under concurrent calls until the public API grows narrower attach/detach operations for that domain.

`canonry_project_upsert` and `canonry_apply_config` use PUT semantics — fields omitted from the request are reset to their defaults, with one `canonry_apply_config` exception: a spec carrying neither `queries` nor `keywords` leaves the tracked-query basket unchanged. To clear the basket, pass an explicit `queries: []`; omitting the field never clears it. Pass the full intended project shape, including `providerModels` when retaining project model overrides. An empty map inherits instance settings. `canonry_apply_config` accepts one project document per call; loop on the client side for multi-project configs.

The built-in Aero agent consumes the same MCP-derived local tool registry, then may apply an agent profile. The `ads-operator` profile is intentionally narrower than the full MCP catalog and adds one Aero-only context-packing helper, `canonry_ads_operator_context`, that bundles existing public reads for long-session efficiency. It is not an MCP tool because it introduces no new public capability; agents that need the same data outside Aero should call the existing project overview, ads, doctor, and memory tools directly.

Five ads tools call the provider live and spend on the operator's ad account:
`canonry_ads_account`, `canonry_ads_geo_search`, `canonry_ads_conversion_pixels`,
`canonry_ads_conversion_event_settings`, and `canonry_ads_live_delivery`. They
are read tools and stay in a `--read-only` catalog, but the server refuses them
to a credential that was never granted ads authority — a key carrying only
`read`, or one scoped to something unrelated, gets `403`. The default `*` key
and the ads-operator key below both satisfy the gate.

For an external ads operator, default to a project-scoped key with exactly
`read`, `ads.write`, and `ads.activate`. The auth layer confines a key whose
only write grants are ads scopes to that project's `/ads/*` mutations; unrelated project writes
remain forbidden. Do not hand an unscoped key to an external operator. Prefer
the `ads-operator` Aero profile when operating inside
Canonry because its visible tool catalog is narrower as well. All lifecycle
creates are paused and all updates require the entity already be paused. Direct
activation and archive tools are absent. A human uses a different `ads.approve`
credential through the API or CLI to issue a short-lived, single-use grant for
the exact tree, advertiser account, and executor key; grant creation and revoke are not MCP tools.
The operator can only execute that already-approved grant. The ads toolkit lists
unresolved receipts through an opaque keyset cursor, routes
`campaign_tree_activate` to bodyless exact-executor
resume, and reconciles other supported checkpointed provider IDs only by
verifying live state on the receipt-bound account. Neither recovery path retries
an ambiguous mutation or binds an uncheckpointed create by mutable-field
similarity. Fresh pending generic receipts cannot be manually claimed, and
inconclusive generic inspections back off before a five-attempt quarantine.
Click campaigns bill for clicks and their ad groups must use click billing;
Canonry rejects a parent/child bidding mismatch before any mutation. Naming
provider-issued conversion event-setting IDs is a separate, optional
optimization choice, not a requirement of click billing.
Complete the live-provider and
production-graduation checks in the
[CLI operator reference](../skills/canonry/references/canonry-cli.md#guarded-operator-release-gates)
before enabling spend.

## Progressive Tool Discovery

The full 223-tool catalog (221 API tools plus two meta-tools) is too large to expose eagerly in most sessions. `canonry-mcp` defaults to a small **core tier** and registers the rest on demand via `notifications/tools/list_changed`.

For shared query assignments and measured results, see [Query control and AI visibility](query-visibility.md). The setup toolkit provides workspace, preview, and commit tools. Monitoring provides `canonry_visibility_report`. Its optional `marketKey` narrows a project, group, or property report to exact saved market assignments, including metrics, competitors and answer details. Omit it to read the full selected scope. Preview requires write access but starts no provider calls.

Core tier (always loaded):

- `canonry_help` — compact intent route and approval boundaries; use `includeCatalog: true` for toolkit details
- `canonry_load_toolkit` — register a toolkit's tools for the rest of the session
- `canonry_projects_list`, `canonry_project_get`
- `canonry_project_overview` — composite read for "how is project X doing?"
- `canonry_search` — composite text search across snapshots and insights
- `canonry_doctor` — run health checks (Google/GA auth, redirect URI, scopes, providers); filter by check id or wildcard
- `canonry_settings_get`
- `canonry_apply_config`, `canonry_run_trigger`, `canonry_run_cancel`
- `canonry_agent_webhook_attach`

Toolkits (loaded on demand):

| Toolkit | What's in it | When to load |
| --- | --- | --- |
| `monitoring` | runs list/latest/get, project history, timeline, snapshots list/diff, insights list/get, health latest/history, content targets/sources/gaps, `canonry_report` (aggregated AEO report bundle), `canonry_organic_evidence` (GSC + GA4 + server AI evidence ladder) | Investigating regressions, comparing runs, reviewing insights/health, surfacing content opportunities, generating client-facing reports |
| `setup` | project export/upsert, sitemap Target discovery, measurement setup/overview, draft get + paginated Targets/assignments/groups, guarded draft actions, query sets/templates, measurement-plan get/history/compile/diff/publish/deactivate, revision-pinned measurement report, queries list/add/remove/replace/generate, legacy keyword aliases, competitors list/add/remove, schedule get/list/set/delete, notification event names, telemetry status, insight dismiss, backlinks domains | Onboarding a project, discovering and publishing its Target measurement plan, reviewing stored Target evidence, editing queries/competitors/schedules, reviewing notification capability, and checking safe setup state |
| `gsc` | google connections list, GSC performance, inspections, coverage, coverage history, sitemaps, sitemap submission, deindexed | Indexing, coverage, sitemap analysis and submission from Google Search Console |
| `ga` | GA status, native-channel/lead/search-demand measurement analysis, traffic, coverage, AI/social referral history, social/attribution trends, session history | Traffic, referral, attribution data from Google Analytics 4 |
| `gbp` | Google Business Profile location discovery, selection, and local AEO evidence | Reviewing connected Business Profile locations and local search visibility |
| `ads` | OpenAI ads connection/live account status, integrity review, geo target search, conversion pixels/event settings, lifecycle-ready snapshots with upstream timestamps, paid rollups, summary, sync, durable receipts, unresolved-receipt listing, provider-state reconciliation, exact-executor activation recovery, image upload, paused create/update/pause operations, and execution of an exact human approval grant. No approval creation, direct activation, or archive. | Planning, reviewing, recovering ambiguous receipts, preparing ChatGPT ads, or executing a separately approved launch |
| `google-ads` | connected status, customer discovery, stored conversion-action and effective-goal snapshots, and bounded read-only sync | Discovering Ads customer options or reviewing conversion evidence |
| `gtm` | account, container, and workspace discovery, sanitized live/draft graphs, and bounded read-only sync | Discovering GTM resource options or reviewing tag-graph evidence |
| `conversion-tracking` | declared contracts and stored cross-provider integrity assessments with no live provider call | Checking whether stored Google Ads and GTM evidence agrees with a contract |
| `traffic` | List sources, source detail (24h totals + latest run), windowed crawler/AI-referral events, Cloud Run / WordPress / Vercel connect, sync, async backfill for Cloud Run/Vercel (replaces hourly rollups in a `--days` window with current classifier output; WordPress requires a retention-aware repair) | Confirming server-log evidence of crawler hits or AI-referral sessions (e.g. GPTBot, ChatGPT-User), wiring up / syncing a Cloud Run, WordPress, or Vercel traffic source, or one-shot reclassifying supported historical logs after a classifier change |
| `agent` | Aero memory list/set/forget, agent clear, agent webhook detach | Reading or writing project-scoped Aero notes, clearing a stuck conversation, removing an agent webhook |
| `discovery` | **Find queries:** start/inspect ICP discovery sessions, harvest candidate seeds, and optionally promote approved findings into tracking. **Research queries:** start one run with `canonry_research_run_start` or reviewed destinations with `canonry_research_batch_start`. Read results with `canonry_research_runs_list` and `canonry_research_run_get`. Research never adds tracked queries. | Expanding or auditing a project's tracked-query basket, or researching specific queries, models, and locations without changing tracking. |

Loading a toolkit is idempotent and persists for the rest of the session; there is no unload. `canonry_load_toolkit` returns `{ status: 'loaded' \| 'already-loaded' \| 'empty', name, tools }`. The server coalesces all enable/disable side effects into one `notifications/tools/list_changed` per call, fired just before the response — so a single call refreshes the client's catalog once regardless of how many tools the toolkit contains.

#### Wait for the response before pipelining

`canonry_load_toolkit` runs the enable side effect synchronously inside the call's handler, but the newly registered tools only become callable after the response is returned to the client. Always await the response before issuing a `tools/call` for a tool that the toolkit just enabled. Pipelining the two requests on the same connection (sending `tools/call` for `canonry_insights_list` immediately after `canonry_load_toolkit` without awaiting the load response) can race the registration and produce `MCP error -32602: Tool ... disabled`. Sequenced clients (Claude Desktop, Cursor, Codex) already wait by default; only batch test harnesses or custom clients risk this.

### Eager mode

Power-user environments (scripts, Aero, telemetry harnesses) that want the flat 220-API-tool catalog at startup can opt back in with `--eager` (or `CANONRY_MCP_EAGER=1`):

```json
{
  "mcpServers": {
    "canonry": { "command": "canonry-mcp", "args": ["--eager"] }
  }
}
```

`--eager` and `--read-only` compose: `canonry-mcp --eager --read-only` registers every read tool eagerly.

### Read-only scope and toolkits

`--read-only` filters out write tools before the catalog is built, so toolkits with no read tools appear as `empty` from `canonry_load_toolkit`. Mixed toolkits load with whatever survives the filter — the `agent` toolkit, for example, drops its writes (`canonry_memory_set`, `canonry_memory_forget`, `canonry_agent_clear`, `canonry_agent_webhook_detach`) and exposes only `canonry_memory_list` under read-only scope.

### Read-only API keys (auto-detection)

The same startup probe preserves explicit narrow scopes such as `research.run`
and filters the catalog to matching capabilities, not general writes.

A read-only API key (`canonry key create --read-only`, scopes `['read']`) is rejected by the API on every write HTTP method (`403 FORBIDDEN`). To avoid advertising tools that would 403 at call time, `canonry-mcp` probes `GET /keys/self` at startup and, when its configured key is read-only, **auto-restricts the catalog to read tools** — exactly as if `--read-only` had been passed — and prints a one-line notice on stderr. The probe is best-effort: if the API is unreachable or the server predates the endpoint, the adapter keeps the requested scope. A read-only key can only ever narrow the catalog, never widen it; passing `--read-only` explicitly skips the probe.

## Safety Rules

MCP uses stdio, so any normal stdout write breaks the protocol. Code under `packages/canonry/src/mcp/` must not use `console.log`, `process.stdout.write`, CLI dispatch, telemetry, logger imports, DB imports, route imports, or job-runner imports. Tool handlers call `createApiClient()` only.

Tool input schemas are Zod schemas tied to `packages/contracts` and exposed as JSON Schema for MCP clients. Ordinary tool results retain their legacy JSON text and also provide MCP `structuredContent`: object responses stay objects, top-level arrays are wrapped as `{ "items": [...] }`, and scalars as `{ "value": ... }`. Canonry API/client errors and Zod input-validation errors return MCP tool results with `isError: true` and the same structured `{ "error": { "code", "message", "details" } }` envelope in both text and `structuredContent` (`VALIDATION_ERROR` for bad input, with `details.issues` listing the per-field problems). Malformed JSON-RPC and unknown tools remain MCP protocol errors.
