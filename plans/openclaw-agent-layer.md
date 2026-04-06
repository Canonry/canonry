# OpenClaw Agent Layer Integration Plan

## Context

Canonry (v1.38.0) is an open-source agent-first AEO monitoring platform. The team wants to add an AI agent layer (persona: "Aero") on top of canonry, following the **DenchClaw distribution model** (forked OpenClaw for CRM) and the **Obsidian monetization model** (free local tool, paid sync for teams).

The team decided: **build everything inside canonry**, not a separate repo. One `npx canonry`, one release cycle.

Two source documents scope the work:
1. **ARCHITECTURE.md** (aero repo) — originally a separate `@ainyc/aero` package
2. **PR #251** — proposes folding intelligence + agent commands into canonry monorepo

---

## Evaluation of Source Documents

### ARCHITECTURE.md — What to Adopt vs Drop

| Adopt | Modify | Drop |
|-------|--------|------|
| Agent persona "Aero" + workspace templates | Agent config in `~/.canonry/config.yaml`, not `~/.aero/` | Separate `@ainyc/aero` package |
| DenchClaw bootstrap (detect → install → profile → seed) | Profile `aero` → `~/.openclaw-aero/` | `@clack/prompts` wizard — canonry uses flags-only CLI |
| Obsidian sync model (local-first, paid sync) | No intelligence features behind paywall — sync is the only paid feature | Chrome process management — CDP provider handles this |
| Skill layering (canonry + aero orchestration) | | USER.md as rendered view of memory — over-engineered for v1 |
| BYO-agent parity (power users use API/CLI directly) | | Separate `~/.aero/config.json` |
| Webhook bridge for proactive agent | | |
| Task-based interaction (not chatbot) | | |

### PR #251 — What's Correct vs Needs Revision

**Correct:** Intelligence package structure, DB tables, CLI commands, API routes, workspace templates in assets, analyzer test structure.

**Needs revision:**
- Phase 1 is written as greenfield but intelligence already exists (package, DTOs, DB tables, migrations, routes, CLI, client methods). Must be additive, not a rewrite.
- Agent config must include `binary`, `profile` (`aero`), `autoStart`, `gatewayPort` — not just an enable flag.
- `canonry agent setup` must be fully non-interactive.
- Skills directory `skills/aero/` (name is fine — aero repo gets archived, name lives on as persona).

---

## Current State: What Already Exists

### Intelligence Infrastructure (70% built, 0% integrated)

| Component | Status | Location |
|-----------|--------|----------|
| Analysis engine (`analyzeRuns`, `detectRegressions`, `detectGains`, `computeHealth`, `analyzeCause`, `generateInsights`) | Built, **never called** | `packages/intelligence/src/` |
| DTOs (`InsightDto`, `HealthSnapshotDto`) | Built | `packages/contracts/src/intelligence.ts` |
| DB tables (`insights`, `health_snapshots`) | Built with v21 migrations, **always empty** | `packages/db/src/schema.ts:321` |
| API routes (GET insights, GET health, POST dismiss) | Built, **return empty results** | `packages/api-routes/src/intelligence.ts` |
| Client methods (`getInsights`, `getHealth`, etc.) | Built | `packages/canonry/src/client.ts:678` |
| CLI (`canonry insights`, `canonry health`) | Built | `packages/canonry/src/cli-commands/intelligence.ts` |
| Frontend insight rendering | Built, **uses in-memory generation** | `apps/web/src/pages/ProjectPage.tsx:907` |

### The Gap

The run completion call chain is: `JobRunner.executeRun()` → `onRunCompleted` callback → `Notifier.onRunCompleted()` → webhooks.

**What's missing:**
1. Nobody calls `analyzeRuns()` after a run completes
2. Nobody writes to the `insights` or `health_snapshots` tables
3. The `Notifier` short-circuits at line 32 when no notifications are enabled — if intelligence were wired into notifier, projects without webhooks would never get insights
4. The frontend builds insights client-side in `build-dashboard.ts:635` using its own logic, completely independent of the `@ainyc/canonry-intelligence` package
5. The intelligence package is **not listed as a dependency** of `@ainyc/canonry`

### Notification Events (today)

```typescript
type NotificationEvent = 'citation.lost' | 'citation.gained' | 'run.completed' | 'run.failed'
```

The plan's `regression.detected` and `insight.generated` events **do not exist** and require contract changes.

### Published Package (`files` field)

```json
"files": ["bin/", "dist/", "assets/", "package.json", "README.md"]
```

