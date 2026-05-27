# Cloudflare Worker Traffic Source Plan

Status: design plan for implementation
Last updated: 2026-05-27

## Context

Canonry already supports three server-side traffic sources — `cloud-run`,
`wordpress`, `vercel` — all pull-shaped: canonry calls an upstream HTTP API
on a cursor schedule, normalizes rows, classifies via
`packages/integration-traffic`, and rolls into hourly buckets.

Cloudflare is the next adapter, and it's structurally different. Cloudflare
exposes three data surfaces:

1. **GraphQL Analytics API** — aggregate-only, even on the AI Crawl Control
   dataset. No raw request rows.
2. **Logpush** — raw rows, but Business plan or higher only.
3. **Workers** — universal raw-row access on any plan, including free, via
   a customer-deployed Worker that forwards filtered requests to a canonry
   ingestion endpoint.

Free/Pro plans cover most prospective canonry customers, so building only
Logpush would leave the long tail out. The Worker path covers every plan
and also unlocks the long-considered "Cloudflare-as-proxy" story for hosts
that expose no logs at all (Shopify, Webflow, Wix, Ghost) — once a customer
puts Canonry's Worker on their zone, that zone is a fully ingestible
traffic source regardless of where the site is actually hosted.

This plan covers the Worker adapter. A parallel `cloudflare-logpush`
adapter is reserved for later — same ingestion endpoint shape, different
delivery mechanism (Logpush HTTPS destination batches rows instead of the
Worker fetching them one at a time).

See [`server-side-ai-traffic-ingestion.md`](./server-side-ai-traffic-ingestion.md)
for the overall traffic plan and
[`cloud-run-traffic-source-model-review.md`](./cloud-run-traffic-source-model-review.md)
for the raw-event vs aggregate-bucket rationale.

## Goals

1. Capture AI crawler hits + AI-referral hits on any Cloudflare-fronted site,
   regardless of plan tier.
2. Reuse the existing classifier + rollup pipeline — the Worker only
   forwards events, it does not classify.
3. Provide first-class IP verification: unlike Vercel (no client IP),
   Cloudflare Workers expose `cf-connecting-ip` on every request, so
   `claimed_unverified` → `verified` promotion via
   `integration-traffic/ip-verify.ts` works out of the box.
4. Operator-deployable in Phase 1: canonry generates the Worker script,
   operator pastes it into Cloudflare's dashboard or `wrangler deploy`s it.
5. Architecturally compatible with Phase 2 auto-deploy via Cloudflare API.

## Non-Goals

- **No Logpush implementation in this plan.** Same target endpoint, but the
  delivery shape (batched gzipped JSONL POSTed by Cloudflare directly)
  warrants its own adapter and is gated on Business+ plan availability.
- **No GraphQL Analytics API ingestion.** Aggregate-only; useful as an
  aux signal on the dashboard, but not a primary ingestion path.
- **No Worker auto-deploy in Phase 1.** Operator-pasted/wrangler'd only.
  Phase 2 adds a `--auto-deploy` flow that takes a Cloudflare API token
  and provisions the Worker via Cloudflare's Workers API.
- **No Cloudflare-as-proxy zone provisioning.** That's a separate
  feature — putting a non-Cloudflare-hosted site behind a canonry-created
  Cloudflare zone — built on top of this adapter once it ships.
- **No edge-side classification.** Worker uses a broad, stable filter to
  decide what to forward; the strict bot/referer list stays in
  `packages/integration-traffic`.

## Architecture

```
+-----------------------------+
| Customer's Cloudflare zone  |
|                             |
|  Worker (canonry-issued)    |
|  - generic AI-signal filter |
|  - event.waitUntil(fetch()) |
+--------------+--------------+
               |
               | POST /api/v1/projects/:name/traffic/cloudflare/ingest
               | Authorization: Bearer <source-token>
               | X-Canonry-Signature: <hmac>
               v
+--------------+--------------+
| canonry serve / apps/api    |
|                             |
|  packages/api-routes/       |
|    traffic.ts (new route)   |
|                             |
|  -> verify token + HMAC     |
|  -> normalize event         |
|  -> classify (existing)     |
|  -> upsert hourly rollups   |
+-----------------------------+
```

