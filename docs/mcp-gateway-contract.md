# MCP gateway upstream contract

This contract describes the engine support for a shared MCP gateway. It covers
OAuth grants, connection identity, stored reads, and both MCP protocol eras.
Deployment and live client approval remain separate from this implementation.

## Boundary

The shared gateway connects to an operator-approved Canonry instance. Its V1
upstream transport is `POST /api/v1/mcp/readonly`, with the configured base path.
The same surface serves customer instances and the synthetic review instance.
Each instance retains its users, roles, permissions, and data.

The gateway must request `read offline_access`. The instance also supports
`research.run` for existing clients. The gateway does not request that scope.
The readonly transport permits stored evidence reads only. It excludes writes,
live provider reads, research execution, and administrative mutations.
Existing stdio and other hosted endpoints retain their separate policies.

Gateway tokens and instance tokens have different audiences. The gateway keeps
instance tokens private. It never forwards a gateway bearer to an instance.
Instance selection comes from the gateway allowlist, never from a tool argument.

## Discovery and audience

Let `origin` be the origin of configured `publicUrl`. Let `basePath` be the
configured mount path, or an empty string. An example deployment uses
`origin=https://tenant.example` and `basePath=/canonry`.

| Item | Exact value or behavior |
| --- | --- |
| Transport | `${origin}${basePath}/api/v1/mcp/readonly` |
| Protected-resource metadata | `${origin}/.well-known/oauth-protected-resource${basePath}/api/v1/mcp/readonly` |
| Canonical OAuth resource | `${origin}${basePath}/api/v1/mcp` |
| Issuer | `${origin}` |
| Authorization-server metadata | `${origin}/.well-known/oauth-authorization-server` |
| Alternate server metadata | `${origin}/.well-known/oauth-authorization-server${basePath}/api/v1/mcp/readonly` |
| Authorization | `${origin}${basePath}/oauth/authorize` |
| Token | `${origin}/oauth/token` |
| Revocation | `${origin}/oauth/revoke` |
| Dynamic registration | `${origin}/oauth/register` |

Every transport segment advertises the same canonical resource. `/readonly` is
not a distinct OAuth audience. The unauthenticated transport returns 401 and a
`WWW-Authenticate: Bearer resource_metadata="..."` challenge for its segment.
Read the advertised values rather than deriving endpoints from the transport URL.

Authorization uses the existing instance sign-in and explicit consent. It accepts
only the authorization-code flow with S256 PKCE. The gateway sends the canonical
resource in authorization and token requests. Redirect URIs must match registered
values. Native loopback redirects retain their existing variable-port exception.

Predefined public and confidential clients remain supported. Dynamic registration
creates a public client with `token_endpoint_auth_method=none`. Confidential
clients authenticate with `client_secret_post`. Registration alone grants no access.

## Connection profile

`GET ${basePath}/api/v1/mcp/profile` returns:

```json
{
  "userId": "immutable-instance-local-user-id",
  "displayName": "Synthetic reader",
  "instance": {
    "issuer": "https://tenant.example",
    "resource": "https://tenant.example/canonry/api/v1/mcp"
  },
  "scopes": ["read"]
}
```

`userId` comes from the instance user record. `displayName` can change and must
not serve as an identity key. `issuer` and `resource` identify the configured
instance deployment. They are not a global user identity or a new database UUID.
The gateway keys users by configured instance identity plus `userId`.

The profile reports effective read authority only. It never returns credentials,
password fields, email assumptions, or general administrative capabilities.
It requires a named user with instance-wide read access. An ordinary API key
without a delegated user receives 403. A project-scoped key also receives 403.
An instance without configured OAuth resource identity receives 501.

This exact GET is inside the MCP authorization boundary. An MCP bearer still
cannot read ordinary REST endpoints such as `/api/v1/projects`.
CLI parity is `canonry mcp profile --format json`. MCP parity is
`canonry_mcp_profile`, using the same response and delegated identity.

## Refresh and revoke

Access tokens last one hour. Refresh tokens last 30 days. Responses retain the
existing fields `access_token`, `token_type`, `expires_in`, `refresh_token`, and
`scope`. Each authorization creates a durable grant. All token rotations and
internal delegated session keys retain that grant identity.

A refresh request includes `grant_type=refresh_token`, `refresh_token`, and the
original `client_id`. Confidential clients also include `client_secret`.
The server rejects a missing or different client ID. It consumes the refresh
token and issues its replacement in one database transaction. A token succeeds
at most once, including concurrent requests. An authenticated replay revokes the grant and returns `invalid_grant`.
The gateway must serialize refresh operations and store the new pair atomically.
A repeated request after an uncertain refresh outcome requires connection authorization.

`POST /oauth/revoke` accepts `token` and revokes the token's complete grant,
including related access tokens, refresh tokens, and delegated session keys.
Other authorizations and other users of the same OAuth client remain valid.
Unknown tokens return 200 without revealing whether a token exists.
An explicit client ID must authenticate, or revocation returns `invalid_client`.
Public clients retain token-only revocation for compatibility. Confidential clients
must send `client_id` and `client_secret`.
Deleting or revoking an OAuth client remains an explicit administrator action.

Historical tokens lack authorization lineage. The migration groups them by
client, user, resource, and scope. Revocation can therefore affect multiple old
authorizations within that group. It never crosses users. New authorizations
have separate grant identities. Reconnect to obtain a new distinct grant.
The upgrade retires old MCP internal keys that lack grant lineage; legacy clients
initialize a new session. Ordinary keys and Aero viewer keys remain unchanged.
If an older binary later writes an unlinked token, access resolution adopts its
legacy family before the transport creates a delegated key.

