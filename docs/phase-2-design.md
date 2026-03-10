# Agent-First Architecture: Phase 2 Design (v3)

## Context

Canonry is an open-source AEO monitoring tool in Phase 1 (scaffolding). The web dashboard exists with mock data, but the backend is stubs. Phase 2 must produce a **publishable npm package** that a technical analyst can install globally and use immediately. The architecture must support a future cloud-hosted version with usage-based tiers without requiring a rewrite.

## Target Persona

**Technical analyst:** Knows terminal basics, wants the UI for analysis, comfortable with CLI for setup.

## Design Principles

1. **One command to start.** `npm install -g @ainyc/canonry` → `canonry init` → `canonry serve` → working instance.
2. **Surface parity.** Every feature must be equally accessible through CLI, API, and UI. No surface is privileged — the API is the shared backbone; both CLI and UI are clients of it.
3. **Single process for local.** API + job runner + bundled SPA in one Node.js process. No Docker, no Postgres, no message queue.
4. **SQLite locally, Postgres for cloud.** Same Drizzle ORM schema, different driver. Switch via env var.
5. **Same auth path everywhere.** Local mode auto-generates an API key on init. Code paths are identical to cloud.
6. **Visibility-only in Phase 2.** Site audit is deferred to Phase 3. No site-audit CLI commands, API branches, or UI placeholders ship in Phase 2.
7. **Track usage from day one.** Per-project, scoped counters — not global totals.
8. **API-complete.** Everything the CLI and UI can do goes through the API.

---

## 1. Packaging & Distribution

### The problem (P1 finding)

The repo has no publish workflow, no SPA build step, and no bundled artifact story. `apps/*` are deployable surfaces, `packages/*` are reusable libraries. A globally installed CLI cannot depend on `apps/` layout.

### The solution

Create `packages/canonry/` as the **publishable standalone package**. It is the only thing published to npm. It bundles:
- The Fastify API routes (extracted from `apps/api/` into `packages/api-routes/`)
- The built SPA assets (pre-built during package prepare step)
- The in-process job runner
- The CLI entry point

```
packages/canonry/            # The publishable npm package
  package.json               # name: @ainyc/canonry, bin: { canonry: ./dist/cli.js }
  src/
    cli.ts                   # CLI entry point (parseArgs routing)
    server.ts                # Unified server: mounts API routes + static SPA + job runner
    job-runner.ts            # In-process async job queue with concurrency control
    commands/
      init.ts                # First-time setup, creates ~/.canonry/
      serve.ts               # Starts the unified server
      project.ts             # Project CRUD
      keyword.ts             # Keyword management
      competitor.ts          # Competitor management
      run.ts                 # Trigger and check runs
      status.ts              # Project summary
      history.ts             # Audit log viewer
      apply.ts               # Config-as-code apply
      export.ts              # Export as YAML/JSON
    client.ts                # HTTP client for CLI → API communication
    config.ts                # Reads/writes ~/.canonry/config.yaml
  assets/                    # Built SPA files (populated by build script)
  build-web.ts               # Script: builds apps/web and copies to assets/
```

### Boundary discipline

```
packages/api-routes/         # NEW — shared Fastify route plugins (no app-level concerns)
  src/
    projects.ts              # Project CRUD route plugin
    keywords.ts              # Keyword route plugin
    competitors.ts           # Competitor route plugin
    runs.ts                  # Run trigger + results route plugin
    apply.ts                 # Config apply route plugin
    history.ts               # Audit log + snapshot endpoints
    openapi.ts               # Swagger/OpenAPI plugin
    auth.ts                  # Auth middleware plugin

apps/api/                    # Cloud deployment entry point (imports packages/api-routes)
apps/worker/                 # Cloud worker entry point (imports packages/provider-gemini)
apps/web/                    # SPA source (built and bundled into packages/canonry/assets/)
```

`apps/api/` becomes a thin entry point that imports route plugins from `packages/api-routes/`. The local server in `packages/canonry/server.ts` imports the same route plugins. Neither depends on the other's layout.

### Build & publish

```json
// packages/canonry/package.json
{
  "name": "@ainyc/canonry",
  "bin": { "canonry": "./dist/cli.js" },
  "scripts": {
    "build": "node build-web.ts && tsc",
    "prepublishOnly": "pnpm run build"
  },
  "files": ["dist/", "assets/"]
}
```

