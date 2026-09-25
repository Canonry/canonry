# doctor


`canonry doctor` runs an extensible set of health checks across global config and project-scoped integrations. Each check has a stable dotted ID (`google.auth.connection`, `ga.auth.connection`, `config.providers`, …) so an agent or skill can filter via `--check <id>` / `?check=<id>` and react to specific failures programmatically.

- **CLI:** `canonry doctor [--project <name>] [--check <id>...] [--format json]`
- **API:** `GET /api/v1/doctor` (global), `GET /api/v1/projects/:name/doctor` (project-scoped). Both accept `?check=<comma-separated ids or wildcards>`.
- **MCP:** `canonry_doctor` (core tier) — passes `project` + `checks[]` straight through.

Each check returns `status: ok | warn | fail | skipped`, a stable machine-readable `code`, a `summary`, optional `remediation`, and structured `details`. v1 ships:

| Category | ID | Scope | Purpose |
|----------|----|-------|---------|
| database | `db.file.present` | global | Configured SQLite database file still exists on disk (catches `rm ~/.canonry/data.db` against a running daemon — SQLite holds the inode open across `unlink`) |
| config | `config.file.present` | global | Configured `~/.canonry/config.yaml` still exists on disk (same gotcha as above) |
| config | `canonry.version.current` | global | The running server is the newest published `@canonry/canonry`: warns `version.outdated` with an upgrade command for the detected install (npm, Homebrew, or container) plus a restart reminder; skipped when the update check is opted out (reports which opt-out, never suggests undoing it), before the registry has been reached, or on deployments that don't report update status. Registry values that are not strict semver are ignored |
| auth | `google.auth.connection` | project | OAuth credentials present, refresh token works |
| auth | `google.auth.property-access` | project | Authorized principal can list the selected GSC site |
| auth | `google.auth.redirect-uri` | project | `publicUrl`-derived redirect URI is valid + advertised |
| auth | `google.auth.scopes` | project | Granted GSC + Indexing scopes match what's stored |
| auth | `ga.auth.connection` | project | GA4 service account verifies against the configured property |
| auth | `gbp.auth.connection` | project | Google Business Profile OAuth credentials present, refresh token works |
| auth | `gbp.auth.scopes` | project | Granted scope includes `business.manage` |
| auth | `gbp.account.access` | project | The tracked GBP account is still listable for the authorized user (maps 0-QPM access-form-pending → warn) |
| auth | `gbp.places.api-key` | project | Google Places API readiness for the listing cross-reference (#648): warns when GBP is connected but no Places key is set, or when no selected location carries a Maps place id; skipped when Places is disabled (`tier: off`) or GBP isn't connected |
| integrations | `gbp.data.recent-sync` | project | A selected GBP location synced in the last 4d (warn) or 30d (fail); warns when never synced. 4d rather than 7d because GBP metrics land daily, so a week of silence is already a long outage |
| integrations | `ga.data.recent-data` | project | Newest stored GA4 daily row is no older than 3d (`ga.data.aging`) or 5d (`ga.data.stale`), both **warn** so a failing auth check keeps the headline. Catches a sync that keeps succeeding with zero rows, for example a GA4 tag removed from the site. Reports `ga.data.not-syncing` instead when no sync has completed recently; skipped when GA4 is not connected |
| integrations | `gsc.data.recent-data` | project | Same for Search Console at 5d and 7d, graded from the monotonic `gsc_data_watermarks` date (which advances even on zero-impression days) against Google's Pacific reporting date; skipped when GSC is not connected |
| integrations | `site.reachability` | project | **Opt-in** (`optIn: true`): runs only when a filter names it, so an unfiltered doctor pass never reaches the network. The project homepage answers below HTTP 500, retried once, trying every approved address. Each hop is resolved and checked against private, reserved and link-local ranges before dialing. A 403 or 429 counts as up; a name that resolves only to refused addresses fails as `site.reachability.refused-address`; this host's own resolver failing is `skipped`, never an outage |
| auth | `ads.auth.connection` | project | OpenAI ads connection row has a matching SDK key in the local config (skipped when not connected) |
| integrations | `ads.data.recent-sync` | project | Connected ad account synced in the last 7d (warn) or 30d (fail); warns when never synced (skipped when not connected) |
| auth | `wordpress.publish.connection` | project | WordPress publishing connection (`integration-wordpress`): the Application Password authenticates and the `wp/v2` REST API responds; skipped when no connection is configured |
| auth | `traffic.source.credentials` | project | Per-source-type credential validation (Cloud Run service-account access token resolves; WordPress and Vercel probe-call their endpoints) |
| auth | `traffic.source.scopes` | project | Per-source-type scope validation (skipped where the adapter has no explicit scope check — e.g. WordPress Application Passwords, Vercel API tokens) |
| integrations | `traffic.source.connected` | project | At least one non-archived server-side traffic source exists for the project |
| integrations | `traffic.source.recent-data` | project | Connected sources have crawler, AI user-fetch, or AI-referral events in the last 7d (warn) or 30d (fail) |
| integrations | `traffic.source.sync-lag` | project | Pull-source watermark health. Skips only Cloudflare `deliveryMode=direct-push` (legacy missing mode is direct push); Queue pull remains checked. |
| integrations | `traffic.source.worker-version` | project | Cloudflare direct/Queue last-observed Worker health. Warns before the first ingested batch and when the most recently ingested version differs from the current generated version. |
| integrations | `backlinks.source.connected` | project | Common Crawl is ready (`autoExtractBacklinks` + a `ready` release sync); warns when it is not set up |
| integrations | `content.winnability.coverage` | project | Discovery classification coverage for cited-surface domains behind the content winnability gate; warns when discovery has not classified the domains that make ownable/ceded decisions meaningful |
| providers | `config.providers` | global | At least one answer-engine provider key configured |
| providers | `config.agent-providers` | global | At least one agent LLM provider (claude / openai / gemini / zai / deepinfra) has a usable key — warns when none do (the built-in Aero agent can't run); skipped on deployments that don't run the agent. Reports `agent-providers.restricted`, with no counts or details, to a caller who is not an install administrator: which provider drives the agent is administrator knowledge, and `GET /doctor` has no administrator gate of its own |
| agent | `agent.skills.installed` | global | Both bundled skills (`canonry`, `aero`) are available through a verified native plugin cache or present under `~/.claude/skills/`; an enabled entry with missing/corrupt assets warns instead of reporting a false success |
| agent | `agent.skills.trigger-surface` | global | The bundled skills' `description` frontmatter, which is their ENTIRE trigger surface: a skill is model-decided, so nothing forces it to load and the description is the only text a request is matched against. Fails on a missing description or one over the 1024-char spec cap; warns when one is too thin to match or never names the CLI binary the operator actually types. Reports total listing cost, which competes for the host's per-session skill budget. Measures the surface, never the outcome. |
| agent | `agent.skills.current` | global | Native plugin manifest versions must match the running Canonry bundle; version mismatches warn. Legacy `~/.claude/skills/` trees are compared file-by-file and warn when new or upstream-updated files have not been picked up (local edits do not count as "behind") |

## Check implementation notes

`src/doctor/checks/*.ts` (individual `CheckDefinition`s):

- `content` covers `content.winnability.coverage`, which measures how many cited-surface domains the shared surface classifier recognizes (own / tracked-competitor / static allow-list / stored discovery `domain_classifications`) so the ownable/ceded gate does not silently fail open, and nudges to set an ICP when the project has none.
- `gbp-auth` covers `gbp.auth.connection` / `gbp.auth.scopes` / `gbp.account.access` (token refresh + `business.manage` scope + the tracked account is listable via `listAccounts`, mapping `GbpApiError` 0-QPM → a `quota-pending` warn) and `gbp.data.recent-sync` (selected-location sync freshness).
- The `traffic-source` checks are adapter-agnostic — they query `traffic_sources` directly for connection/recent-data, and dispatch credential / scope validation through `DoctorContext.trafficSourceValidators[<sourceType>]`.
- v1 registers validators for `cloud-run` (service-account-token resolution), `wordpress` (probe-call against the plugin's REST endpoint), and `vercel` (probe-call against the `request-logs` endpoint — 401/403 maps to `traffic.credentials.unauthorized`), wired from the corresponding credential stores in `index.ts`. Future adapters plug in by adding a key to that map — no doctor-side changes needed.
- Cloudflare sources follow "Cloudflare traffic doctor boundary" above.

## Referral reporting diagnostic

`report.ai-referral-ratio` is a DB-only, silent project check. It follows the report-month selection and calls the same assessment reader as the API/CLI/MCP. It reports `report.ai-referral-ratio.coverage-unknown` with raw server counts, dimension-deduplicated GA counts, an observed quotient and explicit missing/zero states. Current records cannot prove complete server intervals or the GA reporting timezone. A high quotient is not a comparable-window warning or proof of automation. Silent checks never change health paging state.

## Scheduled health alerts

Two schedules feed `health.degraded` and `health.recovered`, which reach every enabled webhook whether or not it subscribes to them:

- `doctor` (every 6h, seeded per project) grades every check and notifies when the worst `(status, code)` changes, **or when the set of failing checks changes** (`doctor_health_state.failing_signature`, sorted `status:code` pairs). The second rule exists because equally severe checks are ranked by id: a breach opening under an alphabetically earlier one left the headline code untouched, so it was graded, listed in the payload's `failing`, and then dropped at the trigger. A row predating that column carries NULL, which reads as unknown rather than changed, so shipping the rule pages nobody on its first pass. `site.reachability` is `optIn`, so it never runs in that pass.
- The website loop (every 10 min, in-process, started with the server) runs only `site.reachability` and keeps its own `site_liveness_state` row. It pages after two failed passes that are genuinely an interval apart, and sends `health.recovered` only for an outage it actually delivered a page for. It never writes `doctor_health_state`, so a quick "site is up" pass cannot clear a GA outage. It is deliberately not a schedule row: an older build would not recognize the kind and would run the row as a paid answer-visibility sweep after a rollback.

## Adding a new check

1. Implement a `CheckDefinition` in `packages/api-routes/src/doctor/checks/<topic>.ts`. Use `@ainyc/canonry-contracts` `CheckStatuses` / `CheckCategories` / `CheckScopes` enums — never raw strings.
2. Register it in `packages/api-routes/src/doctor/registry.ts` (`ALL_CHECKS`).
3. Add a `<topic>.ts` test under `packages/api-routes/test/doctor-*` covering the happy path + each `code` value the check can emit.
4. Both the CLI and MCP tool surface the new check automatically — no additional wiring required.

## Monthly report readiness

`report.sweeps`, `report.models`, and `report.daily-data` are stored-evidence
project checks. They run by default and carry `notificationPolicy: silent`.
The notifier excludes silent checks from health status, signatures and recovery;
a report-only pass must leave existing operational state untouched.

`reportMonth=YYYY-MM` selects a report month (never a future month). Omitted,
checks cover the current UTC month and retain the previous closed month through
day 3. This is read selection, not a work-identity or tuning parameter.

Sweep readiness excludes probes and spot checks. Advanced runs validate their
frozen revision, complete manifest and usable observations. Simple runs use the
frozen input definition when present; legacy runs explicitly report current-basket
coverage as their basis. A failed or empty run cannot clear readiness.
Model checks use the same matched-pair snapshot continuity gate as monthly
comparison, including unknown and mixed models. First observed dates do not
claim to be provider deployment dates.

Daily checks distinguish observed totals (including measured zero), unknown
dates, onboarding dates and pending reporting dates. Both APIs omit zero-data
rows. No current store proves every interior date was queried, so missing rows
never become confirmed collection gaps or synthetic zeros. Search Console uses
Pacific dates. GA timezone is unrecorded and the response labels its UTC fallback.
Both use a conservative three-day reporting lag. Backfill is advice only.
