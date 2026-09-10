# @canonry/val-kit

The code two or more vals share. It is published to public npm because Val Town resolves a fully-qualified
`npm:@canonry/val-kit@<version>/<subpath>` specifier at runtime and ignores import maps — a workspace link cannot
reach a deployed val.

## The seam

A module belongs here only if all of these hold:

- **Pure and host-agnostic.** It reads no environment, no storage, and no HTTP state of its own. Whatever it needs
  from a host — the environment object, a SQLite client, a `fetch`, an `AbortSignal` — arrives as a parameter.
- **No host imports.** Never `hono`, never `@canonry/aeo-audit`, never anything from `esm.town`, and never a `Deno.`
  global. `deno.json`, an import map, and a `main.http.tsx` are the val's business.
- **No product surface.** No product name, no page copy, no error sentence a visitor reads, no MCP tool that
  describes one val's offering. A val owns what it IS; the kit owns what it runs on. `createRequestBoundDispatcher`
  is generic; `createPublicCheckRunner` — which knows the phases, their budget, and every sentence a failure
  produces — is not, and stays with the val.

The test for a candidate is mechanical: if it references a visibility or site-health type, string, or phase, it is
not generic, whatever else is true of it.

## A product's result is stored, never read

The kit runs a check; the val decides what a check MEASURES. So `CheckRecord<TResult>` carries the product's own
result schema as a type parameter and the kit never looks inside it: the stores stringify it on write and hand it
back on read, and `rowToCheck` is the single boundary assertion on the way out. Nothing here may narrow, validate, or
branch on `result` — a store that knew the shape would have to be edited for the second product, which is the
coupling the parameter removes. `SiteHealthSample`, `CheckResult`, and the site-health phase left for
`apps/vals/ai-visibility-check/` for exactly that reason; `VisibilityReport` and `VisibilityProbePort` stayed,
because they are what the visibility INSTRUMENT produces, not what a product stores.

A val names the parameter once, where it builds its store — `new ValSqliteCheckStore<CheckResult>(sqlite)` — and
every record it takes out is typed from there.

## The fingerprint namespace belongs to the product

`checkFingerprint(namespace, domain, userQueries)` takes the namespace as a REQUIRED first argument, and an empty one
is refused rather than defaulted. The key is both the 24h cache key and the one-active-check index, so two products
sharing a namespace would serve each other's results as cache hits — a different measurement entirely, reported as a
hit.

Each product owns exactly one namespace and bumps only its own, to retire its own records when it starts measuring
something new. A new product means a NEW namespace, never a bump of another product's: bumping someone else's
retires their live cache and changes nothing about yours.

The produced string is a STORED value — every record already written carries the exact bytes the function returned —
so the format is a compatibility contract. `test/records.test.ts` pins the literals for that reason: a reformat that
reads as harmless orphans every stored record, and the only symptom is a cache that stops hitting and a bill that
goes up.

## Subpaths

`.`, `./visibility`, `./perception`, `./security`, `./storage`, `./jobs`, `./mcp`, `./ui`, `./config`. Each is a
`src/<name>.ts` barrel and a tsup entry; `.` re-exports the rest. Adding a subpath means adding all three (barrel,
tsup entry, `exports` map) or a consumer gets a resolution error rather than a type error.

`VisibilitySource` is declared twice in the seam with two different shapes — the adapter-facing source in
`visibility/contracts.ts` and the display-safe source stored on a record in `runtime/types.ts`. Two star re-exports
of one name are ambiguous, which drops it from the root barrel silently, so `src/index.ts` names the winner
explicitly. Keep that line if either declaration moves.

`VisibilityReport`, `VisibilityEvidence`, `VisibilitySummary`, `VisibilityProbePort`, and `VisibilityProbeInput` are
declared in `runtime/types.ts` and re-exported BY NAME from `visibility.ts`, so `./visibility` and `./jobs` both
resolve them to one declaration and no consumer has to move. Named rather than starred, for the `VisibilitySource`
reason directly above.

## Brand perception is a second instrument, not a visibility mode

`./perception` measures how an answer engine CHARACTERISES a brand when it is asked about it directly. `./visibility`
asks non-brand questions and measures whether the brand shows up at all. They share the probe runner, the Gemini
adapter, and the brand matcher; they share nothing else, and they must never share a denominator, a rate, or a table.
A branded question hands the model the answer, so the brand is present on nearly all of them and the finding is what
the engine then says — pooling that with a non-brand basket lets recall outvote the characterisation and inverts the
number a reader thinks they are looking at.