`skills/aero/` at repo root will **not** be included in `npx canonry`. Agent workspace assets must live under `packages/canonry/assets/` to ship.

---

## The BYO-Agent vs Managed Agent Design

| | Power User (BYO-agent) | Novice User (managed agent) |
|---|---|---|
| **Installs** | `npx canonry` | `npx canonry` + `canonry agent setup --install` |
| **Agent runtime** | Their own (Cursor, Claude Code, scripts) | OpenClaw gateway managed by canonry |
| **Interacts via** | `canonry <cmd> --format json`, REST API | Dashboard insight feed, Cmd+K task dispatch |
| **Intelligence** | Same API endpoints, same CLI commands | Same, plus proactive via webhooks → agent |
| **Pays for** | Sync (if team) | Sync (if team) |

**No feature should require OpenClaw to function.** The intelligence engine, API endpoints, and CLI commands are the shared platform layer. OpenClaw adds a managed persona on top.

**No direct DB access for agents.** Per AGENTS.md: "The CLI and API are the agent interface. If an agent can't do something with `canonry <command> --format json` or an HTTP call, it's a bug." If Aero needs analytical power beyond current endpoints, the fix is a composite endpoint or CLI command — not raw SQLite. This keeps BYO-agent parity.

---

## Aero: The Agent Identity

**Name:** Aero — an AI-native AEO analyst
**OpenClaw profile:** `aero` → state at `~/.openclaw-aero/`
**Persona:** Data-first, proactive, honest timelines, action-oriented

### Interaction model: Autonomous analyst, not chatbot

| Surface | Role | Interaction |
|---------|------|-------------|
| **Insight Feed** (primary) | Prioritized findings on the project page | Aero posts → user approves/dismisses/escalates |
| **Task Queue** | Aero's work log — running, completed, scheduled | User monitors, cancels, reviews results |
| **Command Palette** (Cmd+K) | Ad-hoc task dispatch | User types request → task created → palette closes |

No conversation UI. No back-and-forth chat. One request → one task → results posted to feed.

### Capabilities beyond canonry

Aero has full local system access via OpenClaw:
- Run visibility sweeps — decides when and which providers
- Audit any URL — `npx @ainyc/aeo-audit` for competitors or own pages
- Read actual pages — HTTP fetch + HTML analysis
- Query Search Console — check indexing, coverage, impressions
- Write content recommendations — schema markup, llms.txt drafts
- Set up persistent monitors — "alert me if X changes"
- Push to channels — Slack, Telegram, email via OpenClaw
- Multi-step workflows — regression → audit → check indexing → draft fix → notify

---

## Implementation Phases

### Phase 1: Complete Intelligence Integration

The intelligence package exists. The gap is wiring: run completion → analysis → DB persistence → frontend consumption from DB. All changes are **additive** to existing contracts.

#### 1A. Schema migration: add `runId` + idempotency

The current `insights` and `health_snapshots` tables have no `runId` column and no uniqueness constraint. Without these, `analyzeAndPersist(runId)` can't be safely re-run (duplicate insights on retry) and Phase 2 can't correlate insights to the triggering run.

**Modify `packages/db/src/schema.ts`:**
- `insights` table: add `runId: text('run_id').references(() => runs.id, { onDelete: 'cascade' })` (nullable for backcompat with any manually-inserted rows)
- `health_snapshots` table: add `runId: text('run_id').references(() => runs.id, { onDelete: 'cascade' })` (nullable)

**Modify `packages/db/src/migrate.ts`** — add incremental migrations:
```sql
ALTER TABLE insights ADD COLUMN run_id TEXT REFERENCES runs(id) ON DELETE CASCADE
CREATE INDEX IF NOT EXISTS idx_insights_run ON insights(run_id)
ALTER TABLE health_snapshots ADD COLUMN run_id TEXT REFERENCES runs(id) ON DELETE CASCADE
CREATE INDEX IF NOT EXISTS idx_health_run ON health_snapshots(run_id)
```

**Idempotency strategy:** `IntelligenceService.analyzeAndPersist()` deletes existing insights/health_snapshots for the given `runId` before inserting, inside a transaction. This makes re-runs safe (same result, no duplicates).

#### 1B. Run-completion coordinator (the critical missing piece)

The `Notifier` is the wrong place — it short-circuits when no notifications are enabled (line 32). Intelligence analysis must run for **every** completed run, regardless of webhook config.

**Create:** `packages/canonry/src/run-coordinator.ts`

A post-run orchestrator with **failure isolation** — one subscriber failing must not starve the others. `JobRunner` fire-and-forgets `onRunCompleted` (line 445), so the coordinator must catch independently:

