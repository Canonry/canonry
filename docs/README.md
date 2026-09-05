# Canonry Docs Index

Start here when you need to understand what is implemented today and how it fits together.

Canonry is API-first. The API is the source of truth, the CLI is the standard operator surface, and the web UI is a secondary consumer for human analysts.

## Repo Narrative Docs

| Document | Label | Audience | Purpose |
| --- | --- | --- | --- |
| [`README.md`](../README.md) | current | users, operators | Product overview, quickstart, key CLI/API entrypoints |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | current | contributors | Setup, workspace structure, and contribution rules |
| [`AGENTS.md`](../AGENTS.md) | current | Codex, Claude Code | Repo guidance optimized for Codex and Claude Code |
| [`CLAUDE.md`](../CLAUDE.md) | current | Claude Code | Claude-specific overlay (imports AGENTS.md + UI design system) |
| [`PRODUCT.md`](../PRODUCT.md) | current | product, design, coding agents | Dashboard purpose, users, voice, and product principles |
| [`DESIGN.md`](../DESIGN.md) | current | designers, frontend contributors, coding agents | Durable dashboard hierarchy, copy, typography, controls, and review rules |

## Current Reference And Guides

| Document | Label | Audience | Purpose |
| --- | --- | --- | --- |
| [`CODEMAP.md`](CODEMAP.md) | current | engineers, agents | File-level index: every `apps/` + `packages/` key file, navigation recipes, and agent efficiency tips — start here for “where is …?” |
| [`architecture.md`](architecture.md) | current | engineers | System architecture, dependency graph, run lifecycle, provider system |
| [`data-model.md`](data-model.md) | current | engineers | ER diagram, table groups, JSON column shapes |
| [`deployment.md`](deployment.md) | current | operators | Current deployment and runtime guidance |
| [`testing.md`](testing.md) | current | contributors | Validation and test workflow guidance |
| [`../apps/vals/ai-visibility-check/README.md`](../apps/vals/ai-visibility-check/README.md) | current | contributors, operators | Public Val Town sample, local Deno validation, and manual release order |
| [`../apps/vals/brand-perception-check/AGENTS.md`](../apps/vals/brand-perception-check/AGENTS.md) | current | contributors, operators | The branded-question Val: verdict-with-verbatim-evidence rules, its one-phase budget, and the release order that gates its first deploy |
| [`../packages/val-kit/AGENTS.md`](../packages/val-kit/AGENTS.md) | current | contributors | `@canonry/val-kit`: the Vals' shared host kit — module boundaries, dev vs production graph, and the manual publish gate |
| [`plugins.md`](plugins.md) | current | agent users | Portable Agent Plugin structure, client adapters, installation, coexistence, and security boundaries |
| [`mcp.md`](mcp.md) | current | operators, agent users, contributors | MCP stdio adapter rationale, setup, auth model, safety rules, and limitations |
| [`query-visibility.md`](query-visibility.md) | current | operators, contributors | Query assignments, research promotion, market scopes, and frozen visibility results |
| [`google-marketing.md`](google-marketing.md) | current | operators, agents | Google Ads and GTM setup, conversion evidence, integrity states, live-read authority, and v1 safety boundary |
| [`providers/README.md`](providers/README.md) | current | engineers | Provider system overview, ProviderAdapter interface, how to add a provider |
| [`providers/gemini.md`](providers/gemini.md) | current | engineers | Gemini provider behavior and constraints |
| [`providers/openai.md`](providers/openai.md) | current | engineers | OpenAI provider behavior and constraints |
| [`providers/claude.md`](providers/claude.md) | current | engineers | Claude provider behavior and constraints |
| [`providers/local.md`](providers/local.md) | current | engineers | Local provider behavior and constraints |
| [`providers/perplexity.md`](providers/perplexity.md) | current | engineers | Perplexity provider behavior and constraints |
| [`google-search-console-setup.md`](google-search-console-setup.md) | current | operators | Google Search Console OAuth setup and usage |
| [`bing-webmaster-setup.md`](bing-webmaster-setup.md) | current | operators | Bing Webmaster Tools API key setup and usage |
| [`google-analytics-setup.md`](google-analytics-setup.md) | current | operators | Google Analytics 4 service account setup and usage |
| [`wordpress-setup.md`](wordpress-setup.md) | current | operators | WordPress REST + Application Password setup, staging diffs, and manual handoff workflows |
| [`cloudflare-traffic-setup.md`](cloudflare-traffic-setup.md) | current | operators | Cloudflare Queue-pull server-side traffic: token scopes, queue + HTTP pull consumer, request-volume sizing, asset-exclusion and fail-open routes |
| [`server-side-traffic.md`](../skills/canonry/references/server-side-traffic.md) | current | operators | Cloudflare direct-push or Queue-pull and Cloud Run, WordPress, and Vercel pull-source setup, smoke tests, rollback, and troubleshooting |

## Implementation Records

| Document | Label | Audience | Purpose |
| --- | --- | --- | --- |
| [`oss-onboarding-evaluation.md`](oss-onboarding-evaluation.md) | implemented | product, design, engineers | Source-based evaluation and decisions for the OSS onboarding rework |

New plans, product direction, and design rationale live in PR descriptions.
The implementation record above preserves context, but it does not define
current behavior. Durable behavior rules live in the per-package `AGENTS.md`
files.

## Reading Order

1. Read [`README.md`](../README.md) for product context and quickstart.
2. Read [`architecture.md`](architecture.md) for the current shape of the system.
3. Use the provider, deployment, and testing docs for current implementation details.