The ingestion path is the only structural divergence from existing
adapters: it is **push-receive** rather than pull. This is operationally
fine because canonry is single-tenant per deployment — the operator runs
their own canonry instance, the operator owns the Cloudflare zone, and
the Worker only ever talks to the operator's own canonry URL. No canonry
SaaS relay is introduced. The Vercel adapter explicitly deferred this
push shape; the Cloudflare Worker is where we accept it, scoped narrowly.

## Worker Script Design

### Filter (edge-side, broad, stable)

The Worker forwards a request iff **any** of:

- UA matches the generic keyword set:
  `bot | crawler | spider | agent | gpt | claude | ai | perplexity | chatgpt | openai | anthropic`
  (case-insensitive substring match)
- Referer host matches the generic suffix list:
  `.openai.com | .anthropic.com | .perplexity.ai | chat. | search.` or the
  host contains `gpt | claude | ai | chat` as a token
- Cloudflare bot signals: `request.cf.botManagement?.verifiedBot === true`
  OR `request.cf.botManagement?.score < 30` (best-effort — only populated
  on plans with Bot Management; safe to be absent)

The filter is intentionally broader than canonry's classifier so the
Worker doesn't need a redeploy every time a new bot UA is identified —
the strict classifier on the server side does the real work.

### Payload

One request, one `fetch()`. Body is a single-element array (the array
shape lets the same endpoint accept Logpush batches later without an
endpoint version bump).

```json
{
  "schemaVersion": 1,
  "workerVersion": "1.0.0",
  "events": [
    {
      "eventId": "8a3d2b0c-cf-ray",
      "observedAt": "2026-05-27T15:30:00.123Z",
      "method": "GET",
      "host": "example.com",
      "path": "/blog/post",
      "queryString": "utm_source=chatgpt",
      "status": 200,
      "userAgent": "GPTBot/1.2",
      "remoteIp": "20.171.207.34",
      "referer": "https://chat.openai.com/",
      "cf": {
        "verifiedBot": true,
        "botScore": 30,
        "country": "US",
        "asn": 8075,
        "asOrganization": "Microsoft Corporation"
      }
    }
  ]
}
```

`eventId` is Cloudflare's `cf-ray` header — globally unique per request,
durable across retries.

### Delivery semantics

```typescript
addEventListener('fetch', (event) => {
  event.respondWith(handle(event.request))
  if (shouldForward(event.request)) {
    event.waitUntil(forward(event.request))
  }
})
```

`waitUntil` keeps the forward `fetch()` alive after the response has been
sent, so it never adds to user-perceived latency. If the canonry endpoint
is unreachable, the event is dropped — no retry, no buffering. That's
acceptable: the AI traffic signal is statistical, not transactional, and
adding a Durable Object for retry queueing isn't worth the complexity in
Phase 1.

### Auth

Every forward carries:

- `Authorization: Bearer <source-token>` — per-source token, generated at
  `canonry traffic connect cloudflare` time, embedded in the Worker script
  at generation, stored hashed in `traffic_sources.ingestTokenHash`.
- `X-Canonry-Timestamp: <unix-seconds>` — request timestamp.
- `X-Canonry-Signature: hex(hmac_sha256(secret, timestamp + "." + body))`
  — HMAC over `timestamp + "." + body`, using a per-source HMAC secret
  stored in `~/.canonry/config.yaml` under `cloudflareTraffic.connections`.
- `X-Canonry-Worker-Version: <semver>` — for the staleness doctor check.

Receiver verifies in this order: timestamp within ±5 minutes → token hash
match → HMAC match. Any failure responds 401 with a structured error
envelope; no detail about which check failed (avoid token-vs-secret
disambiguation).

### Versioning

The Worker script carries a `WORKER_VERSION` constant. On each forwarded
event, the receiver records the version against the source. A new doctor
check flags drift:

- `cloudflare.worker.version-stale`:
  - `warn` when deployed version is > 2 releases behind canonry's current
  - `fail` when > 5 releases behind

The bot keyword set is generic enough that updates are quarterly-ish, not
per-bot. When the constants do change, canonry tags a new Worker release
and the operator regenerates+redeploys.

