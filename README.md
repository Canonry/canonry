# Canonry <img src="https://raw.githubusercontent.com/Canonry/canonry/main/apps/web/public/favicon-32.png" alt="Canonry canary icon" width="24" />

[![npm version](https://img.shields.io/npm/v/@canonry/canonry)](https://www.npmjs.com/package/@canonry/canonry)

Canonry is an **agent-first, open-source AEO operating platform.** Track AI visibility over time, investigate changes across search and traffic, and measure progress after your agent acts.

**Self-hosted, with your own provider keys.** Your dashboard and agent review the same project evidence.

[Quick start](#quick-start) · [Evidence](#explore-the-evidence) · [Actions](#act-on-the-evidence) · [Integrations](#integrations) · [Docs](#documentation)

<p align="center">
  <a href="https://raw.githubusercontent.com/Canonry/canonry/main/docs/images/measure-act.svg">
    <img src="https://raw.githubusercontent.com/Canonry/canonry/main/docs/images/measure-act.svg" alt="AI, search, analytics, and traffic sources feed Canonry on schedules or on demand. Historical evidence across multiple domains and portfolios runs from baseline through the latest checks. Your agent reads evidence and sends commands to Canonry tools, while using its own tools for code and content. Canonry publishes to WordPress, submits to Google and Bing, and supplies the dashboard, reports, and webhooks. Site changes loop back into measurement." width="100%" />
  </a>
</p>

## Quick start

<a id="or-use-any-shell-capable-coding-agent"></a>

### Start with your agent

Connect the [Agent Plugin](docs/plugins.md) or [MCP adapter](docs/mcp.md) to your own agent.

Or use [Aero](skills/aero/SKILL.md), Canonry's optional built-in agent. Aero works without an external agent. When enabled, Aero wakes after completed runs to review the evidence.

For a new installation, give your agent this setup request:

<details>
<summary>Copy the first-time setup request</summary>

```text
Help me set up Canonry for my public site.

Use the official Canonry docs:
- Agent quickstart: https://github.com/Canonry/canonry#or-use-any-shell-capable-coding-agent
- CLI reference: https://github.com/Canonry/canonry/blob/main/skills/canonry/references/canonry-cli.md
- Plugin setup: https://github.com/Canonry/canonry/blob/main/docs/plugins.md
- MCP setup: https://github.com/Canonry/canonry/blob/main/docs/mcp.md

If a Canonry installation or connected plugin/MCP is available, use it. Do not create a duplicate. Choose the connected tools or the shell path, not both. The `cnry` and `canonry` commands are interchangeable.

1. Ask for my public domain, country, and language. Do not create or scan anything yet.
2. If connected tools are available, use them for the remaining steps. For the shell path, make sure that `cnry` is on PATH. Then run `cnry --version`. If Canonry is missing, propose `npm install -g @canonry/canonry` and wait for approval. If configuration is missing, tell me to run `cnry bootstrap` in my private terminal and wait. Never ask me to paste passwords, API keys, OAuth credentials, or command output.
3. Make sure that the API or connected tool is reachable. If the shell API is unavailable, propose `cnry start`. Wait for approval. List the projects with the connected project tool or `cnry project list --format json`. Reuse a project with the same domain. Make sure that the proposed name is not assigned to a different domain. If no match exists, show the exact create operation and wait for approval.
4. Propose a bounded Site Health scan. Include `--max-pages` and the state of dead-link checking. Show the connected operation or exact `cnry technical-aeo run ... --wait --format json` command. Wait for separate approval before scanning.
5. If the run status is `completed` or `partial`, read its score and worst pages with run-pinned connected tools. For the shell path, use `cnry technical-aeo score <project> --run-id <run-id> --format json` and `cnry technical-aeo pages <project> --run-id <run-id> --sort score-asc --limit 10 --format jsonl`. If the run failed or was cancelled, inspect the run error and stop. Summarize completed evidence and propose AI Visibility setup.
6. Ask before you add queries, connect providers, start a provider-backed or quota-consuming run, edit files, or publish.
```

</details>

<a id="get-a-page-health-baseline"></a>

### Start locally

1. Install Canonry.

   ```bash
   npm install -g @canonry/canonry
   ```

2. Initialize Canonry.

   ```bash
   cnry bootstrap
   ```

3. Start Canonry.

   ```bash
   cnry serve
   ```

4. Open [http://127.0.0.1:4100/setup](http://127.0.0.1:4100/setup) and follow the setup to scan your site.

The crawl saves a Page Health baseline. AI Visibility is optional and has a separate setup.

<details>
<summary>Scan and read results from the terminal</summary>

Keep `cnry serve` active. In a second terminal, create a project and start a bounded scan:

```bash
cnry project create my-site --domain example.com --country US --language en
cnry technical-aeo run my-site --max-pages 100 --wait --format json
```

Read the run ID and status from the output. If the status is `completed` or `partial`, read evidence from that run:

```bash
cnry technical-aeo score my-site --run-id <run-id> --format json
cnry technical-aeo pages my-site --run-id <run-id> --sort score-asc --limit 10 --format jsonl
```

`--wait` polls for up to 15 minutes. If the scan remains active, use `cnry technical-aeo progress <project> --run-id <id> --format json`.
If the scan fails or is cancelled, read the error with `cnry run show <run-id> --format json`.

</details>

## Explore the evidence

Your agent and dashboard use the same project API. The dashboard makes trends, exact answers, and site findings available for human review.

<a id="add-ai-visibility-when-you-need-it"></a>

### AI visibility

Track brand mentions and citations over time, by query and answer engine. Find answers that cite competitors but omit your site.

![Canonry AI Visibility mention share trend across answer engines](https://raw.githubusercontent.com/Canonry/canonry/main/docs/images/ai-visibility-trend.png)

*Track your share of answer-engine brand mentions over time.*

![Canonry AI Visibility citation map across queries and answer engines](https://raw.githubusercontent.com/Canonry/canonry/main/docs/images/ai-visibility-diagnostics.png)

The citation map shows mention and citation coverage across queries and engines.
[Rank cited domains and pages](skills/canonry/references/canonry-cli.md#cited-source-rankings-cnry-sources), then inspect the exact answers and URLs behind each result.

<details>
<summary>Configure a provider and run visibility checks</summary>

For an existing project, configure a provider with your own key.

| Provider | Key source | Environment variable |
|---|---|---|
| Gemini | [Google AI Studio](https://aistudio.google.com/apikey) | `GEMINI_API_KEY` |
| OpenAI | [OpenAI Platform](https://platform.openai.com/api-keys) | `OPENAI_API_KEY` |
| Claude | [Anthropic Console](https://console.anthropic.com/settings/keys) | `ANTHROPIC_API_KEY` |
| Perplexity | [Perplexity settings](https://www.perplexity.ai/settings/api) | `PERPLEXITY_API_KEY` |
| Local model | Any OpenAI-compatible endpoint | `LOCAL_BASE_URL` |

Add the queries that matter to your project:

```bash
cnry query add my-site "your first query" "your second query"
cnry run my-site --wait
cnry visibility-stats my-site --by-provider
```

</details>

<a id="why-we-use-model-providers-apis-directly-not-a-router"></a>

<details>
<summary>Why Canonry uses direct provider APIs</summary>

Canonry uses direct provider APIs to capture answers, citations, and available
search details that model routers can omit. This richer data helps us measure
brand mentions and website citations accurately and explain changes in your
visibility.
[Read more about accuracy and why we chose models and direct provider API adapters individually](docs/providers/model-selection.md).

</details>

<details>
<summary>Discover questions or run one-off research</summary>

**Expand your tracked questions.** Run `cnry discover run <project> --icp "..."`. This does not change the tracked questions.
Preview a completed session with `cnry discover promote preview <project> <session-id>`. Promote only after approval.

**Research without changing tracking.** Run `cnry research run <project> "query one" "query two" --wait`.
Research saves the answers without adding queries to the tracked questions.

</details>

<a id="compare-competitors-and-measure-complex-portfolios"></a>

### Portfolios and competitors

Use [versioned measurement plans](docs/mcp.md#tool-surface) for portfolios of locations, products, or site sections.

- **Properties:** Assign queries, engines, models, and locations to each property. Keep branded and non-brand coverage separate.
- **Market groups:** Organize overlapping sets of properties, each with its own competitors.
- **Comparisons:** Compare properties, groups, engines, and locations. Open the exact answers and cited URLs behind each result.

### Search, traffic, and site health

Investigate visibility changes with evidence from search and local performance, crawler visits, AI page fetches, referrals, and conversions.
Site audits show technical findings alongside that evidence.

![Canonry Site Map graph](https://raw.githubusercontent.com/Canonry/canonry/main/docs/images/dashboard.png)

*Map crawlable pages and the internal links that connect them.*

## Act on the evidence

Your agent coordinates the work through Canonry and its own tools.

- **Improve the site:** Combine your agent's coding tools with Canonry's content, [WordPress publishing](docs/wordpress-setup.md), JSON-LD, and [indexing workflows](skills/canonry/references/indexing.md).
- **Measure after changes:** Configure [independent schedules](skills/canonry/references/canonry-cli.md#scheduling--notifications) for data syncs and checks. Compare new results with earlier evidence.
- **Report and follow up:** Generate [HTML reports or JSON evidence](skills/canonry/references/canonry-cli.md#reports). Send [webhook alerts](skills/canonry/references/canonry-cli.md#agent) to Discord, Slack, or your systems.

**An example job for your connected agent:**

> Find where competitors get cited and we don't. Use search data and the site audit to prepare a pull request or WordPress draft for review. After it ships, rerun checks and report what changed.

<a id="built-in-integrations-and-workflows"></a>

## Integrations

Connect the sources you use. Each integration adds evidence or tools to the same project workflow.

| Area | Supported integrations |
|---|---|
| **AI answers** | ChatGPT · Claude · Gemini · Perplexity · OpenAI-compatible local models |
| **Search and local** | [Google Search Console](docs/google-search-console-setup.md) · [Bing Webmaster Tools](docs/bing-webmaster-setup.md) · [Google Business Profile](skills/canonry/references/google-business-profile.md) |
| **Analytics** | [Google Analytics 4](docs/google-analytics-setup.md) |
| **Conversion measurement** | [Google Ads + Google Tag Manager](docs/google-marketing.md): read-only snapshots and declared conversion contracts |
| **Server traffic** | [Cloudflare · Vercel · Cloud Run · WordPress](skills/canonry/references/server-side-traffic.md) |
| **Backlinks** | [Common Crawl](skills/canonry/references/canonry-cli.md#backlinks-common-crawl) hyperlink releases, queried locally with DuckDB |
| **Publishing and indexing** | [WordPress](docs/wordpress-setup.md) · JSON-LD · [sitemap and URL submissions](skills/canonry/references/indexing.md) |
| **ChatGPT Ads** | [Campaign measurement, paused campaign editing, approved activation, and operation reconciliation](docs/mcp.md#tool-surface) |

<a id="deployment-and-trust-boundary"></a>
<a id="technical-surface"></a>

## Self-hosting and API

Canonry is single-tenant. Run one instance for one operator or team. Keep unrelated teams on separate instances.

The CLI and REST API are the primary interfaces. They expose measurements, diagnoses, actions, reports, and schedules.
OpenAPI is available at `GET /api/v1/openapi.json`.

See the [deployment guide](docs/deployment.md) for reverse proxies, daemon mode, Docker, systemd, and Tailscale.

## Documentation

- **Operate Canonry:** [CLI reference](skills/canonry/references/canonry-cli.md) · [Agent Plugin](docs/plugins.md) · [MCP](docs/mcp.md)
- **Use built-in Aero:** [Setup and analysis workflows](skills/aero/SKILL.md)
- **Understand the system:** [Architecture](docs/architecture.md) · [Data model](docs/data-model.md)
- **Install standalone agent skills:** `cnry skills install` ([guide](skills/canonry/SKILL.md))
- **Browse all guides:** [Documentation index](docs/README.md)

<a id="if-you-get-stuck"></a>

<details>
<summary>Troubleshoot installation, scans, and visibility results</summary>

| Problem | Next step |
|---|---|
| Site scan is still active | Read exact counters with `cnry technical-aeo progress <project> --run-id <id> --format json`. |
| Site scan failed | Read the error with `cnry run show <run-id> --format json`. Read the last phase and counters with the progress command. |
| No visibility results | Inspect existing work with `cnry runs <project> --format json`, then `cnry run show <run-id> --format json`. This does not start another paid run. |
| `npm install` fails on `node-gyp` | Install build tools for `better-sqlite3` ([guide](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md)). |

</details>

## Contributing

```bash
git clone https://github.com/Canonry/canonry.git && cd canonry
pnpm install && pnpm run typecheck && pnpm run test && pnpm run lint
```

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[FSL-1.1-ALv2](./LICENSE). Free to use, modify, and self-host. Each version converts to Apache 2.0 after two years.
