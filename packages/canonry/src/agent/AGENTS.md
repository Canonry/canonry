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
- **Dashboard**: bottom command bar (`AeroBar`) on every project-scoped
  route. SSE-streamed via `POST /api/v1/projects/:name/agent/prompt`.
- **Proactive**: `RunCoordinator` enqueues a synthesized `[system]` follow-up
  into the project's session after every `run.completed`; `SessionRegistry.drainNow`
  wakes the agent unprompted so insights/failures get analyzed without a
  user click.
- **Persistence**: one `agent_sessions` row per project. Transcript + queued
  follow-ups survive `canonry serve` restarts. See `docs/data-model.md`.
- **Memory**: durable project-scoped notes in `agent_memory` (key/value +
  source). Written via `remember` tool (or CLI / API), read via `recall`, and
  the N most-recent rows are injected into every new session's system prompt
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

Tool surface has two layers:
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
- **Aero tool profiles** (`src/agent/tools.ts`) — the default profile exposes
  the full local MCP-derived tool surface for the requested scope. The
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

## External agents (webhook lifecycle)

`canonry agent attach <project> --url <webhook-url>` registers an agent
webhook subscribing to `run.completed`, `insight.critical`, `insight.high`,
`citation.gained`. Idempotent — skipped if one already exists on the project.
`canonry agent detach <project>` removes it. The event list is `AGENT_WEBHOOK_EVENTS` in `src/agent-webhook.ts`.

## Agent file rules

Aero's rules live in `src/agent/AGENTS.md` (see "Agent layer (Aero)" below). These file-level rules stay here:

- `src/agent-config.ts` — `resolveAgentEnabled(env, config)`, the Aero kill-switch. Resolves whether the built-in agent runs from `CANONRY_AGENT_DISABLED` env layered over `agent.mode: 'disabled'` in `config.yaml` (env over config; `=1`/`true` off, `=0`/`false` force on). `server.ts` reads it once at boot and guards the three Aero wiring points: the `SessionRegistry`, the proactive run-completion wake, and the interactive agent routes. Does not touch data syncs / intelligence / notifications.
- `src/agent/session-registry.ts` — hybrid session registry — in-memory `Map<project, Agent>` + durable `agent_sessions` row per project. Handles hydration, persistence, follow-up queueing, post-`agent_end` auto-drain, and the `<memory>` hydrate block appended to every new session's system prompt. `acquireForTurn` is async and awaits transcript compaction before returning.
- `src/agent/memory-store.ts` — CRUD helpers for `agent_memory`: `listMemoryEntries`, `upsertMemoryEntry`, `deleteMemoryEntry`, `loadRecentForHydrate`, `writeCompactionNote`. Enforces the 2 KB value cap and the `compaction:` reserved-prefix rule.
- `src/agent/compaction.ts` — transcript compaction — `shouldCompact`, `findSafeSplit` (snaps to user-message boundaries), `runSummaryLlm` (one-shot pi-ai `complete()` call), and `compactMessages` which persists the summary as a `compaction:` memory row and returns the kept suffix. `src/agent/compaction-config.ts` holds the tuning constants for compaction — token threshold, target ratio, preserved-tail size, max-messages hard cap.
- `src/agent/token-counter.ts` — `estimateMessageTokens` / `estimateTranscriptTokens`: chars/4 heuristic handling user/assistant/toolResult content shapes. Used only to decide when to compact, not to enforce provider limits.
- `src/agent/tools.ts` — thin wrapper around `mcp-to-agent-tool.ts`: `buildReadTools(ctx)` and `buildAllTools(ctx)` delegate to `buildMcpAgentTools(canonryMcpTools, ctx)`. Adding a new tool to `mcp/tool-registry.ts` automatically exposes it to Aero — no separate registration in this file.
- `src/agent/mcp-to-agent-tool.ts` — adapter that converts every `CanonryMcpTool` into a pi-agent-core `AgentTool`. Strips `project` from the LLM-visible schema and injects `ctx.projectName` at call time. `AERO_EXCLUDED_MCP_TOOLS` lists tools that ride the registry but should not reach Aero (e.g. `canonry_agent_clear` — Aero must not erase the operator's transcript).
- `src/agent/remote-mcp.ts` — `loadExternalMcpTools(servers, opts)`, the injected remote-MCP load path. For each configured `{ url, token, label? }` it connects to a REMOTE MCP server over the FROZEN transport (bearer-gated MCP Streamable HTTP, `connectStreamableHttp`), `listTools()`, and adapts each tool into an `AgentTool` (mirroring `mcp-to-agent-tool.ts`). Read-only filter: a remote tool is adopted ONLY when `annotations.readOnlyHint === true` AND its name is not in the local `AERO_EXCLUDED_MCP_TOOLS` set. Fail-soft: a server that fails to connect/list is logged and skipped, never throwing the whole load; no servers configured returns `[]`. The transport is the contract a remote MCP server must speak (see "Injected remote-MCP load path" in `src/agent/AGENTS.md`).
- `src/agent/skill-tools.ts` — 2 skill-doc tools (`list_skill_docs`, `read_skill_doc`): progressive disclosure of bundled reference playbooks. Ride in every scope.

## Key files

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
