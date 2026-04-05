# Migration Plan: Aero → Canonry Monorepo

## Context

Maintaining Aero as a separate package that depends on both `@ainyc/canonry` and `openclaw` is too complex — three packages to keep in sync, Docker setup is painful, and every feature touches multiple repos. Since canonry is already FSL-licensed, we're moving all Aero features into the canonry monorepo. One repo, one `npx canonry` install, one release cycle.

**What moves into canonry:** Intelligence engine, agent CLI commands, OpenClaw bootstrap, agent persona/skills
**What stays separate (future private repo):** Sync service, team management, billing

---

## What Changes in Canonry

### 1. New package: `packages/intelligence/`

Pure-function library for post-sweep analysis. No external deps — just takes run data in, returns insights out.

| Aero source | Canonry destination |
|---|---|
| `src/intelligence/regressions.ts` | `packages/intelligence/src/regressions.ts` |
| `src/intelligence/gains.ts` | `packages/intelligence/src/gains.ts` |
| `src/intelligence/health.ts` | `packages/intelligence/src/health.ts` |
| `src/intelligence/causes.ts` | `packages/intelligence/src/causes.ts` |
| `src/intelligence/insights.ts` | `packages/intelligence/src/insights.ts` |
| `src/intelligence/analyzer.ts` | `packages/intelligence/src/analyzer.ts` |
| `src/intelligence/types.ts` | `packages/intelligence/src/types.ts` |
| (new) | `packages/intelligence/src/db-adapter.ts` — converts Drizzle querySnapshot rows to intelligence `RunData` |

All 25 intelligence tests migrate to `packages/intelligence/test/`. Import paths change, logic stays the same.

**Integration hook:** Canonry's `notifier.ts` already detects citation transitions after each run. We add a call to the intelligence analyzer after transitions are computed. A new `packages/canonry/src/intelligence-service.ts` orchestrates: fetch runs from DB → convert via db-adapter → call `analyzeRuns` → persist to `insights` and `health_snapshots` tables.

### 2. Database additions

Two new tables in `packages/db/src/schema.ts` + matching migrations in `migrate.ts`:

**`insights`** — regression/gain/opportunity records per run
- id, projectId, runId, type, severity, title, keyword, provider, recommendation (JSON), cause (JSON), dismissedAt, createdAt

**`health_snapshots`** — cited rate snapshots per run
- id, projectId, runId, overallCitedRate, totalPairs, citedPairs, providerBreakdown (JSON), createdAt

### 3. New CLI commands

**`canonry agent` group** — OpenClaw lifecycle management:
- `canonry agent setup [--provider X --api-key Y]` — detect/install OpenClaw, set profile, seed workspace
- `canonry agent start` / `stop` / `status` — gateway lifecycle
- `canonry agent reset [--force]` — cleanup

**Intelligence commands:**
- `canonry insights <project> [--type regression|gain]` — list insights
- `canonry health <project>` — show health score + trend

All follow existing canonry patterns: `CliCommandSpec` in `src/cli-commands/agent.ts` and `src/cli-commands/intelligence.ts`, implementations in `src/commands/agent-*.ts` and `src/commands/insights.ts`.

### 4. New API routes in `packages/api-routes/src/intelligence.ts`

| Method | Path | Description |
|---|---|---|
| GET | `/projects/:name/insights` | List insights (filter by type, run) |
| GET | `/projects/:name/insights/:id` | Get single insight |
| POST | `/projects/:name/insights/:id/dismiss` | Dismiss insight |
| GET | `/projects/:name/health` | Latest health snapshot |
| GET | `/projects/:name/health/history` | Health trend (limit param) |

### 5. Config extension

Add `agent` section to `CanonryConfig` in `packages/canonry/src/config.ts`:

```yaml
# In ~/.canonry/config.yaml
agent:
  enabled: true
  provider: anthropic
  apiKey: sk-ant-...
  gatewayPort: 19001
```

No separate `~/.aero/` directory — everything lives in canonry's config.

### 6. Agent persona + skills

| Aero source | Canonry destination |
|---|---|
| `workspace/SOUL.md` | `packages/canonry/assets/agent-workspace/SOUL.md` |
| `workspace/AGENTS.md` | `packages/canonry/assets/agent-workspace/AGENTS.md` |
| `workspace/USER.md` | `packages/canonry/assets/agent-workspace/USER.md` |
| `skills/aero/*` | `skills/aero/*` (repo root, alongside `skills/canonry-setup/`) |

