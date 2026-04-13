# Agent Tasks Plan (Phase 3 of OpenClaw Agent Layer)

> **Superseded by [`plans/agent-conversation.md`](./agent-conversation.md).** This plan modeled the dashboard as a task control panel with a custom `agent_tasks` queue, dispatch API, callback protocol, and a separate task queue page. After deeper investigation of OpenClaw's primitives — specifically the OpenAI-compatible chat completions endpoint with `x-openclaw-session-key` header support, the `SessionMessageSubscriberRegistry` WS broadcast for cross-channel session events, and the universal `session.dmScope` model that lets every chat adapter route to the same session — a much simpler architecture became feasible: treat the dashboard as just another OpenClaw chat surface (peer to Telegram, Discord, Slack, etc.) backed by the same Aero session. The new plan preserves the user's existing chat-driven UX seamlessly across all surfaces. The sections below are kept for historical reference.

## Context

This plan supersedes the Phase 3 section of [`plans/openclaw-agent-layer.md`](./openclaw-agent-layer.md). Phases 1 and 2 of that plan are complete and shipped (intelligence integration, OpenClaw bootstrap, agent webhook lifecycle). Phase 3 in the original plan was sketched at a generic "build the dashboard surfaces" level, with an assumption that canonry would proxy task execution to OpenClaw's gateway over WebSocket. After investigating OpenClaw's actual primitives (webhook plugin, task-flow registry, cron-job webhook delivery, `tools/invoke` API), that assumption is wrong. This plan replaces it with a concrete protocol that fits OpenClaw's real shape and preserves canonry's BYO-agent parity guarantee.

The goal is unchanged: make Aero a visible **autonomous analyst** on the dashboard, not a chatbot. Users surface intent via the insight feed, the task queue, or a Cmd+K palette; Aero (or a BYO worker) executes; results post back to canonry's durable task table; the UI reflects state in real time.

---

## Architecture decision: hybrid task queue with skill-mediated callback

**Canonry owns the durable task queue** (`agent_tasks` table). It is the source of truth for what work exists and what state each task is in, regardless of which agent runtime is executing the work.

Two dispatch paths feed the same queue:

1. **Push to OpenClaw (managed-agent users).** When a task is created and `config.agent.autoStart` is true, canonry POSTs `{action: "create_flow", goal, stateJson: {canonryTaskId, callbackUrl, callbackToken, taskType, projectId}}` to OpenClaw's webhook plugin route at `http://localhost:<gatewayPort>/plugins/webhooks/canonry`. The Aero skill — which canonry owns and ships in `assets/agent-workspace/skills/aero/` — picks up the flow inside OpenClaw's session, reads its `stateJson` for the canonry callback metadata, executes the work, and POSTs progress + final result back to `callbackUrl` on canonry. Canonry updates the matching `agent_tasks` row.

2. **Pull by BYO worker (power users / tooling integrations).** Canonry exposes the queue as REST. A BYO worker (Cursor, a shell script, a Temporal worker, anything) calls `GET /api/v1/agent/tasks?status=queued`, atomically claims a task via `POST /api/v1/agent/tasks/{id}/claim`, executes it however it wants, and PATCHes status + result back via the same endpoints OpenClaw's Aero skill uses on the callback path.

Both paths converge on the same `agent_tasks` row updates. The frontend reads that table (initially via polling, optionally via WebSocket later) and renders the queue, insight action results, and Cmd+K dispatch outcomes uniformly.

### Why this shape

| Alternative considered | Why it was rejected |
|---|---|
| **Pure proxy** — canonry forwards `POST /agent/tasks` straight to OpenClaw's gateway over HTTP, returns the synchronous result | Long-running agent loops time out HTTP requests. Couples canonry to OpenClaw's gateway protocol versioning. Breaks BYO-agent parity (BYO users would have nowhere to plug in). Failure modes are worse: gateway down → 503 → user confused, vs. queue model where work just sits queued until a worker comes back. |
| **Pure pull** — OpenClaw polls canonry's queue directly | OpenClaw is not a polling worker. It has no native "watch an external queue" mode. Tasks originate inside OpenClaw from cron, ACP child sessions, `sessions_spawn`, or CLI commands. There is no documented or source-visible primitive for OpenClaw to call out and ask canonry "any work for me?". |
| **Use OpenClaw's `requesterOrigin` for callback** | `requesterOrigin` is a `DeliveryContext` with `channel` / `to` / `accountId` / `threadId` fields — a chat-channel target (Slack, Telegram, etc.), not an HTTP URL. It cannot POST to canonry. Verified in `src/utils/delivery-context.types.ts` and `src/tasks/task-registry.types.ts`. |
| **Use OpenClaw's cron-job webhook delivery** | Cron jobs DO support real HTTP POST callbacks (`delivery.mode = "webhook"`, `delivery.to = <url>`, optional `cron.webhookToken` for `Authorization: Bearer`). But cron is designed for scheduled work, not ad-hoc dispatch — every dispatched task would have to be a one-shot `kind: "at"` cron job firing now, with two registries to reconcile (cron jobs vs. flows). Workable but ugly; revisit only if the skill-mediated callback path proves insufficient. |
| **`POST /tools/invoke` synchronous RPC** | Synchronous only. Returns the tool result in the HTTP response body. Fine for short, deterministic operations (fetch a URL, read a config), but blocks for the duration of any agent loop. Long-running tasks (audits, multi-step investigations) would either time out or pin a connection for minutes. Useful as a **secondary** primitive for in-task tool calls, not as the primary dispatch path. |
| **Embed callback in `create_flow.stateJson` + skill POSTs back** *(chosen)* | Works with OpenClaw as it ships today. No upstream feature requests. The Aero skill is something canonry already owns and ships in `assets/agent-workspace/skills/aero/`; teaching it "after every state change, POST to `state.callbackUrl` with `Authorization: Bearer ${state.callbackToken}`" is normal skill-authoring, not a protocol negotiation. The protocol is encoded in code we control on both sides (canonry sends the metadata, the Aero skill consumes it). |