`build-web.ts` runs `pnpm --filter @ainyc/aeo-platform-web build` and copies the output to `packages/canonry/assets/`. The server uses `@fastify/static` to serve from this directory.

---

## 2. Installation & First Run

```bash
npm install -g @ainyc/canonry

canonry init
# → Creates ~/.canonry/ directory
# → Creates ~/.canonry/data.db (SQLite)
# → Prompts for provider API keys (Gemini, OpenAI, Claude — at least one required)
# → Auto-generates API key: cnry_abc123...
# → Saves config to ~/.canonry/config.yaml
# → Prints: "Ready. Run 'canonry serve' to open the dashboard."

canonry serve
# → Starts server on localhost:4100
# → Serves API at /api/v1/* (auth required, uses key from config)
# → Serves web dashboard at /
# → Opens browser
```

### Config file (`~/.canonry/config.yaml`)

```yaml
apiUrl: http://localhost:4100
database: ~/.canonry/data.db
apiKey: cnry_a1b2c3d4...                # auto-generated on init
providers:
  gemini:
    apiKey: gmni_...
    quota:
      maxConcurrency: 2
      maxRequestsPerMinute: 10
      maxRequestsPerDay: 1000
  openai:
    apiKey: sk-...
  claude:
    apiKey: sk-ant-...
```

### Auth (same path everywhere)

- `canonry init` generates a random API key, hashes it, stores the hash in SQLite's `api_keys` table, and saves the plaintext key in `~/.canonry/config.yaml`.
- Every API request (from CLI, UI, or external) requires `Authorization: Bearer cnry_...`.
- The web dashboard reads the key from a server-injected config (the local server embeds it in the HTML template since it owns both sides).
- Cloud mode: same auth plugin, keys created via bootstrap endpoint instead of init.
- Auth plugin lives in `packages/api-routes/src/auth.ts`. Skips only `/health` and `/api/v1/openapi.json`.

---

## 3. CLI Design

Visibility-only in Phase 2. No `site-audit` commands or options.

```bash
# Setup
canonry init                                    # First-time setup
canonry serve                                   # Start dashboard + API

# Project management
canonry project create <name> --domain <domain> --country US --language en
canonry project list
canonry project show <name>
canonry project delete <name>

# Keywords & competitors
canonry keyword add <project> <keyword>...
canonry keyword list <project>
canonry keyword import <project> <file.csv>
canonry competitor add <project> <domain>...
canonry competitor list <project>

# Runs (visibility only in Phase 2)
canonry run <project>                           # Trigger answer-visibility sweep
canonry run status <run-id>
canonry runs <project>

# Results
canonry status <project>                        # Summary: visibility score, latest run
canonry evidence <project>                      # Keyword-level citation results

# History & export
canonry history <project>                       # Config change audit trail
canonry export <project>                        # Export project config as YAML
canonry export <project> --include-results      # Config + latest run results as JSON

# Config-as-code
canonry apply <canonry.yaml>                    # Declarative apply
```

Uses `node:util` `parseArgs`. No heavy CLI framework.

---

## 4. Single-Process Server Architecture

```
┌──────────────────────────────────────────────┐
│              canonry serve                    │
│                                               │
│  ┌───────────────┐  ┌──────────┐  ┌────────┐ │
│  │ Fastify        │  │ Job      │  │ Static │ │
│  │ (api-routes)   │  │ Runner   │  │ (SPA)  │ │
│  │ /api/v1/*      │  │ (async)  │  │ /      │ │
│  └───────┬───────┘  └────┬─────┘  └────────┘ │
│          │               │                    │
│          └───────┬───────┘                    │
│           ┌──────┴──────┐                     │
│           │  Drizzle    │                     │
│           │  (SQLite)   │                     │
│           └─────────────┘                     │
└──────────────────────────────────────────────┘
```

- **Fastify API**: Mounts route plugins from `packages/api-routes/`. Same plugins used by cloud `apps/api/`.
- **Job Runner**: In-process async queue with concurrency control. When a run is triggered, it's queued and executed in the background. Simple `Map<string, Promise>` pattern. Cloud mode replaces this with pg-boss.
- **Static Server**: `@fastify/static` serves pre-built SPA from `packages/canonry/assets/`.

---

## 5. Database Schema (Drizzle ORM — SQLite + Postgres)

### Snapshot state model (P1 finding fix)

