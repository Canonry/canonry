# integration-cloudflare-worker

## Purpose

Cloudflare traffic integration. Generates the JavaScript Worker that the
operator deploys onto their Cloudflare zone; verifies the HMAC-signed
inbound ingest requests it produces; normalizes Worker events into the
provider-neutral `NormalizedTrafficRequest` shape consumed by
`packages/integration-traffic`.

The adapter supports both delivery modes. With **direct push**, the customer's
Worker sends each filtered request to a canonry ingest endpoint. With
**queue pull**, the Worker publishes the same event batch to a Cloudflare Queue
and the single-team canonry deployment drains it over the HTTP pull API. The
Queue Worker needs only a producer binding; the Queue API token remains in the
canonry credential store.

The push direction is safe because canonry is single-tenant per
deployment — the Worker only ever talks to the operator's own canonry
instance, never to a canonry-hosted SaaS relay.

## Key Files

| File | Role |
|------|------|
| `src/script.ts` | `generateWorkerScript` — produces an ES-module Worker with a transport-neutral capture path and direct-push or Queue delivery. `generateWranglerToml` emits non-secret vars and the account id, but never attaches a route. Operators attach the exact route manually with Fail open. |
| `src/canonical-json.ts` | Deterministic JSON encoding embedded into the generated Worker and reused by receiver signature verification. |
| `src/normalize.ts` | `normalizeCloudflareEdgeEvent` — one edge event → `NormalizedTrafficRequest`; the old Worker-named export is a compatibility alias. |
| `src/verify.ts` | `verifyRequestSignature` — timestamp window + HMAC-SHA256 check. Constant-time once inputs are well-formed. |
| `src/types.ts` | `CloudflareWorkerBotList`, `GenerateWorkerScriptOptions` |
| `src/index.ts` | Re-exports public API |

## Patterns

- **Edge filter is generic; canonry classifier is strict.** The Worker
  forwards on a broad UA keyword match, an exact canonical AI-engine domain
  (including subdomains), AI `utm_source` evidence on the request or referrer,
  or Cloudflare bot signals (`cf.botManagement.verifiedBot` /
  `cf.botManagement.score`). The authoritative bot-id / operator
  decisions happen in `packages/integration-traffic` once the event lands
  server-side. Updating the strict list does not require a Worker
  redeploy; updating the generic list does.
- **Versioned bot list.** `CloudflareWorkerBotList.version` is baked into
  the generated script and stored on the source row as
  `configJson.expectedBotListVersion`. The Worker reports its
  `workerVersion` on every ingest call; the receiver records it on
  `traffic_sources.lastWorkerVersion`. The `traffic.source.worker-version`
  doctor check compares it with `configJson.workerVersion`.
- **HMAC-SHA256 with timestamp binding.** The Worker signs
  `timestamp + "." + canonicalJson(batch)` with the per-source HMAC secret and sends
  `X-Canonry-Timestamp` + `X-Canonry-Signature`. The receiver verifies a
  ±300s window then runs constant-time equality. Failure reasons are
  intentionally specific (`timestamp_invalid` / `timestamp_expired` /
  `signature_invalid` / `signature_mismatch`) for receiver-side logging,
  but **never echoed back to the Worker** — an attacker who knows which
  leg failed can enumerate the rest.
- **Direct-push secrets live in `~/.canonry/config.yaml` and Worker secret
  bindings.** The DB stores only the sha256 of the bearer
  (`traffic_sources.ingestTokenHash`). The HMAC secret never goes to the DB in
  any form. Queue pull uses no Worker secret binding; its Cloudflare API token
  stays server-side in the canonry credential store. No delivery mode emits a
  secret in generated source, Wrangler TOML, API output, or MCP output.
- **ES-module Worker + `waitUntil`.** The generated Worker exports
  `{ fetch(request, env, ctx) }` and uses `ctx.waitUntil(...)` so delivery never blocks the customer
  response. Errors are swallowed — AI traffic is statistical, not
  transactional; dropped events are acceptable, and surfacing the failure
  would mask the customer response.
- **Delivery is the seam.** Filtering builds a `CloudflareEdgeEventBatch`,
  then `deliverEdgeEventBatch` selects `deliverViaDirectPush` or
  `deliverViaQueue`. Delivery modes share the filter, event schema, canonical
  encoding, and normalizer.
- **`cf-ray` as event id.** Cloudflare assigns a unique `cf-ray` per
  request. The normalizer namespaces it as `cloudflare-worker:<ray>` so
  it cannot collide with another adapter's event id.
- **`cf-connecting-ip` enables IP verification.** Cloudflare exposes the
  real client IP on every plan via this header, so unlike the Vercel
  adapter, Cloudflare-Worker sources can promote `claimed_unverified` →
  `verified` via `packages/integration-traffic/src/ip-verify.ts`.
- **No classification, no DB, no I/O.** This package only generates,
  normalizes, and verifies. The HTTP route + DB writes live in
  `packages/api-routes/src/traffic.ts`. The classifier + rollup live in
  `packages/integration-traffic`.

- **Operator setup is local-CLI-only (never MCP or Aero).** `canonry traffic connect cloudflare` (in `packages/canonry`) writes secret-free Worker/Wrangler artifacts and refuses to overwrite them. With `--deploy --confirm-route --confirm-fail-open` it deploys an unattached Worker after a route preflight; the operator attaches the exact `host/*` route manually with Fail open. With `--delivery-mode queue-pull` the API token stays server-side and the Worker gets only a producer binding; enable pull separately with `wrangler queues consumer http add <name>`. `canonry traffic activate` is the explicit cutover: it pauses the old source and moves or removes traffic-sync scheduling for the target mode.

## Common Mistakes

- **Echoing the verifier's failure reason in the HTTP response.** Use a
  single 401 envelope; do not let the Worker (or anything else) learn
  which leg of the auth failed.
- **Putting a direct-push secret or Queue API token in generated source/TOML or
  `traffic_sources.configJson`.** Direct-push shared secrets belong in
  `~/.canonry/config.yaml`; only the bearer hash goes to the DB. The Queue API
  token also stays in the local credential store and never becomes a Worker
  binding.
- **Adding bot-id or operator classification in this package.** The
  classifier lives in `packages/integration-traffic` for one-place rule
  evolution across every adapter.
- **Storing or reading the Worker bot list anywhere but `DEFAULT_BOT_LIST`.**
  The Worker is regenerated from this constant; updates must rev the
  `version` field so the staleness check picks up the drift.

## See Also

- `packages/contracts/src/traffic.ts` — `cloudflareEdgeEventSchema`,
  `cloudflareEdgeEventBatchSchema`, `cloudflareTrafficSourceConfigSchema`,
  plus the compatibility Worker-named aliases,
  `trafficConnectCloudflareRequestSchema`,
  `trafficConnectCloudflareResponseSchema`
- `packages/integration-traffic/AGENTS.md` — classifier + rollup that the
  ingest route hands off to
- `packages/integration-vercel/AGENTS.md` — sibling adapter (pull, not
  push) — mirror file layout, different delivery shape