## Server Side

### New adapter package: `packages/integration-cloudflare-worker/`

Following the file layout of `packages/integration-vercel/`:

| File | Role |
|------|------|
| `src/script.ts` | `generateWorkerScript(opts)` — produces the JS string with embedded source-id, bearer, HMAC secret, version, bot-keyword constants |
| `src/normalize.ts` | `normalizeCloudflareWorkerEvent(payload)` — converts one inbound event to `NormalizedTrafficRequest` |
| `src/verify.ts` | `verifyRequestSignature(headers, body, secret)` — timestamp + HMAC check |
| `src/types.ts` | Inbound payload schema (Zod) + worker version manifest |
| `src/index.ts` | Re-exports |

No client/drain module — there's nothing for canonry to pull. The Worker
pushes; the API route handles ingestion.

### New API routes (in `packages/api-routes/src/traffic.ts`)

- `POST /api/v1/projects/:name/traffic/connect/cloudflare`
  - Body: `{ displayName?, zoneId?, accountId? }`
  - Generates per-source bearer token + HMAC secret
  - Stores hashed token + zone metadata in `traffic_sources`
  - Stores cleartext bearer + HMAC secret in `~/.canonry/config.yaml`
  - Returns the generated Worker script as a string field on the response
    (with embedded constants) and a `wranglerToml` field so the operator
    can `wrangler deploy` directly
  - Idempotent on `(project, sourceType, zoneId?)` — rerunning rotates
    the secrets and emits a new script

