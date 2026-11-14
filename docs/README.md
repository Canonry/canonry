# Canonry Docs Index

Start here when you need to understand what is implemented today and how it fits together.

Canonry is API-first. The API is the source of truth, the CLI is the standard operator surface, and the web UI is a secondary consumer for human analysts.

## Repo Narrative Docs

| Document | Label | Audience | Purpose |
| --- | --- | --- | --- |
| [`agent-operations/v1.md`](agent-operations/v1.md) | current, versioned | agents, operators | Canonical MCP navigation, vocabulary, workflows, authority, and safety; source for optional Codex/Claude skills |
| [`README.md`](../README.md) | current | users, operators | Product overview, quickstart, key CLI/API entrypoints |
| [`public-demo.md`](public-demo.md) | current | operators | Public view-only sample dashboard, isolation, and hosting |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | current | contributors | Setup, workspace structure, and contribution rules |
| [`AGENTS.md`](../AGENTS.md) | current | Codex, Claude Code | Repo guidance optimized for Codex and Claude Code |
| [`PRODUCT.md`](../PRODUCT.md) | current | product, design, coding agents | Dashboard purpose, users, voice, and product principles |
| [`DESIGN.md`](../DESIGN.md) | current | designers, frontend contributors, coding agents | Durable dashboard hierarchy, copy, typography, controls, and review rules |

## Current Reference And Guides

| Document | Label | Audience | Purpose |
| --- | --- | --- | --- |
| [`CODEMAP.md`](CODEMAP.md) | current | engineers, agents | Key app and package files and where to start common changes |
| [`architecture.md`](architecture.md) | current | engineers | System architecture, dependency graph, run lifecycle, provider system |
| [`data-model.md`](data-model.md) | current | engineers | ER diagram, table groups, JSON column shapes |
| [`deployment.md`](deployment.md) | current | operators | Current deployment and runtime guidance |
| [`aero-evaluation.md`](aero-evaluation.md) | current | contributors | Analyst replay tests and offline evaluation of captured native turns |
| [`testing.md`](testing.md) | current | contributors | Validation and test workflow guidance |
| [`plugins.md`](plugins.md) | current | agent users | Portable Agent Plugin structure, client adapters, installation, coexistence, and security boundaries |
| [`mcp.md`](mcp.md) | current | operators, agent users, contributors | Stdio and hosted HTTP MCP setup, authentication, tool discovery, and access limits |
| [`chatgpt-sign-in.md`](chatgpt-sign-in.md) | current | operators | Sign in with ChatGPT for invited people, invitations, and Aero on a person's own ChatGPT plan |
| [`mcp-gateway-contract.md`](mcp-gateway-contract.md) | current | gateway engineers | Instance OAuth, identity, stored-read policy, modern/legacy transport, and synthetic integration contract |
| [`../apps/mcp-gateway/README.md`](../apps/mcp-gateway/README.md) | implementation | operators, reviewers | Independent remote MCP gateway, encrypted routing/auth state, deployment and synthetic review procedure |
| [`seo-data.md`](seo-data.md) | current | operators, developers | Provider-neutral SEO profiles, explicit refreshes, stored evidence and host-only financial controls |
| [`report-retirement.md`](report-retirement.md) | current | operators, agents | Canonry 7 Report retirement and replacement API, CLI, and MCP reads |
| [`competitor-landscape.md`](competitor-landscape.md) | current | operators, engineers | Pinned-first historical competitor evidence for Simple and Advanced Measurement scopes |
| [`query-visibility.md`](query-visibility.md) | current | operators, contributors | Query assignments, research promotion, market scopes, and frozen visibility results |
| [`google-marketing.md`](google-marketing.md) | current | operators, agents | Google Ads and GTM setup, conversion evidence, integrity states, live-read authority, and v1 safety boundary |
| [`batch-mode.md`](batch-mode.md) | current | operators, agents, engineers | Batch dispatch for scheduled and manual sweeps, eligibility, fills, cost, and data retention |
| [`providers/README.md`](providers/README.md) | current | engineers | Provider system overview, ProviderAdapter interface, how to add a provider |
| [`providers/model-selection.md`](providers/model-selection.md) | current | operators, engineers | Model selection and evidence rules for direct APIs and OpenRouter |
| [`providers/gemini.md`](providers/gemini.md) | current | engineers | Gemini provider behavior and constraints |
| [`providers/openrouter.md`](providers/openrouter.md) | current | engineers | Multi-model setup, sweep identity and independent evaluator roles |
| [`providers/answer-services.md`](providers/answer-services.md) | current | engineers | Shared layer for hosted search answer services: profiles, evidence, eligibility, adding a vendor |
| [`providers/openai.md`](providers/openai.md) | current | engineers | OpenAI provider behavior and constraints |
| [`providers/muse.md`](providers/muse.md) | current | operators, engineers | Muse setup, search evidence, and model tier choice |
| [`providers/claude.md`](providers/claude.md) | current | engineers | Claude provider behavior and constraints |
| [`providers/local.md`](providers/local.md) | current | engineers | Local provider behavior and constraints |
| [`providers/perplexity.md`](providers/perplexity.md) | current | engineers | Perplexity provider behavior and constraints |
| [`google-search-console-setup.md`](google-search-console-setup.md) | current | operators | Google Search Console OAuth setup and usage |
| [`bing-webmaster-setup.md`](bing-webmaster-setup.md) | current | operators | Bing Webmaster Tools API key setup and usage |
| [`google-analytics-setup.md`](google-analytics-setup.md) | current | operators | Google Analytics 4 service account setup and usage |
| [`wordpress-setup.md`](wordpress-setup.md) | current | operators | WordPress REST + Application Password setup, staging diffs, and manual handoff workflows |
| [`cloudflare-traffic-setup.md`](cloudflare-traffic-setup.md) | current | operators | Cloudflare Queue-pull server-side traffic: token scopes, queue + HTTP pull consumer, request-volume sizing, asset-exclusion and fail-open routes |
| [`server-side-traffic.md`](../skills/canonry/references/server-side-traffic.md) | current | operators | Cloudflare direct-push or Queue-pull and Cloud Run, WordPress, and Vercel pull-source setup, smoke tests, rollback, and troubleshooting |
| [`sentiment.md`](sentiment.md) | experimental | operators, contributors | Sentiment configuration, permissions, and measurement scope |

## Implementation Records

| Document | Label | Audience | Purpose |
| --- | --- | --- | --- |
| [`oss-onboarding-evaluation.md`](oss-onboarding-evaluation.md) | historical | product, design, engineers | Evaluation, decisions, and proposals from the OSS onboarding rework |
| [`technical-scopes/muse-web-search.md`](technical-scopes/muse-web-search.md) | historical | engineers | Initial Muse web search scope. See the [Muse provider guide](providers/muse.md) for current behavior. |
| [`google-business-posts-and-review-events.md`](google-business-posts-and-review-events.md) | implementation | operators, engineers | Local Posts publication and review event contracts |
| [`sentiment-validation.md`](sentiment-validation.md) | validation record | reviewers, contributors | Sentiment validation evidence and evaluation gates |

Find new plans, product direction, and design rationale in PR descriptions.
Use the current guides and per-package `AGENTS.md` files for current behavior.

## Reading Order

1. Read [`README.md`](../README.md) for product context and quickstart.
2. Read [`architecture.md`](architecture.md) for the current shape of the system.
3. Use the provider, deployment, and testing docs for current implementation details.