```typescript
export class RunCoordinator {
  constructor(
    private db: DatabaseClient,
    private notifier: Notifier,
    private intelligenceService: IntelligenceService,
  ) {}

  async onRunCompleted(runId: string, projectId: string): Promise<void> {
    // 1. Intelligence — always runs, catches its own errors
    try {
      await this.intelligenceService.analyzeAndPersist(runId, projectId)
    } catch (err) {
      log.error('intelligence.failed', { runId, error: err instanceof Error ? err.message : String(err) })
    }

    // 2. Notifications — may short-circuit, catches its own errors
    try {
      await this.notifier.onRunCompleted(runId, projectId)
    } catch (err) {
      log.error('notifier.failed', { runId, error: err instanceof Error ? err.message : String(err) })
    }
  }
}
```

**Modify:** `packages/canonry/src/server.ts` (line 237) — replace direct notifier wiring:
```typescript
// Before: jobRunner.onRunCompleted = (runId, projectId) => notifier.onRunCompleted(runId, projectId)
// After:
const coordinator = new RunCoordinator(opts.db, notifier, intelligenceService)
jobRunner.onRunCompleted = (runId, projectId) => coordinator.onRunCompleted(runId, projectId)
```

#### 1B. Intelligence service + run-scoped read contract

**Create:** `packages/canonry/src/intelligence-service.ts`

Owns the DB interaction. The intelligence package stays pure. Returns the analysis result so the coordinator can use it for webhook dispatch.

```typescript
export class IntelligenceService {
  async analyzeAndPersist(runId: string, projectId: string): Promise<AnalysisResult> {
    // 1. Query DB for current + previous run snapshots
    // 2. Convert to intelligence package's RunData format
    // 3. Call analyzeRuns(currentRun, previousRun)
    // 4. Delete existing insights/health_snapshots for this runId (idempotency)
    // 5. Persist AnalysisResult.insights → insights table (with runId)
    // 6. Persist AnalysisResult.health → health_snapshots table (with runId)
    // 7. Return AnalysisResult for coordinator to inspect
  }
}
```

**Modify `packages/contracts/src/intelligence.ts`** — add `runId: string | null` to both `InsightDto` and `HealthSnapshotDto`. Field is nullable for backcompat with any pre-existing rows. This is an additive field change (allowed per API stability rules).

**Modify `packages/api-routes/src/intelligence.ts`** — add `?runId=` query parameter to `GET /projects/:name/insights`. When present, filters insights to that run. This gives the agent (or any webhook consumer) a deterministic way to fetch the exact insights that triggered an `insight.critical` webhook:
```
GET /projects/mysite/insights?runId=run_abc123 --format json
```

**Modify:** `packages/canonry/package.json` — add `@ainyc/canonry-intelligence` to `devDependencies` as `"workspace:*"` (follows the existing pattern for all internal workspace packages — see line 60-77)
**Modify:** `packages/canonry/tsup.config.ts` — add to `noExternal` for bundling (same as other workspace packages)

#### 1C. Migrate frontend from in-memory to DB-backed insights

The persisted `InsightDto` (contracts) and the current UI's `ProjectInsightVm` (view-models.ts:136) have different shapes:

| `InsightDto` (API) | `ProjectInsightVm` (UI) |
|---|---|
| `type` ('regression' / 'gain' / 'opportunity') | `tone` (MetricTone) |
| `severity` ('critical' / 'high' / 'medium' / 'low') | — |
| `title` | `title` |
| `keyword` + `provider` (single strings) | `affectedPhrases: AffectedPhrase[]` |
| `recommendation` (JSON) | `actionLabel` (string) |
| `cause` (JSON) | `detail` (string) |
| — | `evidenceId` (links to evidence drawer) |

These can't be consumed directly. Need a mapper.

**Create:** `apps/web/src/mappers/insight-mapper.ts` — `mapInsightDtoToVm(dto: InsightDto): ProjectInsightVm`
- `type` → `tone`: regression→negative, gain→positive, opportunity→caution
- `keyword` + `provider` → single-element `affectedPhrases[]` with `citationState` derived from type
- `recommendation.action` → `actionLabel`
- `cause.details` or `cause.cause` → `detail`
- `evidenceId` → look up from latest evidence by keyword match (or omit if unavailable)

**Modify:** `apps/web/src/queries/use-dashboard.ts` — add query for `GET /projects/:name/insights` and `GET /projects/:name/health/latest`

