# wordpress-traffic-logger-plugin

## Purpose

PHP WordPress plugin that ships the **producer side** of canonry's WordPress
traffic-ingestion path. It captures every non-admin, non-AJAX GET page-load
on a WP site, hashes the client IP per-site, and exposes the resulting event
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
    class-plugin.php            Activation + uninstall (table, salt, schema-version option)
    class-recorder.php          Request -> row writer (shutdown hook entry point)
    class-rest.php              GET /wp-json/canonry/v1/events handler + cursor pagination
    class-ip-hasher.php         Pure sha256-prefix hashing utility
test/
  run-tests.php                 Discovers *Test.php, runs every public test_* method
  lib/TestCase.php              Minimal assertion API (no PHPUnit dependency)
  lib/WpShim.php                In-memory stub of the WP API surface the plugin touches
  *Test.php                     Test cases (Activation, Ingestion, IpHash, EndpointAuth, CursorPagination, Uninstall)
```

## Auth

- The REST endpoint requires the authenticated user to have the
  `manage_options` capability. Traffic-log access is admin-equivalent: paths,
  UAs, referrers, and hashed IPs together effectively de-anonymize visitors
  to the operator who holds them. Granting Editor/Author access would let
  someone whose role is "publish posts" read everyone else's visit log.
- Authentication happens via the standard WP Application Password flow
  (Basic auth). The plugin does **not** implement its own auth — it leans on
  `wp_authenticate_application_password` so the operator manages keys from
  `wp-admin → Users → Profile → Application Passwords` and revokes them
  there too.

## IP hashing

`hash('sha256', $ip . $salt)`, first 12 hex chars. The salt is generated
once at activation via `wp_generate_password(64, true)` and stored in the
`canonry_traffic_logger_ip_salt` WP option. The plugin never sees raw IPs
again after the request hook returns.

- Same IP + same salt produces the same 12-char hash (so unique-visitor
  counts work inside a single salt window).
- Different salts diverge, so re-installing the plugin produces a brand-new
  hash space (intentional — re-installation is a privacy boundary).
- 48 bits of hash space (12 hex chars) make brute-forcing infeasible without
  the salt while keeping collisions inside a single rolling window negligible
  for any plausible visitor volume.

## What's out of scope (wave 2)

The following are deliberately deferred:

- Settings page / admin UI (no UI; everything is hook-driven).
- Retention / auto-prune of old events (server keeps everything; operator
  drops the table or uses MySQL TTL).
- Salt rotation UI.
- "Test endpoint" admin button.
- Multisite-aware activation (works in single-site mode only; multisite ships
  in wave 2).

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

- **ActivationTest** — table + salt + schema-version options created; salt
  not overwritten on re-activation.
- **IngestionTest** — non-admin / non-AJAX page-loads write one row matching
  the TS `WordpressTrafficEventPayload` shape.
- **IpHashTest** — deterministic per-salt, 12-hex, sha256 prefix.
- **EndpointAuthTest** — 401 without `manage_options`; 200 with; response
  shape matches `WordpressTrafficEventsResponseBody`.
- **CursorPaginationTest** — three-page walk in `(observed_at, id)` order;
  invalid cursor → 400.
- **WindowFilterTest** — optional `since`/`until` ISO 8601 query params
  filter events to the half-open window `[since, until)`; cursor pagination
  still walks inside the window; invalid timestamps → 400. Used by the TS
  backfill route to scope historical pulls.
- **UninstallTest** — table dropped + options deleted.

## See also

- `packages/integration-wordpress-traffic/` — TS pull adapter that consumes
  this plugin's `/wp-json/canonry/v1/events` endpoint.
- `packages/integration-wordpress/` — separate content-publishing plugin
  client; shares only the Application-Password auth pattern.
- `plans/server-side-ai-traffic-ingestion.md` — overall traffic plan.
