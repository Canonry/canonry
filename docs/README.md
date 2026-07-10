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

## Current Reference And Guides

| Document | Label | Audience | Purpose |
| --- | --- | --- | --- |
| [`architecture.md`](architecture.md) | current | engineers | System architecture, dependency graph, run lifecycle, provider system |
| [`data-model.md`](data-model.md) | current | engineers | ER diagram, table groups, JSON column shapes |
| [`deployment.md`](deployment.md) | current | operators | Current deployment and runtime guidance |
| [`testing.md`](testing.md) | current | contributors | Validation and test workflow guidance |
| [`mcp.md`](mcp.md) | current | operators, agent users, contributors | MCP stdio adapter rationale, setup, auth model, safety rules, and limitations |
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

## Product Direction

| Document | Label | Audience | Purpose |
| --- | --- | --- | --- |
| [`gtm.md`](gtm.md) | launch plan | founders, maintainers | GTM launch sequencing, success metrics, per-agent distribution |

Implementation plans and design rationale live in PR descriptions, not in the repo — a plan doc goes stale the day its PR merges, while the PR record stays attached to the change that realized it. Durable behavior rules live in the per-package `AGENTS.md` files.

## Reading Order

1. Read [`README.md`](../README.md) for product context and quickstart.
2. Read [`architecture.md`](architecture.md) for the current shape of the system.
3. Use the provider, deployment, and testing docs for current implementation details.