**Modify:** `apps/web/src/build-dashboard.ts` — in `buildProjectCommandCenter()`, prefer DB-backed insights (via mapper) when available; fall back to in-memory `buildInsights()` when no persisted insights exist (first run, intelligence not yet run). This avoids a hard cutover — both paths coexist until the in-memory path can be removed.

#### 1D. Testing

**Create:** `packages/canonry/test/run-coordinator.test.ts` — verify both intelligence and notifier are called; verify intelligence runs even when no notifications are configured
**Create:** `packages/canonry/test/intelligence-service.test.ts` — mock DB with in-memory SQLite; verify insights + health snapshots persisted after analysis

#### 1E. Workspace config

**Modify:** `vitest.workspace.ts` — ensure `packages/intelligence` is included (may already be)

**No version bump yet** — single bump at the end of the release (see Versioning below).

#### Parallelization
- 1A (schema migration) first — 1B and 1C depend on `runId` existing
- 1B and 1C can proceed in parallel after 1A
- 1D tests depend on 1A/1B

---

### Phase 2: Agent Infrastructure (OpenClaw integration)

Optional layer. Canonry works without it.

#### 2A. Config extension

**Modify `packages/canonry/src/config.ts`:**
```typescript
interface AgentConfigEntry {
  binary?: string          // path to openclaw binary (auto-detected)
  profile?: string         // openclaw profile name (default: 'aero')
  autoStart?: boolean      // start gateway with `canonry serve`
  gatewayPort?: number     // default: 3579
}
// Add agent?: AgentConfigEntry to CanonryConfig
```

Profile defaults to `aero` → state at `~/.openclaw-aero/`, workspace at `~/.openclaw-aero/workspace/`.

#### 2B. Agent workspace templates + skills packaging

All managed-agent assets must live under `packages/canonry/assets/` to be included in the published npm package (per `"files": ["assets/"]`).

**Create in `packages/canonry/assets/agent-workspace/`:**
- `SOUL.md` — Aero analyst persona
- `AGENTS.md` — Operational guidelines (canonry CLI usage, quota awareness)
- `USER.md` — Empty client context template

**Create in `packages/canonry/assets/agent-workspace/skills/aero/`:**
- `SKILL.md` — Orchestration skill definition
- `references/orchestration.md` — Workflow recipes
- `references/regression-playbook.md` — Detection → triage → diagnosis
- `references/memory-patterns.md` — What to persist per client
- `references/reporting.md` — Report generation templates

Skills live inside `assets/` for npm publishing. `canonry agent setup` copies them to the OpenClaw workspace at `~/.openclaw-aero/workspace/skills/`.

Also copy `skills/canonry-setup/` into `packages/canonry/assets/agent-workspace/skills/canonry-setup/` — the published package only ships `assets/`, so `canonry agent setup` cannot read from repo-root `skills/` at runtime.

**Build/publish path for agent assets:**

Canonical sources live at repo root: `skills/aero/`, `skills/canonry-setup/`. These are NOT shipped in the npm package.

The copy into `packages/canonry/assets/agent-workspace/skills/` must happen during `build`, not only `prepublishOnly`, because:
- `prepublishOnly` runs before `npm publish` but NOT before `npm pack --dry-run`
- Developers running locally via `pnpm run build` also need the assets in place

**Modify `packages/canonry/package.json`** — extend the existing `"build"` script:
```json
"build": "tsx scripts/copy-agent-assets.ts && tsup && tsx build-web.ts"
```

**Create `packages/canonry/scripts/copy-agent-assets.ts`:**
- Copies `../../skills/aero/` → `assets/agent-workspace/skills/aero/`
- Copies `../../skills/canonry-setup/` → `assets/agent-workspace/skills/canonry-setup/`
- Idempotent (rm + copy)

**Add to `.gitignore`:**
```
packages/canonry/assets/agent-workspace/skills/canonry-setup/
packages/canonry/assets/agent-workspace/skills/aero/
```

**Runtime reads in `agent-bootstrap.ts` MUST only reference `assets/agent-workspace/...`** — never repo-root paths. Use `path.join(__dirname, '../assets/agent-workspace/')` (or the resolved dist path) so it works both in dev and from the published package.

#### 2C. New notification events

The webhook bridge needs events that don't exist yet.

**Modify `packages/contracts/src/notification.ts`:**
```typescript
export const notificationEventSchema = z.enum([
  'citation.lost',
  'citation.gained',
  'run.completed',
  'run.failed',
  'insight.critical',    // new: critical-severity insight generated
  'insight.high',        // new: high-severity insight generated
])
```