The planner is the visibility planner's mirror image. That one drops any generated query which names the brand
(`!detectMention(query, target).mentioned`); `createGeminiPerceptionPlanner` drops any which does NOT. It is a filter
rather than a prompt instruction on purpose: the prompt asks for branded questions, `detectMention` decides whether it
got them. Fewer than requested is a smaller sample; zero is a failure, because there is nothing to ask. A question the
VISITOR supplied is exempt — they chose it.

**A verdict, carried by verbatim evidence — never a score.** A number between 0 and 1 would read as a measurement of
feeling, and nothing here measures feeling. So the model proposes and exact matching disposes, exactly as
`mention-extract.ts` does for names: one bounded structured-output call returns a verdict with the sentences that
carry it, and `verifyVerdict` keeps a sentence only when the answer literally contains it (whitespace-collapsed,
case-insensitive) and a concern only when it is written by `namesWrittenIn`'s adjacent-complete-words rule. A verdict
with no surviving evidence collapses to `'none'`, because a verdict nothing in the text carries is the model's opinion
rather than the engine's.

`'none'` and `null` are different findings and the difference is the whole honesty story. `'none'` says the answer took
no position — a fact about the answer. `null` says nobody read one out of it, whether the probe failed or the
extraction did — a fact about the check. A row with `null` leaves EVERY denominator in `summarizePerception`, verdict
counts, concerns, and source types alike: one definition of "successful", used by all three, or the same card says
"2 answers" above one number and "3 answers" above the next.

**Five provider calls per check** — 1 planner + 3 probes in one wave + 1 verdict extraction — pinned by
`perception-budget.test.ts`, which also asserts every call sets an explicit `thinkingConfig.thinkingBudget`. That
number is meant to be noticed when a feature adds a call: it is the check on what an anonymous visitor can make this
instrument spend. The deadlines are arithmetic, not a guess: `10 + 20 + 12 = 42s` inside a 45s job budget, and it fits
only because `probeConcurrency >= maxProbeCalls` keeps the probes in ONE wave. The test asserts that relationship
rather than the numbers, because raising `maxProbeCalls` alone silently buys a second wave.

**Source types are explicit host lists. Extend the list; never add fuzzy matching.** A similarity score on a hostname
would type `trustpilot-reviews-scam.example` as a review site and the reader has no way to see the label was guessed.
The lists ARE the classifier, so extending one is a visible, reviewable edit. Order matters and is load-bearing: the
brand's own domain wins first, then the exact lists, then the two label-prefix rules — which is why
`news.ycombinator.com` types as community rather than being re-typed by a `news.` prefix. Anything unrecognised is
`'other'`, which is a real answer: the engine attributed something the instrument does not recognise.

## Build

tsup to ESM + `.d.ts`. Deno consumes an npm package as BUILT JavaScript — it does not run TypeScript out of
`node_modules` — so an unbuilt `dist/` is a broken publish, not a slow one. Relative imports carry a `.js`
extension (repo convention; tsup and tsc resolve them to the `.ts` source).

## Versioning and publishing

Vals pin an EXACT version (`npm:@canonry/val-kit@0.2.0/...`), so a change here reaches a val only when its
specifier is bumped. Before publishing, a val resolves the kit locally through Deno `links` so an unreleased change
can be run end to end; after publishing, the pin moves.

Publishing is a manual workflow. It is not part of the Canonry release, and the kit's version is independent of
`packages/canonry`.

## `src/mcp/skills/` is generated

For the Canonry entry point, edit `docs/agent-operations/v1.md` and run `pnpm guide:sync`; it refreshes the
runtime guide, native skills, and this mirror together. Other skill documents still originate in
`skills/<name>/`; run `node scripts/sync-val-town-skills.mjs` after editing them and commit the result.
`--check` fails instead of writing, which is what CI runs. Never hand-edit a generated module; the next sync
overwrites it.

## Tests

`packages/val-kit/test/`, vitest, run by the root suite as the `val-kit` project. Every module the kit owns keeps
the coverage it had as val-local code — a module that moved in without its tests moved in untested. `storage.test.ts`
uses `node:sqlite` as a stand-in for Val Town's SQLite over the same `ValSqliteClient` interface, which is the point
of the store taking an interface rather than a binding.