`query_snapshots` stores **raw observation state only**: `cited` or `not-cited`. The values `lost` and `emerging` are **transitions computed at query time** by comparing a keyword's current snapshot to its previous snapshot. This avoids the contradiction where stored state implies comparison but is written per-run.

### Tables

```sql
-- projects
CREATE TABLE projects (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,       -- slug, idempotency key
  display_name      TEXT NOT NULL,
  canonical_domain  TEXT NOT NULL,
  country           TEXT NOT NULL,
  language          TEXT NOT NULL,
  tags              TEXT NOT NULL DEFAULT '[]',
  labels            TEXT NOT NULL DEFAULT '{}',
  config_source     TEXT NOT NULL DEFAULT 'cli',
  config_revision   INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- keywords
CREATE TABLE keywords (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  keyword     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(project_id, keyword)
);

-- competitors
CREATE TABLE competitors (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  domain      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(project_id, domain)
);

-- runs (visibility only in Phase 2; kind always 'answer-visibility')
CREATE TABLE runs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'answer-visibility',
  status      TEXT NOT NULL DEFAULT 'queued',
  trigger     TEXT NOT NULL DEFAULT 'manual',
  started_at  TEXT,
  finished_at TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL
);

-- query_snapshots: raw observation per keyword per run
-- citation_state is 'cited' or 'not-cited' ONLY (raw observation)
-- transitions (lost, emerging) computed by comparing to previous run
CREATE TABLE query_snapshots (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  keyword_id          TEXT NOT NULL REFERENCES keywords(id),
  provider            TEXT NOT NULL DEFAULT 'gemini',
  citation_state      TEXT NOT NULL,            -- 'cited' | 'not-cited'
  answer_text         TEXT,
  cited_domains       TEXT NOT NULL DEFAULT '[]',
  competitor_overlap  TEXT NOT NULL DEFAULT '[]',
  raw_response        TEXT,
  created_at          TEXT NOT NULL
);

-- audit_log: every config mutation recorded
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  diff        TEXT,
  created_at  TEXT NOT NULL
);

-- api_keys: same table for local and cloud
CREATE TABLE api_keys (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  key_prefix  TEXT NOT NULL,
  scopes      TEXT NOT NULL DEFAULT '["*"]',
  created_at  TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at  TEXT
);

-- usage_counters: per-project scoped for billing readiness (P2 finding fix)
CREATE TABLE usage_counters (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,                -- project id, or 'global'
  period      TEXT NOT NULL,                -- '2026-03'
  metric      TEXT NOT NULL,                -- 'runs' | 'keywords_tracked' | 'snapshots'
  count       INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  UNIQUE(scope, period, metric)
);

-- Indexes
CREATE INDEX idx_keywords_project ON keywords(project_id);
CREATE INDEX idx_competitors_project ON competitors(project_id);
CREATE INDEX idx_runs_project ON runs(project_id);
CREATE INDEX idx_runs_status ON runs(status);
CREATE INDEX idx_snapshots_run ON query_snapshots(run_id);
CREATE INDEX idx_snapshots_keyword ON query_snapshots(keyword_id);
CREATE INDEX idx_audit_log_project ON audit_log(project_id);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);
CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX idx_usage_scope_period ON usage_counters(scope, period);
```

### Citation state transitions (computed, not stored)

The `/timeline` and `/snapshots/diff` endpoints compute transitions by joining consecutive snapshots:

| Previous run | Current run | Computed transition |
|-------------|-------------|-------------------|
| (none)      | cited       | **new** |
| (none)      | not-cited   | not-cited |
| cited       | cited       | cited (stable) |
| cited       | not-cited   | **lost** |
| not-cited   | cited       | **emerging** |
| not-cited   | not-cited   | not-cited (stable) |

The web dashboard's `CitationState` type (`cited | lost | emerging | not-cited`) maps to these computed transitions. The view model layer transforms raw DB rows into the enriched display state.

### Database package

```
packages/db/
  src/
    schema.ts           # Drizzle table definitions (replaces placeholder)
    client.ts           # createClient(url) → Drizzle instance (SQLite or Postgres)
    migrate.ts          # Auto-migration on startup
  drizzle/
    0001_core.sql       # Initial migration
```

---

## 6. API Design (`/api/v1`)

### Phase 2 endpoints (visibility only)