**Modify:** `packages/api-routes/src/notifications.ts` — update validation for new events
**Insight webhook dispatch lives in RunCoordinator, not Notifier.** The current Notifier derives events from run status + transitions (lines 57-71). It has no awareness of insights. Rather than threading insight results through Notifier's existing flow, the RunCoordinator dispatches `insight.critical` / `insight.high` webhooks directly after `intelligenceService.analyzeAndPersist()` returns:

```typescript
// In RunCoordinator.onRunCompleted():
const analysisResult = await this.intelligenceService.analyzeAndPersist(runId, projectId)
if (analysisResult.insights.some(i => i.severity === 'critical' || i.severity === 'high')) {
  await this.dispatchInsightWebhooks(runId, projectId, analysisResult.insights)
}
// Then: await this.notifier.onRunCompleted(runId, projectId)
```

The coordinator reuses the same `deliverWebhook()` utility from `@ainyc/canonry-api-routes` and the same notification lookup pattern. This keeps Notifier unchanged and avoids coupling it to the intelligence package.

**Modify:** `packages/canonry/src/notifier.ts` — no changes. Stays as-is.
**Modify:** CLI help text for `canonry notify add` — document new events

Using `insight.critical` / `insight.high` instead of generic `regression.detected` because:
- They align with existing severity levels in the InsightDto
- They're more useful for filtering (agent only wants critical alerts, not every gain)
- They don't introduce a new concept — insights already exist in the contract

#### 2D. Bootstrap logic

**Create:** `packages/canonry/src/agent-bootstrap.ts`
- `detectOpenClaw()` — check PATH, configured binary path
- `bootstrapAgent(opts)` — detect/install OpenClaw → set `OPENCLAW_PROFILE=aero` → resolve port → stage config → `openclaw onboard --install-daemon` → seed workspace from `assets/agent-workspace/` (includes both aero and canonry-setup skills, copied there at build time) → verify health → save agent config
- All non-interactive. Install only with `--install` flag.

#### 2E. Agent lifecycle manager

**Create:** `packages/canonry/src/agent-manager.ts` — `AgentManager` class
- `start(config)` → spawn openclaw gateway, write PID to `~/.canonry/agent.pid`
- `stop()` → graceful shutdown
- `status()` → running/stopped, PID, port, uptime
- `reset(config)` → stop + wipe workspace + re-seed

#### 2F. CLI commands

**Create:** `packages/canonry/src/commands/agent.ts` — `agentSetup()`, `agentStart()`, `agentStop()`, `agentStatus()`, `agentReset()`
**Create:** `packages/canonry/src/cli-commands/agent.ts` — `AGENT_CLI_COMMANDS` array
**Modify:** `packages/canonry/src/cli-commands.ts` — register
**Modify:** `packages/canonry/src/cli.ts` — add agent section to USAGE string

#### 2G. Agent webhook lifecycle

Notifications are project-scoped (`POST /projects/:name/notifications`). A one-time `canonry agent setup` cannot cover projects created later. Three pieces:

**1. Explicit attach/detach commands:**
- `canonry agent attach <project>` — registers agent webhook for the named project via existing `POST /projects/:name/notifications` API. Idempotent (checks for existing agent webhook by URL pattern before creating).
- `canonry agent detach <project>` — removes the agent webhook notification.

Add to `AGENT_CLI_COMMANDS` array. Implementation calls `createApiClient().createNotification()` (client.ts:291).

**2. Auto-attach on project create/apply (when agent is enabled):**

Follows the existing callback pattern (see `onRunCreated`, `onScheduleUpdated`, `onProjectDeleted` in `ApiRoutesOptions` at index.ts:45):

**Modify `packages/api-routes/src/index.ts`:**
- Add to `ApiRoutesOptions`: `onProjectUpserted?: (projectId: string, projectName: string) => void`
- Pass through to `projectRoutes(app, { ..., onProjectUpserted: opts.onProjectUpserted })` and `applyRoutes(app, { ..., onProjectUpserted: opts.onProjectUpserted })`

**Modify `packages/api-routes/src/projects.ts`:**
- Add `onProjectUpserted` to `ProjectRoutesOptions`
- Fire after PUT create/update transaction commits (same pattern as `onScheduleUpdated` firing after schedule writes)

**Modify `packages/api-routes/src/apply.ts`:**
- Add `onProjectUpserted` to `ApplyRoutesOptions`
- Fire after the apply transaction commits (line 248+), for each project that was created or updated

