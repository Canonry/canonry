# Brand Perception Check (Val Town)

This directory is the exact source mirrored to the public `canonry/Brand-Perception-Check` val. Git is authoritative; do
not make production-only edits in Val Town because `vt push` removes remote-only files.

## Naming

The Val is **Brand Perception Check**, not Canonry. It puts 3 branded questions to one engine, once, where Canonry
tracks four engines on a schedule with no such limits. Calling this "Canonry" would tell a visitor, or an agent reading
`serverInfo`, that they had the platform when they have a sample of it. So the product name, the page title, the
wordmark, and the MCP `serverInfo.title` all say Brand Perception Check.

`serverInfo.name` is the slug `brand-perception-check`, matching the sibling Val's `ai-visibility-check`. MCP's `name`
is the identifier a client keys off and `title` is where a human reads the display name; the shared contract wrote the
display name into `name`, and splitting the two is the deviation this file records.

Attribution runs the other way, and deliberately: every surface points back at the open-source project. The header
byline, the footer (with the install command), the MCP `initialize` instructions, the `self_host` tool, and the bundled
skills all name Canonry and link to it. Keep that; a sample that does not lead anywhere is just a toy.

## What this measures, and what it must never claim

**A verdict, carried by the answer's own sentences.** Each branded answer is read back for the position it takes —
`recommends`, `cautions`, `mixed`, `none` — and that verdict survives only when sentences copied WORD FOR WORD out of
the answer carry it. The model proposes and exact matching disposes; the kit's `verifyVerdict` is the arbiter, and a
verdict with no surviving evidence collapses to `none`. The page then QUOTES those sentences. That is the whole product:
a reader who does not believe a verdict can read the line it came from.

- **Never a sentiment score.** There is no number between 0 and 1 here and there must not be one. Nothing in this
  pipeline measures feeling, and a score would read as though something did.
- **`none` is a finding; `null` is not.** "Took no position" says the answer described the brand and took none.
  `null` says nobody read a position out of it — a failed probe or a failed extraction — and it leaves EVERY
  denominator, not just the verdict counts. Collapsing the second into the first turns an outage into a result.
- **Sources are "sources the answer engine attributed"**, typed as official / community / review / news / other. They
  are not "where opinions about this brand come from on the web": three answers cannot support that claim. The phrase
  may appear on the page only inside the tooltip that denies it, and `render.test.ts` enforces exactly that.
- **Concerns are the answer's own words.** A concern is a short phrase the answer wrote as a drawback, verified against
  the prose by the same adjacent-complete-words rule the brand matcher uses. It counts once per answer.

## Branded is a separate instrument, not a variant

Every question here NAMES the brand, so the engine was always going to discuss it. A mention rate over this basket
would read near 100% and mean nothing. AI Visibility asks NON-BRAND questions, where placement is actually decided.

The two never share a denominator, a table, or a rate, and the scope travels with every number: `scope: 'branded'` plus
a `scopeNote` on every MCP payload, and the branded framing in the section tooltips on the page. The repository's own
"Branded vs non-brand" rule is where this comes from — measured on a real basket, pooling the two inverted the ranking.

This is also why the two Vals cannot share a cache. `CHECK_FINGERPRINT_NAMESPACE` is `perception-v1`, and the kit's
`checkFingerprint(namespace, domain, userQueries)` takes it as a required argument with no default: a namespace two
products shared would hand each of them the other's result and report it as a cache hit. Bump THIS constant when THIS
Val's measured signal set changes, and never another Val's.

## Boundaries

- Keep the host Deno-native and web-standard. Do not import the Node Canonry server, Fastify, `better-sqlite3`, or the
  Vite dashboard.
- **The kit is the shared core; this Val is the product surface.** `@canonry/val-kit` owns the perception instrument
  (branded planner, verdict extraction and its arbiter, source typing, aggregation, the Gemini adapter); the URL and
  Turnstile guards; both `CheckStore` implementations; check-record identity and the generic admission/lease machinery;
  MCP framing and the generated skill resources; and the design tokens and mark. What stays here is what this Val IS:
  its HTTP routes and response policy, the check runner's phase and every sentence a visitor reads, its MCP tool
  surface, and its HTML. Moving one here is not a fork: delete the local copy and import the kit, or the two drift and
  only production finds out which one shipped.
