# Desktop UI audit checkpoint — November 7, 2026

The owner requested a WIP commit because usage limits were approaching. **This
checkpoint is not validated or ready to merge.** Resume this checkout and branch;
do not restart the audit or discard the existing PR work.

## State

- Branch: `codex/provider-settings-lifecycle`; PR: https://github.com/Canonry/canonry/pull/1480.
- Previous validated/pushed head: `c82a220548606f1fbbd7af16bf4cf7016d547953`.
- Latest fetched main: `3bd7d9bc47a109ddbcbfa8f2f3d95aa3c80c926e` (one additional
  docs/plugin commit). It has **not** been integrated into this checkpoint yet.
- PR version remains 7.98.0; npm was checked at 7.97.1.
- Impeccable 4.8.0 and its checksum-verified native engine 0.1.18 are installed
  at `~/.agents/skills/impeccable`. Context and detector commands work. The
  owner approved the Codex hooks; automatic invocation was not observed in
  this tool session. Explicit detector runs remain necessary evidence.
- `.codex/hooks.json` contains the local absolute install path and is excluded
  through Git's local info/exclude; do not commit that machine-specific file.

## Implemented in this checkpoint

1. Runs: compact status/project/type/date/search filters and a structured table;
   readable errors and Retry; run-drawer opener focus restoration.
2. Setup: wait for resumed run details before declaring missing answers; focus
   new step headings; keep an exit after failure; quieter completion layout.
3. History: grouped headings with contextual help, no impossible single-run
   comparison controls, and keyboard tabs.
4. Research: reduced repeated headings and empty panels. Conversions: supporting
   evidence in disclosures, runtime checklist opened by its action. Google Ads
   diagnostic metadata moved into Data details. **These four source files have
   not been built or visually checked after editing.**
5. SEO: actionable host-configuration guidance and visible disclosure cues.
   Bing: readable SDK errors and truthful demo-only read gating.
6. Shared tooltips: viewport placement, Escape, and hover handling. Search
   Engines tabs: keyboard behavior. GSC inspection filter: persistent label.
7. Property help buttons separated from heading names; real Not Found recovery;
   compact empty trends; durable rendered acceptance rules in DESIGN.md.

All changes preserve API data and measurement scope; no new metric calculations
or provider contracts were introduced. Recheck this claim during final review.

## Evidence and limits

Two independent assessments covered every routed page family through 62 native
desktop captures, plus setup. Assessment A froze at 26/40 before B released its
findings. A's browser became unavailable, so most visual observations used B's
neutral screenshots, without detector interpretations. Source detector scans
returned zero findings across 104 TSX files; this did not catch the verified
interaction and hierarchy defects.

The full reports, route matrix, screenshots, detector outputs and pre-fix files
are archived locally under:

`/Users/arberx/Developer/canonry/research_notes/pr1480-onboarding-ux-audit-2026-11-06/impeccable-desktop-2026-11-07/evidence/`

The original audit continues in the adjacent `AUDIT.md`. Temporary originals
remain at `/tmp/canonry-impeccable-full/`.

Fresh instance 4190 completed project creation, local provider connection, query
deduplication, a two-answer fixture sweep, reload/resume, dashboard entry, and an
optional public example.com site scan through skip/finish. These provider answers
were fixtures, not live vendor validation. Root verified the new Runs table in
dark/light and actual Escape return focus. Most remaining changed surfaces need
post-fix browser acceptance. Mobile was deliberately outside this review.
Populated Advanced Journeys and live OAuth connection flows were not exercised.

## Resume in this order

1. Read the repository/test-audit/installed Impeccable instructions. Inspect the
   checkpoint diff and the two assessment reports. Keep desktop density and
   fewer default explanations as the priority; preserve all evidence in details.