**Modify `packages/canonry/src/server.ts`:**
- Wire: `onProjectUpserted: (projectId, name) => agentManager?.autoAttachWebhook(projectId, name)` when `config.agent?.autoStart` is true

**3. Setup seeds existing projects:**

During `canonry agent setup`, attach to all existing projects. Two paths depending on server state:
- **Server running:** `canonry project list --format json` → `canonry agent attach <project>` for each (uses API client)
- **Server not running:** Read projects directly from the SQLite database at the path in `config.yaml` (read-only, same pattern as `canonry export` which also works offline). Create notification rows directly via DB insert. This keeps setup usable without requiring `canonry serve` first.

Webhook config per project:
```yaml
notifications:
  - channel: webhook
    url: http://localhost:{gatewayPort}/hooks/canonry
    events: [run.completed, insight.critical, insight.high, citation.gained]
```

**Config-as-code precedence:** `apply.ts:224` replaces ALL notifications when `spec.notifications` is present — it deletes existing rows then inserts from YAML. This means `canonry apply` will wipe the auto-attached agent webhook if `spec.notifications` is declared. This is intentional: **declarative config is authoritative.** Users who use `canonry apply` with explicit notifications own that config. The `onProjectUpserted` callback fires AFTER apply completes, so auto-attach re-adds the agent webhook post-apply only if the user didn't declare their own notifications block. If they did, the agent webhook must be included in their YAML to persist. Document this in `skills/canonry-setup/references/canonry-cli.md`.

#### 2H. Server integration

**Modify:** `packages/canonry/src/server.ts` — if `config.agent?.autoStart`, start AgentManager on server boot, stop on shutdown.

#### 2I. Docs

**Update:** `packages/canonry/AGENTS.md`, `AGENTS.md` root, CLI reference in `skills/canonry-setup/references/canonry-cli.md` — add agent commands, new notification events.

**No version bump yet** — single bump at the end of the release (see Versioning below).

#### Parallelization
- 2A, 2B, 2C can proceed in parallel
- 2D depends on 2A + 2B
- 2E depends on 2A
- 2F depends on 2D + 2E
- 2G depends on 2C + 2F
- 2H depends on 2E

---

### Phase 3: Dashboard — Aero as Autonomous Analyst

Aero is NOT a chatbot. It's an autonomous analyst that surfaces work. The dashboard reflects this with three interaction surfaces: **Insight Feed** (enhanced), **Task Queue**, and **Command Palette**.

#### UX Principle

> Aero surfaces work. The user approves, modifies, or dismisses.
> Not: "User asks question → agent answers."
> Instead: "Aero detects regression → investigates → posts diagnosis with recommended action → user clicks [Apply fix] or [Ignore]."

#### 3A. Agent tasks API + DB

**Create:** `packages/api-routes/src/agent-tasks.ts`
- `POST /api/v1/agent/tasks` — dispatch a task to Aero
- `GET /api/v1/agent/tasks` — list tasks (filter by status, project)
- `GET /api/v1/agent/tasks/:id` — task detail with results
- `POST /api/v1/agent/tasks/:id/cancel` — cancel a running task
- `GET /api/v1/agent/status` — gateway status (running/stopped, current task)

**Add to `packages/contracts/src/`:** `agent-tasks.ts` — `AgentTaskDto`, `TaskStatus`, `TaskType` DTOs

**Add to `packages/db/src/schema.ts`:** `agentTasks` table:
- id, projectId, type (investigate, audit, analyze, monitor, report, custom), prompt, status (queued, running, completed, failed, cancelled), result (JSON), dispatchedBy (user, webhook, schedule), createdAt, startedAt, completedAt

**Add to `packages/db/src/migrate.ts`:** matching migration

**Create:** `packages/api-routes/src/agent-ws.ts` — WebSocket at `/api/v1/agent/ws` for real-time task status updates + insight streaming. Proxied to OpenClaw gateway. Auth via API key/session cookie.

**New dependency:** `@fastify/websocket` added to `packages/api-routes/package.json`. Currently api-routes depends only on Fastify core — the WS plugin must be explicitly added and registered in `index.ts` conditionally (only when agent routes are enabled, to avoid pulling WS deps for non-agent deployments).

**Reverse-proxy note:** The `basePath`-aware route registration already handles sub-path prefixes. WS upgrade requests at `{basePath}/api/v1/agent/ws` follow the same pattern. Nginx/Caddy users need `proxy_set_header Upgrade` and `proxy_set_header Connection "upgrade"` — document in `skills/canonry-setup/references/canonry-cli.md`.