Workspace templates bundled in npm package (already in `assets/`). Copied to OpenClaw workspace during `canonry agent setup`.

### 7. Bootstrap integration

Extend existing `canonry bootstrap` / `canonry init` with optional agent setup:
- Env vars: `CANONRY_AGENT_ENABLED`, `CANONRY_AGENT_PROVIDER`, `CANONRY_AGENT_API_KEY` for CI
- Interactive: "Connect an AI agent?" prompt at end of init flow

### 8. Utility consolidation

Aero's `src/utils/` (shell exec, health check, port finder, copy helpers) → single `packages/canonry/src/agent-utils.ts`. Only used by agent commands.

---

## Implementation Sequence

1. **Foundation** — `packages/intelligence/` scaffold, migrate source + tests, add DB tables/migrations, add DTOs to contracts
2. **API surface** — intelligence routes, ApiClient methods, intelligence-service orchestration, wire into notifier
3. **Intelligence CLI** — `canonry insights` + `canonry health` commands
4. **Agent CLI** — `canonry agent setup/start/stop/status/reset`, agent-utils, config extension
5. **Bootstrap integration** — extend init/bootstrap with agent setup prompt
6. **Skills + docs** — copy persona files, update CLAUDE.md and CLI reference

---

## Files to Create

```
packages/intelligence/                       # New package (7 source + 7 test files)
packages/canonry/src/cli-commands/agent.ts   # Agent CLI specs
packages/canonry/src/cli-commands/intelligence.ts  # Intelligence CLI specs
packages/canonry/src/commands/agent-setup.ts
packages/canonry/src/commands/agent-process.ts
packages/canonry/src/commands/agent-reset.ts
packages/canonry/src/commands/insights.ts
packages/canonry/src/commands/health-cmd.ts
packages/canonry/src/agent-utils.ts
packages/canonry/src/intelligence-service.ts
packages/canonry/assets/agent-workspace/{SOUL,AGENTS,USER}.md
packages/api-routes/src/intelligence.ts
packages/contracts/src/intelligence.ts
skills/aero/                                 # SKILL.md + 4 reference docs
```

## Files to Modify

```
packages/db/src/schema.ts                    # +insights, +health_snapshots tables
packages/db/src/migrate.ts                   # +v18 migrations
packages/canonry/src/cli-commands.ts         # Register AGENT + INTELLIGENCE commands
packages/canonry/src/config.ts               # +AgentConfig type
packages/canonry/src/client.ts               # +insight/health API methods
packages/canonry/src/notifier.ts             # Wire intelligence after run completion
packages/canonry/src/commands/bootstrap.ts   # Optional agent env-var support
packages/canonry/package.json                # +intelligence dep, version bump
packages/api-routes/src/index.ts             # Register intelligence routes
packages/contracts/src/index.ts              # Re-export intelligence DTOs
vitest.workspace.ts                          # Add packages/intelligence
```

## Verification

1. `pnpm test` — all existing canonry tests still pass
2. `pnpm --filter @ainyc/canonry-intelligence test` — migrated intelligence tests pass
3. `canonry insights <project> --format json` — returns insights after a sweep
4. `canonry health <project> --format json` — returns health score
5. `canonry agent setup` — detects/installs OpenClaw, seeds workspace
6. `canonry agent start` / `canonry agent status` — gateway lifecycle works
7. Run a sweep → verify insights auto-generated in DB via `canonry insights`

## After Migration

The aero repo (`asuncion-v1`) can be archived. Everything it contains moves into canonry. The future `canonry-cloud` private repo handles sync/teams/billing — that's a separate effort.

---

## Phase 4 Detail: Agent CLI (`canonry agent` Commands)

### Context

Steps 1–3 are done (intelligence engine, API routes, intelligence CLI — 798/798 tests passing). This phase ports OpenClaw agent lifecycle management from aero's `src/bootstrap.ts`, `src/gateway.ts`, and `src/process.ts` into canonry.

### Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Utility structure | Single `commands/agent.ts` file, no separate `agent-utils.ts` | Canonry's `daemon.ts` inlines helpers. Small enough for one file. |
| Config location | `agent?` section in `CanonryConfig` (`~/.canonry/config.yaml`) | Follows canonry pattern. No separate `~/.aero/config.json`. |
| Port aero's `process.ts` orchestration? | No | `canonry start` already handles the server. `canonry agent start` manages only the gateway. Users compose them. |
| Port aero's onboard wizard? | No | Canonry has `init`, `project create`, `settings`. Agent setup only does OpenClaw-specific bootstrap. |
| Profile name | `OPENCLAW_PROFILE=canonry` | Replaces aero's `OPENCLAW_PROFILE=aero`. |
| `@clack/prompts` dependency? | Not needed | Agent setup is non-interactive. |

