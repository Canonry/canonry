# AI Visibility Check (Val Town)

This directory is the exact source mirrored to the public `canonry/AI-Visibility-Check` val. Git is authoritative; do not make
production-only edits in Val Town because `vt push` removes remote-only files.

## Naming

The Val is **AI Visibility Check**, not Canonry. It runs 3 generated queries against one engine and audits 5 pages,
where Canonry tracks four engines on a schedule with no such limits. Calling this "Canonry" would tell a visitor, or
an agent reading `serverInfo`, that they had the platform when they have a sample of it. So the product name, the val
name, and the MCP `serverInfo.name` all say AI Visibility Check.

Attribution runs the other way, and deliberately: every surface points back at the open-source project. The header
byline, the footer (with the install command), the MCP `initialize` instructions, the `self_host` tool, and the
bundled skills all name Canonry and link to it. Keep that; a sample that does not lead anywhere is just a toy.

## Boundaries

- Keep the host Deno-native and web-standard. Do not import the Node Canonry server, Fastify, `better-sqlite3`, or the
  Vite dashboard.
- Import reusable code through exact pins. Technical AEO uses `@canonry/aeo-audit`; everything a public check runs ON
  comes from `@canonry/val-kit`.
- **The kit is the shared core; this Val is the product surface.** `@canonry/val-kit` owns the visibility contracts,
  brand matcher, evidence runner, share of voice, and Gemini adapter; the URL and Turnstile guards; both `CheckStore`
  implementations; check-record identity and the generic admission/lease machinery; MCP framing and the generated skill
  resources; and the design tokens and mark. What stays here is what this Val IS: its HTTP routes and response policy,
  the check runner's phases and every sentence a visitor reads, the Technical AEO adapter, its MCP tool surface, and its
  HTML. The admission test is mechanical — a module that references a visibility or site-health phase, string, or the
  product's own offering is not generic, whatever else is true of it. Moving one here is not a fork: delete the local
  copy and import the kit, or the two drift and only production finds out which one shipped.
- **This Val owns its own result schema, and the kit stores it opaquely.** `CheckResult` and
  `CHECK_FINGERPRINT_NAMESPACE` live in `src/runtime/check-result.ts`; the Technical AEO sample's types
  (`SiteHealthSample`, `SiteMapNode`, `FactorSample`, `SiteHealthRunner`, …) live in `src/site-health/types.ts`. The
  kit sees them only as the `TResult` of `CheckRecord<CheckResult>` — written as JSON, handed back untouched — which
  is what lets a second Val store a completely different result through the same admission, lease, and quota
  machinery. The parameter is named once, at `new ValSqliteCheckStore<CheckResult>(sqlite)` in `main.http.tsx`, and
  every record downstream is typed from there; a cast on the result path in this Val means the generic was dropped
  somewhere above it. What stayed in the kit is the visibility INSTRUMENT's output and ports —
  `VisibilityReport`, `VisibilityEvidence`, `VisibilityProbePort` — because they are what a probe PRODUCES, not what
  a product stores.
- The browser never receives provider, Turnstile-secret, deployment, or signing credentials.
- Anonymous work is bounded by human verification, atomic quotas, cache reuse, output clipping, and hard provider/crawl
  deadlines.
- `allowPrivateHost` names the ONE host being crawled, per attempt, and must never be widened. Val Town grants no DNS
  (`Deno.resolveDns` has no net access to the resolver, `node:dns.resolve4` returns UNKNOWN), so the engine's
  resolve-then-check SSRF guard fails closed on every hostname and the crawl audits zero pages for every domain. The
  option is a hostname rather than a boolean precisely so the guard cannot be switched off: a matching host skips the
  DNS preflight and IP pinning, and every other host, including a redirect to cloud metadata, is still resolved and
  still blocked. Two layers below it, `normalizePublicDomain` has already rejected private hosts at the input
  boundary, and Val Town's sandbox refuses fetches to 169.254.169.254, 127.0.0.1, 10/8 and 192.168/16 outright.
- Keep Technical AEO labeled as a bounded page sample, not a whole-site score.
- Mention and citation are independent signals. Summary denominators contain successful checks only; failures stay
  visible.
- The visibility core (`contracts`, `runtime`, `brand`, `runner`) must not read environment, storage, or HTTP state.
  Only the Gemini adapter makes provider calls; the host owns credentials, quotas, and scheduling. That is now the
  kit's own seam rule — see `packages/val-kit/AGENTS.md` — and it is why `loadValTownConfig` takes the environment as
  an argument rather than reading `Deno.env` itself.
- **Never render data the Val did not measure.** The landing page ships an empty state, not a fixture. It previously
  drew a four-engine trend with invented model identifiers, labelled only by a badge in the page header, well above
  the numbers it qualified — anyone who scrolled read fabrication as measurement, and it advertised three engines this
  Val does not run. A fresh check is a single Gemini snapshot; there is no history to draw and none may be invented.
- Never present the Val as the full platform. Bounds stay stated on the surface that shows the number.
- The bundled skills are generated into the KIT (`packages/val-kit/src/mcp/skills/`), not into this directory. Edit
  `skills/<name>/` at the repository root, then run `node scripts/sync-val-town-skills.mjs` and commit the result. CI
  runs it with `--check`. Never hand-edit a generated module.

## MCP endpoint

`POST /mcp` serves Model Context Protocol over Streamable HTTP so an agent can read this Val's checks directly. It is
additive: every browser route is unchanged, and the endpoint shares the same `CheckStore`, so an agent sees exactly the
checks the UI shows.