### What the Aero skill becomes

The skill in `assets/agent-workspace/skills/aero/` is **the protocol adapter** between canonry's queue and OpenClaw's task-flow runtime. It is not just persona + workflow recipes. It is also the executable definition of "what does Aero do when canonry hands it a task." The split:

- **Canonry's responsibility:** maintain the durable queue, dispatch tasks to OpenClaw via `create_flow` with metadata in `stateJson`, expose a callback endpoint, render the UI.
- **Aero skill's responsibility:** read flow `stateJson` on activation, dispatch on `taskType`, execute the work using OpenClaw's tools (fetch, sessions, models, etc.), POST progress and terminal results to the canonry callback URL, call `finish_flow` / `fail_flow` / `cancel_flow` on the OpenClaw side to keep the flow registry consistent.

This is the clean separation that makes BYO-agent parity automatic: the skill *is* the canonry-protocol adapter. A BYO agent (Cursor, Temporal worker, etc.) implements the same callback protocol against the same REST endpoints, just without the OpenClaw flow-registry plumbing in the middle.

---

## Dispatch protocol (the wire contract)

This section is the canonical contract that both canonry and the Aero skill must implement. It is the source of truth — the API endpoint specs, DB shape, skill recipes, and test cases all derive from this section. Update this section first when the protocol changes.

### Task lifecycle states

```
queued → running → (completed | failed | cancelled)
              ↑
           cancelling (intermediate, set when cancel is requested)
```

- **queued**: row inserted by canonry, no worker has claimed it yet.
- **running**: a worker (Aero skill or BYO) has claimed and started executing.
- **cancelling**: user has requested cancellation; worker is expected to wind down.
- **completed**: terminal; `result` is populated.
- **failed**: terminal; `error` is populated.
- **cancelled**: terminal; worker acknowledged the cancel and stopped.

Terminal states are immutable. Once a task reaches `completed`, `failed`, or `cancelled`, no further updates are accepted.

### Step 1 — Canonry creates the task row

```sql
INSERT INTO agent_tasks (
  id, project_id, type, prompt, status,
  dispatched_by, callback_token, created_at
) VALUES (
  ?, ?, ?, ?, 'queued',
  ?, ?, ?
)
```

`callback_token` is a per-task secret canonry generates (`crypto.randomBytes(32).toString('hex')`). It scopes the callback endpoint so a leaked token only authorizes updates to one specific task, not the whole queue.

### Step 2A — Canonry dispatches to OpenClaw (managed-agent path)

If `config.agent.autoStart` is true and the agent manager reports OpenClaw is running:

```http
POST http://localhost:{gatewayPort}/plugins/webhooks/canonry
Authorization: Bearer {OPENCLAW_WEBHOOK_SECRET}
Content-Type: application/json

{
  "action": "create_flow",
  "goal": "{prompt}",
  "notifyPolicy": "state_changes",
  "stateJson": {
    "canonryTaskId": "{taskId}",
    "callbackUrl": "{canonryApiUrl}/api/v1/agent/tasks/{taskId}/callback",
    "callbackToken": "{callbackToken}",
    "taskType": "{type}",
    "projectId": "{projectId}",
    "context": {
      "projectName": "{projectName}",
      "canonicalDomain": "{canonicalDomain}",
      "relatedRunId": "{runId}",
      "relatedKeyword": "{keyword}",
      "relatedProvider": "{provider}"
    }
  }
}
```

OpenClaw's webhook plugin validates the request against the route's `createFlowRequestSchema` (verified in `extensions/webhooks/src/http.ts`), inserts a flow row in its task-flow registry bound to the configured `sessionKey`, and returns:

```json
{ "ok": true, "routeId": "canonry", "result": { "flowId": "..." } }
```

Canonry stores the returned `flowId` on the `agent_tasks` row (`openclaw_flow_id` column) so cancellation requests can reference it.

If the dispatch POST fails (OpenClaw not running, network error), the task **stays queued**. A BYO worker can still claim it later. Canonry logs the failure, increments a `dispatch_attempts` counter, and the row stays observable via `canonry agent task list` so the user can diagnose. We do not auto-retry the dispatch POST — if OpenClaw is down, retrying every few seconds would flood logs; users restart OpenClaw via `canonry agent start` and the next created task dispatches normally.

### Step 2B — BYO worker pulls the task

A BYO worker polls canonry's queue:

```http
GET /api/v1/agent/tasks?status=queued
Authorization: Bearer {canonryApiKey}
```

Returns an array of queued tasks. The worker picks one and atomically claims it:

```http
POST /api/v1/agent/tasks/{id}/claim
Authorization: Bearer {canonryApiKey}
Content-Type: application/json

{ "claimedBy": "cursor-worker-1" }
```

Claim is implemented as a conditional UPDATE — it succeeds only if `status = 'queued'`:

```sql
UPDATE agent_tasks
SET status = 'running',
    claimed_by = ?,
    claimed_at = ?,
    started_at = ?
WHERE id = ? AND status = 'queued'
RETURNING *
```

If the row was already claimed (status changed under us), the UPDATE affects 0 rows and the endpoint returns `409 Conflict` with the error code `TASK_ALREADY_CLAIMED`. This is the **only** atomic claim primitive in the system; it prevents two BYO workers (or a BYO worker + the Aero skill in a misconfiguration) from both executing the same task. Aero skill workers do not need to call `/claim` because OpenClaw's webhook plugin gives them the flow exclusively — the canonry task row is updated via callback in Step 3 instead.

### Step 3 — Worker reports progress and final result

Both Aero and BYO workers POST to the per-task callback endpoint:

```http
POST /api/v1/agent/tasks/{id}/callback
Authorization: Bearer {callbackToken}    # Aero path
# OR
Authorization: Bearer {canonryApiKey}    # BYO path
Content-Type: application/json

{
  "status": "running",            # or "completed" | "failed" | "cancelled"
  "progress": "Fetching competitor pages…",
  "progressPct": 45,              # optional, 0-100
  "result": { ... },              # required if status is "completed"
  "error": "...",                 # required if status is "failed"
  "logs": ["..."]                 # optional, append-only execution trace
}
```

The endpoint accepts **two distinct auth modes**:
- A `callback_token` (per-task secret) authorizes updates to **only that task**. Aero uses this. The token never leaves the OpenClaw process unless the user has compromised their own machine.
- The standard canonry API key authorizes updates to **any task**. BYO workers use this since they're already authenticated as the user.

The endpoint validates state transitions (queued → running → terminal; no terminal → anything; no skipping states) and rejects invalid transitions with `409 Conflict`. Progress updates while in `running` state are unbounded — workers can PATCH as often as makes sense.

### Step 4 — Cancellation

User clicks cancel in the dashboard:

```http
POST /api/v1/agent/tasks/{id}/cancel
Authorization: Bearer {canonryApiKey}
```

Canonry sets `status = 'cancelling'`, `cancel_requested_at = NOW()`, and:

- **Managed-agent path:** POSTs `{action: "request_cancel", flowId: <openclawFlowId>, expectedRevision: <last known>}` to the OpenClaw webhook plugin. The Aero skill detects the cancel-requested state on its next progress check, winds down the agent loop, POSTs final `cancelled` status to the callback endpoint, and calls `cancel_flow` on the OpenClaw side to terminate the flow registry entry.
- **BYO path:** the worker is expected to poll task status (`GET /agent/tasks/{id}`) periodically while running and respect `cancelling` state. If it doesn't, canonry has no out-of-band kill switch. Document this clearly — BYO workers must be cooperative.

If a worker doesn't acknowledge a cancel within `CANCEL_TIMEOUT_MS` (default 60s), canonry forcibly transitions the row to `cancelled` and any subsequent callback from the worker is rejected with `STALE_CLAIM`. The worker can detect this via the 409 response and stop work.

### Step 5 — Dashboard reflects the change

The frontend either polls `GET /agent/tasks?since=<lastSeen>` every 2s (v1) or subscribes to `/api/v1/agent/tasks/stream` over WebSocket (v2 optimization). Each update triggers a re-render of the task queue and any insight cards whose action button is associated with the task.

---

## DB schema

### `agent_tasks` table (new)

```typescript
// packages/db/src/schema.ts
export const agentTasks = sqliteTable('agent_tasks', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),                    // 'investigate' | 'audit' | 'analyze' | 'monitor' | 'report' | 'fix' | 'custom'
  prompt: text('prompt').notNull(),                // human-readable goal/description
  status: text('status').notNull().default('queued'),  // 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'
  dispatchedBy: text('dispatched_by').notNull(),   // 'user' | 'webhook' | 'schedule' | 'insight-action'
  context: text('context'),                        // JSON: { runId?, keyword?, provider?, insightId?, ... }
  callbackToken: text('callback_token').notNull(), // per-task secret for the callback endpoint
  openclawFlowId: text('openclaw_flow_id'),        // set after successful dispatch to OpenClaw, null for BYO-only
  claimedBy: text('claimed_by'),                   // worker identifier — 'aero' or BYO worker name
  claimedAt: text('claimed_at'),
  cancelRequestedAt: text('cancel_requested_at'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  progress: text('progress'),                      // human-readable progress string (last update)
  progressPct: integer('progress_pct'),            // 0-100, optional
  result: text('result'),                          // JSON, terminal completed result
  error: text('error'),                            // string, terminal failure message
  logs: text('logs').notNull().default('[]'),     // JSON array of progress log lines
  dispatchAttempts: integer('dispatch_attempts').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_agent_tasks_project').on(table.projectId),
  index('idx_agent_tasks_status').on(table.status),
  index('idx_agent_tasks_status_created').on(table.status, table.createdAt),
])
```

### Migration (`packages/db/src/migrate.ts`)

Add a new entry to the `MIGRATIONS` array. Find the highest existing `vN:` and increment.

```typescript
// vNN: Phase 3 — agent_tasks table for queue-based agent dispatch
`CREATE TABLE IF NOT EXISTS agent_tasks (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type                  TEXT NOT NULL,
  prompt                TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'queued',
  dispatched_by         TEXT NOT NULL,
  context               TEXT,
  callback_token        TEXT NOT NULL,
  openclaw_flow_id      TEXT,
  claimed_by            TEXT,
  claimed_at            TEXT,
  cancel_requested_at   TEXT,
  started_at            TEXT,
  completed_at          TEXT,
  progress              TEXT,
  progress_pct          INTEGER,
  result                TEXT,
  error                 TEXT,
  logs                  TEXT NOT NULL DEFAULT '[]',
  dispatch_attempts     INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
)`,
`CREATE INDEX IF NOT EXISTS idx_agent_tasks_project ON agent_tasks(project_id)`,
`CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status)`,
`CREATE INDEX IF NOT EXISTS idx_agent_tasks_status_created ON agent_tasks(status, created_at)`,
```

---

## Contracts (`packages/contracts/src/agent-tasks.ts`)