**Auth model:** WS connections authenticate on upgrade via the same bearer token or session cookie used by REST endpoints. The `auth.ts` middleware runs before the upgrade completes. No separate gateway session token needed — the canonry API key IS the auth boundary.

#### 3B. Enhance existing insight feed

The frontend already renders insights in `ProjectPage.tsx:907`. Enhance it — don't replace it.

**Modify:** `InsightSignals` component — add action buttons that dispatch agent tasks:
```
[CRITICAL] Lost ChatGPT citation for "roof repair phoenix"
Competitor roofco.com now cited instead. Page not re-indexed since March 28.
→ [Request re-indexing]  [Run full audit]  [Dismiss]
```

Action buttons call `POST /api/v1/agent/tasks` with appropriate type + context. If agent is offline, buttons are disabled with tooltip "Start Aero to use this action".

**Create in `apps/web/src/components/agent/`:**
- `InsightActions.tsx` — action button bar for insight cards
- `useAgentStatus.ts` — hook that polls `GET /api/v1/agent/status`

#### 3C. Task queue page

**Create in `apps/web/src/components/agent/`:**
- `TaskQueue.tsx` — list of agent tasks with status indicators
- `TaskDetail.tsx` — expanded view of task results (markdown rendering)
- `useTaskStream.ts` — WebSocket hook for real-time task updates

**Create:** `apps/web/src/pages/TasksPage.tsx` — dedicated page (linked from sidebar)

```
Tasks
──────────────────────────
● Running   Investigating "roof coating" regression (2m ago)
✓ Complete  Weekly competitive analysis (today 8:00am)
✓ Complete  Audit azcoatings.com/services (yesterday)
◷ Scheduled Weekly review — next: Monday 9:00am
```

#### 3D. Command palette (Cmd+K — task dispatch, not chat)

Opens as overlay, user types request, dispatches as agent task, palette closes. Results appear in task queue / insight feed when done.

**Create in `apps/web/src/components/agent/`:**
- `CommandPalette.tsx` — Cmd+K overlay with input + context-aware suggestions
- `CommandSuggestions.tsx` — suggestions based on current page/project
- `useCommandPalette.ts` — keyboard shortcut + dispatch logic

Context-aware suggestions:
- On project overview: "Run a sweep", "Show regressions this week"
- On keyword detail: "Why isn't this cited on ChatGPT?"
- On run detail: "Explain these results"

#### 3E. Status indicators

**Modify:** sidebar project list — health score dot from `GET /projects/:name/health/latest`
**Modify:** topbar — Aero status indicator:
- Green dot + "Aero" = idle
- Pulsing + "Working..." = task in progress
- Gray + "Aero offline" = gateway stopped
- No indicator = agent not configured (BYO-agent user)

#### 3F. Agent task types

| Task type | What Aero does | Triggered by |
|---|---|---|
| `investigate` | Trace why citation was lost (indexing? content? competitor?) | Webhook, user action |
| `audit` | Run `npx @ainyc/aeo-audit` on a URL | User action button |
| `analyze` | Competitive comparison, trend analysis, gap analysis | User Cmd+K, schedule |
| `monitor` | Set up persistent watch on keyword/provider pair | User Cmd+K |
| `report` | Generate weekly/monthly summary | Schedule, user Cmd+K |
| `fix` | Draft schema markup, llms.txt, content changes | Post-audit recommendation |
| `custom` | Any freeform request from Cmd+K | User Cmd+K |

#### 3G. Docs

**Update:** AGENTS.md files, skill references, `docs/data-model.md` for new `agent_tasks` table.

#### Parallelization
- 3A (API + DB) first
- 3B, 3C, 3D, 3E can proceed in parallel once 3A is done

---

### Phase 4: Sync & Monetization (design now, build later)

Design only. Implementation in a separate private repo.

#### What syncs (paid feature)
- Project configurations (via `canonry export` / `canonry apply`)
- Run metadata + health snapshots + insights (small, high-value)
- Agent memory (structured JSON records)

#### What doesn't sync
- Raw query snapshots (too large), API keys (security), integration connections (per-env)

#### Architecture
- **In canonry:** sync client (`canonry sync login/push/pull/status`), local diff computation
- **Separate service:** sync server, billing, team management, SSO

#### Tiers
- **Free ($0):** full local functionality including intelligence + agent
- **Team ($29/seat/mo):** + centralized sync, shared projects, team management
- **Enterprise (custom):** + self-hosted sync, SSO, dedicated runner

#### Runner mode
A team "runner" is a canonry daemon on a VPS. Runs scheduled sweeps, pushes results to sync. Non-runner machines pull results but don't execute schedules.

