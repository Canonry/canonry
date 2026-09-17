# Keeping Documentation Current

This repo uses per-package `AGENTS.md` files for local context. **These must stay in sync with the code.** Update the relevant documentation when making structural changes:

| When you... | Update... |
|-------------|-----------|
| Add a new package under `packages/` or `apps/` | Create `AGENTS.md` + `CLAUDE.md` (`@AGENTS.md`) in the new package |
| Add a new table or column in `packages/db/src/schema.ts` | Update `docs/data-model.md` (ER diagram + table groups) |
| Add a new API route file in `packages/api-routes/src/` | Update `packages/api-routes/AGENTS.md` key files table |
| Add a new CLI command | Update `packages/canonry/AGENTS.md`; add the equivalent MCP tool or document the explicit classification exception |
| Add or change an MCP tool | Update `packages/canonry/src/mcp/tool-registry.ts` (tag with a `tier`), `openapi-classification.ts`, `docs/mcp.md`, and the `mcp-registry`/`mcp-stdio` tests. The built-in Aero agent picks the new tool up automatically through `agent/mcp-to-agent-tool.ts` — no second registration in `agent/tools.ts`. Add the name to `AERO_EXCLUDED_MCP_TOOLS` only if Aero must not invoke it (e.g. `canonry_agent_clear`). |
| Change agent operations guidance or the Canonry skill | Edit `docs/agent-operations/v1.md`, run `pnpm guide:sync`, and verify `pnpm plugin:check`. Runtime guidance, the optional MCP resource, and both clients' Canonry skill must share this source. |
| Add a new doctor check | Add a `CheckDefinition` in `packages/api-routes/src/doctor/checks/<topic>.ts`, register in `doctor/registry.ts`, add tests in `packages/api-routes/test/doctor-*`, document the new check ID in `AGENTS.md`'s "Doctor" section |
| Add a new MCP toolkit | Add the toolkit name to `packages/canonry/src/mcp/toolkits.ts`, tag the relevant tools with the new tier, and update the toolkit table in `docs/mcp.md` |
| Add a new UI dashboard section or widget | Verify backing API endpoint + CLI command exist first (UI/CLI parity rule) |
| Add a new provider package | Update `docs/providers/README.md` and create `docs/providers/<name>.md` |
| Add a new integration package | Create `packages/integration-<name>/AGENTS.md`; wrap its HTTP layer in `withRetry` (see "Third-party HTTP calls" below) |
| Change a critical pattern (error handling, DB access, auth) | Update the relevant package's AGENTS.md patterns section |
| Add a new dependency between packages | Update `docs/architecture.md` module dependency graph |
| Add a generic utility (formatter, parser, normalizer) | Add it to `packages/contracts/src/<topic>.ts`, re-export from `index.ts`, add tests in `packages/contracts/test/<topic>.test.ts`. Update the "Where utilities live" table in this file if introducing a new category. |
| Add a lint guard (selector ban, custom rule) | Give it a UNIQUE rule id via `createRestrictedSyntaxRule` — never `no-restricted-syntax` options — add it to the coverage matrix in `test/eslint-guards.test.ts` and the guard table in `docs/GUARDS.md` |
| Change `@canonry/val-kit`'s public API | Bump `packages/val-kit/package.json`, update the inline `npm:@canonry/val-kit@<version>` pin in EVERY Val that imports it (Val Town applies no import map, so the version is repeated at each import site), then publish manually with `pnpm --filter @canonry/val-kit publish`. Vals have no CI/CD, so nothing stops a deploy against an unpublished pin: run the Val's `deno task check:prod` first. |
| Add a Val under `apps/vals/` | Give it its own `deno.json` / `deno.dev.json` tasks and its own Val Town target, and add the Val to `docs/CODEMAP.md` + `docs/README.md`. Vals have no CI/CD job or deploy workflow; document its manual verification and release order in its `AGENTS.md`. |

**Documentation-only changes do not require a version bump.**
