# Sentiment validation

The implementation was split across contracts/storage, the Jev classifier/evaluation runner, backend dispatch/API, CLI/MCP, dashboard, and integration/release testing. The initial stack used the schema 1 branded evaluator with themes. The follow-up revision removes active themes, supports separate branded/non-brand populations, and places Favorable scores in the existing overview and query evidence. Historical validation below is retained as evidence for that original artifact; it does not establish accuracy or live schema 2 behavior.

## Stance-only schema 2 revision (2026-09-28)

Version 5.25.0 was built and installed outside the checkout. The [revision receipt](../evals/sentiment/revision-smoke-receipt-2026-09-28.json) pins the package SHA-256 and records only synthetic data. No additional live Jev requests were made.

| Layer | Recorded result |
| --- | --- |
| Integrated source | 173 sentiment tests across 15 suites passed. Classifier/evaluation/CLI/MCP focused suites, 227 affected dashboard regressions, and focused follow-ups for source membership and provisional display passed. API, runtime, web, SDK and script typechecks passed; generated-client, plugin and Val skill guards passed. |
| Branded and non-brand transports | Separate installed smokes each passed eight checks across HTTP, spawned CLI, hosted MCP and spawned stdio MCP. Each used three deterministic provider requests, exact per-query/source membership, separate class denominators, permissions and idempotent replay. Reads added no calls. |
| Non-brand absent subject | Nine checks passed; all three selected synthetic assessments were subject-not-mentioned, with zero judged/unfavorable answers, Unavailable rates and zero provider calls. |
| Zero judgment | Nine checks passed with three stub requests; factual/wrong-subject exclusions, null intervals, Unavailable display and comparison refusal agreed across every transport. |
| Grouped boundaries | Nineteen cases passed across every transport: exact run-group/query scores, cursor membership, and model/evaluator/population/history boundaries. Zero provider calls or attempts. |
| Recovery | All three installed fault scenarios passed: retry/disable, transmitted-attempt crash, and missed/superseded completion reconciliation. Six stub requests; uncertain receipts stayed distinct from reported usage. |
| Browser | Branded and non-brand each passed ten checks and produced twelve screenshots. Configured overview, hidden disabled scores, class headlines, per-query quotes, full Advanced scope, keyboard/mobile behavior, real stored-result backfill reuse, read-only access and session demotion passed. Both runs had zero unexpected HTTP/console/page errors, external requests or provider attempts; owned servers were stopped. |

Schema 1 history and legacy job replay stay readable without rewriting immutable data. Upgrading an enabled evaluator advances the future-completion boundary, so historical non-brand work requires explicit admission. Grouped scores refuse incompatible evaluator/subject/query/mode/revision identities, and incomplete source groups remain provisional.

## Compact overview card follow-up (2026-09-28)

The overview card shows two aligned class/rate rows. Judgment coverage, state and methodology are behind keyboard/touch-accessible help; provisional results retain a visible marker. The project link and info control remain separate navigation targets.

The [UI follow-up receipt](../evals/sentiment/card-ui-smoke-receipt-2026-09-28.json) pins the rebuilt dashboard artifact separately from the earlier full revision artifact. All 28 focused UI tests, web typecheck, changed-file lint and dashboard build passed. The packaged browser smoke passed 11 assertions with 15 screenshots, including desktop/mobile card layout, first-touch help, viewport bounds, project navigation, Simple/Advanced evidence and permissions. It made zero provider requests and stopped its owned server. The CLI/runtime and dependencies were reused unchanged; earlier backend and recovery receipts remain attached to their original artifact.

## Engine evidence follow-up (2026-09-28)

The stack is rebased onto PR #1235. Version 5.26.0 adds stored verdicts to expanded engine rows, scopes Simple scores to the visible engine and saved run group, and keeps shared Advanced subject judgments and location-specific query scores separate. Exact assessment links preserve source and evaluator identity. Changing the resolved Advanced run or revision dismisses stale evidence and management drawers.

The [engine receipt](../evals/sentiment/engine-smoke-receipt-2026-09-28.json) pins a fresh CLI/dashboard package. Focused checks passed: 274 web, 100 API, 13 contracts, 12 generated SDK, and 65 CLI/MCP tests; affected package and script typechecks; lint; generated-client/plugin/Val guards; and both builds. Unchanged runtime dependencies were copied from the prior isolated installed smoke.

