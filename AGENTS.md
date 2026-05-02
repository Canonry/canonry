# AGENTS.md

## Project Overview

`canonry` is an **agent-first** open-source AEO operating platform that tracks how AI answer engines cite a domain for tracked keywords and acts on the signal through the content engine and integrations. Published as `@ainyc/canonry` on npm. The CLI and API are the primary interfaces — the web dashboard is supplementary.

## Workspace Map

```text
apps/api/                        Cloud API entry point (imports packages/api-routes)
apps/worker/                     Cloud worker entry point
apps/web/                        Vite SPA source (bundled into packages/canonry/assets/)
packages/canonry/                Publishable npm package (CLI + server + bundled SPA)
packages/api-routes/             Shared Fastify route plugins
packages/contracts/              DTOs, enums, config-schema, error codes
packages/config/                 Typed environment parsing
packages/db/                     Drizzle ORM schema, migrations, client (SQLite/Postgres)
packages/provider-gemini/        Gemini adapter
packages/provider-openai/        OpenAI adapter
packages/provider-claude/        Claude/Anthropic adapter
packages/provider-local/         Local LLM adapter (OpenAI-compatible API)
packages/provider-perplexity/    Perplexity adapter
packages/provider-cdp/           Chrome DevTools Protocol adapter
packages/integration-google/     Google Search Console integration
packages/integration-google-analytics/  Google Analytics 4 integration
packages/integration-bing/       Bing Webmaster Tools integration
packages/integration-wordpress/  WordPress integration
docs/                            Architecture, roadmap, testing, ADRs
```

Start with `docs/README.md` when you need the current doc map, active plans, ADR index, or canonical roadmap.

## Commands

```bash
# One-command dev setup: install deps, build all packages, install canonry globally
./canonry-install.sh

pnpm install
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run dev:web

# CLI
canonry init
canonry serve
canonry project create <name> --domain <domain> --country US --language en
canonry keyword add <project> <keyword>...
canonry keyword replace <project> <keyword>...
canonry competitor add <project> <domain>...
canonry competitor remove <project> <domain>...
canonry run <project>
canonry run <project> --provider gemini          # single-provider run
canonry status <project>
canonry apply <file...>                          # multi-doc YAML + multiple files
canonry export <project>

# Agent layer
canonry agent ask <project> "<prompt>"               # one-shot turn against built-in Aero
canonry agent ask <project> "<prompt>" --provider zai --format json
canonry agent attach <project> --url <webhook-url>   # subscribe an external agent to run/insight events
canonry agent detach <project>                       # remove the agent webhook
canonry agent memory list <project>                  # list Aero's durable project-scoped notes
canonry agent memory set <project> --key <k> --value <v>    # upsert a note (2 KB max)
canonry agent memory forget <project> --key <k>      # delete a note

# Doctor — health checks (extensible registry: google.auth.*, ga.auth.*, config.providers, …)
canonry doctor                                                # global checks (provider keys, etc.)
canonry doctor --project <name>                               # project-scoped checks (Google/GA auth, redirect URI, scopes)
canonry doctor --project <name> --check google.auth.* --format json   # filter by id/wildcard, JSON output

# MCP adapter (separate bin, stdio only)
canonry-mcp                                          # core tier (~12 tools); load toolkits on demand
canonry-mcp --read-only                              # core read tier; toolkits load read-only tools only
canonry-mcp --eager                                  # register all 51 API tools at startup (legacy flat catalog)

# MCP client install helpers (operate on local client config files)
canonry mcp install --client claude-desktop          # merges a canonry entry into the config
canonry mcp install --client cursor --read-only      # scope to the 35 read tools
canonry mcp config  --client codex                   # print snippet for clients without auto-install

# Skills — install canonry's agent playbook into a user's project
canonry skills list                                  # show bundled skills (canonry-setup, aero)
canonry skills install                               # write both skills into ./.claude/skills/ + ./.codex/skills/ (default)
canonry skills install aero --client claude          # install only the analyst skill, no codex symlink
canonry skills install --dir ~/projects/foo --force  # custom target, overwrite divergent local edits
```

## Agent Layer

