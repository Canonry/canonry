# MCP adapter (`canonry-mcp`)

For MCP clients such as Claude Desktop, Codex, or custom agent shells that
prefer a typed tool catalog over shell or HTTP, the package ships a separate
`canonry-mcp` bin. It is a thin stdio adapter over `createApiClient()` — not
a parallel surface. v1 exposes a curated API tool catalog (`tool-registry.ts` holds the list and counts) — including
the `canonry_project_overview` and `canonry_search` core composites; the
catalog is split across a small **core tier** (always loaded) and the
**toolkits** listed in `CANONRY_MCP_TIERS` (`toolkits.ts`; `ads` is OpenAI / ChatGPT Ads, `google-ads` is separate) that the client
loads on demand via `canonry_load_toolkit`. The catalog coalesces enable
side effects so each `canonry_load_toolkit` call emits exactly one
`notifications/tools/list_changed`. Pass `--read-only` to surface
only the read tools, or `--eager` (or `CANONRY_MCP_EAGER=1`) to register
every tool at startup like the previous flat catalog. Auth is inherited
from `~/.canonry/config.yaml`.

Key files:
- `packages/canonry/src/mcp/server.ts` — `createCanonryMcpServer` (one client per server instance, registers core tier + meta tools)
- `packages/canonry/src/mcp/cli.ts` — stdio entrypoint + scope/eager flag parsing
- `packages/canonry/src/mcp/tool-registry.ts` — single source of truth for every API tool, each tagged with a `tier`
- `packages/canonry/src/mcp/toolkits.ts` — toolkit catalog (`CANONRY_MCP_TIERS`) consumed by `canonry_help`
- `packages/canonry/src/mcp/dynamic-catalog.ts` — `DynamicToolCatalog`: enables tools on `canonry_load_toolkit`, drives `canonry_help`
- `packages/canonry/src/mcp/openapi-classification.ts` — drift table; every published OpenAPI op is `included`, `deferred`, or `excluded-protocol`
- `packages/canonry/src/mcp/results.ts` — `withToolErrors` wrapper, `CliError` → MCP error envelope mapping
- `packages/canonry/bin/canonry-mcp.mjs` — published bin shim
- `docs/mcp.md` — install, auth, client config, safety rules, tier system, and v1 limitations

The MCP adapter must follow the boundary rules in `Surface Priority → Agent
& automation design principles → MCP adapter boundary` (rule 8 in this
file): no DB, route, job-runner, telemetry, or logger imports; never write
non-MCP data to stdout. Every new MCP tool must already exist as a public
API endpoint and CLI command — MCP is not a place to add capabilities.
MCP parity is the default for every new public API/CLI capability: either add
the matching tool, or explicitly classify the OpenAPI operation as `deferred`
or `excluded-protocol` with a short security/protocol/product rationale in
`openapi-classification.ts`. Do not silently skip MCP.

## Adapter rules

HTTP sessions bind the exact bearer and current effective scopes/project boundary,
not a user ID alone. Changed credentials or authority require re-initialization.
Research history uses the model catalog's cached-only read; live discovery stays
out of stored-evidence workflows, including on cold or expired caches.

Reject invalid MCP opening messages before minting internal OAuth keys. A failed initialization must revoke its temporary key and close its transport even if no session ID was registered.

Hosted `/api/v1/mcp` and `/api/v1/mcp/readonly` expose every tier at initialization, filtered by existing access permissions. Specialist `/api/v1/mcp/x/<toolkit>` endpoints retain core plus one toolkit. Keep hosted catalogs fixed and preserve both credential-based and endpoint-based read-only filtering.

MCP is the universal guide; skills are optional upgrades. Initialization must
route agents through `canonry_help(intent)` without requiring resources,
plugins, skills, or a local CLI. Default help stays compact; `includeCatalog`
opts into toolkit details. Return only available stored-evidence next steps and
offer loading only on progressive stdio. Guidance never grants authority.
Edit `docs/agent-operations/v1.md`, then run `pnpm guide:sync` to generate runtime
instructions, the optional MCP resource, and the Canonry skills shared by Codex
and Claude. `plugin:check` checks guide drift too. Keep public guidance limited
to vocabulary, workflow, authority, and safety; enforce permissions server-side.

`canonry-mcp` is the only MCP executable. It is allowed only as a stdio adapter over `createApiClient()` and must not import DB modules, API routes, job runners, CLI command dispatch, telemetry, or loggers. It must never write to stdout except MCP protocol frames. Add tools only when the same capability already exists through the public API/CLI, and keep input schemas tied to `packages/contracts` Zod schemas.

MCP parity is the default for every new public API/CLI capability. When adding a command or `ApiClient` method, either add the matching tool in `src/mcp/tool-registry.ts` and update `docs/mcp.md` + MCP tests, or classify the OpenAPI operation as `deferred` / `excluded-protocol` in `src/mcp/openapi-classification.ts` with a short rationale. Security-sensitive credential/token operations may be deferred, but the PR must explain the exception.

Cloudflare connect is intentionally deferred. It is a local deployment workflow that reads Canonry's local credential store. Direct push installs Worker secret bindings; Queue pull keeps its API token server-side. Do not add `canonry_traffic_connect_cloudflare` to MCP or Aero; agents may instruct the operator to run the CLI, inspect the exact zone route, attach it manually with Fail open, and pass both acknowledgement flags. Credentials and deployment material must not enter a transcript.

## Commands

```bash
canonry-mcp                                          # core tier; load toolkits on demand
canonry-mcp --read-only                              # core read tier; toolkits load read-only tools only
canonry-mcp --eager                                  # register all API tools at startup (legacy flat catalog)

# MCP client install helpers (operate on local client config files)
canonry mcp install --client claude-desktop          # merges a canonry entry into the config
canonry mcp install --client cursor --read-only      # scope to the read tools
canonry mcp config  --client codex                   # print snippet for clients without auto-install
```

## Agent workflow

MCP workflows (agent): inspect → diagnose → act. Inspect: get-project / report / property / property-evidence / visibility-stats ; diagnose: doctor / coverage-refresh / technical-aeo score ; act: query add/replace, measurement-plan publish, gsc sitemap submit (gsc-sitemap-submission), discovery promote. Start with canonry_help(intent); native skills are optional. Only progressive stdio offers canonry_load_toolkit. Permissions remain server-enforced.

## Kept out of MCP on purpose

- MCP/Aero expose task-shaped Site Health overview/page-audit/subgraph/path/changes reads; the 20k/50k Sigma layout payload stays API/dashboard-only. CLI aliases: `canonry site-health overview|pages|page-audit|structure|links|neighbors|dead-links|subgraph|path|changes`.
- Ads archive is classified `deferred`: it is irreversible and stays a human API surface.
- `canonry serve --embed` is not an `/api/v1` operation, so it has no MCP tool (same precedent as `--base-path`).
- Cloudflare connect: see "Adapter rules" above.

Aero history is exposed through five `canonry_agent_conversations_*` tools in the
agent toolkit. API/CLI implement the same operations. New requires a UUID for
retry identity. The native agent excludes new/resume/delete; HTTP enforces
instance-administrator authority on reads and writes alike.