### Files to Create

**1. `packages/canonry/src/commands/agent.ts`** (new — core implementation)

All agent logic in one file. Private helpers for exec, health check, port finding (inlined, not in separate utils). Public exports:

- `agentSetup(format)` — Detect/install OpenClaw → resolve port → stage `~/.openclaw-canonry/openclaw.json` → `openclaw onboard --install-daemon` → seed workspace (SOUL.md, AGENTS.md, USER.md from `assets/agent-workspace/`, skills from `skills/aero/`) → verify health → save `agent` config to `config.yaml`
- `agentStart(format)` — Load port from config → `openclaw gateway start` → health poll → doctor --fix fallback
- `agentStop(format)` — `openclaw gateway stop`
- `agentStatus(format)` — `openclaw gateway status --json` → display profile, state dir, running/stopped, PID, port
- `agentReset(format)` — Stop gateway (swallow errors) → `rm -rf ~/.openclaw-canonry/` → clear `agent` from config.yaml

Source references for porting:
- `asuncion-v1/src/bootstrap.ts` → `agentSetup()` (detect, install, profile, port, stage, onboard, seed, verify)
- `asuncion-v1/src/gateway.ts` → `agentStart()`, `agentStop()`, `agentStatus()`
- `asuncion-v1/src/utils/shell.ts` → inline `exec()` helper
- `asuncion-v1/src/utils/net.ts` → inline `checkHealth()`, `findAvailablePort()`

**2. `packages/canonry/src/cli-commands/agent.ts`** (new — CLI specs)

Exports `AGENT_CLI_COMMANDS: readonly CliCommandSpec[]` with 6 entries:
- `['agent', 'setup']` — calls `agentSetup(format)`
- `['agent', 'start']` — calls `agentStart(format)`
- `['agent', 'stop']` — calls `agentStop(format)`
- `['agent', 'status']` — calls `agentStatus(format)`
- `['agent', 'reset']` — calls `agentReset(format)`
- `['agent']` — catch-all, calls `unknownSubcommand()` with available list

**3. `packages/canonry/test/agent.test.ts`** (new — tests)

Mock `child_process.execFile` via `vi.mock`. Tests:
- `agentStatus` returns `{ running: false }` when openclaw not installed
- `agentReset` removes state directory + clears config
- Config round-trip: save AgentConfig → loadConfig → verify `agent` section
- CLI specs are well-formed (paths, usage strings)

### Files to Modify

**4. `packages/canonry/src/config.ts`**
- Add `AgentConfig` interface: `{ enabled?: boolean; gatewayPort?: number; setupCompletedAt?: string }`
- Add `agent?: AgentConfig` to `CanonryConfig`

**5. `packages/canonry/src/cli-commands.ts`**
- Import `AGENT_CLI_COMMANDS` from `./cli-commands/agent.js`
- Add `...AGENT_CLI_COMMANDS` to `REGISTERED_CLI_COMMANDS`

**6. `packages/canonry/src/cli.ts`**
- Add 5 agent lines to USAGE string (before `canonry --help`)

### Assets (already in place)

These were copied in a prior phase — verify they exist:
- `packages/canonry/assets/agent-workspace/SOUL.md`
- `packages/canonry/assets/agent-workspace/AGENTS.md`
- `packages/canonry/assets/agent-workspace/USER.md`
- `skills/aero/SKILL.md` + `skills/aero/references/*.md`

### Implementation Order

1. Config extension (`config.ts` — add `AgentConfig`)
2. Command implementation (`commands/agent.ts` — all 5 functions)
3. CLI specs (`cli-commands/agent.ts`)
4. Registration (`cli-commands.ts` + `cli.ts` USAGE)
5. Tests (`test/agent.test.ts`)
6. Verify: `pnpm test` (798+ tests pass), `npx tsc --noEmit`

### Verification

1. `pnpm test` — all existing 798 tests still pass + new agent tests
2. `npx tsc --noEmit --project packages/canonry/tsconfig.json` — clean compile
3. Manual: `canonry agent setup` detects OpenClaw, installs if missing, seeds workspace
4. Manual: `canonry agent start` → `canonry agent status` → `canonry agent stop`
5. Manual: `canonry agent reset` cleans up `~/.openclaw-canonry/`
