# Agent Conversation Plan (Phase 3 of OpenClaw Agent Layer)

## Context

This plan supersedes [`plans/agent-tasks.md`](./agent-tasks.md). After investigating OpenClaw's source — specifically `src/gateway/openai-http.ts`, `src/gateway/server-chat.ts`, `src/gateway/server-session-events.ts`, `src/routing/session-key.ts`, and `src/config/zod-schema.session.ts` — the architecture for Phase 3 changes shape entirely. The previous plan modeled the dashboard as a **task control panel**: insight buttons that POSTed to a `agent_tasks` REST queue, a separate task-queue page, a Cmd+K palette, a per-task callback protocol mediated by a custom Aero skill. That architecture would have built a parallel paradigm to the user's existing chat-driven workflow (Telegram), forcing dual mental models and breaking the one-conversation-anywhere experience the user values.

The new architecture treats **the dashboard as just another OpenClaw chat surface** — peer to Telegram, Discord, Slack, Signal, Feishu, iMessage, Matrix, MS Teams, and every other adapter OpenClaw supports. All chat surfaces share the same Aero session. The user has one conversation with one Aero, accessible from whichever surface they happen to be on. The dashboard is a thin chat UI backed by OpenClaw's existing OpenAI-compatible chat completions endpoint and the WebSocket session-event subscription mechanism. No new task table. No new dispatch protocol. No new callback semantics. The plumbing is `POST /v1/chat/completions` for outbound and a WS subscription for inbound, both with the same session key.

The seamlessness property the user wanted to preserve — *"wherever I am, it's the same Aero"* — generalizes naturally because OpenClaw was built for it. We just have to use the primitives correctly.

---

## Architectural principle

> **Aero is a channel-aware conversational entity. The dashboard is one of its channels.**

All five properties of the existing Telegram experience are preserved:

1. **One place at a time** — wherever you happen to be is the conversation
2. **Conversational** — natural language, with clarification, push-back, refinement
3. **Proactive** — when work finishes, Aero reaches out *in the channel where it makes sense*
4. **Stateful per user** — Aero knows you and the conversation has full history
5. **Async-aware** — fire-and-forget, with channel-routed callbacks