```typescript
import { z } from 'zod'

export const taskTypeSchema = z.enum([
  'investigate',
  'audit',
  'analyze',
  'monitor',
  'report',
  'fix',
  'custom',
])
export type TaskType = z.infer<typeof taskTypeSchema>
export const TaskTypes = taskTypeSchema.enum   // enum constant per AGENTS.md

export const taskStatusSchema = z.enum([
  'queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled',
])
export type TaskStatus = z.infer<typeof taskStatusSchema>
export const TaskStatuses = taskStatusSchema.enum

export const taskDispatchedBySchema = z.enum([
  'user', 'webhook', 'schedule', 'insight-action',
])
export type TaskDispatchedBy = z.infer<typeof taskDispatchedBySchema>

export const agentTaskContextSchema = z.object({
  runId: z.string().optional(),
  keyword: z.string().optional(),
  provider: z.string().optional(),
  insightId: z.string().optional(),
  url: z.string().optional(),
}).strict()

export const agentTaskDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string(),       // hydrated for UI convenience
  type: taskTypeSchema,
  prompt: z.string(),
  status: taskStatusSchema,
  dispatchedBy: taskDispatchedBySchema,
  context: agentTaskContextSchema.nullable(),
  claimedBy: z.string().nullable(),
  claimedAt: z.string().nullable(),
  cancelRequestedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  progress: z.string().nullable(),
  progressPct: z.number().int().min(0).max(100).nullable(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
  logs: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type AgentTaskDto = z.infer<typeof agentTaskDtoSchema>

export const dispatchTaskRequestSchema = z.object({
  projectName: z.string().min(1),
  type: taskTypeSchema,
  prompt: z.string().min(1),
  dispatchedBy: taskDispatchedBySchema.optional().default('user'),
  context: agentTaskContextSchema.optional(),
})
export type DispatchTaskRequest = z.infer<typeof dispatchTaskRequestSchema>

export const taskCallbackRequestSchema = z.object({
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  progress: z.string().optional(),
  progressPct: z.number().int().min(0).max(100).optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  logs: z.array(z.string()).optional(),
})
export type TaskCallbackRequest = z.infer<typeof taskCallbackRequestSchema>
```

Re-export from `packages/contracts/src/index.ts`.

**Errors to add to `packages/contracts/src/errors.ts`:**
- `TASK_NOT_FOUND` → `notFound()` (already exists, just use it with task ID)
- `TASK_ALREADY_CLAIMED` → new factory `taskAlreadyClaimed()`, status 409
- `TASK_INVALID_TRANSITION` → new factory `taskInvalidTransition(from, to)`, status 409
- `TASK_STALE_CLAIM` → new factory `taskStaleClaim()`, status 409
- `AGENT_DISPATCH_FAILED` → new factory, status 502 (when OpenClaw POST fails — but note we still create the row, this is informational)

---

## API endpoints (`packages/api-routes/src/agent-tasks.ts`)

All under `/api/v1/agent/`. Use the global error handler — throw `notFound()`, `validationError()`, etc., rather than hand-constructing JSON.

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/agent/tasks` | API key | Create a task. Returns the row. If `agent.autoStart`, fire-and-forget dispatch to OpenClaw. |
| `GET`  | `/agent/tasks` | API key | List tasks. Query: `status`, `projectName`, `type`, `since`, `limit` (default 50, max 200). |
| `GET`  | `/agent/tasks/:id` | API key | Single task with full result/logs. |
| `POST` | `/agent/tasks/:id/claim` | API key | Atomic queued→running transition. Body: `{claimedBy: string}`. 409 if already claimed. |
| `POST` | `/agent/tasks/:id/callback` | API key **OR** `callback_token` | Worker reports progress or terminal state. |
| `POST` | `/agent/tasks/:id/cancel` | API key | Request cancellation. Sets `cancelling` state and notifies OpenClaw if dispatched there. |
| `GET`  | `/agent/status` | API key | Aggregate gateway status: `{running: bool, pid?, port?, queueDepth, runningCount, currentTaskIds[]}`. |

### Auth implementation note for the callback endpoint

The callback endpoint is the only one that accepts two auth modes. Implement as:

1. Extract bearer token from `Authorization` header.
2. If it matches `loadConfig().apiKey` (hashed), allow as full API key.
3. Else, look up the task by `id` and compare the token against `agent_tasks.callback_token` for that row only. If it matches, allow scoped to this task.
4. Else, 401.

Per-task token check uses constant-time comparison (`crypto.timingSafeEqual`).

### State transition validation

Use a small lookup table:

```typescript
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  queued:     ['running', 'cancelled'],
  running:    ['running', 'completed', 'failed', 'cancelling'],
  cancelling: ['cancelled', 'completed', 'failed'],
  completed:  [],
  failed:     [],
  cancelled:  [],
}
```

Note `running → running` is allowed (progress updates). Terminal states accept no further transitions. The endpoint rejects invalid transitions with `taskInvalidTransition(from, to)`.

### Wiring into the server

`packages/canonry/src/server.ts` registers the new routes via `apiRoutes(app, ...)`. The dispatch logic — POSTing to OpenClaw's webhook plugin — needs the agent config + manager. Pass it as a `dispatchAgentTask` callback in `ApiRoutesOptions`, similar to how `onProjectUpserted` works today:

```typescript
// in ApiRoutesOptions:
dispatchAgentTask?: (task: AgentTaskDto) => Promise<{ openclawFlowId?: string }>
```

The implementation in `server.ts` builds the `create_flow` request, POSTs to OpenClaw, returns the flowId on success or logs and returns `{}` on failure (the row stays queued; not a hard error). This keeps `api-routes` from depending directly on agent-bootstrap or the AgentManager — it stays at the same dependency boundary as the existing callbacks.

---

## CLI commands (UI/CLI parity rule — required, not optional)

Per `AGENTS.md` UI/CLI parity: every dashboard surface in Phase 3B–3E must have a matching CLI command that returns the same data. Build these **alongside** the API, not after.

```bash
# Dispatch
canonry agent task dispatch <project> --type investigate --prompt "Why did roof-coating drop on ChatGPT?"
canonry agent task dispatch <project> --type audit --prompt "..." --context '{"url":"https://example.com"}'

# Read
canonry agent task list                                  # all tasks across projects
canonry agent task list --status running --project foo
canonry agent task list --format json
canonry agent task get <task-id>
canonry agent task get <task-id> --format json
canonry agent task get <task-id> --watch                 # tail progress until terminal

