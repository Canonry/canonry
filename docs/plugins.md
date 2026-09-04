# Portable Agent Plugin with Codex and Claude Code adapters

Canonry's plugin targets the [Agent Plugins 1.0.0 format](https://agent-plugins.org/). The portable core is `plugins/canonry/plugin.json`, `skills/`, and `mcp.json`. It bundles the Canonry and Aero playbooks and launches the existing `canonry-mcp` stdio adapter. It does not add a second API, execution path, or credential store.

Codex consumes the root Agent Plugins core today and uses
`.codex-plugin/plugin.json` as a client overlay and older-client fallback.
Claude Code distribution still uses `.claude-plugin/plugin.json` plus the
legacy `.mcp.json`. The portable files are canonical; the compatibility files
are generated adapters. Marketplaces remain client-owned and intentionally
outside the Agent Plugins specification.

## Codex brand assets

The plugin tile Codex renders comes from `interface` in
`.codex-plugin/plugin.json`: `logo`, `logoDark`, `composerIcon`, and
`brandColor`. Without them Codex substitutes a generated placeholder icon. The
assets themselves live in `plugins/canonry/assets/` and are the canonry.ai
canary on a rounded tile — ink `#1C1413` on paper `#FFFAED` for light surfaces
and the inverse for dark, with `brandColor` set to the canonry.ai accent
`#940000`. They are a filled tile rather than a bare glyph because the mark is
monochrome and would disappear against a matching client theme.

These keys are client-only. The portable `plugin.json` is closed to the Agent
Plugins field set (`scripts/sync-canonry-plugin.mjs` rejects anything else), and
`syncClientAdapters` only rewrites the eight shared metadata fields, so the
`interface` block survives `pnpm plugin:sync` untouched. Changing an asset still
needs a version bump: clients key their update check off the manifest version
and pin the cache by version (`~/.codex/plugins/cache/canonry/canonry/<version>/`).

## Prerequisites

Install Node.js 22.14 or newer. Then install Canonry globally so the plugin can
find `canonry-mcp` on `PATH`. A one-off `npx` invocation is not sufficient.
Bootstrap the local runtime after installation:

```bash
npm install -g @canonry/canonry
cnry bootstrap
```

`cnry bootstrap` creates the local configuration, SQLite database, and default
API key. The command is safe to run again and preserves existing settings.
Provider credentials are optional, so Page Health works before you add one.

The command prints a new full-access API key once. Run it in a private terminal.
Never paste the output into an agent chat or shared log. Add provider credentials
later through the dashboard, environment variables, or Canonry's local configuration.
Never put secrets in a plugin manifest or commit them to the repository.

## Install for Codex

Add the Canonry repository marketplace, then install the plugin:

```bash
codex plugin marketplace add Canonry/canonry
codex plugin add canonry@canonry
```

## Install for Claude Code

Add the same repository as a Claude Code marketplace, then install the plugin:

```bash
claude plugin marketplace add Canonry/canonry
claude plugin install canonry@canonry
```

Both clients install from their own marketplace manifest in this repository.
Those catalogs point at the same portable plugin directory.
Ensure Canonry's local daemon is running, then verify the live advisory plugin
check:

```bash
# Only when Canonry is not already running
cnry start
cnry doctor --check 'agent.skills.*' --format json
```

`cnry start` waits for the health endpoint before returning and refuses to
start over a live tracked daemon. A successful doctor JSON response confirms
transport; inspect each check's status separately because provider or
integration checks may legitimately return `warn` or `fail` on a fresh setup.
The agent-skills check also warns when a client cache manifest version does not
match the running Canonry version; update the runtime and plugin in lockstep.

Restart or reload the client after installation if it does not discover the
plugin immediately.

Verify the installed components:

```bash
# Codex: confirm the Canonry MCP server is enabled
codex mcp list --json

# Claude Code: confirm 2 skills, 0 hooks, and 1 MCP server
claude plugin details canonry@canonry
claude mcp list
```

Fetch and apply plugin updates explicitly:

```bash
# Keep the separately installed Canonry runtime in lockstep with the plugin
npm install -g @canonry/canonry@latest

# Codex
codex plugin marketplace upgrade canonry
codex plugin add canonry@canonry

# Claude Code
claude plugin marketplace update canonry
claude plugin update canonry@canonry

# Reload the upgraded Canonry runtime
cnry stop
cnry start
cnry doctor --check 'agent.skills.*' --format json
```

Then use `/reload-plugins` in Claude Code. In Codex, start a new task or
restart the app so the updated plugin is loaded.

## What enabling the plugin does

- Makes the Canonry and Aero skills available to the agent.
- Starts `canonry-mcp` as an MCP stdio server when the client activates the plugin.
- Reuses Canonry's public API client, local configuration, and API-key enforcement.

The plugin declares no hooks, scheduled work, monitoring loop, or automatic provider call. Starting the MCP server does not itself run a visibility sweep or incur provider cost. Existing Canonry schedules and Aero settings continue to behave as configured independently of the plugin. The plugin makes write tools available by default when Canonry is configured with a write-capable key; using them still requires explicit operator approval.

Fresh `cnry bootstrap` creates an instance-wide `*` key. This key gives the
client teammate-level access to every project and shared setting. A narrower
runtime configuration reduces this access.

## Existing skills or MCP configuration

The standalone paths remain supported:

- `cnry skills install` writes the playbooks directly into a project.
- `cnry mcp install` or `cnry mcp config` configures supported MCP clients without a plugin.

Choose one integration path per client. If a project already uses standalone skills or a `canonry` MCP entry, install and verify the native plugin before retiring the older configuration; the plugin does not overwrite or delete it. Do not keep two `canonry-mcp` entries active in the same client, because they expose duplicate tools and start duplicate server processes.

## Security boundaries

The plugin does not weaken or expand Canonry's server-enforced authorization model, but enabling it gives the client MCP tools that can exercise the configured key's scope:

- A read-only Canonry key causes `canonry-mcp` to expose only read tools.
- A project-scoped key limits project routes to that project. Instance-level settings remain shared, so this is a project boundary, not tenant isolation.
- An instance-wide key can access every project on that Canonry instance.
- Canonry remains single-tenant: run a separate service and database for each unrelated team.

The plugin never embeds a Canonry key or provider secret. Authentication is inherited from the same Canonry configuration described in the [MCP guide](mcp.md). Treat a write-capable key like teammate access to the instance. Get explicit operator approval before every mutation or quota-consuming sweep, including publishing, indexing, schedule changes, and paid operations.