These are not features we have to build. They are properties of OpenClaw's existing session model, applied uniformly to every channel adapter. By configuring canonry's web dashboard as another channel adapter (specifically: a webchat surface that drives OpenClaw's chat completions endpoint with a stable session key), we inherit them.

---

## The universal session model

OpenClaw resolves session keys uniformly across every chat surface. The canonical format is `agent:<agentId>:<rest>` where `<rest>` is determined by the `session.dmScope` configuration. Verified in `src/config/zod-schema.session.ts:30-38`:

```typescript
dmScope: z.union([
  z.literal("main"),                       // all DMs → agent:<id>:main  (default)
  z.literal("per-peer"),                   // agent:<id>:direct:<peerId>
  z.literal("per-channel-peer"),           // agent:<id>:<channel>:direct:<peerId>
  z.literal("per-account-channel-peer"),   // agent:<id>:<channel>:<accountId>:direct:<peerId>
]).optional(),
identityLinks: z.record(z.string(), z.array(z.string())).optional(),
```

Group chats and topics get their own session keys (`agent:<id>:<channel>:group:<peerId>`) regardless of `dmScope` — this is fine, group conversations are inherently scoped to the group.

### Single-user canonry (the default path)

Set `session.dmScope: "main"` in OpenClaw's profile config. Every chat adapter — including canonry's web dashboard — routes to `agent:<agentId>:main` (typically `agent:aero:main` since canonry uses the `aero` profile). One Aero, one transcript, one set of in-flight tasks visible from any surface.

This is the configuration the rest of this plan assumes.

### Multi-user canonry (future extension)

When canonry grows multi-tenancy (cloud deployments, team installs), each canonry user gets their own Aero session. Two viable approaches:

1. **Per-user `dmScope`:** set `session.dmScope: "per-peer"` and use `session.identityLinks` to map "Telegram user X = Slack user Y = canonry user Z" so the same person sees one conversation across surfaces. Requires identity linking config per user.
2. **Canonry-derived session keys:** canonry's API computes session keys as `agent:<agentId>:canonry-user:<userId>` and uses that key when proxying to OpenClaw. Other chat adapters need to be configured to map their per-user identity to the canonry user ID via `identityLinks`. Slightly more involved at setup time but avoids relying on adapter-specific peer IDs.

Multi-user is **explicitly out of scope** for this plan but the architecture leaves the door open. The session key resolution helper (described below) is the only place we'd need to change to support it.

---

## The wire contract (what the dashboard does, end to end)

This section is the source of truth. Update it first when the protocol changes; everything else derives from it.

### Outbound: dashboard sends a message to Aero

```
User types in dashboard chat panel
            │
            │  POST /api/v1/agent/chat
            │  Authorization: Bearer cnry_...           (canonry API key)
            │  Content-Type: application/json
            │  {
            │    "message": "Investigate the roof-coating regression on az-coatings",
            │    "context": {
            │      "page": "/projects/az-coatings",
            │      "insightId": "ins_abc123",            (optional, when launched from an insight)
            │      "runId": "run_xyz789"                 (optional, when scoped to a specific run)
            │    },
            │    "stream": true
            │  }
            ▼
Canonry API route /api/v1/agent/chat
            │
            │  - Resolves the session key for the current user
            │    (single-user: hardcoded "agent:aero:main")
            │  - Builds the OpenAI messages array, optionally injecting
            │    a system message with the page context
            │  - Forwards to OpenClaw with the gateway token
            │
            │  POST http://localhost:<gatewayPort>/v1/chat/completions
            │  Authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}
            │  x-openclaw-session-key: agent:aero:main
            │  x-openclaw-message-channel: webchat
            │  Content-Type: application/json
            │  {
            │    "model": "openclaw",
            │    "messages": [
            │      { "role": "system", "content": "User is on /projects/az-coatings" },
            │      { "role": "user",   "content": "Investigate the roof-coating regression on az-coatings" }
            │    ],
            │    "stream": true
            │  }
            ▼
OpenClaw's chat completions handler
            │
            │  - Resolves session via x-openclaw-session-key header (verbatim, no transformation)
            │  - Runs the agent loop in agent:aero:main session — full tool access
            │    (canonry CLI, fetch, search console, etc.)
            │  - Streams SSE events back to canonry as the agent reasons,
            │    calls tools, and produces output
            │
            │  data: {"choices":[{"delta":{"content":"Looking up..."}}]}
            │  data: {"choices":[{"delta":{"content":" the recent runs..."}}]}
            │  ...
            │  data: [DONE]
            ▼
Canonry forwards SSE events back to the dashboard verbatim (or transformed
into a canonry-flavored event stream — see "Streaming protocol" below)
            │
            ▼
Dashboard chat panel renders streaming text in real time
```

### Inbound: dashboard receives all session events (proactive Aero messages)

```
Dashboard chat panel mounts
            │
            │  WebSocket: /api/v1/agent/events?session=current
            │  Authorization: query param `?token=cnry_...` or upgrade header
            ▼
Canonry WS endpoint
            │
            │  - Resolves session key for current user
            │  - Opens a WS to OpenClaw subscribed to that session key
            │
            │  WebSocket: ws://localhost:<gatewayPort>/<openclaw-ws-path>
            │  with x-openclaw-token: ${OPENCLAW_GATEWAY_TOKEN}
            │  on connect: { "type": "subscribe", "sessionKey": "agent:aero:main" }
            ▼
OpenClaw's SessionMessageSubscriberRegistry registers the connection
            │
            │  On ANY transcript update in agent:aero:main —
            │    - User sent a message via Telegram
            │    - Aero replied to a Telegram message
            │    - User sent a message via the dashboard (different tab)
            │    - Aero generated an autonomous turn from a webhook trigger
            │      (e.g., run.completed fired, Aero decided to ping the user)
            │    - Cron job result delivered into the session
            │  ...the broadcast handler in src/gateway/server-session-events.ts
            │  pushes the event to every subscribed connection
            │
            ▼
Canonry forwards the event to the dashboard WS connection
            │
            ▼
Dashboard chat panel renders the new message in the conversation
```

### What the dashboard does NOT need to do

- **Maintain its own task list.** OpenClaw's session transcript IS the task history. Filter/render it as needed.
- **Atomically claim work.** The chat completion is single-tenant per request; OpenClaw handles concurrency.
- **Implement a state machine.** OpenClaw's task-flow registry handles flow lifecycle. The dashboard just renders messages.
- **Authenticate per-task.** The canonry API key is the auth boundary for the dashboard ↔ canonry hop; the gateway token is the boundary for the canonry ↔ OpenClaw hop.

---

## What canonry needs to build

### 1. `POST /api/v1/agent/chat` — the outbound proxy

`packages/api-routes/src/agent-chat.ts`. A thin proxy that:

1. Validates the request body against a Zod schema (`message`, optional `context`, `stream`)
2. Resolves the session key (single-user mode → constant from `config.agent.sessionKey ?? "agent:aero:main"`)
3. Builds the OpenAI messages array. If `context.page` or `context.insightId` etc. are set, prepends a system message: `"User is currently on {page}. Insight context: {summary}. Run context: {runId}."` This gives Aero situational awareness without forcing the user to type it.
4. POSTs to `http://localhost:<gatewayPort>/v1/chat/completions` with:
   - `Authorization: Bearer ${config.agent.gatewayToken}`
   - `x-openclaw-session-key: <resolved key>`
   - `x-openclaw-message-channel: webchat`
5. If `stream: true`: forwards the SSE event stream back to the dashboard verbatim (or wraps in a canonry envelope — see "Streaming protocol" below)
6. If `stream: false`: awaits the full response and returns it as a single JSON object

**Auth:** standard canonry API key. The dashboard authenticates as the same user as any other API consumer.

**Error handling:** if OpenClaw is offline, return `503 Service Unavailable` with a structured error and a hint to start the gateway. If the chat completion errors out (model rate limit, tool failure, etc.), forward the error in the SSE stream so the dashboard can render it inline.

### 2. `WS /api/v1/agent/events` — the inbound subscription proxy

`packages/api-routes/src/agent-events.ts`. A WebSocket endpoint that:

1. Authenticates on upgrade via the canonry API key (query param or upgrade header — same pattern as future agent-task WS would have used)
2. Resolves the session key for the user
3. Opens a downstream WebSocket to OpenClaw subscribed to that session key
4. Forwards every event from OpenClaw → dashboard
5. Handles disconnects on either side gracefully (canonry auto-reconnects to OpenClaw if it drops; dashboard auto-reconnects to canonry)

**This is the only place we need `@fastify/websocket` as a dependency.** Add it conditionally — only when `agent.autoStart` is true or when an explicit `agent.exposeChat` flag is set — so non-agent canonry deployments don't pull WS plumbing they don't need.

**Note:** the exact OpenClaw WS endpoint and subscribe message format are in `src/gateway/server-chat.ts:243-365`. The implementation lives in OpenClaw's `SessionMessageSubscriberRegistry`. We need to look at how OpenClaw's own web UI talks to the gateway WS to learn the upgrade path and message envelope. This is **Open Question 1 below.**

### 3. Session key resolution helper

`packages/canonry/src/agent-session.ts` (new file). A small utility:

```typescript
export function resolveAgentSessionKey(config: CanonryConfig, request: AuthenticatedRequest): string {
  // Single-user mode: configurable, defaults to agent:aero:main
  return config.agent?.sessionKey ?? `agent:${config.agent?.profile ?? 'aero'}:main`
}
```

When canonry adds multi-user, this function grows a `request.user` lookup. For now it's a constant. Centralizing it means the multi-user upgrade is one file change.

### 4. Streaming protocol — pass-through OpenAI SSE vs. canonry envelope

Two options:

**A. Pass-through (simplest)** — canonry forwards OpenAI SSE events verbatim. The dashboard parses the same OpenAI streaming format as any OpenAI client. Pros: zero translation overhead, dashboard can use any standard OpenAI streaming library. Cons: leaks OpenClaw's API surface to the dashboard; if OpenClaw's response format ever drifts from OpenAI compat, the dashboard breaks.

**B. Canonry envelope** — canonry wraps OpenAI deltas in a canonry-flavored event stream, e.g. `event: agent.message.delta\ndata: {"text":"...","sessionKey":"..."}\n\n`. Pros: canonry can mix in canonry-specific events (run progress, intelligence updates, dispatch failures) on the same stream. Cons: more code, custom client parser needed.

**Recommendation: A for v1, with an eye toward B once we know what canonry-specific events are worth multiplexing.** Start by passing through OpenAI deltas. If we later want to inject e.g. "a sweep just finished, insights updated" into the same stream, refactor to B.

### 5. Dashboard chat panel component

`apps/web/src/components/agent/ChatPanel.tsx`. A persistent chat surface, rendered in the dashboard layout (sidebar, bottom drawer, or full panel — design TBD; reference the AGENTS.md UI design system for conventions).

Responsibilities:
- Maintain a local message buffer for the current session
- On mount, fetch the recent transcript via `GET /api/v1/agent/transcript?limit=50` (new endpoint — fetches recent messages from the OpenClaw session via a session-history call)
- Open a WebSocket connection to `/api/v1/agent/events` and listen for new messages
- On user input, POST to `/api/v1/agent/chat` with `stream: true`, render incoming SSE deltas in real time
- Pass `context` based on the current route (e.g. `{page: "/projects/az-coatings", projectName: "az-coatings"}`)
- Handle reconnection, message ordering, missed-event recovery (on reconnect, fetch any messages newer than the last seen ID)

**Sub-components:**
- `ChatMessage.tsx` — renders one message (user or assistant), supports markdown, code blocks, tool-use blocks, and inline images
- `ChatInput.tsx` — textarea + send button, supports Cmd/Ctrl+Enter to send
- `ChatToolUse.tsx` — collapsible block showing a tool call and its result (so users can see when Aero called the canonry CLI, fetched a URL, etc.)
- `useAgentChat.ts` — hook that owns the message buffer, stream state, and WS connection
- `useAgentSessionTranscript.ts` — hook that fetches the recent transcript on mount

**Cmd+K becomes "focus the chat input."** Pressing Cmd+K from anywhere in the dashboard scrolls the chat panel into view (or expands it from a collapsed state) and focuses the input. No separate palette overlay.

### 6. Insight cards: action buttons compose messages

Modify `apps/web/src/components/InsightSignals.tsx` (or wherever the existing insight cards live — currently inline in `ProjectPage.tsx:907`). For each insight, render action buttons that compose a structured message and send it to the chat panel:

```typescript
function InsightActions({ insight, project }: Props) {
  const { sendMessage } = useAgentChat()
  return (
    <div className="flex gap-2">
      {insight.type === 'regression' && (
        <button onClick={() => sendMessage({
          message: `Investigate this regression: "${insight.keyword}" lost on ${insight.provider}`,
          context: { insightId: insight.id, runId: insight.runId, page: location.pathname },
        })}>
          Investigate
        </button>
      )}
      {/* ... other action buttons ... */}
      <button onClick={() => dismissInsight(insight.id)}>Dismiss</button>
    </div>
  )
}
```

The action buttons are syntactic sugar over "send a message to Aero on the dashboard channel." The user gets the same result whether they click the button or type "investigate this regression on roof-coating" into the chat input. The Aero session sees both as user messages and responds the same way.

### 7. Existing dashboard surfaces stay as data visualization

Project pages, run history, snapshots, intelligence drill-downs, schedule editor, settings — none of these change. They're data viz surfaces; the chat panel is the agent surface. They coexist on the same page.

### 8. `canonry agent setup` additions

Phase 2 already does 8 setup steps after this branch's bulk-attach work. Phase 3 adds 2 more, between step 5 (configure LLM) and step 6 (seed workspace):

```typescript
// 5b. Generate gateway token for canonry → OpenClaw chat completions + WS
const gatewayToken = `oc_gw_${crypto.randomBytes(32).toString('hex')}`
writeAgentEnv(stateDir, 'OPENCLAW_GATEWAY_TOKEN', gatewayToken)

// 5c. Configure OpenClaw gateway auth + dmScope
configureOpenClawGatewayAuth(detection.path!, profile, {
  mode: 'token',
  tokenEnvVar: 'OPENCLAW_GATEWAY_TOKEN',
})
configureOpenClawSessionScope(detection.path!, profile, {
  dmScope: 'main',  // single-user: all DMs share agent:<id>:main
})

// 5d. Save gateway token in canonry config
saveConfigPatch({
  agent: {
    ...existingAgentConfig,
    gatewayToken,
    sessionKey: `agent:${profile}:main`,
  },
})
```

`configureOpenClawGatewayAuth` and `configureOpenClawSessionScope` are new helpers in `agent-bootstrap.ts` that run:

```bash
openclaw config set gateway.auth.mode "token"
openclaw config set gateway.auth.token "\${OPENCLAW_GATEWAY_TOKEN}"
openclaw config set session.dmScope "main"
```

(All `openclaw config set` invocations honor the existing `OPENCLAW_PROFILE=aero` env-var-based profile resolution — same pattern as the rest of Phase 2's setup helpers.)

**Add to `CanonryConfig.agent`:**

```typescript
interface AgentConfigEntry {
  // ...existing fields...
  gatewayToken?: string  // for canonry → openclaw chat completions + WS
  sessionKey?: string    // session to route dashboard messages to (single-user: constant)
}
```

The Phase 2 webhook plugin route is **NOT removed** by this plan. It still serves its purpose: canonry's `RunCoordinator` POSTs `insight.critical` / `run.completed` events to OpenClaw via the webhook plugin so Aero can react proactively. With the chat-channel architecture, those proactive reactions surface in any subscribed channel including the dashboard. The webhook route handles canonry → Aero notifications; the chat completions endpoint handles dashboard → Aero requests; the WS subscription handles Aero → dashboard delivery. Three separate channels, all working together.

---

## What collapses out of the previous plan

`plans/agent-tasks.md` listed dozens of files and primitives. Most of them disappear:

- ❌ `agent_tasks` table + migration
- ❌ `packages/contracts/src/agent-tasks.ts` (DTOs, state enums, dispatch/callback schemas)
- ❌ `packages/api-routes/src/agent-tasks.ts` (POST /agent/tasks, GET /agent/tasks, /claim, /callback, /cancel)
- ❌ Per-task callback tokens, dual-mode auth on the callback endpoint
- ❌ State machine validation table, `cancel_requested_at`, `dispatch_attempts`
- ❌ `dispatchAgentTask` callback in `ApiRoutesOptions`
- ❌ `installWebhookPluginRoute` for canonry-as-task-queue (the existing Phase 2 webhook plugin route stays, but no task-queue-specific route is added)
- ❌ `assets/agent-workspace/skills/aero/references/canonry-callback-protocol.md`
- ❌ `taskAlreadyClaimed`, `taskInvalidTransition`, `taskStaleClaim` error factories
- ❌ Insight action buttons as POSTs to a task queue
- ❌ Cmd+K palette as a separate overlay
- ❌ TaskQueue / TaskRow / TaskDetail components
- ❌ `useAgentTasks`, `useTaskStatus` hooks
- ❌ `TasksPage.tsx`
- ❌ `canonry agent task dispatch | list | get | cancel | watch` CLI commands as a queue interface

That's roughly half the file list from the previous plan.

## What stays from the previous plan

- The **Phase 2 webhook plugin route** (`/plugins/webhooks/canonry`) and its existing `insight.critical` / `insight.high` / `run.completed` event flow. This is how canonry tells Aero "something happened in the background" so Aero can decide whether to surface a proactive message.
- The **`canonry run --no-wait` CLI fix** is still needed regardless of architecture — Aero calls the canonry CLI as a tool, and a non-blocking `canonry run` is a real bug fix unrelated to dashboard model. Same for any other `pollRun()`-using CLI command.
- The **Aero skill async-task-tracking memory pattern** — when Aero kicks off a long-running canonry operation (with `--no-wait`), it still needs to remember "I dispatched run R-123 on behalf of this conversation" so when the `run.completed` webhook fires, it can compose a proactive followup message. This belongs in `assets/agent-workspace/skills/aero/references/async-task-tracking.md`.
- **Aero skill orchestration recipes** (regression playbook, audit, analyze, monitor, report, fix) — these describe *what Aero does*, not *how it's invoked*. They don't change.
- **`canonry agent task ...` CLI commands** (in a much smaller form): `dispatch` / `list` / `get` / `cancel` are gone, but `canonry agent chat <message>` could be a useful CLI shortcut for terminal-first users — POST a message to the agent chat endpoint and stream the reply to stdout. Optional, defer to a follow-up.

---

## Open questions to resolve at implementation time

These are small enough that they don't block planning, but each needs a 15-30 minute spike before the relevant code lands.

### Q1. OpenClaw WebSocket subscription path and protocol

`SessionMessageSubscriberRegistry` (`src/gateway/server-chat.ts:243-365`) clearly supports per-session WS subscriptions. We need to know:

- The exact WebSocket upgrade path on OpenClaw's gateway (`/ws`? `/api/ws`? `/v1/events`?)
- The subscribe message format (probably JSON: `{ "type": "subscribe", "sessionKey": "..." }`)
- The event payload format (what fields, what types — probably mirrors `SessionTranscriptUpdate`)
- Auth: same gateway token via header? Query param?

**How to resolve:** read OpenClaw's own web UI (`apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatTransport.swift` was in the search results, suggesting there's a chat transport implementation we can reference) or trace `connectControlUiWebSocket` / similar in the gateway server code. Worst case, run OpenClaw locally and inspect the WS traffic from its built-in web UI.

**Risk if wrong:** the dashboard can't receive proactive messages or other-channel updates in real time. Mitigation: poll a `GET /api/v1/agent/transcript?since=<lastSeen>` endpoint every 2-3s as a fallback. Less elegant but functional.

### Q2. Recent transcript fetch endpoint

The chat panel needs to fetch the last N messages on mount so the user sees their existing conversation, not an empty box. OpenClaw stores transcripts at `~/.openclaw-aero/agents/<agentId>/sessions/<sessionId>/transcript.jsonl` (per `src/config/sessions/transcript.ts`). We need either:

- An OpenClaw HTTP endpoint that returns a session's recent messages (possibly `sessions-history-http.ts` from the search results)
- Or canonry reads the transcript file directly from disk (works only when canonry and OpenClaw share a host, which is the standard local case)

**How to resolve:** look at `src/gateway/sessions-history-http.ts` to see if it exposes a "list recent messages for a session" endpoint. If yes, canonry's `GET /api/v1/agent/transcript` proxies to it. If no, canonry reads `~/.openclaw-aero/agents/<profile>/sessions/<sessionId>/transcript.jsonl` directly — but it needs to know which `sessionId` to read for a given session key, which means looking at OpenClaw's session store format.

**Risk if wrong:** chat panel starts empty on every page load, which is bad UX. Worst case fallback: maintain a local message cache in canonry's DB that mirrors what comes through the WS subscription, and serve it from a canonry-side endpoint. This adds duplication but is fully under our control.

### Q3. `messageChannel: "webchat"` and channel-bound tools

The chat completions handler defaults `messageChannel: "webchat"` (`openai-http.ts:537`). This affects which channel-bound tools Aero can use during the request (e.g., `telegram_send_message` is only available when the channel is `telegram`).

We need to confirm:
- Aero doesn't accidentally try to call channel tools that don't exist on the `webchat` surface
- If Aero needs to send a proactive followup later (after a webhook trigger), it can do so without the dashboard being the active surface — i.e., the proactive reply should reach whichever channel(s) the user is currently active on, not just `webchat`

**How to resolve:** read the Aero skill's tool list in `assets/agent-workspace/skills/aero/SKILL.md` and confirm it doesn't hardcode a specific channel. The skill should use a `send_in_current_session` or `respond_to_user` abstraction, not `telegram_send_message`. If it uses channel-specific tools, refactor the skill.

**Risk if wrong:** Aero responds via `webchat` only, even when the user originally asked from Telegram and isn't looking at the dashboard. The user feels Aero "lost" the conversation.

---

## Verification plan

### Phase 3.0 — Backend plumbing

1. `pnpm typecheck && pnpm lint && pnpm test` — clean
2. `canonry agent setup --install` produces a working OpenClaw config with `gateway.auth.mode = token`, `gateway.auth.token = ${OPENCLAW_GATEWAY_TOKEN}`, `session.dmScope = main`, and a generated token persisted to both OpenClaw's `.env` and canonry's `config.yaml`
3. `curl -X POST http://localhost:4100/api/v1/agent/chat -H "Authorization: Bearer cnry_..." -d '{"message":"hello","stream":false}'` returns Aero's reply
4. With OpenClaw stopped: same curl returns 503 with a clear error
5. `wscat -c ws://localhost:4100/api/v1/agent/events?token=cnry_...` connects, receives session events when messages are sent via curl in another terminal
6. From a Telegram conversation, send a message to the bot. The dashboard WS connection receives the same transcript update.
7. Trigger `insight.critical` via the existing webhook flow (Phase 2). If Aero's skill produces a proactive message in response, the dashboard WS receives it.

### Phase 3.1 — Frontend chat panel

8. Open the dashboard. Chat panel renders, fetches recent transcript, shows the conversation history that exists in `agent:aero:main` (whether messages came from Telegram, the dashboard, or anywhere else).
9. Type a message in the chat input. Streaming reply renders token-by-token in real time.
10. Open the same dashboard in a second browser tab. Type a message in tab 1. Tab 2's chat panel receives the message via WS in real time.
11. Click an insight action button. The composed message appears in the chat input area, gets sent automatically, response streams back.
12. Press Cmd+K from anywhere in the dashboard. Chat panel scrolls into view, input is focused.
13. Send a message that requires a long-running tool call (e.g., "run a sweep on az-coatings"). Aero replies "Started sweep R-..., I'll let you know when it's done." Some minutes later, the `run.completed` webhook fires, Aero generates a proactive message, the dashboard WS receives it and renders it inline.

### Phase 3.2 — Cross-channel parity (the main test)

14. Set up a Telegram bot bound to `agent:aero:main`. Send a message from Telegram. Dashboard receives the user message and Aero's reply via WS.
15. Send a message from the dashboard. Telegram client receives the new turn (verify by manual inspection of the Telegram chat).
16. Continue a conversation alternately on Telegram and dashboard for several turns. Aero's memory of the conversation is consistent across both surfaces.
17. Disconnect from the dashboard, send several messages from Telegram, reconnect. Dashboard catches up with the missed messages on reconnect (transcript fetch + WS resume).

### Phase 3.3 — End-to-end with all the existing surfaces

18. Repeat the Telegram parity test with at least one other channel adapter (Discord or Slack — whichever is easiest to set up). Confirm three surfaces (Telegram + Discord + dashboard) all share the same conversation.

---

## Phasing and parallelization

```
3.0  Backend
  3.0a  Q1 spike: OpenClaw WS path + protocol                              ┐
  3.0b  Q2 spike: transcript fetch mechanism                               ┤  Parallel
  3.0c  Q3 spike: skill tool-channel bindings                              ┘
  3.0d  POST /api/v1/agent/chat proxy                                      ┐
  3.0e  WS /api/v1/agent/events proxy                                      ┤  Sequential after spikes
  3.0f  GET /api/v1/agent/transcript endpoint                              ┘
  3.0g  Session key resolver helper
  3.0h  agent-bootstrap helpers: configureOpenClawGatewayAuth + Scope
  3.0i  agent-setup wiring: token gen, config.yaml persistence
  3.0j  Tests for proxy, WS, transcript, session resolver
─────────────────────────────────────────────────────────
3.1  Frontend (depends on 3.0d-3.0f)
  3.1a  ChatPanel + sub-components (ChatMessage, ChatInput, ChatToolUse)
  3.1b  useAgentChat + useAgentSessionTranscript hooks
  3.1c  WS connection + reconnect handling
  3.1d  Layout integration (sidebar/drawer/full panel — design first)
  3.1e  Cmd+K binding (focus chat input, not separate overlay)
  3.1f  InsightActions component refactored to compose messages
  3.1g  Component tests
─────────────────────────────────────────────────────────
3.2  Skill polish (parallel with 3.1)
  3.2a  Async-task-tracking memory pattern doc
  3.2b  Verify no channel-specific hard-coded tools in the skill
  3.2c  canonry run --no-wait CLI fix (orthogonal but small)
─────────────────────────────────────────────────────────
3.3  Docs
  3.3a  AGENTS.md updates (root, packages/canonry, packages/api-routes)
  3.3b  skills/canonry-setup/references/canonry-cli.md (chat endpoint, agent commands)
  3.3c  Setup guide: how to bind multiple channels to the same Aero session
─────────────────────────────────────────────────────────
3.4  End-to-end verification
```

**Hard ordering:**
- 3.0a, 3.0b, 3.0c (the three spikes) before any backend code — they determine the API shapes
- 3.0d-3.0f before any 3.1 work — frontend depends on the proxy endpoints existing
- 3.2 can run fully in parallel with 3.1 (different files, no dependencies)
- 3.4 is the gate before merge

**Critical-path effort:** the spikes are short (15-30 min each) but must come first. Backend is 3-5 small files. Frontend is the largest piece but well-scoped (chat panel is a known UX pattern, lots of references to crib from). Skill work is markdown.

---

## Versioning

- **3.0 PR (backend):** minor bump (e.g., 1.48.0 → 1.49.0) — new feature: agent chat proxy, WS subscription, dashboard channel
- **3.1 PR (frontend):** patch bump (1.49.x) — UI feature, no schema or contract changes
- **3.2 PR (skill + CLI):** patch bump if it touches code; doc-only otherwise

---

## Multi-user extension (out of scope but architecturally clear)

When canonry adds multi-tenancy, this architecture extends without reshaping:

1. `resolveAgentSessionKey()` looks up the authenticated user from the request and returns `agent:<agentId>:canonry-user:<userId>` (or whatever scoping rule the multi-user model adopts).
2. OpenClaw's `session.dmScope` switches to `per-peer` (or `per-channel-peer` if users have multiple chat surfaces).
3. `session.identityLinks` maps each canonry user's external chat identities (Telegram user ID, Slack user ID, etc.) to their canonry user ID, so cross-channel sharing still works.
4. Each canonry user authenticates to the dashboard with their own canonry API key. Canonry's proxy uses one shared OpenClaw gateway token (since OpenClaw is single-tenant), but resolves the per-user session key before forwarding.

The only file that knows about user identity in single-user mode is `agent-session.ts`. Multi-user touches that file plus the auth middleware that populates `request.user`. Everything else stays the same.

---

## Critical files reference

| File | Role | Status |
|---|---|---|
| `packages/api-routes/src/agent-chat.ts` | POST /api/v1/agent/chat — proxy to OpenClaw chat completions | new |
| `packages/api-routes/src/agent-events.ts` | WS /api/v1/agent/events — proxy to OpenClaw session subscription | new |
| `packages/api-routes/src/agent-transcript.ts` | GET /api/v1/agent/transcript — fetch recent messages on chat panel mount | new |
| `packages/api-routes/src/index.ts` | Register the three new routes (conditionally on agent enabled) | extend |
| `packages/api-routes/package.json` | Add `@fastify/websocket` dep (conditional registration) | extend |
| `packages/canonry/src/agent-session.ts` | Session key resolver helper | new |
| `packages/canonry/src/agent-bootstrap.ts` | `configureOpenClawGatewayAuth`, `configureOpenClawSessionScope` helpers | extend |
| `packages/canonry/src/commands/agent.ts` | Setup steps 5b–5d: gateway token gen, gateway/session config, persist to config.yaml | extend |
| `packages/canonry/src/config.ts` | Add `gatewayToken`, `sessionKey` to `AgentConfigEntry` | extend |
| `packages/canonry/src/server.ts` | Pass new agent config through to api-routes for the chat proxy | extend |
| `packages/canonry/test/agent-chat.test.ts` | Unit tests: chat proxy, error handling, streaming forward | new |
| `packages/canonry/test/agent-events.test.ts` | Unit tests: WS subscription forwarding, reconnect | new |
| `packages/canonry/test/agent-bootstrap.test.ts` | Test new gateway/session config helpers | extend |
| `apps/web/src/components/agent/ChatPanel.tsx` | Persistent chat surface | new |
| `apps/web/src/components/agent/ChatMessage.tsx` | Single message render (markdown, code, tool-use) | new |
| `apps/web/src/components/agent/ChatInput.tsx` | Textarea + send | new |
| `apps/web/src/components/agent/ChatToolUse.tsx` | Collapsible tool call/result block | new |
| `apps/web/src/components/agent/InsightActions.tsx` | Action buttons that compose chat messages | new |
| `apps/web/src/components/agent/useAgentChat.ts` | Hook: message buffer, stream state, send + receive | new |
| `apps/web/src/components/agent/useAgentSessionTranscript.ts` | Hook: fetch recent transcript on mount | new |
| `apps/web/src/components/agent/useCmdK.ts` | Cmd+K → focus chat input | new |
| `apps/web/src/api.ts` | Add chat, events (WS factory), transcript API client functions | extend |
| `apps/web/src/pages/ProjectPage.tsx` | Wire `InsightActions` into existing insight feed | extend |
| `apps/web/src/components/Layout.tsx` (or wherever the layout is) | Mount `ChatPanel` in the dashboard layout | extend |
| `apps/web/test/agent/*.test.tsx` | Component tests for chat panel, message render, insight actions | new |
| `assets/agent-workspace/skills/aero/references/async-task-tracking.md` | When dispatching long-running canonry ops, remember initiator and channel for proactive followup | new |
| `assets/agent-workspace/skills/aero/references/orchestration.md` | Add the async-task-tracking pattern reference | extend |
| `assets/agent-workspace/skills/aero/SKILL.md` | Verify channel-agnostic tool usage; remove any hard-coded telegram_* etc. if found | review |
| `packages/canonry/src/commands/run.ts` | Add `--no-wait` flag, skip `pollRun` calls when set | extend |
| `packages/canonry/src/cli-commands.ts` | Document `--no-wait` flag in run command spec | extend |
| `packages/api-routes/AGENTS.md` | Document agent chat / events / transcript routes | extend |
| `packages/canonry/AGENTS.md` | Document new agent setup steps (token, session scope) | extend |
| `AGENTS.md` (root) | Add agent chat surface to commands section, document multi-channel binding | extend |
| `skills/canonry-setup/references/canonry-cli.md` | Document `canonry run --no-wait`, agent chat endpoint | extend |
