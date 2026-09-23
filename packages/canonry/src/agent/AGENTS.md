# Aero (built-in agent)

Canonry ships a built-in AI agent called **Aero**, built on
[`@mariozechner/pi-agent-core`](https://github.com/badlogic/pi-mono). Users
who already have their own agent (Claude Code, Codex, custom) can still
consume Canonry through the external-agent webhook.

## Built-in agent (native loop)

- **CLI**: `canonry agent ask <project> "<prompt>"` — one-shot turn. Streams
  `AgentEvent` lines to stdout (or JSON with `--format json`). Supports
  `--provider claude|openai|gemini|zai|deepinfra` and `--model <id>`. `zai` and
  `deepinfra` are agent-only; `deepinfra` is an OpenAI-compatible host outside
  pi-ai's catalog (`agent/providers.ts` builds a custom `openai-completions`
  model against `https://api.deepinfra.com/v1/openai`; key from `DEEPINFRA_TOKEN` or `providers.deepinfra.apiKey`,
  base URL overridable via `DEEPINFRA_BASE_URL` for proxy/LiteLLM-gateway routing).
  The agent tier is `deepseek-ai/DeepSeek-V4-Flash`; analyze and classify stay on
  `zai-org/GLM-5.2` (see "Model tiers and upgrades").
- **Dashboard**: bottom command bar (`AeroBar`) on every project-scoped
  route. SSE-streamed via `POST /api/v1/projects/:name/agent/prompt`.
- **Proactive**: `RunCoordinator` enqueues a synthesized `[system]` follow-up
  into the project's session after every `run.completed`; `SessionRegistry.drainNow`
  wakes the agent unprompted so insights/failures get analyzed without a
  user click.
- **Persistence**: one active `agent_sessions` row per project, with inactive
  conversations in `agent_conversations`. New/resume atomically archive the
  current transcript, model, and follow-ups; delete removes only that conversation
  and its compaction notes. Shared project notes survive. Migration 159 keeps the
  existing active transcript intact. Busy acquisition/streaming blocks switching.
  History routes live in `api-routes/agent-conversations.ts`, with injected runtime
  hooks. CLI: `agent conversations list|new|show|resume|delete`; MCP: the five
  `canonry_agent_conversations_*` tools. Native Aero excludes the three mutations
  so it cannot switch/delete its own context. See `docs/data-model.md`.
- **Memory**: durable project-scoped notes in `agent_memory` (key/value +
  source). Written via `remember` tool (or CLI / API), read via `recall`, and
  the N most-recent shared notes and active-conversation summaries are injected into the system prompt
  under a `<memory>` block so notes take effect immediately on next session.
  Hydrate is capped at 20 rows / 32 KB, oldest-first truncation. Keys with
  the `compaction:` prefix are reserved for summarized transcript slices.