# Control
canonry agent task cancel <task-id>

# Status
canonry agent status                                     # extends existing — adds queueDepth, runningCount
canonry agent status --format json
```

All commands accept `--format json` and follow the existing exit-code convention (0 success, 1 user error, 2 system error).

Add to `packages/canonry/src/cli-commands/agent.ts` `AGENT_CLI_COMMANDS` array. Implementations in `packages/canonry/src/commands/agent.ts` (or a new `commands/agent-task.ts` if that file gets too big — current file is ~360 lines after Phase 2G additions).

The `--watch` flag for `get` polls `GET /agent/tasks/{id}` every 1s, prints progress diffs, and exits when status reaches a terminal state. This is the CLI equivalent of the dashboard's real-time task detail view.

---

## Aero skill updates (`assets/agent-workspace/skills/aero/`)

The skill becomes the **canonry protocol adapter** for OpenClaw users. Add these references:

### `references/canonry-callback-protocol.md` (new)

Documents the wire format from the Aero skill's perspective. Covers:
- How to read `flow.stateJson` to extract `canonryTaskId`, `callbackUrl`, `callbackToken`, `taskType`, `projectId`, `context`
- The exact shape of progress callbacks (`POST {callbackUrl}` with `Authorization: Bearer {callbackToken}` and the `taskCallbackRequest` body)
- When to POST progress vs. only terminal: rule of thumb is "every state transition + at most every 5s during execution"
- How to detect cancellation: poll the canonry callback URL with `GET` for current task status, or inspect the OpenClaw flow's `cancelRequestedAt` field — both are valid
- Final completion: POST terminal status to canonry **then** call OpenClaw's `finish_flow` / `fail_flow` / `cancel_flow` action via the webhook plugin (route is the same `/plugins/webhooks/canonry` path) so the OpenClaw flow registry stays consistent

### `references/orchestration.md` (existing — extend)

Add a new section: **"Canonry-dispatched task workflow"** with a step-by-step recipe:

1. On flow activation (via OpenClaw's task-flow runtime), parse `stateJson` and validate the canonry metadata fields exist.
2. POST `{status: "running", progress: "Starting…"}` to the callback URL.
3. Dispatch on `taskType`:
   - `investigate` → see `references/regression-playbook.md`
   - `audit` → call `npx @ainyc/aeo-audit` with the URL from `context.url`
   - `analyze` → see `references/competitive-analysis.md` (new, Phase 3B)
   - `monitor` → see `references/monitor-setup.md` (new, Phase 3D)
   - `report` → see `references/reporting.md`
   - `fix` → see `references/fix-recipes.md` (new)
   - `custom` → freeform; the `prompt` is the goal, use general agent reasoning
4. POST progress updates with human-readable status ("Fetching competitor pages…", "Analyzing citation patterns…").
5. On completion, POST `{status: "completed", result: <markdown or structured JSON>}` and call `finish_flow`.
6. On failure, POST `{status: "failed", error: <message>}` and call `fail_flow`.
7. On cancel detection, POST `{status: "cancelled"}` and call `cancel_flow`.

### `references/regression-playbook.md` (existing — extend)

Already documents the investigate workflow conceptually. Add the canonry-specific bits: which canonry CLI/API calls to make (`canonry timeline`, `canonry snapshots diff`), how to format the diagnosis as a `result` payload (suggested fields: `summary`, `rootCause`, `recommendations[]`, `evidence[]`).

### `SKILL.md` (existing — small update)

Add to the skill metadata that this skill implements the canonry callback protocol v1, references the new doc.

---

## `canonry agent setup` additions

The setup script in `packages/canonry/src/commands/agent.ts` already does 8 steps after this branch's bulk-attach work. Phase 3 adds 3 more, between step 5 (configure LLM) and step 6 (seed workspace):

```typescript
// 5b. Generate webhook secret for canonry → OpenClaw dispatch
const webhookSecret = `cnry_wh_${crypto.randomBytes(32).toString('hex')}`
writeAgentEnv(stateDir, 'OPENCLAW_WEBHOOK_SECRET', webhookSecret)

// 5c. Install webhook plugin route in OpenClaw config
installWebhookPluginRoute(detection.path!, profile, {
  routeId: 'canonry',
  path: '/plugins/webhooks/canonry',
  sessionKey: 'agent:aero:main',           // OPEN QUESTION — see below
  secretEnvVar: 'OPENCLAW_WEBHOOK_SECRET',
})

