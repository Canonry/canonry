# Canonry GTM Launch Plan

> **Scope:** launch-oriented sequencing, success metrics, and per-agent distribution. The canonical product roadmap remains `docs/roadmap.md`. This doc is the launch view; roadmap is the feature view.

## Launch Thesis

Canonry is **CLI/API-first, any-agent**. AGENTS.md is explicit: "No MCP layer, no virtual filesystem, no special agent SDK. If an AI agent can't do something with `canonry <command> --format json` or an HTTP call, it's a bug." Aero is a **convenience** — one built-in agent for users who don't already have one. The real win is that Claude Code, Codex, Hermes, OpenClaw, or any custom agent can drive canonry natively through the CLI + API, given the right guidance.

That reframes the GTM feature set: the question isn't "what can Aero do?" It's **"how fast can any agent become productive with canonry?"** Everything below is oriented around that.

**Lead investment:** the content engine (`canonry content gaps|sources|suggest|brief|draft` + WordPress publish). It is the launch headliner, the demo moment, and the feature that closes the loop from observation to outcome.

## Target Users & Agents

- **Target users:** solo AEO analysts, SEO consultants, in-house SEO at SaaS companies.
- **Target agents (first-class skill install support):** Claude Code, Codex, Hermes, OpenClaw. Generic fallback for anything else.
- **Marketing domain:** `canonry.ai`. Backend telemetry stays on `ainyc.ai`.

---

## The three originally-proposed features — validated & reframed

### 1. Easy setup — extend the existing UI wizard, mirror in CLI for agents

**Status — corrected:** the dashboard already has a 5-step setup wizard at `apps/web/src/pages/SetupPage.tsx:21` (system check → create project → keywords → competitors → first run). Empty installs are auto-redirected to `/setup` (`apps/web/src/router/routes.tsx:46-48`), and `build-dashboard.ts:1153,1167` already surfaces empty-state CTAs. **The wizard exists; the gap is what it covers.**

The existing wizard:
- Only *checks* providers in step 1 (system check) and links out to `/settings` to add them — provider entry is not inline.
- Has no GSC / GA4 / Bing / WordPress integration steps.
- Has no "connect your AI editor" step.
- Is one-shot: once a project exists, `routes.tsx:108-113` redirects users away from `/setup` permanently — there is no persistent setup checklist for half-finished setups.

**Two paths, same destination:**

#### Path A — extend the existing UI wizard (primary, most users)

Build on `SetupPage.tsx`, don't replace it.