One complete installed command passed seven assertion groups across HTTP, spawned CLI, hosted MCP, and spawned stdio MCP, then six browser assertion groups with 14 screenshots. The fixture covers opposing engine verdicts, a locally excluded absent subject, an unadmitted engine, shared Advanced subjects, exact model/location/Property/market evidence, the 100%/0% location regression, mobile reachability, keyboard focus, read-only users and disabled state. Expanding rows adds no per-row summary reads. Seven assessments completed through six deterministic loopback requests; all subsequent reads and browser actions added zero attempts. There were no unexpected HTTP, console or page errors or external requests. The owned server stopped. No additional live Jev requests were made.

The [final mobile follow-up receipt](../evals/sentiment/engine-mobile-smoke-receipt-2026-09-28.json) pins the subsequent dashboard rebuild: subject and verdict may use separate lines, and verdict words stay intact. All 33 semantic sentiment UI tests, lint and the dashboard build passed. The complete installed command passed again with seven assertion groups, six browser groups, 14 screenshots and six loopback requests. A real text-range assertion verifies the verdict fits on one line inside its button; the Advanced mobile screenshot is exactly 390 pixels wide. The prior receipt remains attached to its original artifact.

Reproduce with a freshly installed package under `/tmp/canonry-sentiment-...` and the Playwright/Chromium setup documented in the evaluation README:

```sh
pnpm exec tsx scripts/smoke-sentiment-engines.mjs --package-root /tmp/canonry-sentiment-install/node_modules/@canonry/canonry --browser
```

## Original schema 1 checks (2026-09-28)

| Layer | Evidence |
| --- | --- |
| Contracts/storage | Canonical ten-assessment math and complete companion; Wilson interval and zero-judgment semantics; immutable definition, migration/FK/index, idempotency, lease/cancellation, audit, and attempt-budget tests. |
| Jev adapter | 31 classifier/evaluation tests plus retry-coverage guard; real loopback serialization, pinned model, safe errors, evidence integrity, bounded complete input, opposite subjects, theme overlap, and abstention. |
| Backend | Frozen Simple/Advanced selection, complete/fill/superseded receipts, probe/legacy exclusion, scope/model/evaluator comparison boundaries, named/delegated authorization and demotion, revoked authority before replay, cursor boundaries, historic identity/theme continuity, and explicit coverage gaps. |
| CLI/MCP | 106 focused SDK/CLI/MCP/registry tests after rebasing onto current upstream; server-owned values, all nine capabilities, normal error envelopes, read/write filtering, and deferred Aero routing. |
| Dashboard | 15 semantic/SDK/action tests, shared write-control coverage, and 105 portfolio-route regressions; built assets and a real browser against the installed package. Account demotion disables open Save/Confirm controls before sentiment action permissions refresh. |
| Installed transports | Synthetic Simple and shared-answer Advanced fixtures under `/smoke/`; matching summaries/evidence across HTTP, spawned CLI, hosted MCP, and spawned stdio MCP; settings/jobs parity through CLI for both projects and both MCP transports for Simple; read/scoped denials, cross-client idempotent replay, exact Advanced market deduplication, no extra provider calls from reads. |
| Installed zero-judgment | Exactly three stub requests; factual Simple/Harbor and wrong-subject Bayside; unavailable rates, explicit exclusions, human CLI display, and summary/evidence/comparison parity through all four transports. |
| Installed boundaries | Thirteen cases across HTTP, CLI, hosted MCP, and stdio MCP: source-model/evaluator/population comparison refusals, valid paging plus market/Property/run/evaluator cursor rejection, and actual current identity/language/theme edits preserving historical summary and evidence. Offline seeded classifications; zero classifier attempts or provider calls. Request UUIDs are validated separately from exact semantic error equality. |
| Installed recovery | Six loopback stub calls across three isolated scenarios: 429 Retry-After then disable/restart/reenable, a killed transmitted attempt followed by lease recovery, and missed/superseded completion reconciliation. Separate unknown and reported receipts survive; completed results remain unique. |
| Built browser | Simple and Advanced Property/market selection, evidence quotations, keyboard containment/Escape/focus restoration, 390px layout, administrator preview followed by real backfill admission reusing stored results, read-only denial, and API-key session scope reduction while an editor is open. Ten screenshots; zero unexpected HTTP/console/page errors, external egress, or provider calls. |