Current user roles and user deletion remain enforced on authenticated requests.
The gateway must not cache the profile as authorization proof.

## Modern protocol and legacy compatibility

The engine uses official SDK v2: `@modelcontextprotocol/server`, `client`, and
`core` version `2.4.0`, plus `@modelcontextprotocol/node` version `2.1.2`. It serves
`2026-07-28` sessionless requests and legacy sessions at the same URLs.

The endpoint URLs, issuer, canonical OAuth resource, profile, and grant semantics
remain the same. Route classification uses the SDK `isLegacyRequest` predicate.
Modern requests go to `createMcpHandler(factory, { legacy: 'reject' })`.
Legacy requests retain the existing session-based Streamable HTTP transport.
Host and Origin validation precede both paths.

Modern clients use `server/discover`, without `initialize` or `Mcp-Session-Id`.
Each modern request supplies the protocol and capabilities through the reserved
`params._meta` keys `io.modelcontextprotocol/protocolVersion` and
`io.modelcontextprotocol/clientCapabilities`. Client information uses the optional
`io.modelcontextprotocol/clientInfo` key. The SDK client supplies these fields.
HTTP headers include `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` when applicable. Each request authenticates independently.
The engine creates request-local authorization and adapter state. It does not
share a delegated key, catalog, or user identity across modern requests.
A modern delegated key remains valid through response streaming, then is revoked
and removed. Cleanup failures are retried on requests, sweeps, and shutdown.
OAuth-linked internal keys expire after one hour even if cleanup fails.
Shutdown closes streams before waiting for HTTP connections to drain.

SDK v2 clients can choose `versionNegotiation.mode='auto'`, `'legacy'`, or
`{ pin: '2026-07-28' }`. The gateway uses automatic negotiation or a verified
modern pin. An authorization failure must not cause a legacy fallback.
After a modern bearer refresh, the next request uses the new bearer directly.
After a legacy bearer refresh, the client initializes a new session.

A process restart does not require a modern session recovery step. OAuth grants
and revocation remain durable. Legacy process-local sessions still require
initialization after restart. A restart can reset a pooled TCP connection; a
client may retry a stored read without renegotiating a modern session.
The synthetic suites cover streaming, cancellation, authentication, restart,
and both protocol paths, including an SDK v1 client.

Official references: [SDK migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2),
[modern protocol](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28),
[legacy routing](https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients),
and [client negotiation](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions).

## Legacy MCP sessions and errors

The transport uses Streamable HTTP. Send an `initialize` request, keep the
returned `Mcp-Session-Id`, and send the negotiated `MCP-Protocol-Version` on
subsequent requests. Requests accept `application/json, text/event-stream`.

The installed SDK supports `2025-11-25`, `2025-06-18`, `2025-03-26`,
`2024-11-05`, and `2024-10-07`. `2025-11-25` is the preferred version.
These are SDK-supported versions. Live ChatGPT compatibility needs a separate
check against the gateway deployment.

A session binds the exact bearer, effective scopes, project boundary, and endpoint.
A changed bearer requires a new initialization, including after refresh.
Sessions are process-local and expire after ten idle minutes. OAuth-backed
sessions also require reinitialization after their internal key's one-hour limit.
A restart loses legacy sessions.
All available tool tiers appear at initialization. Hosted catalogs do not require
`canonry_load_toolkit`. Tools carry explicit read/write, destructive, idempotent,
and open-world annotations. The HTTP challenge and discovery carry OAuth metadata.

| Result | Gateway behavior |
| --- | --- |
| 401, missing/expired/revoked bearer | Refresh once if a valid refresh token exists. Otherwise require connection authorization. |
| `invalid_grant` on refresh | Clear the unusable token pair and require connection authorization. |
| `invalid_client` | Correct client registration or credentials before connection authorization. |
| 403 | Preserve the denial. Reauthorization must not widen the user's permissions. |
| 404, unknown/mismatched/expired MCP session | Initialize a new session with the current bearer. |
| 400, invalid opening message | Correct the protocol request. Do not loop through authorization. |
| MCP protocol or tool error | Preserve the structured error. Do not retry a forbidden operation through another endpoint. |

## Synthetic integration fixtures

The engine supplies `packages/canonry/test/mcp-gateway-fixture.ts` for isolated
instance listeners. Use `startSyntheticMcpInstance({ name, basePath?, publicOrigin? })` and
`authorizeSyntheticMcp(instance, scope?)`. Each fixture uses a temporary database,
explicit configuration, synthetic accounts and projects, and no provider credentials.
Create instances sequentially because construction temporarily selects configuration.
Set `CANONRY_TELEMETRY_DISABLED=1` and `CANONRY_DISABLE_UPDATE_CHECK=1` first.
Never pass an existing database or load the operator configuration.

The fixture returns `origin`, `resource`, `transportUrl`, `profileUrl`, `clientId`,
`redirectUri`, synthetic `user` credentials, and a real `sessionCookie`.
`authorizeSyntheticMcp` runs consent and S256 PKCE against the real OAuth routes.
`restart()` closes the server and database, then opens the same temporary database.
`close()` closes the listener and deletes the temporary directory.

The engine checks this seam in `mcp-gateway-contract.test.ts` and
`mcp-gateway-protocols.test.ts`. The companion gateway suite must also exercise its
own token storage, routing, and authorization boundaries against these listeners.

Refresh replay policy follows [RFC 9700 section 4.14.2](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2).
Revocation authentication follows [RFC 7009 section 2.1](https://www.rfc-editor.org/rfc/rfc7009.html#section-2.1).