| Method | Path | Purpose |
|--------|------|---------|
| **Auth** | | |
| `POST` | `/api/v1/auth/keys` | Create a new API key (requires existing key) |
| `GET` | `/api/v1/auth/keys` | List API keys |
| `DELETE` | `/api/v1/auth/keys/{id}` | Revoke a key |
| **Projects** | | |
| `PUT` | `/api/v1/projects/{name}` | Create or update project |
| `GET` | `/api/v1/projects` | List projects |
| `GET` | `/api/v1/projects/{name}` | Get project with latest visibility score |
| `GET` | `/api/v1/projects/{name}/export` | Export as canonry.yaml |
| `DELETE` | `/api/v1/projects/{name}` | Delete project |
| **Keywords** | | |
| `PUT` | `/api/v1/projects/{name}/keywords` | Replace keyword list (declarative) |
| `GET` | `/api/v1/projects/{name}/keywords` | List keywords |
| `POST` | `/api/v1/projects/{name}/keywords` | Append keywords (imperative) |
| **Competitors** | | |
| `PUT` | `/api/v1/projects/{name}/competitors` | Replace competitors |
| `GET` | `/api/v1/projects/{name}/competitors` | List competitors |
| **Runs** | | |
| `POST` | `/api/v1/projects/{name}/runs` | Trigger visibility sweep |
| `GET` | `/api/v1/projects/{name}/runs` | List runs for project |
| `GET` | `/api/v1/runs/{id}` | Get run with results |
| `GET` | `/api/v1/runs` | List all runs |
| **History & Snapshots** | | |
| `GET` | `/api/v1/projects/{name}/history` | Audit log for project |
| `GET` | `/api/v1/projects/{name}/snapshots` | All snapshots (paginated) |
| `GET` | `/api/v1/projects/{name}/snapshots/diff` | Compare two runs |
| `GET` | `/api/v1/projects/{name}/timeline` | Per-keyword citation state over time |
| `GET` | `/api/v1/history` | Global audit log |
| **Config-as-code** | | |
| `POST` | `/api/v1/apply` | Apply canonry.yaml config |
| **System** | | |
| `GET` | `/api/v1/usage` | Usage counters (per-project) |
| `GET` | `/api/v1/openapi.json` | OpenAPI spec (no auth) |
| `GET` | `/health` | Health check (no auth) |

### What's NOT in Phase 2

- No `kind: site-audit` in run trigger (returns 400 if attempted)
- No schedule endpoints
- No webhook/SSE endpoints
- No multi-tenant/workspace endpoints

---

## 7. Declarative Config (`canonry.yaml`)

Visibility-only in Phase 2. No `schedule` field (deferred).

```yaml
apiVersion: canonry/v1
kind: Project
metadata:
  name: citypoint-dental-nyc
  labels:
    team: marketing
spec:
  displayName: Citypoint Dental NYC
  canonicalDomain: citypointdental.com
  country: US
  language: en
  keywords:
    - emergency dentist brooklyn
    - best invisalign dentist downtown brooklyn
  competitors:
    - downtownsmiles.com
    - harbordental.com
```

Validation schema in `packages/contracts/src/config-schema.ts`.

---

## 8. Version Control & History

### 8a. Audit Log

Every config mutation writes to `audit_log` with actor, action, entity, and JSON diff.

**Actions:** `project.created`, `project.updated`, `project.deleted`, `keyword.added`, `keyword.removed`, `keywords.replaced`, `competitor.added`, `competitor.removed`, `competitors.replaced`, `config.applied`, `run.triggered`, `run.completed`, `run.failed`

### 8b. Snapshot History

Raw observation snapshots in DB. Transitions computed at query time (see table in section 5). Endpoints: `/snapshots`, `/snapshots/diff`, `/timeline`.

### 8c. Git Export

`canonry export --include-results` produces structured JSON suitable for git commit. Canonry does NOT auto-commit. The export is the bridge.

```json
{
  "project": "citypoint-dental-nyc",
  "exportedAt": "2026-03-09T12:00:00Z",
  "run": { "id": "...", "kind": "answer-visibility", "status": "completed" },
  "snapshots": [
    {
      "keyword": "emergency dentist brooklyn",
      "observedState": "not-cited",
      "transition": "lost",
      "citedDomains": ["downtownsmiles.com"],
      "answerSnippet": "..."
    }
  ]
}
```

---

## 9. Web Dashboard: Handling Missing Technical Readiness (P2 finding)

