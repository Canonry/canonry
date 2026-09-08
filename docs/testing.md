# Testing Guide

## Test Runner

Canonry uses **Vitest**. `vitest.config.ts` defines the workspace projects. `vitest.package.config.ts` supports package tests.

```typescript
import { test, expect, describe, it, beforeEach, afterEach } from 'vitest'
```

Tests live in `test/` directories colocated with each package (e.g. `packages/canonry/test/`).

## Fast Local Checks

Run changed-file lint from the repository root:

```bash
pnpm check
```

`pnpm check` and `pnpm lint:changed` lint staged, unstaged, and untracked JS/TS files using their working content.
They skip deleted files, symlinks, and ESLint-ignored files.
They run syntax rules and repository guards without loading TypeScript projects. They do not run tests, builds, or code generation.
They cover local changes, not every committed change on the branch. CI checks the full workspace.

### Shared lint cache

Changed-file and staged checks share clean results across this repository's Git worktrees.
Cache keys include source content, relative file paths, effective ESLint configuration, local rules, the lockfile, and installed tool versions.
Timestamps and branch names do not affect reuse. Warnings and errors are checked again and remain visible.

Entries live under `${TMPDIR}/canonry-lint-cache-<uid>/`, grouped by the repository's common Git directory.
Each result has a separate file, written atomically. Concurrent worktrees do not rewrite a shared ESLint cache file.
Set `CANONRY_LINT_CACHE_DIR` to change the cache root. Cache storage failures do not prevent linting or commits.
Use `pnpm check --no-cache` or `pnpm lint:staged --no-cache` to bypass the cache.

Full type-aware lint remains uncached: edits to imported types can change diagnostics in an otherwise unchanged file.

For behavior changes, run the relevant tests and package typechecks:

```bash
pnpm exec vitest run --project contracts
pnpm exec vitest run packages/contracts/test/citations.test.ts
pnpm --filter @ainyc/canonry-contracts typecheck
```

Replace the project, test path, and package with the affected scope.
After another edit or rebase, rerun only the affected checks.

## Git Hooks

Pre-commit runs `node scripts/lint-changed.mjs --staged` directly, without a pnpm startup or dependency scan.
`pnpm lint:staged` runs the same check manually. It reads the exact staged blobs, including partially staged files.
It never fixes files, stages changes, or stashes work. Errors block the commit. Warnings remain visible.
Documentation-only commits skip ESLint and do not need installed npm dependencies.

The commit-message hook checks Conventional Commits. There is no pre-push hook.
Git hooks never run tests, builds, code generation, or workspace typechecks.

## Codegen and Build Checks

`pnpm gen:check` generates into a temporary directory and compares it with the SDK in the working tree.
It does not change generated files or the Git index. After generation, the cache records input and output content hashes.
Unchanged checks skip the generator. Missing or edited output files invalidate the cache.
For a fresh generator run, use `pnpm gen:check --force`. To update the SDK, use `pnpm gen`.

Use the build command for the affected surface:

```bash
pnpm build:cli              # CLI/server bundle, without the SPA
pnpm build:web              # SPA build and package asset copy
pnpm build                  # Complete publishable package
pnpm build:web --force      # Fresh SPA build
pnpm -r run build           # All packages, with one SPA compilation
```

Dashboard builds include source, workspace dependencies, configuration, environment, and output contents in the cache check.
Vite resolves environment values before the cache check. Variable expansion and symlinked environment files participate in invalidation.
The web package supports standard Vite build flags:

```bash
pnpm --filter @ainyc/canonry-web build --mode staging --base /preview/ --sourcemap
```

These options participate in cache identity. Other Vite flags pass through to the native CLI without caching.
Cached builds leave previous output intact if compilation fails. Asset copies retain agent files and do not rewrite identical SPA files.
Recursive builds order the dashboard before Canonry, which reuses its output.

## Full Workspace Checks

CI owns full workspace validation. For a requested full local check or a CI failure reproduction, run `pnpm verify`.
This command includes generated-file drift and documentation assertions. It is not required before each commit or push.

## CI Mapping

Separate jobs in `ci.yml` cover the checks in `pnpm verify`:

- `pnpm gen:check`
- `pnpm plugin:check` (CI also supplies `--base-ref`)
- `pnpm val:skills:check`
- `pnpm run typecheck`
- `pnpm run lint`
- `pnpm run test`

CI also runs build, Deno, and release guards. `pnpm verify` does not replace those additional checks.

## Package Verification

To verify the publishable package:

```bash
cd packages/canonry && npm pack
npm install -g ./ainyc-canonry-*.tgz
canonry init
canonry serve
```

## Dependency Verification Checklist

1. Run tests and typechecks for the affected packages.
2. Confirm `apps/worker/src/audit-client.ts` still imports from `@ainyc/aeo-audit`.
3. Confirm worker adapter tests still pass against the published package.
4. Confirm `packages/api-routes/` has no direct dependency on `apps/*`.
5. Confirm `packages/canonry/` bundles SPA assets correctly (`build-web.ts`).

## Provider Tests

The provider packages (`packages/provider-gemini`, `provider-openai`, `provider-claude`, `provider-perplexity`, `provider-local`, `provider-cdp`) have unit tests that validate:

- Config validation (accepts valid keys, rejects empty)
- Custom model passthrough
- Answer text extraction from provider-specific response structures
- Domain extraction from grounding source URIs (www. stripping, deduplication)
- Graceful handling of empty responses and invalid URIs

These tests do **not** make real API calls. They test `normalizeResult` against synthetic raw result objects to verify the parsing and extraction logic.

### Provider-specific response formats

- **Gemini**: `candidates[].content.parts[].text` + `groundingMetadata.groundingChunks`
- **OpenAI**: `output[].content[].text` + `output[].content[].annotations[]` (URL citations)
- **Claude**: `content[].text` + `web_search_tool_result` blocks with `search_results`
- **Perplexity**: `search_results` array (preferred) or `citations` array fallback
- **Local**: heuristic URL/domain scan over the raw answer text (no native web search)

To test live API calls, use the CLI with real API keys:

```bash
canonry init                                    # provide API keys for one or more providers
canonry project create test --domain example.com --country US --language en
canonry query add test "best dentist brooklyn"
canonry run test                                # runs against all configured providers
canonry run test --provider gemini              # single-provider run
canonry status test                             # view citation results
```

## End-to-End Verification

1. `canonry init` creates `~/.canonry/` with SQLite DB and auto-generated API key
2. `canonry serve` starts server, dashboard loads
3. `canonry project create` / `query add` / `run` workflow completes with results from all configured providers
4. Run results include per-provider grounding sources, search queries, and cited domains
5. `canonry export` produces valid `canonry.yaml`
6. `canonry apply` is idempotent and records audit log entries
7. Dashboard shows visibility data
8. `GET /runs/:id` returns snapshots with `groundingSources`, `searchQueries`, and `model` fields

## Conventions

- Test the public API of each module, not internal implementation details.
- Cover both the happy path and meaningful edge cases (invalid input, env var overrides, error handling).
- When testing CLI commands, capture stdout/stderr and assert on output rather than only checking side effects.
- Use temp directories (`os.tmpdir()`) for file-system tests; clean up in `afterEach`.
- **Test default-value propagation end-to-end.** When a feature stores a default that another feature consumes, write a test that exercises the full path with no explicit override.
