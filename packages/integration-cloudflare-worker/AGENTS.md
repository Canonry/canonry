# integration-cloudflare-worker

## Purpose

Cloudflare traffic integration. Generates the JavaScript Worker that the
operator deploys onto their Cloudflare zone; verifies the HMAC-signed
inbound ingest requests it produces; normalizes Worker events into the
provider-neutral `NormalizedTrafficRequest` shape consumed by
`packages/integration-traffic`.

Unlike the pull adapters (`integration-cloud-run`, `integration-vercel`,
`integration-wordpress-traffic`), this package targets a **push-receive**
delivery model — the customer's Worker `fetch()`-es each filtered request
to a canonry ingest endpoint. The choice is justified by Cloudflare's
data surface: GraphQL Analytics is aggregate-only, Logpush requires
Business+ plans, so Worker push is the only universal access path.

The push direction is safe because canonry is single-tenant per
deployment — the Worker only ever talks to the operator's own canonry
instance, never to a canonry-hosted SaaS relay.

## Key Files

| File | Role |
|------|------|
| `src/script.ts` | `generateWorkerScript` — produces the JS string with embedded source-id, bearer, HMAC secret, version, bot keyword constants. `generateWranglerToml` companion. `DEFAULT_BOT_LIST` is the canonical edge-side keyword set. |
| `src/normalize.ts` | `normalizeCloudflareWorkerEvent` — one ingest event → `NormalizedTrafficRequest`. Returns `null` when path/observedAt/eventId are missing. |
| `src/verify.ts` | `verifyRequestSignature` — timestamp window + HMAC-SHA256 check. Constant-time once inputs are well-formed. |
| `src/types.ts` | `CloudflareWorkerBotList`, `GenerateWorkerScriptOptions` |
| `src/index.ts` | Re-exports public API |

## Patterns

- **Edge filter is generic; canonry classifier is strict.** The Worker
  forwards on a broad UA keyword match, a broad referer host pattern, or
  Cloudflare bot signals (`cf.botManagement.verifiedBot` /
  `cf.botManagement.score`). The authoritative bot-id / operator
  decisions happen in `packages/integration-traffic` once the event lands
  server-side. Updating the strict list does not require a Worker
  redeploy; updating the generic list does.
- **Versioned bot list.** `CloudflareWorkerBotList.version` is baked into
  the generated script and stored on the source row as
  `configJson.expectedBotListVersion`. The Worker reports its
  `workerVersion` on every ingest call; the receiver records it on
  `traffic_sources.lastWorkerVersion` so the `cloudflare.worker.version-stale`
  doctor check can flag drift.
- **HMAC-SHA256 with timestamp binding.** The Worker signs
  `timestamp + "." + body` with the per-source HMAC secret and sends
  `X-Canonry-Timestamp` + `X-Canonry-Signature`. The receiver verifies a
  ±300s window then runs constant-time equality. Failure reasons are
  intentionally specific (`timestamp_invalid` / `timestamp_expired` /
  `signature_invalid` / `signature_mismatch`) for receiver-side logging,
  but **never echoed back to the Worker** — an attacker who knows which
  leg failed can enumerate the rest.
- **Bearer + HMAC secrets live in `~/.canonry/config.yaml`.** The DB
  stores only the sha256 of the bearer (`traffic_sources.ingestTokenHash`).
  The HMAC secret never goes to the DB in any form. Both are inlined into
  the Worker script at generation time.
- **`waitUntil` for forwards.** The generated Worker uses
  `event.waitUntil(fetch(...))` so the forward never blocks the customer
  response. Errors are swallowed — AI traffic is statistical, not
  transactional; dropped events are acceptable, and surfacing the failure
  would mask the customer response.
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

## Common Mistakes

- **Echoing the verifier's failure reason in the HTTP response.** Use a
  single 401 envelope; do not let the Worker (or anything else) learn
  which leg of the auth failed.
- **Putting the HMAC secret in `traffic_sources.configJson`.** Both
  shared secrets belong in `~/.canonry/config.yaml`; only the bearer hash
  goes to the DB.
- **Adding bot-id or operator classification in this package.** The
  classifier lives in `packages/integration-traffic` for one-place rule
  evolution across every adapter.
- **Storing or reading the Worker bot list anywhere but `DEFAULT_BOT_LIST`.**
  The Worker is regenerated from this constant; updates must rev the
  `version` field so the staleness check picks up the drift.

## See Also

- `plans/cloudflare-worker-traffic-source.md` — design plan
- `packages/contracts/src/traffic.ts` — `cloudflareWorkerEventSchema`,
  `cloudflareWorkerIngestRequestSchema`,
  `cloudflareWorkerSourceConfigSchema`,
  `trafficConnectCloudflareRequestSchema`,
  `trafficConnectCloudflareResponseSchema`
- `packages/integration-traffic/AGENTS.md` — classifier + rollup that the
  ingest route hands off to
- `packages/integration-vercel/AGENTS.md` — sibling adapter (pull, not
  push) — mirror file layout, different delivery shape
