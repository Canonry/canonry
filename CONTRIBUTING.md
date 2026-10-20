# Contributing to Canonry

Thanks for your interest in contributing! Canonry is [MIT licensed](./LICENSE) and welcomes contributions.

By submitting a contribution, you agree to license it under the project's MIT license. Submit only work you have the right to contribute, and preserve any third-party copyright and license notices.

## Setup

```bash
git clone https://github.com/Canonry/canonry.git
cd canonry
pnpm install
```

## Development

To build everything and install the `canonry` CLI globally in one step:

```bash
./canonry-install.sh
```

This runs `pnpm install`, builds all packages, and installs `canonry` globally via npm. After that, `canonry --version` should work from any directory.

Individual commands:

```bash
pnpm check                  # Fast lint of changed JS/TS files
pnpm lint:staged            # Fast lint of staged JS/TS content
pnpm --filter @canonry/canonry-contracts typecheck  # Type-check one affected package
pnpm exec vitest run --project contracts        # Run one affected test project
pnpm verify                 # Full workspace check; required before outside code PRs
pnpm build:cli              # CLI/server bundle only
pnpm build:web              # Cached dashboard build and asset copy
pnpm build                  # Complete publishable package
pnpm run dev:web            # Run web dashboard in dev mode
```

## Project Structure

```
packages/canonry/         Single publishable npm package (CLI + server + bundled SPA)
packages/api-routes/      Shared Fastify route plugins
packages/contracts/       DTOs, enums, config schema
packages/db/              Drizzle ORM schema + migrations (SQLite)
packages/provider-*/      Provider adapters (Gemini, OpenAI, Claude, local)
apps/web/                 Vite SPA source (bundled into packages/canonry/assets/)
```

`@canonry/canonry` is the application package; `@canonry/val-kit` is published independently for Val Town hosts. All other packages are private workspace dependencies under `@canonry` and are bundled by tsup at build time.

## Guidelines

- **API first**: every feature starts as an API capability in `packages/api-routes/`.
- **CLI required**: operator and agent workflows must be exposed through the CLI.
- **Web UI secondary**: UI support is important, but it must not block API/CLI delivery.
- Keep shared types in `packages/contracts/`.
- Keep API route plugins in `packages/api-routes/` (no app-level concerns).
- Keep provider logic in `packages/provider-*/`.
- Keep API handlers thin.

Use [`docs/README.md`](docs/README.md) as the entrypoint for the current reference docs.

## Before Submitting a PR

Use the [PR template](.github/pull_request_template.md). Keep the summary to **1–3 bullets, at most 75 words total**.
Describe the problem and resulting behavior. Link the issue and longer design notes instead of repeating them.
Omit file inventories, implementation diaries, and repeated before/after sections.

Complete the checklist and collect results **before opening a PR**, including a draft.
Outside contributors must run the full workspace checks for code changes. Focused tests and future CI runs do not replace these results.
During local iteration, do not run tests, test watchers, or `pnpm verify`. Run them after the changes are final:

```bash
pnpm check
pnpm verify
```

`pnpm verify` runs generated-file checks, full typechecks, type-aware lint, and the full test suite (`pnpm run test`).
It stops at the first failure. Report each completed check separately. Never claim that later checks ran after an earlier failure.

- [ ] Read and followed the root and affected folders' `AGENTS.md` files.
- [ ] Reviewed potential security issues, including permissions, project boundaries, secrets, untrusted input, and provider spend. Recorded risks and mitigations, or `None identified` with the reviewed areas.
- [ ] Ran the required tests and recorded pass/fail/skip counts. Covered the relevant regressions and both Simple and Advanced paths.
- [ ] Passed the required typechecks, type-aware lint, and generated-file checks. `pnpm check` alone is insufficient.
- [ ] Built and smoke-checked affected CLI, API, MCP, and UI surfaces. Included installed-package checks for packaging changes.
- [ ] Checked code style against the applicable `AGENTS.md` rules. For UI changes, also checked `PRODUCT.md`, `DESIGN.md`, desktop/mobile layout, and keyboard use. Attached before/after screenshots.
- [ ] Recorded the tested commit SHA, exact commands, results, and evidence for the submitted head.

Keep evidence brief: one result line per command, with sanitized logs in a collapsed `<details>` block or linked artifact.
Include the test totals and explain skipped checks. Never include credentials or private data.
Failed or unrun required checks block submission. Missing tools, time, or credentials are blockers, not `N/A` reasons.
If blocked, report the blocker to the maintainer before opening a PR. Only an explicit maintainer exception permits submission with missing results.

Docs/comment-only changes use diff and link checks. Configuration changes use the applicable checks in [the testing guide](docs/testing.md#before-merging).
Mark inapplicable items `N/A — <reason>` beside the item. Do not mark an unrun check as passed.
For owner (`arberx`) changes, the affected-package validation rules in `AGENTS.md` still apply. Full local checks remain optional.
Reuse passing results only while their inputs remain unchanged. After edits or a rebase, rerun affected checks at final validation.
Outside contributions still need full CI after submission. Skipped or absent CI is not a pass.

## Git Hooks

`pnpm install` installs the Git hooks. Ordinary code commits lint staged JS/TS content, including partially staged files.
It runs syntax rules and repository guards without loading TypeScript projects. It never changes files or the index.
Both use oxlint, which is fast enough to need no result cache.
Documentation-only commits skip the linter. The commit-message hook checks Conventional Commits. Pushes run the three drift gates below.

See [the testing guide](docs/testing.md) for the local and CI commands.

API changes need `pnpm gen`. Review and stage the generated files before `pnpm gen:check`.
The check compares temporary output and the Git index without changing either.
Pre-push runs the three drift gates and requires their inputs and output to match the pushed commit.
Changes to `.oxlintrc.json` or `eslint-rules/` trigger full typed lint. Ordinary commits keep the staged-file check.
Codegen and dashboard builds reuse cached results only when their inputs and output contents match.
