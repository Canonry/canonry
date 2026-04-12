# OpenClaw Agent Layer Integration Plan

## Context

Canonry (v1.39.0) is an open-source agent-first AEO monitoring platform. The team wants to add an AI agent layer (persona: "Aero") on top of canonry, following the **DenchClaw distribution model** (forked OpenClaw for CRM) and the **Obsidian monetization model** (free local tool, paid sync for teams).

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
- ~~Phase 1 is written as greenfield but intelligence already exists~~ **Resolved** — Phase 1 implemented as additive integration, not a rewrite.
- ~~Agent config must include `binary`, `profile` (`aero`), `autoStart`, `gatewayPort` — not just an enable flag.~~ **Done** — `AgentConfigEntry` has all fields, persisted via `saveConfigPatch()`.
- ~~`canonry agent setup` must be fully non-interactive.~~ **Done** — supports both interactive (prompts via `initCommand` in `init.ts`) and non-interactive (flags/env vars). Setup uses `openclaw onboard --non-interactive --accept-risk --mode local`. Agent LLM credentials stored in `~/.openclaw-aero/.env`. Gateway spawned via `openclaw --profile aero gateway` (direct mode, not launchd).
- ~~Skills directory `skills/aero/`~~ **Done** — created at `skills/aero/` with SKILL.md and reference docs.

---

## Current State: What Already Exists

### Intelligence Infrastructure (95% built, ~80% integrated)

Phase 1 integration is largely complete. The run-completion pipeline now calls `analyzeRuns()` and persists results.

| Component | Status | Location |
|-----------|--------|----------|
| Analysis engine (`analyzeRuns`, `detectRegressions`, `detectGains`, `computeHealth`, `analyzeCause`, `generateInsights`) | **Integrated** — called by `IntelligenceService` on every run completion | `packages/intelligence/src/` |
| DTOs (`InsightDto`, `HealthSnapshotDto`) | Built, includes `runId` field | `packages/contracts/src/intelligence.ts` |
| DB tables (`insights`, `health_snapshots`) | **Populated** — v21 migrations create tables, v22 adds `runId` column | `packages/db/src/schema.ts` |
| API routes (GET insights, GET/filter by runId, GET health, POST dismiss) | **Functional** — returns real DB-backed results | `packages/api-routes/src/intelligence.ts` |
| Client methods (`getInsights`, `getHealth`, `dismissInsight`, etc.) | Built | `packages/canonry/src/client.ts` |
| CLI (`canonry insights`, `canonry insights dismiss`, `canonry health`) | **Built + dismiss command** | `packages/canonry/src/cli-commands/intelligence.ts` |
| `RunCoordinator` | **Built** — failure-isolated post-run orchestrator | `packages/canonry/src/run-coordinator.ts` |
| `IntelligenceService` | **Built** — DB read/write layer, idempotent via runId | `packages/canonry/src/intelligence-service.ts` |
| Frontend insight rendering | Built, **still uses in-memory generation** | `apps/web/src/pages/ProjectPage.tsx:907` |

### Remaining Gap

1. ~~Nobody calls `analyzeRuns()` after a run completes~~ **Done** — `RunCoordinator` → `IntelligenceService` → `analyzeRuns()`
2. ~~Nobody writes to the `insights` or `health_snapshots` tables~~ **Done** — `IntelligenceService.analyzeAndPersist()`
3. ~~The `Notifier` short-circuits when no notifications are enabled~~ **Done** — `RunCoordinator` runs intelligence independently of notifier
4. ~~The frontend builds insights client-side in `build-dashboard.ts:635`~~ **Done** — `buildProjectCommandCenter()` prefers DB-backed insights via mapper, falls back to in-memory
5. ~~The intelligence package is not listed as a dependency of `@ainyc/canonry`~~ **Done** — added to `package.json` + `tsup.config.ts`
6. ~~Tests for `RunCoordinator` and `IntelligenceService`~~ **Done** — full coverage in `packages/canonry/test/` + mapper tests in `apps/web/test/`

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

> **Status: Complete.** All steps (1A–1E) are done.

#### 1A. Schema migration: add `runId` + idempotency ✅ DONE

Query snapshot indexes preserved from v21. Intelligence tables created in v22. `runId` column added in v23. Both `insights` and `health_snapshots` have `runId` with cascade delete and indexes.

**Idempotency strategy:** `IntelligenceService.analyzeAndPersist()` deletes existing insights/health_snapshots for the given `runId` before inserting, inside a transaction. This makes re-runs safe (same result, no duplicates).

#### 1B. Run-completion coordinator + Intelligence service ✅ DONE

