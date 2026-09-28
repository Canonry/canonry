# Experimental sentiment

Sentiment classifies stored English answers for a specific frozen subject. Branded and non-brand queries have separate scores and denominators. It is disabled by default at both install and project levels. It does not change citation or mention measurements, pool branded with non-brand queries, or run a new answer-engine sweep. Independent held-out human evaluation has not been completed; these results remain experimental.

## Enablement and authority

The private install `config.yaml` accepts:

```yaml
sentiment:
  enabled: true
  model: jev-1.13.0
  maxConcurrency: 2
  maxRequestsPerMinute: 60
  maxInputTokensPerMinute: 100000
  maxAttempts: 3
```

Supply `TYPESAFE_API_KEY` in the server environment, or `sentiment.apiKey` in private install configuration. Never put it in a project export, source repository, command argument, or browser configuration. `CANONRY_SENTIMENT_ENABLED` can explicitly override install enablement; `TYPESAFE_MODEL` must remain `jev-1.13.0`. The worker rereads configuration before each dispatch. Disabling prevents subsequent requests and cancels pending selections; re-enabling does not resume canceled work.

An install administrator must also configure the project:

```bash
canonry sentiment settings example --format json
canonry sentiment configure example --enabled true --format json
```

Enabling automatically admits eligible completions after the enablement boundary. Old answers require an explicit preview and backfill. Named viewers, read-only keys, project-scoped keys, and narrow write keys cannot configure or admit work. Delegated requests retain their underlying user's role. The read surfaces obey the existing project boundary.

Backfill sends the selected stored answer text, frozen subject, and execution context to TypeSafe and may incur usage. Inspect the preview before submitting its token with a stable idempotency key:

```bash
canonry sentiment backfill example --preview --run-id saved-run --query-class non-brand --format json
canonry sentiment backfill example --preview-token TOKEN --idempotency-key operator-action-1 --format json
canonry sentiment jobs example --format json
canonry sentiment example --run-id saved-run --query-class non-brand --format json
canonry sentiment evidence example --run-id saved-run --query-class non-brand --query-id saved-query --format json
```

Identical authorized retries return the same job receipt, including after preview expiry or disablement. A changed payload with the same key conflicts. Explicit new backfill can renew an exhausted or canceled attempt budget while retaining lifetime attempt history.

## Measurement and provenance

Favorable rate is favorable divided by favorable + mixed + unfavorable. Mixed receives no favorable credit. Zero judged answers produce unavailable rates, not zero percent. Counts explicitly partition judged, excluded, pending, failed, canceled, and unadmitted assessments. A 95% Wilson interval describes the judged proportion; it does not include classifier error or correlation among repeated answers.

The initial feature measures overall stance only; there are no theme presets or custom theme settings. The evaluator asks five questions about identity, judgment, stance, conclusion evidence, and a complaint quotation. Evidence consists only of original sentence spans. Invalid conclusion evidence abstains. Complaint quotations are separate from the overall conclusion.

A known intended subject absent from the answer yields `subject-not-mentioned`, outside the judged denominator. Non-brand answers with no shared-matcher hit for any frozen alias, qualified alias, or URL hostname abstain locally without a provider request. Missing frozen identity is separately inapplicable. Mention detection does not assign stance: a matching but ambiguous name still requires identity resolution.

Simple assessments use frozen run-sidecar identity and query class. Advanced assessments use the frozen plan revision, execution node, Target/Property, query assignment, location, and exact group/market usage edges. One shared answer can yield opposite verdicts for two subjects. Overlapping markets count an answer-subject assessment once. Deleting a tracked query or editing current project identity does not rewrite the saved evidence.

Complete initial sweeps and completed fills publish durable completion receipts, including superseded fills. Incomplete, probe, failed, and legacy sources without required provenance cannot silently supply the headline. Unsupported language, absent text, ambiguous identity/judgment, factual answers, and oversized input have explicit outcomes. Full input is not silently truncated.

## Reads, retries, and comparison

HTTP exposes nine capabilities under `/api/v1/projects/:name/sentiment`: settings GET/PUT, summary GET, evidence GET, compare GET, backfill-preview GET, backfills POST, jobs GET, and job detail GET. The generated SDK, CLI, and monitoring MCP toolkit expose the same capabilities. Dashboard selectors retain the same frozen scope. `queryId` is a selection identity on summary, evidence, comparison, and preview; summary responses include server-computed per-query and location scores with frozen source membership. The default read class remains branded for compatibility; select `queryClass` explicitly for non-brand. New completed runs admit both classes separately. Summary and evidence can select an exact saved run group using `runIds` (repeated HTTP query keys), mutually exclusive with `runId`; the CLI spelling is repeated `--run-ids <id>`, and MCP takes an array. Evidence cursors include this group identity. Reads and previews never invoke Jev.

Leases and shared SQLite reservations bound requests across projects. Every started remote attempt has a durable receipt. Reported usage enters the existing `typesafe`/`sentiment` ledger; interrupted or uncertain billing remains unknown. Recovery can create another billable attempt and does not imply exactly-once remote billing. The lifetime attempt history is retained independently of a newly authorized retry budget.

Comparisons match frozen units and refuse a directional claim across incompatible evaluator, subject, source-model, execution-context, query-class, or population boundaries. Evidence cursors bind the entire selection and resolved evaluator. New answer text under unchanged measurement/evaluator identity remains comparable.

## Dashboard placement

When project sentiment is configured, portfolio project rows show separately labeled non-brand and branded Favorable scores beside the existing visibility metrics. Overview scores use the same latest completed location-run group as visibility and expose its `runIds`. Simple Query evidence and Advanced Property/query views show separate class headlines and per-query Favorable values. Selecting a value opens the source evidence. Advanced scope retains the exact Property, market, run, and revision.

Manage sentiment opens the enablement and backfill controls from the existing view. There is no additional sentiment tab. Disabled projects hide these scores; zero judged answers show Unavailable. The server owns all percentages, counts, location slices, and source deduplication.

## Historical evaluator compatibility

The stance-only evaluator has schema version 2 and a new immutable definition ID. Stored version 1 results remain readable through a projection that omits retired theme fields without changing their stored JSON, schema version, or evaluator identity. Existing version 1 queued work cannot dispatch under version 2 semantics; new work requires explicit admission under the current definition. Comparisons across definitions refuse a directional claim.

## Validation and release gates

See [sentiment smoke validation](sentiment-validation.md) for reproducible built-package tests and the recorded synthetic live smoke. Aero routing and downstream reports remain follow-on work. Branded and non-brand accuracy require separate held-out evaluations; neither has passed that gate. Production rollout and claims of measured classifier quality require the independent evaluation rubric in `evals/sentiment/`; synthetic smoke is not that evaluation.
