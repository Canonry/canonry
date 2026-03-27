# Canonry Docs Index

Start here when you need to understand what is implemented today, what is planned next, and which architectural decisions are already settled.

Canonry is API-first. The API is the source of truth, the CLI is the standard operator surface, and the web UI is a secondary consumer for human analysts.

## Repo Narrative Docs

| Document | Label | Audience | Purpose |
| --- | --- | --- | --- |
| [`README.md`](../README.md) | current | users, operators | Product overview, quickstart, key CLI/API entrypoints |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | current | contributors | Setup, workspace structure, and contribution rules |
| [`CLAUDE.md`](../CLAUDE.md) | current | agents, maintainers | Repo operating guidance and implementation priorities |

## Current Reference And Guides

| Document | Label | Audience | Purpose |
| --- | --- | --- | --- |
| [`architecture.md`](architecture.md) | current | engineers | Current local architecture and planned deployment shape |
| [`deployment.md`](deployment.md) | current | operators | Current deployment and runtime guidance |
| [`testing.md`](testing.md) | current | contributors | Validation and test workflow guidance |
| [`providers/gemini.md`](providers/gemini.md) | current | engineers | Gemini provider behavior and constraints |
| [`providers/openai.md`](providers/openai.md) | current | engineers | OpenAI provider behavior and constraints |
| [`providers/claude.md`](providers/claude.md) | current | engineers | Claude provider behavior and constraints |
| [`providers/local.md`](providers/local.md) | current | engineers | Local provider behavior and constraints |
| [`google-search-console-setup.md`](google-search-console-setup.md) | current | operators | Google Search Console OAuth setup and usage |
| [`bing-webmaster-setup.md`](bing-webmaster-setup.md) | current | operators | Bing Webmaster Tools API key setup and usage |
| [`google-analytics-setup.md`](google-analytics-setup.md) | current | operators | Google Analytics 4 service account setup and usage |
| [`wordpress-setup.md`](wordpress-setup.md) | current | operators | WordPress REST + Application Password setup, staging diffs, and manual handoff workflows |

## Product Direction

| Document | Label | Audience | Purpose |
| --- | --- | --- | --- |
| [`roadmap.md`](roadmap.md) | roadmap | founders, maintainers | Canonical product roadmap and prioritization |

`docs/roadmap.md` is the only product roadmap. Do not treat plans or ADRs as substitutes for roadmap priority.

## Active Plans

| Document | Label | Audience | Purpose |
| --- | --- | --- | --- |
| [`../plans/deployment-parity.md`](../plans/deployment-parity.md) | active plan | engineers, operators | Bring local, Docker, and hosted deployment paths into parity |
| [`../plans/optimize-ai-calls.md`](../plans/optimize-ai-calls.md) | active plan | engineers | Reduce provider cost and unnecessary repeat calls |

Plans describe implementation work. They are not current-behavior reference docs.

## ADR Index

| ADR | Label | Purpose |
| --- | --- | --- |
| [`0001-root-package-workspace.md`](adr/0001-root-package-workspace.md) | ADR | Keep `@ainyc/aeo-audit` as an external dependency |
| [`0002-separate-score-families.md`](adr/0002-separate-score-families.md) | ADR | Keep technical readiness and answer visibility as separate score families |
| [`0003-provider-throttling-and-quotas.md`](adr/0003-provider-throttling-and-quotas.md) | ADR | Use conservative provider throttling and quota defaults |
| [`0004-local-llm-provider.md`](adr/0004-local-llm-provider.md) | ADR | Support local LLMs via an OpenAI-compatible provider |
| [`0005-distributed-node-hub-architecture.md`](adr/0005-distributed-node-hub-architecture.md) | ADR | Define the long-term distributed node and hub architecture |
| [`0006-location-aware-tracking.md`](adr/0006-location-aware-tracking.md) | ADR (superseded) | Historical proposal for keyword-scoped location tracking |
| [`0007-project-scoped-location-context.md`](adr/0007-project-scoped-location-context.md) | ADR | Keep locations project-scoped and use them as run context |

## Reading Order

1. Read [`README.md`](../README.md) for product context and quickstart.
2. Read [`architecture.md`](architecture.md) for the current shape of the system.
3. Read [`roadmap.md`](roadmap.md) for product direction and priorities.
4. Use the provider, deployment, and testing docs for current implementation details.
5. Read ADRs when you need durable architectural rationale.
