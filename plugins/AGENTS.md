# plugins and skills

The portable Canonry plugin (`plugins/canonry/`), its client adapters, and the canonical skill sources in `skills/` that it ships. This file lives outside both folders on purpose: everything in `plugins/canonry/` ships to users, and any change under `skills/` counts as a plugin change for `plugin:check --base-ref`, which then requires a version bump.

## Plugin

`plugins/canonry/` targets Agent Plugins 1.0.0 with root `plugin.json`, fixed
`skills/` children, and root `mcp.json`. Current Codex and Claude Code
distribution remains backward-compatible through `.codex-plugin/plugin.json`,
`.claude-plugin/plugin.json`, and `.mcp.json`. The repository marketplaces live
at `.agents/plugins/marketplace.json` (Codex) and
`.claude-plugin/marketplace.json` (Claude Code); distribution is outside the
portable specification.

- The plugin launches the published `canonry-mcp` binary; it must never grow a
  second server, private API, credential store, hook, or automatic sweep.
- Keep root `plugin.json` closed to Agent Plugins fields and root `mcp.json`
  closed to `$schema` + `mcpServers`. Client-only metadata stays in the adapter
  manifests. Bundled `SKILL.md` frontmatter follows Agent Skills, including
  string-valued `metadata` entries.
- Canonical skill edits happen only under `skills/`. Run `pnpm plugin:sync`
  afterward and commit the mirrors; CI runs `pnpm plugin:check`.
- Native-plugin setup uses `canonry init --skip-skills --skip-mcp`; those flags
  keep the legacy installation decision explicit. `serve` and the agent doctor
  checks use best-effort detection only for advisory status and to suppress
  the legacy-skills nudge.
- Plugin manifests contain no keys. Authorization remains server-enforced by
  Canonry's existing instance-wide, project-scoped, or read-only key.

## Install (native plugins)

```bash
canonry init --skip-skills --skip-mcp
codex plugin marketplace add Canonry/canonry && codex plugin add canonry@canonry
claude plugin marketplace add Canonry/canonry && claude plugin install canonry@canonry
canonry start                         # only when the daemon is not already running
canonry doctor --check 'agent.skills.*' --format json
```

## Skills (`skills/`)

### Purpose

Canonical sources for the two agent skills Canonry ships. Both are bundled into the published `@canonry/canonry` package and installable into any user's project via `canonry skills install`:

| Skill | Audience | Purpose |
|---|---|---|
| `skills/canonry/` | External users (their Claude Code / Codex) | Operator playbook: how to install canonry, run sweeps, audit indexing, fix integrations |
| `skills/aero/` | Aero (canonry's built-in analyst) AND external users | Analyst playbook: regression diagnosis, orchestration, memory patterns, reporting |

**Keep both skills in sync with the codebase.** Both are co-equal — the analyst playbook ships alongside the operator playbook in every install.

### Layout

Each skill is a directory tree:

```
skills/<name>/
  SKILL.md          # entry point: when to use, top-level capabilities, references TOC
  references/       # deep playbooks the agent reads on demand
    *.md
```

`SKILL.md` is the only file always pulled into agent context when the skill is invoked. References lazy-load — the agent `Read`s them only when the task matches. **Keep `SKILL.md` lean** and push detail into `references/`.

`skills/canonry/SKILL.md` and `skills/aero/references/agent-operations.md` are generated from `docs/agent-operations/v1.md`. Edit that source and run `pnpm guide:sync`; never edit the generated files directly.

### When to update skills

The triggers (new CLI command, provider, integration, analytics feature, or analyst workflow) are rows in `docs/DOC_UPDATE.md`. After any edit under `skills/`, run `pnpm plugin:sync` (see "Plugin" above) and follow the version-bump rule in the root `AGENTS.md` ("Versioning").

### Bundling and installation

- `packages/canonry/scripts/copy-agent-assets.ts` mirrors `skills/<name>/` into `packages/canonry/assets/agent-workspace/skills/<name>/` at build time so the trees ship in the published package.
- `canonry skills install [skill...] [--dir <path> | --user] [--client claude|codex|all] [--force]` writes the bundled trees into `<dir>/.claude/skills/<name>/` and (for codex) creates a relative symlink at `<dir>/.codex/skills/<name>` pointing back at the Claude path. Default scope: all skills, both clients.
- `canonry init` auto-runs `installSkills()` when the cwd looks like a project (has `.git`, `canonry.yaml` / `canonry.yml`, or `package.json`); otherwise prints a tip. Pass `--skip-skills` to opt out or `--skills-dir <path>` to override the target.

### What NOT to put in skills

- Internal implementation details, file paths, or architecture
- Anything that changes every release (version numbers, changelog)
- Dev-only workflows (testing, CI, building from source beyond basic install)
