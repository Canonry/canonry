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
| auth | `gbp.auth.connection` | project | Google Business Profile OAuth credentials present, refresh token works. **skipped** (`gbp.auth.not-connected`) when the domain has no GBP connection and the project selects no location: GBP is optional and the project never used it. With no connection but a selected location (the project used GBP and lost the connection) it keeps the **fail** `gbp.auth.no-connection` |
| auth | `gbp.auth.scopes` | project | Granted scope includes `business.manage` |
| auth | `gbp.account.access` | project | The tracked GBP account is still listable for the authorized user (maps 0-QPM access-form-pending → warn) |
| auth | `gbp.places.api-key` | project | Google Places API readiness for the listing cross-reference (#648): warns when GBP is connected but no Places key is set, or when no selected location carries a Maps place id; skipped when Places is disabled (`tier: off`) or GBP isn't connected |
| integrations | `gbp.reviews.access` | project | Whether negative-review alerts can fire, per selected location, read from what the last sync stored (no Google call). **ok** when v4 reviews work everywhere (a transient v4 error where v4 has worked before still counts). **skipped** when v4 is gated (the normal state) and locations use the Places fallback or have no source. **warn** only when the project subscribes to a review event and some location has no source, since health alerts reach every webhook |
| integrations | `gbp.data.recent-sync` | project | A selected GBP location synced in the last 4d (warn) or 30d (fail); warns when never synced. 4d rather than 7d because GBP metrics land daily, so a week of silence is already a long outage |
| integrations | `ga.data.recent-data` | project | Newest stored GA4 daily row is no older than 3d (`ga.data.aging`) or 5d (`ga.data.stale`), both **warn** so a failing auth check keeps the headline. Catches a sync that keeps succeeding with zero rows, for example a GA4 tag removed from the site. Reports `ga.data.not-syncing` instead when no sync has completed recently; skipped when GA4 is not connected |
| integrations | `gsc.data.recent-data` | project | Same for Search Console at 5d and 7d, graded from the monotonic `gsc_data_watermarks` date (which advances even on zero-impression days) against Google's Pacific reporting date; skipped when GSC is not connected |
| integrations | `site.reachability` | project | **Opt-in** (`optIn: true`): runs only when a filter names it, so an unfiltered doctor pass never reaches the network. The project homepage answers below HTTP 500, retried once, trying every approved address. Each hop is resolved and checked against private, reserved and link-local ranges before dialing. A 403 or 429 counts as up; a name that resolves only to refused addresses fails as `site.reachability.refused-address`; this host's own resolver failing is `skipped`, never an outage |
| integrations | `<integration>.api.reachable` | project | Default provider host probe for GSC, GA, GBP, Google Ads, GTM, Bing and OpenAI Ads. It resolves with `dns.lookup`, refuses all `0.0.0.0/8` null-routed addresses and private addresses without dialing, and completes a certificate-validated TLS handshake without sending application bytes. DNS blocks fail; private, connect and TLS problems warn; a resolver outage skips. The GSC indexing-only host is intentionally excluded because indexing submission is a separate opt-in mutation. Remediation names the exact check and sync command. The checks run in scheduled health passes and are superseded causes for repeated sync failures. |
| integrations | `google-ads.sync.recent-failures`, `gtm.sync.recent-failures`, `gbp.sync.recent-failures`, `ga.sync.recent-failures`, `gsc.sync.recent-failures` | project | Repeated sync failures, read from the integration's run rows (no provider call). **fail** (`<integration>.sync.repeated-failures`) when the newest 3 finished runs (`completed`, `partial`, `failed`; queued, running and cancelled runs are ignored) all failed, with the latest run error, the failure streak since the last success, and the last success time (or `never`); **ok** otherwise; **skipped** when the integration is not connected (so a disconnected integration's old failures stay quiet), when GBP is connected but the project selects no location (`gbp.sync.no-selected-locations`, the state `gbp.data.recent-sync` also skips, where every sync fails by design), or when no run has finished. **skipped** as `<id>.superseded` (original code and status kept in `details`) when one of the integration's auth checks fails in the same pass, so the check that names the fix keeps the health alert's headline instead of the integrations-ranked symptom: `google-ads.auth.connection`, `google-ads.auth.scopes`, `google-ads.account.context`; `gtm.auth.connection`, `gtm.auth.scopes`, `gtm.container.context`; `gbp.auth.connection`, `gbp.auth.scopes`, `gbp.account.access`; `ga.auth.connection`; `google.auth.connection`, `google.auth.property-access`, `google.auth.scopes` (`supersededBy` on the definition, applied by the runner). A cause that threw (`<cause>.runtime-error`) or got no answer from Google (a code ending in `-unreachable`) tested nothing and supersedes nothing: a DNS block that fails every sync fails the auth check's live token refresh too, and the sync's stored error is what names it. GA4 grades only runs created since its current connection (service account first, then OAuth), because its sync writes the run row before resolving credentials and so leaves a failed row on every GA-less project each data refresh; the streak and the last success are both counted from then (`details.gradedSince`), and a connection with no success yet reads `none since connecting at <time>`. GBP leaves out runs that failed with `GBP_NO_SELECTED_LOCATIONS_ERROR` (contracts), matched as the sync stores it, because `gbp_locations` does not record when a location was selected and those runs had nothing to sync. A `partial` run stored data, so it ends a streak. Exists because a queued sync answers its endpoint before any provider call: the scheduled data refresh logs `integration.queued`, and the failure lands only on the run row |
| auth | `bing.auth.connection` | project | Bing Webmaster Tools API key present and able to list sites. **skipped** (`bing.auth.not-connected`) when the domain has no connection and the project never used Bing or the domain's connection was disconnected on purpose; **fail** `bing.auth.no-connection` when the connection is gone but the project still has stored Bing data (see "Check implementation notes") |
| auth | `bing.auth.site-access` | project | The selected Bing site is in the key's site list and verified; skipped when there is no connection |
| auth | `ads.auth.connection` | project | OpenAI ads connection row has a matching SDK key in the local config (skipped when not connected) |
| integrations | `ads.data.recent-sync` | project | Connected ad account synced in the last 7d (warn) or 30d (fail); warns when never synced (skipped when not connected) |
| auth | `wordpress.publish.connection` | project | WordPress publishing connection (`integration-wordpress`): the Application Password authenticates and the `wp/v2` REST API responds, dialed through the egress guard (`createGuardedFetch`, loopback only with `allowLoopbackWebhooks`); skipped when no connection is configured |
| auth | `traffic.source.credentials` | project | Per-source-type credential validation (Cloud Run service-account access token resolves; WordPress and Vercel probe-call their endpoints) |
| auth | `traffic.source.scopes` | project | Per-source-type scope validation (skipped where the adapter has no explicit scope check — e.g. WordPress Application Passwords, Vercel API tokens) |
| schedules | `report.sweeps` | project | **Silent** report advisory: whole-project sweeps of the report month together answered every expected slot (see "Monthly report readiness") |
| providers | `report.models` | project | **Silent** report advisory: each provider kept one known model across the report month and the month before, in every frame the monthly comparison gates on |
| integrations | `report.daily-data` | project | **Silent** report advisory: every mature GA4 and Search Console date of the report month has a stored total or was proven quiet by the latest sync |
| integrations | `traffic.source.connected` | project | At least one non-archived server-side traffic source exists for the project |
| integrations | `traffic.source.recent-data` | project | Connected sources have crawler, AI user-fetch, or AI-referral events in the last 7d (warn) or 30d (fail) |
| integrations | `traffic.source.sync-lag` | project | Pull-source watermark health. Skips only Cloudflare `deliveryMode=direct-push` (legacy missing mode is direct push); Queue pull remains checked. |
| integrations | `traffic.source.worker-version` | project | Cloudflare direct/Queue last-observed Worker health. Warns before the first ingested batch and when the most recently ingested version differs from the current generated version. |
| integrations | `report.ai-referral-bursts` | project | **Silent** report advisory (see "Referral reporting diagnostic"): warns only when stored AI referrals hold threshold-qualified burst groups to review before quoting server-side AI referral totals; skipped when every traffic source is archived |
| integrations | `traffic.source.cache-blindspot` | project | **Silent** standing advisory: warns whenever a WordPress traffic source exists, because the plugin cannot see page views a full-page cache or CDN serves before PHP runs. It can never clear while the source exists, so it does not page; skipped with no WordPress source |
| integrations | `backlinks.source.connected` | project | Common Crawl is set up, graded from stored data: a completed release sync AND a Common Crawl row in `backlink_summaries` for the project (`readCommonCrawlSourceState`, the rule the sources route reports as `connected`). A release is completed when its row is `ready` or has `query_finished_at` set, so re-syncing the only release (which re-queues its row and leaves the stored rows intact) does not warn on every project. Warns `backlinks.source.none` otherwise: with no completed release the remediation names `canonry backlinks sync`; with no summary for the project (one created after the last sync), it names `canonry backlinks extract <project>` only when a release is currently `ready`, and `canonry backlinks sync` otherwise. Historical completion keeps retained data connected but cannot make a new extract run. The project's `autoExtractBacklinks` flag is not consulted: the release sync is workspace-global and writes every project's rows |
| integrations | `content.winnability.coverage` | project | **Silent** standing advisory: discovery classification coverage for cited-surface domains behind the content winnability gate; warns when discovery has not classified the domains that make ownable/ceded decisions meaningful (below 80%). Advice about content targeting, so it does not page |
| providers | `config.providers` | global | At least one answer-engine provider key configured |
| providers | `config.agent-providers` | global | At least one agent LLM provider (claude / openai / gemini / zai / openrouter) has a usable key — warns when none do (the built-in Aero agent can't run); skipped on deployments that don't run the agent. Reports `agent-providers.restricted`, with no counts or details, to a caller who is not an install administrator: which provider drives the agent is administrator knowledge, and `GET /doctor` has no administrator gate of its own |
| agent | `agent.skills.installed` | global | Both bundled skills (`canonry`, `aero`) are available through a verified native plugin cache or present under `~/.claude/skills/`; an enabled entry with missing/corrupt assets warns instead of reporting a false success |
| agent | `agent.skills.trigger-surface` | global | The bundled skills' `description` frontmatter, which is their ENTIRE trigger surface: a skill is model-decided, so nothing forces it to load and the description is the only text a request is matched against. Fails on a missing description or one over the 1024-char spec cap; warns when one is too thin to match or never names the CLI binary the operator actually types. Reports total listing cost, which competes for the host's per-session skill budget. Measures the surface, never the outcome. |
| agent | `agent.skills.current` | global | Native plugin manifest versions must match the running Canonry bundle; version mismatches warn. Legacy `~/.claude/skills/` trees are compared file-by-file and warn when new or upstream-updated files have not been picked up (local edits do not count as "behind") |

## Check implementation notes

`src/doctor/checks/*.ts` (individual `CheckDefinition`s):

- `content` covers `content.winnability.coverage`, which measures how many cited-surface domains the shared surface classifier recognizes (own / tracked-competitor / static allow-list / stored discovery `domain_classifications`) so the ownable/ceded gate does not silently fail open, and nudges to set an ICP when the project has none.
- `gbp-auth` covers `gbp.auth.connection` / `gbp.auth.scopes` / `gbp.account.access` (token refresh + `business.manage` scope + the tracked account is listable via `listAccounts`, mapping `GbpApiError` 0-QPM → a `quota-pending` warn) and `gbp.data.recent-sync` (selected-location sync freshness).
- An optional integration the project does not use is `skipped`, never failed, or every such project is permanently degraded and can never send `health.recovered`. "Lost the connection" still fails, and each check reads its own trace of past use. `gbp.auth.connection`: a selected `gbp_locations` row (disconnecting GBP clears them, so a deliberate disconnect skips), asked before the OAuth client check because an unused integration needs no client. `bing.auth.connection`: stored Bing data (`bing_coverage_snapshots`, `bing_url_inspections`, `bing_keyword_stats`), since the connection itself lives in the config file. Disconnecting Bing keeps that data, so the check also reads the latest `bing.connected` / `bing.disconnected` audit entry and skips when it is a disconnect. It reads that entry by the connection's domain (`entityType: bing_connection`, `entityId`), not by project: projects on one domain share the connection and all store data through it, the audit row names only the project that ran the command, and only the owner may disconnect, so a per-project read failed the others for good. `google.auth.connection` (Search Console) and `ga.auth.connection` are deliberately unchanged: a project with neither connected still fails or warns there.
- A live provider call that got no answer (`isFetchTransportError` from contracts: DNS, connect, reset, TLS, timeout) fails with a code ending in `-unreachable` (`UNREACHABLE_CODE_SUFFIX` in `types.ts`), never the code for a rejection, and names the host through `describeFetchError`: `google.auth.refresh-unreachable`, `google.auth.list-sites-unreachable`, `gbp.auth.refresh-unreachable`, `gbp.account.list-unreachable`, `ga.auth.refresh-unreachable`, `ga.auth.verify-unreachable`. The credential was not tested, so the remediation never says to re-authorize, and the runner never lets such a result supersede a symptom.
- The `traffic-source` checks are adapter-agnostic — they query `traffic_sources` directly for connection/recent-data, and dispatch credential / scope validation through `DoctorContext.trafficSourceValidators[<sourceType>]`.
- Provider API reachability checks live in `checks/api-hosts.ts`. They are TLS probes that send no credentials, use injected lookup/connect seams in tests, and are intentionally default checks so scheduled health can name a DNS block before repeated sync failures accumulate.
- v1 registers validators for `cloud-run` (service-account-token resolution), `wordpress` (probe-call against the plugin's REST endpoint), and `vercel` (probe-call against the `request-logs` endpoint — 401/403 maps to `traffic.credentials.unauthorized`), wired from the corresponding credential stores in `index.ts`. Future adapters plug in by adding a key to that map — no doctor-side changes needed.
- Cloudflare sources follow "Cloudflare traffic doctor boundary" above.

## Referral reporting diagnostic

`report.ai-referral-bursts` is a DB-only, silent project check. It follows the report-month selection and calls the same assessment reader as the API/CLI/MCP. It skips (`report.ai-referral-bursts.not-configured`) when the project has no non-archived traffic source, the rule `traffic.source.connected` and traffic analytics use. Per month, its details carry the `suspected` burst hits, `candidateGroups` (threshold-qualified source × product × normalized path × UTC hour groups, not hours), the rule, and the comparison: the countable server total (`serverCountable`, not raw hits), dimension-deduplicated GA sessions, an observed quotient rounded to 2 decimals, and explicit missing/observed-zero states. GA is observed-zero only for a window inside the latest GA sync window that holds no AI row from an earlier sync (`latestGaSyncQueriedWindow` in `src/referral-assessment.ts`). Current records cannot prove complete server intervals or the GA reporting timezone, so unproven coverage is never the signal: it warns (`report.ai-referral-bursts.bursts`) only when a report month has threshold-qualified bursts to review, and otherwise passes (`report.ai-referral-bursts.no-bursts`). A high quotient is not a comparable-window warning or proof of automation. Silent checks never change health paging state.

## Scheduled health alerts

Two schedules feed `health.degraded` and `health.recovered`, which reach every enabled webhook whether or not it subscribes to them:

- `doctor` (every 6h, seeded per project) grades every pageable check and sends `health.degraded` only when something is **new or worse** (`Notifier.onHealthChecked`): the first pass is already not ok, a healthy project stops being healthy, the worst status rises, or a check starts failing, gets more severe, or reports a different code at the same severity. The whole set is read, not only the headline, because equally severe checks are ranked by id: a breach opening under an alphabetically earlier one leaves the headline code untouched. A pass that only loses checks, eases one from fail to warn, or changes the headline because the old one cleared sends nothing while the project is still not ok; it is stored (every pass is) and logged as `health.improved` with the cleared and eased codes. That rule exists because the trigger used to fire on any change to the set, so one transient blip sent two "degraded" alerts, each re-listing the standing items. `health.recovered` is sent when every check passes again. `site.reachability` is `optIn`, so it never runs in that pass.
- Checks are compared by **check id**, not by code. Every check changes its code when its severity changes (`traffic.source.all-errored` fail, `traffic.source.partially-errored` warn), so by code an easing check reads as one entry cleared and another gained, and paged. `doctor_health_state.failing_checks` stores the last pass as `status:code:id` entries. `failing_signature` (sorted `status:code` pairs) is still written in its old form, because a rolled-back release compares it as a string and would page every degraded project if the format changed. That release leaves `failing_checks` behind, so the ids are trusted only while they still spell the signature and headline beside them; otherwise the row is compared by code for one pass (also the first pass after upgrading), and a row predating the signature column (NULL) notifies for that pass only on a new headline or a worse status.
- A `health.degraded` alert that no webhook accepted is sent again on the next pass. `doctor_health_state.pending_signature` stores its triggering breaches as `status:code:id`, separately from the last DELIVERED set (`notified_signature`), since a check can clear quietly and recur with a code that set already knows. Pending triggers are recorded with the observation before the send, survive restarts and the first pass after upgrading, and remain owed while the same check still fails at the attempted severity or worse. Cleared, eased and superseded triggers stop retrying; any accepted alert clears the pending set. A legacy row with an unknown earlier set owes only the changed or worse headline. An older writer's changed signature/headline invalidates pending ids too. With no webhook to try no pending delivery is recorded, so an install without webhooks does not retry on every pass. `health.recovered` is not retried.
- The payload says what changed: optional `health.added` (codes of the checks that are new or worse) and `health.cleared` (codes of the checks failing at the last delivered alert, or on the pass before, and not failing now, so a check that cleared on a quiet pass is reported by the next delivered alert). A check that still fails under another code has not cleared, and neither has a symptom the runner set aside under its failing cause (`<id>.superseded`, read from `details.supersededCode`): it is hidden, not fixed. A pass where no check could be graded reports no `cleared` at all. Chat destinations render them as `New (n)` and `Cleared (n)` ahead of `Also failing`, which then lists only the standing checks. Both are absent on website liveness alerts and when the earlier set is unknown. The `health.notified` log line carries the headline code plus `added` and `cleared`.
- The website loop (every 10 min, in-process, started with the server) runs only `site.reachability` and keeps its own `site_liveness_state` row. It pages after two failed passes that are genuinely an interval apart, and sends `health.recovered` only for an outage it actually delivered a page for. It never writes `doctor_health_state`, so a quick "site is up" pass cannot clear a GA outage. It is deliberately not a schedule row: an older build would not recognize the kind and would run the row as a paid answer-visibility sweep after a rollback.

### Urgent problems

`health.urgent` and `health.urgent-resolved` exist so one webhook can carry only what needs a person now, for a channel people watch. The rules:

- A check marks an **output** `urgent: true`, not itself: `ga.data.aging` is a warning, the same check at `ga.data.stale` is urgent. The runner copies the flag onto the result and keeps it on a result it sets aside under a failing cause. Today: `site.reachability.down` and `.refused-address`; `ga.data.stale` and `gsc.data.stale`; `ga.data.not-syncing` and `gsc.data.not-syncing` once the data is stale and nothing has synced for `NOT_SYNCING_URGENT_DAYS` (a weekly schedule is not an emergency); `<integration>.sync.repeated-failures`. Other stale codes (`gbp.data.stale`, `ads.data.stale`, `traffic.recent-data.stale`) are not urgent. Mark an output urgent only when someone should stop what they are doing; a routine warning marked urgent spends the one signal that channel has.
- Routing (`receivesHealthEvent` in `notifier.ts`): an urgent event goes only to webhooks that list it. A webhook that lists either urgent event receives the health events it lists and no others, which is the one exception to "health events reach every enabled webhook".
- The urgent set on a pass is the failing urgent checks plus any urgent symptom set aside under its failing cause (`<id>.superseded`). The second kind is how a sync usually stops (a revoked grant fails the auth check, which supersedes the sync), so it is reported under the symptom's code with the cause's summary and remediation.
- Delivery histories live in `doctor_health_state.urgent_receipts` (migration 183), keyed by notification id and bound to its URL; each records outstanding `status:code:id` entries. Added or replaced destinations start without a receipt, hear about currently open problems, and inherit no resolution. Removed or disabled destinations are pruned. `urgent_notified` remains the aggregate summary for older readers. Historical aggregate receipts without recipient identity establish no delivery history: the next pass catches up open problems once and sends no speculative resolution. An aggregate changed by an older writer invalidates recipient histories too.
- A told problem is not news again. It clears only when its check reached a verdict on a pass (`ok`, `warn` or `fail`, not `<id>.runtime-error`) and is no longer urgent. A check that was skipped, left out or threw says nothing.
- `health.urgent-resolved` is sent when at least one told problem cleared and none is known to be open (still urgent, or set aside under its cause). A told check that can no longer be graded (its integration was disconnected) does not hold the resolution back.
- Receivers with identical histories share one delivery decision: any accepted delivery settles that group's record, preserving the fanout policy. A newcomer with a different history has independent catchup and retries. Records are persisted before sending. A message nobody lists (a webhook that lists only `health.urgent` has no one for the resolved message) is owed to no one and takes effect at once. A quiet pass drops what cleared, so its return is news, and refreshes the code of what stands.
- The website loop keeps recipient outage timestamps in `site_liveness_state.urgent_receipts`; `urgent_notified_at` summarizes outstanding receipts, apart from `notified_at`. Recovery debt survives an ok pass until accepted. One message per webhook: a scoped webhook receives the general event instead only when that event is actually sent to it. Its accepted general delivery can settle its urgent group; a refused general delivery leaves the urgent retry owed.
- The two loops report separately. A resolved message is about the problems that loop reported, not a statement that nothing else is wrong.

Branch-by-branch cases: `packages/canonry/test/urgent-health-notifications.test.ts`.

## Adding a new check

1. Implement a `CheckDefinition` in `packages/api-routes/src/doctor/checks/<topic>.ts`. Use `@ainyc/canonry-contracts` `CheckStatuses` / `CheckCategories` / `CheckScopes` enums — never raw strings.
   A check that reports a symptom of another check's failure (a sync failing because its credential is revoked) lists that check's id in `supersededBy`, so the cause leads the health alert. A cause check whose provider call got no answer reports a code ending in `-unreachable`, so it never hides the symptom's evidence.
2. Register it in `packages/api-routes/src/doctor/registry.ts` (`ALL_CHECKS`).
3. Add a `<topic>.ts` test under `packages/api-routes/test/doctor-*` covering the happy path + each `code` value the check can emit.
4. Both the CLI and MCP tool surface the new check automatically — no additional wiring required.

## Monthly report readiness

`report.sweeps`, `report.models`, `report.daily-data`, and
`report.ai-referral-bursts` are stored-evidence project checks. They run by
default and carry `notificationPolicy: silent`.
The notifier excludes silent checks from health status, signatures and recovery;
a report-only pass must leave existing operational state untouched. The
scheduled health pass requests only `scheduledHealthCheckIds()` (non-silent,
non-opt-in), so it never pays for advisories the notifier would discard. A
silent check that throws reports `warn`, never `fail`: an advisory cannot fail
`canonry doctor`.

Two standing advisories carry the same policy for a different reason:
`content.winnability.coverage` and `traffic.source.cache-blindspot`. Neither
reports a broken instrument, and each stays non-ok for as long as its condition
holds (the cache note for as long as a WordPress source exists), so as health
checks they kept every affected project permanently degraded and
`health.recovered` could never be sent. They still appear in `canonry doctor`.
Give a new check this policy when its warning is advice that cannot clear
through an operator fixing the instrument.

`reportMonth=YYYY-MM` selects a report month (never a future month). Omitted,
checks cover the current UTC month and retain the previous closed month through
day 3. This is read selection, not a work-identity or tuning parameter. While
both months are shown (days 1-3), only the closed month decides a check's
status (`gradedReportMonths`); the new month is listed with `graded: false`.

Sweep readiness excludes probes and spot checks: a plan run with a
`measurementScope`, and a Simple run with a `queries` subset (the same rule as
`newerFullSweep`). Plan runs (schema v1 or v2)
validate their manifest against the frozen revision and match usable answers by
execution slot (`measurementSlotKey`); an answer with no execution id makes the
run unusable. Simple runs use the frozen input definition when present; legacy
runs explicitly report current-basket coverage as their basis (an empty project
provider list means every configured provider, which only the runner knows, so
such a run is held to the providers it answered on). A month is ready when its
sweeps with the same expected slots together answer every slot, as the monthly
comparison pools a month; a failed or empty run cannot clear readiness. Only
the widest expectations decide: a group whose slots are a strict subset of
another group's (a `canonry run --provider` run) cannot clear the month. Runs
do not record a provider override, so a month whose only runs used one reads
as that narrower set.
Model checks read `readVisibilityContinuity`: the same matched-pair continuity
gates as monthly comparison, including unknown and mixed models, without
matching answer text. Every project gets the project frame, which gates the
compare's four project metrics; an Advanced project whose two months are frozen
schema-v2 history also gets the class frame, which gates the class rates. A
schema-v1 plan has no class frame (its class rates are unavailable), so it
never warns for lack of one. First observed dates do not claim to be provider
deployment dates.

Daily checks distinguish observed totals (including measured zero), dates the
latest sync queried that returned no row, unknown dates, onboarding dates and
pending reporting dates. Both APIs omit zero-data rows, and each sync replaces
its whole requested range, so an absent date inside the latest sync's range
(`latestSyncRange`: the GA summary window, or the Search Console rows' span up
to the watermark's requested ceiling when both came from that sync) is zero
activity, but only up to the reporting lag before that sync ran
(`zeroProvenThrough`): a sync asks through its own day, and the source had not
published its last few days yet. Earlier syncs' ranges are not recorded: absent
dates outside the proven range stay unknown, never confirmed gaps or synthetic
zeros. Search Console uses Pacific dates. GA timezone is unrecorded and the
response labels its UTC fallback. Both use a conservative three-day reporting
lag. The scheduled GA refresh reaches back to the first day of the closed month
through day 3 (`gaRefreshDays`), so the report month sits inside the latest GA
sync. Backfill is advice only.
