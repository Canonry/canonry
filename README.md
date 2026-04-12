# Canonry <img src="apps/web/public/favicon-32.png" alt="Canonry canary icon" width="24" />

[![npm version](https://img.shields.io/npm/v/@ainyc/canonry)](https://www.npmjs.com/package/@ainyc/canonry) [![License: FSL-1.1-ALv2](https://img.shields.io/badge/License-FSL--1.1--ALv2-blue.svg)](https://fsl.software/) [![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

Canonry is an agent-first AEO platform powered by [OpenClaw](https://openclaw.ai). It tracks how ChatGPT, Gemini, Claude, and Perplexity cite your site, detects regressions, diagnoses causes, coordinates fixes, and reports results.

AEO (Answer Engine Optimization) is about making sure your content shows up accurately in AI-generated answers. As search shifts from links to synthesized responses, you need something that can monitor, analyze, and act across these engines continuously.

![Canonry Dashboard](docs/images/dashboard.png)

## Getting Started

```bash
npm install -g @ainyc/canonry
canonry agent setup
```

One command. It installs [OpenClaw](https://openclaw.ai), configures the agent's LLM, sets up monitoring providers, and seeds the workspace. Interactive prompts guide you through everything, or pass flags for fully automated setup:

```bash
canonry agent setup --gemini-key <key> --agent-key <key> --format json
```

Then start the agent and server:

```bash
canonry serve &
canonry agent start
```

Open [http://localhost:4100](http://localhost:4100) for the web dashboard. The agent runs in the background, ready to orchestrate sweeps and act on results.

### Monitoring only (no agent)

If you just want the monitoring layer without the autonomous agent:

```bash
npm install -g @ainyc/canonry
canonry init
canonry serve
```

## What the Agent Does

The Canonry agent ("Aero") is an [OpenClaw](https://openclaw.ai)-powered operator:

- **Monitors** visibility sweeps across providers on schedule, tracking citation changes over time
- **Analyzes** regressions, emerging opportunities, and correlates visibility shifts with site changes
- **Operates** across your content, schema markup, indexing submissions, and `llms.txt` to coordinate fixes and generate action-oriented reports
- **Remembers** client context across sessions: canonical domains, historical patterns, known issues

Every action the agent takes goes through the same CLI and API available to everyone. No special SDK, no hidden state.

## Features

- **Agent-operated.** The OpenClaw agent monitors, analyzes, and acts autonomously. Humans supervise via the dashboard.
- **Multi-provider.** Query Gemini, OpenAI, Claude, Perplexity, and local LLMs from a single platform.
- **Config-as-code.** Kubernetes-style YAML files. Version control your monitoring, let agents apply changes declaratively.
- **Self-hosted.** Runs locally with SQLite. No cloud account required.
- **Full API parity.** REST API and CLI cover 100% of functionality. `--format json` on every command.
- **Integrations.** Google Search Console, Google Analytics 4, Bing Webmaster Tools, WordPress.
- **Location-aware.** Project-scoped locations for geo-targeted monitoring.
- **Scheduled monitoring.** Cron-based recurring runs with webhook notifications.

## How It Works

The agent uses the same CLI and API that humans do. A typical cycle:

```bash
canonry apply canonry.yaml --format json         # define projects from YAML specs
canonry run my-project --wait --format json       # sweep all providers
canonry evidence my-project --format json         # inspect citation evidence
canonry insights my-project --format json         # get agent-generated analysis
canonry health my-project --format json           # visibility health snapshot
```

The agent runs these automatically on schedule, detects changes, and generates reports. You can run the same commands manually at any time.

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

| Method | Path | Description |
|--------|------|-------------|
| `PUT` | `/api/v1/projects/{name}` | Create or update a project |
| `POST` | `/api/v1/projects/{name}/runs` | Trigger a visibility sweep |
| `GET` | `/api/v1/projects/{name}/timeline` | Per-keyword citation history |
| `GET` | `/api/v1/projects/{name}/snapshots/diff` | Compare two runs |
| `POST` | `/api/v1/apply` | Config-as-code apply |
| `GET` | `/api/v1/openapi.json` | OpenAPI spec (no auth required) |

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

The agent learns how to operate canonry through bundled [OpenClaw skills](https://clawhub.dev) that cover CLI commands, provider setup, analysis workflows, and troubleshooting. Skills are seeded into the agent workspace during `canonry agent setup`.

**Claude Code** also picks up the skill automatically from `.claude/skills/canonry-setup/` when you open this repo. **ClawHub** hosts the same skill at [clawhub.dev](https://clawhub.dev) for any MCP-equipped agent.

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

- Node.js >= 20
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