- `POST /api/v1/projects/:name/traffic/cloudflare/ingest`
  - The Worker target
  - Bearer + HMAC auth (separate from canonry's `cnry_...` API keys)
  - Body: see "Payload" above
  - Verifies → normalizes → classifies (existing
    `integration-traffic`) → upserts rollups via the existing hourly-rollup
    pipeline shared with the pull adapters
  - Returns `{ acceptedEvents, droppedEvents, workerVersionAck }`
  - Rate-limited per source (e.g., 100 req/sec, 5000 req/min) to defend
    against a runaway Worker; over-limit returns 429 with `Retry-After`

- `POST /api/v1/projects/:name/traffic/cloudflare/rotate/:sourceId`
  - Generates new bearer + HMAC secret
  - Emits a new Worker script
  - Old secrets stay valid for 5 minutes so the operator has time to
    redeploy without a gap

### Schema changes (`packages/db/src/schema.ts` + `migrate.ts`)

`traffic_sources` already exists. Add two nullable columns:

```typescript
ingestTokenHash:   text('ingest_token_hash'),         // sha256 of bearer
lastWorkerVersion: text('last_worker_version'),       // most recent forwarded value
```

`configJson` for a `cloudflare` source:

```typescript
{
  schemaVersion: 1,
  workerVersion: '1.0.0',           // version embedded at last generate
  expectedBotListVersion: '2026-05-27',
  zoneId: string | null,
  accountId: string | null,
}
```

Credentials in `~/.canonry/config.yaml`:

```yaml
cloudflareTraffic:
  connections:
    <sourceId>:
      bearerToken: <opaque>
      hmacSecret: <opaque>
```

Both stored only here; the DB has only the hashed bearer for verification
and never the HMAC secret in cleartext.

### Migration version

Append to `MIGRATION_VERSIONS` in `packages/db/src/migrate.ts`:

```typescript
{
  version: <next>,
  name: 'cloudflare-worker-traffic-source',
  statements: [
    `ALTER TABLE traffic_sources ADD COLUMN ingest_token_hash TEXT`,
    `ALTER TABLE traffic_sources ADD COLUMN last_worker_version TEXT`,
  ],
},
```

## Contracts (`packages/contracts/src/traffic.ts`)

Already has `'cloudflare'` in `trafficSourceTypeSchema` — no enum change.
Add:

```typescript
export const cloudflareWorkerSourceConfigSchema = z.object({
  schemaVersion: z.literal(1),
  workerVersion: z.string(),
  expectedBotListVersion: z.string(),
  zoneId: z.string().nullable(),
  accountId: z.string().nullable(),
})

export const trafficConnectCloudflareRequestSchema = z.object({
  displayName: z.string().min(1).optional(),
  zoneId: z.string().optional(),
  accountId: z.string().optional(),
})

export const trafficConnectCloudflareResponseSchema = z.object({
  sourceId: z.string(),
  workerScript: z.string(),
  wranglerToml: z.string(),
  workerVersion: z.string(),
  instructions: z.string(),
})

export const cloudflareWorkerEventSchema = z.object({
  eventId: z.string().min(1),
  observedAt: z.string().min(1),
  method: z.string().nullable(),
  host: z.string().nullable(),
  path: z.string().min(1),
  queryString: z.string().nullable(),
  status: z.number().int().nullable(),
  userAgent: z.string().nullable(),
  remoteIp: z.string().nullable(),
  referer: z.string().nullable(),
  cf: z.object({
    verifiedBot: z.boolean().nullable(),
    botScore: z.number().int().nullable(),
    country: z.string().nullable(),
    asn: z.number().int().nullable(),
    asOrganization: z.string().nullable(),
  }).nullable(),
})

export const cloudflareWorkerIngestRequestSchema = z.object({
  schemaVersion: z.literal(1),
  workerVersion: z.string().min(1),
  events: z.array(cloudflareWorkerEventSchema).min(1).max(100),
})
```

## Doctor checks

`packages/api-routes/src/doctor/checks/cloudflare-worker.ts` registers:

- `cloudflare.worker.last-seen`:
  - `ok` if a forwarded event arrived in last 24h
  - `warn` if last in 24h–7d
  - `fail` if no event ever / last > 7d
- `cloudflare.worker.version-stale`:
  - `ok` if deployed version matches current
  - `warn` if 1–2 releases behind
  - `fail` if > 2 releases behind OR deployed version unknown
- `cloudflare.worker.signature-failures`:
  - `ok` if no signature-failure events in last 24h
  - `warn` if > 0 — likely a stale token after rotation
  - Read from a new lightweight counter; sized to drop after 7 days

The generic `traffic.source.recent-data` and `traffic.source.connected`
checks already cover the Cloudflare source type with no per-source code.

The new check IDs go into the doctor table in `AGENTS.md`.

## CLI surface

```bash
canonry traffic connect cloudflare <project> [--display-name <n>] \
  [--zone-id <id>] [--account-id <id>] [--out <path>]
# Generates a new source. Writes worker.js + wrangler.toml to --out (default:
# ./canonry-cloudflare-worker/) and prints next-step instructions. Secrets
# are inlined into worker.js and saved to ~/.canonry/config.yaml.

canonry traffic rotate cloudflare <project> --source <sourceId> [--out <path>]
# Rotates the bearer + HMAC secret. Old secrets remain valid 5 minutes.

canonry traffic verify cloudflare <project> --source <sourceId>
# Polls until at least one event has been forwarded, or 60s timeout. Useful
# for the post-deploy "did it work?" loop.
```

Each command supports `--format json` per the agent-first principle.

## MCP / Aero

The MCP tool registry picks up `traffic.connect.cloudflare`,
`traffic.rotate.cloudflare`, and `traffic.verify.cloudflare` automatically
once the API routes exist. Tag them under the `setup` toolkit (same as the
other `traffic.connect.*` tools). Aero inherits them through the
MCP-to-agent adapter; no separate Aero registration unless we want to
exclude the rotate tool from autonomous use.

## Dashboard

The Cloudflare source surfaces in the existing AI Traffic section with no
special-case UI — it shows up in the source list, the connect modal gets
a new "Cloudflare Worker" option that calls the connect endpoint and
renders the generated script + wrangler.toml for the operator to copy,
and the version-stale doctor check renders as a banner on the source's
detail card.

## Testing strategy

### Unit (`packages/integration-cloudflare-worker/test/`)

- `script.test.ts` — generated script compiles (`new Function(...)` smoke
  test); embedded constants land at expected placeholders; bot keyword set
  matches manifest snapshot.
- `normalize.test.ts` — happy path, every nullable field individually
  missing, malformed timestamp, malformed eventId.
- `verify.test.ts` — valid signature passes, mutated body fails, expired
  timestamp fails, wrong secret fails, replay (same timestamp) fails on
  second submission.

### API (`packages/api-routes/test/`)

- `traffic-cloudflare-connect.test.ts` — connect endpoint creates source,
  writes secrets to config, returns script, idempotent on rerun, rotation
  invalidates old token after grace.
- `traffic-cloudflare-ingest.test.ts` — auth happy path, signature replay
  rejected, rate-limit triggers 429, events land in rollups identical to
  what the equivalent pull adapter would produce, version is recorded.
- `probe-exclusion.test.ts` — add a case confirming probe runs don't
  contaminate Cloudflare-source rollups (the source has no run-trigger
  concept — but the rollup table is shared, so still worth asserting).
- `doctor-cloudflare-worker.test.ts` — every status × every code path.

### Classifier (`packages/integration-traffic/test/`)

- Existing tests already cover UA + referer rules. Add a case that uses a
  Cloudflare-shaped `NormalizedTrafficRequest` (with `remoteIp` populated)
  to confirm IP-range verification promotes to `verified` for the major
  AI bots — this is the first adapter where IP verification actually
  fires, so it's worth one explicit assertion.

## Rollout

1. Contracts + schema + migration.
2. `integration-cloudflare-worker/` package (script generator, normalizer,
   verifier).
3. API routes: connect, ingest, rotate. Reuse existing classifier + rollup.
4. CLI commands.
5. Doctor checks.
6. MCP toolkit registration (automatic via tool-registry).
7. Dashboard connect-modal entry.
8. Docs: `packages/integration-cloudflare-worker/AGENTS.md`, update root
   `AGENTS.md` doctor table, update `docs/data-model.md` if new columns
   are visible to the schema diagram.

## Phase 2 (deferred)

- **Auto-deploy** — operator hands canonry a Cloudflare API token; canonry
  uses the Workers API to create/update the Worker on the operator's
  behalf. Reuses the same script generator. Adds a new credential to
  `~/.canonry/config.yaml` and a `cloudflare.api.token` doctor check.
- **Cloudflare-as-proxy** — for hosts with no native logs, canonry walks
  the operator through pointing nameservers at Cloudflare, creates the
  zone, installs the Worker. This is where the auto-deploy story actually
  pays off.
- **Logpush sibling adapter** — Business+ plan customers point Logpush at
  the same ingest endpoint. Endpoint shape already accepts arrays, so this
  is mostly a parser change + a separate connect flow + a separate doctor
  category.

## Open questions

- **Drop-on-failure vs in-Worker buffering.** Phase 1 drops events the
  canonry endpoint refuses (network error, 5xx). Acceptable for AI
  traffic since the signal is statistical, but worth revisiting if early
  customers want stronger guarantees. Durable Objects + a small queue
  would add hard delivery semantics at a cost.
- **Rate-limit shape.** Static per-source limits (100/s, 5k/min) are a
  reasonable starting point. A busy site under heavy AI-crawler load
  might exceed it; sample-down at the Worker (1-in-N) might be worth
  exposing as a config value if it becomes a problem.
- **Worker keyword list distribution.** Inlined constants vs fetched-from-
  KV. Inlined is simpler (no KV reads on every request, no Cloudflare API
  dependency); the cost is a redeploy when keywords change. Sticking with
  inlined for Phase 1.
- **Signature-failure counter storage.** Want a lightweight per-source
  counter without growing the schema much. Options: a new
  `traffic_source_metrics` table with a small fixed set of counters, or
  reuse `usage_counters`. Lean toward `usage_counters` if the scope/period
  shape fits.

## See Also

- `plans/server-side-ai-traffic-ingestion.md` — overall traffic plan
- `plans/cloud-run-traffic-source-model-review.md` — raw-event model
  rationale
- `packages/integration-vercel/AGENTS.md` — closest sibling adapter (pull,
  not push, but same normalizer shape)
- `packages/integration-traffic/AGENTS.md` — classifier + rollup that the
  ingest endpoint hands off to
- Cloudflare Workers Bot Management docs — `cf.botManagement` property
  availability per plan tier (sanity-check before relying on `verifiedBot`
  as a verification signal)
