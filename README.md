# Canonry <img src="https://raw.githubusercontent.com/Canonry/canonry/main/apps/web/public/favicon-32.png" alt="Canonry canary icon" width="24" />

[![npm version](https://img.shields.io/npm/v/@canonry/canonry)](https://www.npmjs.com/package/@canonry/canonry) [![Node.js >= 22.14](https://img.shields.io/badge/node-%3E%3D22.14-brightgreen)](https://nodejs.org)

**Agent-first AEO operating platform. Open source. Self-hosted.**

- Track citations across Gemini, ChatGPT, Claude, Perplexity, and local LLMs
- Watch AI engines crawl and refer traffic via [server-log ingestion](skills/canonry/references/server-side-traffic.md) — Cloud Run, Vercel, and the WordPress Traffic Logger plugin today
- Diagnose against real traffic with built-in [GSC](docs/google-search-console-setup.md), [GA4](docs/google-analytics-setup.md), and [Bing Webmaster](docs/bing-webmaster-setup.md)
- Track local AEO via [Google Business Profile](skills/canonry/references/google-business-profile.md) — search-term impressions, performance metrics, and hotel lodging + booking-CTA gaps
- Manage [ChatGPT ads](docs/mcp.md#tool-surface) with OpenAI Ads Manager — connect an ad account, inspect conversion setup and performance, prepare paused campaigns, and launch only with an explicit human approval
- Discover who links to you with [Common Crawl backlinks](skills/canonry/references/canonry-cli.md#backlinks-common-crawl) — follows Common Crawl's rolling monthly hyperlink graph, auto-syncing each new window on a schedule, queried locally with DuckDB
- Execute fixes via [WordPress](docs/wordpress-setup.md), JSON-LD schema, and indexing submissions
- Manage many clients declaratively — config-as-code YAML + `cnry apply`
- Schedule recurring visibility checks, traffic syncs, and Business Profile syncs, with webhook alerts on regressions
- Generate client-ready HTML reports — `cnry report <project>`
- Drive from your own agent via the [MCP adapter](docs/mcp.md), a [native Codex or Claude Code plugin](docs/plugins.md), or webhooks
- Or use **Aero** — Canonry's built-in agent that wakes up after every run

Every dashboard view has a matching CLI command and API endpoint. The CLI is the surface; the UI consumes the same API your agent does.

![Canonry Dashboard](https://raw.githubusercontent.com/Canonry/canonry/main/docs/images/dashboard.png)

## Run your first AI visibility check in 5 minutes

```bash
npm install -g @canonry/canonry
cnry init
cnry serve
```

The CLI installs as `cnry` (short form) and `canonry` — the two are interchangeable.
The legacy package name `@ainyc/canonry` is still published at the same versions for compatibility, but new installs should use `@canonry/canonry`.

Open [http://localhost:4100/setup](http://localhost:4100/setup). A guided wizard walks you through provider keys, project setup, queries, and your first visibility check.

If you serve Canonry on `0.0.0.0` or a LAN address, complete first-run dashboard password setup from loopback first, or authenticate with a `cnry_...` bearer key. The unauthenticated setup path is loopback-only by design.

Prefer the terminal?

```bash
cnry project create my-site --domain example.com
cnry query add my-site "your first query" "second query"
cnry run my-site --wait
cnry evidence my-site
cnry insights my-site
```

To pin a project to a provider model for future sweeps, use an explicit
override. Omitting a provider keeps the project on all configured engines;
omitting its model keeps that engine on the instance setting.

```bash
cnry project update my-site --provider gemini --provider-model gemini=gemini-2.5-pro
cnry project update my-site --clear-provider-model gemini
```

## Manage ChatGPT ads with human control

Connect an OpenAI Ads Manager account to bring its account state, integrity review,
conversion pixels and event settings, campaign structure, and paid-performance
rollups into the same project as your organic AEO evidence.

```bash
cnry ads connect my-site --api-key <ads-manager-sdk-key>
cnry ads sync my-site
cnry ads account my-site
cnry ads summary my-site
```

Canonry and your agent can inspect the live account, look up geo targets, prepare
campaigns, ad groups, and ChatGPT chat-card ads in a paused state, and keep durable
operation receipts for reconciliation. Activation is deliberately separate: a human
approves one exact campaign tree, then a scoped executor may launch only that approved
tree. This keeps spend-bearing changes reviewable and recoverable instead of granting
an agent unrestricted access to your ad account. See the [MCP tool surface](docs/mcp.md#tool-surface)
for the complete agent workflow and safety model.

## Use the native Codex or Claude Code plugin

The native plugin gives your agent Canonry's operator playbooks and starts the existing `canonry-mcp` adapter. Canonry itself remains the execution and data plane.

Install the runtime. If this is the first initialization, skip the legacy per-project skill and MCP copies:

```bash
npm install -g @canonry/canonry
# First initialization only
cnry init --skip-skills --skip-mcp
```

Run `cnry init` in a private terminal: it prompts for credentials and prints the
new full-access API key once. Never paste that output into an agent chat or
shared log.

Then install the plugin for your client:

```bash
# Codex
codex plugin marketplace add Canonry/canonry
codex plugin add canonry@canonry

# Claude Code
claude plugin marketplace add Canonry/canonry
claude plugin install canonry@canonry
```

Ensure Canonry's local daemon is running, then verify that its advisory doctor
check sees the enabled plugin:

```bash
# Only when Canonry is not already running
cnry start
cnry doctor --check 'agent.skills.*' --format json
```

The plugin contains no credentials and declares no hooks or automatic provider calls. It does not expand Canonry's server-enforced key scope, but fresh `cnry init` creates a full-instance `*` key and a write-capable key makes write tools available to the client by default; a read-only key restricts the catalog to reads. Treat the default as teammate-level access to every project and shared setting on that single-tenant instance, and get explicit approval before every mutation or quota-consuming sweep. Existing `cnry skills install` and standalone MCP configuration remain supported; use one integration path per client to avoid duplicate skills or MCP servers. See the [plugin setup and security guide](docs/plugins.md).

## Or use any shell-capable coding agent

Without the native plugin, drop this into any shell-capable agent. It keeps
credential setup private and asks before each persisted or quota-consuming
operation:

```text
Set up canonry for me. Canonry is an open-source platform that tracks how AI answer engines (Gemini, ChatGPT, Claude, Perplexity) cite my site.

1. Ask me for: my domain, 3–5 queries I want to track, and which provider I want to start with (gemini / openai / claude / perplexity). Wait for my answers before proceeding.
2. Ask for approval, then run `npm install -g @canonry/canonry`.
3. Do not run `cnry init` yourself or ask me for credentials. Tell me to run `cnry init` in my own private terminal because it prompts for provider secrets and prints the new full-access API key once. Wait for me to confirm completion; never ask me to paste its output. This scaffolds config and installs the Canonry skills.
4. Read `.claude/skills/canonry/SKILL.md`, run the read-only doctor checks, and show me the exact project/domain/query changes you propose. Ask for explicit approval before creating the project or changing queries.
5. After project setup, show the provider and query count for the first sweep and ask for explicit approval for that quota-consuming run. Only then trigger it.
6. Read `.claude/skills/aero/SKILL.md` and summarize the existing mention and citation evidence. Propose the technical audit, including its page limit, and ask for separate approval before running `cnry technical-aeo run <project> --wait`; after approval, read the result with `cnry technical-aeo score <project> --format json`.
7. Open the dashboard only if I ask, then summarize what you found: mention and citation rates per provider, the top 3 gaps, and the highest-impact site issues. Ask again before drafting content, submitting URLs, editing files, publishing, or performing any other mutation or quota-consuming operation.
```

One-click copy at [canonry.ai](https://canonry.ai).

## If you get stuck

| Problem | Fix |
|---------|-----|
| No provider key configured | Open `/setup`, or grab a free [Gemini key](https://aistudio.google.com/apikey), set `GEMINI_API_KEY`, and restart `cnry serve`. |
| Why did my first audit fail? | Run `cnry doctor`, then reopen `/setup`; it checks provider keys and setup blockers before the first sweep. |
| No results after a run | Visibility checks are async — check the Runs tab or use `cnry run <project> --wait`. |
| Not sure what queries to test | Setup wizard auto-generates them; expand the basket later with `cnry discover run <project> --icp "..."` — see the [discovery methodology](skills/aero/references/aeo-discovery.md). |
| `npm install` fails on `node-gyp` | Install build tools for `better-sqlite3` ([guide](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md)). |

## Provider keys

| Provider | Key source | Env var |
|----------|-----------|---------|
| Gemini | [aistudio.google.com](https://aistudio.google.com/apikey) | `GEMINI_API_KEY` |
| OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) | `OPENAI_API_KEY` |
| Claude | [console.anthropic.com](https://console.anthropic.com/settings/keys) | `ANTHROPIC_API_KEY` |
| Perplexity | [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api) | `PERPLEXITY_API_KEY` |
| Local LLMs | Any OpenAI-compatible endpoint | `LOCAL_LLM_URL` |

Configure during `cnry init`, in the dashboard `/settings`, or as env vars.

## Documentation

| | |
|---|---|
| **Architecture & data model** | [docs/architecture.md](docs/architecture.md) · [docs/data-model.md](docs/data-model.md) |
| **Aero — built-in agent** | [skills/aero/SKILL.md](skills/aero/SKILL.md) |
| **Native plugins — Codex / Claude Code** | [docs/plugins.md](docs/plugins.md) |
| **MCP — Claude Desktop / Cursor / Codex** | [docs/mcp.md](docs/mcp.md) |
| **Integrations** | [GSC](docs/google-search-console-setup.md) · [GA4](docs/google-analytics-setup.md) · [Bing](docs/bing-webmaster-setup.md) · [Google Business Profile](skills/canonry/references/google-business-profile.md) · [WordPress](docs/wordpress-setup.md) · [Server-side traffic (Cloud Run + Vercel + WordPress logs)](skills/canonry/references/server-side-traffic.md) |
| **Deployment** — Docker, Railway, Render, systemd, Tailscale | [docs/deployment.md](docs/deployment.md) |
| **API** — 118+ endpoints | `GET /api/v1/openapi.json` (no auth) |
| **Standalone skills bundle** for Claude Code / Codex | `cnry skills install` ([details](skills/canonry/SKILL.md)) |
| **Roadmap & ADRs** | [docs/roadmap.md](docs/roadmap.md) · [docs/adr/](docs/adr/) |
| **All docs** | [docs/README.md](docs/README.md) |

## Requirements

Node.js ≥ 22.14.0. At least one provider API key.

## Contributing

```bash
git clone https://github.com/Canonry/canonry.git && cd canonry
pnpm install && pnpm run typecheck && pnpm run test && pnpm run lint
```

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[FSL-1.1-ALv2](./LICENSE). Free to use, modify, and self-host. Each version converts to Apache 2.0 after two years.
