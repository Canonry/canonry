# AGENTS.md

## Project Overview

`canonry` is an **agent-first** open-source AEO operating platform that tracks how AI answer engines cite a domain for tracked queries and acts on the signal through the content engine and integrations. Published as `@canonry/canonry` on npm, with `@ainyc/canonry` kept as a compatibility package at the same versions. The CLI and API are the primary interfaces — the web dashboard is supplementary.

It ships a built-in analyst agent, Aero (`packages/canonry/src/agent/`), and a stdio MCP adapter, `canonry-mcp` (`packages/canonry/src/mcp/`).

## Where rules live

This file holds only the rules every change must follow. Every package and app has its own `AGENTS.md` with the rest; read the one for the folder you're changing before you edit. Claude Code loads a folder's `AGENTS.md` automatically when it opens a file there. Codex and most other agents load only the files from the repo root down to their working directory, so open the right one yourself. Find files, navigation recipes, and search tips (`muse.search`, chunked reads of large files) in `docs/CODEMAP.md`; find docs, plans, ADRs, and the roadmap in `docs/README.md`.

```text
apps/api/, apps/worker/   Cloud Run API and worker entry points (import packages/api-routes)
apps/web/                 Vite SPA, bundled into packages/canonry/assets/ (also read PRODUCT.md, DESIGN.md)
apps/vals/*/              Public Deno/Val Town samples on @canonry/val-kit
packages/canonry/         Publishable npm package: CLI + server + SPA (+ src/mcp/AGENTS.md, src/agent/AGENTS.md)
packages/api-routes/      Shared Fastify route plugins (+ src/doctor/AGENTS.md, src/discovery/AGENTS.md)
packages/contracts/       DTOs, enums, config schema, error codes, shared utilities
packages/config/          Typed environment parsing
packages/db/              Drizzle ORM schema, migrations, client (SQLite/Postgres)
packages/intelligence/    Insight and health analysis over snapshots
packages/provider-*/      Answer-engine adapters (gemini, openai, claude, perplexity, local, cdp)
packages/integration-*/   Third-party integrations (Google, GA4, Bing, OpenAI ads, Cloudflare, WordPress, ...)
packages/val-kit/         Published host kit for the Vals (@canonry/val-kit)
skills/, plugins/         Canonical agent skills and the portable plugin (rules for both: plugins/AGENTS.md)
docs/                     Architecture, data model, setup guides, testing
```

## Deployment Posture (Critical)

**`canonry serve` (local) and `apps/api` (Cloud Run) are single-tenant**: one trust boundary per instance — one operator's projects on one machine, or one team's projects on one Cloud Run service. Never multiplex unrelated tenants behind one instance.

