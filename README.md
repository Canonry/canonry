# Canonry

[![npm version](https://img.shields.io/npm/v/@ainyc/canonry)](https://www.npmjs.com/package/@ainyc/canonry) [![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0) [![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

**Open-source AEO monitoring for your domain.** Canonry tracks how AI answer engines (ChatGPT, Gemini, Claude, and others) cite or omit your website for the keywords you care about.

AEO (Answer Engine Optimization) is the practice of ensuring your content is accurately represented in AI-generated answers. As search shifts from links to synthesized responses, monitoring your visibility across answer engines is essential.

![Canonry Dashboard](docs/images/dashboard.png)

## Quick Start

```bash
npm install -g @ainyc/canonry
canonry init
canonry serve
```

Open [http://localhost:4100](http://localhost:4100) to access the web dashboard.

## Features

- **Multi-provider monitoring** -- query Gemini, OpenAI, Claude, and local LLMs (Ollama, LM Studio, or any OpenAI-compatible endpoint) from a single tool.
- **Three equal surfaces** -- CLI, REST API, and web dashboard all backed by the same API. No surface is privileged.
- **Config-as-code** -- manage projects with Kubernetes-style YAML files. Version control your monitoring setup.
- **Self-hosted** -- runs locally with SQLite. No cloud account, no external dependencies beyond the LLM API keys you choose to configure.
- **Scheduled monitoring** -- set up cron-based recurring runs to track citation changes over time.
- **Webhook notifications** -- get alerted when your citation status changes.
- **Audit logging** -- full history of every action taken through any surface.

## CLI Reference

### Setup

```bash
canonry init                        # Initialize config and database
canonry bootstrap                   # Bootstrap hosted config/database from env vars
canonry serve                       # Start server (API + web dashboard)
canonry settings                    # View/edit configuration
```

### Projects

```bash
canonry project create <name> --domain <domain> --country US --language en
canonry project list
canonry project show <name>
canonry project delete <name>
```

### Keywords and Competitors

```bash
canonry keyword add <project> "keyword one" "keyword two"
canonry keyword list <project>
canonry keyword import <project> <file.csv>

canonry competitor add <project> competitor1.com competitor2.com
canonry competitor list <project>
```

### Visibility Runs

```bash
canonry run <project>                    # Run all configured providers
canonry run <project> --provider gemini  # Run a single provider
canonry runs <project>                   # List past runs
canonry status <project>                 # Current visibility summary
canonry evidence <project>               # View citation evidence
canonry history <project>                # Per-keyword citation timeline
canonry export <project>                 # Export project as YAML
```

### Config-as-Code

```bash
canonry apply canonry.yaml          # Declarative project apply
```

### Scheduling and Notifications

```bash
canonry schedule set <project> --cron "0 8 * * *"
canonry schedule show <project>
canonry schedule enable <project>
canonry schedule disable <project>
canonry schedule remove <project>

canonry notify add <project> --url https://hooks.slack.com/...
canonry notify list <project>
canonry notify remove <project> <id>
canonry notify test <project> <id>
```

## Config-as-Code

Define your monitoring projects in version-controlled YAML files:

```yaml
apiVersion: canonry/v1
kind: Project
metadata:
  name: my-project
spec:
  displayName: My Project
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
    - local
```

Apply with the CLI or the API:

```bash
canonry apply canonry.yaml
```

```bash
curl -X POST http://localhost:4100/api/v1/apply \
  -H "Authorization: Bearer cnry_..." \
  -H "Content-Type: application/yaml" \
  --data-binary @canonry.yaml
```

The database is authoritative. Config files are input, not state.

## Provider Setup

Canonry queries multiple AI answer engines. Configure the providers you want during `canonry init`, or add them later via the settings page or API.

### Gemini

Get an API key from [Google AI Studio](https://aistudio.google.com/apikey).

### OpenAI

Get an API key from [platform.openai.com](https://platform.openai.com/api-keys).

### Claude

Get an API key from [console.anthropic.com](https://console.anthropic.com/settings/keys).

### Local LLMs

Any OpenAI-compatible endpoint works -- Ollama, LM Studio, llama.cpp, vLLM, and similar tools. Configure via CLI or API:

```bash
canonry settings provider local --base-url http://localhost:11434/v1
```

The base URL is the only required field. API key is optional (most local servers don't need one). You can also set a specific model:

```bash
canonry settings provider local --base-url http://localhost:11434/v1 --model llama3
```

> **Note:** Unless your local model has web search capabilities, responses will be based solely on its training data. Cloud providers (Gemini, OpenAI, Claude) use live web search to ground their answers, which produces more accurate citation results. Local LLMs are best used for comparing how different models perceive your brand without real-time search context.

## API

All endpoints are served under `/api/v1/`. Authenticate with a bearer token:

```
Authorization: Bearer cnry_...
```

Key endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `PUT` | `/api/v1/projects/{name}` | Create or update a project |
| `POST` | `/api/v1/projects/{name}/runs` | Trigger a visibility sweep |
| `GET` | `/api/v1/projects/{name}/timeline` | Per-keyword citation history |
| `GET` | `/api/v1/projects/{name}/snapshots/diff` | Compare two runs |
| `POST` | `/api/v1/apply` | Config-as-code apply |
| `GET` | `/api/v1/openapi.json` | OpenAPI spec (no auth required) |

## Web Dashboard

The bundled web dashboard provides five views:

- **Overview** -- portfolio-level visibility scores across all projects with sparkline trends.
- **Project** -- command center with score gauges, keyword evidence tables, and competitor analysis.
- **Runs** -- history of all visibility sweeps with per-provider breakdowns.
- **Settings** -- provider configuration, scheduling, and notification management.
- **Setup** -- guided wizard for first-time onboarding.

Access it at [http://localhost:4100](http://localhost:4100) after running `canonry serve`.

## Requirements

- Node.js >= 20
- At least one provider API key (or a local LLM endpoint)
- A C++ toolchain for building `better-sqlite3` native bindings (only needed if prebuilt binaries aren't available for your platform)

### Native dependency setup

Canonry uses `better-sqlite3` for its embedded database. Prebuilt binaries are downloaded automatically for most platforms, but if `npm install` fails with a `node-gyp` error, you need to install build tools:

**macOS:**
```bash
xcode-select --install
```

**Debian / Ubuntu:**
```bash
sudo apt-get install -y python3 make g++
```

**Alpine Linux (Docker):**
```bash
apk add --no-cache python3 make g++ gcc musl-dev
```

**Windows:**
```bash
npm install -g windows-build-tools
```

If you're running in a minimal Docker image or CI environment without these tools, the install will fail. See the [better-sqlite3 troubleshooting guide](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md) for additional help.

## Development

```bash
git clone https://github.com/ainyc/canonry.git
cd canonry
pnpm install
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run dev:web          # Run SPA in dev mode
```

## Docker Deployment

Canonry currently deploys as a **single Node.js service with a SQLite file on persistent disk**.

The repo includes a production `Dockerfile` and entry script. The default container entrypoint runs `canonry bootstrap` and then `canonry serve`.

```bash
docker build -t canonry .

docker run --rm \
  -p 4100:4100 \
  -e PORT=4100 \
  -e CANONRY_CONFIG_DIR=/data/canonry \
  -e GEMINI_API_KEY=your-key \
  -v canonry-data:/data \
  canonry
```

Keep the container to a single replica and mount persistent storage at `/data` so SQLite and `config.yaml` survive restarts.

No CORS configuration is required for this Docker setup. The dashboard and API are served by the same Canonry process on the same origin. CORS only becomes relevant if you split the frontend and API onto different domains.

## Deploy on Railway or Render

Use the **repo root** as the service root. `@ainyc/canonry` depends on shared workspace packages under `packages/*`, so deploying from a subdirectory will break the build.

### Hosted environment variables

Set at least one provider:

- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `LOCAL_BASE_URL` (plus optional `LOCAL_API_KEY` and `LOCAL_MODEL`)

Set these for hosted persistence/bootstrap:

- `CANONRY_CONFIG_DIR=/data/canonry`
- Optional `CANONRY_API_KEY=cnry_...` to pin the generated API key instead of letting bootstrap create one
- Optional `CANONRY_DATABASE_PATH=/data/canonry/data.db`

The hosted bootstrap command is idempotent. It creates `config.yaml`, creates or migrates the SQLite database, and inserts the API key row the server expects.

### Railway

Create one service from this repo using the checked-in `Dockerfile`, then attach a persistent volume mounted at `/data`.

- Add the provider and Canonry env vars in the service's **Variables** tab. Railway can also bulk import them from `.env` files or the Raw Editor.
- Leave the start command unset so Railway uses the image `ENTRYPOINT`.
- Health check: `/health`
- Recommended env: `CANONRY_CONFIG_DIR=/data/canonry`

SQLite should live on the mounted volume, so keep the service to a single instance.

### Render

Create one **Web Service** from this repo with runtime **Docker**, then attach a persistent disk mounted at `/data`.

- Add the provider and Canonry env vars in the service's **Environment** settings or an Environment Group.
- Leave the start command unset so Render uses the image `ENTRYPOINT`.
- Health check path: `/health`
- Recommended env: `CANONRY_CONFIG_DIR=/data/canonry`

Render makes Docker service env vars available at runtime and also exposes them to Docker builds as build args. This image does not use `ARG` for provider secrets, so those values are only consumed at runtime by the entry script and Canonry process.

SQLite should live on the persistent disk, so keep the service to a single instance.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup instructions.

## License

[AGPL-3.0-only](./LICENSE)

---

Built by [AI NYC](https://ainyc.ai)