// 5d. Save webhook secret in canonry config (so canonry knows what to send)
saveConfigPatch({
  agent: {
    ...existingAgentConfig,
    webhookSecret,
  },
})
```

`installWebhookPluginRoute` is a new helper in `agent-bootstrap.ts` that runs:

```bash
openclaw --profile aero config set plugins.entries.webhooks.enabled true
openclaw --profile aero config set plugins.entries.webhooks.config.routes.canonry.path "/plugins/webhooks/canonry"
openclaw --profile aero config set plugins.entries.webhooks.config.routes.canonry.sessionKey "agent:aero:main"
openclaw --profile aero config set plugins.entries.webhooks.config.routes.canonry.secret.source "env"
openclaw --profile aero config set plugins.entries.webhooks.config.routes.canonry.secret.id "OPENCLAW_WEBHOOK_SECRET"
openclaw --profile aero config set plugins.entries.webhooks.config.routes.canonry.controllerId "webhooks/canonry"
```

(All `openclaw config set` invocations honor the existing `OPENCLAW_PROFILE=aero` env-var-based profile resolution that the rest of the canonry setup already uses. The `--profile` flag in the example above is conceptual; if it doesn't exist on the binary, fall back to `OPENCLAW_PROFILE=aero` env injection — same as how the current `initializeOpenClawProfile` and `configureOpenClawGateway` helpers work.)

**Add to `CanonryConfig.agent`:**
```typescript
interface AgentConfigEntry {
  // ...existing fields...
  webhookSecret?: string  // for canonry → openclaw dispatch
}
```

---

## Frontend (`apps/web/`)

### 3B — Insight feed action buttons

`apps/web/src/components/InsightSignals.tsx` (or wherever the existing insight cards live — currently inline in `ProjectPage.tsx:907`; this is the right opportunity to extract into a component if it isn't already).

For each insight, render action buttons based on `insight.type`:
- `regression` → `[Investigate]` `[Run audit]` `[Dismiss]`
- `gain` → `[Generate report]` `[Dismiss]`
- `opportunity` → `[Investigate]` `[Dismiss]`

Each action button calls `apiClient.dispatchAgentTask({...})` with the appropriate `type`, `prompt`, and `context` (insight ID, related run, keyword, provider). On success, updates a local "in-flight" state so the button shows "Running…" and disables further clicks. The Insight Feed polls task status for in-flight tasks until terminal, then surfaces the result inline.

When `useAgentStatus()` reports the gateway is offline AND no BYO worker has been seen claiming tasks recently, action buttons render disabled with tooltip "Start Aero with `canonry agent start`, or run a worker against this canonry instance."

**New files:**
- `apps/web/src/components/agent/InsightActions.tsx` — the button bar
- `apps/web/src/components/agent/useAgentStatus.ts` — hook polling `GET /api/v1/agent/status` every 5s
- `apps/web/src/components/agent/useTaskStatus.ts` — hook for an individual task's status, polls every 1s while non-terminal
- `apps/web/src/api.ts` — add `dispatchAgentTask`, `listAgentTasks`, `getAgentTask`, `cancelAgentTask`, `getAgentStatus` API functions

### 3C — Task queue page

**New page:** `apps/web/src/pages/TasksPage.tsx`. Linked from sidebar (new entry). Layout:

```
Tasks
══════════════════════════════════════════════════════════════════
[ Status: All ▾ ]  [ Project: All ▾ ]  [ Type: All ▾ ]   [+ Dispatch]

● Running    Investigating "roof coating phoenix" regression       2m
             ├─ Fetching competitor pages…                  45%
             └─ Project: az-coatings · investigate · by user

✓ Complete   Weekly competitive analysis for az-coatings           3h
             └─ Project: az-coatings · analyze · by schedule

✗ Failed     Audit https://competitor.example.com                  yesterday
             └─ Error: connection timeout