The recovery harness expires only the killed process’s lease in its disposable database and inserts synthetic completion receipts while the server is stopped. It verifies installed reconciliation; separate run-writer tests verify receipts are inserted atomically by actual initial/fill transactions. Named-session/delegated edge cases are exercised in real API tests, and the browser verifies an actual API-key session scope reduction; the installed CLI/MCP key matrix covers administrator, read-only, and project-scoped credentials.

The bounded live smoke ran once using the operator-supplied key file, held only in process memory/environment. Exactly **three** requests returned `jev-1.13.0`: **16,892 reported input tokens** and **6,026 output tokens**. The conservative preflight input bound was 51,828 tokens. Observed synthetic judgments were Aurora Service favorable, Harbor Homes favorable, and Bayside Homes unfavorable. Every accepted quotation matched its source span. HTTP, CLI, hosted MCP, and stdio MCP read the persisted results without additional provider calls. No credential appeared in responses, CLI/MCP output, logs, or the redacted receipt.

Live validation used the original schema 1 feature-complete isolated development tarball. The schema 2 revision uses deterministic transports and made no additional live provider requests. The public smoke receipt records measured counts and explicit evaluation limits, not a classifier accuracy claim. The browser fixture later added the exact requested/supported Harbor context required by the pre-existing Advanced visibility report; that correction does not change the sentiment assessment.

## Reproduce safely

Use an isolated development checkout. Do not use an operator database, install globally, or deploy as part of smoke testing.

```sh
pnpm build
pnpm --filter @canonry/canonry pack --pack-destination /tmp/sentiment-package
# Install the emitted .tgz with npm --prefix into a fresh scratch directory.
pnpm exec tsx scripts/smoke-sentiment.mjs --package-root /tmp/sentiment-install/node_modules/@canonry/canonry
pnpm exec tsx scripts/smoke-sentiment.mjs --package-root /tmp/sentiment-install/node_modules/@canonry/canonry --zero-judgment
pnpm exec tsx scripts/smoke-sentiment.mjs --package-root /tmp/sentiment-install/node_modules/@canonry/canonry --non-brand
pnpm exec tsx scripts/smoke-sentiment.mjs --package-root /tmp/sentiment-install/node_modules/@canonry/canonry --non-brand --absent-subject
pnpm exec tsx scripts/smoke-sentiment-recovery.mjs --package-root /tmp/sentiment-install/node_modules/@canonry/canonry
pnpm exec tsx scripts/smoke-sentiment-boundaries.mjs --package-root /tmp/sentiment-install/node_modules/@canonry/canonry
```

The source import seeds synthetic data only. Server, CLI, and stdio MCP run the installed binaries outside the checkout. The source-free preload redirects only TypeSafe's fixed production URL to a loopback stub and rejects external fetches/redirects. It validates response/model shape, never prints authorization, and records redacted attempt receipts. The main harness allows at most three unique assessments, six requests, and 150,000 conservative input tokens. Its budget is per process: do not restart or rerun live mode without reconciling the previous attempt receipts and original authorized total. Recovery testing uses only the deterministic stub.

Live mode is explicit: append `--live-key-file /absolute/private/key-file` to the main smoke command. Never combine it with `--zero-judgment`, `--non-brand`, or `--absent-subject`; those modes use deterministic fixtures only. The original three-request live budget has been consumed. Do not rerun live mode under that same budget. Authentication, returned-model, or response-contract failures stop further provider dispatch. A live run is not required for routine CI. Browser setup and configurable Playwright/Chromium paths are documented in [the evaluation README](../evals/sentiment/README.md).

Focused checks include:

```sh
pnpm exec vitest run sentiment --maxWorkers 2
pnpm exec vitest run --project integration-typesafe
pnpm exec tsc --noEmit -p scripts/tsconfig.json
pnpm check
pnpm gen:check
pnpm plugin:check
pnpm val:skills:check
```

## Unmet release gate

No independently reviewed held-out corpus was supplied. Each query class independently needs at least 150 representative answers across two industries, adjudicated stance challenge cases, and the blinded accuracy/evidence review in the current rubric. Both class gates remain **unmet**. The checked-in template stays empty and the offline release report truthfully fails both gates. Themes are outside the initial scope and rubric. The feature stays experimental and default-off; these smoke results do not authorize production enablement or establish accuracy on customer data.
