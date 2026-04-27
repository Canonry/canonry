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

`install` merges a `canonry` MCP server entry into the client's config (creating the file if needed, backing up the original to `<config>.canonry.bak`). It is idempotent — re-running with the same flags is a no-op. `config` prints the snippet to stdout for copy-paste or use in unsupported clients (currently Codex CLI, since it uses TOML). Both helpers accept `--name <server>` to install under a custom key, `--read-only` to scope to the 33 read tools, `--dry-run` (install only), and `--format json` for machine-readable output.

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

v1 is curated for client usability: 48 tools total, 33 read tools in read-only mode. It covers projects, config apply, runs, snapshots, insights, health, keyword generation and replacement, competitor add/remove, schedules, settings, GSC reads, GA reads, run trigger/cancel, schedule updates, insight dismiss, and agent webhook attach/detach.

`canonry_apply_config` accepts one config-as-code project document per call. For multi-document YAML or multiple project files, agents should call the tool once per project document. `canonry_keywords_generate` returns suggestions only; persist accepted suggestions with `canonry_keywords_add` or replace the tracked set with `canonry_keywords_replace`.

Deferred from v1: Aero ask SSE, OAuth callbacks, raw screenshots, project delete, snapshot generation, broad admin/provider writes, Google/Bing/GA connect/sync/inspect/indexing writes, WordPress writes, CDP screenshot, generic notifications, backlinks, raw OpenAPI, and raw HTTP escape hatches.

Some write tools compose existing API calls rather than using a native atomic endpoint. The agent webhook attach/detach tools are best-effort under concurrent calls until the public API grows narrower attach/detach operations for that domain.

`canonry_project_upsert` and `canonry_apply_config` use PUT semantics — fields omitted from the request are reset to their defaults. Pass the full intended project shape. `canonry_apply_config` accepts one project document per call; loop on the client side for multi-project configs.

## Safety Rules

MCP uses stdio, so any normal stdout write breaks the protocol. Code under `packages/canonry/src/mcp/` must not use `console.log`, `process.stdout.write`, CLI dispatch, telemetry, logger imports, DB imports, route imports, or job-runner imports. Tool handlers call `createApiClient()` only.

Tool input schemas are Zod schemas tied to `packages/contracts` and exposed as JSON Schema for MCP clients. Canonry API/client errors return MCP tool results with `isError: true` and a structured `{ "error": { "code", "message", "details" } }` envelope. Malformed JSON-RPC, unknown tools, and invalid tool arguments remain MCP protocol errors.