- **This Val owns its own result schema, and the kit stores it opaquely.** `PerceptionCheckResult` and
  `CHECK_FINGERPRINT_NAMESPACE` live in `src/runtime/check-result.ts`. The kit sees them only as the `TResult` of
  `CheckRecord<PerceptionCheckResult>` — written as JSON, handed back untouched. The parameter is named once, at
  `new ValSqliteCheckStore<PerceptionCheckResult>(sqlite)` in `main.http.tsx`, and every record downstream is typed from
  there; a cast on the result path means the generic was dropped somewhere above it.
- The browser never receives provider, Turnstile-secret, deployment, or signing credentials.
- Anonymous work is bounded by human verification, atomic quotas, cache reuse, output clipping, and a hard provider
  deadline.
- **Never render data the Val did not measure.** The landing page ships an empty state, not a fixture. A fabricated
  verdict about a real brand is a worse lie than a fabricated percentage, and a badge in the header does not qualify it
  for anyone who scrolls.
- Never present the Val as the full platform. Bounds stay stated on the surface that shows the number.
- The bundled skills are generated into the KIT (`packages/val-kit/src/mcp/skills/`), not into this directory. Edit
  `skills/<name>/` at the repository root, then run `node scripts/sync-val-town-skills.mjs` and commit the result. CI
  runs it with `--check`. Never hand-edit a generated module.

## One phase, and its budget is arithmetic

There is exactly ONE phase: `createGeminiValPerceptionProbe(...).probe(...)`. No site crawl, no second track. Inside it
the work is strictly SEQUENTIAL — plan, then one probe wave, then one verdict extraction — so the worst cases ADD
rather than overlap, and there is no second phase to hide a slip behind:

```
plannerTimeoutMs (10s) + 1 wave x probeTimeoutMs (20s) + verdictTimeoutMs (12s) = 42s
                                                  <= PUBLIC_CHECK_WORK_BUDGET_MS (45s)
```

Four numbers across two packages, and nothing but `perception-budget.test.ts` connects them to the job ceiling. It
asserts the RELATIONSHIP, not the numbers: raising `maxProbeCalls` without raising `probeConcurrency` silently
reintroduces a second wave, and the cost shows up as a shorter per-probe deadline rather than as an error. It also pins
`verdictTimeoutMs === VERDICT_EXTRACT_LIMITS.timeoutMs`, because two constants that happen to match are two constants
and the budget stops being true the first time only one moves.

The whole check is five provider calls: 1 planner + 3 probes in one wave + 1 verdict extraction. That number is meant
to be noticed when a feature adds a call — it is the check on what a public visitor can make this Val spend.

## A failed check says why, and an unmeasured one is not a zero

`publicProbeError` translates each of the runner's closed-set failure strings into visitor wording ("answer engine",
not "provider") and falls back to a generic sentence for anything it does not recognize, so a sanitizer never trusts
its input. `perceptionPhaseError` does the same for a failure thrown before any probe ran — a phase that produced no
row still has to say why, or the check is unexplainable from every surface.

A planning failure gets its own sentence: **"Branded questions could not be generated for this brand."** That is a fact
about the BRAND, not about the engine, and the difference between "try again" and "this will not work".

`perception-runner.test.ts` drives the REAL probe runner into each failure and then asserts none of them lands on the
generic fallback. That is the guard: a new failure mode added upstream without a translation fails the suite instead of
silently erasing its own reason.

**Status is decided from what was measured.** `complete` when every answer produced a verdict, `partial` when some did
not, and `failed` when `successfulChecks === 0` — a report where nothing was measured has a zero in every denominator,
which is not a result with empty sections but a check that found nothing. The evidence rows survive a `failed` record,
so the page can still say why each answer was not measured. There is no configured ceiling here, so reaching one is
never the reason for a `partial`.

The UI reads the same evidence rather than the stored flag. `record.status` is frozen when the check runs, so
correcting the rule behind it never reaches a record already written; `hasFailedWork` looks at the rows instead, and a
stored `partial` with nothing failed reads as `ready`.

## UI

Match the Canonry dashboard's restrained evidence-first hierarchy: compact header, tables, native disclosure controls,
visible focus. Four sections, in this order, and `render.test.ts` pins the order:

1. **Verdict snapshot** — a flat KPI row. The counts are UNBOUNDED, so there is no bar and no meter: "2 of 3" has no
   target to fill and a bar would invent one. The denominator is written under every number, not once at the top,
   because the number and the bound it rests on have to be read together. With nothing measured the cells read
   "Not measured" rather than printing four zeroes.
