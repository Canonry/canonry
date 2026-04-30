# Server-Side AI Traffic & Crawler Ingestion Plan

Status: design plan for implementation after GA known-AI landing page work
Last updated: 2026-04-30

## Context

Canonry already has two AI discovery signals:

- Answer visibility sweeps show whether AI answer engines cite or mention a project domain.
- GA4 attribution shows explicit known-AI human referrals when GA exposes a matching source, medium, or UTM signal.

GA4 cannot recover crawler activity or referrer-stripped AI clicks. GA4 also automatically excludes known bot traffic before reporting and does not expose how much was excluded. Server-side ingestion is therefore a separate product layer: it captures request evidence before browser JavaScript, GA attribution, or GA bot filtering shape the data.

## Goals

1. Show AI crawler activity by bot, verification confidence, path, status, and time window.
2. Show server-observed human AI referrals when request evidence exists (`Referer`, UTM, or similar explicit marker).
3. Correlate crawler activity, answer-engine citations, GA known-AI referrals, GA Direct traffic, and server-observed referrals without overstating causality.
4. Keep Canonry local-first and pull-based. No Canonry-hosted endpoint may sit in the hot data path.
5. Make the first adapters useful for both non-technical WordPress users and developer-hosted Cloud Run users.

## Non-Goals

- No JavaScript pixel for crawler detection. Crawlers do not execute it, and GA already covers the browser-tag lower-bound click signal.
- No Canonry SaaS relay.
- No crawler blocking, paywalling, or robots policy enforcement.
- No deterministic claim that a referrer-stripped Direct session came from an AI surface.
- No Vercel adapter until the user-owned log destination story is resolved; Vercel drains are push-oriented.

## Canonry Boundaries

The implementation must preserve the platform rules in `AGENTS.md`:

- API and CLI first.
- Dashboard consumes API data only.
- MCP tools are adapters over public API client methods.
- Aero receives tools through the MCP-to-agent adapter once the MCP registry is updated.
- Credentials and adapter secrets live in `~/.canonry/config.yaml`, not the project database.
- Any new DB table or column in `schema.ts` has a matching migration in `migrate.ts`.

## Data Model

Store rollups as the durable reporting source and keep raw samples only for inspection and classifier debugging.

### `traffic_sources`

Connection/status metadata for each pull source.

Fields:

- `id`
- `project_id`
- `source_type`: `wordpress` | `cloud-run`
- `display_name`
- `status`: `connected` | `error` | `paused`
- `last_synced_at`
- `last_cursor`
- `last_error`
- `created_at`
- `updated_at`

No credentials in this table.

### `crawler_events_hourly`

Hourly rollups for server-observed crawler requests.

Fields:

- `project_id`
- `source_id`
- `ts_hour`
- `bot_id`
- `operator`
- `verification_status`: `verified` | `claimed_unverified` | `unknown_ai_like`
- `path_normalized`
- `status`
- `hits`
- `sampled_user_agent`
- `created_at`
- `updated_at`

Suggested unique key:

`project_id, source_id, ts_hour, bot_id, verification_status, path_normalized, status`

### `ai_referral_events_hourly`

Hourly rollups for server-observed human visits with explicit AI-origin evidence.

Fields:

- `project_id`
- `source_id`
- `ts_hour`
- `product`
- `operator`
- `source_domain`
- `evidence_type`: `referer` | `utm` | `other`
- `landing_path_normalized`
- `sessions_or_hits`
- `users_estimated` nullable
- `created_at`
- `updated_at`

This is not a GA replacement. It is raw request-level evidence that can be compared with GA known-AI rows and GA Direct buckets.

### `raw_event_samples`

Short-retention samples for debugging.

Fields:

- `project_id`
- `source_id`
- `ts`
- `event_type`: `crawler` | `ai_referral` | `unknown`
- `ip_hash` or truncated IP, not full IP by default
- `user_agent`
- `path_normalized`
- `status`
- `referer_host`
- `classifier_details_json`
- `created_at`

Retention target: 30 days by default.

## Classifier

Use a bundled manifest with optional refresh from a public repository.

Classifier tiers:

1. User-agent pattern match creates a candidate bot.
2. IP/rDNS verification promotes the event to `verified` where the provider publishes usable ranges or host suffixes.
3. UA-only or unverifiable matches remain `claimed_unverified`.
4. Behavioral heuristics can flag `unknown_ai_like`, but these must be clearly labeled as heuristic.

Manifest fields:

- `id`
- `operator`
- `product`
- `purpose`
- `user_agent_patterns`
- `ip_sources`
- `rdns_suffixes`
- `verification_methods`
- `docs_url`
- `last_reviewed`

The manifest must not assume every crawler has authoritative IP ranges. Some providers support verification; some only expose UA guidance.

## Pull Adapters

