# Canonry: AEO, SEO, and AI Search Operations

[Canonry](https://canonry.ai) is an open-source, agent-first Answer Engine
Optimization (AEO) platform for AI search and SEO operations. It brings AI
answer evidence, search data, Agent Readiness site audits, traffic, and
content workflows together so an agent can investigate a gap, prepare a fix,
and measure what changed.

The plugin bundles the **Canonry operator skill**, the **Aero analyst skill**,
and the local `canonry-mcp` adapter. Together they guide your agent through:

- **AI and competitor measurement:** track answer-text mentions and source-link
  citations across ChatGPT, Claude, Gemini, Perplexity, Meta, and other supported
  engines. Compare competitors while preserving branded and non-brand query scopes.
- **Search and SEO research:** investigate keyword volume, difficulty, rankings,
  and competitor gaps with DataForSEO; combine Search Console, Bing Webmaster
  Tools, and GA4 evidence with query discovery and one-off research.
- **Agent Readiness:** crawl pages, score how ready each one is for AI agents
  and answer engines, inspect findings, and review internal links.
- **AI traffic:** inspect crawler visits, user-triggered AI fetches, and
  referral arrivals from server logs.
- **Content, publishing, and indexing:** find content gaps, prepare WordPress
  drafts and structured data, publish approved content, and submit sitemaps and
  URLs to Google and Bing.
- **Ads and local search:** manage ChatGPT Ads with approval, read Google Ads
  results, and inspect Google Business Profile performance and review evidence.
- **Portfolios and ongoing checks:** work with Simple projects and Advanced
  Measurement portfolios, retaining Property, Target, market, provider, and
  query-class scope; configure schedules and webhooks when authorized.

Capabilities depend on the configured Canonry runtime, credentials, and
integrations. The API enforces permissions for every call. This plugin uses a
self-hosted instance and the operator's own provider accounts.

## Prerequisite

Install Node.js in a supported range: `>=22.23.4 <23`, `>=24.22.1 <25`, or
`>=26.12.1 <27`. Check `node --version` before installing and upgrade Node first
if it is outside these ranges. Install the global Canonry runtime before you
enable the plugin. The global install keeps `canonry-mcp` on `PATH`. A one-off
`npx` invocation is not sufficient. Bootstrap the local runtime after installation:

```bash
npm install -g @canonry/canonry
cnry bootstrap
```

`cnry bootstrap` creates the local configuration, SQLite database, and default
API key. The command is safe to run again and preserves existing settings.
Provider credentials are optional, so Agent Readiness works before you add one.

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

## Install in Hermes

To install directly from GitHub, review the source and replace the placeholder
below with its full 40-character
commit SHA. Hermes supports the plugin's directory inside the Canonry repository:

```bash
hermes plugins install 'Canonry/canonry#plugins/canonry' \
  --ref '<FULL_40_CHARACTER_COMMIT_SHA>' --enable
```

Keep `canonry-mcp` on Hermes's `PATH` and the Canonry daemon running. Hermes
loads both bundled skills and the stdio MCP declaration. Direct GitHub installs
are unreviewed sources in Hermes; a catalog listing requires a separate reviewed
commit pin.

The plugin declares its `canonry` MCP server `untrusted` to Hermes, so Hermes
asks before every tool call that is not annotated read-only: writes,
publishing, schedule and settings changes, and ad actions. Hermes's YOLO mode
and `approvals.mode: off` skip these prompts. Read-only tools run without a
prompt. A few of them read connected services live (for example Search
Console, Bing, Business Profile, and ad accounts, or `doctor`) and can count
against those services' quotas; Canonry's guidance tells the agent to ask
first, but Hermes does not enforce it. A `canonry` entry in your own Hermes
`mcp_servers` configuration replaces the plugin's server, trust level
included, so set `trust: untrusted` on it to keep the prompts.

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

## Portable package

This directory is an [Agent Plugins 1.0.0](https://agent-plugins.org/) package.
Portable clients discover `plugin.json`, the immediate children of `skills/`,
and `mcp.json`. The package starts the published `canonry-mcp` stdio server.

Codex consumes this root portable core and uses `.codex-plugin/` as a client
overlay and older-client fallback. Claude Code continues to use
`.claude-plugin/` with `.mcp.json`. All formats load the same generated
`canonry` and `aero` skills and the same MCP executable. Distribution and
marketplace metadata are client-owned and are not part of the portable
specification.

Do not hand-edit `skills/canonry/` or `skills/aero/` in this directory. Run
`pnpm plugin:sync` from the repository root after changing the canonical trees
under `skills/`, and use `pnpm plugin:check` to verify skill, portable manifest,
and client-adapter drift.
