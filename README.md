# Canonry <img src="https://raw.githubusercontent.com/Canonry/canonry/main/apps/web/public/favicon-32.png" alt="Canonry canary icon" width="24" />

[![npm version](https://img.shields.io/npm/v/@canonry/canonry)](https://www.npmjs.com/package/@canonry/canonry) [![Node.js >= 22.14](https://img.shields.io/badge/node-%3E%3D22.14-brightgreen)](https://nodejs.org)

**Agent-first AEO operating platform. Open source. Self-hosted.**

Canonry shows where AI answer engines mention and cite your brand, explains what changed, and helps your agent act on the evidence. Use it through the CLI, API, MCP, or the optional dashboard.

## Quick start

```bash
npm install -g @canonry/canonry
cnry init
cnry serve
```

Open [http://localhost:4100/setup](http://localhost:4100/setup) to create a project and run your first check. `cnry` and `canonry` are interchangeable.

## Native plugin for Codex

Install the runtime without the standalone skills or MCP config, then add the Canonry plugin:

```bash
npm install -g @canonry/canonry
cnry init --skip-skills --skip-mcp
codex plugin marketplace add Canonry/canonry
codex plugin add canonry@canonry
```

## Native plugin for Claude Code

```bash
npm install -g @canonry/canonry
cnry init --skip-skills --skip-mcp
claude plugin marketplace add Canonry/canonry
claude plugin install canonry@canonry
```

The plugin provides the Canonry and Aero skills plus the typed `canonry-mcp` tool server. It contains no credentials and starts no sweeps or background work by itself.

## Docs

- [Native plugins](docs/plugins.md)
- [MCP](docs/mcp.md)
- [Deployment](docs/deployment.md)
- [All documentation](docs/README.md)

Requires Node.js 22.14 or newer and at least one supported provider key.

[Contributing](CONTRIBUTING.md) · [License](LICENSE)