2. **Answers** — one row per branded question: the question, the verdict badge, the answer's own first verified
   sentence (quoted), and the source count. A native `<details>` per row opens every verified sentence, the concerns,
   the typed sources, the searches the engine ran, and the full answer.
3. **Concerns raised** — phrase plus "in N of M answers". An empty list is STATED, not omitted: "no concern was raised"
   is a finding, and a missing section reads as a broken page.
4. **Sources the engine attributed** — by kind, counted once per answer, with the share and the unattributed remainder
   stated separately.

Other rules the tests hold:

- **Heavy explanation lives in tooltips, not inline prose.** Each section heading carries a CSS-only `info-tip`: a real
  `<button>` whose `aria-label` is the copy, opening on `:hover` and `:focus-within`. The page CSP allows no inline
  script, so a control that only works after a file loads is broken on first paint, and `:focus-within` only fires for
  something focusable.
- **Say it once.** "Sources the engine attributed" is a section heading; the per-row disclosure labels its list
  "Sources". The section-order test finds the first occurrence of a heading string, so a duplicate phrase earlier in
  the page fails it — which is how the duplication was caught.
- **A numeric column is aligned once, on the column.** `is-numeric` goes on the header AND every cell in that column,
  and one kit rule keys off it. The test walks every rendered table and asserts they agree. Note the lookahead in its
  header regex: `<th[^>]*>` also matches `<thead>` and silently shifts every column index by one.
- **No inline styles and no inline script**, because the page CSP blocks both.
- **The waiting view has ONE track.** The runner is genuinely sequential, but the server reports no phase, so naming
  three phases would tell the reader which one is running when nothing knows that. The bar is indeterminate for the
  same reason; elapsed time is counted, not guessed.
- **Copy the client rewrites lives in one constant.** `client.ts` rewrites the query hint's whole line on every
  keystroke, so a sentence added only to the server markup is on the page until the visitor types and then silently
  disappears. `QUERY_HINT_SUFFIX` is declared once in `client.ts` and imported by `render.ts`; that direction avoids a
  cycle, since `render.ts` already imports the script.

### Styles: the kit's, extended rather than forked

`src/ui/styles.ts` concatenates `canonryDemoStyles` with the handful of rules this product needs — the verdict row, the
quotation lists, the concern list, and `.signal-negative` (the kit's signal vocabulary has no negative, because the
sibling Val has no negative signal). They are written in the kit's own token vocabulary, so the two Vals read as one
surface. The kit is NOT edited to hold them: a rule no other Val can use is not a shared value, and the seam says a
product's own surface stays with the product. A literal hex here instead of a token would be the first step to two
design systems, and a test pins the tokens.

## MCP endpoint

`POST /mcp` serves Model Context Protocol over Streamable HTTP so an agent can read this Val's checks directly. Five
tools: `get_check`, `get_brand_perception`, `start_check`, `self_host`, `read_skill`.

- **Reads never spend.** `get_check` and `get_brand_perception` resolve through `store.get` and `store.findReusable`
  only. They must never reach `admit` or `dispatch`; a test asserts an uncached domain lookup leaves the store
  untouched and spends no quota.
- **`start_check` is the only tool that spends,** and it runs the host's full admission path. It skips Turnstile, which
  an agent cannot solve, and spends from its own `mcp:` quota subject with its own daily limit. It keeps sharing the
  global daily cap and the single execution lease: the global cap is what bounds the bill, so MCP may widen who spends
  the budget but never how large it is. Disable with `CANONRY_MCP_START_CHECKS=0`.
- **It blocks.** Execution is request-bound (`AbortSignal.timeout(45_000)`); there is no background queue, so returning
  a check ID early would kill the work with the request.
- **Anonymous, on purpose.** Everything reachable here is already public: `/api/checks/:id` serves any check without a
  credential, and the skills ship in a public npm package.
- **The skill INDEX is `resources/list`, not a tool.** `read_skill` reads one document and its description says where
  the index is. The sibling Val also ships `list_skills` for clients with no resource support; this one does not, which
  is the second deviation from the shared contract's tool list — it enumerated five tools and `list_skills` was not
  among them.
- **Every payload carries `scope: 'branded'` and a `scopeNote`,** and a test asserts no numbered payload leaves without
  one. The summary is passed straight through from the record and never recomputed on the read path: deriving it a
  second time is how a tool payload starts disagreeing with the page.
