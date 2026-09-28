# Sentiment evaluation

This directory contains an offline scoring runner and the frozen initial release rubric. It makes no provider calls. The example corpus is deliberately empty: the supplied plan contains no independently reviewed held-out answers, and no human labels have been fabricated.

Run from the repository root:

```sh
pnpm exec tsx evals/sentiment/run.ts evals/sentiment/held-out.template.json evals/sentiment/release-report.json
pnpm exec tsx evals/sentiment/token-estimates.ts
```

`release-report.json` records the current unmet release gates. It is not a claim about Jev accuracy. `token-estimates.json` records the default, multifamily, and maximum custom-theme request estimates, including the cost of per-theme evidence questions. Its input tokens are conservative byte bounds, not measured vendor tokenization or billing.

The input document has a `manifest` with `evaluatorDefinitionId` and `developmentGroups` (keys `property:<id>`, `query-family:<id>`, `sweep:<id>`), plus an `examples` array of `SentimentEvaluationExample` from `packages/integration-typesafe/src/evaluation.ts`. Store the complete frozen evaluation definition beside its SHA-256 ID and retain both reviewers' original label files matching `labelHash`. The scorer checks source hashes, duplicate IDs, reviewer identity/blinding, and declared development-group overlap. Corpus selection and reviewer independence still require human review; merely filling metadata cannot prove them.

Freeze the held-out manifest before calling the model. Keep all tuning and the original 32 prototype answers in development data. After tuning against any held-out result, move that split to development and collect a new held-out split.

The representative sample must have at least 150 answers across two industries. Challenge cases must be separately marked; use them to reach at least 25 adjudicated examples of each stance. Include favorable conclusions with caveats, factual answers, wrong or shared-name subjects, negation, quoted opinions, overlapping theme polarities, and instructions embedded in source answers. Do not select the representative sample by complaint content.

Each reviewer first resolves the intended subject, then decides whether the answer judges that subject, then assigns favorable/mixed/unfavorable only to correct-subject, judgeable cases. A favorable conclusion remains favorable when a narrower criticism is present. Theme discussion is independent of praise and criticism; both polarities can hold. Review quoted evidence for subject and semantic support after blind labels are frozen. Record difficult cases and adjudicate disagreements rather than dropping them.

Release targets: quotation integrity 100%; correct-subject precision 95%; favorable precision 90%; stance macro F1 0.85; absolute favorable-share error at most 0.05; classified coverage 90%; accepted evidence semantic support 95%; preset complaint precision 90% and recall 85%. The scorer reports counts, Wilson intervals, seeded ordinary-bootstrap macro-F1 intervals, separate samples, and industry/provider/language slices. Coverage retains abstentions; favorable-share error discloses excluded cases and abstention by gold stance. Sparse slices require at least 25 answers and five examples of each stance to support a passing claim. These intervals do not model Property/query-family/sweep dependence.

A public release needs the independently reviewed corpus, semantic evidence review, and all applicable preset-theme and slice gates. Custom themes remain unvalidated; non-brand and non-English capabilities require separate evaluation. Current runtime remains experimental and off by default regardless of deterministic smoke success.
