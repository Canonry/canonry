# Sentiment evaluation

This directory contains an offline scoring runner and the frozen initial release rubric. It makes no provider calls. The example corpus is deliberately empty: the supplied plan contains no independently reviewed held-out answers, and no human labels have been fabricated.

Run from the repository root:

```sh
pnpm exec tsx evals/sentiment/run.ts evals/sentiment/held-out.template.json evals/sentiment/release-report.json
pnpm exec tsx evals/sentiment/token-estimates.ts
```

`release-report.json` records the current unmet release gates. It is not a claim about Jev accuracy. `token-estimates.json` records the five-question branded and non-brand request estimates plus a non-brand absent-subject preflight case that needs no provider request. Themes are deferred and are not sent to the classifier. Its input tokens are calibrated UTF-8 byte estimates (bytes / 2.5 plus 1024), not measured vendor tokenization or billing.

The input document has a `manifest` with `evaluatorDefinitionId` and `developmentGroups` (keys `property:<id>`, `query-family:<id>`, `sweep:<id>`), plus an `examples` array of `SentimentEvaluationExample` from `packages/integration-typesafe/src/evaluation.ts`. Store the complete frozen evaluation definition beside its SHA-256 ID and retain both reviewers' original label files matching `labelHash`. The manifest `evaluatorDefinitionId` must equal `frozenSentimentEvaluationDefinitionId()` from `packages/integration-typesafe/src/evaluation.ts`, and every example must record `prediction.evaluatorDefinitionId` and `prediction.returnedModel` (`jev-1.13.0`, or null only for a pre-dispatch abstention). The scorer checks source hashes, duplicate IDs, reviewer identity/blinding, and declared development-group overlap. Corpus selection and reviewer independence still require human review; merely filling metadata cannot prove them.

Freeze the held-out manifest before calling the model. Keep all tuning and the original 32 prototype answers in development data. After tuning against any held-out result, move that split to development and collect a new held-out split.

Each query class needs its own representative sample of at least 150 answers across two industries. Every example must declare `queryClass` as `branded` or `non-brand`; never pool their scores, favorable-share denominators, or release gates. Challenge cases must be separately marked; use them to reach at least 25 adjudicated examples of each stance. Include favorable conclusions with caveats, factual answers, wrong or shared-name subjects, non-brand absent intended subjects, opposite opinions about different subjects, negation, quoted opinions, and instructions embedded in source answers. Do not select the representative sample by complaint content. Tag challenge rows with `challengeTags`: `same-name` (adjudicated wrong-subject) and `caveated-favorable` (adjudicated favorable) each need at least 25 examples per query class and 90% recall.

Each reviewer first resolves the intended subject, then decides whether the answer judges that subject, then assigns favorable/mixed/unfavorable only to correct-subject, judgeable cases. A favorable conclusion remains favorable when a narrower criticism is present. A known intended subject absent from the answer is `subject-not-mentioned`, not unfavorable. Missing frozen identity is distinct from absence and remains inapplicable or ambiguous. Themes are outside the initial rubric. Review quoted evidence for subject and semantic support after blind labels are frozen. Record difficult cases and adjudicate disagreements rather than dropping them.

Release targets: quotation integrity 100%; correct-subject precision 95%; favorable precision 90%; stance macro F1 0.85; absolute favorable-share error at most 0.05; classified coverage 90%; accepted evidence semantic support 95%. The scorer reports counts, Wilson intervals, seeded ordinary-bootstrap macro-F1 intervals, separate query-class populations and samples, and industry/provider/language slices within each population. Coverage retains abstentions; favorable-share error discloses excluded cases and abstention by gold stance. Representative slices with fewer than 25 answers or fewer than five of any stance are reported as not gated; challenge slices are diagnostic. These intervals do not model Property/query-family/sweep dependence.

A public release needs the independently reviewed corpus, semantic evidence review, and all stance/evidence and applicable slice gates for both query classes. Deferred themes are not release gates. Non-English capabilities require separate evaluation. Current runtime remains experimental and off by default regardless of deterministic smoke success.

The browser smoke uses the dashboard assets from an installed tarball and the synthetic database produced by `scripts/smoke-sentiment.mjs --package-root <scratch>/node_modules/@canonry/canonry`. Copy that database with SQLite backup into a new `/tmp/canonry-sentiment-browser-*/synthetic.sqlite`; copy its `admin/config.yaml`, change the database path and loopback port, and keep its `/smoke` base path. Never point this harness at an operator database. The synthetic Advanced snapshot includes the same requested/supported Harbor context as its frozen execution slot, so ordinary visibility and sentiment can render together.

Start the installed `bin/canonry.mjs serve` with an isolated `CANONRY_CONFIG_DIR`, `TYPESAFE_API_KEY=synthetic-typesafe-key`, `NODE_OPTIONS=--import=<checkout>/scripts/sentiment-smoke-preload.mjs`, `CANONRY_SENTIMENT_SMOKE_GUARD=1`, and `CANONRY_SENTIMENT_SMOKE_PROVIDER_URL=http://127.0.0.1:9/v1/systemone`. Re-enable the copied `simple` and `advanced` projects through their sentiment settings REST endpoints using the fixture administrator key (`cnry_sentiment_synthetic_admin`); no backfill is needed. Both retain the completed synthetic assessments from the package smoke. Do not supply a real provider key.

With Playwright and Chromium available, run:

```sh
SENTIMENT_SMOKE_URL="http://127.0.0.1:<port>/smoke/" \
SENTIMENT_SMOKE_DATABASE="/tmp/canonry-sentiment-browser-<id>/synthetic.sqlite" \
SENTIMENT_BROWSER_ARTIFACTS="/tmp/canonry-sentiment-browser-<id>/artifacts" \
node scripts/smoke-sentiment-browser.mjs
```

Set `CANONRY_PLAYWRIGHT_MODULE` to a Playwright module path when it is installed outside Node's normal module resolution, and `CANONRY_BROWSER_EXECUTABLE` to an existing Chromium executable when required. The harness blocks foreign browser origins, signs in with real synthetic scoped sessions, records screenshots and a JSON receipt, checks configured overview scores and hiding when disabled, separate class headlines, exact per-query quotations, Simple and Advanced Property/market/provider/model/location selection, keyboard drawer behavior, mobile width, administrator preview and confirmed backfill admission reusing the stored Harbor assessment, and read-only enforcement. Set `SENTIMENT_SMOKE_QUERY_CLASS=non-brand` for a separate fixture from `smoke-sentiment.mjs --non-brand`; the default fixture is branded. Each run checks the empty sibling class is Unavailable rather than borrowing the populated class score. It also creates a temporary synthetic administrator credential through REST, demotes only that exact row in the copied database while its editor is open, verifies the UI sends no settings write and the server denies a direct write, then revokes the credential through REST. This last check requires Node's `node:sqlite` module. Stop only the fixture server you started after the smoke. A successful run has no unexpected HTTP/console/page errors and no provider requests.