- **Two protocol eras.** Revision `2026-07-28` removed sessions and the GET stream; every shipping client still opens
  with `initialize`. Both work. Keep the strict mirrored-header checks keyed off the version the caller declared, or
  legacy clients break.

## Dependencies

Every dependency is fully qualified at the import site (`npm:hono@4.12.25`, `npm:@canonry/val-kit@0.2.0/jobs`,
`https://esm.town/v/std/sqlite/main.ts`). Val Town resolves the module graph from esm.town and does NOT apply a pushed
`deno.json` import map, so a bare specifier deploys and then throws `not a dependency and not in import map` at the
first request. `deno.json` therefore excludes the `no-import-prefix` lint rule, which enforces the opposite convention.

The kit pin is therefore repeated in every file that imports it — N places to drift instead of one manifest key — and
`packages/canonry/test/val-kit-dependency-contract.test.ts` asserts each Val's inline specifiers collapse to exactly one
version equal to `packages/val-kit/package.json`. It iterates `apps/vals/*`, so this Val was covered the day it landed.

### Two configs, because the kit is resolved from two different places

`deno.json` is PUSHED. It is the production graph and must describe only what Val Town can see: the public registry. A
`links` entry there would point at a workspace no deployed Val has, and a shared `lock` would be rewritten with a
resolution production cannot reproduce. So it carries no `links`, no `nodeModulesDir`, and no `lock` key, and the
contract test fails if one appears.

`deno.dev.json` is LOCAL, and `.vtignore` keeps it (and `deno.dev.lock` and `node_modules/`) out of the push. It
duplicates `compilerOptions`, `lint`, and `fmt` — Deno has no `extends` — and adds `links: ["../../../packages/val-kit"]`,
`nodeModulesDir: "auto"` (linking an npm package REQUIRES a node_modules directory; without it Deno refuses outright),
and its own `lock: "deno.dev.lock"`. That is what lets one PR change the kit and this Val together, before the kit is
published. `deno.dev.lock` is committed, because `--frozen` needs it and CI checks out fresh.

**There is no production `deno.lock` yet, and there cannot be one.** It is generated by resolving the production graph
against public npm, and `@canonry/val-kit@0.2.0` is not published. Creating it is step 3 of the release order below.

**Build the kit first.** Deno consumes an npm package as built JavaScript, and the kit's `exports` point at `dist/`, so
`pnpm --filter @canonry/val-kit build` has to run before any Deno task here. The `check`, `test`, and `dev` tasks guard
on `dist/index.js` and say so rather than failing inside a resolution error. Deno re-syncs its copy of a linked package
whenever that `dist/` changes, so rebuilding is the whole refresh step.

## Fixed public limits

- A visitor may supply up to three questions; the planner generates only the remainder, and is not called at all when
  all three are supplied. A supplied question need not name the brand — the visitor chose it — while a GENERATED one
  must, and the planner drops any that does not. Supplied questions are IDENTITY, not tuning: they join
  `checkFingerprint`, so two callers asking different things about one brand never share a cached result.
- One grounded Gemini planning call creates the questions the visitor did not supply.
- Three Gemini answers run in one wave.
- One bounded extraction call reads all three answers back for the position each takes.
- The full request stops after 45 seconds.
- Turnstile, daily quotas, one active job, and a 24-hour cache bound public use.

## Local development

```sh
deno task dev                      # http://localhost:8788 — stub runner, no network
GEMINI_API_KEY=… deno task dev     # real Gemini planner, probes, and verdict extraction
```

In-memory storage and no Turnstile, so the UI and `/mcp` both work without credentials. The offline stub composes its
summary with the REAL `summarizePerception`, so it cannot hand the page a headline its own rows do not support — the
one thing a fixture must never be allowed to do here. It also always includes one unmeasured row, so the
null-is-not-`none` contract is visible in every hand test. `npx @modelcontextprotocol/inspector` against
`http://localhost:8788/mcp` drives the endpoint as a real client would.

## Verification

Run `pnpm --filter @canonry/val-kit build` from the repository root, then `deno task check`, `deno task lint`, and
`deno task test` from this directory, plus `node scripts/sync-val-town-skills.mjs --check` from the root. Those three
tasks validate the DEV graph. Vals have no CI/CD, so nothing runs them for you.

`deno task check:prod` validates the PRODUCTION graph instead (plain `deno.json`, `--frozen`). It cannot pass until the
pinned kit version is on public npm — before that it fails with `npm package '@canonry/val-kit' does not exist` — and
with no deploy workflow it is the only thing that catches an unpublished pin before `vt push`.