**Created:** `packages/canonry/src/run-coordinator.ts` — post-run orchestrator with failure isolation. Intelligence runs first (so insights are persisted before webhooks fire), then notifier. Each step has independent try/catch.

**Created:** `packages/canonry/src/intelligence-service.ts` — DB integration layer. Fetches the two most recent completed/partial runs, converts snapshots to `RunData` format, calls `analyzeRuns()`, persists results in a transaction.

**Wired in `server.ts`:**
```typescript
const intelligenceService = new IntelligenceService(opts.db)
const runCoordinator = new RunCoordinator(notifier, intelligenceService)
jobRunner.onRunCompleted = (runId, projectId) => runCoordinator.onRunCompleted(runId, projectId)
```

**Also completed:**
- `InsightDto` and `HealthSnapshotDto` include `runId: string | null`
- `GET /projects/:name/insights?runId=` filter parameter works
- `@ainyc/canonry-intelligence` added to `package.json` + `tsup.config.ts`
- `canonry insights dismiss` CLI command added (was missing from original implementation)
- API routes use `throw notFound()` factory (not hand-constructed error JSON)
- `packages/intelligence/` has `AGENTS.md` + `CLAUDE.md`
- Documentation updated: api-routes AGENTS.md, canonry AGENTS.md, skills CLI reference

#### 1C. Migrate frontend from in-memory to DB-backed insights ✅ DONE

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

**Created:** `apps/web/src/mappers/insight-mapper.ts` — `mapInsightDtoToVm(dto: InsightDto): ProjectInsightVm` and `mapInsightDtosToVms()` (filters dismissed).
- `type` → `tone`: regression→negative, gain→positive, opportunity→caution
- `keyword` + `provider` → single-element `affectedPhrases[]` with `citationState` derived from type
- `recommendation.action` → `actionLabel` (fallback: type name)
- `cause.details` or `cause.cause` → `detail`
- `evidenceId` omitted (no evidence linkage from DB insights)

**Modified:** `apps/web/src/api.ts` — added `fetchInsights(project, runId?)` and `fetchLatestHealth()` API functions. `fetchInsights` accepts optional `runId` to scope results to a single run.

**Modified:** `apps/web/src/queries/use-dashboard.ts` — fetches `dbInsights` scoped to `completedRuns[0]?.id` via `fetchInsights()`. Uses array-vs-null to distinguish "intelligence ran for this run" (`[]`) from "fetch failed or no run" (`null`).

**Modified:** `apps/web/src/build-dashboard.ts` — `buildProjectCommandCenter()` always runs in-memory `buildInsights()` for full signal coverage (7 types). When DB insights exist for the latest run, merges via `mergeInsights()`: DB regressions/gains replace in-memory `insight_lost` (richer cause/recommendation data), all other in-memory signals preserved (first-citation, provider-pickup, persistent-gap, competitor signals, stable). Falls back to pure in-memory when `dbInsights` is null.

**Modified:** `apps/web/src/pages/ProjectPage.tsx` — `InsightSignals` suppresses "View →" button for affected phrases with empty `evidenceId` (DB-backed insights have no evidence linkage). Uses stable composite key (`insight.id + index`) when evidenceId is empty.

#### 1D. Testing ✅ DONE

**Exists:** `packages/canonry/test/run-coordinator.test.ts` — verifies both intelligence and notifier are called; verifies intelligence runs even when notifications fail; verifies execution order.
**Exists:** `packages/canonry/test/intelligence-service.test.ts` — real SQLite DB; verifies insights + health snapshots persisted after analysis; covers idempotency, regression detection, backfill, edge cases.
**Created:** `apps/web/test/insight-mapper.test.ts` — 20 tests covering tone mapping, affected phrases, actionLabel/detail derivation, dismissed filtering.

Note: `packages/intelligence/` already has full test coverage (analyzer, regressions, gains, health, causes, insights).

#### 1E. Workspace config ✅ DONE

`packages/intelligence` included in vitest workspace. Version bumped to **1.39.0** (both root and `packages/canonry/package.json`).

#### Parallelization
- ~~1A (schema migration) first — 1B and 1C depend on `runId` existing~~ Done
- ~~1B and 1C can proceed in parallel after 1A~~ All done
- ~~1C and 1D can proceed in parallel~~ All done

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

Per AGENTS.md: "Every non-documentation change must include a version bump."

**v1.39.0** — already applied (both root `package.json` and `packages/canonry/package.json`). Covers Phase 1 intelligence integration. Subsequent phases may warrant additional bumps depending on scope.