Phase 2 only produces visibility data. The current dashboard shows both Answer Visibility and Technical Readiness as first-class signals. The plan:

- **Score gauges**: Show Answer Visibility gauge with real data. Technical Readiness gauge shows "Unavailable" with neutral tone and a tooltip: "Enable with site audits (coming soon)."
- **Project page**: The 4-gauge row becomes 2 real gauges (Visibility, Competitor Pressure) + 2 placeholder gauges (Technical Readiness = "N/A", Run Status = real).
- **Overview page**: `readinessScore` field is nullable. Project rows show "—" for readiness with a muted style.
- **Findings section**: Hidden when no site-audit data exists.
- **View model changes**: `readinessSummary` becomes optional on `ProjectCommandCenterVm`. `readinessScore` becomes optional on `PortfolioProjectVm`.

This is explicit "unavailable" treatment, not silent omission. The UI tells the analyst what's missing and why.

---

## 10. MVP Scope

### In scope (Phase 2)
- **Publishable `@ainyc/canonry` npm package** with bundled SPA and CLI
- `canonry init` + `canonry serve` with auto-generated auth
- SQLite database with Drizzle ORM + auto-migration
- Project CRUD via CLI and API
- Keyword and competitor management
- **Answer visibility runs against Gemini, OpenAI, and Claude** (multi-provider)
- Raw observation snapshots with computed transitions
- Audit log for all config mutations
- Snapshot history, diff, and timeline endpoints
- Git-friendly structured export
- Web dashboard wired to real API (visibility data only, readiness marked unavailable)
- `canonry apply` / `canonry export` for config-as-code
- Per-project scoped usage counters
- OpenAPI spec generation
- Auth everywhere (same path local and cloud)

### Deferred to Phase 3
- Site audit runs + Technical Readiness scores
- Scheduling / cron
- MCP server for AI agents
- Webhooks and SSE events

### Deferred to Phase 4+
- Cloud deployment, Postgres mode
- Multi-tenancy and workspaces
- Billing integration (Stripe)

---

## 11. MVP → Cloud Transition

| Concern | Local (Phase 2) | Cloud (Phase 4) |
|---------|-----------------|-----------------|
| Database | SQLite | Managed Postgres |
| Process model | Single process | API + Worker + CDN |
| Job queue | In-process async | pg-boss |
| Auth | Auto-generated local key | Bootstrap endpoint + team keys |
| Web hosting | Fastify static | CDN |
| Billing | Per-project counters (informational) | Counters → Stripe |
| Config | `~/.canonry/config.yaml` | Environment variables |

**What stays the same**: API surface, route plugins, contracts, Drizzle schema, dashboard code, CLI commands, canonry.yaml format.

---

## 12. Implementation Sequence

### Phase 2-pre: Documentation Cleanup & Agent Docs Update

Before writing any code, clean up stale/irrelevant documentation and ensure agent docs reflect Phase 2 reality.

**Delete (superseded or empty):**
- `.context/plans/agent-first-architecture-phase-2-design.md` — superseded by v3
- `.context/plans/agent-first-architecture-phase-2-design-revised.md` — superseded by v3
- `.context/todos.md` — empty
- `.context/notes.md` — empty
- `docs/self-hosting.md` — describes Docker/Postgres Phase 1 stack; Phase 2 replaces with `canonry init`/`canonry serve`. Will be rewritten when relevant.
- `compose.yaml` and `.env.example` — Docker Compose setup is replaced by single-process local server in Phase 2

**Move to repo (canonical plan):**
- Copy `.context/plans/agent-first-architecture-phase-2-design-v3.md` content into `docs/phase-2-design.md` so the plan lives in version control, not a dotfile directory. Then delete `.context/plans/` directory entirely.

**Update (stale content):**
- `docs/site-audit.md` — add header note: "Deferred to Phase 3. Not in scope for Phase 2."
- `docs/architecture.md` — update to reflect Phase 2 architecture (single-process local, SQLite, `packages/canonry/`, `packages/api-routes/`). Remove Postgres/pg-boss/Docker references from the "current" section; move them to a "Cloud (Phase 4)" section.
- `docs/product-plan.md` — update Phase 2 scope to match this plan. Mark Phase 1 as complete.
- `docs/testing.md` — update for Phase 2 packages and verification steps.
- `docs/workspace-packaging.md` — update boundary rules for new packages.
- `docs/providers/gemini.md` — keep, will be updated when provider is implemented.