2. Finish known stale tests from the Research/Conversions lane:
   - `router.test.tsx` and `portfolio-route.test.tsx`: old
     `Generate and check questions` heading is now `Describe your customer`.
   - `conversion-integrity-section.test.tsx`: runtime guidance is now a native
     summary; account controls require opening Assessment details. Also verify
     the workspace action opens and focuses the runtime checklist.
     Preserve the summary's normal tab stop: workspace `focusElement` currently
     does not recognize summary as naturally focusable and can add `tabindex=-1`
     when the action reveals it. Fix that before keyboard acceptance.
   - `google-ads-performance.test.tsx`: old combined metadata strings now live
     in Data details. Preserve assertions on all fields and incomplete data.
3. Review the new shared `WorkspaceTabs.tsx` and `use-tooltip-position.ts` and
   their consumers. Build, then inspect changed pages in dark/light at desktop
   width. Check tooltip bounds/Escape, tabs with arrows/Home/End, dialogs,
   Research empty/populated states, Conversions collapsed/open/action states,
   History one/two-run states, Bing sample data and SEO recovery.
4. Finish optional minor findings: use existing `labelForVerification` instead
   of raw verification tokens in TrafficSourceDetailPage; move audit entity,
   session and API-key IDs into row Details while retaining search/raw evidence.
   Do not invent SEO geographic names: its current DTO only supplies a numeric
   location code. Activity freshness duplication still needs source verification.
5. At source freeze, integrate latest main and run final validation. No tests
   ran during this iteration. Earlier builds passed **before** the last batch;
   they do not validate this checkpoint.

```sh
pnpm check
pnpm --filter @canonry/canonry-web typecheck
pnpm --filter @canonry/canonry-web lint
pnpm exec vitest run --project web
pnpm build:web
git diff --check
```

Confirm the Vitest project name in `vitest.config.ts` before running. Focused
owners include router, setup-ai-visibility-onboarding, measurement-property-page,
seo-data-section, audit-history-panel, app-embed-callgraph, bing-section,
design-system-components, gsc-public-demo, app, portfolio-route,
conversion-integrity-section/workspace, google-ads-performance and trend-card.

Run finalized regressions against pre-fix owners, expecting intended failures,
then restore byte-for-byte and run passing checks. Use the previous validated
head for root fixes and `evidence/b/baseline/` for B's fixes (those retain earlier
History/SEO work). Isolate the focus control: restore only App.tsx and
RunDetailLink.tsx while retaining new RunsPage, otherwise the test fails earlier
on its status selector. Other controls: setup delayed detail/focus, missing-route
recovery, Property heading names, SEO recovery, single-run comparison, Bing
error/demo reads, tooltips and keyboard tabs. Never edit while Vitest runs.

6. Run the installed detector across final UI sources; inspect findings in
   context. `impeccable doctor` reports missing colors/components sections even
   though DESIGN.md specifies them under Color and themes/Controls; do not treat
   that heading-parser warning as missing product guidance.
7. Update audit notes and PR description with actual final checks/screenshots.
   Commit/push only after required checks pass; match tested SHA to remote/PR
   head and require GitHub MERGEABLE. Do not merge or release without instruction.

## Local instances

- 4182: existing disposable audit instance, config
  `/tmp/canonry-pr1480-ui/instance/config.yaml`; safe fixture login file
  `/tmp/canonry-pr1480-ui/browser-login` (read without printing).
- 4190: fresh audit instance, `/tmp/canonry-impeccable-fresh/config.yaml`, same
  disposable authentication. Cookie names overlap across localhost ports, so
  switching instances may require signing in again.
- 4191: view-only sample data, Simple `summit-roofing`, Advanced `harbor-resorts`.
  Restart after web builds to reload its HTML: `node packages/canonry/dist/cli.js
  demo --host 127.0.0.1 --port 4191 --format json`.
- 4183/4185: local answer/OpenRouter fixtures. No real keys are needed.
- Leave the original instance on 4180 alone. Audit tabs/viewport were cleaned up.

The user explicitly requested this unvalidated checkpoint. Keep that distinction
visible in the next status update; do not call the audit fixes complete yet.