- **Reads never spend.** `get_check`, `get_ai_visibility`, and `get_site_health` resolve through `store.get` and
  `store.findReusable` only. They must never reach `admit` or `dispatch`; a test asserts an uncached domain lookup
  leaves the store untouched.
- **`start_check` is the only tool that spends,** and it runs the host's full admission path. It skips Turnstile,
  which an agent cannot solve, and spends from its own `mcp:` quota subject with its own daily limit. It must keep
  sharing the global daily cap and the single execution lease: the global cap is what bounds the bill, so MCP may
  widen who spends the budget but never how large it is. Disable with `CANONRY_MCP_START_CHECKS=0`.
- **It blocks.** Execution is request-bound (`AbortSignal.timeout(45_000)`); there is no background queue, so
  returning a check ID early would kill the work with the request.
- **Anonymous, on purpose.** Everything reachable here is already public: `/api/checks/:id` serves any check without a
  credential, and the skills ship in a public npm package. A token would gate nothing and would make the endpoint
  useless as something an agent is simply pointed at.
- **Two protocol eras.** Revision `2026-07-28` removed sessions and the GET stream; every shipping client still opens
  with `initialize`. Both work. Keep the strict mirrored-header checks keyed off the version the caller declared, or
  legacy clients break.
- Responses are always `application/json`. Nothing here streams, so do not add an SSE encoder.
- `self_host` is the conversion path and costs nothing. Keep it in the read set and keep its comparison honest.
- Mention and citation stay independent in tool output, and a failed check stays `null` rather than becoming `false`.

## Share of voice

The kit's `visibility/share.ts` ranks every domain the engine attributed as a source across the answers.

- **It is CITATION share, and the label must say so.** Mention share needs the rivals' brand names so they can be
  matched in the answer text. A public check has no competitor list, and the probe contract in
  the kit's `visibility/contracts.ts` forbids the shortcut: brand names are exact approved aliases and a prose alias is
  never derived from a domain. Inferring "stripe.com is in the sources, so the word Stripe here is a rival mention"
  is precisely the guess that contract rules out. Do not add it.
- **A domain counts once per answer, never once per link.** Ten links to one documentation site is one site holding
  one answer; counting links would let a single well-linked page outrank a domain cited across every answer.
- **A failed answer is unmeasured and cannot enter the denominator.** A successful answer that attributed no source is
  counted separately and stated, because an answer with no sources is not an answer where rivals won.
- **The checked site keeps its row even at 0%,** and absorbs its own subdomains. A measured zero is the finding; a
  missing row reads as an error. The first version re-inserted the target only when it ranked BELOW the display cut,
  which silently dropped it whenever it was never cited at all: a domain absent from the ranking has no rank. Assert
  the ROW exists, not just that `targetShare` is zero, or the test passes while the UI omits it.
- **Two bases, one ranker, never blended.** `Mentioned` is brands named in the answer prose; `Cited` is domains the
  engine attributed as sources. They are independent signals with separate tables, captions, column headers, and
  denominators, and `rank()` is shared so ordering, the display cut, and the tail cannot drift between them. The switch
  is two radios and a general-sibling CSS selector, never script: the page CSP blocks inline script, and a control that
  only works once an external file has loaded is broken on first paint. Radios also carry real keyboard semantics.
- **Mention share exists only because of `mention-extract.ts`.** A mention is a name written in text, and nothing before
  the probes run knows the rivals' names. Deriving one from a cited domain is the exact inference `contracts.ts`
  forbids, so instead the model PROPOSES and exact matching DISPOSES: one extra bounded call lists the names each
  answer writes, and every proposal is re-verified with `namesWrittenIn`, the same adjacent-complete-words rule the
  target's own verdict uses. An invented, expanded, or translated name is not in the prose, so it is dropped. The
  target's row is counted from its OWN `mentioned` verdict, never from the extraction, because its aliases are approved
  and the extraction's are proposals.
- **The extraction constrains its own output.** It uses no tool, so unlike the planner it can set `responseMimeType` +
  `responseSchema`; the planner has to hand-parse a fence because Gemini 2.5 refuses structured output alongside
  `googleSearch`. `thinkingBudget: 0` is set for the same reason the first live run returned nothing: thinking is on by
  default on 2.5 and bills from the same output allowance, so a reasoning model can spend the whole budget before
  writing a character and return empty text. Copying names out of a text needs no reasoning.
- **`namedBrands: null` is unmeasured, not empty.** An answer the extraction never covered leaves the mention basis out
  of the denominator entirely. Counting it as naming nobody would deflate every share by an outage instead of
  reporting one.
- **The Val budget is now five provider calls** (1 planner, 3 probes, 1 extraction), pinned by
  the kit's `visibility-gemini.test.ts`. That number is meant to be noticed when a feature adds a call.
- **It is a donut, and the hole is the point.** The target's own share is written into the ring's centre and stated
  nowhere else. A share chart where the reader hunts for their own row has buried its own headline, and the section
  header used to print the same number a second time. Arc lengths come from the COUNTS, never from the rounded display
  percent: eight rows each rounded to 5% leave a ring visibly short of closing. Geometry rides on SVG attributes
  (`stroke-dasharray`, `stroke-dashoffset`), never inline style, because the page CSP blocks the latter. One neutral
  ramp drives both the arc stroke and the legend swatch through a `--share-color` custom property, so a colour is
  written once.
