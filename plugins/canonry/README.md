# Canonry Agent Plugin

This directory is an [Agent Plugins 1.0.0](https://agent-plugins.org/) package.
Portable clients discover `plugin.json`, the immediate children of `skills/`,
and `mcp.json`. The package starts the published `canonry-mcp` stdio server.

Codex consumes this root portable core and uses `.codex-plugin/` as a client
overlay and older-client fallback. Claude Code continues to use
`.claude-plugin/` with `.mcp.json`. All formats load the same generated
`canonry` and `aero` skills and the same MCP executable. Distribution and
marketplace metadata are client-owned and are not part of the portable
specification.

## Prerequisite

Install Node.js 22.14 or newer and the global Canonry runtime before you enable
the plugin. The global install keeps `canonry-mcp` on `PATH`. A one-off `npx`
invocation is not sufficient. Bootstrap the local runtime after installation:

```bash
npm install -g @canonry/canonry
cnry bootstrap
```

`cnry bootstrap` creates the local configuration, SQLite database, and default
API key. The command is safe to run again and preserves existing settings.
Provider credentials are optional, so Page Health works before you add one.

The command prints a new full-access API key once. Run it in a private terminal.
Never paste the output into an agent chat or shared log. Existing standalone
installs remain supported. The plugin never deletes or rewrites them.

After enabling the plugin, ensure Canonry's local daemon is running and verify
the live advisory plugin check:

```bash
# Only when Canonry is not already running
cnry start
cnry doctor --check 'agent.skills.*' --format json
```

`cnry start` waits for the health endpoint and refuses to start over a live
tracked daemon. A successful doctor JSON response confirms transport; inspect
individual check statuses separately because a fresh setup can still report
provider or integration warnings. The agent-skills check warns when this
plugin's cached manifest version does not match the running Canonry version.

## Safety boundary

- The plugin contains no API keys and does not read or edit
  `~/.canonry/config.yaml`; `canonry-mcp` uses the runtime's existing config.
- There are no hooks or background jobs. Sweeps, mutations, publishing, and
  paid or quota-consuming operations require explicit operator approval.
- The plugin does not expand server-enforced key scopes, but it gives the
  client MCP tools that can exercise the configured scope. Write tools are
  available by default with a write-capable key; a read-only key restricts the
  catalog to reads. A project-scoped key keeps its project route boundary, but
  a write-capable scoped key can still mutate shared instance settings.
- Fresh `cnry bootstrap` creates a full-instance `*` key. This key gives the
  client teammate-level access to every project and shared setting. A narrower
  runtime configuration reduces this access.
- Canonry remains single-tenant per local or hosted instance. The plugin is a
  client distribution layer, not a new trust boundary.

Do not hand-edit `skills/canonry/` or `skills/aero/` in this directory. Run
`pnpm plugin:sync` from the repository root after changing the canonical trees
under `skills/`, and use `pnpm plugin:check` to verify skill, portable manifest,
and client-adapter drift.