- **Insert a "Connect a provider" step** before the existing system-check, with inline forms for Gemini / OpenAI / Claude / Perplexity / Local. Validate keys inline (test call); save via existing settings API. Removes the `/settings` round-trip and the "at least one provider" `INIT_PROVIDER_REQUIRED` failure path (`packages/canonry/src/commands/init.ts:218-229`).
- **Insert a skippable "Connect integrations" step** after competitors — GSC OAuth, GA4 service account, Bing key, WordPress app password. All optional with clear "do this later" CTAs.
- **Insert a final "Connect your AI editor" step** after the first run launches. Lists Claude Code, Codex, Hermes, OpenClaw, generic as cards (browser can't auto-detect, so show all). Each card shows copy-paste install command backed by `canonry skill install --for <agent>`.
- **Persistent setup checklist component** that surfaces in the sidebar/topbar even after the redirect kicks in — shows "provider ready / project / GSC / agent", links back to the relevant step. Lives independently of the one-shot wizard so users can finish skipped items later.
- **Empty states everywhere** that say what to do, not just what's missing. The dashboard already does this for projects (`build-dashboard.ts:1167-1174`); extend the same pattern to insights / runs / GSC / etc.
- **Aero is right there** in the bottom AeroBar as the convenience option for users who haven't wired up an external agent.

#### Path B — CLI/agent setup (power users, agent-driven)

Same capabilities exposed for users who say "Claude, install canonry and set me up for stripe.com."

- **`canonry skill install [--for claude-code|codex|cursor|generic]`** — drops the canonry-setup skill into the right location (`~/.claude/skills/`, Codex config, Cursor rules, or prints markdown for a generic README).
- **`canonry init` handoff step:** after setup, detect installed agent tooling and print the one-line install. "Claude Code detected — run `canonry skill install --for claude-code` to give it full context."
- **`canonry agent-guide`** — prints a compact markdown doc (domain overview, common CLI invocations, `--format json` contract, error codes) that an agent can drop into its system prompt.
- **Example workflow docs:** "Using canonry with Claude Code to audit & fix your site" — `canonry run` → Claude Code reads insights → Claude Code applies schema fixes in the user's repo → `canonry run` to verify. Same doc for Codex/Cursor/custom.

**Parity rule:** anything the wizard does, the CLI must do too (per AGENTS.md UI/CLI parity). Project create, provider add, integration connect, first run — all single-call CLI commands with `--format json`. The wizard is just a friendly chrome over them.

**Why this wins:** non-terminal users get a polished install-and-go path. Agent users get the lean CLI flow. Both routes converge on the same project state, and both surfaces teach the agent-integration story.

### 2. Codebase integration — extend the WordPress manual-assist pattern

**Status:** Canonry is observational. `integration-wordpress` is the one exception, and it already models exactly the right pattern for agent-driven code changes — *generate the payload, leave the final mutation to the operator/agent.* See `docs/wordpress-setup.md:44-54` ("What Stays Manual") and `packages/integration-wordpress/src/schema-templates.ts:1` (schema.org templates).

**Reframed for agent-first:** don't invent a new `packages/site-adapters/*` tree. Extend the existing manual-assist pattern with framework-aware emitters that any agent can pipe into the user's repo.

- **Generalize the pattern:** the WordPress commands `wordpress set-schema`, `wordpress set-llms-txt` already do "generate payload + next steps." Lift the schema-template helpers out of `integration-wordpress/` (or add a sibling `packages/site-emitters/`) so they're framework-agnostic.
- **New CLI commands that emit fix artifacts:**
  - `canonry fix schema <project> --page /pricing --format patch|jsonld` → JSON-LD snippet (or unified diff for a detected framework).
  - `canonry fix llms-txt <project> --format file` → full `llms.txt` content.
  - `canonry fix meta <project> --page /pricing --format json` → title/description/OG recommendations.
- **Framework awareness as a flag, not a package:** `--framework next|astro|hugo|html|wordpress`. Start with HTML + Next.js (biggest audience); WordPress already exists. Add others as demand shows up. Each framework just changes the emitted format.
- **Agent workflow:** Claude Code / Codex reads `canonry insights list --format json`, picks an issue, runs `canonry fix schema --format patch`, applies the patch in the user's repo, commits, pushes. Canonry stays out of git — the agent already has repo permissions.
- **Defer:** a `packages/integration-github-app/` for non-agent users (opens a PR for them). Only build if traction shows users want canonry to touch git directly.

**Why this wins:** the WordPress integration already proves the pattern works. Generalizing is a smaller lift than inventing a new package tree, and it stays consistent with how canonry already thinks about side effects (generate + advise, never silently mutate).

### 3. Packaged (macOS first, one-click)

**Status:** npm-only (`@ainyc/canonry@2.0.0`). Dockerfile exists. No Homebrew, no .dmg, no desktop bundle.

- **`npx @ainyc/canonry init`** — verify this works end-to-end for zero-install trial. This is the lowest-friction entry for any npm-capable user.
- **Homebrew tap** (small lift, big reach): `brew install ainyc/tap/canonry`. Wraps the npm install + `canonry init` shim.
- **macOS signed/notarized .pkg installer:** bundles Node runtime + canonry + optional launchd agent for background `canonry serve`. Click → menu-bar app showing serve status + quick-open dashboard. Removes "install Node first" from the funnel.
- **Tauri desktop shell (defer):** full GUI wrapping the SPA. Only pursue if a non-CLI audience shows up.
- Keep npm as canonical for power users and CI.

### 3a. Content recommendations & generation — close the loop from observation to action (LEAD FEATURE)

**Status:** canonry already tracks a very rich signal. Per-query snapshots (`QuerySnapshotDto` in `packages/contracts/src/run.ts:57-77`) carry:
- `citedDomains: string[]` — which domains the LLM credited
- `groundingSources: { uri, title }[]` — the **specific URLs with titles** the LLM used to generate its answer (not just domains)
- `searchQueries: string[]` — the internal queries the LLM fired (related angles to cover)
- `competitorOverlap: string[]` — competitor domains cited alongside the query
- `matchedTerms: string[]` — which of the tracked keyword terms appeared in the answer

Plus the `competitors` table (`packages/db/src/schema.ts:32`), `competitorOverlap` / `recommendedCompetitors` on health snapshots (lines 68-69), and the intelligence package (`packages/intelligence/src/regressions.ts`, `gains.ts`, `causes.ts`) which already computes *why* citations move.

This is **URL-level competitive intel, not just domain-level.** Canonry knows not only "stripe.com is cited for payment processing," but "the LLM pulled from `stripe.com/guides/payment-processing` with title X, and also searched for these related queries." **What's missing is turning that signal into "here's what to write next."**

This is the highest-leverage feature on the list, for two reasons:
1. AEO buyers ultimately want **outcomes** (more citations), not observation. Content is the lever that moves the metric.
2. It's the perfect agent-driven loop: canonry says what to write → agent (Claude Code / Codex / Aero) drafts it → user publishes → next sweep measures the impact. Closes the observation-to-action loop that Profound and Semrush AEO leave open.

**New CLI commands (extend the manual-assist pattern from #2):**
- `canonry content gaps <project> --format json` — queries where competitors are cited but you're not, ranked by frequency and competitor count. Reuses `competitor_overlap` data; pure DB query, no LLM.
- `canonry content sources <project> [--query "..."] [--competitor <domain>] --format json` — the grounding URLs the LLM used, grouped by query and cited domain. "For this query, the LLM pulled from these 4 URLs with these titles" — a reference map the agent (or user) can read to understand what earns a citation. Pure DB query, no LLM, no third-party fetch (canonry surfaces URLs; the agent decides whether to read them).
- `canonry content suggest <project> [--limit N]` — prioritized topic recommendations with reasoning ("3 competitors cited for 'best CRM for SaaS', you're missing — grounding sources suggest long-form comparison posts earn citations here"). Enriched by `searchQueries` (shows the LLM's internal related angles) and `groundingSources` (shows competitive depth).
- `canonry content brief <project> "<topic>" --format md` — full content brief: target query, **top grounding URLs cited for this query** (so the agent knows what to match/exceed), the LLM's internal `searchQueries` as related-angle coverage, competitor citation patterns, suggested H2s/entities, schema to include, target length, supporting stats. Single LLM call using the grounding signal as context.
- `canonry content draft <project> "<topic>" --provider <name> --format md` — full draft using the project's configured provider. Outputs markdown the user/agent commits to their repo, or pipes into the WordPress integration for a draft post. The agent is expected to fetch the grounding URLs itself (via its own WebFetch / browser tool) for source material — canonry surfaces the URLs but never scrapes them (respects ToS, keeps canonry on the "signal, not execution" side).

**New Aero tools:** `get_content_gaps`, `get_grounding_sources`, `suggest_content_topics`, `generate_content_brief`. Same scope rules as existing tools (gaps/sources always-on since they're DB reads; draft generation only via explicit user invocation since it spends provider tokens).

**WordPress synergy:** `canonry wordpress publish-draft <project> --content-file <md>` extends the existing manual-assist pattern (`docs/wordpress-setup.md:44-54`) — generates the WP draft post, stops short of publishing. Same "advise + payload, never silently mutate" principle.

**Demo synergy:** `canonry demo` and the hosted sandbox should highlight this loop. "Watch canonry tell you exactly what blog post to write next based on what your competitors are getting cited for" is a much stronger demo moment than a static dashboard tour. Bake this into the Wave 1 demo script.

**Why this is a GTM differentiator:**
- Profound and Semrush AEO observe; they don't generate. This closes the loop.
- URL-level grounding-source intel is a signal most AEO tools don't expose — "here's the exact page your competitor wrote that earned the citation" beats "your competitor is cited more than you."
- Aligns 1:1 with the agent-first thesis: agents are excellent at writing; canonry is excellent at signal. Don't blur the lines.
- Has SEO value beyond AEO — the same gap analysis helps with traditional Google search.
- Creates a measurable feedback loop: "you wrote this; here's what happened to your citations next sweep" — a unique data story competitors can't tell.

---

## Critical additions the audit surfaced

### 4. Demo mode / no-API-key experience (HIGH GTM IMPACT)

Today users must bring Gemini/OpenAI/Claude keys *before* seeing anything. Huge funnel drop.

- **`canonry demo`** — installs a sample project (e.g. "stripe.com / payment processing") with pre-recorded snapshots, fake citations, populated insights. Users see the dashboard before paying any provider cost.
- **Hosted sandbox** at a public URL — read-only public dashboard so prospects click around without installing. Same data as `canonry demo`.
- **`packages/provider-mock/`** — deterministic replayable provider for CI, demos, and offline dev. Half-implied by `provider-local`; formalize it.

### 5. Credential encryption at rest — full scope (BLOCKER for paid/business users)

Plaintext-in-`~/.canonry/config.yaml` covers far more than provider keys. Buyer-blocking surface area in `packages/canonry/src/config.ts`:

- `apiKey` — local server bearer token (line 101)
- `providers[].apiKey` — every provider key (line 10)
- `providers[].vertexCredentials` — service-account JSON path (line 19)
- `google.clientSecret` (line 43) + `google.connections[].accessToken` / `refreshToken` (lines 33-34)
- `bing.apiKey` and `bing.connections[].apiKey` (lines 49, 56)
- `ga4.connections[].privateKey` — GA4 service-account private key (line 64)
- `wordpress.connections[].appPassword` — explicitly called out as plaintext at `docs/wordpress-setup.md:71`

Wave 0 must cover **all** of the above, not just a "provider keys + Google OAuth" subset. A partial migration leaves the most embarrassing vectors (GA4 private keys, WordPress app passwords) exposed.

- OS keychain via `keytar` (macOS Keychain, Linux libsecret, Windows Credential Manager).
- Config.yaml keeps references (e.g. `apiKey: keychain:wordpress:mysite-app-password`), not secrets.
- Upgrade migration: scan all known secret fields, move to keychain, redact yaml. Idempotent; safe across re-runs.
- Per-secret-type tests so future fields can't slip back into plaintext.

### 6. CLI/API contract hardening — the agent surface itself

The agent-first promise lives or dies on CLI/API predictability. Audit should confirm **every** command and endpoint meets the contract in AGENTS.md.

- Every command supports `--format json` — write a test that asserts this for all commands in `packages/canonry/src/commands/`.
- JSON errors to stderr with stable `code` fields; exit codes follow 0/1/2.
- Composite read endpoints for common questions (AGENTS.md already documents `/projects/:name/runs/latest` and `/projects/:name/search?q=term` — verify they exist and are exercised).
- Publish an **agent-targeted changelog** that highlights breaking CLI/API changes explicitly. Regular changelog buries them.
- Record every new command/endpoint as "agent-safe" in a machine-readable manifest (simple JSON) so agents can discover surface at runtime.

### 6a. Agent-docs accuracy audit (BLOCKER for "any agent fast" pitch)

Shipped agent guidance is stale enough that an agent following it hits dead ends. The most visible: `canonry timeline` is referenced in `packages/canonry/assets/agent-workspace/AGENTS.md:32,64` and `skills/aero/references/memory-patterns.md:28`, but it is not a registered CLI command (verified — no match in `packages/canonry/src/cli-commands.ts` or `packages/canonry/src/cli-commands/*.ts`). An agent told to run `canonry timeline` gets "command not found." That alone breaks the GTM pitch on day one.

- Cross-reference every CLI invocation in `packages/canonry/assets/agent-workspace/`, `skills/aero/`, and `skills/canonry-setup/` against the registered command list. Fail-fast in CI.
- Either ship the missing commands (`timeline` is the obvious one — there's already a `/timeline` API route the UI uses) or update every doc that references them.
- Add a CI lint that greps doc files for `canonry <verb>` invocations and asserts each one is registered.
- This is **Wave 0**, not polish: the agent-first story dies if the docs are wrong.

### 7. Marketing surface

Only a GitHub README today. `ainyc.ai` is referenced but there's no landing, no docs site. **GTM marketing site lives at `canonry.ai`** (separate from `ainyc.ai` which remains the telemetry/backend domain).

- Landing page at `canonry.ai`: positioning, one-line install, comparison table vs Profound / Semrush AEO / Ahrefs Brand Radar.
- **"How to use canonry with Claude Code, Codex, Hermes, OpenClaw"** — dedicated pages per agent. This is the distribution story.
- "Compete vs X" SEO pages — eat branded search.
- 90-second Loom showing agent-driven workflow end-to-end, leading with the content-loop demo (#3a).
- Discord or GitHub Discussions for community.

### 8. Onboarding analytics

Telemetry exists (`https://ainyc.ai/api/telemetry` — backend stays on ainyc.ai; marketing moves to canonry.ai), no funnel dashboard. Without it you'll iterate blind.

- Instrument: `init_started`, `init_provider_added`, `init_completed`, `first_project_created`, `first_run_completed`, `first_insight_viewed`, `skill_installed`, `agent_external_used_cli` (detect via CLI invocation heuristics / env var).
- Build the dashboard before launch.

### 9. Polish blockers from the audit

Would embarrass, not block:
- Migration robustness (`packages/db/src/migrate.ts` silently swallows duplicate column errors).
- Provider error wrapping (raw 429s leaking into snapshots).
- Empty/loading states (skeletons, TanStack Query states).
- Troubleshooting + FAQ docs (none exist).
- Node version mismatch (README ≥22.14, Dockerfile 20).

---

## Wave Sequencing

### Wave 0 — Content engine (start here) + launch hardening — 2–3 weeks

Content is the lead investment. It's the differentiator, the demo headliner, and the feature that closes the loop from observation to outcome. Everything else in Wave 0 is supporting hardening that runs in parallel.

**Lead — content engine (#3a, full scope):**
- **`canonry content gaps`** — DB-only query: which queries do competitors win that you don't?
- **`canonry content sources`** — DB-only query: the grounding URLs the LLM used per query/competitor (URL-level competitive map).
- **`canonry content suggest`** — prioritized topic recommendations enriched by `searchQueries` and `groundingSources`.
- **`canonry content brief`** — full content brief: target query + top grounding URLs + LLM internal queries + suggested H2s/entities/schema. Single LLM call.
- **`canonry content draft`** — full draft via the project's configured provider; emits markdown the user/agent commits to their repo.
- **`canonry wordpress publish-draft`** — closes the WordPress loop; generates draft post via existing manual-assist pattern.
- **Aero tools:** `get_content_gaps`, `get_grounding_sources`, `suggest_content_topics`, `generate_content_brief` (draft generation gated to explicit user invocation).
- **Demo fixtures highlight the content loop** — sample project's `canonry demo` data shows a clear "your competitor is cited via this URL → here's the brief → here's the draft" walkthrough.

**Parallel — launch hardening:**
- **Credential encryption — full secret scope** (#5): provider keys, Vertex creds, Google OAuth + tokens, Bing keys, GA4 private keys, WordPress app passwords, local API key.
- **Agent-docs accuracy audit + CI lint** (#6a): fix `canonry timeline` references and any other dead invocations; ship the `timeline` CLI wrapper around the existing API route; add the lint.
- **`canonry demo` + sample fixtures + mock provider** (#4): "see value before keys"; demo data wired to showcase the content loop end-to-end.
- Migration robustness fix (#9).
- CLI/API contract audit: every command `--format json`, consistent errors, exit codes (#6).
- Minimal troubleshooting doc.

### Wave 1 — Onboarding & distribution — 2–4 weeks

- **Extend the existing `/setup` wizard** (#1, Path A): inline provider step before system check, integrations step (GSC/GA4/Bing/WordPress), final "Connect your AI editor" step.
- **Persistent setup checklist** independent of the one-shot wizard (since `routes.tsx:108-113` redirects users away once a project exists) (#1, Path A).
- **Content surfacing in the dashboard** — gaps/sources/suggest results visible in the project page, not only in the CLI. Same UI/CLI parity rule as the rest of the dashboard.
- **Empty-state polish** sweep across remaining dashboard views (#1, Path A).
- `canonry skill install --for <agent>` + agent-guide doc surface (#1, Path B) — backs the UI panel and the CLI path.
- `canonry init` detects + recommends agent integration (#1, Path B).
- **Hosted demo sandbox** at a `canonry.ai` subdomain — public read-only dashboard with the content-loop fixtures.
- "Using canonry with Claude Code, Codex, Hermes, OpenClaw" docs (#1, #7).
- Homebrew tap (#3).
- Verified `npx @ainyc/canonry init` zero-install path (#3).
- Landing page at `canonry.ai` with agent-workflow demo video — **lead with the content loop** (#7).
- Onboarding telemetry events + funnel dashboard (#8).

### Wave 2 — Polish & expansion — 4–8 weeks

- `canonry fix` commands extending the WordPress manual-assist pattern, HTML + Next.js first (#2).
- macOS .pkg installer (#3).
- Additional `--framework` emitters (Astro, Hugo) (#2).
- "Compete vs X" SEO pages (#7).

### Deferred

- Tauri desktop GUI
- GitHub App for users without an agent
- Multi-tenant SaaS / Stripe
- Aero-specific polish — it works; investing here doesn't move GTM

---

## Success Metrics

Track against a funnel dashboard powered by `packages/canonry/src/telemetry.ts`:

- Install count (npm + Homebrew + .pkg).
- `init_completed` rate (vs `init_started`).
- `first_run_completed` rate (vs `init_completed`).
- `skill_installed` rate (which agent breakdown).
- `content_brief_generated` rate (Wave 0 lead-feature adoption).
- `content_draft_published` rate (closed-loop validation).
- 7-day retention on dashboard.
- Demo → install conversion (hosted sandbox to local install).

## Go/No-Go Criteria

### Wave 0 ship gate
- [ ] All `canonry content` subcommands ship with `--format json` parity and tests.
- [ ] All seven secret types in `config.ts` migrated to keychain. Zero plaintext secrets in fresh `~/.canonry/config.yaml`.
- [ ] CI lint asserts every doc-referenced `canonry <verb>` invocation is registered. `canonry timeline` ships or all references removed.
- [ ] `canonry demo` boots a working sample project with content-loop data on a clean machine in under 60 seconds.
- [ ] CLI contract test passes: every command exposes `--format json`, follows 0/1/2 exit codes, structured stderr errors.

### Wave 1 ship gate
- [ ] `/setup` wizard covers provider, integrations, agent-connect.
- [ ] Persistent setup checklist surfaces post-redirect.
- [ ] Content gaps/sources/suggest visible in dashboard with API/CLI parity.
- [ ] `canonry skill install` works for Claude Code, Codex, Hermes, OpenClaw.
- [ ] Hosted sandbox live at canonry.ai subdomain with demo fixtures.
- [ ] Landing page at canonry.ai with content-loop demo video.
- [ ] Telemetry funnel dashboard live and capturing all instrumented events.

### Wave 2 ship gate
- [ ] `canonry fix` supports schema/llms-txt/meta for HTML + Next.js + WordPress.
- [ ] macOS .pkg installer signed, notarized, and downloadable from canonry.ai.

---

## Per-Agent Distribution Plan

### Claude Code

- **Install:** `canonry skill install --for claude-code` drops skill into `~/.claude/skills/`.
- **Example prompt:** "Use canonry to find queries where my competitors are cited but I'm not, then write a brief for the highest-priority topic."
- **Expected workflow:** `canonry content gaps --format json` → pick top result → `canonry content brief "<topic>" --format md` → Claude Code writes draft and commits to user repo → `canonry run` next sweep validates impact.

### Codex

- **Install:** `canonry skill install --for codex` writes Codex-format config.
- **Example prompt:** "Audit this site against canonry's latest sweep and apply schema fixes."
- **Expected workflow:** `canonry insights list --format json` → Codex picks issues → `canonry fix schema --page <url> --format patch` → Codex applies patch in repo → re-run.

### Hermes

- **Install:** `canonry skill install --for hermes` writes Hermes-format guidance.
- **Example prompt:** "Plan a content roadmap based on canonry's competitive intel for this domain."
- **Expected workflow:** `canonry content suggest --limit 10 --format json` → Hermes synthesizes editorial calendar → user approves → Hermes drives `canonry content draft` for each topic.

### OpenClaw

- **Install:** `canonry skill install --for openclaw` writes OpenClaw skill bundle.
- **Example prompt:** "Set up canonry for stripe.com and run the first sweep."
- **Expected workflow:** OpenClaw drives `canonry init` → `canonry project create` → `canonry keyword add` → `canonry run` → `canonry insights list` end-to-end.

### Generic fallback

- **Install:** `canonry agent-guide` prints a markdown brief any agent can ingest.
- **Example prompt:** "Read this canonry CLI guide and use it to analyze citation gaps for example.com."
- **Expected workflow:** Agent reads the guide, drives the CLI directly using `--format json` for every read.

---

## Critical files for the implementation waves

| Wave | Area | Files |
|------|------|-------|
| 0 (lead) | Content gaps + sources + suggest | new `packages/canonry/src/commands/content.ts` (gaps, sources, suggest subcommands); reads `groundingSources` + `searchQueries` + `competitorOverlap` fields on `QuerySnapshotDto` (`packages/contracts/src/run.ts:57-77`); reuses `competitors` table + health-snapshot fields (`packages/db/src/schema.ts:32,68`); reuses `packages/intelligence/src/causes.ts` |
| 0 (lead) | Content brief + draft | extend `packages/canonry/src/commands/content.ts`, new `packages/intelligence/src/content-prompts.ts` for brief + draft prompt templates, new Aero tools in `packages/canonry/src/agent/tools.ts` |
| 0 (lead) | WordPress draft publish | extend `packages/integration-wordpress/src/wordpress-client.ts` (draft post creation), new CLI subcommand in `packages/canonry/src/cli-commands/wordpress.ts` |
| 0 | Credential encryption | `packages/canonry/src/config.ts` (all secret fields lines 10, 19, 33-34, 43, 49, 56, 64, 80, 101), `packages/canonry/src/commands/init.ts`, new `packages/canonry/src/keychain.ts`, migration in `packages/canonry/src/config-migrate.ts` |
| 0 | Agent-docs accuracy | `packages/canonry/assets/agent-workspace/AGENTS.md`, `skills/aero/references/memory-patterns.md`, `skills/canonry-setup/`, new CI lint comparing doc invocations to `packages/canonry/src/cli-commands.ts` |
| 0 | `canonry timeline` CLI wrapper | new `packages/canonry/src/commands/timeline.ts` wrapping the existing `/timeline` API route, register in `packages/canonry/src/cli-commands/run.ts` (or new `cli-commands/timeline.ts`) |
| 0 | Demo mode (highlights content loop) | new `packages/canonry/src/commands/demo.ts`, new `packages/canonry/fixtures/demo-project/` (with grounding-source data wired for the content demo), new `packages/provider-mock/` |
| 0 | Migration fix | `packages/db/src/migrate.ts` |
| 0 | CLI contract audit | new `packages/canonry/test/cli-contract.test.ts`, all `packages/canonry/src/commands/*.ts` |
| 1 | UI wizard extensions | extend `apps/web/src/pages/SetupPage.tsx` (add provider step, integrations step, agent-connect step), update step labels in `SETUP_STEPS` (line 21) |
| 1 | UI content surfacing | new `apps/web/src/components/project/ContentGapsSection.tsx`, `ContentSourcesSection.tsx`, `ContentSuggestionsSection.tsx`; consume the same API endpoints the CLI hits |
| 1 | UI persistent setup checklist | new `apps/web/src/components/shared/SetupChecklist.tsx`, surface in topbar/sidebar; reuse `buildSetupModel` from `health-helpers.ts` |
| 1 | UI empty-state sweep | extend pattern from `build-dashboard.ts:1167-1174` to insights / runs / GSC / analytics / content views |
| 1 | Skill install (CLI) | new `packages/canonry/src/commands/skill.ts`, existing `skills/canonry-setup/` |
| 1 | Agent-guide surface (CLI) | new `packages/canonry/src/commands/agent-guide.ts` (prints compact markdown) |
| 1 | Init handoff (CLI) | `packages/canonry/src/commands/init.ts` |
| 1 | Hosted demo sandbox | new ops/deployment for a public read-only canonry instance at a `canonry.ai` subdomain using the same fixtures as `canonry demo` |
| 1 | Homebrew | new `homebrew-tap` repo + formula referencing the npm tarball |
| 1 | Telemetry events | `packages/canonry/src/telemetry.ts` (server) + new instrumentation in `apps/web/src/pages/SetupPage.tsx` |
| 2 | Fix commands | new `packages/canonry/src/commands/fix.ts`, generalize `packages/integration-wordpress/src/schema-templates.ts` into a framework-agnostic emitter (in-place or new `packages/site-emitters/`); start with `--framework html|next` |

---

## Relationship to other docs

- **`docs/roadmap.md`** — feature-level product priority (stays canonical for what to build). This doc is the launch view.
- **`docs/architecture.md`** — current system topology.
- **`AGENTS.md` (root)** — agent-first contract, surface priority, UI/CLI parity rules. This GTM plan operationalizes those rules.
