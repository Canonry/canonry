# Canonry MCP Stdio Adapter

Canonry is CLI/API-first. MCP exists to make that same public surface easier to use from MCP clients such as Claude Desktop, Codex, and custom agent shells that prefer a tool catalog over shell commands or raw HTTP.

MCP is useful here because many agent clients can discover typed tools, validate arguments, and call them without asking the user to compose `curl` or `canonry ... --format json` invocations. It is not more authoritative than the API or CLI. `canonry-mcp` is an adapter over `createApiClient()` only, so it must not expose capabilities that do not already exist through Canonry's public API/CLI.

## Install

Install Canonry normally:

```bash
npm install -g @ainyc/canonry
```

The package exposes one MCP executable:

```bash
canonry-mcp
```

`canonry-mcp` itself stays out of the main CLI to keep stdio clean — telemetry, help text, or stray logs would corrupt the protocol. The main CLI does ship two read/write *helpers* that operate on client config files only:

```bash
canonry mcp install --client claude-desktop
canonry mcp install --client cursor --read-only
canonry mcp config  --client codex            # print snippet for clients without auto-install
```

`install` merges a `canonry` MCP server entry into the client's config (creating the file if needed, backing up the original to `<config>.canonry.bak`). It is idempotent — re-running with the same flags is a no-op. `config` prints the snippet to stdout for copy-paste or use in unsupported clients (currently Codex CLI, since it uses TOML). Both helpers accept `--name <server>` to install under a custom key, `--read-only` to scope to the 35 read tools, `--dry-run` (install only), and `--format json` for machine-readable output.

## Auth

`canonry-mcp` inherits the normal local config at `~/.canonry/config.yaml` through `createApiClient()`.

For a local server, use the same config created by `canonry init` and run `canonry serve`. For a remote API, set `apiUrl` and `apiKey` in `~/.canonry/config.yaml`. MCP adds no OAuth flow, token storage, or alternate auth path.

## Client Config

Claude Desktop:

```json
{
  "mcpServers": {
    "canonry": {
      "command": "canonry-mcp",
      "args": []
    }
  }
}
```

Read-only mode:

```json
{
  "mcpServers": {
    "canonry": {
      "command": "canonry-mcp",
      "args": ["--read-only"]
    }
  }
}
```

Codex-style TOML:

```toml
[mcp_servers.canonry]
command = "canonry-mcp"
args = []
```

## Tool Surface

v1 is curated for client usability: 60 API tools (42 read in `--read-only`) plus two meta-tools (`canonry_help`, `canonry_load_toolkit`). It covers projects, project-overview and search composites, config apply, runs, snapshots, insights, health, keyword generation and replacement, competitor add/remove, schedules, settings, GSC reads, GA reads, the doctor health-check (Google/GA auth diagnostics), run trigger/cancel, schedule updates, insight dismiss, content gap/target/source analysis, backlinks domains, durable Aero memory (list/set/forget), agent transcript clear, and agent webhook attach/detach.

`canonry_apply_config` accepts one config-as-code project document per call. For multi-document YAML or multiple project files, agents should call the tool once per project document. `canonry_keywords_generate` returns suggestions only; persist accepted suggestions with `canonry_keywords_add` or replace the tracked set with `canonry_keywords_replace`.

Deferred from v1: Aero ask SSE, OAuth callbacks, raw screenshots, project delete, snapshot generation, broad admin/provider writes, Google/Bing/GA connect/sync/inspect/indexing writes, WordPress writes, CDP screenshot, generic notifications, backlinks, raw OpenAPI, and raw HTTP escape hatches.

Some write tools compose existing API calls rather than using a native atomic endpoint. The agent webhook attach/detach tools are best-effort under concurrent calls until the public API grows narrower attach/detach operations for that domain.

`canonry_project_upsert` and `canonry_apply_config` use PUT semantics — fields omitted from the request are reset to their defaults. Pass the full intended project shape. `canonry_apply_config` accepts one project document per call; loop on the client side for multi-project configs.

## Progressive Tool Discovery

The full 60-tool catalog costs roughly 14k tokens of definitions every session. Most sessions touch a handful of tools, so `canonry-mcp` defaults to a small **core tier** (~10 tools, ~3k tokens) and registers the rest on demand via `notifications/tools/list_changed`.