**Update `README.md`:**
- Update workspace map to include `packages/canonry/`, `packages/api-routes/`
- Replace Docker Quick Start with `canonry init` / `canonry serve` flow
- Update architecture diagram (single-process local, SQLite)
- Remove Docker endpoint references

**Update `CLAUDE.md`:**
- Update workspace map to include `packages/canonry/`, `packages/api-routes/`
- Add Phase 2 context (what's in scope, what's deferred)
- Update commands section (add `canonry` CLI commands)
- Update improvement order to reflect Phase 2 sequence
- Update CI guidance (add publish workflow mention)
- Keep UI Design System section as-is

**Update `AGENTS.md`:**
- Sync workspace map with CLAUDE.md
- Add Phase 2 context section
- Add CLI command reference
- Add `canonry.yaml` config-as-code reference
- Add API endpoint summary for agent workflows
- Update improvement order
- Update CI guidance

**Update `CONTRIBUTING.md`:**
- Update setup instructions for Phase 2 (mention `canonry init` for local dev)
- Add section on config-as-code workflow

**Update package-level READMEs** (brief, accurate):
- `packages/db/README.md` — Drizzle schema, SQLite/Postgres, auto-migration
- `packages/contracts/README.md` — Add config-schema, errors
- `packages/provider-gemini/README.md` — Update status (Phase 2 = real implementation)
- `apps/api/README.md` — Thin entry point importing from `packages/api-routes/`
- `apps/worker/README.md` — Cloud worker entry point
- `apps/web/README.md` — SPA source, bundled into `packages/canonry/`

### Phase 2a: Foundation
1. `packages/db/src/schema.ts` — Drizzle schema (SQLite-compatible)
2. `packages/db/src/client.ts` — SQLite/Postgres client factory
3. `packages/db/src/migrate.ts` — Auto-migration on startup
4. `packages/contracts/src/config-schema.ts` — Zod validation for canonry.yaml (no schedule field)
5. `packages/contracts/src/errors.ts` — Structured error codes
6. Extend `packages/contracts/src/project.ts` — Add labels, configSource, configRevision
7. Extend `packages/contracts/src/run.ts` — Add trigger, startedAt, finishedAt, error; remove site-audit from Phase 2 public types or gate it

### Phase 2b: API Routes (new package)
8. Create `packages/api-routes/` — Fastify route plugins
9. `packages/api-routes/src/auth.ts` — API key auth middleware
10. `packages/api-routes/src/projects.ts` — Project CRUD
11. `packages/api-routes/src/keywords.ts` — Keyword management
12. `packages/api-routes/src/competitors.ts` — Competitor management
13. `packages/api-routes/src/runs.ts` — Run triggers and results (visibility only)
14. `packages/api-routes/src/apply.ts` — Config apply endpoint
15. `packages/api-routes/src/history.ts` — Audit log + snapshots + diff + timeline
16. `packages/api-routes/src/openapi.ts` — Swagger generation
17. Update `apps/api/src/app.ts` — Import route plugins from package

### Phase 2c: Provider Execution
18. Implement `packages/provider-gemini/src/index.ts` — Real Gemini API calls
18b. Implement `packages/provider-openai/` — OpenAI Responses API with web_search_preview
18c. Implement `packages/provider-claude/` — Anthropic Messages API with web_search_20250305
19. `packages/canonry/src/job-runner.ts` — In-process async job queue with multi-provider fan-out
19b. `packages/canonry/src/provider-registry.ts` — Provider registry for adapter management
20. Wire: API trigger → job runner → provider registry → all configured providers → snapshot persistence → usage counter increment

### Phase 2d: Publishable Package
21. Create `packages/canonry/` — CLI + server + build script
22. `packages/canonry/src/cli.ts` — All CLI commands
23. `packages/canonry/src/server.ts` — Unified server (mounts api-routes + static)
24. `packages/canonry/src/commands/init.ts` — Setup wizard with auth key generation
25. `packages/canonry/build-web.ts` — Builds SPA and copies to assets/
26. Test: `npm pack` → `npm install -g ./ainyc-canonry-0.0.1.tgz` → full workflow

### Phase 2e: Wire Web Dashboard
27. Make `readinessSummary` optional in view models
28. Add API client/fetch layer to `apps/web/`
29. Replace mock data with real API calls
30. Show "Unavailable" for Technical Readiness sections
31. Hide findings section when no site-audit data

