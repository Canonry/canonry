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
Today's only adapter is `cloud-run`; future adapters slot in by
implementing the same contract.

## Connecting a Cloud Run source

```bash
# 1. Create a service account in the Cloud project that hosts the Cloud Run
#    service. Grant it `roles/logging.viewer`. Download the JSON key.

# 2. Connect from canonry CLI:
canonry traffic connect cloud-run <project> \
  --gcp-project <gcp-project-id> \
  --service-account-key <path/to/key.json>

# 3. (Optional) narrow to a specific service or location:
canonry traffic connect cloud-run <project> \
  --gcp-project <id> \
  --service-account-key <path> \
  --service my-service-name \
  --location us-east1
```

Credentials are stored in `~/.canonry/config.yaml` (not the DB). The
canonical key lives only on the host that runs `canonry serve`. The
sync flow does NOT echo the private key back in any response.

## Syncing data

```bash
# Manual sync — defaults to a 30-day lookback on the first run; subsequent
# runs are clamped forward to lastSyncedAt to avoid re-pulling.
canonry traffic sync <project> --source <id>

# Override the lookback window (minutes):
canonry traffic sync <project> --source <id> --since-minutes 4320  # 3 days
```

Cross-sync dedupe via the `last_event_ids` ring buffer means re-running a
sync over an overlapping window cannot double-count rolled-up hourly
hits. Safe to schedule (see "Scheduling" below) or trigger from CI.

## Inspecting source state

```bash
# All sources with last-24h totals + latest sync run (single-call):
canonry traffic status <project> --format json

# Just the source list:
canonry traffic sources <project> --format json

# Windowed events (defaults to last 24h):
canonry traffic events <project> --kind crawler --limit 200 --format json
canonry traffic events <project> --kind ai-referral --since 2026-04-01 --until 2026-04-30
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
| `canonry report <project>` (HTML + SPA) | "AI Visibility — Server-Side" section, ranked above Indexing Health |
| `canonry doctor --project <name>` | `traffic.source.connected`, `recent-data`, `credentials`, `scopes` checks |
| MCP toolkit `traffic` | Tools: `canonry_traffic_status`, `_sources_list`, `_source_get`, `_events`, `_connect_cloud_run`, `_sync` |

## Doctor signals

The doctor checks are adapter-agnostic. When they fail or warn:

| Check | Code | What to do |
|---|---|---|
| `traffic.source.connected` | `traffic.source.none` | No source — `canonry traffic connect cloud-run …` |
| `traffic.source.connected` | `traffic.source.all-errored` | Re-connect the source. The check's `details.lastError` shows the underlying reason. |
| `traffic.source.recent-data` | `traffic.recent-data.stale` | Last sync was >7d ago. Run `canonry traffic sync …` or schedule a recurring sync. |
| `traffic.source.recent-data` | `traffic.recent-data.empty` | Source connected but no data in 30d. Verify config and credentials with `canonry traffic sources <project>`. |
| `traffic.source.credentials` | `traffic.credentials.resolve-failed` | Service-account key in `~/.canonry/config.yaml` is invalid or expired. Re-connect. |

## Scheduling

`canonry schedule` supports `--kind traffic-sync`. Recurring syncs are
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
- **Cloud Run only in v1.** WordPress plugin and other adapters are
  planned. The doctor checks and the report renderer are already
  adapter-agnostic — adding a new adapter is just a new entry in
  `traffic_sources.source_type` and a `TrafficSourceValidator`
  registration.
