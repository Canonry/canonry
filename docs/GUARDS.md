# Lint Guards — Detailed Reference

Source of truth for `AGENTS.md` “Lint Guards (Critical)” summary. All guards live in `eslint.config.js`; **every one has its own rule id** — never add options to core `no-restricted-syntax` (flat config last-wins override clobbers prior guards with no diagnostic).

**Never add options to the core `no-restricted-syntax` rule.** ESLint flat config resolves rules by id with LAST-WINS OVERRIDE across overlapping config objects, so a second block that names an already-guarded tree does not add to the first — it REPLACES the first block's options, and the first guard stops reporting. There is no warning, no duplicate-rule diagnostic, and `pnpm lint` stays green. On 2026-08-05 four of the five `no-restricted-syntax` blocks were found dead this way: the vocabulary literal ban fired in none of the four trees it named, the GA4 dimension drift guard fired nowhere, and the AI-hostname ban was clobbered in `apps/web/src` and `packages/canonry/src` by the two raw-`fetch()` guards. Three AGENTS.md rules had been false for as long, and a dead guard is invisible from the outside — it reads exactly like a clean tree.

| Guard | Scope | Bans |
|---|---|---|
| `canonry-vocabulary/no-banned-metric-literal` | `packages/canonry/src/commands`, `…/cli-commands`, `packages/api-routes/src`, `apps/web/src`, `packages/contracts/src/report-sections.ts` | Legacy/conflated AEO metric literals ("Vocabulary (Critical)" rule 7) |
| `canonry-vocabulary/no-question-ui-copy` | `apps/web/src`, `packages/contracts/src/report-sections.ts` | "question" in UI copy ("Query vs question") |
| `canonry-guards/no-inline-ai-hostname` | `packages/canonry`, `api-routes`, `provider-*`, `integration-*`, `intelligence`, `apps/*` src | Raw AI-provider hostnames — use `AI_ENGINE_DOMAINS` |
| `canonry-guards/no-inline-ga4-dimension` | `packages/integration-google-analytics/src` | Raw GA4 dimension names — use `GA4_DIMENSIONS` |
| `canonry-guards/no-raw-http-web` | `apps/web/src` | `fetch()` / `XMLHttpRequest` — use the generated SDK |
| `canonry-guards/no-raw-http-cli` | `packages/canonry/src` | `fetch()` — use `ApiClient` / `createApiClient()` |
| `design-tokens/no-literal-palette` | `apps/web/src` | Raw Tailwind palette utilities ("Design tokens") |

### Adding a guard

1. Build it with `createRestrictedSyntaxRule` from `eslint-rules/restricted-syntax.js` (same behavior as `no-restricted-syntax`, under an id you choose), or write a custom rule module in `eslint-rules/` when the check needs more than a selector.
2. Register it in the shared `canonryGuardsPlugin` / `canonryVocabularyPlugin` object — one object per namespace, reused by reference. Flat config throws `Cannot redefine plugin` if a namespace gets two different objects.
3. Add the rule id to the coverage matrix in `test/eslint-guards.test.ts`, plus any file it deliberately exempts. That test resolves the real config per tree and asserts each guard is enabled at error severity; it is what catches a clobbered or misscoped guard, since lint output cannot.
4. If an AGENTS.md rule cites the guard, name the rule id there so the claim is checkable.
