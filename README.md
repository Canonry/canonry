# Canonry <img src="apps/web/public/favicon-32.png" alt="Canonry canary icon" width="24" />

[![npm version](https://img.shields.io/npm/v/@ainyc/canonry)](https://www.npmjs.com/package/@ainyc/canonry) [![Node.js >= 22.14](https://img.shields.io/badge/node-%3E%3D22.14-brightgreen)](https://nodejs.org)

**Agent-first AEO operating platform. Open source. Self-hosted.**

- Track citations across Gemini, ChatGPT, Claude, Perplexity, and local LLMs
- Watch AI engines crawl and refer traffic via [server-log ingestion](skills/canonry-setup/references/server-side-traffic.md) — Cloud Run today, more sources coming
- Diagnose against real traffic with built-in [GSC](docs/google-search-console-setup.md), [GA4](docs/google-analytics-setup.md), and [Bing Webmaster](docs/bing-webmaster-setup.md)
- Execute fixes via [WordPress](docs/wordpress-setup.md), JSON-LD schema, and indexing submissions
- Manage many clients declaratively — config-as-code YAML + `canonry apply`
- Schedule recurring visibility checks AND traffic syncs, with webhook alerts on regressions
- Generate client-ready HTML reports — `canonry report <project>`
- Drive from your own agent via the [67-tool MCP adapter](docs/mcp.md) or webhooks
- Or use **Aero** — Canonry's built-in agent that wakes up after every run

Every dashboard view has a matching CLI command and API endpoint. The CLI is the surface; the UI consumes the same API your agent does.

![Canonry Dashboard](docs/images/dashboard.png)

## Run your first AI visibility check in 5 minutes

```bash
npm install -g @ainyc/canonry
canonry init
canonry serve
```

Open [http://localhost:4100/setup](http://localhost:4100/setup). A guided wizard walks you through provider keys, project setup, queries, and your first visibility check.

Prefer the terminal?

```bash
canonry project create my-site --domain example.com
canonry query add my-site "your first query" "second query"
canonry run my-site --wait
canonry evidence my-site
canonry insights my-site
```

## If you get stuck

| Problem | Fix |
|---------|-----|
| No provider key configured | Grab a free [Gemini key](https://aistudio.google.com/apikey), set `GEMINI_API_KEY`, restart `canonry serve`. |
| No results after a run | Visibility checks are async — check the Runs tab or use `canonry run <project> --wait`. |
| Not sure what queries to test | The setup wizard auto-generates them by analyzing your site. |
| `npm install` fails on `node-gyp` | Install build tools for `better-sqlite3` ([guide](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md)). |

## Provider keys

| Provider | Key source | Env var |
|----------|-----------|---------|
| Gemini | [aistudio.google.com](https://aistudio.google.com/apikey) | `GEMINI_API_KEY` |
| OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) | `OPENAI_API_KEY` |
| Claude | [console.anthropic.com](https://console.anthropic.com/settings/keys) | `ANTHROPIC_API_KEY` |
| Perplexity | [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api) | `PERPLEXITY_API_KEY` |
| Local LLMs | Any OpenAI-compatible endpoint | `LOCAL_LLM_URL` |

Configure during `canonry init`, in the dashboard `/settings`, or as env vars.

## Documentation

| | |
|---|---|
| **Architecture & data model** | [docs/architecture.md](docs/architecture.md) · [docs/data-model.md](docs/data-model.md) |
| **Aero — built-in agent** | [skills/aero/SKILL.md](skills/aero/SKILL.md) |
| **MCP — Claude Desktop / Cursor / Codex** | [docs/mcp.md](docs/mcp.md) |
| **Integrations** | [GSC](docs/google-search-console-setup.md) · [GA4](docs/google-analytics-setup.md) · [Bing](docs/bing-webmaster-setup.md) · [WordPress](docs/wordpress-setup.md) · [Server-side traffic (Cloud Run logs)](skills/canonry-setup/references/server-side-traffic.md) |
| **Deployment** — Docker, Railway, Render, systemd, Tailscale | [docs/deployment.md](docs/deployment.md) |
| **API** — 118+ endpoints | `GET /api/v1/openapi.json` (no auth) |
| **Skills bundle** for Claude Code / Codex | `canonry skills install` ([details](skills/canonry-setup/SKILL.md)) |
| **Roadmap & ADRs** | [docs/roadmap.md](docs/roadmap.md) · [docs/adr/](docs/adr/) |
| **All docs** | [docs/README.md](docs/README.md) |

## Requirements

Node.js ≥ 22.14.0. At least one provider API key.

## Contributing

```bash
git clone https://github.com/ainyc/canonry.git && cd canonry
pnpm install && pnpm run typecheck && pnpm run test && pnpm run lint
```

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[FSL-1.1-ALv2](./LICENSE). Free to use, modify, and self-host. Each version converts to Apache 2.0 after two years.