- **The tail is a stated fact, not a row.** Folding it into `entries` printed "12 more sites, 12 of 2 answers", where
  the answers column counted appearances spread over twelve domains against the answer count. It is its own field, it
  keeps its bar segment, and the head plus the tail still total 1.
- Segment geometry is SVG attributes, never inline style: the page CSP blocks inline styles. The checked site is the
  only coloured segment; rivals sit on a neutral ramp, because hues would imply a taxonomy that does not exist.

## The engine pin lives in source, so the bump sweeps source

Val Town ignores an import map, so every import is fully qualified inline:
`npm:@canonry/aeo-audit@<version>`, repeated in each file that imports the engine. That is N places to drift instead of
one `deno.json` key.

`scripts/bump-aeo-audit.mjs` therefore SWEEPS `apps/vals/ai-visibility-check/src`, `test`, and `main.http.tsx` rather than editing a manifest
key, and `aeo-audit-dependency-contract.test.ts` asserts the set of inline specifiers collapses to exactly one version
that equals Canonry's pin. Both were written against the import map the val briefly had; the bump would have thrown on
every engine release and the val would have sat on an old engine while Canonry moved.

A new file importing the engine is picked up with no change to either, which is the point of scanning rather than
listing.

`npm:@canonry/val-kit@0.2.0/<subpath>` is the same pattern for the same reason, and it is guarded the same way:
`packages/canonry/test/val-kit-dependency-contract.test.ts` asserts each val's inline kit specifiers collapse to one
version, that it equals `packages/val-kit/package.json`, and that the two Deno configs stay on their respective sides
of the seam. It iterates `apps/vals/*`, so a second val is covered on the day it lands. The deploy workflow repeats the
version half against public npm, because a pin CI resolved from the workspace still has to exist on the registry before
Val Town can resolve it.

## "Partial" was written in THREE places, and fixing one hid the other two

Reaching a configured ceiling was framed as a failure in three independent spots, all keyed off the same frozen
`status`:

1. the top-level `Partial result` banner (`statusCopy` in `render.ts`, via `mapStatus`),
2. a `Partial site sample` notice inside Site Health (`mapSiteHealth`), and
3. `Partial termination: <reason>` in the Sample scope disclosure.

Each was fixed in turn, and after each one the banner "was gone" — because the fix was verified by grepping for that
one string. Grep for the CONCEPT (`grep -oiE 'partial[a-z ]*'`) and render a real record, not for the sentence you
just changed.

All three now key off whether work actually failed. The third keeps the reason visible as evidence and only changes
the framing: `Stopped at a configured limit: max pages` for a `max-*` reason, `Crawl ended early: <reason>` for
anything else.

## The caution is read from the evidence, not from a stored flag

`record.status` is decided once, when the check runs, and persisted. That makes it the wrong thing to warn a reader
off. Correcting the rule behind it does NOT correct the records already written: every check from before the
bounded-sample fix kept `status: 'partial'` for its whole 24h life, so a reader opening a shared link still got
"Partial result — Failed checks are shown separately" over a run with zero failed probes and a completed crawl. The
fix shipped and the screenshot still showed the banner, because the fix could only reach checks that had not happened
yet.

`hasFailedWork` reads the result instead: a probe left unmeasured (`mentioned` and `cited` both null), a crawl with
`status: 'error'`, or a recorded phase error. A stored `partial` with none of those reads as `ready`. Any of them
still raises the caution, so a real failure is never swallowed.

This is the same principle as the factor ordering: a presentation decision over stored data belongs at READ time, not
frozen into the row. It also makes the next semantic correction retroactive for free.

## A bounded sample reaching its own ceiling is COMPLETE

The crawler's `summary.complete` means "the crawler saw the whole site". This sample is designed never to do that:
`maxPages` is 5. So `max-pages` fired on every real site, site health reported `partial`, that marked the whole record
partial, and an amber "Partial result — Only completed checks are included below. Failed checks are shown separately."
sat at the top of every single report, over runs where nothing had failed. A caution on 100% of results is not a
caution; it is the first thing a reader sees and it says the product is broken.

`isCompleteBoundedSample` keys off the termination reason instead. Every `max-*` reason names a limit configured in
`VAL_TOWN_SITE_HEALTH_LIMITS`, so reaching one is the sample working. `root-host-redirect` — the only reason today
that is not one of ours — stays partial, because it means the crawl never reached the host that was asked for. An
empty sample is still an `error`: hitting a ceiling cannot upgrade one. The reason itself was always shown under
"Sample scope" and still is; only the STATUS was wrong.

**Drive the browser path, not just MCP.** This survived every test and every MCP check because `start_check` over MCP
bypasses Turnstile, and the notice is rendered from the record status by the UI. It took one real submission through
the form to see it.

## Every Gemini call needs an explicit thinking budget

Gemini 2.5 thinks by DEFAULT and bills those tokens against `maxOutputTokens`. A call that does not set
`thinkingConfig` can therefore spend its whole allowance reasoning and return a response with NO TEXT. It presents as
lost data, never as an error.

The same bug landed three separate times before the pattern was obvious:

| call | symptom | budget |
|---|---|---|
| `mention-extract.ts` | mentions silently unmeasured | `0` — copying names out needs no thought |
| probe adapter | "returned no answer text", one lost answer per check | `512` of 2,400 — it simulates an engine, so some reasoning is wanted |
| planner | "returned invalid JSON" from `JSON.parse('')`, losing every generated question | `0` of 1,200 — emitting a small JSON object needs no thought |

