# Canonry native plugin

This directory is the shared Canonry plugin for Codex and Claude Code. Both
clients load the same generated `canonry` and `aero` skills and start the
published `canonry-mcp` stdio server.

## Prerequisite

Install Node.js 22.14 or newer and the global Canonry runtime before enabling
the plugin. The global install is required so `canonry-mcp` remains on `PATH`;
a one-off `npx` invocation is not sufficient. Initialize it only if it has not
already been initialized:

```bash
npm install -g @canonry/canonry
# First initialization only
cnry init --skip-skills --skip-mcp
```

`cnry init` prompts for credentials and prints the new full-access API key once.
Run it in a private terminal you control; never paste its output into an agent
chat or shared log.

The skip flags avoid installing Canonry's legacy standalone skills and
project-level Claude MCP entry when the native plugin already provides them.
Existing standalone installs remain supported; the plugin never deletes or
rewrites them.

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
- Fresh `cnry init` creates a full-instance `*` key. Until the operator selects
  a narrower runtime configuration, the plugin therefore gives the client
  teammate-level access to every project and shared setting on that instance.
- Canonry remains single-tenant per local or hosted instance. The plugin is a
  client distribution layer, not a new trust boundary.

Do not hand-edit `skills/canonry/` or `skills/aero/` in this directory. Run
`pnpm plugin:sync` from the repository root after changing the canonical trees
under `skills/`, and use `pnpm plugin:check` to verify drift.
