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
They cover local changes, not every committed change on the branch. Contributor CI checks the full workspace.

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

The generated SDK package's `typecheck` also compiles its tests through
`packages/api-client-generated/tsconfig.test.json`. This checks `expectTypeOf`
assertions that runtime Vitest execution does not verify.

## Git Hooks

Pre-commit runs `node scripts/lint-changed.mjs --staged` directly, without a pnpm startup or dependency scan.
`pnpm lint:staged` runs the same check manually. It reads the exact staged blobs, including partially staged files.
It never fixes files, stages changes, or stashes work. Errors block the commit. Warnings remain visible.
Documentation-only commits skip ESLint and do not need installed npm dependencies.

Changes to `eslint.config.*` or `eslint-rules/` trigger `pnpm run lint` across the repository, with all type-aware rules enabled.
This fallback does not use the fast cache. It can find new violations in unchanged files.
For staged checks, code and configuration must match the index before the fallback runs.
The hook refuses partially staged inputs for full typed lint, because TypeScript reads the project from disk.
Ordinary code commits retain the fast path. Run relevant typechecks locally for owner changes; contributor CI checks types across the workspace.

The commit-message hook checks Conventional Commits.
Pre-push runs `pnpm gen:check --committed`, `pnpm plugin:check`, and `pnpm val:skills:check`, in that order.
A failed gate stops the push. These checks can generate temporary comparison files but never rewrite tracked artifacts.
Git hooks never run tests, builds, or workspace typechecks.

Drift inputs must match each commit being pushed. They include packages, scripts, skill/plugin files, manifests, and the checked codemap documents.
Uncommitted changes in those paths cannot supply a missing fix to the checks. Other work, such as a README edit, can remain uncommitted.
Deletion-only pushes skip these gates. For another branch with different inputs, run the push from a checkout of that branch.

## Codegen and Build Checks

`pnpm gen:check` generates into a temporary directory and compares it with the SDK in the working tree.
It does not change generated files or the Git index. After generation, the cache records input and output content hashes.
Unchanged checks skip the generator. Missing or edited output files invalidate the cache.
Every check also compares generated files with the Git index, including cache hits. Unstaged or untracked generated files fail the check.
After `pnpm gen`, review and stage the generated changes before running `pnpm gen:check` or `pnpm verify`.
Use `pnpm gen:check --committed` to compare with `HEAD` instead. Pre-push uses this mode to catch generated changes missing from the commit.
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

Outside contributions run full workspace validation in CI. Owner changes rely on local checks.
For a requested full local check or a CI failure reproduction, run `pnpm verify`.
This command includes generated-file drift and documentation assertions. It is not required before each commit or push.

## CI Mapping

`.github/workflows/change-policy.yml` reads GitHub metadata without checking out or executing contributed code.
It exempts changes attributed exclusively to `arberx` (GitHub user ID `14798762`).
An owner PR must come from this repository, have an authenticated owner sender, and contain only owner-authored commits.
Pushes check every introduced commit and its associated PRs, so merging an outside contribution remains outside work.
Mixed authorship, unknown attribution, incomplete metadata, or API errors retain the full pipeline.
Rerunning an outside contribution as the owner does not exempt it.
The metadata lookup is bounded; changes over 100 commits or 120 API reads use contributor checks.

Owner changes skip all CI validation and Docker, ClawHub, and WordPress deployment.
Only npm and Homebrew publishing remain automated. GitHub's native merge-conflict handling applies; there is no conflict workflow.
The metadata job routes the policy; its success and skipped jobs are not validation evidence.
Scheduled dependency and crawler maintenance keep their existing checks and bot PRs.

For outside contributions, separate jobs in `ci.yml` cover the checks in `pnpm verify`:

- `pnpm gen:check`
- `pnpm plugin:check` (CI also supplies `--base-ref`)
- `pnpm val:skills:check`
- `pnpm run typecheck`
- `pnpm run lint`
- `pnpm run test`

CI also runs build, Deno, and release guards. `pnpm verify` does not replace those additional checks.

### CI caches

Lint and typechecks use four concurrent package processes without dependency ordering.
They read workspace source directly and produce no artifacts needed by another package's check.
Builds retain dependency ordering.

Typechecks reuse TypeScript incremental state, including the root `scripts/` and `test/` projects.
CI collects the `.tsbuildinfo` files with shallow shell globs and caches a single archive.
This avoids scanning `node_modules` during cache uploads. TypeScript still validates the current inputs on every run.

