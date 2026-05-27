# Server-side traffic (AI Visibility — Server-Side)

Server-side traffic ingestion captures **what AI engines actually do in
your server logs** — bots crawling pages, AI products sending
click-through arrivals — in addition to the citation data that measures
**what models say** about you. The two surfaces are independent.

## When to use it

Reach for server-side traffic when an analyst or operator asks:

- *"Is GPTBot / ClaudeBot / PerplexityBot actually fetching my pages?"*
- *"Which paths are AI engines paying attention to?"*
- *"Are users clicking through from chatgpt.com / claude.ai / etc.?"*
- *"My citation rate is fine but there's no traffic — why?"*

GA4 referrals (chatgpt.com → your site) catch click-throughs after they
land. Server logs catch the upstream bot activity AND referrals at the
edge — including arrivals GA4 missed because of cookie consent, ad
blockers, or analytics gaps.

## Architecture

Two tables, populated from server-log adapters:

| Table | What's in it |
|---|---|
| `crawler_events_hourly` | One row per `(project, source, hour, bot, verification, path, status)` — bot crawls rolled up by hour |
| `ai_referral_events_hourly` | One row per `(project, source, hour, product, source_domain, evidence_type, landing_path, status)` — click-through arrivals rolled up by hour |
| `raw_event_samples` | Bounded forensic samples (≤100 per sync) for spot-checking |

Each `traffic_sources` row is one server-log integration for a project.
Adapters today:

| Adapter | Source | Best for |
|---|---|---|
| `cloud-run` | GCP Cloud Run request logs via Logging API | Any service running on Cloud Run |
| `wordpress` | The Canonry Traffic Logger WP plugin's REST endpoint | WordPress sites where you control wp-admin |
| `vercel` | Vercel project logs via the Vercel API | Sites deployed on Vercel (Next.js, SvelteKit, etc.) |

Future adapters slot in by implementing the same contract.

## Connecting a Cloud Run source

```bash
# 1. Create a service account in the Cloud project that hosts the Cloud Run
#    service. Grant it `roles/logging.viewer`. Download the JSON key.

# 2. Connect from cnry CLI:
cnry traffic connect cloud-run <project> \
  --gcp-project <gcp-project-id> \
  --service-account-key <path/to/key.json>

# 3. (Optional) narrow to a specific service or location:
cnry traffic connect cloud-run <project> \
  --gcp-project <id> \
  --service-account-key <path> \
  --service my-service-name \
  --location us-east1
```

Credentials are stored in `~/.canonry/config.yaml` (not the DB). The
canonical key lives only on the host that runs `cnry serve`. The
sync flow does NOT echo the private key back in any response.

## Connecting a WordPress source

The WordPress adapter pulls events from the **Canonry Traffic Logger**
WordPress plugin, which captures every non-admin GET page-load and
exposes a paginated REST endpoint protected by an Application Password.

```bash
# 1. Install the plugin. Download the latest release zip from the
#    canonry-traffic-logger plugin's GitHub release (the repo CI workflow
#    publishes a zip on every plugin-file change), then in wp-admin:
#    Plugins → Add New → Upload Plugin → upload + activate.

# 2. In wp-admin, create an Application Password for the operator user:
#    Users → Profile → Application Passwords. Copy the generated password.

# 3. (Optional) Adjust settings at Settings → Canonry Traffic Logger:
#    - Retention window: clamps to 7-365 days, default 90.
#    - "Behind a proxy or CDN": enable this when the site sits behind
#      Cloudflare or another reverse proxy, so the real visitor IP
#      (needed to verify AI-bot hits) is read from forwarded headers
#      rather than the proxy's edge address.
#    The page also shows the current event count and oldest event.

# 4. Connect from cnry CLI:
cnry traffic connect wordpress <project> \
  --url https://example.com \
  --username admin \
  --app-password "xxxx xxxx xxxx xxxx xxxx xxxx"
```

What the events table looks like (mirrors the TS
`WordpressTrafficEventPayload`):

| Column | Meaning |
|---|---|
| `observed_at` | ISO 8601 UTC timestamp with millisecond precision |
| `method`, `host`, `path`, `query_string` | Split `REQUEST_URI` parts |
| `status` | HTTP response status code |
| `user_agent`, `referer` | Headers as captured at request time |
| `remote_ip` | Client IP address (IPv4 or IPv6), or empty when none was captured |