Core tier (always loaded):

- `canonry_help` — list available toolkits and which are loaded
- `canonry_load_toolkit` — register a toolkit's tools for the rest of the session
- `canonry_projects_list`, `canonry_project_get`
- `canonry_project_overview` — composite read for "how is project X doing?"
- `canonry_search` — composite text search across snapshots and insights
- `canonry_doctor` — run health checks (Google/GA auth, redirect URI, scopes, providers); filter by check id or wildcard
- `canonry_settings_get`
- `canonry_apply_config`, `canonry_run_trigger`, `canonry_run_cancel`
- `canonry_agent_webhook_attach`

Toolkits (loaded on demand):

| Toolkit | What's in it | When to load |
| --- | --- | --- |
| `monitoring` | runs list/latest/get, project history, timeline, snapshots list/diff, insights list/get, health latest/history, content targets/sources/gaps | Investigating regressions, comparing runs, reviewing insights/health, surfacing content opportunities |
| `setup` | project export/upsert, keywords list/add/remove/replace/generate, competitors list/add/remove, schedule get/set/delete, insight dismiss, backlinks domains | Onboarding a project, editing keywords/competitors/schedules, reviewing backlink coverage |
| `gsc` | google connections list, GSC performance, inspections, coverage, coverage history, sitemaps, deindexed | Indexing, coverage, sitemap analysis from Google Search Console |
| `ga` | GA status, traffic, coverage, AI/social referral history, social/attribution trends, session history | Traffic, referral, attribution data from Google Analytics 4 |
| `agent` | Aero memory list/set/forget, agent clear, agent webhook detach | Reading or writing project-scoped Aero notes, clearing a stuck conversation, removing an agent webhook |

Loading a toolkit is idempotent and persists for the rest of the session; there is no unload. `canonry_load_toolkit` returns `{ status: 'loaded' \| 'already-loaded' \| 'empty', name, tools }`. The server coalesces all enable/disable side effects into one `notifications/tools/list_changed` per call, fired just before the response — so a single call refreshes the client's catalog once regardless of how many tools the toolkit contains.

#### Wait for the response before pipelining

`canonry_load_toolkit` runs the enable side effect synchronously inside the call's handler, but the newly registered tools only become callable after the response is returned to the client. Always await the response before issuing a `tools/call` for a tool that the toolkit just enabled. Pipelining the two requests on the same connection (sending `tools/call` for `canonry_insights_list` immediately after `canonry_load_toolkit` without awaiting the load response) can race the registration and produce `MCP error -32602: Tool ... disabled`. Sequenced clients (Claude Desktop, Cursor, Codex) already wait by default; only batch test harnesses or custom clients risk this.

### Eager mode

Power-user environments (scripts, Aero, telemetry harnesses) that want the flat 62-tool catalog at startup can opt back in with `--eager` (or `CANONRY_MCP_EAGER=1`):

```json
{
  "mcpServers": {
    "canonry": { "command": "canonry-mcp", "args": ["--eager"] }
  }
}
```

`--eager` and `--read-only` compose: `canonry-mcp --eager --read-only` registers every read tool eagerly.

### Read-only scope and toolkits

`--read-only` filters out write tools before the catalog is built, so toolkits with no read tools appear as `empty` from `canonry_load_toolkit`. Mixed toolkits load with whatever survives the filter — the `agent` toolkit, for example, drops its writes (`canonry_memory_set`, `canonry_memory_forget`, `canonry_agent_clear`, `canonry_agent_webhook_detach`) and exposes only `canonry_memory_list` under read-only scope.

## Safety Rules

MCP uses stdio, so any normal stdout write breaks the protocol. Code under `packages/canonry/src/mcp/` must not use `console.log`, `process.stdout.write`, CLI dispatch, telemetry, logger imports, DB imports, route imports, or job-runner imports. Tool handlers call `createApiClient()` only.

Tool input schemas are Zod schemas tied to `packages/contracts` and exposed as JSON Schema for MCP clients. Canonry API/client errors and Zod input-validation errors return MCP tool results with `isError: true` and a structured `{ "error": { "code", "message", "details" } }` envelope (`VALIDATION_ERROR` for bad input, with `details.issues` listing the per-field problems). Malformed JSON-RPC and unknown tools remain MCP protocol errors.
