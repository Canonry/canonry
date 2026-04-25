# Canonry <img src="apps/web/public/favicon-32.png" alt="Canonry canary icon" width="24" />

[![npm version](https://img.shields.io/npm/v/@ainyc/canonry)](https://www.npmjs.com/package/@ainyc/canonry) [![License: FSL-1.1-ALv2](https://img.shields.io/badge/License-FSL--1.1--ALv2-blue.svg)](https://fsl.software/) [![Node.js >= 22.14](https://img.shields.io/badge/node-%3E%3D22.14-brightgreen)](https://nodejs.org)

Canonry is an agent-first AEO operating platform. It ships a built-in AI agent — **Aero** — that reads project state, analyzes regressions, acts through a typed tool surface, and wakes up unprompted when runs complete. Users who prefer their own agent (Claude Code, Codex, custom) consume Canonry through the same CLI/API surface or subscribe via webhook. It tracks how ChatGPT, Gemini, Claude, and Perplexity cite your site, detects regressions, diagnoses causes, coordinates fixes, and reports results.

AEO (Answer Engine Optimization) is about making sure your content shows up accurately in AI-generated answers. As search shifts from links to synthesized responses, you need something that can monitor, analyze, and act across these engines continuously.

![Canonry Dashboard](docs/images/dashboard.png)

## Getting Started

```bash
npm install -g @ainyc/canonry
canonry init
canonry serve
```

Interactive prompts guide you through provider keys, or pass everything as flags:

```bash
canonry init --gemini-key <key> --openai-key <key>
canonry serve
```

Open [http://localhost:4100](http://localhost:4100) for the web dashboard. Aero's command bar sits at the bottom of every project page.

### Talking to Aero (built-in agent)

From the CLI:

```bash
# One-shot turn — Aero picks the right tools and analyzes on its own.
canonry agent ask my-project "Why did the last run fail? Recommend a fix."

# Pick a specific LLM:
ANTHROPIC_API_KEY=... canonry agent ask my-project "…" --provider anthropic
ZAI_API_KEY=...        canonry agent ask my-project "…" --provider zai
```

Aero uses whichever LLM has an API key configured in `~/.canonry/config.yaml`
or exported (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`ZAI_API_KEY`). Conversations persist across invocations per project.

Aero also wakes up **unprompted** after each run completes — analyzing the
new data and writing the result back to the project's transcript so you see
it next time you open the bar or run `canonry agent ask`.

### Bringing your own agent (webhook)

If you'd rather drive Canonry from Claude Code, Codex, or a custom agent,
wire a webhook to receive run/insight events:

```bash
canonry agent attach my-project --url https://my-agent.example.com/hooks/canonry
```

Your agent receives `run.completed`, `insight.critical`, `insight.high`, and
`citation.gained` notifications. Detach with `canonry agent detach my-project`.

## How agents use Canonry

Canonry's CLI and API are the agent interface — no special SDK, no MCP layer, no virtual filesystem. Every command supports `--format json`; every dashboard view has a matching API endpoint.

- **Monitor** visibility sweeps across providers on a schedule, tracking citation changes over time
- **Analyze** regressions, emerging opportunities, and correlations with site changes
- **Coordinate** fixes across content, schema markup, indexing submissions, and `llms.txt`
- **Report** results in a machine-readable form agents can act on

## Features

- **Built-in AI agent (Aero).** Reads state, analyzes regressions, fires write tools (`run_sweep`, `dismiss_insight`, `update_schedule`, etc.), wakes up unprompted after runs. Backed by [`pi-agent-core`](https://github.com/badlogic/pi-mono) — 15+ LLM providers, streaming first.
- **Agent-first.** Every CLI command supports `--format json`; every UI view has a matching API endpoint.
- **Multi-provider.** Query Gemini, OpenAI, Claude, Perplexity, and local LLMs from a single platform.
- **Config-as-code.** Kubernetes-style YAML files. Version control your monitoring, let agents apply changes declaratively.
- **Self-hosted.** Runs locally with SQLite. No cloud account required.
- **Full API parity.** REST API and CLI cover 100% of functionality. `--format json` on every command.
- **Integrations.** Google Search Console, Google Analytics 4, Bing Webmaster Tools, WordPress.
- **Backlinks (Common Crawl).** Workspace-level release sync via DuckDB, per-project inbound-link extraction, and an opt-in auto-extract on each new release — no third-party API key required.
- **Location-aware.** Project-scoped locations for geo-targeted monitoring.
- **Scheduled monitoring.** Cron-based recurring runs with webhook notifications.

## How It Works

A typical cycle — run manually or from an external agent:

```bash
canonry apply canonry.yaml --format json         # define projects from YAML specs
canonry run my-project --wait --format json       # sweep all providers
canonry evidence my-project --format json         # inspect citation evidence
canonry insights my-project --format json         # DB-backed insight analysis
canonry health my-project --format json           # visibility health snapshot
```

Schedule cron-based sweeps with `canonry schedule` and subscribe an agent webhook via `canonry agent attach` to act on results as they land.

## Config-as-Code

```yaml
apiVersion: canonry/v1
kind: Project
metadata:
  name: my-project
spec:
  canonicalDomain: example.com
  country: US
  language: en
  keywords:
    - best dental implants near me
    - emergency dentist open now
  competitors:
    - competitor.com
  providers:
    - gemini
    - openai
    - claude
    - perplexity
```

```bash
canonry apply canonry.yaml
canonry apply project-a.yaml project-b.yaml
```

## API

All endpoints under `/api/v1/`. Authenticate with `Authorization: Bearer cnry_...`.
The canonical, always-up-to-date surface is served at `GET /api/v1/openapi.json` (no auth required).

Canonry is **agent-first** — every dashboard view has a matching API endpoint and CLI command. The surface is grouped by domain:

| Domain | What it covers | Highlights |
|--------|----------------|------------|
| **Projects** | Create, read, update, delete projects; locations; export | `PUT /projects/{name}`, `GET /projects`, `GET /projects/{name}/export` |
| **Apply** | Config-as-code — declarative multi-project upsert | `POST /apply` |
| **Keywords / Competitors** | Per-project keyword and competitor management | `POST/DELETE /projects/{name}/keywords`, `/competitors` |
| **Runs** | Trigger, list, cancel, and inspect visibility sweeps | `POST /projects/{name}/runs`, `GET /runs`, `POST /runs/{id}/cancel` |
| **Schedules** | Cron-based recurring sweeps | `GET/PUT /projects/{name}/schedule` |
| **History / Snapshots** | Timeline + run diffs + per-keyword citation state | `GET /projects/{name}/timeline`, `/snapshots/diff`, `/history` |
| **Intelligence** | DB-backed insights + health snapshots + dismissal | `GET /projects/{name}/insights`, `/health`, `POST /insights/{id}/dismiss` |
| **Notifications** | Webhook subscriptions per project (agent or user-defined) | `GET/POST/DELETE /projects/{name}/notifications`, `POST /.../test` |
| **Analytics** | Aggregated dashboard analytics | `GET /projects/{name}/analytics` |
| **Google (GSC + OAuth)** | Search Console integration, OAuth flow, property selection, URL inspection | `/google/*`, `/projects/{name}/google/*` |
| **Google Analytics (GA4)** | Traffic, social referrals, attribution, AI referrals | `/projects/{name}/ga/*` |
| **Bing Webmaster** | Coverage, URL inspection, keyword stats | `/projects/{name}/bing/*` |
| **WordPress** | Content publishing + site management integration | `/projects/{name}/wordpress/*` |
| **CDP (ChatGPT browser provider)** | Chrome DevTools Protocol health and session status | `/cdp/*` |
| **Settings / Auth / Telemetry** | Server config, API key management, opt-in telemetry | `/settings`, `/telemetry` |
| **OpenAPI** | Full spec | `GET /openapi.json` *(no auth)* |

For the complete list of ~118 endpoints with request/response schemas, query `GET /api/v1/openapi.json` or browse the per-domain route handlers under [`packages/api-routes/src/`](packages/api-routes/src/).

## Provider Setup

Configure providers during `canonry init`, via the web dashboard at `/settings`, or with the CLI:

| Provider | Key source | CLI flag |
|----------|-----------|----------|
| Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | `--gemini-key` |
| OpenAI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | `--openai-key` |
| Claude | [console.anthropic.com](https://console.anthropic.com/settings/keys) | `--claude-key` |
| Perplexity | [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api) | `--perplexity-key` |
| Local LLMs | Any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM) | `--local-url` |

Integration setup guides: [Google Search Console](docs/google-search-console-setup.md) | [Google Analytics](docs/google-analytics-setup.md) | [Bing Webmaster](docs/bing-webmaster-setup.md) | [WordPress](docs/wordpress-setup.md)

## Skills

Canonry ships a bundled `canonry-setup` skill that turns Aero (or any Claude-powered agent) into an AEO/SEO operator. **Claude Code** picks it up automatically from `.claude/skills/canonry-setup/` when you open this repo; the same content lives under [`skills/canonry-setup/`](skills/canonry-setup/) for portable use with other harnesses.

The skill covers the end-to-end answer-engine optimization loop:

- **AEO monitoring.** Running citation sweeps across Gemini, ChatGPT, Claude, and Perplexity via `canonry run` / `canonry evidence` / `canonry status`, including how to interpret per-phrase citation state and regressions.
- **Technical SEO audits.** Driving the companion [`@ainyc/aeo-audit`](https://www.npmjs.com/package/@ainyc/aeo-audit) CLI for 14-factor scoring — structured data (JSON-LD), content depth, AI-readable files (`llms.txt`, `llms-full.txt`), E-E-A-T signals, FAQ blocks, definition blocks, H1/alt/meta hygiene.
- **Indexing diagnosis.** Google Search Console and Bing Webmaster Tools coverage, URL inspection, and one-shot submissions via `canonry google request-indexing` / `canonry bing request-indexing`.
- **Schema & content execution.** Patterns for injecting LocalBusiness/FAQPage JSON-LD, writing `llms.txt` with service-area detail, trimming keyphrase lists to high-intent queries, and handling WordPress/Elementor specifics (REST API, Application Passwords, Elementor Custom Code).
- **Diagnose → prioritize → execute → monitor → report workflow.** Opinionated defaults for new sites (0 citations), regressions on established sites, and county-level targeting — with guardrails like "never fabricate citation data" and "back up `~/.canonry/config.yaml` before editing".

See [`skills/canonry-setup/SKILL.md`](skills/canonry-setup/SKILL.md) plus the reference files under [`skills/canonry-setup/references/`](skills/canonry-setup/references/) (`canonry-cli.md`, `aeo-analysis.md`, `indexing.md`, `wordpress-integration.md`) for the full playbook. Aero loads the same material natively, so anything an external agent can do through the skill, Aero can do from the CLI or dashboard command bar.

## Deployment

See **[docs/deployment.md](docs/deployment.md)** for local, reverse proxy, sub-path, Tailscale, systemd, and Docker guides.

### Docker

```bash
docker build -t canonry .
docker run --rm -p 4100:4100 -e GEMINI_API_KEY=your-key -v canonry-data:/data canonry
```

Published images: [Docker Hub](https://hub.docker.com/repository/docker/arberx/canonry) | [GHCR](https://github.com/ainyc/canonry/pkgs/container/canonry)

### Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/ENziH9?referralCode=0vODBs&utm_medium=integration&utm_source=template&utm_campaign=generic)

Click deploy, add a volume at `/data`, generate a domain. No env vars required to start. Configure providers via the dashboard.

### Render

Create a Web Service with runtime Docker, attach a disk at `/data`. Health check: `/health`.

## Requirements

- Node.js >= 22.14.0
- At least one provider API key (configurable after startup)

If `npm install` fails with `node-gyp` errors, install build tools for `better-sqlite3`: `xcode-select --install` (macOS), `apt-get install python3 make g++` (Debian), or see the [troubleshooting guide](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md).

## Development

```bash
git clone https://github.com/ainyc/canonry.git
cd canonry
pnpm install
pnpm run typecheck && pnpm run test && pnpm run lint
```

See [docs/README.md](docs/README.md) for the full architecture, roadmap, ADR index, and doc map.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[FSL-1.1-ALv2](./LICENSE). Free to use, modify, and self-host. Each version converts to Apache 2.0 after two years.

---

Built by [AI NYC](https://ainyc.ai)
