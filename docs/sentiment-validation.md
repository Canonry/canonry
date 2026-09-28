# Sentiment validation

The implementation was split across contracts/storage, the Jev classifier/evaluation runner, backend dispatch/API, CLI/MCP, dashboard, and integration/release testing. Every track supplied focused tests; independent reviews found and repaired historical query deletion, scoped Advanced provenance, crash attempt budgets, and evidence-drawer focus handling.

## Recorded checks (2026-09-28)

| Layer | Evidence |
| --- | --- |
| Contracts/storage | Canonical ten-assessment math and complete companion; Wilson interval and zero-judgment semantics; immutable definition, migration/FK/index, idempotency, lease/cancellation, audit, and attempt-budget tests. |
| Jev adapter | 31 classifier/evaluation tests plus retry-coverage guard; real loopback serialization, pinned model, safe errors, evidence integrity, bounded complete input, opposite subjects, theme overlap, and abstention. |
| Backend | Frozen Simple/Advanced selection, complete/fill/superseded receipts, probe/legacy exclusion, scope/model/evaluator comparison boundaries, named/delegated authorization and demotion, revoked authority before replay, cursor boundaries, historic identity/theme continuity, and explicit coverage gaps. |
| CLI/MCP | 106 focused SDK/CLI/MCP/registry tests after rebasing onto current upstream; server-owned values, all nine capabilities, normal error envelopes, read/write filtering, and deferred Aero routing. |
| Dashboard | 14 semantic/SDK/action tests and 56 nearby project/scope regressions; built assets and a real browser against the installed package. |
| Installed transports | Synthetic Simple and shared-answer Advanced fixtures under `/smoke/`; matching summaries/evidence across HTTP, spawned CLI, hosted MCP, and spawned stdio MCP; settings/jobs parity through CLI for both projects and both MCP transports for Simple; read/scoped denials, cross-client idempotent replay, exact Advanced market deduplication, no extra provider calls from reads. |
| Installed zero-judgment | Exactly three stub requests; factual Simple/Harbor and wrong-subject Bayside; unavailable rates, explicit exclusions, human CLI display, and summary/evidence/comparison parity through all four transports. |
| Installed boundaries | Thirteen cases across HTTP, CLI, hosted MCP, and stdio MCP: source-model/evaluator/population comparison refusals, valid paging plus market/Property/run/evaluator cursor rejection, and actual current identity/language/theme edits preserving historical summary and evidence. Offline seeded classifications; zero classifier attempts or provider calls. Request UUIDs are validated separately from exact semantic error equality. |
| Installed recovery | Six loopback stub calls across three isolated scenarios: 429 Retry-After then disable/restart/reenable, a killed transmitted attempt followed by lease recovery, and missed/superseded completion reconciliation. Separate unknown and reported receipts survive; completed results remain unique. |
| Built browser | Simple and Advanced Property/market selection, evidence quotations, keyboard containment/Escape/focus restoration, 390px layout, administrator preview followed by real backfill admission reusing stored results, read-only denial, and API-key session scope reduction while an editor is open. Ten screenshots; zero unexpected HTTP/console/page errors, external egress, or provider calls. |

The recovery harness expires only the killed process’s lease in its disposable database and inserts synthetic completion receipts while the server is stopped. It verifies installed reconciliation; separate run-writer tests verify receipts are inserted atomically by actual initial/fill transactions. Named-session/delegated edge cases are exercised in real API tests, and the browser verifies an actual API-key session scope reduction; the installed CLI/MCP key matrix covers administrator, read-only, and project-scoped credentials.

The bounded live smoke ran once using the operator-supplied key file, held only in process memory/environment. Exactly **three** requests returned `jev-1.13.0`: **16,892 reported input tokens** and **6,026 output tokens**. The conservative preflight input bound was 51,828 tokens. Observed synthetic judgments were Aurora Service favorable, Harbor Homes favorable, and Bayside Homes unfavorable. Every accepted quotation matched its source span. HTTP, CLI, hosted MCP, and stdio MCP read the persisted results without additional provider calls. No credential appeared in responses, CLI/MCP output, logs, or the redacted receipt.

Live validation used the feature-complete isolated development tarball; the final rebased stack is rebuilt and tested with deterministic transports. The public smoke receipt records measured counts and explicit evaluation limits, not a classifier accuracy claim. The browser fixture later added the exact requested/supported Harbor context required by the pre-existing Advanced visibility report; that correction does not change the sentiment assessment.

## Reproduce safely

Use an isolated development checkout. Do not use an operator database, install globally, or deploy as part of smoke testing.

```sh
pnpm build
pnpm --filter @canonry/canonry pack --pack-destination /tmp/sentiment-package
# Install the emitted .tgz with npm --prefix into a fresh scratch directory.
pnpm exec tsx scripts/smoke-sentiment.mjs --package-root /tmp/sentiment-install/node_modules/@canonry/canonry
pnpm exec tsx scripts/smoke-sentiment.mjs --package-root /tmp/sentiment-install/node_modules/@canonry/canonry --zero-judgment
pnpm exec tsx scripts/smoke-sentiment-recovery.mjs --package-root /tmp/sentiment-install/node_modules/@canonry/canonry
pnpm exec tsx scripts/smoke-sentiment-boundaries.mjs --package-root /tmp/sentiment-install/node_modules/@canonry/canonry
```

The source import seeds synthetic data only. Server, CLI, and stdio MCP run the installed binaries outside the checkout. The source-free preload redirects only TypeSafe's fixed production URL to a loopback stub and rejects external fetches/redirects. It validates response/model shape, never prints authorization, and records redacted attempt receipts. The main harness allows at most three unique assessments, six requests, and 150,000 conservative input tokens. Its budget is per process: do not restart or rerun live mode without reconciling the previous attempt receipts and original authorized total. Recovery testing uses only the deterministic stub.

Live mode is explicit: append `--live-key-file /absolute/private/key-file` to the main smoke command. Never combine it with `--zero-judgment`. Authentication, returned-model, or response-contract failures stop further provider dispatch. A live run is not required for routine CI. Browser setup and configurable Playwright/Chromium paths are documented in [the evaluation README](../evals/sentiment/README.md).

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

No independently reviewed held-out corpus was supplied. The 150-answer, two-industry, independently blinded human evaluation and its accuracy/evidence/theme thresholds remain **unmet**. The checked-in template stays empty and the offline release report truthfully fails that gate. Custom themes remain unevaluated. The feature stays experimental and default-off; these smoke results do not authorize production enablement or establish accuracy on customer data.
