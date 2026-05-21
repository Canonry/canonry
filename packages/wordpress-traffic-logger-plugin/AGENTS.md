# wordpress-traffic-logger-plugin

## Purpose

PHP WordPress plugin that ships the **producer side** of canonry's WordPress
traffic-ingestion path. It captures every non-admin, non-AJAX GET page-load
on a WP site, records the real client IP, and exposes the resulting event
log through a Basic-auth (Application Password) REST endpoint that the
`@ainyc/canonry-integration-wordpress-traffic` TS adapter pulls. Non-GET
requests (comment submissions, logins, admin saves) are skipped — AI
crawlers and human clicks from AI referrers are always GET, and the
server-side classifier in `packages/integration-traffic/` is GET-shaped.

This package is intentionally **agent-installable**: the operator drops the
single `plugin/canonry-traffic-logger.php` file (plus its `includes/` siblings)
into `wp-content/plugins/canonry-traffic-logger/` and activates it from
`wp-admin`. No build step, no composer, no PHP framework dependency beyond WP
itself.

The companion TS adapter is in `packages/integration-wordpress-traffic/` and
defines the wire contract this plugin satisfies (`WordpressTrafficEventPayload`,
`WordpressTrafficEventsResponseBody`).

## Layout

```
plugin/
  canonry-traffic-logger.php    Main plugin file: WP header, hook wiring
  includes/
    class-plugin.php            Activation + uninstall + retention prune callback
    class-recorder.php          Request -> row writer (shutdown hook entry point)
    class-rest.php              GET /wp-json/canonry/v1/events handler + cursor pagination + since/until
    class-client-ip.php         Pure client-IP resolver (proxy-header aware)
    class-settings-page.php     Settings → Canonry Traffic Logger admin form
test/
  run-tests.php                 Discovers *Test.php, runs every public test_* method
  lib/TestCase.php              Minimal assertion API (no PHPUnit dependency)
  lib/WpShim.php                In-memory stub of the WP API surface the plugin touches
  *Test.php                     Test cases (Activation, Ingestion, ClientIp, EndpointAuth, CursorPagination, WindowFilter, Uninstall, Retention, SettingsPage)
```

## Auth

- The REST endpoint requires the authenticated user to have the
  `manage_options` capability. Traffic-log access is admin-equivalent: paths,
  UAs, referrers, and client IPs together effectively de-anonymize visitors
  to the operator who holds them. Granting Editor/Author access would let
  someone whose role is "publish posts" read everyone else's visit log.
- Authentication happens via the standard WP Application Password flow
  (Basic auth). The plugin does **not** implement its own auth — it leans on
  `wp_authenticate_application_password` so the operator manages keys from
  `wp-admin → Users → Profile → Application Passwords` and revokes them
  there too.

## Client IP

The plugin records the **real client IP** (`remote_ip`, IPv4 or IPv6) on
every event. The canonry server needs it to verify bot claims against
published operator IP ranges, the same as the Cloud Run and Vercel traffic
loggers. `ClientIp::resolve()` is a pure function (`class-client-ip.php`):

- **Default:** the IP is `REMOTE_ADDR`, the address the web server saw
  directly.
- **Behind a proxy/CDN:** when the operator enables the "behind a trusted
  proxy" setting, `ClientIp::resolve()` consults the forwarded headers a CDN
  sets, in order: `CF-Connecting-IP`, `True-Client-IP`, `X-Real-IP`, then
  `X-Forwarded-For`. `X-Forwarded-For` is read right-to-left so a visitor
  cannot win by prepending a forged entry.
- The toggle is off by default. Forwarded headers are visitor-settable, so
  trusting them on a non-proxied site would let a visitor forge their IP
  (and forge a "verified" bot hit). Operators turn it on only when the site
  genuinely sits behind a CDN.

Plugin 0.3.0 replaced the previous per-site SHA-256 IP hash. Schema 2 drops
the legacy `remote_ip_hash` column on activation, and the old
`canonry_traffic_logger_ip_salt` option is deleted on uninstall.

## What's in scope (wave 2 shipped)

- **Retention auto-prune.** WP-Cron event `canonry_traffic_logger_prune` runs
  daily, deleting events older than `canonry_traffic_logger_retention_days`
  (default 90, clamped to 7–365). Scheduled at activation, cleared at
  uninstall.
- **Settings page.** `Settings → Canonry Traffic Logger` renders the
  retention input, the trusted-proxy toggle, the current event count, and
  the oldest event timestamp. Capability gate: `manage_options`.
- **Window filter on the REST endpoint.** `GET /wp-json/canonry/v1/events`
  accepts optional `since` / `until` ISO 8601 query params and filters
  events to the half-open window `[since, until)`. Powers the TS backfill
  route's historical pulls.

## What's out of scope (deferred)

- "Test endpoint" admin button. The operator can curl the REST endpoint
  with a WP Application Password.
- Multisite-aware activation (works in single-site mode only; multisite
  ships in a future slice — table-per-site vs shared with `blog_id`).

## Testing

```
php test/run-tests.php
```

No composer, no PHPUnit. The harness is ~600 LOC of plain PHP that stubs
just the WP API surface the plugin uses. Adding a test = drop a `*Test.php`
file with a class extending `Canonry\TrafficLogger\Test\TestCase`; every
public method starting with `test_` runs. `wpshim_reset()` clears WP globals
between tests.

Why not PHPUnit? The canonry monorepo has no PHP toolchain (no composer, no
PHP container). Vendoring PHPUnit added > 30 min of setup with no marginal
value over a 100-line harness for the assertions the plugin needs.

Test files cover:

- **ActivationTest** — the events table and the schema-version option are
  created; re-activation updates the recorded schema version.
- **IngestionTest** — non-admin / non-AJAX page-loads write one row matching
  the TS `WordpressTrafficEventPayload` shape.
- **ClientIpTest** — `ClientIp::resolve()` uses `REMOTE_ADDR` when untrusted,
  CDN headers when trusted, and reads `X-Forwarded-For` right-to-left.
- **EndpointAuthTest** — 401 without `manage_options`; 200 with; response
  shape matches `WordpressTrafficEventsResponseBody`.
- **CursorPaginationTest** — three-page walk in `(observed_at, id)` order;
  invalid cursor → 400.
- **WindowFilterTest** — optional `since`/`until` ISO 8601 query params
  filter events to the half-open window `[since, until)`; cursor pagination
  still walks inside the window; invalid timestamps → 400. Used by the TS
  backfill route to scope historical pulls.
- **UninstallTest** — table dropped + options deleted; scheduled prune cleared.
- **RetentionTest** — daily cron scheduled at activation, cleared at
  uninstall; `pruneExpired()` deletes rows older than the configured
  window; clamps to 7..365; default 90 when unset.
- **SettingsPageTest** — admin options page registered under Settings;
  retention and trusted-proxy settings registered with their sanitizers;
  render requires `manage_options` and shows current retention, the
  trusted-proxy checkbox, event count, and oldest event.

## See also

- `packages/integration-wordpress-traffic/` — TS pull adapter that consumes
  this plugin's `/wp-json/canonry/v1/events` endpoint.
- `packages/integration-wordpress/` — separate content-publishing plugin
  client; shares only the Application-Password auth pattern.
- `plans/server-side-ai-traffic-ingestion.md` — overall traffic plan.
