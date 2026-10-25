# integration-cloudflare-queue

## Purpose

Cloudflare Queues HTTP pull and acknowledgement client. It converts the
Cloudflare wire envelope into typed messages for the traffic routes while
keeping API tokens, raw poison bodies, and transport details out of errors.
Database writes, source lifecycle, leases, and traffic normalization remain in
`packages/api-routes` and `packages/integration-traffic`.

## Key Files

| File | Role |
|------|------|
| `src/client.ts` | Injected-fetch pull/ack client, bounded retries, envelope decoding, poison handling, and acknowledgement validation. `getCloudflareQueueRetentionSeconds` reads the Queue's live `settings.message_retention_period` (null when unusable) so the consumer can size dedupe receipts. |
| `src/types.ts` | Public client options and decoded message/result types. |
| `src/index.ts` | Public exports. |
| `test/client.test.ts` | Wire-contract, retry, timeout, redaction, poison, and partial-ack regressions. |

## Patterns

- **Injected I/O.** Keep `fetch` and retry sleeping injectable so tests are
  deterministic and no test calls Cloudflare.
- **Bounded pull.** Cloudflare accepts at most 100 messages per pull and a
  visibility timeout up to 12 hours. Validate both before issuing a request.
- **Bounded retries.** A request times out after 30 seconds by default. Retry
  429 and 5xx responses at most three times, and cap each exponential or
  `Retry-After` delay at 30 seconds so the caller can stay within its source
  lease.
- **Content-aware decoding.** JSON bodies can be direct JSON text or base64.
  Base64 JSON uses strict UTF-8 decoding before parsing. Bytes bodies are
  base64-decoded. Text bodies remain the plain UTF-8 strings from Cloudflare.
- **Poison is ACK-able.** If a message has a usable lease but its envelope,
  body, or content type is malformed, return a poison message without its raw
  body.
- **Skip entries without leases.** Exclude a raw entry that has no usable
  lease. Increment `skippedUnleasedMessageCount`. Continue with valid entries.
- **Validate optional ACK counts.** Cloudflare can omit `ackCount` and
  `retryCount`. If a count is present, it must match the submitted leases.
- **Return safe warning telemetry.** Return `warningCount`. Do not return
  warning keys or messages. Valid warnings do not make a successful ACK fail.
  Reject a malformed warnings value with one fixed, secret-free error.
- **Secret-free failures.** Never include the bearer token, response body,
  message body, or an injected fetch error in a thrown error.

## Common Mistakes

- Parsing a `text` message as JSON or base64.
- Returning a malformed raw body with a poison message.
- Retrying an invalid request, an abort, or an upstream delay without a cap.
- Rejecting an ACK because an optional count is absent.
- Returning Cloudflare warning keys or messages.
- Adding database or source-authority behavior to this transport-only package.

## See Also

- `packages/api-routes/src/traffic.ts` — source lease, drain loop,
  commit-before-ACK, backlog persistence, and lifecycle fences.
- `packages/integration-cloudflare-worker/AGENTS.md` — shared event capture and
  Queue-producer Worker generation.
- `packages/contracts/src/traffic.ts` — Queue source configuration and traffic
  DTOs.