The kit's `visibility-gemini.test.ts` drives all three through a capturing client and fails if any omits an explicit
budget, or sets one that could consume its whole allowance. A new call site cannot inherit the default quietly.

## An empty answer says which of eleven things happened

`FinishReason` is a closed provider enum, and every value is mapped to a safe sentence. Mapping only the likely ones
left the rest falling through to "contained no answer text", which is where the diagnosis had already been destroyed
twice: the same probe failure got investigated from scratch each time because the message could not distinguish a
truncated answer from a refused one from one never attempted.

`STOP` with no text is a real, observed outcome — the model ends cleanly and writes nothing — and it reads as "the
answer engine finished without saying anything for this question". That is a finding, not a bug: the signals stay
`null`, because a brand cannot be absent from an answer that does not exist.

## One flaky call must not cost the whole visibility phase

Three things each turned a single transient failure into TOTAL visibility loss. All three are fixed, and all three
were found by reading real failed checks rather than by testing.

- **The planner demanded an EXACT query count.** Two usable queries out of three threw, and the reader got nothing
  instead of two answers. Fewer than requested is a smaller sample; only ZERO is a failure, because then there is
  nothing to ask.
- **Nothing retried.** `maxRetries: 0` on both the planner and the probe adapter, with `withBoundedRetry` wired and
  disabled. A transient 503 on one probe lost that answer outright, and one on the planner lost the entire phase.
  Both now retry once, INSIDE the deadline the call already holds, so the budget arithmetic is unchanged. The
  regression fixture proves the value: its retryable 429 used to report 2 successful / 1 failed and now reports 3 / 0.
- **A planning failure discarded questions the VISITOR typed.** `probe()` rejected whole when `planner.plan()` threw,
  even with supplied queries in hand. Those are perfectly good probes; losing them because our generator hiccuped
  returns an empty report for work the visitor already specified. A planning failure is now fatal only when it leaves
  nothing to probe.

The call-count pin in the kit's `visibility-gemini.test.ts` moved 5 -> 6 to cover the retry. That number is meant to
be noticed: it is the check on what a public visitor can make this val spend.

## The probe budget is arithmetic, not a guess

Three deadlines in three files have to fit inside one ceiling: `plannerTimeoutMs` + probe waves x `probeTimeoutMs` +
`MENTION_EXTRACT_LIMITS.timeoutMs` <= `PUBLIC_CHECK_WORK_BUDGET_MS`. Nothing but `probe-budget.test.ts` connects them.

They last disagreed in a way that cost the product: three probes at concurrency 2 need TWO waves, so the phase's worst
case was `10 + 2x10 + 12 = 42s` against a 45s ceiling. There was no room left to give a probe a realistic deadline, so
`probeTimeoutMs` sat at 10s — and a grounded `googleSearch` answer regularly runs past that. A real check timed out on
ALL THREE probes. The 10s was never a judgement about Gemini; it was all the budget there was.

Running every probe in one wave (`probeConcurrency >= maxProbeCalls`) buys back a whole wave and pays for a 20s
deadline. Measured after: 3 of 3 successful in 16s wall clock. Raising `maxProbeCalls` without raising concurrency
silently reintroduces the second wave, so the test asserts one wave rather than asserting the numbers.

## A phase that produced no rows still says why

`publicProbeError` preserves why one PROBE failed. `visibilityPhaseError` preserves why the whole PHASE did — a
planning failure or a provider failure thrown before any probe ran. Without it a check that threw early reported "The
AI Visibility sample could not complete." and had no evidence rows to carry a reason either, so it was unexplainable
from every surface.

Provider failures route through the same `safeProviderErrorMessage` classifier the row path uses, so the two cannot
describe one outage differently. Planning failures get their own sentence, because "questions could not be generated
for this domain" is a fact about the DOMAIN and the difference between "try again" and "this will not work".

## A failed start must not look like a bounce

`.form-busy` carries two different things: "Starting check…" and the reason a check failed. They used to be the same
13px `--secondary` line, sitting directly under `#queries-help`, which is also 13px `--secondary`, and `.check-facts`
at 12px muted. So when `restore()` hid the waiting view and un-hid the hero, the page appeared to bounce back to the
form with nothing said, while the reason sat on screen as the fourth of four near-identical grey lines.

A failure now gets `is-error`, which reuses the `.verification-unavailable` treatment already in the stylesheet
(`--caution`, circled `!`). The glyph is generated content, not markup, because the message is set with `textContent`.
`markBusy()` clears the class, so a previous failure cannot outlive the next submit.

The stub `classList` in `render.test.ts` had only `toggle` and `contains`. Adding `add`/`remove` was needed, and the
existing behavioural test caught the missing method immediately, which is the argument for driving the real script in
the harness rather than asserting on its source. The failure half still needs a `FormData` stub to drive, so it is
pinned at the source; the clear-on-submit half is behavioural.

## A basis with no data is offered and explained

The section renders BOTH radios always. A basis with nothing to show gets a pane saying so and a dimmed label, and the
default selection lands on a basis that has data so the page never opens onto an empty pane.

It used to render only the bases it had, which meant a check with no mention data lost the control entirely. A reader
cannot tell a missing control from a broken page, and asked twice why the toggle was gone. This is not only about
records written before the extraction shipped: the extraction call can fail on a live check, leaving `namedBrands:
null` on a fresh one.

## Adding a measured signal bumps the reuse key