- **Compaction**: once a transcript crosses `COMPACTION_TOKEN_THRESHOLD` or
  `COMPACTION_MAX_MESSAGES`, `acquireForTurn` awaits a one-shot summarizer
  (`pi-ai` `complete()` on the session's current model) that rolls the
  oldest half of the transcript into a `compaction:<sessionId>:<iso>`
  memory row, removes those messages from `agent.state.messages`, and
  rehydrates the system prompt so the next LLM call sees the summary in
  its `<memory>` block. Splits are snapped to user-message boundaries to
  avoid orphaning tool calls from their results. Concurrent compaction
  runs for the same project dedupe via an in-flight promise map.

## Current view and bounded execution

`runtime.ts` starts the default profile with authorized core tools, skill readers,
`aero_inspect_view`, and `aero_list_toolkits` / `aero_load_toolkit`. Loading a
kit updates the active pi context before the next model request. Rebuild the
catalog every turn, including permission downgrades; never preserve a loaded
write tool across a read-only turn. Remote read tools remain available.
The narrow `ads-operator` catalog stays eager.

`AgentPromptRequest` carries typed per-turn context and execution limits through
REST, CLI flags, and dashboard Copy as CLI. Resolve context through public API
reads before generation/compaction. Invalid identities must fail without silently
widening the selection. `view-context.ts` packs report/API evidence without
calculating metrics, preserves class denominators and missing states, and links
the selected evidence. Do not persist context into the system-prompt snapshot.

Default execution limits are 30 tool calls / 180 seconds; hard maxima are 100 /
600 seconds. Count attempted calls, including invalid ones. Abort stops future
calls; dispatched work may settle. SSE emits `aero_turn_status`; CLI and UI treat
missing `stream_close` as failure. Observe socket closure during acquisition too.
Transcript reads expose `isStreaming` so polling cannot erase live partial text.
Tool results persist small labels/durations, not full `details` payloads.

Tool surface:

- **Canonry state** (`src/agent/tools.ts` → `mcp-to-agent-tool.ts`) — every
  tool from `src/mcp/tool-registry.ts` minus the `AERO_EXCLUDED_MCP_TOOLS`
  set, adapted into pi-agent-core `AgentTool`s. The adapter strips the
  top-level `project` property from each tool's JSON schema and injects
  `ctx.projectName` at call time, so the LLM never sees raw project ids and
  cannot target the wrong project. Result: **adding a new tool to the MCP
  registry automatically makes it available to Aero — no second
  registration**. Tool intent surfaces via `tool_execution_start` events.
- **Skill docs** (`src/agent/skill-tools.ts`) — 2 tools (`list_skill_docs`,
  `read_skill_doc`) for progressive disclosure of bundled reference playbooks.
  These stay Aero-only because they read on-disk skill files, not API state.
  Ride in every scope. `SKILL.md` stays lightweight; detailed playbooks
  (workflows, regression diagnosis, reporting templates, integrations) load
  on-demand via slug. `portfolio-analysis` and `site-health` cover Simple and
  Advanced interpretation. `agent-operations` is generated from
  `docs/agent-operations/v1.md` by `pnpm guide:sync` and ships through the same
  skill-doc reader; built-in Aero does not expose external MCP help/load tools.
  The Aero-only framing is a preface added by the generator, not guide text, so
  external hosts reading the guide, `skills/canonry/SKILL.md`, or the MCP
  resource never see Aero internals.
- **Aero tool profiles** (`src/agent/tools.ts`) — the default profile progressively exposes
  the local MCP-derived tool surface for the requested scope. The
  `ads-operator` profile narrows local state tools to an explicit typed
  allow-list for ads reads, durable lifecycle writes, and prep, and prepends `canonry_ads_operator_context`, an
  Aero-only context-packing helper that composes existing project overview,
  ads, doctor, and memory reads through `ApiClient`. It does not expose a new
  capability outside Aero; promote it to API/CLI/MCP only if operators need
  that exact bundle as a public contract rather than as a long-session prompt
  optimization.
- **Injected remote MCP tools** (`src/agent/remote-mcp.ts`), read-only tools
  loaded from external MCP servers configured via `config.externalMcpServers`
  (or the `CANONRY_EXTERNAL_MCP` env var, a JSON array of `{ url, token, label? }`).
  Loaded once per `SessionRegistry` lifetime (cached promise) and merged into
  each session's tool list in `acquireForTurn`, after local-scope/profile
  alignment. This is intentional: profile narrowing applies to the local
  Canonry tools, while injected remote tools are separately accepted only when
  their MCP annotations mark them read-only.
  See "Injected remote-MCP load path" below for the frozen transport + filter.

## Injected remote-MCP load path (OSS-A)

Aero can load tools from a REMOTE, externally-hosted MCP server injected via
config/env. This is a generic capability, no host names, no domain logic.

- **Frozen transport (the contract a remote MCP server must speak):**
  **token-gated MCP Streamable HTTP**, `StreamableHTTPClientTransport` from
  `@modelcontextprotocol/sdk/client/streamableHttp.js`, with the bearer token
  carried in the transport's request headers (`Authorization: Bearer <token>`).
  SSE is legacy and is NOT used. The remote server is platform/external code,
  never co-located in the OSS container; the injected env carries only
  `{ url, token, label? }` and Aero connects out. Per-tenant isolation is the
  token's responsibility (scoped server-side), NOT the container boundary.
- **Read-only filter (always applied):** a remote tool is adopted ONLY when it
  is read-only, keyed off the MCP `annotations.readOnlyHint === true` flag -
  AND its name is not in `remote-mcp.ts`'s `AERO_EXCLUDED_MCP_TOOLS`. Write
  tools and excluded tools never reach Aero.
- **Resilience:** a server that fails to connect or list its tools is logged
  and skipped; one bad server never aborts the whole load. No servers
  configured returns `[]` (default path is byte-identical to today).
- **Config:** `CanonryConfig.externalMcpServers?: ExternalMcpServerConfig[]`
  (`config.ts`), parsed from `CANONRY_EXTERNAL_MCP` (env wins over config.yaml)
  by `parseExternalMcpEnv`. Malformed/non-array/entry-missing-url-or-token
  values are ignored fail-soft.
- **Seam:** `loadExternalMcpTools(servers, opts)` is the async load function.
  `createAeroSession` stays synchronous; the registry awaits the load in its
  already-async `acquireForTurn` and merges the returned tools into
  `agent.state.tools`. `opts.connect` is the test injection point (the
  InMemory transport replaces the production StreamableHTTP transport).

## Generic system-prompt append seam (OSS-D)

`appendSystemPromptExtras(base, env?)` (`session.ts`) appends
`AERO_SYSTEM_PROMPT_APPEND` (inline) and/or the contents of
`AERO_SYSTEM_PROMPT_FILE` (a mounted file path) AFTER the base soul+SKILL
prompt, separated by a divider. Empty by default => byte-identical. Generic, no
product vocabulary. It lives inside `loadAeroSystemPrompt`, so it covers BOTH
the one-shot `createAeroSession` default path and the registry (which builds on
`loadAeroSystemPrompt`, then layers the `<memory>` block AFTER, so the appended
rules frame the task and precede per-session memory). A `systemPromptOverride`
(tests / explicit full control) deliberately bypasses it. A missing/unreadable
file is skipped, never breaking the agent. The FILE variant exists so a multi-KB
prompt is mounted, not crammed into a single `-e` arg.

## Evidence-safe tool-result truncation (OSS-C)

`truncateToolResult` (`mcp-to-agent-tool.ts`) renders a tool result under the
20 KB cap WITHOUT cutting a row mid-structure. The previous guard blind-sliced
the serialized JSON, which could split an array element halfway (invalid JSON)
and silently drop a cited evidence row mid-object. Now: an object whose largest
field is an array drops WHOLE trailing rows and stamps `__truncated` +
`__omittedRows`; a top-level array is wrapped as `{ items, __truncated,
__omittedRows }`; only a giant scalar with nothing structured to drop falls back
to a marked string slice. Every retained row stays byte-intact; the programmatic
`details` envelope is never trimmed, only the model-facing text.

System prompt is composed from `skills/aero/soul.md` (identity/voice/values)
+ `skills/aero/SKILL.md` (task rules). Soul is prepended so identity frames
the task instructions. Both files ship in `assets/agent-workspace/skills/aero/`.
The `<memory>` hydrate block is appended at session-build time by
`SessionRegistry.buildHydratedSystemPrompt` — the DB row keeps the raw
(unhydrated) installed prompt snapshot. Cold hydration and idle
`acquireForTurn` adopt the current bundled skill plus configured prompt
appends without clearing the transcript, queued follow-ups, or durable notes.
Busy turns keep their existing prompt. Skill updates therefore do not require
operators to delete their conversations.

## Disabling Aero

This is the full kill switch. For an install that wants an agent it can ask but
never one that starts talking on its own, see "Prompt-only Aero" instead.

Aero is enabled by default. Set `agent.mode: 'disabled'` in
`~/.canonry/config.yaml` (or `CANONRY_AGENT_DISABLED=1` in the environment;
env wins, `=0` forces it back on) to turn the agent OFF entirely — the
proactive auto-wake on `run.completed`, the `SessionRegistry`, and the
interactive agent routes (`/projects/:name/agent/*`) + `canonry agent ask` are all skipped. `server.ts`
resolves this once at boot via `resolveAgentEnabled(process.env, config)`
(`src/agent-config.ts`) and guards the three Aero wiring points. Data syncs,
intelligence, and notifications are unaffected. Note it stops only the
*automatic* per-run agent stream — the on-demand `analyze`-tier recommendation
`explain` / `brief` routes (Sonnet) still bill on explicit user action.

## Who can use Aero

`agent-routes.ts` calls `requireInstanceAdministrator` on every route it mounts,
so the whole agent surface is administrator-only: transcript, providers, memory,
reset and prompt. A signed-in viewer is refused with 403 even on the reads, and
`AeroBarHost` in the dashboard renders nothing for one. Installs with no accounts
report full access and keep the bar, which is the single-operator case.

The gate runs before `resolveProject`, so a refused caller gets the same 403
whether or not the project exists and cannot use it to probe which projects an
install has.

Two reasons the reads are gated rather than trimmed. There is one Aero session
per project, so the transcript is the operator's conversation rather than
metadata about it, and memory holds operator notes plus the compaction summaries
Aero writes of that transcript. And Aero's tools run with the INSTALL ROOT key
(`server.ts` builds its `ApiClient` from `config.apiKey`, which carries the
wildcard scope, and the per-turn tool scope is read off the request body), so
reaching the prompt route at all means acting with the operator's authority
rather than your own.

### Why the gate asks two questions

`requireAdminSession` reads a role, and an API key carries none, so it passes
every key. `requireInstanceAdministrator` also requires full-instance wildcard
authority, including for credentials delegated by an administrator. Read-only
and project-scoped grants fail this check. Without it, a project-scoped read-only
key (the shape handed to an outside integration) would read the operator's
conversation and memory, and a project-scoped wildcard key would reach the prompt
route and drive the install root key from a credential deliberately narrowed to
one project.

### Model identity

Which provider and model answer is administrator knowledge, and it leaks from
more than the agent routes. `GET /agent/providers` is refused rather than
trimmed, because a filtered list still discloses which providers exist and which
one is configured. `GET /doctor` carries no administrator gate of its own (the
generic role gate refuses a viewer only on write methods), so the
`config.agent-providers` check consults `ctx.callerIsInstanceAdministrator` and
returns `agent-providers.restricted`, with no summary count and no details, to
anyone who is not an install administrator.

## Prompt-only Aero

Aero wakes itself after every `run.completed`. To keep the agent fully usable but
never self-starting, set `agent.mode: 'prompt-only'` in `~/.canonry/config.yaml`,
or `CANONRY_AGENT_PROMPT_ONLY=1` in the environment (env wins; `=0` forces the
wake back on even when config sets prompt-only). Resolved by
`resolveAgentProactiveEnabled` in `src/agent-config.ts`, the same way
`resolveAgentEnabled` resolves the kill switch.

Prompt-only is not a second kill switch. The routes stay mounted, the dashboard
bar still works for administrators, and `canonry agent ask` is unchanged. What
goes away is the unattended turn after each run, and with it the per-run agent
spend and any transcript entry nobody asked for.

The `SessionRegistry` is the enforcing layer, not just the caller. With
`proactive: false`, `queueFollowUp` and `drainNow` are no-ops, `consumePending`
returns nothing, and `getOrCreate` leaves a persisted `follow_up_queue` untouched
rather than migrating it into pending. Without that last part, a follow-up queued
under an earlier mode would be bundled in front of the next thing an operator
typed. The queue is left intact rather than cleared, so turning the wake back on
does not cost the operator those events.

`agent.mode` is therefore a three-state field, held on one key so the states stay
mutually exclusive: absent (enabled and proactive), `prompt-only` (enabled, never
self-starting), and `disabled` (off entirely).

## Model tiers and upgrades

`PROVIDER_MODELS` maps each provider to an agent, analyze and classify model, and
`AGENT_PROVIDERS[x].defaultModel` derives from the agent tier
(`validateAgentProviderRegistry` throws if they desync). DeepInfra splits by tier:
`deepseek-ai/DeepSeek-V4-Flash` drives the agent loop, while analyze and classify
stay on `zai-org/GLM-5.2`, because those tiers suppress the reasoning trace
through GLM's chat-template switch and that branch applies only to a model
declared `reasoning: true`.

A session persists its model id as provenance. Migration 158 moves existing
DeepInfra GLM-5.2 sessions to DeepSeek-V4-Flash once, without changing their
transcript, queue, or activity timestamp. Future default-model upgrades use a
new versioned migration rather than repeatedly replacing stored models during
hydration.

`agent.provider` / `agent.model` in config.yaml pin the model Aero reasons with.
`SessionRegistry.resolveTurnModel` picks the model for every turn and every
hydration, in this order: an explicit request's provider/model (that turn only),
then the pin, then the session's stored model. The stored model therefore
decides only on an unpinned install when the request names nothing, which keeps
an unpinned override sticky across boots as before. Naming the pinned provider
gets `agent.model`, whatever ran last, and a model id never crosses providers.
Removing a pin leaves existing sessions on their stored provider until the
conversation is deleted. A turn the pin sent to a provider with no key is
refused before it starts, with an error naming `agent.provider`, and doctor's
`config.agent-providers` check warns on an unkeyed pin or an unresolvable
`agent.model`. The dashboard never saves a conversation's stored provider as its
own choice, because an explicit provider outranks the pin.

## External agents (webhook lifecycle)

`canonry agent attach <project> --url <webhook-url>` registers an agent
webhook subscribing to `run.completed`, `insight.critical`, `insight.high`,
`citation.gained`. Idempotent — skipped if one already exists on the project.
`canonry agent detach <project>` removes it. The event list is `AGENT_WEBHOOK_EVENTS` in `src/agent-webhook.ts`.

## Agent file rules

Aero's rules live in `src/agent/AGENTS.md` (see "Agent layer (Aero)" below). These file-level rules stay here:

- `src/agent-config.ts` — `resolveAgentEnabled(env, config)`, the Aero kill-switch, plus `resolveAgentProactiveEnabled(env, config)`, the prompt-only switch (`agent.mode: 'prompt-only'` / `CANONRY_AGENT_PROMPT_ONLY`) which keeps every interactive surface and removes only the self-wake. Resolves whether the built-in agent runs from `CANONRY_AGENT_DISABLED` env layered over `agent.mode: 'disabled'` in `config.yaml` (env over config; `=1`/`true` off, `=0`/`false` force on). `server.ts` reads it once at boot and guards the three Aero wiring points: the `SessionRegistry`, the proactive run-completion wake, and the interactive agent routes. Does not touch data syncs / intelligence / notifications.
- `src/agent/session-registry.ts` — hybrid session registry — in-memory `Map<project, Agent>` + durable `agent_sessions` row per project. Handles hydration, persistence, follow-up queueing, post-`agent_end` auto-drain, and the `<memory>` hydrate block appended to every new session's system prompt. `acquireForTurn` is async and awaits transcript compaction before returning.
- `src/agent/memory-store.ts` — CRUD helpers for `agent_memory`: `listMemoryEntries`, `upsertMemoryEntry`, `deleteMemoryEntry`, `loadRecentForHydrate`, `writeCompactionNote`. Enforces the 2 KB value cap and the `compaction:` reserved-prefix rule.
- `src/agent/compaction.ts` — transcript compaction — `shouldCompact`, `findSafeSplit` (snaps to user-message boundaries), `runSummaryLlm` (one-shot pi-ai `complete()` call), and `compactMessages` which persists the summary as a `compaction:` memory row and returns the kept suffix. `src/agent/compaction-config.ts` holds the tuning constants for compaction — token threshold, target ratio, preserved-tail size, max-messages hard cap.
- `src/agent/token-counter.ts` — `estimateMessageTokens` / `estimateTranscriptTokens`: chars/4 heuristic handling user/assistant/toolResult content shapes. Used only to decide when to compact, not to enforce provider limits.
- `src/agent/tools.ts` — thin wrapper around `mcp-to-agent-tool.ts`: `buildReadTools(ctx)` and `buildAllTools(ctx)` delegate to `buildMcpAgentTools(canonryMcpTools, ctx)`. Adding a new tool to `mcp/tool-registry.ts` automatically exposes it to Aero — no separate registration in this file.
- `src/agent/mcp-to-agent-tool.ts` — adapter that converts every `CanonryMcpTool` into a pi-agent-core `AgentTool`. Strips `project` from the LLM-visible schema and injects `ctx.projectName` at call time. `AERO_EXCLUDED_MCP_TOOLS` lists tools that ride the registry but should not reach Aero (e.g. `canonry_agent_clear` — Aero must not erase the operator's transcript).
- `src/agent/remote-mcp.ts` — `loadExternalMcpTools(servers, opts)`, the injected remote-MCP load path. For each configured `{ url, token, label? }` it connects to a REMOTE MCP server over the FROZEN transport (bearer-gated MCP Streamable HTTP, `connectStreamableHttp`), `listTools()`, and adapts each tool into an `AgentTool` (mirroring `mcp-to-agent-tool.ts`). Read-only filter: a remote tool is adopted ONLY when `annotations.readOnlyHint === true` AND its name is not in the local `AERO_EXCLUDED_MCP_TOOLS` set. Fail-soft: a server that fails to connect/list is logged and skipped, never throwing the whole load; no servers configured returns `[]`. The transport is the contract a remote MCP server must speak (see "Injected remote-MCP load path" in `src/agent/AGENTS.md`).
- `src/agent/skill-tools.ts` — 2 skill-doc tools (`list_skill_docs`, `read_skill_doc`): progressive disclosure of bundled reference playbooks. Ride in every scope.

## Key files

- `packages/canonry/src/agent/runtime.ts` — progressive schemas and execution budgets
- `packages/canonry/src/agent/view-context.ts` — authoritative view evidence
- `packages/canonry/src/agent/session.ts` — `createAeroSession` (pi integration)
- `packages/canonry/src/agent/session-registry.ts` — hybrid in-memory + DB registry
- `packages/canonry/src/agent/tools.ts` — thin wrapper that exposes the entire MCP tool registry to Aero via `mcp-to-agent-tool.ts`
- `packages/canonry/src/agent/mcp-to-agent-tool.ts` — adapter; new MCP tools flow into Aero with no second registration
- `packages/canonry/src/agent/agent-routes.ts` — Fastify SSE endpoints
- `apps/web/src/components/shared/AeroBar.tsx` — dashboard UI

## Commands

```bash
canonry agent ask <project> "<prompt>"               # one-shot turn against built-in Aero
canonry agent ask <project> "<prompt>" --provider zai --format json
canonry agent attach <project> --url <webhook-url>   # subscribe an external agent to run/insight events
canonry agent detach <project>                       # remove the agent webhook
canonry agent memory list <project>                  # list Aero's durable project-scoped notes
canonry agent memory set <project> --key <k> --value <v>    # upsert a note (2 KB max)
canonry agent memory forget <project> --key <k>      # delete a note
```