### Phase 1 Adapter: WordPress

Purpose: support Hostinger/shared WordPress and other users without server config access.

Components:

- A small WordPress plugin.
- A Canonry puller that reads the plugin endpoint.
- Config stored under `~/.canonry/config.yaml`.

Plugin behavior:

- Runs server-side in the WordPress request lifecycle.
- Records candidate AI crawler hits and explicit AI referral hits.
- Avoids front-end JavaScript injection.
- Stores events or pre-rollups in plugin-owned tables.
- Exposes a cursor-paginated REST endpoint under `/wp-json/canonry/v1/events` or `/rollups`.
- Uses `Authorization` header or signed request auth, not query-string tokens.
- Has bounded retention and cleanup via WP-Cron.
- Hashes or truncates IPs by default.

Canonry CLI/API:

- `canonry traffic connect wordpress <project> --url <url> --token-env <env>`
- `canonry traffic sync <project> --source wordpress`
- `canonry traffic status <project>`

Security review requirements:

- Token validation.
- Rate limiting or cheap cursor reads.
- No public unauthenticated event dump.
- No collection of cookies or request bodies.
- Explicit retention behavior.

### Phase 1 Adapter: Cloud Run / Cloud Logging

Purpose: support developer-hosted apps with no app code changes.

Inputs:

- Cloud project id.
- Log resource filters.
- Service name or labels where available.
- Time cursor.

Pulled fields:

- timestamp
- request URL/path
- status
- user agent
- remote IP
- referer
- request method
- resource labels

Canonry CLI/API:

- `canonry traffic connect cloud-run <project> --gcp-project <id> --service <service>`
- `canonry traffic sync <project> --source cloud-run`
- `canonry traffic status <project>`

Operational requirements:

- Support dry-run filter preview.
- Store cursors so repeated syncs are incremental.
- Prefer narrow Cloud Logging filters when possible, but allow full request pulls for verification/testing.
- Keep IAM instructions explicit in docs.

## Public Surfaces

### API

- `GET /api/v1/projects/:name/traffic/status`
- `POST /api/v1/projects/:name/traffic/sync`
- `GET /api/v1/projects/:name/traffic/crawlers?window=7d`
- `GET /api/v1/projects/:name/traffic/referrals?window=7d`
- `GET /api/v1/projects/:name/traffic/timeline?window=30d`
- `GET /api/v1/projects/:name/traffic/sources`

### CLI

- `canonry traffic status <project> --format json`
- `canonry traffic sync <project> --source wordpress|cloud-run --format json`
- `canonry traffic crawlers <project> --window 7d --format json`
- `canonry traffic referrals <project> --window 7d --format json`
- `canonry traffic timeline <project> --window 30d --format json`
- `canonry traffic sources <project> --format json`

### MCP and Aero

Add read tools to the MCP registry after the API and CLI exist. The current Aero implementation adapts MCP registry tools automatically, so no second Aero-specific registration should be needed unless a tool belongs in the Aero exclusion set.

### Dashboard

Add an AI Traffic section that consumes only API data:

- Crawler activity table.
- Verified vs claimed-unverified split.
- Top crawled paths.
- Server-observed AI referrals.
- Timeline comparing crawls, citation visibility, GA known-AI referrals, and Direct traffic.

## Insight Rules

The intelligence layer should use evidence-weighted phrasing:

- "GPTBot crawled `/pricing` 34 times before the next observed citation gain."
- "`/guide` is cited but has no detectable AI referral clicks."
- "`/blog/foo` has crawler activity but no current citation visibility."
- "Direct traffic rose on a cited page; source is unknown because no referrer or UTM survived."

Avoid deterministic attribution unless the request evidence is explicit.

## Testing Strategy

Unit tests:

- Manifest parser.
- UA matching.
- IP/rDNS verification status.
- Path normalization.
- Rollup aggregation.

API tests:

- Sync cursor behavior.
- Idempotent repeated sync.
- Window filtering.
- Verified vs unverified crawler breakdown.
- No credentials in response payloads.

CLI tests:

- `--format json` for every command.
- User-error exit semantics for missing connections and invalid source names.

Adapter tests:

- WordPress fixture endpoint with pagination and auth failures.
- Cloud Logging fixture responses with timestamp cursors and duplicate event prevention.

UI tests:

- Empty state.
- Verified/unverified labeling.
- Timeline with no overclaiming language.

## Rollout Order

1. Traffic contracts and DB schema.
2. Manifest parser and classifier.
3. API/CLI read surfaces over seeded data.
4. WordPress plugin and puller.
5. Cloud Run / Cloud Logging puller.
6. MCP registry entries.
7. Dashboard section.
8. Intelligence correlations.

The key product line: GA remains the lower-bound click signal; server-side ingestion adds crawler visibility and raw request-level AI referral evidence.
