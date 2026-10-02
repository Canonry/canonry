# Personal Aero with a Managed ChatGPT account

Managed account sign-in and ChatGPT plan consent belong to the Managed host.
The engine accepts a short-lived encrypted inference grant alongside the usual
instance-administrator API credential. The grant binds one person, connection,
project, model and operation; it cannot authorize API calls or broaden tool scope.

Set the host-only `CANONRY_MANAGED_INFERENCE_KEY` to a 32-byte key encoded as
64 hexadecimal characters. The key is not available through engine settings.
An enabled engine reports `managedInferenceAvailable: true` in `/health` and
`<basePath>health`. The Managed host must check this capability before prompt,
transcript or reset calls, because older engines ignore the inference header.
No capability or a false value means personal Aero is unavailable.

## Host request contract

Send `x-canonry-managed-inference: <ivHex>.<tagHex>.<ciphertextHex>` using
AES-256-GCM, a random 12-byte IV and a 16-byte authentication tag. The JSON
plaintext has exactly these fields:

```json
{
  "v": 1,
  "grantId": "a fresh UUID",
  "actorId": "Managed user ID",
  "connectionId": "ChatGPT connection ID",
  "projectName": "exact route project name",
  "modelId": "model granted to this account",
  "purpose": "turn",
  "accessToken": "current account access token",
  "expiresAt": 1790935500000
}
```

Expiry is an epoch millisecond timestamp, at most ten minutes ahead. The host
creates a fresh `grantId` for each prompt request. Turn admission consumes it in
`managed_agent_turn_grants`; a replay fails even after a restart. Expired entries
are pruned in bounded batches. Failed acquisition can consume a grant without
calling a provider, so retries need a new grant.

Use the existing routes under the configured API prefix:

| Operation | Route | Grant purpose |
| --- | --- | --- |
| Prompt | `POST /projects/:name/agent/prompt` | `turn` |
| Transcript | `GET /projects/:name/agent/transcript` | `read` |
| Reset | `DELETE /projects/:name/agent/transcript` | `read` |

Read grants omit `accessToken` and permit an empty `modelId`. They may be reused
until expiry. A turn grant cannot read or reset a transcript. A read grant cannot
generate. Malformed, expired, incorrectly encrypted or cross-project grants fail
before generation. A request carrying this header cannot access the operator's
conversation history, memory or provider list.

## Inference and isolation

Each foreground turn creates an Agent with its current account token and granted
model. It sends requests to `https://api.openai.com/v1/responses` with
`store: false`, streaming enabled, developer instructions and functions inside
the `canonry` namespace. An `OPENAI_BASE_URL` proxy configured for ordinary
OpenAI API-key use cannot redirect these requests. Provider retries retain
backoff and cancellation. Upstream authentication and quota failures use the safe
`CHATGPT_AUTH_REQUIRED` and `CHATGPT_RATE_LIMITED` error prefixes; raw provider
errors and credentials are not saved or streamed.

Personal transcripts live in `managed_agent_sessions`, uniquely identified by
project, actor and connection. Reconnecting with a new connection ID starts a
separate conversation. Reset deletes only the selected personal transcript.
Older turns remain in the durable transcript, while each model request uses a
bounded window of recent whole turns.
Project operator transcripts, memory, compaction notes and follow-up queues are
not loaded or modified. Personal sessions do not wake in the background, and
access tokens remain in memory for the active turn only.

Mounted system instructions and approved read-only external MCP tools remain
available. Prompt context and execution limits retain their existing typed
contracts, including Advanced Property, Target, market and query-class evidence.
The default tool scope is read-only. An explicitly authorized `scope: "all"`
retains existing write behavior, while managed sweep restrictions always apply.

This host-to-engine protocol reuses the existing agent API and SSE contract.
Ordinary engine CLI, MCP and dashboard calls retain their API-key and session
behavior. Account OAuth, model catalog, refresh and revocation belong to the
Managed host; this protocol does not expose account tokens through an engine
CLI command, MCP tool or settings endpoint.