- No domain table has an `owner_id`, and `resolveProject(app.db, name)` is a global lookup, so a full-instance `cnry_…` key reads and writes every project. A project-scoped key (`api_keys.project_id`, `canonry key create --project`) is a project boundary, not a tenant boundary: instance-global `/settings/*` and shared `google_connections` are unchanged.
- `google_connections` / `bing_connections` are keyed on `(domain, connectionType)`, so projects tracking the same domain share one OAuth connection by design.
- Don't deploy `apps/api` as multi-tenant SaaS (one Cloud Run service, database, and OAuth client per team), and hand out `cnry_…` keys only within the trust boundary you'd give a teammate.
- A GET that SPENDS (calls a provider live on the caller's behalf) needs `requirePaidReadScope` + `requireAdminSession`, not just the read/write split. **Any new route that calls a provider live on the caller's behalf must be added to this gate.**
- Internal observability (runtime logs, server telemetry) is operator-only through host-level `CANONRY_OPERATOR_KEY_IDS`; never add an API that self-grants it.

Key types, scope gates, read-only keys, `keys.write`, and what a multi-tenant migration would cost: `packages/api-routes/AGENTS.md` → "Deployment posture and key authority".

## Commands

```bash
./canonry-install.sh            # one-command dev setup: install deps, build all packages, install canonry globally
pnpm install
pnpm check                      # fast lint of staged, unstaged, and untracked JS/TS files
pnpm lint:staged                # fast lint of the exact staged JS/TS content
pnpm verify                     # optional full check: drift checks + all workspace checks
pnpm build:cli                  # CLI/server bundle only; skips the dashboard
pnpm build:web                  # build or reuse dashboard output and copy changed assets
pnpm build                      # complete publishable package
pnpm run typecheck && pnpm run test && pnpm run lint
pnpm gen                        # regenerate the API client after changing openapi.ts
pnpm plugin:sync                # refresh plugin skill mirrors + portable/client manifest versions
pnpm plugin:check               # fail on plugin spec, skill, or version drift (CI gate)
pnpm guide:sync                 # generate MCP guidance + optional native skills from docs/agent-operations/v1.md
pnpm run dev:web
```

For the product CLI, `canonry <command> --help` is authoritative and `skills/canonry/references/canonry-cli.md` is the full reference. Rules a command must follow live with the code that implements it ("Where rules live"), not in a command list.

## Portfolio Feature Parity (Critical)

Here, a **simple portfolio** means the standard project flow. A **custom portfolio** means an Advanced Measurement portfolio.

- Every feature for a simple portfolio must also work in a custom portfolio.
- Include both portfolio paths in the same implementation scope.
- Cover the API, CLI, MCP, web UI, permissions, states, and tests for both paths.
- If the paths need different aggregation rules, implement and document both rules.
- Do not omit a custom-portfolio dimension. Preserve its Property, Target, market, provider, and query-class scope.

## Response sections and feedback

Use these sections only for review handoffs. Keep simple answers and routine status updates short.

When proposing work, requesting feedback, or showcasing changes:

- Use indexed items so the user can answer precisely: `1`, `2`, `3` for one section; `A1`, `A2`, `B1` when there are multiple sections.
- Put completed or proposed changes under a clearly labeled `SHOWCASE` section when presenting them for review.
- Add a clearly labeled `FEEDBACK NEEDED` section only when a real user question or decision is needed. Put every question there, indexed, and keep it separate from `SHOWCASE`; omit the section when there are no questions.
- Use architecture diagrams when they clarify complicated topics. New ideas and discussions warrant a back-and-forth.

## Dependency Boundary

- `packages/api-routes/` must not import from `apps/*`.
- `packages/canonry/` and `packages/val-kit/` are the only publishable artifacts — the product package and the Vals'
  shared host kit. Every other package is internal and bundled via tsup.
- `packages/val-kit/` must stay runtime-neutral (web standards + Deno-compatible): it is consumed by the Val Town Vals,
  not by the Node server, so it must not import `packages/canonry/`, `packages/db/`, or anything Node-only.
- All internal packages use `@ainyc/canonry-*` naming convention.
- Keep environment parsing in `packages/config`, provider logic in `packages/provider-*/`, and route plugins in `packages/api-routes` (no app-level concerns; thin handlers).
- Keep the canonry app independent from the audit package repo except for the published npm dependency.
- Store raw observation snapshots only (`cited` / `not-cited`); compute transitions at query time.

## Vocabulary (Critical)

Every (query × provider) snapshot carries two independent signals — a model can do either, both, or neither. Never conflate them in code, copy, or contract field names.

| Term | Meaning | Source field |
|------|---------|--------------|
| **mention / mentioned** | The project's brand or domain appears in the LLM's answer text. | `query_snapshots.answer_mentioned` (boolean) |
| **cited** | The project's domain appears in the answer's source links / grounding. | `query_snapshots.citation_state` = `'cited'` |

1. Say `mention` / `mentioned` for answer-text presence. `answer`, `visible`, and `visibility` are legacy terms (`visibility_state`, run kind `answer-visibility`, `visibilityStateFromAnswerMentioned`); new APIs, fields, flags, and UI labels say `mentioned` (`mentionRate`, never `answerRate`).
2. Say `cited` for source-list presence; never use `citation` as an umbrella for both.
3. Never compute one signal from the other. A "cited" label reads `citationState`; a "mentioned" label reads `answerMentioned`. A metric named for one and computed from the other is a bug — fix it.
4. When you mean both, say "citation + mention coverage" or "visibility (cited or mentioned)" and disambiguate immediately.
5. Public API field names use this vocabulary from the start; a rename needs a version bump.
6. Render both signals in CLI/UI snapshot output: a two-glyph cell (`C/c` cited or not, `M/m` mentioned or not, `–` missing) with the legend above the table, as `canonry citations` and `canonry run` do.
7. `canonry-vocabulary/no-banned-metric-literal` bans conflating literals (`'answerRate'`, `'visibility run'`, `'paid mentions'`, …) in the CLI, api-routes, and web trees; the list is in `eslint.config.js`. Bare `'visible'` stays legal (DOM, legacy enum) — review owns it.

### Branded vs non-brand (Critical)

**Branded and non-brand queries never share a denominator.** A branded query names the project, so the model was handed the answer; pooling lets brand recall outvote the category and can invert a ranking (measured on a real basket: pooled ranked the subject FIRST at 42%, non-brand ranked it LAST at 3%).

1. Competitive metrics default to non-brand: Mention Share (card, breakdown chart, trend buckets), `visibility-stats --share-of-voice`, `visibility-compare`, and the report's mention landscape.
2. Branded stays visible as a sibling field (`branded`) with its own labelled section and denominator — never dropped, never pooled.
3. The class travels with the number: `scope` / `queryClass` on the wire; "· non-brand queries" in the delta, chart title, column header, and CLI line. A GROUP of figures sitting directly under a heading that names the class may rely on that heading for the visible label (the dashboard's AI Visibility headline strip names the class once in its `h2`), but each figure still carries the class in its own accessible text via an `sr-only` suffix beside the value. A reader who sees only the number, or hears only the figure, must still be able to tell which instrument produced it.
4. `pooled` appears only when the project has no usable brand alias. Never label an unsplit figure `non-brand`, and never silently classify an unclassifiable basket.
5. One classifier: `compileQueryClassifier` (`packages/contracts/src/query-class.ts`) runs `effectiveBrandNames` through the shared brand matcher; `queryClassSchema` IS `measurementQueryClassSchema`. No hand-rolled regex, no second enum.
6. `competitorOverlap` is legacy MIXED evidence (answer text, source links, or both). Citation metrics use `citedDomains` plus grounding-source hosts; mention metrics use answer text with the shared matcher.

### Query vs question

The tracked thing (`canonry query add`, the `queries` / `query_snapshots` tables, `queryText` / `queryId` / `queryClass` on the wire) is a **query**.

1. Human-facing copy says `query`: UI labels, headings, tooltips, `aria-label`, placeholders, CLI output, and both report renderers — with correct agreement ("Assign at least one query", "3 query assignments").
2. The frozen wire names stay: routes `/measurement-property-questions` and `/measurement-question-result`, MCP tools `canonry_measurement_property_questions` and `canonry_measurement_question_result`, and every SDK symbol, field, prop, and file built on them. The copy/wire mismatch is deliberate.
3. Discovery's generative framing ("questions your customers might ask") is a real-world noun; once a candidate is promoted into the basket it is a query.
4. `canonry-vocabulary/no-question-ui-copy` enforces this in `apps/web/src`. Machine tokens (no whitespace, e.g. `property-questions`) and `className` / `id` / `aria-labelledby` values are exempt; only two files are excluded, permanently: `DiscoverySection.tsx` (rule 3's framing can't be separated by regex) and `mock-data.ts` (test fixture).

## Enum Constants (Critical)

Never compare domain values as raw string literals: write `kind === RunKinds['answer-visibility']`, not `kind === 'answer-visibility'`. The constant objects (`RunKinds`, `RunStatuses`, `RunTriggers`, `CitationStates`, `VisibilityStates`, `ComputedTransitions`) come from `packages/contracts/src/run.ts` via `@ainyc/canonry-contracts`.

1. Type parameters with the union type (`kind: RunKind`, not `string`).
2. Use exhaustive switches with no `default`, or `default: { const _exhaustive: never = value }`.
3. Add new variants to the Zod schema in `run.ts`; the constant object derives from it. Worked example: `packages/contracts/AGENTS.md` → "Enum constants".

## Surface Priority

**Agent-first.** The API is the backbone, the CLI is the primary user-facing surface, and the web UI is important but never blocks a release. A new feature needs an API endpoint in `packages/api-routes/` and a CLI command in `packages/canonry/`; UI in `apps/web/` is ideal.

### UI/CLI parity (Critical)

Everything the dashboard shows must be readable through the API and CLI, with the same data. The UI consumes the API; it is not a privileged surface.

1. **No UI-only calculations.** Derived metrics (percentages, trends, diffs, scores, roll-ups) are computed in the API response; components only lay out and present.
2. **No UI-only state.** Every panel, section, or page that displays data maps to a CLI command.
3. **Mirror granularity.** A UI summary and detail view need a CLI summary and detail command.
4. **Same data, same shape.** `--format json` output matches the API response the UI consumes.
5. **Same capabilities across UI, API, CLI, and MCP** for the equivalent authorized credential: scopes, OAuth consent, project boundaries, usage limits, initiating identity, inputs, saved results, and errors. Cover Simple and Advanced paths. Test real calls across authentication/transport boundaries — tool lists alone don't prove parity. Document deliberate exclusions, and never turn a narrow action grant into general write access.

### Calculation Testing (Critical)

Every derived number — percentage, trend, score, rank, bucket, residual, roll-up, dedupe, classification — is tested against the business invariant it claims to represent.

1. Assert exact expected math, not shape (`toBeGreaterThanOrEqual(0)`, `typeof`, "renders without crashing").
2. Test the invariant: buckets sum to the total; disjoint metrics don't double-count seeded overlap; a rate asserts numerator, denominator, rounded value, and display value.
3. Cover zero totals, missing/partial data, duplicates, overlapping categories, rounding boundaries (`<1%`, `0%`, `100%`), clamping, and stale/legacy rows.
4. The canonical calculation lives and is tested in the API/shared layer; UI tests check the UI renders API values without recomputing.
5. Test the machine-readable contract (CLI JSON, reports, MCP/API) as well as any display string.

### Report parity (Critical)

The downloadable HTML report (`packages/api-routes/src/report-renderer.ts`, `canonry report`, `GET /report.html`) and the in-app report (`apps/web/src/pages/ReportPage.tsx`) are two renderers of one `ProjectReportDto` — clients and agencies see one report.

1. Any change to one lands in the other in the same change.
2. Per audience (`client` / `agency`), both render the same ordered sections with the same eyebrows, titles, and subtitles.
3. Tile labels, headlines, action-card copy, evidence-card titles, and chart axis labels match verbatim.
4. Every SPA chart, progress bar, hero block, and badge has an HTML equivalent (inline SVG, CSS, or table).
5. Update `packages/api-routes/test/report-renderer.test.ts` when client/agency copy or structure changes, and check the SPA visually.
6. Copy both renderers show lives in shared modules: `packages/contracts/src/report-sections.ts` (`REPORT_SECTION_COPY` plus copy functions such as `reportExecutiveHeadline` and `reportServerActivityHeading`) for section copy, `report-visibility.ts` for the visibility summary, and `share-of-voice.ts` for share of voice. Both renderers read all three; never write report copy inline in either one.
7. `renderReportHtml` assembles its own ordered section list in `report-renderer.ts`, and `reportSectionOrder(report, audience)` encodes that same order for the SPA, which renders it through an exhaustive switch over `ReportSectionIds`. `report-renderer-bytes.test.ts` (`ORDER_CASES` / `ORDER_MATRIX`) asserts the two agree, so adding, removing or re-conditioning a section means editing both in the same commit.
8. `packages/api-routes/test/report-renderer-bytes.test.ts` pins the HTML bytes and writes the outline goldens in `packages/api-routes/test/fixtures/report-outline/`. `apps/web/test/report-page.test.tsx` holds the SPA to them, whole and for both audiences, through its `data-report-*` hooks, and `apps/web/test/report-agency-*.test.tsx` pin the per-section values, rows, badges and tones an outline does not record. Only the api-routes suite regenerates the goldens, and never to make a failing test pass.

### Agent & automation design principles

The CLI and API **are** the agent interface. If an agent can't do something with `canonry <command> --format json` or an HTTP call, it's a bug.

1. **No interactive prompts.** Everything works through flags, env vars, or `config.yaml`; `node:readline` is ESLint-banned in command files. Only `canonry init` may prompt, and all its values are also flags.
2. **JSON everywhere.** `--format json` goes to stdout; errors go to stderr as `{ "error": { "code": "...", "message": "..." } }` with a code from `CliError`.
3. **Idempotent writes**, with `canonry apply` as the model. Creating POSTs (runs) return a stable identifier and handle conflicts (e.g. `runInProgress` with the existing run id).
4. **Single-call reads.** If a common question needs two calls, add a composite endpoint (`/projects/:name/runs/latest`, `/projects/:name/search?q=`).
5. **Exit codes:** `0` success, `1` user error (bad input, not found, validation), `2` system error (network, provider failure, internal) — agents use them to decide whether to retry.
6. **Stable output contracts.** JSON fields, endpoint paths, and error codes are public API: add freely, never rename or remove without a version bump.
7. **MCP adapter boundary.** `canonry-mcp` may use `createApiClient()` and public client methods only — no DB, route, job-runner, CLI-dispatch, telemetry, or logger imports, and nothing on stdout but MCP frames.
8. **MCP parity by default.** Every new public API endpoint and CLI command gets an MCP tool, or its OpenAPI operation is classified `deferred` / `excluded-protocol` with a rationale in `packages/canonry/src/mcp/openapi-classification.ts`. MCP never adds capabilities the API/CLI lack. Details and the deliberate exceptions: `packages/canonry/src/mcp/AGENTS.md`.
9. **Classify new request parameters** on any operation that skips or reuses work as identity or tuning (`packages/api-routes/AGENTS.md` → "Request parameters: identity vs tuning").

### Spec-driven typing (Critical)

`packages/api-routes/src/openapi.ts` is the single source of truth for HTTP shapes; the web client, the CLI's `ApiClient`, and the MCP adapter consume types regenerated from it.

1. Every new route registers a Zod schema and uses `jsonResponse(...)`; new `rawJsonResponse(..., looseObjectSchema)` routes fail `no-new-loose-routes.test.ts`. Steps: `packages/api-routes/AGENTS.md` → "Typed responses".
2. Every web call goes through the generated SDK; only `api.ts` and `api-aero.ts` may use raw `fetch`. Details: `apps/web/AGENTS.md` → "API calls".

`openapi-contract.test.ts` requires every registered schema to be referenced by a route.

## Shared Utilities (Critical)

**Generic, pure helpers (`formatX`, `parseX`, `normalizeX`, `clampX`, …) live once in `packages/contracts/` and are imported everywhere they're needed.**

1. Check `packages/contracts/src/` first; the "Where utilities live" table in `packages/contracts/AGENTS.md` maps each concern to its file.
2. Make helpers generic enough for the next caller; domain wrappers stay in the consumer and call the generic core.
3. No duplicate implementations: replace a second copy with the import.
4. Pure functions only — no side effects, I/O, DB access, or logging.
5. Test the helper in `packages/contracts/test/<name>.test.ts`, not in its callers.
6. When you find an inline helper that should be shared, migrate it and every caller in the same change.

Show every percentage with `formatPercent(value, unit)`, never `(x * 100).toFixed(…)`: each ratio field declares its wire unit on its schema (`fraction()` / `percent()`, checked by `ratio-units.test.ts`), and `canonry-guards/no-inline-percent` flags inline percent formatting.

Fit trends and other statistics server-side (`linearTrend`, `wilsonInterval`) and put them in the DTO; a regression computed in a chart component is invisible to the CLI. Render a caught `unknown` with `describeError`, never `err instanceof Error ? err.message : String(err)`.

## Backend rules at a glance

Each rule is detailed in the linked file. The one-liners live here because these have caused real bugs.

- **API errors.** Throw `AppError` factories from `@ainyc/canonry-contracts` (`notFound()`, `validationError()`, …) and let the global handler serialize them; never catch-and-reply or hand-build an `{ error }` envelope. → `packages/api-routes/AGENTS.md` "Error handling"
- **Schema changes.** Every new table or column in `packages/db/src/schema.ts` needs a new `MIGRATION_VERSIONS` entry in `migrate.ts`; never edit `MIGRATION_SQL` or a shipped version. → `packages/db/AGENTS.md`
- **JSON / boolean columns.** `projects` uses Drizzle's native modes (direct access); other tables still need `parseJsonColumn<T>()` and manual boolean coercion. → `packages/db/AGENTS.md`
- **Transactions and counters.** Wrap multi-table writes in one `db.transaction()` (async I/O before it, the audit log inside it, callbacks after commit). Increment counters with `INSERT … ON CONFLICT DO UPDATE`, never read-then-write. → `packages/db/AGENTS.md`
- **Typed CLI client.** `ApiClient` methods return contracts DTOs, and commands never cast responses. → `packages/canonry/AGENTS.md` "ApiClient usage"
- **Config-as-code.** `canonry apply` / `POST /api/v1/apply` is declarative; `spec.queries` replaces the basket only when present (omitted = untouched). → `packages/api-routes/AGENTS.md` "Config-as-code apply"

## Third-party HTTP calls (Critical)

Every integration that calls a third party over HTTP must back off when that service pushes back. Wrap the package's HTTP layer in `withRetry` from `@ainyc/canonry-contracts` — one private `fetchOnce`, one exported wrapper (reference: `packages/integration-bing/src/bing-client.ts`) — and use `isRetryableHttpError` rather than a hand-written status check. `packages/contracts/test/integration-retry-coverage.test.ts` fails CI for a new HTTP-calling integration without it. Throttles that aren't HTTP 429, `Retry-After`, base-delay tuning, and testing both directions: `packages/contracts/AGENTS.md` → "Third-party HTTP calls".

## Authentication Storage

- The local config file at `~/.canonry/config.yaml` is the source of truth for authentication credentials.
- Store provider API keys, Google OAuth client credentials, and Google OAuth access/refresh tokens in the local config file.
- Do not treat the SQLite database as the authoritative store for authentication material.

## API Surface and Stability

All endpoints live under `/api/v1/` with `Authorization: Bearer cnry_...`; the full contract is `GET /api/v1/openapi.json` (no auth). **Never change an existing endpoint path or HTTP method** — the CLI, UI, and external integrations are hard-coded to them. Additive changes (new endpoints, new optional fields) are fine; renaming or restructuring needs a versioned migration plan and explicit user approval. If a route is wrong, fix the logic, not the URL.

## Probe runs (Critical)

A **probe run** (`runs.trigger = 'probe'`, `RunTriggers.probe`; `canonry run --probe` or `POST /api/v1/projects/:name/runs` with `"trigger": "probe"`) writes a snapshot for operator/agent inspection but MUST NOT influence the dashboard, analytics, intelligence, reports, or notifications.

1. Aggregate reads (dashboard, analytics, report, timeline, intelligence) AND-in `notProbeRun()` from `packages/api-routes/src/helpers.ts`, including recent-runs windows. Add a case to `packages/api-routes/test/probe-exclusion.test.ts` for every new aggregate endpoint.
2. Per-run detail endpoints that take a `runId` (`GET /runs/:id`, screenshots, browser diffs, GSC inspect lookups) include probes.
3. Operator lists (`GET /runs`, `GET /projects/:name/runs`) include probes; the dashboard filters them client-side (`apps/web/src/queries/use-dashboard.ts`).
4. `RunCoordinator` (`packages/canonry/src/run-coordinator.ts`) returns early for probes — no intelligence, webhooks, or Aero wake. New post-run subscribers keep that check.
5. External callers may send only `manual` or `probe` (`runTriggerRequestSchema`); `scheduled`, `config-apply`, and `backfill` are server-set.

## Base Path Awareness (Critical)

Canonry can run behind a reverse proxy sub-path (e.g. `/canonry/`); code that ignores `basePath` produces silent 404s in production.

- **CLI:** always `createApiClient()` — it folds `config.yaml` and `CANONRY_BASE_PATH` into `apiUrl`. Never `new ApiClient(loadConfig().apiUrl, …)`.
- **Server:** register routes through the plugin's `routePrefix`; never hardcode `/api/v1`. Redirect and OAuth callback URLs use `publicUrl` or `apiUrl`, which already include the base path.
- **Web:** read `window.__CANONRY_CONFIG__.basePath` for API calls and the router base.
- **`GET /health`** (also served at `<basePath>health`) reports `basePath` plus build and instance identity. Field contract: `packages/canonry/AGENTS.md` → "Health endpoint"; adding fields is fine, renaming or removing one is breaking.

## Versioning

**Bump the package version only for non-documentation changes of more than 100 changed lines** (features, bug fixes, refactors, dependency updates, and the tests that accompany them); documentation-only changes (README, `docs/`, `AGENTS.md`) and smaller changes don't bump. A bump updates the root `package.json` and `packages/canonry/package.json` together, in sync with the latest published `@canonry/canonry` (and the compatibility `@ainyc/canonry`). Use semver: patch for fixes, minor for features, major for breaking changes.

- **Native-plugin exception:** any change shipped through `plugins/canonry/` or its canonical `skills/canonry/` / `skills/aero/` sources bumps Canonry, the portable manifest, and both client manifests even when the diff is small — clients use the manifest version to discover updates. `pnpm plugin:sync` copies the package version into all three manifests.

## Testing

**Every non-trivial change ships with tests** — features, bug fixes, and refactors. Typo, comment, and config-only changes are exempt. Vitest runs the workspace projects in `vitest.config.ts`; tests live in each package's `test/` directory.

- Test the public API of each module, not internals. Cover the happy path plus meaningful edge cases (invalid input, env var overrides, error handling).
- CLI tests capture stdout/stderr and assert on the output, not only side effects. File-system tests use `os.tmpdir()` and clean up in `afterEach`.
- Run focused tests during development; CI runs the full suite. Hooks never run tests or builds.
- **Test boundary matchers with data as STORED, not idealized.** Check how a column is actually populated before matching on it (project upsert/apply store `canonicalDomain` raw — full URLs and mixed case included) and use the canonical helpers (`hostOf`, `normalizeQueryText`). A clean-fixture-only suite passes while production values miss the match.
- **Test default-value propagation end-to-end.** When a stored default (e.g. a project's `defaultLocation`) feeds another feature (run creation), exercise the full path with no explicit override — not just "the default is stored" and "the consumer accepts a value".

## Code Comments

- **Never use comments as a substitute for code.** `// else use project default` is a wish, not an implementation: a branch a comment describes must exist. ESLint's `no-warning-comments` flags `TODO` / `FIXME` / `HACK` so deferred work doesn't rot.
- **No placeholder branches.** Write the code for a case that should do something; an intentional no-op gets an explicit empty block with a comment saying why (`// allLocations handled in the block below`).

## Lint Guards (Critical)

Several rules in this file are true only because a lint guard enforces them — see `docs/GUARDS.md` for the full guard table and `Adding a guard` procedure. Every guard has its own rule id in `eslint.config.js`; **never add options to core `no-restricted-syntax`** (flat config last-wins override clobbers prior guards with no diagnostic — 4 dead guards found 2026-08-05). Key guards: `canonry-guards/no-raw-http-web` (apps/web → SDK), `canonry-guards/no-raw-http-cli` (canonry → ApiClient), `canonry-vocabulary/no-banned-metric-literal`, `design-tokens/no-literal-palette` — full list in `docs/GUARDS.md`.

## CI Guidance

- **CI owns full workspace validation** (typecheck, test, lint on PRs, explicit job permissions). Locally, run `pnpm check` plus the tests or package typechecks relevant to your change; run `pnpm verify` only when asked or reproducing a CI failure. After another edit or rebase, rerun only the affected checks. Report local results and CI status separately.
- **Git hooks stay fast.** Commits lint staged JS/TS only (content caches shared across worktrees; `--no-cache` to diagnose) and never run tests, builds, or typechecks; documentation-only commits skip ESLint. ESLint config or rule changes trigger full type-aware lint, so code and config must match the index — don't hide staged errors with unstaged fixes. The commit-message hook checks Conventional Commits. Pre-push runs only `gen:check --committed`, `plugin:check`, and `val:skills:check`, and drift inputs must match each pushed commit.
- **Build only the affected surface:** `pnpm build:cli` for CLI/server, `pnpm build:web` for the dashboard.
- **Fix drift at its source** (`pnpm gen`, `pnpm plugin:sync`, `pnpm val:skills`), review the generated changes, and stage generated SDK changes before `gen:check`. Never weaken assertions to obtain a pass.
- **Vals have no CI/CD** — manual validation, publish, and deploy order: `packages/val-kit/AGENTS.md`. **Adding a guard:** `docs/GUARDS.md`.

### Landing a PR here (read before opening one)

Four traps have cost real time here. CI validates the branch, and these are all about the branch's relationship to `main`, so a green run never reveals them.

1. **The version race.** `publish.yml` releases only when `packages/canonry/package.json` differs from the *previous commit on main*. A PR bumping to a version `main` has since reached merges with no version change: npm and Homebrew are skipped while Docker still moves `latest` — a silent half-release. `plugin:check --base-ref` compares against the merge base, so it passes in exactly this case; the `version-guard` job (base-branch tip and npm) predicts the post-merge outcome. **Re-check the version right before you push**, not when you branch.
2. **Stacked PRs after a squash merge.** `main` squashes, so a branch stacked on a merged parent still carries the parent's individual commits. GitHub retargets the base but does not rewrite history. Rebase with `git rebase --onto origin/main <old-base-tip> <branch>`.
3. **Waiting for CI.** `gh pr checks` returns an EMPTY list between a push landing and the workflows queueing, so a "wait until nothing is pending" loop reports success against no checks. Require a non-empty list before believing a green result.
4. **Auto-merge is disabled repo-wide**, so `gh pr merge --auto` is rejected and a green, approved PR still needs a manual merge.

## Keeping Documentation Current

Per-package `AGENTS.md` must stay in sync — see `docs/DOC_UPDATE.md` for the full “When you… → Update…” table (route/CLI/MCP/doctor/guard/provider etc.).

Put a new rule in the `AGENTS.md` closest to the code it governs; add it here only if every change must follow it. Point to the source (`path` or `file:line`) instead of copying it, and leave out what an agent can learn from the code, `--help`, or `docs/CODEMAP.md`.

`AGENTS.md` is the only agent-instruction file. Claude Code v2.1.277+ reads it directly, but only where no `CLAUDE.md`, `.claude/CLAUDE.md`, or `CLAUDE.local.md` is on the path, so never add one: it hides the `AGENTS.md` beside and below it. Claude Code sessions that cannot read `AGENTS.md` directly (before v2.1.277, on Bedrock / Vertex / Foundry, or with telemetry disabled) get no project instructions from this repo.

**Documentation-only changes do not require a version bump.**
