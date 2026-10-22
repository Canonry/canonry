# Lint Guards — Detailed Reference

Source of truth for `AGENTS.md` “Lint Guards (Critical)” summary. Lint runs on oxlint. Each guard's code lives in its plugin module (`eslint-rules/canonry-guards.js`, `canonry-vocabulary.js`, `design-tokens.js`), which oxlint loads as a JS plugin; its scope and exemptions live in `.oxlintrc.json`. **Every guard has its own rule id** — never add options to core `no-restricted-syntax` (overrides resolve rules last-wins, so a later block clobbers prior guards with no diagnostic).

**Never add options to the core `no-restricted-syntax` rule.** The linter resolves rules by id with LAST-WINS OVERRIDE across overlapping config blocks (ESLint flat config did, and `.oxlintrc.json` overrides do), so a second block that names an already-guarded tree does not add to the first — it REPLACES the first block's options, and the first guard stops reporting. There is no warning, no duplicate-rule diagnostic, and `pnpm lint` stays green. On 2026-08-05 four of the five `no-restricted-syntax` blocks were found dead this way: the vocabulary literal ban fired in none of the four trees it named, the GA4 dimension drift guard fired nowhere, and the AI-hostname ban was clobbered in `apps/web/src` and `packages/canonry/src` by the two raw-`fetch()` guards. Three AGENTS.md rules had been false for as long, and a dead guard is invisible from the outside — it reads exactly like a clean tree.

| Guard | Scope | Bans |
|---|---|---|
| `canonry-vocabulary/no-banned-metric-literal` | `packages/canonry/src/commands`, `…/cli-commands`, `packages/api-routes/src`, `apps/web/src`, `packages/contracts/src/visibility-display.ts` | Legacy/conflated AEO metric literals ("Vocabulary (Critical)" rule 7) |
| `canonry-vocabulary/no-question-ui-copy` | `apps/web/src`, `packages/contracts/src/visibility-display.ts` | "question" in UI copy ("Query vs question") |
| `canonry-guards/no-inline-ai-hostname` | `packages/canonry`, `api-routes`, `provider-*`, `integration-*`, `intelligence`, `apps/*` src | Raw AI-provider hostnames — use `AI_ENGINE_DOMAINS` |
| `canonry-guards/no-inline-percent` | `packages/canonry/src/commands`, `…/cli-commands`, `…/agent`, `apps/web/src`, `packages/api-routes/src`, `packages/intelligence/src`, `packages/contracts/src` (not `formatting.ts`) | A `%` right after a number rounded inline — show it with `formatPercent` |
| `canonry-guards/no-inline-ga4-dimension` | `packages/integration-google-analytics/src` | Raw GA4 dimension names — use `GA4_DIMENSIONS` |
| `canonry-guards/no-second-query-classifier` | every `packages/*/src` and `apps/**/src` (not `packages/contracts/src/query-class.ts`, not `packages/intelligence/src/query-categorize.ts`) | A hand-written branded / non-brand classifier for tracked queries. Use `compileQueryClassifier` ("One query classifier" below) |
| `canonry-guards/no-raw-http-web` | `apps/web/src` | `fetch()` / `XMLHttpRequest` — use the generated SDK |
| `canonry-guards/no-raw-http-cli` | `packages/canonry/src` | `fetch()` — use `ApiClient` / `createApiClient()` |
| `design-tokens/no-literal-palette` | `apps/web/src` | Raw Tailwind palette utilities ("Design tokens") |

### One query classifier

A tracked query is branded or non-brand through `compileQueryClassifier(effectiveBrandNames(project))` (`packages/contracts/src/query-class.ts`), or through the class an advanced measurement plan stored for it. Two checks keep a second classifier out.

`canonry-guards/no-second-query-classifier` (`eslint-rules/no-second-query-classifier.js`) reports the three shapes a hand-written classifier takes:

1. A conditional that turns something that is not a class into the two class literals: `nameHit ? 'branded' : 'non-brand'`.
2. A function that produces both class literals without comparing against one, whether it returns them, holds them in a variable (`let cls = 'non-brand'; if (hit) cls = 'branded'`) or writes them onto a row (`row.queryClass = 'branded'` in one branch, `'non-brand'` in the other).
3. A brand matcher primitive (`matcherMatchesText`, `matchedAliasKeys`, `textContainsBrandAlias`, `textContainsAnyBrandAlias`) whose text argument is named for a query (`query`, `queryText`, `row.query`, `keyword`, `q`).

Code that maps a class it was given is left alone: a test that compares against `'branded'` or `'non-brand'`, or a `switch` over a class, reads a class and does not derive one. The two exempt files are the classifier itself and `query-categorize.ts`, which sorts Search Console queries into its own enum (brand, lead-gen, industry, other) and is not the class of a tracked query. `test/no-second-query-classifier.test.ts` pins what the rule reports and what it leaves alone.

The rule cannot see a classifier that keeps only a boolean, never writes a class literal, and holds the text in a variable not named for a query. It also cannot see class literals written only as object fields or call arguments, because code that lists both classes looks the same. One existing helper has the first shape and is out of scope, not exempt: `filterBrandedSeedCandidates` (`packages/contracts/src/discovery.ts`) runs the brand matcher over discovery seed candidates and Search Console queries, with its own `branded` / `non-branded` labels in `ga-measurement-analysis.ts`. Neither is the class of a tracked query, so do not reuse it for one. `packages/api-routes/test/query-class-parity.test.ts` covers the blind spots from the other side: it asks each server surface that classes a tracked query (the query list, mention share inputs, the frozen simple sweep definition, the advanced draft proposal) about one fixture basket and compares each with a hand-written answer key. A new server surface that classes tracked queries adds itself to that test's `SURFACES`.

### Adding a guard

The guards that catch real defects here are the ones that compare two sources
that must agree, and they have caught changes to AGENTS.md more than once:
`db-dto-coverage` (a new table with no classification), `dashboard-class-baseline`
(a className with no stylesheet selector), `codegen-drift` (a route whose SDK was
not regenerated), `no-new-loose-routes`, `lint-guards`. When a change
introduces a new pair that must stay in step, prefer a guard over a convention —
see the "Lint Guards (Critical)" section of the root `AGENTS.md`.

1. Build it with `createRestrictedSyntaxRule` from `eslint-rules/restricted-syntax.js` (same behavior as `no-restricted-syntax`, under an id you choose), or write a custom rule module in `eslint-rules/` when the check needs more than a selector.
2. Register it in its namespace's plugin module (`eslint-rules/canonry-guards.js` or `eslint-rules/canonry-vocabulary.js`), then enable it in `.oxlintrc.json` with its `files` scope. Put any exemption in an `"off"` override directly after that block.
3. Add the rule id to the coverage matrix in `test/lint-guards.test.ts`, plus any file it deliberately exempts, and add a violation of it to that test's `PROBE`. The test lints the probe at a representative path in each guarded tree and asserts each guard reports at error severity, and stays silent where exempt; it is what catches a clobbered or misscoped guard, since lint output cannot.
4. If an AGENTS.md rule cites the guard, name the rule id there so the claim is checkable.