Tests run in six shards on each of Node 22 and Node 26. Both majors run the complete suite.
CI persists Vitest's experimental module-transform cache and Node's compile cache.
These caches reuse compilation work; they never skip test assertions or reuse a passing test result.
Cache keys separate the OS, architecture, Node major, shard, lockfiles, manifests, and configuration.
Adding or removing tracked files also invalidates the cache because it can change import resolution.
Vitest checks module contents before reusing a transform. Changes to transform plugins or their external inputs must also invalidate the CI cache key.

Successful contributor `main` runs warm caches that PRs can restore. Each contributor PR can also reuse its own caches.
A cache miss runs the checks normally. Local test commands keep their existing behavior.
To bypass the test compilation caches in CI, omit the two `--experimental` flags and set `NODE_DISABLE_COMPILE_CACHE=1`.

For outside contributions, npm publishing waits for the `validate` job of the `ci.yml` push run on the exact release commit and branch.
`validate` requires typecheck, tests, lint, the drift checks, the WordPress plugin suite, the package build, and the install smoke test.
The Docker image build is outside it, so a Docker failure cannot skip npm; Docker publishes from its own Publish job.
It does not repeat typechecks or an unsharded test suite. Failed, cancelled, missing, or timed-out validation blocks publication.
The wait has a 25-minute deadline. After fixing CI, rerun the failed Publish jobs to retry the gate.
If metadata lookup failures caused CI and Publish to choose different policies, rerun both workflows;
Publish refuses a skipped validation job when its own policy requires contributor checks.

Before each image build, CI and Publish run `scripts/pull-docker-base-images.sh Dockerfile`.
It retries failed pulls with backoff. For ECR Public's Docker Official Images, it also tries the same image on Docker Hub, which has a separate quota.
BuildKit then uses the local copy instead of the registry, so leave `pull` off in `docker/build-push-action`.

The contributor build job includes the root README, packs Canonry once, and uploads the tarball for the install smoke test and npm publication.
The smoke job installs that artifact in a scratch directory outside the checkout and checks `canonry --version`.
It then runs `scripts/smoke-sentiment.mjs` against the installed package. Checkout dependencies only seed synthetic data and run the harness;
the server, CLI, HTTP MCP, and stdio MCP behavior comes from the installed binaries.
The scenario covers Simple and Advanced portfolios, credential scopes, idempotent replay, and exact stored results.
Provider requests go to a bounded loopback stub; CI uses no live provider credentials.
Reports, provider receipts, and redacted failure logs are uploaded as `packaged-sentiment-smoke` artifacts.
For outside contributions, Publish downloads the artifact from the push CI run whose `validate` job passed for the exact release commit.
It publishes the tested primary tarball unchanged and repacks its contents with the compatibility package name.
Neither publication runs build or lifecycle scripts. Missing artifacts or a mismatched package name or version stop publication.
Owner releases build and pack in Publish without running tests, lint, drift checks, or the CI wait.
They publish that release artifact through the same tarball publisher, then update Homebrew.
Artifacts remain available for seven days; after expiry, rerun the build workflow for the applicable policy before retrying publication.

For a local artifact dry run, set `CANONRY_NPM_PUBLISH_TARBALL` to the absolute tarball path and run
`CANONRY_NPM_PUBLISH_DRY_RUN=1 node scripts/publish-canonry-npm.mjs`.
Without the tarball variable, the publisher retains its local build-and-publish workflow.
Homebrew still waits for npm's public metadata and tarball before dispatching the tap update.

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

The provider packages (`packages/provider-gemini`, `provider-openai`, `provider-muse`, `provider-claude`, `provider-perplexity`, `provider-local`, `provider-cdp`) have unit tests that validate:

- Config validation (accepts valid keys, rejects empty)
- Custom model passthrough
- Answer text extraction from provider-specific response structures
- Domain extraction from grounding source URIs (www. stripping, deduplication)
- Graceful handling of empty responses and invalid URIs

These tests do **not** make real API calls. They test `normalizeResult` against synthetic raw result objects to verify the parsing and extraction logic.

### Provider-specific response formats

- **Gemini**: `candidates[].content.parts[].text` + `groundingMetadata.groundingChunks`
- **OpenAI**: `output[].content[].text` + `output[].content[].annotations[]` (URL citations)
- **Muse**: final `message` → `output_text` blocks + their `url_citation` annotations; `web_search_call` items set retrieval status
- **Claude**: `content[].text` + `web_search_tool_result` blocks with `search_results`
- **Perplexity**: Agent API `output[]` (`message` text + `search_results` item); stored Sonar rows keep the `search_results` / `citations` parser
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
