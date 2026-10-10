# Outcome telemetry

Canonry's usage events (`cli.command`, `api.request`, `ui.*`) say a feature was
used. Outcome events say what happened when it ran: whether a connection
worked and why not, what a sync or delivery produced, what an agent turn cost,
and what an install has set up. They exist so the team can see people
connecting integrations and get told about issues before users report them.

Schemas live in `packages/contracts/src/outcome-telemetry.ts`. Helpers live in
`packages/canonry/src/outcome-telemetry.ts` and, for route code,
`app.emitOutcome` from `packages/api-routes/src/outcome-telemetry.ts`. The
rules are in `packages/canonry/AGENTS.md` under "Outcome telemetry".

## Events

| Event | When | Key properties |
|---|---|---|
| `integration.connection` | Every connect, disconnect, test, reauth or select attempt | `integration`, `provider` (answer engines), `action`, `status` (`started`, `succeeded`, `failed`, `cancelled`), `reasonCode`, `target` (webhooks), `surface`, `agent`, `durationBucket` |
| `feature.completed` | Every job, sync, delivery, agent turn or operation finishing | `feature`, `operation`, `status` (`succeeded`, `partial`, `failed`, `skipped`, `cancelled`), `trigger`, `reasonCode`, `durationBucket`, `counts`, plus `target`, `eventType`, `statusClass`, `provider`, `model`, `modelProvider` where they apply |
| `install.state` | Once per running server per day | `providers`, `integrations`, `counts`, `usage24h`, `providerCalls24h`, `agentProvider`, `agentModel`, `uptimeBucket` |
| `run.completed` (extended) | Every sweep | adds per-provider call counts and token and cost usage |
| `telemetry.disabled` (extended) | Explicit opt-out | adds `surface` and `agent` |

`surface` is where the action came from: `cli`, `mcp-stdio`, `mcp-http`,
`aero`, `api`, `dashboard`, or `system` when the server acted on its own.
`trigger` is what started an operation: `manual`, `scheduled`, `agent`,
`startup`, `retry`, or `push` (an external system sending data in).

## Privacy

Enums, integer counts and buckets only. Never a URL, a domain (use
`domainHash`), an account, property or customer id, a name, an error message,
or any free text. Absent fields are omitted, never `null`. Environment opt-outs
(`CANONRY_TELEMETRY_DISABLED`, `DO_NOT_TRACK`, `CI`) send nothing at all.

## Volume

The collector allows 100 events a minute and 1,000 an hour per IP, shared by
every event. Per-operation outcomes are low volume. High-volume streams
(webhook deliveries, traffic push ingest) go through `createOutcomeSampler`,
whose `droppedBefore` keeps totals reconstructable.

## Coverage by feature

Each row names the outcome moment. Implementations update the "Emitted from"
column with the final file and function.

### Connections (`integration.connection`)

| Integration | Actions | Emitted from |
|---|---|---|
| `provider` | connect (settings route, bootstrap env), test, disconnect | |
| `gsc`, `ga4`, `gbp` | connect (`started` at the OAuth redirect, then `succeeded`, `failed` or `cancelled` at the callback), select, disconnect, reauth | |
| `bing` | connect (key validated), disconnect | |
| `google_ads`, `gtm` | connect, select, disconnect | |
| `openai_ads` | connect, disconnect | |
| `traffic_cloudflare`, `traffic_vercel`, `traffic_cloud_run` | connect, test, disconnect | |
| `wordpress` | connect, test, disconnect | |
| `webhook` | connect (create), test (result from the destination), disconnect (delete) | |
| `agent_webhook` | connect (attach, `ALREADY_CONNECTED` when already attached), disconnect (detach) | |
| `cdp` | connect, test | |

### Outcomes (`feature.completed`)

| Feature | Operations | Counts | Emitted from |
|---|---|---|---|
| `search_console` | sync, inspect, sitemap_submit | rows, urls | |
| `ga4` | sync | rows | |
| `bing` | sync, inspect | rows, urls | |
| `gbp` | sync, reviews | rows, reviews | |
| `google_ads`, `gtm` | sync | rows, campaigns | |
| `openai_ads` | sync, operation, activation, reconcile | campaigns, operations | |
| `server_traffic` | sync, ingest (sampled), backfill, reset | events, crawlerHits, aiReferralHits, aiUserFetchHits | |
| `backlinks` | install, sync, extract | domains, links | |
| `content` | analyze, brief | gaps, targets, briefs | |
| `research`, `discovery`, `sentiment` | run | queries, snapshots, failures | |
| `aero` | turn | modelCalls, toolCalls, toolErrors, inputTokens, outputTokens, costMicros; plus `model`, `modelProvider` | |
| `webhooks` | deliver (sampled), test | attempts; plus `target`, `eventType`, `statusClass` | |
| `schedules` | slot | items | |
| `exports` | export | rows, bytes | |
| `providers` | reload | providers | |
| `wordpress` | schema_deploy, llms_txt, meta_write, publish | items | |
| `measurement` | publish | items | |
| `insights` | generate | insights | |
| `site_liveness` | check | pages | |
| `reports` | download | | |
| `data_refresh` | refresh | items | |

### Usage

- **Sweeps:** `run.completed` gains `providerCalls` (answer-engine calls per provider) and `usage` (inputTokens, outputTokens, costMicros, batchCalls).
- **Aero:** every turn is `feature.completed` with `feature: aero`, `operation: turn`, the model and its provider, model and tool calls, tokens and cost.
- **Daily:** `install.state.usage24h` and `providerCalls24h` total both, so installs that only run on schedules are visible too.
