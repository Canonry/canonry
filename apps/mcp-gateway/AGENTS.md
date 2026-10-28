# MCP gateway

This app is deployed independently from Canonry instances. It owns routing,
outer OAuth grants, encrypted upstream credentials, and transport sessions.
Instances remain authoritative for user identity, roles, permissions and data.

- Resolve upstream destinations from the operator registry and authenticated
  grant only. Never accept an endpoint, tenant override, or upstream bearer in
  tool arguments or arbitrary headers.
- Keep outer and upstream issuers, audiences, state, PKCE and token families
  separate. Identity is `(tenant ID, immutable instance user ID)`, never email.
- Use `oidc-provider` for outer OAuth and the official MCP SDK for transport.
  Do not replace library security checks with custom token/PKCE implementations.
- Forward the full supported read-only catalog. The synthetic reviewer account
  uses the same path. Never add business tools or a reviewer authorization bypass.
- The sole gateway-owned tool, `canonry_gateway_profile`, wraps authenticated
  connection identity for the OpenAI profile contract. Its persisted opaque ID
  is stable per tenant/user across grants and display changes. It accepts no
  identity input and implements no business operation.
- Recheck current grant and instance authority for each request. Process-local
  MCP sessions are transport state, never an authorization boundary.
- Refresh may require an upstream session reinitialization. Retry only proven
  read operations; never replay a mutation or expand `research.run` authority.
- Durable credentials are encrypted with externally provisioned keys. Never log
  bodies, tokens, cookies, authorization codes, PKCE verifiers or full URLs.
- SQLite deployment is one active replica with a durable volume. A rolling
  multi-replica deployment requires a different tested persistence/lease model.
- Keep environment parsing in `packages/config`. Never read the operator's
  `~/.canonry` config from this app or its tests.
- Consent presentation follows `DESIGN.md` without the dashboard runtime. Keep
  assets local, styles nonce-authorized and controls usable without JavaScript.
  Verify packaged assets and desktop/mobile OAuth flows after presentation changes.
- Integration validation uses two actual isolated Canonry fixtures and no paid
  provider calls. Read the repository test-audit skill before changing tests.