---

## 13. Files to Create

| Path | Purpose |
|------|---------|
| **Database** | |
| `packages/db/src/schema.ts` | Drizzle schema (replace placeholder) |
| `packages/db/src/client.ts` | SQLite/Postgres client factory (replace placeholder) |
| `packages/db/src/migrate.ts` | Auto-migration runner |
| `packages/db/drizzle/0001_core.sql` | Initial migration |
| **Contracts** | |
| `packages/contracts/src/config-schema.ts` | canonry.yaml Zod schema |
| `packages/contracts/src/errors.ts` | Error codes and types |
| **API Routes** | |
| `packages/api-routes/package.json` | Route plugin package |
| `packages/api-routes/src/auth.ts` | Auth middleware |
| `packages/api-routes/src/projects.ts` | Project routes |
| `packages/api-routes/src/keywords.ts` | Keyword routes |
| `packages/api-routes/src/competitors.ts` | Competitor routes |
| `packages/api-routes/src/runs.ts` | Run routes (visibility only) |
| `packages/api-routes/src/apply.ts` | Apply endpoint |
| `packages/api-routes/src/history.ts` | Audit + snapshots + diff |
| `packages/api-routes/src/openapi.ts` | Swagger |
| **Publishable Package** | |
| `packages/canonry/package.json` | The npm package |
| `packages/canonry/src/cli.ts` | CLI entry point |
| `packages/canonry/src/server.ts` | Unified local server |
| `packages/canonry/src/job-runner.ts` | In-process job queue |
| `packages/canonry/src/commands/*.ts` | All CLI commands |
| `packages/canonry/src/client.ts` | API HTTP client |
| `packages/canonry/src/config.ts` | ~/.canonry/ config reader/writer |
| `packages/canonry/build-web.ts` | SPA build + copy script |
| **Docs** | |
| `docs/examples/canonry.yaml` | Example config (no schedule) |
| `docs/adr/0004-config-as-code.md` | ADR |
| `docs/adr/0005-single-process-local.md` | ADR |
| `docs/adr/0006-version-control-layered.md` | ADR |
| `docs/adr/0007-raw-observation-snapshots.md` | ADR for raw vs computed citation state |

## Files to Modify

| Path | Change |
|------|--------|
| `packages/contracts/src/project.ts` | Add labels, configSource, configRevision |
| `packages/contracts/src/run.ts` | Add trigger, startedAt, finishedAt, error |
| `packages/contracts/src/index.ts` | Export new modules |
| `packages/db/package.json` | Add drizzle-orm, better-sqlite3 |
| `packages/provider-gemini/src/index.ts` | Real Gemini implementation |
| `apps/api/src/app.ts` | Import route plugins from packages/api-routes |
| `apps/api/package.json` | Add packages/api-routes dep |
| `apps/web/src/view-models.ts` | Make readinessSummary optional |
| `apps/web/src/App.tsx` | Handle missing readiness, wire to API |
| `apps/web/src/mock-data.ts` | Keep as test fixture |
| `package.json` | Add root build script |
| `CLAUDE.md` | Update workspace map with new packages |
| `AGENTS.md` | Document agent workflows, CLI usage |

---

## 14. Verification

1. `pnpm run typecheck && pnpm run test && pnpm run lint` — all pass
2. `cd packages/canonry && npm pack` — produces installable tarball
3. `npm install -g ./ainyc-canonry-*.tgz` — installs globally
4. `canonry init --api-key test123` → creates `~/.canonry/` with SQLite db + auto-generated API key
5. `canonry serve` → server starts on :4173, dashboard loads with empty state
6. `canonry project create mysite --domain mysite.com --country US --language en` → 201
7. `canonry keyword add mysite "emergency dentist brooklyn"` → keyword added, audit log entry
8. `canonry run mysite` → triggers visibility sweep, snapshots stored
9. `canonry status mysite` → shows citation results in terminal
10. `canonry history mysite` → shows audit trail of config changes
11. Open `localhost:4100` → dashboard shows project with real visibility data, readiness marked "Unavailable"
12. `canonry export mysite` → valid canonry.yaml
13. `canonry export mysite --include-results` → JSON with raw snapshots + computed transitions
14. `canonry apply docs/examples/canonry.yaml` → idempotent apply, audit log records changes
15. `GET /api/v1/projects/mysite/timeline` → per-keyword citation history with computed transitions
