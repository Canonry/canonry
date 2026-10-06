---
name: test-audit
description: "Invoke whenever writing, changing, reviewing, running, or sweeping Canonry tests. Authoring gate for new tests plus audit workflow for low-value, implementation-coupled, or duplicative tests and the test-only production seams they demand."
---

# Test Audit

Repository development skill adapted from [OpenClaw](https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/SKILL.md).
Read [UPSTREAM.md](UPSTREAM.md) for provenance and the Canonry adaptations.

Three modes, one value bar. Authoring mode gates every new or changed test at
write time. Audit mode runs focused sweeps of tests that re-assert source,
duplicate stronger proof, couple behavior to implementation, or keep test-only
production seams alive. Continue broad audits as separate coherent follow-up
PRs; optimize for confidence, not deletion count. Campaign mode prunes one
whole subsystem's test surface (every test file a plugin or core area owns);
before starting one, read [CAMPAIGN.md](CAMPAIGN.md).

## Authoring gate

Before adding any test, answer four questions; a missing answer means do not
add it yet:

1. What observable behavior, invariant, or independent contract does it protect?
2. What credible regression makes it fail?
3. Why does existing coverage not already catch that failure? Each contract has
   one primary test owner at the strongest boundary; another layer needs its
   own distinct risk, such as a transport or lifecycle failure the owner cannot
   reach. Prefer extending a table-driven case or shared fixture over a
   near-duplicate test; consolidate duplicated setup in the same change.
4. Does it need a production seam (export, flag, wrapper, injection hook) that no
   production caller needs? If yes, move the test to the real boundary instead.

