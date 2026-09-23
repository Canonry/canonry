# Canonry <img src="https://raw.githubusercontent.com/Canonry/canonry/main/apps/web/public/favicon-32.png" alt="Canonry canary icon" width="24" />

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![npm version](https://img.shields.io/npm/v/@canonry/canonry)](https://www.npmjs.com/package/@canonry/canonry)

Canonry is an **agent-first (CLI, MCP, API), open-source AEO operating platform with a comprehensive web UI.** Track AI visibility over time, investigate changes across search and traffic, and measure progress after you or your agent acts.

**Self-hosted, using SQLite, with your own (BYOK) provider keys.** The web UI and your agent see the same evidence.

[Live UI Demo](https://custom-demo.canonry.ai/projects/summit-roofing) · [Quick start](#quick-start) · [Evidence](#explore-the-evidence) · [Actions](#act-on-the-evidence) · [Integrations](#integrations) · [Docs](#documentation) · [Support](#support)

<p align="center">
  <a href="https://raw.githubusercontent.com/Canonry/canonry/main/docs/images/measure-act.svg">
    <img src="https://raw.githubusercontent.com/Canonry/canonry/main/docs/images/measure-act.svg" alt="AI, search, analytics, and traffic sources feed Canonry on schedules or on demand. Historical evidence across multiple domains and portfolios runs from baseline through the latest checks. Your agent reads evidence and sends commands to Canonry tools, while using its own tools for code and content. Canonry publishes to WordPress, submits to Google and Bing, and supplies the dashboard, reports, and webhooks. Site changes loop back into measurement." width="100%" />
  </a>
</p>

## Quick start

<a id="or-use-any-shell-capable-coding-agent"></a>

### Start with your agent

<details>
<summary>Copy the first-time setup request</summary>

```text
Help me set up Canonry for my public site.

Use the official Canonry docs:
- Agent quickstart: https://github.com/Canonry/canonry#or-use-any-shell-capable-coding-agent
- CLI reference: https://github.com/Canonry/canonry/blob/main/skills/canonry/references/canonry-cli.md
- Plugin setup: https://github.com/Canonry/canonry/blob/main/docs/plugins.md
- MCP setup: https://github.com/Canonry/canonry/blob/main/docs/mcp.md

Pick one path and stay on it. Use connected Canonry tools (plugin or MCP) only if you have them and I have not pointed you at a specific install. A connected tool runs in its own process and never sees `CANONRY_CONFIG_DIR`, `CANONRY_PORT`, or anything else you export in a shell, so it always acts on my default install. If I named a config directory, a port, or a sandbox, that is the shell path: use `cnry` and tell me which path you chose. Never mix the two in one run, and never create a duplicate project. The `cnry` and `canonry` commands are interchangeable.

1. Ask for my public domain, country, and language. Do not create or scan anything yet. Country and language are only applied when a project is created, so if you reuse an existing project, report its country and language instead of changing them.
2. Shell path only: confirm `cnry` is on PATH, then run `cnry --version`. If Canonry is missing, propose `npm install -g @canonry/canonry` and wait for approval. Then run `cnry doctor --format json`, which is the command that says whether config, database, and server are in place. `cnry --version` does not read config and succeeds on a completely unconfigured install, so it cannot answer this. If config is missing, run `cnry bootstrap` yourself: it is not interactive, takes about a second, and is safe to rerun. Do not hand it to me and wait. The interactive command is `cnry init`, which is optional provider and OAuth setup that Page Health does not need. Bootstrap prints an API key, so do not repeat its output back to me, and never ask me to paste passwords, API keys, OAuth credentials, or command output.
3. Confirm the API is reachable. `cnry doctor --format json` reports it, and any project read exits non-zero with `CONNECTION_ERROR` when it is not. If it is unreachable, propose `cnry start` and wait for approval. Use `cnry start`, which is the background daemon, and not `cnry serve`, which runs in the foreground and will block you until I stop it, even though some error messages suggest it. Stop anything you started with `cnry stop`.
4. List projects with the connected project tool or `cnry project list --format json`, and reuse one whose domain matches. Confirm the proposed name is not already assigned to a different domain. To find out whether a project has already been scanned, run `cnry technical-aeo score <project> --format json` with no `--run-id`, which reports the latest run. Read the `hasData` field, not the score: this command exits 0 and reports `aggregateScore: 0` for a project that has never been scanned, so reading the score alone would have you tell me my site scored zero. If `hasData` is true and `runStatus` is `completed` or `partial`, read that scan instead of starting a new one. If no project matches, show the exact create operation and wait for approval.
5. Propose a bounded Site Health scan: `--max-pages 100` for a first look, plus whether dead-link checking is on (it is off unless you pass `--check-dead-links`). Show the connected operation or the exact `cnry technical-aeo run <project> --max-pages 100 --wait --format json` command with the project name filled in, and wait for separate approval before scanning. `--wait` polls for up to 15 minutes and returns only the run id and status. If the status it returns is still `queued` or `running`, the scan has not finished: do not rerun it or report results, poll `cnry technical-aeo progress <project> --run-id <run-id> --format json` until it is terminal. If `--wait` outruns your own tool timeout first, recover the run id with `cnry technical-aeo score <project> --format json` and poll the same way.
6. When the run is `completed` or `partial`, read `cnry technical-aeo crawl <project> --run-id <run-id> --format json` first. It is the only one of these commands that carries `termination` and `complete`; the score and pages commands do not. Then read `cnry technical-aeo score <project> --run-id <run-id> --format json` and `cnry technical-aeo pages <project> --run-id <run-id> --sort score-asc --limit 10 --format jsonl`. Tell me the termination reason in plain words and whether the scan covered the whole site or stopped at a page, link, depth, or time limit. A `partial` run scored the pages it reached and not my site, so never present it as a full-site result. If it stopped early, the fix depends on the reason, so say which: a page or depth limit needs a larger budget, a time limit needs a smaller scan (a lower `--max-pages` or `--max-depth`). If the run failed or was cancelled, inspect the run error and stop.
7. Summarize only completed evidence, then propose AI Visibility setup. Ask before you add queries, connect providers, start a provider-backed or quota-consuming run, edit files, or publish.
```

</details>

### Or Use Official Claude and Codex Plugins

Connect the [Agent Plugin](docs/plugins.md) or [MCP adapter](docs/mcp.md) to your own agent.

<a id="get-a-page-health-baseline"></a>

### Or start it locally yourself

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
| Meta (Muse) | [Meta Model API](https://dev.meta.ai/) | `MUSE_API_KEY` (`MODEL_API_KEY` alias) |
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
For a configured portfolio destination, select one `--market <key>` or `--property <key>`; Canonry saves the destination with the answers without changing the query. Add paired `--template-id <id> --template-version <version>` only to preserve an already-expanded template's provenance. Research never adds queries to the tracked questions.

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
| **AI answers** | ChatGPT · Claude · Gemini · Meta (Muse) · Perplexity · OpenAI-compatible local models |
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

## Support

Join the [Canonry Discord](https://discord.gg/8K9yY7GywJ) for support and questions about Canonry.

## Contributing

```bash
git clone https://github.com/Canonry/canonry.git && cd canonry
pnpm install && pnpm run typecheck && pnpm run test && pnpm run lint
```

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE), starting with Canonry 5.0.0. Use, modify, self-host, redistribute, and build commercial products with Canonry. Keep the copyright and permission notice with copies or substantial portions of the software.

Earlier releases retain their original licenses, including any future-license grants. Dependencies and bundled assets retain their own licenses; see [third-party notices](packages/canonry/THIRD_PARTY_NOTICES.md).