The thing to bump is `CHECK_FINGERPRINT_NAMESPACE` in `src/runtime/check-result.ts`, and it is bumped in exactly one
place. It is `visibility-v3` because checks now measure the brands each answer names. The key is the cache and the
one-active-check index, so a v2 record kept satisfying requests for the same domain and served a result silently
missing half the report until it hit its own 24h TTL. The repo's own identity-vs-tuning rule covers this: a
parameter, or a signal, that changes what the operation PRODUCES must join the reuse key.

The namespace is a required argument to the kit's `checkFingerprint(namespace, domain, userQueries)` — the kit has no
default and refuses an empty one, because a namespace two products shared would hand each of them the other's result
and report it as a cache hit. So bump THIS constant when THIS Val's signal set changes, and never another Val's: that
would retire their live cache and change nothing about ours.

Bumping retires those records for REUSE only. `?check=<id>` still resolves, so a shared link keeps working and shows
the explained-empty mention pane.

## A numeric column is aligned once, on the column

`is-numeric` goes on the header AND on every cell in that column, and one rule keys off it. Alignment used to live on
the cell classes only (`.share-pct`, `.share-count`, `.inbound-cell`), so every header inherited the table's `left` and
sat half a table away from its own numbers: "ANSWERS" on the left edge, "1 of 2" on the right. Two places that had to
be kept in step by hand, and were not.

`render.test.ts` walks every rendered table, reads which header indices carry the class, and asserts each body cell at
that index agrees. Note the lookahead in its header regex: `<th[^>]*>` also matches `<thead>`, which silently shifts
every column index by one and makes the guard report a failure in the wrong column.

## The link graph is numbers, not a diagram

The crawl's internal-link graph is real and still stored, still in the `get_site_health` MCP payload, and still capped
by `site-map.ts`. It is no longer DRAWN, and the reason is worth keeping.

A 5-page crawl cannot support a graph. On real data every crawled page came back at `depth 0` and every discovered
target at `depth null`, and inbound links took three distinct values across 24 nodes. The diagram claimed three visual
channels (column = click depth, height = inbound rank, size = inbound count) and two of them had no variation to show,
so node position was effectively alphabetical. A picture whose caption asserts axes the data cannot fill reads as
invented, and a reader who says "is this fake?" is reading it correctly.

An earlier version was worse: it spaced nodes evenly around concentric rings, so the angle came from an array index.
Adjacency is the first thing an eye reads in a graph, and there it meant nothing at all.

What survived: inbound links are now a column on the sampled-pages table, joined from the same graph by URL, and the
bounded-crawl counts ("N of M pages and N of M internal links") are a line under it. Both are pinned by tests, because
the risk when deleting a visual is silently deleting the facts it carried.

## UI

Match the Canonry dashboard's restrained evidence-first hierarchy: compact header, underline tabs,
charts/tables/details, visible focus, and native disclosure controls. Do not port the full React SPA or add a card grid.

#- **Factors are ranked by score, best first, at read time.** The audit engine emits its rollup alphabetically, which
  reads as a list of names rather than a result. Order is a reading decision over stored data, not part of the record,
  so `orderFactors` is applied where the data is read: the UI view model and the `get_site_health` payload call the
  same comparator, so a check written before the change ranks correctly too and the two surfaces never disagree about
  which factor is doing best. An unmeasured factor sorts LAST, never as a zero: "not applicable to the sampled page
  types" is the absence of a measurement, and ranking it below the worst real score claims it is worse than the worst
  thing found. Ties break by name, since several factors scoring 100 is the common case. Assert factors by id, never by
  index; a positional assertion in `render.test.ts` broke the moment the order became meaningful.

## Site Health follows the dashboard's page audit

One collapsed `<details>` per factor, mirroring `apps/web/src/components/project/PageAuditEvidence.tsx`. The summary
carries the name, the page count, and the score, which is everything a reader needs to decide whether to open it. The
evidence and the fix live together inside, because a problem and its remedy are one thought.

It used to be two columns, Factors beside Top fixes, built by flattening every recommendation away from the factor it
came from and printing the factor's name as the fix's own subtitle. The two columns restated each other, and a
recommendation repeated across five sampled pages appeared five times, so one templated problem read as five.
Recommendations and findings are now deduped onto their factor.

Critical defects sit outside the score, so they render above the list and are never collapsed.

### The waiting state

A check takes about 45 seconds and execution is request-bound, so a native form POST leaves the browser blocked on a
navigation for the whole time with nothing on screen but a disabled button. Script intercepts the submit, posts to
`/api/checks`, and shows `renderLoadingView()` until the id comes back. The work still happens inside that one
request; it is just no longer the thing the browser is painting.

- **It claims only what is knowable while waiting.** The domain and the visitor's own questions are already theirs;
  elapsed time is counted, not guessed. The bar is indeterminate on purpose: the server reports no phase, and a bar
  that filled would be inventing progress.
- **The two tracks are concurrent because they are.** The runner is `Promise.allSettled` over the probe and the crawl,
  so showing them as parallel is a fact, not a layout choice. Do not turn them into a sequence of phases.
- **The no-script path must keep working.** The form still carries `method="post" action="/check"`, the enhancement
  falls back when the waiting view is absent, and a test asserts both.
- **Reset Turnstile on failure.** A token is redeemed exactly once, and this page now survives a failed submit, so a
  retry without `turnstile.reset()` sends a spent token.
- Motion is `transform` and `opacity` only, and stops entirely under `prefers-reduced-motion`.

### Say it once

