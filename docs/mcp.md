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

There is no `canonry mcp` wrapper. Keeping MCP out of the main CLI avoids telemetry, help text, first-run hints, or command output paths that could pollute stdio.

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

v1 is curated for client usability: 43 tools total, 33 read tools in read-only mode. It covers projects, runs, snapshots, insights, health, keywords, competitors, schedules, settings, GSC reads, GA reads, run trigger/cancel, keyword and competitor updates, schedule updates, insight dismiss, and agent webhook attach/detach.

Deferred from v1: Aero ask SSE, OAuth callbacks, raw screenshots, project create/update/delete, `apply`, snapshot generation, broad admin/provider writes, Google/Bing/GA connect/sync/inspect/indexing writes, WordPress writes, CDP screenshot, generic notifications, backlinks, raw OpenAPI, and raw HTTP escape hatches.

Some write tools compose existing API calls rather than using a native atomic endpoint. `canonry_competitors_add` and the agent webhook attach/detach tools are best-effort under concurrent calls until the public API grows narrower append/remove operations for those domains.

## Safety Rules

MCP uses stdio, so any normal stdout write breaks the protocol. Code under `packages/canonry/src/mcp/` must not use `console.log`, `process.stdout.write`, CLI dispatch, telemetry, logger imports, DB imports, route imports, or job-runner imports. Tool handlers call `createApiClient()` only.

Tool input schemas are Zod schemas tied to `packages/contracts` and exposed as JSON Schema for MCP clients. Canonry API/client errors return MCP tool results with `isError: true` and a structured `{ "error": { "code", "message", "details" } }` envelope. Malformed JSON-RPC, unknown tools, and invalid tool arguments remain MCP protocol errors.