Canonry ships a built-in AI agent called **Aero**, backed by
[`@mariozechner/pi-agent-core`](https://github.com/badlogic/pi-mono). Aero
is an AEO analyst: it reads project state, analyzes regressions, acts
through a typed tool surface (runs sweeps, dismisses insights, attaches
webhooks, updates schedules), and **wakes up unprompted** when runs
complete — producing an analysis without a user request.

Users who prefer their own agent (Claude Code, Codex, custom) still get
the external-agent webhook path via `canonry agent attach <url>`.

### Built-in Aero (native loop)

- **CLI:** `canonry agent ask <project> "<prompt>"` — one-shot, streams
  `AgentEvent`s to stdout. Supports `--provider claude|openai|gemini|zai`
  and `--format json`.
- **Dashboard:** the bottom command bar on every project-scoped route.
  SSE-streamed. Starter buttons cover the common ops (status, insights,
  last failed run, schedule).
- **Proactive:** `RunCoordinator` fires a synthesized user message into the
  session's follow-up queue after each `run.completed`; `SessionRegistry.drainNow`
  wakes the agent to analyze and writes the response back to the transcript
  before the next interaction.
- **Persistence:** one rolling session per project in the `agent_sessions`
  table. Transcript + queued follow-ups survive `canonry serve` restarts.

Key files:
- `packages/canonry/src/agent/session.ts` — `createAeroSession` (pi integration)
- `packages/canonry/src/agent/session-registry.ts` — hybrid in-memory + DB registry
- `packages/canonry/src/agent/tools.ts` — thin wrapper that exposes the entire MCP tool registry to Aero via `mcp-to-agent-tool.ts`
- `packages/canonry/src/agent/mcp-to-agent-tool.ts` — adapter; new MCP tools flow into Aero with no second registration
- `packages/canonry/src/agent/agent-routes.ts` — Fastify SSE endpoints
- `apps/web/src/components/shared/AeroBar.tsx` — dashboard UI

### External agents (webhook)

`canonry agent attach <project> --url <webhook-url>` registers a webhook for
the project. `canonry agent detach <project>` removes it. Events:
`run.completed`, `insight.critical`, `insight.high`, `citation.gained`.

## Doctor

`canonry doctor` runs an extensible set of health checks across global config and project-scoped integrations. Each check has a stable dotted ID (`google.auth.connection`, `ga.auth.connection`, `config.providers`, …) so an agent or skill can filter via `--check <id>` / `?check=<id>` and react to specific failures programmatically.

- **CLI:** `canonry doctor [--project <name>] [--check <id>...] [--format json]`
- **API:** `GET /api/v1/doctor` (global), `GET /api/v1/projects/:name/doctor` (project-scoped). Both accept `?check=<comma-separated ids or wildcards>`.
- **MCP:** `canonry_doctor` (core tier) — passes `project` + `checks[]` straight through.

Each check returns `status: ok | warn | fail | skipped`, a stable machine-readable `code`, a `summary`, optional `remediation`, and structured `details`. v1 ships:

| Category | ID | Scope | Purpose |
|----------|----|-------|---------|
| auth | `google.auth.connection` | project | OAuth credentials present, refresh token works |
| auth | `google.auth.property-access` | project | Authorized principal can list the selected GSC site |
| auth | `google.auth.redirect-uri` | project | `publicUrl`-derived redirect URI is valid + advertised |
| auth | `google.auth.scopes` | project | Granted GSC + Indexing scopes match what's stored |
| auth | `ga.auth.connection` | project | GA4 service account verifies against the configured property |
| providers | `config.providers` | global | At least one provider key configured |

### Adding a new check

1. Implement a `CheckDefinition` in `packages/api-routes/src/doctor/checks/<topic>.ts`. Use `@ainyc/canonry-contracts` `CheckStatuses` / `CheckCategories` / `CheckScopes` enums — never raw strings.
2. Register it in `packages/api-routes/src/doctor/registry.ts` (`ALL_CHECKS`).
3. Add a `<topic>.ts` test under `packages/api-routes/test/doctor-*` covering the happy path + each `code` value the check can emit.
4. Both the CLI and MCP tool surface the new check automatically — no additional wiring required.

### MCP clients (stdio adapter)

For MCP clients such as Claude Desktop, Codex, or custom agent shells that
prefer a typed tool catalog over shell or HTTP, the package ships a separate
`canonry-mcp` bin. It is a thin stdio adapter over `createApiClient()` — not
a parallel surface. v1 exposes 50 curated tools (35 read, 15 write) — including
the `canonry_project_overview` and `canonry_search` core composites; the
catalog is split across a small **core tier** (always loaded) and five
**toolkits** (`monitoring`, `setup`, `gsc`, `ga`, `agent`) that the client
loads on demand via `canonry_load_toolkit`. The catalog coalesces enable
side effects so each `canonry_load_toolkit` call emits exactly one
`notifications/tools/list_changed`. Pass `--read-only` to surface
only the read tools, or `--eager` (or `CANONRY_MCP_EAGER=1`) to register
every tool at startup like the previous flat catalog. Auth is inherited
from `~/.canonry/config.yaml`.

Key files:
- `packages/canonry/src/mcp/server.ts` — `createCanonryMcpServer` (one client per server instance, registers core tier + meta tools)
- `packages/canonry/src/mcp/cli.ts` — stdio entrypoint + scope/eager flag parsing
- `packages/canonry/src/mcp/tool-registry.ts` — single source of truth for all 50 tools, each tagged with a `tier`
- `packages/canonry/src/mcp/toolkits.ts` — toolkit catalog (`monitoring`, `setup`, `gsc`, `ga`, `agent`) consumed by `canonry_help`
- `packages/canonry/src/mcp/dynamic-catalog.ts` — `DynamicToolCatalog`: enables tools on `canonry_load_toolkit`, drives `canonry_help`
- `packages/canonry/src/mcp/openapi-classification.ts` — drift table; every published OpenAPI op is `included`, `deferred`, or `excluded-protocol`
- `packages/canonry/src/mcp/results.ts` — `withToolErrors` wrapper, `CliError` → MCP error envelope mapping
- `packages/canonry/bin/canonry-mcp.mjs` — published bin shim
- `docs/mcp.md` — install, auth, client config, safety rules, tier system, and v1 limitations

The MCP adapter must follow the boundary rules in `Surface Priority → Agent
& automation design principles → MCP adapter boundary` (rule 8 in this
file): no DB, route, job-runner, telemetry, or logger imports; never write
non-MCP data to stdout. Every new MCP tool must already exist as a public
API endpoint and CLI command — MCP is not a place to add capabilities.

### Notification events (shared)

The notification system supports `citation.lost`, `citation.gained`, `run.completed`,
`run.failed`, `insight.critical`, `insight.high`. `insight.critical` and
`insight.high` fire when the intelligence engine generates critical- or
high-severity insights after a run — dispatched by `RunCoordinator` after
`IntelligenceService.analyzeAndPersist()` completes.

## Dependency Boundary

- `packages/api-routes/` must not import from `apps/*`.
- `packages/canonry/` is the only publishable artifact. Internal packages are bundled via tsup.
- All internal packages use `@ainyc/canonry-*` naming convention.

## Vocabulary (Critical)

Canonry tracks two parallel signals for every (keyword × provider) snapshot. They are independent — a model can do either, both, or neither — and must never be conflated in code, copy, or contract field names.

| Term | Meaning | Source field |
|------|---------|--------------|
| **mention / mentioned** | The project's brand or domain appears in the actual LLM answer text response (the prose the model returns). | `query_snapshots.answer_mentioned` (boolean) |
| **cited** | The project's domain appears in the source links/material the LLM used to get the answer (the structured grounding / citations / search-result list returned alongside the answer). | `query_snapshots.citation_state` = `'cited'` |

### Rules

1. **Use `mention` / `mentioned` for answer-text presence.** Never use `answer`, `visible`, or `visibility` for new code that means the same thing — those exist as legacy terms (DB column `visibility_state`, run kind `answer-visibility`, function `visibilityStateFromAnswerMentioned`) but new APIs, fields, CLI flags, and UI labels must say `mentioned`.
2. **Use `cited` for source-list presence.** Never use `citation` as an umbrella for both signals — citation refers specifically to the source-attribution side.
3. **Never compute one signal from the other.** A label that says "cited" must read `citationState` (or a derived `cited: boolean`); a label that says "mentioned" must read `answerMentioned`. If you find a metric named for one signal but computed from the other, that's a bug — fix it, don't paper over it.
4. **When you need to refer to both at once,** say "citation + mention coverage" or "visibility (cited or mentioned)" — but always disambiguate immediately.
5. **Public API field names** must use the canonical vocabulary. Renaming a field means a version bump per the API Stability rules, so get it right the first time.

### Anti-patterns

```typescript
// ❌ Wrong — name says "answer", reader can't tell which signal
{ answerRate: 0.42 }

// ✅ Correct
{ mentionRate: 0.42 }

// ❌ Wrong — "visible" is ambiguous (cited? mentioned? both?)
let visible = 0
if (mentioned) visible++

// ✅ Correct
let mentioned = 0
if (answerMentioned) mentioned++

// ❌ Wrong — "Citation visibility" headline that counts answer-text mentions
"Cited by 3 of 4 engines" // computed from answerMentioned

// ✅ Correct — distinct headlines for the two signals
"Cited by 2 of 4 engines"     // citationState
"Mentioned in 3 of 4 answers" // answerMentioned
```

## Enum Constants (Critical)

**Never compare domain values as raw string literals.** Use the enum constant objects exported from `packages/contracts/src/run.ts` (re-exported via `@ainyc/canonry-contracts`).

### Available constants

| Constant | Type | Values |
|----------|------|--------|
| `RunKinds` | `RunKind` | `RunKinds['answer-visibility']`, `RunKinds['gsc-sync']`, etc. |
| `RunStatuses` | `RunStatus` | `RunStatuses.completed`, `RunStatuses.failed`, etc. |
| `RunTriggers` | `RunTrigger` | `RunTriggers.manual`, `RunTriggers.scheduled`, etc. |
| `CitationStates` | `CitationState` | `CitationStates.cited`, `CitationStates['not-cited']` |
| `VisibilityStates` | `VisibilityState` | `VisibilityStates.visible`, `VisibilityStates['not-visible']` |
| `ComputedTransitions` | `ComputedTransition` | `ComputedTransitions.lost`, `ComputedTransitions.emerging`, etc. |

### Rules

1. **Import and use the constant objects** — never write `kind === 'answer-visibility'`, write `kind === RunKinds['answer-visibility']`.
2. **Type function parameters with the union type** — use `kind: RunKind` not `kind: string`. This enables exhaustive switch checking.
3. **Use exhaustive switches** — when all cases are covered, omit the `default` branch so TypeScript errors if a new variant is added. If a default is needed, use `default: { const _exhaustive: never = value; }` to catch missing cases at compile time.
4. **Add new variants to the Zod schema in `packages/contracts/src/run.ts`** — the constant object is derived from it automatically via `schema.enum`.

### Pattern

```typescript
import type { RunKind } from '@ainyc/canonry-contracts'
import { RunKinds, RunStatuses } from '@ainyc/canonry-contracts'

// ✅ Correct — enum constant + typed parameter + exhaustive switch
function kindLabel(kind: RunKind): string {
  switch (kind) {
    case RunKinds['answer-visibility']: return 'Answer visibility sweep'
    case RunKinds['gsc-sync']: return 'GSC sync'
    case RunKinds['inspect-sitemap']: return 'Sitemap inspection'
    case RunKinds['site-audit']: return 'Site audit'
  }
}

// ❌ Wrong — raw string literals, untyped parameter
function kindLabel(kind: string): string {
  switch (kind) {
    case 'answer-visibility': return 'Answer visibility sweep'
    default: return kind
  }
}
```

## Surface Priority

THIS IS AN **AGENT-FIRST** PLATFORM. The CLI and API are the primary interfaces. The web UI is a nice-to-have — it must never block or delay CLI/API work.

### Priority order
1. **API** — the shared backbone. Every capability must be exposed here first.
2. **CLI** — the primary user-facing surface. Must feel complete and polished.
3. **Web UI** — important but lower priority. Ideally all features have a UI, but never block a release on it.

### When adding a new feature
1. **Required:** Add the API endpoint in `packages/api-routes/`.
2. **Required:** Add the CLI command in `packages/canonry/src/commands/`.
3. **Ideal:** Add the UI interaction in `apps/web/` — aim to include it, but never block a release waiting for UI work.

### UI/CLI parity (Critical)

**Every dashboard view, widget, and computed metric visible in the web UI must have an equivalent API endpoint and CLI command that returns the same data.** The UI is a consumer of the API, not a privileged surface. If a user can see it in the browser, an agent must be able to read it from the CLI.

#### Rules

1. **No UI-only calculations.** If the UI computes a derived metric (percentages, trends, diffs, scores, roll-ups), that calculation must live in the API response — not in frontend component code. The API returns the computed value; both the UI and CLI consume it.
2. **No UI-only state.** Every dashboard panel, section, or page that displays data must map to a CLI command. If the UI shows a "Social Referral Summary" card, there must be a `canonry ga social-referral-summary` command that returns the same information.
3. **Mirror granularity.** If the UI shows both a summary and a detail view, the CLI must offer both. A single dump endpoint that requires agents to post-process is not equivalent.
4. **Same data, same shape.** The JSON output of `--format json` for a CLI command should be structurally identical to the API response the UI consumes. An agent should be able to replace a UI `fetch()` call with a `canonry ... --format json` call and get the same fields.

#### When adding a new UI component

Before building any new dashboard section or widget:

1. Confirm the backing API endpoint already exists (or add it first).
2. Confirm the matching CLI command already exists (or add it first).
3. Ensure all derived metrics and calculations are in the API response, not computed in the component.
4. The UI component should only be responsible for layout and presentation — never for business logic or data aggregation.

#### Anti-patterns

```typescript
// ❌ Wrong — UI computes a metric that agents can't access
const aiShare = Math.round((traffic.aiSessions / traffic.totalSessions) * 100)

// ✅ Correct — API returns the computed metric, UI just displays it
// API response: { aiSharePct: 12 }
<span>{traffic.aiSharePct}%</span>
```

```typescript
// ❌ Wrong — UI aggregates raw data that the API doesn't expose as a summary
const totalBySource = referrals.reduce((acc, r) => { ... }, {})

// ✅ Correct — API has a summary endpoint, UI consumes it
// GET /projects/:name/ga/attribution returns { channelBreakdown: [...] }
```

### Agent & automation design principles

The CLI and API **are** the agent interface. MCP is allowed only as an adapter over the public API client. It is not a parallel surface and must not introduce capabilities unavailable through API/CLI. No virtual filesystem, no privileged agent SDK. If an AI agent can't do something with `canonry <command> --format json` or an HTTP call, it's a bug.

#### Rules

1. **No interactive prompts.** Every CLI command must be fully operable via flags and environment variables. Never import `node:readline` in command files — ESLint enforces this. If a value is sensitive (API keys, passwords), accept it via `--flag`, env var, or `config.yaml`. Prompts are allowed only in `canonry init` as a convenience; all init values must also be passable via flags.
2. **JSON everywhere.** Every command that produces output must support `--format json`. JSON output goes to stdout. Errors go to stderr as `{ "error": { "code": "...", "message": "..." } }`. Human-readable text is the default; JSON is the machine contract.
3. **Idempotent writes.** `canonry apply` is the model — running it twice with the same input produces the same state. New write commands must follow this pattern. `POST` endpoints that create resources (like runs) are exempt, but must return a stable identifier and handle conflicts gracefully (e.g., `runInProgress` error with the existing run ID).
4. **Single-call reads.** If an agent needs two API calls to answer a common question, add a composite endpoint. Examples: `/projects/:name/runs/latest` (don't make agents list-then-filter), `/projects/:name/search?q=term` (don't make agents fetch all snapshots to grep). The test: can an agent get what it needs in one `curl` call?
5. **Meaningful exit codes.** `0` = success, `1` = user error (bad input, not found, validation), `2` = system error (network, provider failure, internal). Agents use exit codes to decide whether to retry.
6. **Stable output contracts.** JSON field names, endpoint paths, and error codes are public API. Renaming a JSON field is a breaking change. Add fields freely; never remove or rename without a version bump.
7. **UI/CLI parity.** Every piece of data or computed metric visible in the web UI must be retrievable via the API and CLI. If the UI shows it, an agent must be able to `curl` or `canonry ... --format json` it. Derived calculations (percentages, trends, roll-ups) belong in the API response, not in frontend code. See the "UI/CLI parity" section above for the full rules.
8. **MCP adapter boundary.** `canonry-mcp` may call `createApiClient()` and public client methods only. It must not import DB modules, API routes, job runners, CLI dispatch, telemetry, or loggers, and it must never write non-MCP data to stdout.

#### Checklist for any new command or endpoint

- [ ] Fully operable without interactive input (no readline, no prompts)
- [ ] `--format json` supported, outputs to stdout
- [ ] Errors output structured JSON to stderr with a code from `CliError`
- [ ] Write operations are idempotent (or return conflict details)
- [ ] Common read patterns achievable in a single API call
- [ ] Exit code follows 0/1/2 convention

#### Checklist for any new UI component

- [ ] Backing API endpoint exists and returns all data the component displays
- [ ] Matching CLI command exists with `--format json` support
- [ ] All derived metrics (percentages, trends, diffs) are computed in the API, not the component
- [ ] JSON shape from CLI matches the API response the UI fetches

## Maintenance Guidance

- Keep shared shapes in `packages/contracts`.
- Keep environment parsing in `packages/config`.
- Keep provider logic in `packages/provider-*/`.
- Keep API route plugins in `packages/api-routes` (no app-level concerns).
- Keep API handlers thin.
- Keep the canonry app independent from the audit package repo except for the published npm dependency.
- Raw observation snapshots only (`cited`/`not-cited`); transitions computed at query time.

## Error Handling in API Routes (Critical)

The global error handler in `packages/api-routes/src/index.ts` catches `AppError` instances and serializes them with the correct status code and JSON envelope. Route handlers must leverage this — never duplicate the serialization logic.

### Rules

1. **Throw `AppError` — never catch and manually reply.** Call `resolveProject(app.db, name)` directly. If the project doesn't exist it throws `notFound()`, which the global handler catches. Do not wrap in try-catch or use a `resolveProjectSafe` helper.
2. **Always use factory functions from `@ainyc/canonry-contracts`.** Never hand-construct `{ error: { code: '...', message: '...' } }`. Use `validationError()`, `notFound()`, `authRequired()`, `providerError()`, etc. This guarantees typed error codes and a consistent envelope.
3. **New error codes** must be added to the `ErrorCode` union in `packages/contracts/src/errors.ts` with a corresponding factory function.

### Pattern

```typescript
// ✅ Correct — let the global handler serialize
import { validationError, notFound } from '@ainyc/canonry-contracts'
import { resolveProject } from './helpers.js'

const project = resolveProject(app.db, request.params.name) // throws notFound on miss
if (!body.keywords?.length) throw validationError('"keywords" must be non-empty')

// ❌ Wrong — duplicates global handler logic
try {
  const project = resolveProject(app.db, name)
} catch (e) {
  reply.status(e.statusCode).send(e.toJSON()) // never do this
}
return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: '...' } }) // never do this
```

## JSON Column Parsing (Critical)

Many SQLite text columns store JSON (`projects.locations`, `providers`, `tags`, `labels`, `citedDomains`, etc.). Always use the typed helper from `@ainyc/canonry-db` — never call `JSON.parse` directly on DB column values.

### Rules

1. **Use `parseJsonColumn(value, fallback)` from `@ainyc/canonry-db`.** It handles null, empty strings, and invalid JSON safely.
2. **Never write `JSON.parse(row.field || '[]') as SomeType[]`** — this pattern is fragile (missing fallback = crash, wrong cast = silent corruption).
3. `JSON.parse` is fine for HTTP request bodies, config files, and other non-DB sources.

### Pattern

```typescript
import { parseJsonColumn } from '@ainyc/canonry-db'

// ✅ Correct
const locations = parseJsonColumn<LocationContext[]>(project.locations, [])
const labels = parseJsonColumn<Record<string, string>>(project.labels, {})

// ❌ Wrong
const locations = JSON.parse(project.locations || '[]') as LocationContext[]
```

## ApiClient Type Safety

All `ApiClient` methods in `packages/canonry/src/client.ts` must return typed DTOs from `@ainyc/canonry-contracts`. CLI commands must not cast API responses with `as Record<string, unknown>` or `as { ... }`.

- Define response interfaces in `packages/contracts/` when they don't already exist.
- The `request<T>()` method is already generic — specify the correct type parameter.
- When adding a new API endpoint, add the corresponding client method with a typed return value.

## Transaction Boundaries

Multi-table writes must be wrapped in a single `db.transaction()` call to ensure atomicity.

### Rules

1. **Do all async I/O (HTTP calls, DNS lookups, validation) before entering the transaction.** SQLite transactions must be synchronous (better-sqlite3 requirement).
2. **Include audit log writes inside the transaction** — `writeAuditLog()` accepts transaction context via its `Pick<DatabaseClient, 'insert'>` parameter.
3. **Fire callbacks (e.g., `onScheduleUpdated`) after the transaction commits**, not inside it.

### Pattern

```typescript
// Validate async work first
const urlCheck = await resolveWebhookTarget(url)
if (!urlCheck.ok) throw validationError(urlCheck.message)

// Then do all writes atomically
app.db.transaction((tx) => {
  tx.update(projects).set({ ... }).where(...).run()
  tx.delete(keywords).where(...).run()
  for (const kw of newKeywords) {
    tx.insert(keywords).values({ ... }).run()
  }
  writeAuditLog(tx, { ... })
})

// Fire callbacks after commit
opts.onScheduleUpdated?.('upsert', projectId)
```

## Atomic Counters

Use `INSERT ... ON CONFLICT DO UPDATE` for counter increments. Never use read-then-write patterns, which lose counts under concurrent requests.

### Pattern

```typescript
import { sql } from 'drizzle-orm'

db.insert(usageCounters).values({
  id: crypto.randomUUID(), scope, period, metric, count: 1, updatedAt: now,
}).onConflictDoUpdate({
  target: [usageCounters.scope, usageCounters.period, usageCounters.metric],
  set: { count: sql`${usageCounters.count} + 1`, updatedAt: now },
}).run()
```

## Database Schema Changes (Critical)

**Every new `sqliteTable(...)` in `packages/db/src/schema.ts` MUST have a corresponding migration in `packages/db/src/migrate.ts`.**

This is not optional. If you add a table to the schema but omit the migration, the table will never be created in any existing or new database, and every query against it will throw `no such table` at runtime.

### Rules

1. **New table** → append a `MIGRATION_VERSIONS` entry in `migrate.ts` with `CREATE TABLE IF NOT EXISTS ...` plus every index from the schema definition.
2. **New column** → append a `MIGRATION_VERSIONS` entry with `ALTER TABLE ... ADD COLUMN ...`. The runner swallows the SQLite "duplicate column name" error so the statement is safe to re-run.
3. **Removed column or table** → SQLite does not support `DROP COLUMN` on older versions; document the intent and leave the entry's `statements[]` as a comment-only no-op if needed.
4. **Never edit `MIGRATION_SQL`** (the initial block at the top). That block bootstraps brand-new installs and creates the `_migrations` tracking table. All incremental changes go in `MIGRATION_VERSIONS` only.
5. **Pick the next version number.** Find the highest existing `version` in `MIGRATION_VERSIONS` and add the next integer. Versions are recorded in the `_migrations` table on success; duplicate or out-of-order `version` values break the skip-already-applied logic.
6. **Never edit a previously-shipped version's `statements[]`.** Old DBs have already recorded that version as applied and will skip it on next boot — your edit will silently never run. Add a new version that fixes things up forward.
7. **Make every statement idempotent.** Each version commits in a single transaction; a non-recoverable failure mid-version rolls back and the next boot retries. Idempotent forms: `CREATE … IF NOT EXISTS`, `DROP … IF EXISTS`, `ALTER TABLE ADD COLUMN` (duplicate-column error swallowed), `UPDATE … WHERE` with a guard that becomes false after first apply.

### Pattern

```typescript
// In packages/db/src/migrate.ts — append to MIGRATION_VERSIONS:
{
  version: 47,
  name: 'my-new-feature',
  statements: [
    `CREATE TABLE IF NOT EXISTS my_new_table (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      value       TEXT NOT NULL,
      created_at  TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_my_new_table_project ON my_new_table(project_id)`,
  ],
},
```

### Checklist for any schema change

- [ ] Table/column added to `schema.ts`
- [ ] Matching migration added to `MIGRATIONS` in `migrate.ts`
- [ ] `pnpm typecheck && pnpm lint && pnpm test` all pass before committing

## Authentication Storage

- The local config file at `~/.canonry/config.yaml` is the source of truth for authentication credentials.
- Store provider API keys, Google OAuth client credentials, and Google OAuth access/refresh tokens in the local config file.
- Do not treat the SQLite database as the authoritative store for authentication material.

## Config-as-Code

Projects are managed via `canonry.yaml` files with Kubernetes-style structure:

```yaml
apiVersion: canonry/v1
kind: Project
metadata:
  name: my-project
spec:
  displayName: My Project
  canonicalDomain: example.com
  country: US
  language: en
  keywords:
    - keyword one
  competitors:
    - competitor.com
  providers:
    - gemini
    - openai
```

Locations are project-scoped via `spec.locations` and `spec.defaultLocation`. Runs choose the default location, an explicit location, all configured locations, or no location. Do not model locations as keyword-owned state.

Multiple projects can be defined in one file using `---` document separators. Apply with `canonry apply <file...>` (accepts multiple files) or `POST /api/v1/apply`. Applied project YAML is declarative input; runtime project/run data lives in the DB, while local authentication credentials live in `~/.canonry/config.yaml`.

## API Surface

All endpoints under `/api/v1/`. Auth via `Authorization: Bearer cnry_...`. Key endpoints:

- `PUT /api/v1/projects/{name}` — create/update project
- `POST /api/v1/projects/{name}/runs` — trigger visibility sweep
- `GET /api/v1/projects/{name}/timeline` — per-keyword citation history
- `GET /api/v1/projects/{name}/snapshots/diff` — compare two runs
- `POST /api/v1/apply` — config-as-code apply
- `GET /api/v1/openapi.json` — OpenAPI spec (no auth)

See OpenAPI spec at `/api/v1/openapi.json` for the complete API surface.

## Base Path Awareness (Critical)

Canonry supports running behind a reverse proxy with a sub-path prefix (e.g. `/canonry/`). All code that constructs URLs or registers routes **must** respect `basePath`. Failing to do so causes silent 404s in production.

### CLI commands — always use `createApiClient()`

Never instantiate `ApiClient` directly with `loadConfig()` in command files. Use the centralized helper:

```typescript
import { createApiClient } from '../client.js'

function getClient() {
  return createApiClient()
}
```

`createApiClient()` (in `packages/canonry/src/client.ts`) calls `loadConfig()` which incorporates `basePath` from both `config.yaml` and the `CANONRY_BASE_PATH` env var into `apiUrl` before constructing the client.

### Server routes — use `apiPrefix`

All API routes in `packages/api-routes/` are registered via a Fastify plugin with a `routePrefix` that already includes `basePath`. Do not hardcode `/api/v1` in route handlers or redirects. Use the prefix passed to the plugin.

### Health endpoint

The `/health` endpoint exposes `basePath` in its response for auto-discovery:
```json
{ "status": "ok", "service": "canonry", "version": "1.26.1", "basePath": "/canonry" }
```
When `basePath` is not configured, the `basePath` field is omitted.

### Web UI — use `window.__CANONRY_CONFIG__.basePath`

The SPA receives `basePath` via an injected config object. Use it for all API fetch calls and router base paths. Do not hardcode `/api/v1`.

### Checklist for any new route or CLI command

- [ ] Server route registered via the plugin's `routePrefix` (not hardcoded `/api/v1`)
- [ ] CLI command uses `createApiClient()` (not `new ApiClient(loadConfig().apiUrl, ...)`)
- [ ] Any redirect URLs or OAuth callback URLs use `publicUrl` or `apiUrl` (which already include basePath)
- [ ] Frontend fetch calls prepend `window.__CANONRY_CONFIG__.basePath`

## API Stability

**Never change existing API endpoint paths or HTTP methods during revisions.** The CLI, UI, and any external integrations are hard-coded to the published routes. Changing a path or method is a breaking change regardless of the reason.

- Additive changes (new endpoints, new optional fields) are fine.
- Renaming or restructuring existing routes requires a versioned migration plan and explicit user approval.
- If a route is wrong, fix the underlying logic — not the URL.

## Versioning

**Every non-documentation change must include a version bump.** The root `package.json` and `packages/canonry/package.json` versions must always be kept in sync with each other and with the latest published version on npm (`@ainyc/canonry`).

- Documentation-only changes (README, docs/, CLAUDE.md) do not require a bump.
- All other changes — features, bug fixes, refactors, dependency updates, test additions that accompany code changes — require a semver bump in both `package.json` files.
- Use semver: patch for fixes, minor for features, major for breaking changes.

## Testing

**Every non-trivial change must include tests.** If you are adding a feature, fixing a bug, or refactoring logic, ship tests alongside the code. Trivial changes (typo fixes, comment updates, config-only changes) are exempt.

- Use **Vitest** as the test runner. Configured via `vitest.workspace.ts` at the root with per-package `vitest.config.ts` files.
- Import test utilities from `vitest`: `import { test, expect, describe, it, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'`.
- Use `expect()` for assertions (e.g. `expect(value).toBe(expected)`, `expect(obj).toEqual(expected)`, `expect(fn).toThrow()`).
- Tests live in `test/` directories colocated with the package (e.g. `packages/canonry/test/`).
- Test the public API of each module, not internal implementation details.
- Cover both the happy path and meaningful edge cases (invalid input, env var overrides, error handling).
- When testing CLI commands, capture stdout/stderr and assert on output rather than only checking side effects.
- Use temp directories (`os.tmpdir()`) for file-system tests; clean up in `afterEach`.
- Run `pnpm run test` to verify before committing.
- **Test default-value propagation end-to-end.** When a feature stores a default (e.g., `defaultLocation` on a project) that another feature consumes (e.g., run creation), write a test that exercises the full path with no explicit override. Don't just test that the default is stored and that the consumer accepts a value — test that they connect.

## Code Comments

- **Never use comments as a substitute for code.** A comment like `// else use project default` is not implementation — it's a wish. If a branch is described in a comment, the code for that branch must exist. ESLint's `no-warning-comments` rule flags `TODO`/`FIXME`/`HACK` as warnings to prevent deferred work from rotting.
- **No placeholder branches.** If an `if/else if` chain has a case that should do something, write the code. If it intentionally does nothing, add an explicit empty block with a comment explaining why it's a no-op (e.g., `// allLocations handled in the block below`).

## CI Guidance

- Validation CI: `typecheck`, `test`, `lint` across the full workspace on PRs.
- Keep explicit job permissions.
- Publish workflow will be added when `packages/canonry/` is ready for npm.

## Keeping Documentation Current

This repo uses per-package `AGENTS.md` files for local context. **These must stay in sync with the code.** Update the relevant documentation when making structural changes:

| When you... | Update... |
|-------------|-----------|
| Add a new package under `packages/` or `apps/` | Create `AGENTS.md` + `CLAUDE.md` (`@AGENTS.md`) in the new package |
| Add a new table or column in `packages/db/src/schema.ts` | Update `docs/data-model.md` (ER diagram + table groups) |
| Add a new API route file in `packages/api-routes/src/` | Update `packages/api-routes/AGENTS.md` key files table |
| Add a new CLI command | Update `packages/canonry/AGENTS.md` |
| Add or change an MCP tool | Update `packages/canonry/src/mcp/tool-registry.ts` (tag with a `tier`), `openapi-classification.ts`, `docs/mcp.md`, and the `mcp-registry`/`mcp-stdio` tests. The built-in Aero agent picks the new tool up automatically through `agent/mcp-to-agent-tool.ts` — no second registration in `agent/tools.ts`. Add the name to `AERO_EXCLUDED_MCP_TOOLS` only if Aero must not invoke it (e.g. `canonry_agent_clear`). |
| Add a new doctor check | Add a `CheckDefinition` in `packages/api-routes/src/doctor/checks/<topic>.ts`, register in `doctor/registry.ts`, add tests in `packages/api-routes/test/doctor-*`, document the new check ID in `AGENTS.md`'s "Doctor" section |
| Add a new MCP toolkit | Add the toolkit name to `packages/canonry/src/mcp/toolkits.ts`, tag the relevant tools with the new tier, and update the toolkit table in `docs/mcp.md` |
| Add a new UI dashboard section or widget | Verify backing API endpoint + CLI command exist first (UI/CLI parity rule) |
| Add a new provider package | Update `docs/providers/README.md` and create `docs/providers/<name>.md` |
| Add a new integration package | Create `packages/integration-<name>/AGENTS.md` |
| Change a critical pattern (error handling, DB access, auth) | Update the relevant package's AGENTS.md patterns section |
| Add a new dependency between packages | Update `docs/architecture.md` module dependency graph |

**Documentation-only changes do not require a version bump.**

## Roadmap

See `docs/roadmap.md` for the full feature roadmap including competitive analysis, priority matrix, and phased implementation order.