The plugin auto-prunes events older than the retention window (default
90 days) once per day via WP-Cron. Operators who want a different
window change it in `Settings → Canonry Traffic Logger`.

## Connecting a Vercel source

The Vercel adapter pulls per-request logs from the Vercel API for a
specific project + environment. Logs are filtered by canonical domain
before classification so a multi-tenant Vercel project only surfaces
hits for the tracked site.

```bash
# 1. In the Vercel dashboard, create a token with read access to the
#    target team (Settings → Tokens → Create). Note the team ID
#    (Settings → General → Team ID) and the Vercel project ID
#    (Project → Settings → General → Project ID).

# 2. Connect from cnry CLI:
cnry traffic connect vercel <project> \
  --project-id prj_xxxxxxxx \
  --team-id   team_xxxxxxxx \
  --token     <vercel-token>            # or: --token-file <path>

# 3. (Optional) scope to a specific environment (default: production):
cnry traffic connect vercel <project> \
  --project-id prj_xxx --team-id team_xxx --token ... \
  --environment preview
```

Credentials live in `~/.canonry/config.yaml` under `vercelTraffic:`,
mirroring the cloud-run / wordpress blocks. The adapter classifies bot
crawls + AI-referral arrivals into the same `crawler_events_hourly` /
`ai_referral_events_hourly` tables — downstream commands
(`cnry traffic events / sources / status`) are source-agnostic.

### Vercel first-sync window (gotcha)

A new Vercel source captures **only going-forward traffic** by default.
`cnry traffic connect vercel` seeds `lastSyncedAt = NOW` so the first
scheduled sync uses a tight window inside Vercel's ~14-day
`request-logs` retention. Without this, the first sync would fall back
to a 30-day window, exceed retention, and throw — leaving the source
permanently stuck.

Run `cnry traffic backfill <project> --source <id> --days N` (capped at
~14 to stay inside retention) if you need any of the pre-connect
history. It's an explicit operator action; the connect flow never pulls
it implicitly.

## Syncing data

```bash
# Manual sync — pulls [lastSyncedAt, now]. For a freshly connected
# source the window is short (since connect-time NOW). For a
# regular-cadence schedule the window stays ~30 min wide.
cnry traffic sync <project> --source <id>

# Override the lookback window (minutes) — note: clamped forward to
# lastSyncedAt, so this can only NARROW the window, never widen it
# past data already pulled.
cnry traffic sync <project> --source <id> --since-minutes 4320  # 3 days
```

### Unsticking a stuck source

If a Vercel (or Cloud Run) source has been failing for so long that
`lastSyncedAt` aged past the upstream retention boundary, every sync
will throw a retention error and `lastSyncedAt` will never advance —
the source is permanently stuck. Recovery:

```bash
# Advances lastSyncedAt to NOW, clears the error state. Skipped
# history is unrecoverable from the sync path; run backfill separately
# if any of it needs to be captured.
cnry traffic reset <project> --source <id> --advance-to-now
```

`--advance-to-now` is required — there is no implicit reset.

`reset` accepts any **non-archived** source type. The `lastSyncedAt`
advance is meaningful for time-windowed sources (Vercel, Cloud Run)
where it determines the next sync window. Cursor-based sources
(WordPress) keep their `last_cursor` intact, so the `lastSyncedAt`
advance is informational — the next WordPress drain still resumes
from the cursor. The primary use case is the retention-trap recovery
above; clearing `lastError` for a transient WordPress failure also
works. Archived sources are rejected — re-connect them with
`cnry traffic connect ...` instead.

Cross-sync dedupe via the `last_event_ids` ring buffer means re-running a
sync over an overlapping window cannot double-count rolled-up hourly
hits. Safe to schedule (see "Scheduling" below) or trigger from CI.

## Inspecting source state

```bash
# All sources with last-24h totals + latest sync run (single-call):
cnry traffic status <project> --format json

# Just the source list:
cnry traffic sources <project> --format json

# Windowed events (defaults to last 24h):
cnry traffic events <project> --kind crawler --limit 200 --format json
cnry traffic events <project> --kind ai-referral --since 2026-04-01 --until 2026-04-30
```