```

**New components in `apps/web/src/components/agent/`:**
- `TaskQueue.tsx` — the list view, uses `useAgentTasks()` hook
- `TaskRow.tsx` — single row with status icon, prompt, progress, metadata
- `TaskDetail.tsx` — expanded view with full result (markdown render), full logs, cancel button if running, dispatch info
- `useAgentTasks.ts` — hook fetching `/agent/tasks` with filters, polls every 2s

Tables (per AGENTS.md design system: "Use tables for any list of 3+ structured items"). Tone colors: positive = emerald (completed), negative = rose (failed/cancelled), caution = amber (cancelling), neutral = zinc (queued/running).

### 3D — Cmd+K command palette

**New components:**
- `apps/web/src/components/agent/CommandPalette.tsx` — overlay with input + suggestions
- `apps/web/src/components/agent/CommandSuggestions.tsx` — context-aware suggestions
- `apps/web/src/components/agent/useCommandPalette.ts` — keyboard shortcut (Cmd+K / Ctrl+K) + dispatch logic

UX:
1. Cmd+K opens a centered modal overlay with an input and a list of suggestions.
2. Suggestions are context-dependent based on current route (project page → project-scoped suggestions; keyword detail → keyword-scoped; etc.).
3. Pressing Enter on a suggestion or typing a freeform request → POST `/agent/tasks` with `dispatchedBy: 'user'`, `type: 'custom'` (unless a suggestion specifies a typed dispatch).
4. Modal closes immediately. A toast confirms dispatch and links to the task in the queue.

Context-aware suggestions:
- On project overview: "Run a sweep", "Show regressions this week", "Generate weekly report"
- On keyword detail: "Why isn't this cited on ChatGPT?", "Audit competitor pages"
- On run detail: "Explain these results"
- Always: "Custom request…" (jumps focus to the freeform input)

### 3E — Status indicators

- **Sidebar project list:** add a small health-score dot (color from existing tone helpers) per project. Data from `GET /projects/:name/health/latest` (Phase 1 endpoint). Polls every 30s.
- **Topbar:** new Aero status pill next to the existing health pills.
  - Green dot + "Aero" → idle (gateway running, no in-flight tasks)
  - Pulsing amber + "Aero · 2 running" → tasks in flight
  - Gray + "Aero offline" → gateway stopped (link to docs/CLI command to start)
  - No pill at all → agent not configured (BYO-agent users; they see the task queue but no Aero-specific pill)

State sourced from `useAgentStatus()`.

### Optional — `/api/v1/agent/tasks/stream` WebSocket

Not required for v1. Polling at 1-2s intervals is sufficient for local-first single-user usage. Add WebSocket later as an optimization for:
- Cloud deployments where polling cost matters
- Multi-tab UIs where stream sharing reduces redundant fetches
- Long-running tasks where 2s poll latency feels laggy

If we add it, the implementation:
- New file `packages/api-routes/src/agent-ws.ts`
- Conditionally registers `@fastify/websocket` only if agent routes are enabled (avoids pulling the dep for non-agent deployments)
- Stream is a one-way push from canonry to client: row updates from the `agent_tasks` table, filtered by query params (project, status). Auth via API key passed as a query param or in the upgrade headers.

---

## Open questions to resolve at implementation time

These are small enough that they don't block planning, but each needs a 5-30 minute spike before the relevant code lands.

### Q1. Session key format for the canonry webhook plugin route

The OpenClaw docs example uses `sessionKey: "agent:main:main"` for a Zapier integration. The canonry profile uses `aero` as the OpenClaw profile name. We need to know whether the right session key is `agent:aero:main`, `agent:main:main`, or something else, and whether the session needs to exist before the route can bind to it (created by `openclaw onboard` step in our existing setup, presumably).

**How to resolve:** read `src/config/sessions/store-load.ts` and `src/channels/session.ts` in the openclaw repo, OR run `openclaw --profile aero sessions list` after `canonry agent setup` and observe what's there.

**Risk if wrong:** `create_flow` POST returns 4xx because the session doesn't exist. Easy to detect, easy to fix once we have one working example.

### Q2. Does `OPENCLAW_PROFILE=aero` route `openclaw config set` writes to the profile-specific config file?

The existing canonry setup assumes yes (it uses the env var for `openclaw onboard`, `openclaw config set gateway.port`, `openclaw models set`). Phase 3 adds 6 more `openclaw config set` calls for the webhook plugin route. If the env var doesn't propagate through `config set`, those writes would land in `~/.openclaw/openclaw.json` instead of `~/.openclaw-aero/openclaw.json`.

**How to resolve:** smoke test. After running this command, check both files:
```bash
OPENCLAW_PROFILE=aero openclaw config set test.key "value"
diff <(jq .test ~/.openclaw/openclaw.json) <(jq .test ~/.openclaw-aero/openclaw.json)
```

**Risk if wrong:** webhook plugin doesn't activate on the aero profile, all dispatches fail. Mitigation: write the JSON5 fragment directly via `fs.writeFileSync` instead of using `config set`. More fragile but works regardless.

### Q3. How does the Aero skill discover a newly-created flow?

Does OpenClaw's task-flow runtime automatically dispatch new flows to the bound session's main agent loop, or does the skill have to register a watcher? The webhook plugin's `bindSession` call (`runtime-taskflow.ts`) presumably wires this up, but the exact contract — does it inject a system message into the session, fire a callback, set a flag the skill polls? — needs to be confirmed.

**How to resolve:** read `src/plugins/runtime/runtime-taskflow.ts` in the openclaw repo. If the answer is "the skill must register a watcher," the Aero skill needs a startup hook that subscribes to flow events on its bound session.

**Risk if wrong:** flows get created in OpenClaw but Aero never picks them up — they just sit forever. Detectable via `canonry agent task list` showing tasks stuck in `running` (or `queued` if dispatch succeeded but the skill never moved the row). Mitigation: poll OpenClaw's flow registry directly via `get_flow` from the skill on a heartbeat.

---

## Verification plan

### Phase 3A (DB + API + dispatch + CLI)

1. `pnpm typecheck && pnpm lint && pnpm test` — clean
2. `canonry agent task dispatch demo-project --type investigate --prompt "test"` returns a task ID
3. `canonry agent task list --format json` returns the queued task
4. With OpenClaw NOT running (autoStart=true case): the task stays queued, `dispatch_attempts` increments, an error is logged, but the CLI succeeds (exit 0). The row is observable.
5. With a fake worker (curl) calling the BYO path: claim succeeds once, second claim returns 409, callback advances state through running → completed, terminal callback rejected.
6. Cancel an in-flight task: status moves to `cancelling`, then a cooperative worker callback flips to `cancelled`, or the timeout kicks it to `cancelled` after 60s.
7. Token security: a callback request with a wrong `callback_token` returns 401; with the correct token it accepts; the token only authorizes its own task.
8. Migration: fresh DB and existing DB both end up with the `agent_tasks` table after `migrate(db)`.

### Phase 3B–3E (frontend)

9. Insight card action buttons dispatch and disable while the task is in flight; result surfaces inline when terminal
10. Task queue page renders all tasks, filters work, expanding a row shows full result and logs
11. Cmd+K opens, suggestions are context-aware, dispatching closes the palette and toasts
12. Topbar Aero pill reflects gateway state and in-flight count
13. With OpenClaw stopped, action buttons render disabled with tooltip; manual `canonry agent task dispatch` from the CLI still works (queue path)

### End-to-end (managed-agent path)

14. `canonry agent setup --install` creates a working setup including webhook plugin route
15. `canonry agent start` brings up OpenClaw with the canonry route active
16. Dashboard click on an insight action button → task appears in queue → progress updates surface every few seconds → terminal result renders inline
17. Dashboard cancel button mid-task → flow ends within 60s with `cancelled` status, OpenClaw flow is cleaned up

### End-to-end (BYO-agent path)

18. With `agent.autoStart=false`, dispatch a task via the dashboard → row sits in `queued`
19. A test BYO worker (a Bash script using `curl`) polls, claims, sends progress, completes
20. Dashboard reflects all of this in real time without OpenClaw running

---

## Phasing and parallelization

```
3A.0  Contracts (agent-tasks.ts) + error factories                         ┐
3A.1  DB schema + migration                                                ┤  Sequential
3A.2  API routes + state machine + auth (callback dual-mode)               ┤  per file
3A.3  Server.ts wiring + dispatchAgentTask callback                        ┘
3A.4  CLI commands (dispatch, list, get, cancel, status) — UI/CLI parity   ┐
3A.5  Aero skill: callback-protocol.md + orchestration.md updates          ┤  Parallel
3A.6  agent-bootstrap.ts: installWebhookPluginRoute helper + setup wiring  ┘  with 3A.4
3A.7  Backend tests: claim race, callback auth, state transitions, dispatch failure paths
─────────────────────────────────────────────────────────────────
3B    Insight action buttons (depends on 3A.0–3A.4)                        ┐
3C    Task queue page (depends on 3A.0–3A.4)                               ┤  Parallel
3D    Cmd+K palette (depends on 3A.0–3A.4)                                 ┤  with each
3E    Status indicators (depends on 3A.0–3A.4)                             ┘  other
─────────────────────────────────────────────────────────────────
3F    Aero skill task-type recipes (regression-playbook extension, etc.)   Parallel with 3B-3E
3G    Docs: data-model.md, AGENTS.md updates, skill references             Last
3H    End-to-end verification with real OpenClaw                           After everything
```

**Hard ordering:**
- 3A.0 (contracts) before 3A.1 (DB) before 3A.2 (routes) — schema flows downstream
- 3A.4 and 3A.5 must land together — UI/CLI parity rule
- All 3A before any of 3B–3E — frontend is consumer
- 3H is the last gate before merge

**Critical-path estimate:** 3A is the only meaningful dependency bottleneck. 3B–3E and 3F can all run in parallel after 3A. The Aero skill work in 3A.5 can start in parallel with 3A.0–3A.3 since it's just markdown.

---

## Versioning

Per AGENTS.md "every non-documentation change must include a version bump." This plan is multiple shipping units, so each PR bumps as appropriate:

- **3A landing PR:** minor bump (e.g. 1.48.0 → 1.49.0) — new feature: `agent_tasks` queue, dispatch API, CLI commands, Aero callback protocol
- **3B–3E individual PRs:** patch bumps (1.49.x) — additive UI features, no schema changes
- **3F (skill recipes):** patch bump if the build copies skill assets (it does), otherwise doc-only

---

## Critical files reference

| File | Role | Status |
|---|---|---|
| `packages/contracts/src/agent-tasks.ts` | DTOs, enums, request/response schemas | new |
| `packages/contracts/src/errors.ts` | Add `taskAlreadyClaimed`, `taskInvalidTransition`, `taskStaleClaim` factories | extend |
| `packages/contracts/src/index.ts` | Re-export `agent-tasks` | extend |
| `packages/db/src/schema.ts` | `agentTasks` table definition | extend |
| `packages/db/src/migrate.ts` | New migration entry for `agent_tasks` | extend |
| `packages/api-routes/src/agent-tasks.ts` | Routes: dispatch, list, get, claim, callback, cancel, status | new |
| `packages/api-routes/src/index.ts` | Register `agentTasksRoutes`, add `dispatchAgentTask` to `ApiRoutesOptions` | extend |
| `packages/canonry/src/server.ts` | Implement `dispatchAgentTask` callback (POST to OpenClaw webhook plugin) | extend |
| `packages/canonry/src/client.ts` | Typed `ApiClient` methods for the new endpoints | extend |
| `packages/canonry/src/commands/agent.ts` (or new `agent-task.ts`) | `agentTaskDispatch`, `agentTaskList`, `agentTaskGet`, `agentTaskCancel`, extend `agentStatus` | extend |
| `packages/canonry/src/cli-commands/agent.ts` | Add new subcommands to `AGENT_CLI_COMMANDS` | extend |
| `packages/canonry/src/agent-bootstrap.ts` | `installWebhookPluginRoute` helper | extend |
| `packages/canonry/src/config.ts` | Add `webhookSecret` to `AgentConfigEntry` | extend |
| `packages/canonry/test/agent-tasks.test.ts` | Unit tests: state machine, claim race, callback auth, dispatch fallback | new |
| `packages/canonry/test/agent-bootstrap.test.ts` | Test `installWebhookPluginRoute` config writes | extend |
| `assets/agent-workspace/skills/aero/references/canonry-callback-protocol.md` | Wire-protocol doc for the skill | new |
| `assets/agent-workspace/skills/aero/references/orchestration.md` | Add canonry-dispatched task workflow recipe | extend |
| `assets/agent-workspace/skills/aero/references/regression-playbook.md` | Canonry-specific result shape | extend |
| `assets/agent-workspace/skills/aero/SKILL.md` | Note callback protocol v1 support | extend |
| `apps/web/src/api.ts` | Add task API client functions | extend |
| `apps/web/src/components/agent/InsightActions.tsx` | Action button bar for insight cards | new |
| `apps/web/src/components/agent/useAgentStatus.ts` | Hook polling agent status | new |
| `apps/web/src/components/agent/useAgentTasks.ts` | Hook fetching task list with filters | new |
| `apps/web/src/components/agent/useTaskStatus.ts` | Hook for single-task polling | new |
| `apps/web/src/components/agent/TaskQueue.tsx` | Task list table | new |
| `apps/web/src/components/agent/TaskRow.tsx` | Single row | new |
| `apps/web/src/components/agent/TaskDetail.tsx` | Expanded task view with result/logs | new |
| `apps/web/src/components/agent/CommandPalette.tsx` | Cmd+K overlay | new |
| `apps/web/src/components/agent/CommandSuggestions.tsx` | Context-aware suggestions | new |
| `apps/web/src/components/agent/useCommandPalette.ts` | Keyboard shortcut + dispatch logic | new |
| `apps/web/src/pages/TasksPage.tsx` | Task queue page | new |
| `apps/web/src/pages/ProjectPage.tsx` | Wire `InsightActions` into existing insight feed | extend |
| `apps/web/src/components/Sidebar.tsx` (or wherever sidebar lives) | Health-score dots per project, Tasks page entry | extend |
| `apps/web/src/components/Topbar.tsx` (or wherever topbar lives) | Aero status pill | extend |
| `apps/web/test/agent/*.test.ts` | Component tests for task queue, insight actions, palette | new |
| `docs/data-model.md` | Add `agent_tasks` to ER diagram and table groups | extend |
| `packages/api-routes/AGENTS.md` | Add `agent-tasks.ts` to key files table | extend |
| `packages/canonry/AGENTS.md` | Add agent task CLI commands | extend |
| `AGENTS.md` (root) | Add agent task family to commands section, document callback protocol briefly | extend |
| `skills/canonry-setup/references/canonry-cli.md` | Document new CLI commands | extend |