The page carried the same idea up to three times. It opened with a `DOMAIN REPORT` kicker over a derived display name
over a subtitle naming the two tabs directly beneath it over the domain the name came from; then an `AI VISIBILITY`
kicker repeating the active tab; then a sentence defining mention against cited, which the evidence section defined
again in its own words a screen later. All of it is named in `DESIGN.md` ("Do not repeat a page choice through cards,
tabs, and headings") and in `PRODUCT.md`'s anti-references ("Multiple headings that restate the same page").

So: no section kickers. Six tiny uppercase labels over six headings is scaffolding, not voice, and the headings
already name their sections. The page title is the domain itself, because that is the subject and a derived name is
one more thing to read. Mention against cited is stated once, in the metric labels where the numbers are
(`Mentioned in the answer`, `Cited as a source`), not in prose above them and again below.

Tone belongs in a whole frame and a glyph, never a coloured rail down one edge. A `border-left` heavier than 1px used
as an accent is the side-stripe pattern; notices use a full tone-tinted border instead.

### What is shared with `apps/web`, and what cannot be

The two surfaces must LOOK like one product, but they cannot SHARE code. `apps/web` is React 19 + Vite + Tailwind 4
with TanStack Query, and its components are bound to the generated SDK (`useQuery(getApiV1…Options({client:
heyClient}))`). This Val is a Deno request handler that returns HTML strings, with no bundler and a `script-src 'self'`
policy. Importing a component would drag in the router, the query layer, and a Tailwind build.

So the design system is shared by VALUE, and the values must be copied exactly:

- **Fonts.** Same package and version the dashboard bundles, `@fontsource-variable/geist@5.3.0` and `-mono`, loaded
  from jsDelivr because a Val cannot ship woff2 (binary files are rejected). Naming Geist in a font stack without
  loading it — which is what this page did originally — silently renders the whole surface in a system font.
- **Typographic detail.** `font-feature-settings: "cv11", "ss01", "ss03"`, `-0.015em` heading tracking (`-0.02em` on
  h1), `"ss02", "cv11"` on monospace, and antialiasing. Without these the same typeface still reads as a different one.
- **Colour.** Token values are copied from `apps/web/src/styles.css`, alpha included (`rgb(24 24 27 / 0.3)`), not
  eyeballed to a nearby hex. A test pins them.

The site map is the one place where sharing was considered and rejected. The dashboard solves its layout with
ForceAtlas2 + noverlap in a `node:worker_threads` worker and renders it with Sigma/WebGL, for graphs of 20k–50k nodes.
Val Town has no worker threads, the page must render without JavaScript, and this graph is at most 24 nodes — a regime
where a force simulation is both overkill and non-deterministic. The deterministic depth-ring layout is the right
tool at this size, not a shortcut.

## Architecture

```mermaid
flowchart LR
    B[Browser] --> H[Val Town Deno host]
    H --> V["@canonry/val-kit visibility core"]
    H --> A[@canonry/aeo-audit]
    V --> G[Gemini: 1 plan + 3 queries]
    A --> C[5-page site sample]
    G --> S[Sanitized check result]
    C --> S
    S --> Q[Val-scoped SQLite]
    Q --> B
    Q --> M[MCP endpoint /mcp]
    K[canonry + aero skills] --> M
    M --> N[Any MCP client]
```

The Deno host owns HTTP routes, the check runner's phases, quota policy, and HTML. Technical AEO comes from the pinned
audit engine. The visibility contracts, bounded evidence runner, Gemini planner and adapter, the URL and Turnstile
guards, and both stores come from the pinned kit; none of them read environment, storage, or HTTP state.

```text
apps/vals/ai-visibility-check/
├── main.http.tsx                 Val HTTP entry
├── deno.json                     PUSHED production graph: Deno tasks and lint policy
├── deno.lock                     Production dependency lock (public npm)
├── deno.dev.json                 Local dev graph: links @canonry/val-kit from the workspace
├── deno.dev.lock                 Dev dependency lock (linked kit)
├── .vt/state.json                Val and branch identity (gitignored; CI generates it from the deploy workflow)
├── src/
│   ├── app/                      HTTP routes and response policy
│   ├── jobs/                     Request-bound check runner: phases, budget, sanitizers, visitor copy
│   ├── mcp/                      This Val's MCP server and tool surface
│   ├── site-health/              Technical AEO adapter, link-graph sample, factor ordering
│   └── ui/                       View models, HTML, and browser script
└── test/                         Deno backend and UI tests, plus the local dev server
```

Everything the tree no longer lists — `visibility/`, `security/`, `storage/`, check-record identity and the lease
machinery, MCP framing, the generated skills, and the design tokens — is `@canonry/val-kit`, imported by subpath.

## Dependencies

Every dependency is fully qualified at the import site (`npm:hono@4.12.25`, `npm:@canonry/val-kit@0.2.0/jobs`,
`https://esm.town/v/std/sqlite/main.ts`). Val Town resolves the module graph from esm.town and does NOT apply a pushed
`deno.json` import map, so a bare specifier deploys and then throws `not a dependency and not in import map` at the
first request. `deno.json` therefore excludes the `no-import-prefix` lint rule, which exists to enforce the opposite
convention.

### Two configs, because the kit is resolved from two different places

`deno.json` is PUSHED. It is the production graph, and it must describe only what Val Town can see: the public
registry. A `links` entry there would point at a workspace no deployed val has, and a shared `lock` would be rewritten
with a resolution production cannot reproduce. So it carries no `links`, no `nodeModulesDir`, and no `lock` key, and
the contract test fails if one appears.

`deno.dev.json` is LOCAL, and `.vtignore` keeps it (and `deno.dev.lock` and `node_modules/`) out of the push. It
duplicates `compilerOptions`, `lint`, and `fmt` — Deno has no `extends`, so there is no way to share them — and adds
`links: ["../../../packages/val-kit"]`, `nodeModulesDir: "auto"` (linking an npm package REQUIRES a node_modules
directory; without it Deno refuses outright), and its own `lock: "deno.dev.lock"`. That is what lets one PR change the
kit and this val together, before the kit is published. `deno.dev.lock` is committed, because `--frozen` needs it and
CI checks out fresh.

**Build the kit first.** Deno consumes an npm package as built JavaScript, and the kit's `exports` point at `dist/`,
so `pnpm --filter @canonry/val-kit build` has to run before any Deno task here. The `check`, `test`, and `dev` tasks
guard on `dist/index.js` and say so rather than failing inside a resolution error. Deno re-syncs its copy of a linked
package whenever that `dist/` changes, so rebuilding is the whole refresh step.

## Fixed public limits

- A visitor may supply up to three questions; the planner generates only the remainder, and is not called at all when
  all three are supplied. Supplied questions are IDENTITY, not tuning: they join `checkFingerprint`, so two callers
  asking different questions about one domain never share a cached result.
- One grounded Gemini planning call creates the questions the visitor did not supply.
- Three Gemini checks run with a concurrency limit of two.
- The site sample checks at most five pages and 2,500 edges.
- The full request stops after 45 seconds.
- Turnstile, daily quotas, one active job, and a 24-hour cache bound public use.
- The link map displays at most 24 nodes and 60 edges, and says so when it truncates.

The host scopes `allowPrivateHost` to the one host being crawled, per the boundary above. Failed provider
checks stay `Not measured` and do not reduce reported rates.

## Local development

```sh
deno task dev                      # http://localhost:8787 — stub runners, no network
GEMINI_API_KEY=… deno task dev     # real Gemini planner, probes, and crawl
```

In-memory storage and no Turnstile, so the UI and `/mcp` both work without credentials. `npx
@modelcontextprotocol/inspector` against `http://localhost:8787/mcp` drives the endpoint as a real client would.

## Verification

Run `pnpm --filter @canonry/val-kit build` from the repository root, then `deno task check`, `deno task lint`, and
`deno task test` from this directory, plus `node scripts/sync-val-town-skills.mjs --check` from the root. Those three
tasks validate the DEV graph, which is what CI's `vals` matrix job runs.

`deno task check:prod` validates the PRODUCTION graph instead (plain `deno.json`, `--frozen`). It cannot pass until
the pinned kit version is on public npm — before that it fails with `npm package '@canonry/val-kit' does not exist` —
which is the same gate the deploy workflow applies, on purpose. A deployment additionally requires a `vt push
--dry-run` and a live health smoke test.

## Production configuration

Set in Val Town: `VAL_TOWN_ENV=production`, `GEMINI_API_KEY`, `CANONRY_QUOTA_SALT`, `TURNSTILE_SECRET_KEY`,
`TURNSTILE_SITE_KEY`, `TURNSTILE_ALLOWED_HOSTNAMES`. Optional: `CANONRY_MCP_START_CHECKS=0` removes the MCP write
tool; `CANONRY_MCP_PER_CLIENT_DAILY_LIMIT` sets its daily per-caller allowance (default 2).

Public checks are disabled when the production quota salt or Turnstile configuration is absent, so an unconfigured
deployment serves reads and skills but refuses to spend.

## Release order

1. Publish the pinned `@canonry/val-kit` version with the `Publish @canonry/val-kit` workflow
   (`.github/workflows/publish-val-kit.yml`). Until then the production graph cannot resolve, and both `check:prod`
   and the deploy workflow fail closed — by design, since a val that deploys against an unpublished pin throws at the
   first request instead of at the push.
2. Refresh the production `deno.lock` with `deno check --allow-import main.http.tsx` (plain config, no `--frozen`) and
   commit it. `deno.dev.lock` is separate and is not touched by this.

> **Deno blocks a freshly published version for 24 hours.** `deno check` applies a
> minimum dependency age policy (default 24h) to reduce supply-chain risk, so the
> step above fails with "blocked by the minimum dependency age policy" if the kit
> was published minutes ago. Pass `--min-dep-age 0` to generate the lock anyway —
> defensible for a first-party package this repo just built and published from a
> reviewed commit. The override is only needed to CREATE the lock: once the lock
> pins the version with its integrity hash, `--frozen` resolves from the lock and
> the policy does not apply, so the deploy workflow needs no flag and no config.
3. Regenerate the skill mirror with `node scripts/sync-val-town-skills.mjs`.
4. Run the verification commands above, including `deno task check:prod`.
5. Run `vt push --dry-run` and review the file plan. A local push reads `.vt/state.json`; CI has none, so the deploy
   workflow generates it from the val and branch IDs pinned in the workflow with
   `node scripts/write-val-town-state.mjs apps/vals/ai-visibility-check`.
6. Run `vt push` only after approval.
7. Request `/healthz` and confirm `{"ok":true}`.

`vt push` makes the Val match this directory. It deletes remote-only files, so do not edit production in the Val Town
editor.

## A failed check says why

`mentioned: null` / `cited: null` is a check that did not happen, and the row reads "Not measured". The runner already
classifies why into a closed set of safe strings (timed out, rate-limited, temporarily unavailable, credentials
rejected, no answer text, unusable model, cancelled, generic), and `gemini-probe.ts` carries the message through.

The public sanitizer used to overwrite all of it with one "This answer-engine check was unavailable.". Nothing is
logged either, so the reason existed for one function call and was then destroyed: a row nobody, operator included,
could explain afterwards. `publicProbeError` now translates each known message into visitor wording ("answer engine",
not "provider") and falls back to the generic sentence for anything it does not recognize, so a sanitizer still never
trusts its input.

`probe-error-copy.test.ts` drives the REAL runner into each failure, then asserts none of them lands on the generic
fallback. That is the guard: a new failure mode added upstream without a translation fails the suite instead of
silently erasing its own reason. The banner leads with the reason only when every failed check shares one; with two
different reasons it would have to pick one and be wrong about the rest, so it defers to the per-row evidence.

## Say it once, and say it where it belongs

The block under the landing form was three paragraphs of identical muted grey carrying five facts, two of them twice:
the question count sat in the hint and again in the page footer, and the single engine sat in its own sentence and
again in the footer. Repetition with no contrast is what made it read as a wall.

It is now two lines with two steps of hierarchy:

- The **hint** (13px, `--secondary`) is an instruction and belongs to the questions field. `DESIGN.md` reserves
  `--muted` for nonessential metadata and forbids putting instructions in it, which is what the old block did with all
  three lines.
- The **facts row** (12px, `--muted`, dot-separated) is scope metadata, so muted is correct there. It reuses the
  `.sample-facts` separator vocabulary, including the narrow-width collapse to a stack, since a wrapped item that
  begins with a separator reads as broken.

The footer sentence is gone from the LANDING, where the facts row above it already says everything, and kept on the
RESULT page, where there is no form and a report read on its own must still state what it is a sample of. Both are
pinned by tests. The redundancy test counts on the visible block only: the tooltip's copy is deliberately written
twice, once as the trigger's accessible name and once as the body, which is one statement for two audiences.

## The heading's tooltip is CSS only

The landing explains itself through a note on the heading rather than a subtitle. It opens on `:hover` and, critically,
`:focus-within` — the page CSP allows no inline script, and the trigger must work before the enhancement script loads
or without it at all. That is why the trigger is a real `<button>`: `:focus-within` only fires for something focusable.

The copy rides the button's `aria-label`, so assistive tech and a test both reach it without the note being open, and
the visible body is `aria-hidden` to avoid announcing it twice. The body resets font family, size, weight, and
letter-spacing, or it inherits the 40px bold heading.

The audit is stated in the open too, in the footer. A fact that only exists inside a tooltip is a fact nobody reads.

## Copy the client rewrites lives in one constant

`client.ts` rewrites the query hint's whole line on every keystroke. A sentence added to only the server markup is on
the page until the visitor types and then silently disappears, and no assertion about the initial render catches it.
`QUERY_HINT_SUFFIX` is therefore declared once in `client.ts` (which owns the rewrite) and imported by `render.ts`;
that direction avoids a cycle, since `render.ts` already imports the script. `render.test.ts` asserts both halves carry
it.

## The human check is invisible unless it is not

The Turnstile widget renders `data-appearance="interaction-only"`. The challenge still runs on page load, so a token is
ready the moment someone submits; only the widget's visibility changes. Under the default (`always`) the RESULT page
carried a green "Success!" panel beside the check-another-domain form, announcing the outcome of a challenge for a
submission that had not happened, next to a report the visitor had already read.

The widget stays in the result-page form, and removing it would break the second check: that form needs a token too.
Nothing reserves height for it either, since on almost every load nothing is drawn there.

Token expiry is Cloudflare's to handle: `data-refresh-expired` defaults to `auto`, so a token solved on load and
submitted much later is refreshed rather than rejected. `client.ts` still calls `turnstile.reset()` after a FAILED
submit, which is a different case: a token is redeemed exactly once, and the page is still open for a retry.

## Branding

The kit's `ui/mark.ts` derives two forms from `plugins/canonry/assets/logo-dark.svg`, because a logo and a glyph do
different jobs. `src/ui/index.ts` re-exports both alongside `canonryDemoStyles`, so the page still imports its whole
surface from one place.

- `canonryMark` keeps the plate and serves the favicon, where a mark needs its own field.
- `canonryGlyph` removes the plate and crops the viewBox to the artwork. Inside the plate the bird fills 58% of the
  width, so at byline size it rendered as a speck, and the plate's warm `#1C1413` fought this page's cool zinc
  surface. Cropping is a reframe, not a redraw: the paths are untouched.

Both are served as fingerprinted assets rather than inlined. At 6 KB against a 5 KB page, inlining would more than
double every response to draw a 20px glyph.

The lockup is `product name | powered by [glyph] Canonry`. The glyph sits against the name it marks rather than against
the connective, so the two read as one unit; `powered by` is a step down in size and weight so the attribution does not
read as one flat phrase; and the byline carries no underline, because it is an identity rather than a link in prose.
The separator is a 1px hairline between two lockups of equal standing, not an accent stripe on one of them.

The cream `#FFFAED` is the brand's own, and against zinc it is the one warm thing on the page. That is deliberate: it
is the only element here that is Canonry rather than this tool.

This is the company silhouette, not the red canary. The canary is the dashboard app's mark. The two are deliberately
different and must not be unified here.

## README

`README.md` is rendered on the public val.town page, so it is marketing copy for a stranger who has never heard of
Canonry — not a contributor document. Keep implementation detail, limits rationale, and operational procedure here in
`AGENTS.md` instead.
