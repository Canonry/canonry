# TypeSafe sentiment integration

Internal Jev classifier, bundled into Canonry. It does not own project authorization, database writes, jobs, or retry scheduling.

- `src/client.ts` owns the fixed TypeSafe HTTP endpoint and safe typed errors. Runtime calls make exactly one attempt through the shared retry wrapper; the durable worker owns retries and total attempt limits.
- `src/classifier.ts` builds one pinned `jev-1.13.0` request per answer-subject assessment. It validates immutable source hashes and full verbatim sentence spans, resolves evidence IDs locally, and never manufactures quotations or truncates input.
- Definition template versions and question wording are part of evaluator identity. Request-semantic changes require a version change and fresh independent evaluation. Moving model aliases are unsupported.
- The active schema-2 evaluator asks five identity/stance/evidence questions and no theme questions. Old schema-1 definitions remain readable history but must not dispatch under new semantics. Branded and non-brand scores are separate populations. A non-brand answer without the known intended subject is `subject-not-mentioned`, never unfavorable; missing frozen identity is `subject-not-applicable`. Invalid conclusion evidence withholds the headline judgment.
- `src/evaluation.ts` scores supplied independent labels offline. Never fabricate reviewer labels or infer release quality from synthetic fixtures. The corpus and frozen rubric under `evals/sentiment/` document unmet release gates.
- Transport injection is test-only and below the fixed URL. Keep credentials out of returned failures, fixtures, evaluation artifacts, and logs.

Run `pnpm exec vitest run --project integration-typesafe`, the package typecheck, and `pnpm check` after changes. Live calls require an explicit corpus and attempt/token budget.