---

## Versioning

One release, one bump. Per AGENTS.md: "Every non-documentation change must include a version bump." But the three phases ship as a single minor release, not three separate bumps.

**Bump:** Both root `package.json` and `packages/canonry/package.json` to **1.39.0** (minor — new features, no breaking changes to existing API surface). Applied once, after Phase 3 completes and all tests pass.

Doc-only changes within each phase don't need their own bump — they're part of the feature work.

---

## Verification Plan

### Phase 1
1. `pnpm test` — all existing tests pass + new coordinator/service tests
2. `pnpm typecheck` + `pnpm lint` — clean
3. Run a sweep on a project **with no notifications configured** → verify insights and health snapshots appear in DB
4. Run a sweep on a project **with notifications** → verify both insights persisted AND webhooks sent
5. `canonry insights <project> --format json` — returns real insights (not empty)
6. `canonry health <project> --format json` — returns real health snapshot
7. Dashboard project page shows DB-backed insights (not in-memory generated)

### Phase 2
8. `canonry agent setup --install` — detects/installs OpenClaw, seeds workspace at `~/.openclaw-aero/`
9. `canonry agent start` → `canonry agent status` → `canonry agent stop` — all work with `--format json`
10. `canonry agent reset` — cleans up `~/.openclaw-aero/`
11. `pnpm --filter @ainyc/canonry run build` then `npm pack --dry-run` in `packages/canonry/` — verify `assets/agent-workspace/skills/aero/SKILL.md` and `assets/agent-workspace/skills/canonry-setup/SKILL.md` appear in the output
12. Verify new notification events (`insight.critical`, `insight.high`) accepted by `canonry notify add`

### Phase 3
13. Dashboard shows health score dots in sidebar
14. Insight cards have action buttons that dispatch agent tasks
15. Task queue page shows running/completed/scheduled tasks
16. Cmd+K opens command palette, dispatches task, closes
17. Topbar shows Aero status (working/idle/offline/not configured)
18. BYO-agent users see insights + health but no Aero-specific UI when agent not configured

---

## Critical Files Reference

| File | Role | Phase |
|------|------|-------|
| `packages/canonry/src/server.ts:237` | Replace direct notifier wiring with RunCoordinator | 1 |
| `packages/canonry/src/job-runner.ts:445` | onRunCompleted callback — unchanged, just receives new coordinator | 1 |
| `packages/canonry/src/notifier.ts` | Stays as-is for webhooks; coordinator calls it AFTER intelligence | 1 |
| `packages/intelligence/src/analyzer.ts` | Already built — `analyzeRuns()` finally gets called | 1 |
| `packages/db/src/schema.ts:321` | Add `runId` column to insights + health_snapshots | 1 |
| `packages/db/src/migrate.ts` | ALTER TABLE migrations for runId + indexes | 1 |
| `packages/contracts/src/intelligence.ts` | Add `runId` to InsightDto + HealthSnapshotDto | 1 |
| `packages/api-routes/src/intelligence.ts` | Add `?runId=` filter to GET insights route | 1 |
| `packages/canonry/src/client.ts:678` | Client methods already exist — no changes needed in Phase 1 | 1 |
| `apps/web/src/view-models.ts:136` | `ProjectInsightVm` — target shape for insight mapper | 1 |
| `apps/web/src/build-dashboard.ts:635` | Prefer DB-backed insights via mapper, fallback to in-memory | 1 |
| `packages/contracts/src/notification.ts` | Add `insight.critical` + `insight.high` events | 2 |
| `packages/api-routes/src/notifications.ts:11` | `VALID_EVENTS` array — must include new events | 2 |
| `packages/api-routes/src/index.ts:45` | Add `onProjectUpserted` to `ApiRoutesOptions` | 2 |
| `packages/api-routes/src/projects.ts` | Fire `onProjectUpserted` after create/update | 2 |
| `packages/api-routes/src/apply.ts:224` | Fire `onProjectUpserted` after apply; note: replaces all notifications | 2 |
| `packages/canonry/src/config.ts` | Add `AgentConfigEntry` (profile: 'aero') | 2 |
| `packages/canonry/package.json:26` | `"files"` field — assets/ must contain agent workspace | 2 |
| `packages/canonry/assets/agent-workspace/` | SOUL.md, AGENTS.md, skills/aero/ — must be under assets/ for npm | 2 |
| `packages/api-routes/package.json` | Add `@fastify/websocket` dependency for Phase 3 WS | 3 |
