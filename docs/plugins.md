# Native Codex and Claude Code Plugins

Canonry's native plugin is a thin distribution layer for agent clients. It bundles the Canonry and Aero playbooks and launches the existing `canonry-mcp` stdio adapter. It does not add a second API, execution path, or credential store.

## Prerequisites

Install Node.js 22.14 or newer, then install Canonry globally so the plugin can
find `canonry-mcp` on `PATH`. A one-off `npx` invocation is not sufficient for
the native plugin. Initialize the local runtime only if it has not already been
initialized:

```bash
npm install -g @canonry/canonry
# First initialization only
cnry init --skip-skills --skip-mcp
```

`cnry init` prompts for credentials and prints the new full-access API key once.
Run it in a private terminal you control; never paste its output into an agent
chat or shared log.

The two flags prevent `cnry init` from also writing standalone skills and project-level MCP configuration. Configure provider credentials through `cnry init`, the dashboard, environment variables, or Canonry's local config. Never put secrets in a plugin manifest or commit them to the repository.

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

Fresh `cnry init` creates an instance-wide `*` key. Unless the operator replaces
that key with a narrower runtime configuration, enabling the plugin therefore
grants the client teammate-level access to every project and shared setting on
that single-tenant instance.

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