Doc-only changes within each phase don't need their own bump — they're part of the feature work.

---

## Verification Plan

### Phase 1
1. ✅ `pnpm test` — all existing tests pass (intelligence package has full test coverage)
2. ✅ `pnpm typecheck` + `pnpm lint` — clean
3. Run a sweep on a project **with no notifications configured** → verify insights and health snapshots appear in DB
4. Run a sweep on a project **with notifications** → verify both insights persisted AND webhooks sent
5. `canonry insights <project> --format json` — returns real insights (not empty)
6. `canonry health <project> --format json` — returns real health snapshot
7. Dashboard project page shows DB-backed insights (not in-memory generated) — **wired, needs manual verification**
8. `canonry insights dismiss <project> <id>` — verify insight marked as dismissed

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

| File | Role | Phase | Status |
|------|------|-------|--------|
| `packages/canonry/src/server.ts` | RunCoordinator wired into job runner | 1 | ✅ Done |
| `packages/canonry/src/run-coordinator.ts` | Post-run orchestrator with failure isolation | 1 | ✅ Done |
| `packages/canonry/src/intelligence-service.ts` | DB read/write layer for intelligence | 1 | ✅ Done |
| `packages/canonry/src/job-runner.ts` | onRunCompleted callback — unchanged, receives coordinator | 1 | ✅ No change needed |
| `packages/canonry/src/notifier.ts` | Stays as-is; coordinator calls it AFTER intelligence | 1 | ✅ No change needed |
| `packages/intelligence/src/analyzer.ts` | `analyzeRuns()` — now called by IntelligenceService | 1 | ✅ Done |
| `packages/db/src/schema.ts` | `insights` + `health_snapshots` tables with `runId` | 1 | ✅ Done |
| `packages/db/src/migrate.ts` | v21 table creation + v22 ALTER TABLE for runId | 1 | ✅ Done |
| `packages/contracts/src/intelligence.ts` | `InsightDto` + `HealthSnapshotDto` with `runId` | 1 | ✅ Done |
| `packages/api-routes/src/intelligence.ts` | Routes with `?runId=` filter, `notFound()` factory | 1 | ✅ Done |
| `packages/canonry/src/client.ts` | Client methods for insights + health + dismiss | 1 | ✅ Done |
| `packages/canonry/src/cli-commands/intelligence.ts` | `insights`, `insights dismiss`, `health` commands | 1 | ✅ Done |
| `apps/web/src/view-models.ts:136` | `ProjectInsightVm` — target shape for insight mapper | 1C | ✅ Done |
| `apps/web/src/mappers/insight-mapper.ts` | `mapInsightDtoToVm` + `mapInsightDtosToVms` | 1C | ✅ Done |
| `apps/web/src/build-dashboard.ts:898` | Prefer DB-backed insights via mapper, fallback to in-memory | 1C | ✅ Done |
| `apps/web/src/queries/use-dashboard.ts` | Fetches `dbInsights` via `fetchInsights()` | 1C | ✅ Done |
| `apps/web/src/api.ts` | `fetchInsights()` + `fetchLatestHealth()` API functions | 1C | ✅ Done |
| `packages/canonry/test/run-coordinator.test.ts` | Coordinator unit tests (4 tests) | 1D | ✅ Done |
| `packages/canonry/test/intelligence-service.test.ts` | Service integration tests (9 tests) | 1D | ✅ Done |
| `apps/web/test/insight-mapper.test.ts` | Mapper unit tests (20 tests) | 1C | ✅ Done |
| `packages/contracts/src/notification.ts` | Add `insight.critical` + `insight.high` events | 2 | |
| `packages/api-routes/src/notifications.ts:11` | `VALID_EVENTS` array — must include new events | 2 | |
| `packages/api-routes/src/index.ts:45` | Add `onProjectUpserted` to `ApiRoutesOptions` | 2 | |
| `packages/api-routes/src/projects.ts` | Fire `onProjectUpserted` after create/update | 2 | |
| `packages/api-routes/src/apply.ts:224` | Fire `onProjectUpserted` after apply; note: replaces all notifications | 2 | |
| `packages/canonry/src/config.ts` | Add `AgentConfigEntry` (profile: 'aero') | 2 | |
| `packages/canonry/package.json:26` | `"files"` field — assets/ must contain agent workspace | 2 | |
| `packages/canonry/assets/agent-workspace/` | SOUL.md, AGENTS.md, skills/aero/ — must be under assets/ for npm | 2 | |
| `packages/api-routes/package.json` | Add `@fastify/websocket` dependency for Phase 3 WS | 3 | |