The `traffic status` composite returns the same per-source detail
(24h crawler hits, AI-referral arrivals, raw-event-sample count, latest
sync-run summary) whether you reach it via the CLI, the API, or the
MCP `canonry_traffic_status` tool.

## Where the data shows up

| Surface | What's rendered |
|---|---|
| Project dashboard `/projects/:name/activity` | Live source table + 24h totals + GA4 referrals (combined view) |
| Top-level `/traffic` route | Cross-project source admin (connect, sync, archive) |
| `cnry report <project>` (HTML + SPA) | "AI Visibility — Server-Side" section, ranked above Indexing Health |
| `cnry doctor --project <name>` | `traffic.source.connected`, `recent-data`, `credentials`, `scopes` checks |
| MCP toolkit `traffic` | Tools: `canonry_traffic_status`, `_sources_list`, `_source_get`, `_events`, `_connect_cloud_run`, `_sync` |

## Doctor signals

The doctor checks are adapter-agnostic. When they fail or warn:

| Check | Code | What to do |
|---|---|---|
| `traffic.source.connected` | `traffic.source.none` | No source — `cnry traffic connect cloud-run …` |
| `traffic.source.connected` | `traffic.source.all-errored` | Re-connect the source. The check's `details.lastError` shows the underlying reason. |
| `traffic.source.recent-data` | `traffic.recent-data.stale` | Last sync was >7d ago. Run `cnry traffic sync …` or schedule a recurring sync. |
| `traffic.source.recent-data` | `traffic.recent-data.empty` | Source connected but no data in 30d. Verify config and credentials with `cnry traffic sources <project>`. |
| `traffic.source.credentials` | `traffic.credentials.resolve-failed` | Service-account key in `~/.canonry/config.yaml` is invalid or expired. Re-connect. |

## Scheduling

`cnry schedule` supports `--kind traffic-sync`. Recurring syncs are
safe because of the `last_event_ids` cross-sync dedupe ring buffer
described above. Recommended cadence:

| Cadence | Use case |
|---|---|
| `0 */6 * * *` (every 6h) | Production agencies tracking active client sites |
| `0 0 * * *` (daily) | Lower-traffic sites or local dev |
| Manual only | First few weeks while validating data |

## Telemetry

Every successful or failed sync emits a `traffic.synced` event to the
canonry telemetry pipeline:

```jsonc
{
  "event": "traffic.synced",
  "errorCode": "PROVIDER_AUTH",       // present only when status='failed'
  "properties": {
    "status": "completed" | "failed",
    "sourceType": "cloud-run",        // adapter type
    "sourceId": "<uuid>",             // opaque
    "pulledEvents": 234,
    "crawlerHits": 200,
    "aiReferralHits": 12,
    "durationMs": 4150
  }
}
```

Counts are aggregate. The sourceId is an opaque UUID. No raw paths,
domains, or PII are surfaced.

## Limits & caveats

- **Path-level citation cross-reference is not implemented yet.** The
  citation store is domain-grain (`query_snapshots.cited_domains`). A
  future iteration that lands URL-grain citation evidence will extend
  the `topCrawledPaths` entry with a `citationState` flag. Until then,
  treat the report's crawled-paths table as "engine attention" — the
  signal is the bot fetched it, not whether it was cited.
- **Verified vs unverified.** The headline numbers count only
  rDNS-verified hits. Unverified bots claim a known UA but couldn't be
  cross-confirmed via reverse-DNS — they may be the real bot or an
  imitator. Don't promote unverified counts in client-facing copy.
  **Vercel sources are a special case:** the Vercel pull API returns
  no client IP, so every Vercel crawler hit is unverified by
  construction (UA-only). A Vercel source reading 100% unverified is
  expected, not a misconfiguration.
- **Three adapters shipped (Cloud Run + WordPress + Vercel); more
  planned.** The doctor checks and the report renderer are
  adapter-agnostic — adding a new adapter is just a new entry in
  `traffic_sources.source_type` and a `TrafficSourceValidator`
  registration.