Then check the test against every [junk pattern](#junk-patterns); a match fails
the gate unless the [retention bar](#retention-bar) names the contract it
independently guards. A test that would break under behavior-preserving
refactoring is asserting implementation, not behavior; rewrite it at the
owning boundary before landing it.

Bug regression tests must fail on the pre-fix code for the intended reason and
pass after the owner-boundary repair. A regression test that never demonstrably
failed proves the mock, not the fix. One regression at the owner boundary
covers the bug; do not replay the same scenario at every layer it crosses.

## Junk patterns

The shared checklist for both modes: the authoring gate rejects a new test that
matches one, and audits hunt for existing tests that do.

- assertion-free coverage probes;
- self-comparisons and identity copiers;
- copied fixtures, inventories, manifests, or export lists;
- exact source, import, or string greps;
- private predicate or call-shape tests duplicated at real boundaries;
- duplicate invocations of the same contract;
- provider-local replays of shared helpers;
- tests whose only purpose is preserving test-only exports, globals, or wrappers;
- dead production code whose only callers are tests;
- expected values produced by the helper or renderer under test;
- mocks that implement the asserted behavior, or one identical mock standing in
  for different APIs;
- fixtures that supply the receipt, admission, or callback ordering the owner
  should produce, or persistence asserted against a store the path never writes;
- capability tests that restate declared flags instead of exercising the
  delivery or acknowledgement the flag promises;
- negative controls that pass for an unrelated reason, such as a denial from a
  different guard or a rejection the production path never reaches;
- names or fixtures that promise more than the input exercises, such as a
  "retires the window" test asserting the window was not cleared.

## Value bar

Tests justify their maintenance cost by protecting behavior, a credible
regression, or an independently meaningful contract. In an audit, an existing
test that must change for behavior-preserving source reorganization is suspect,
not automatically deletable; the authoring gate still rejects new ones.

Before judging a candidate, read the complete test and production owner, its
entry point, callers, callees, sibling implementations, overlapping tests, CI
routing, and relevant history. Read root and scoped `AGENTS.md` files first.
When the test claims dependency-backed behavior, inspect the dependency source
or types directly.

## Discovery

Keep discovery read-only and report evidence before editing. For broad scope,
run parallel discovery lanes when available:

- core, API, contracts, and integrations (`packages/`);
- CLI, MCP, and plugin contracts (`packages/canonry/`, `plugins/`);
- UI, apps, scripts, and tooling (`apps/`, `scripts/`, `test/`);
- a cross-cutting pattern sweep.

Outside campaign mode, prefer a few high-confidence candidates over a large
speculative inventory. Hunt for the [junk patterns](#junk-patterns).

## Retention bar

Keep a test when it independently enforces a public API, plugin SDK, protocol,
config, migration, storage, security, platform, default, prompt-byte, generated
cross-language, package, release, or architecture contract. Also keep:

- call ordering when order is observable behavior;
- regressions with a credible failure mode;
- source inspection when it is the cheapest independent guard: it fails when
  the contract changes (the user-facing key, byte, or path) and survives an
  identifier-only refactor;
- a retained test that fails on the baseline: treat it as a possible product
  bug, reproduce it, and repair the owner rather than deleting it.

Static or slow is not a deletion reason. A test that resembles implementation
may still be the independent contract; prove otherwise before removing it.

## Candidate evidence

Record every field below before editing. A missing field means the candidate is
not ready for deletion:

- exact test name and location;
- what failure it can actually detect;
- non-test callers of the covered production or support seam;
- stronger remaining owner-boundary proof, or why no proof is needed;
- relevant history and the reason the test or seam exists;
- production or test-support deletion unlocked;
- risk and the focused validation command.

## Edit shape

Choose one coherent owner-boundary batch. Delete obsolete test-only exports,
globals, wrappers, and dead production paths instead of preserving aliases.
Move retained regressions to their canonical owners. Consolidate repeated
package or dependency assertions into one generic contract.

Prefer net-negative production LOC. Do not add replacement tests that restate
the same implementation, and do not convert uncertain candidates into cleanup
to increase deletion counts.

## Validation

Never edit source or tests while Vitest is running in the checkout. Follow
the root and scoped `AGENTS.md` files and [Canonry's testing guide](../../../docs/testing.md).

1. Before running tests, identify the observable contract, its primary owner,
   and the credible regression the selected tests should catch. For routine
   runs, scope this check to the affected tests; a full audit is not required.
2. Run the smallest owner and sibling tests from the repository root:
   `pnpm exec vitest run <test-path-or-filter>`. Use
   `pnpm exec vitest run --project <project>` for an affected package.
   Run the relevant package typecheck when types are part of the contract.
   Runtime `expectTypeOf` assertions alone are not compile-time proof; verify
   that a TypeScript or Vitest typechecking gate actually includes the test.
3. For regression repairs, prove the test fails for the intended reason
   before the fix and passes after it. During read-only audits, prefer
   temporary in-memory transforms over editing tracked source for fault probes.
   A green baseline alone does not demonstrate regression detection.
4. For removed source greps or plan assertions, run the executable script or
   dry-run that owns the real contract.
5. Run `pnpm check`, relevant package typechecks for code changes, and
   `git diff --check`. Run generation or drift checks only when their inputs
   change. Follow repository policy; full workspace validation belongs to CI
   unless the user requests it or a CI failure needs reproduction.
6. Inspect `git diff --numstat`; report production/tooling separately from
   tests and test support. Report local tests, fault probes, and CI separately.
7. After audit edits to tests or production, obtain an independent preservation
   review comparing removed coverage with the remaining owner-boundary proof.
   Do not land a cleanup that lost its only contract test.

## Landing and continuation

Commit, push, open a PR, or land only when authorized. Follow Canonry's root
`AGENTS.md` landing and versioning rules. Land one coherent PR at a time;
after landing, refresh from current `main` and rerun read-only discovery for
the next high-confidence batch.

## Handoff

Report:

- root cause and removed low-value categories;
- production owner simplifications;
- retained false positives and why they remain valuable;
- focused and full proof actually run;
- production versus test LOC;
- PR and merge state;
- named follow-ups.