## Production configuration

Set in Val Town: `VAL_TOWN_ENV=production`, `GEMINI_API_KEY`, `CANONRY_QUOTA_SALT`, `TURNSTILE_SECRET_KEY`,
`TURNSTILE_SITE_KEY`, `TURNSTILE_ALLOWED_HOSTNAMES`. Optional: `CANONRY_MCP_START_CHECKS=0` removes the MCP write tool;
`CANONRY_MCP_PER_CLIENT_DAILY_LIMIT` sets its daily per-caller allowance (default 2).

Public checks are disabled when the production quota salt or Turnstile configuration is absent, so an unconfigured
deployment serves reads and skills but refuses to spend.

## Release order

Nothing here has been deployed yet. Deploys are manual: there is no deploy workflow, so every step below is run by hand.

1. **Create the Val in Val Town** and link this directory to it with `vt`. `.vt/state.json` is gitignored
   (`apps/vals/*/.vt/`), so the Val and branch identity live only on the machine that deploys.
2. **Publish the pinned `@canonry/val-kit` version** with `pnpm --filter @canonry/val-kit publish`. Until then the
   production graph cannot resolve and `check:prod` fails closed.
3. **Create the production `deno.lock`** with `deno check --allow-import main.http.tsx` (plain config, no `--frozen`)
   and commit it. This is only possible after step 2. `deno.dev.lock` is separate and is not touched by this.

> **Deno blocks a freshly published version for 24 hours.** `deno check` applies a
> minimum dependency age policy (default 24h) to reduce supply-chain risk, so the
> step above fails with "blocked by the minimum dependency age policy" if the kit
> was published minutes ago. Pass `--min-dep-age 0` to generate the lock anyway —
> defensible for a first-party package this repo just built and published from a
> reviewed commit. The override is only needed to CREATE the lock: once the lock
> pins the version with its integrity hash, `--frozen` resolves from the lock and
> the policy does not apply, so later checks and deploys need no flag and no config.
4. Regenerate the skill mirror with `node scripts/sync-val-town-skills.mjs`.
5. Run the verification commands above, including `deno task check:prod`.
6. Run `vt push --dry-run` and review the file plan.
7. Run `vt push` only after approval.
8. Request `/healthz` and confirm `{"ok":true}`.

`vt push` makes the Val match this directory. It deletes remote-only files, so do not edit production in the Val Town
editor.

## What is copied from the sibling Val, and what to hoist next

There are two Vals now, which is the point at which "copied" becomes "duplicated". These files are identical or nearly
identical to `apps/vals/ai-visibility-check/`, and are the next hoist into `@canonry/val-kit`:

| File | Difference from the sibling |
|---|---|
| `src/app/app.ts` | The result type parameter and two import paths. Nothing else. **The strongest hoist candidate:** routes, CSP, capability URLs, Turnstile, admission/quota/lease flow, body limits, and `/healthz` are product-agnostic already. |
| `src/mcp/server.ts` | `SERVER_INFO` and `INSTRUCTIONS`. The dispatch, the two protocol eras, the body cap, the origin check, and the error envelope are identical. A kit `createMcpHandler({ serverInfo, instructions, tools })` would take all of it. |
| `src/ui/check-form.ts` | One submit label. |
| `src/ui/client.ts` | The sibling's tab code is absent and the fallback submit label differs. The query-hint rewrite and the waiting-view enhancement are the same. |
| `src/jobs/*.ts` (the lease/claim/renew/finalize preamble) | Identical up to the phase itself. The sanitizers and the copy are genuinely per-product and stay. |
| `src/ui/render.ts` (escaping, `safeUrl`/`safeHref`/`safeHost`, `assetUrl`, `renderNotice`, `renderInfoTip`, `formatTime`) | Identical helpers. The sections are per-product and stay. |
| `test/backend/app.test.ts`, `test/backend/mcp.test.ts` | Fixtures and payload names. The admission, quota, capacity, CSP, and protocol cases are the same suite twice. |

Two things deliberately did NOT move: the check runner's phases and every sentence a visitor reads. The admission test
is mechanical — a module that references a perception phase, string, or this product's own offering is not generic,
whatever else is true of it.

## README

`README.md` is rendered on the public val.town page, so it is marketing copy for a stranger who has never heard of
Canonry — not a contributor document. Keep implementation detail, limits rationale, and operational procedure here in
`AGENTS.md` instead.
