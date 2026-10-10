# web

## Purpose

Vite SPA (React 19 + TanStack Router/Query + Tailwind CSS 4) for the analytics dashboard. Built and bundled into `packages/canonry/assets/` for distribution. This is the lowest-priority surface — never block a release on UI work.

## Product and design context

Read the repository-root `PRODUCT.md` and `DESIGN.md` before UI work. They are
the durable product and interaction contract. This file owns implementation
constraints; `DESIGN.md` owns hierarchy, copy, typography, and control choices.
The implementation rules here must not override their hierarchy, copy,
accessibility, or control standards.

The dashboard follows a dark, professional analytics aesthetic inspired by
**Vercel's design system** — clean, minimal, high-contrast, and
information-dense. Rival tools like Semrush, Ahrefs, and Profound for data
richness, but match Vercel for polish: generous whitespace, sharp typography,
subtle borders, no visual noise.

## Key Files

| File | Role |
|------|------|
| `src/styles.css` | Tailwind v4 entrypoint, global component classes, semantic color/chart tokens |
| `src/api.ts` | `apiFetch<T>()` wrapper, `ApiError` class, all API call functions, `getEmbedConfig()` (#716 — reads `window.__CANONRY_CONFIG__.embed`, returns the block when enabled else `null`; `typeof window` guarded for SSR) |
| `src/embed.ts` | Read-only embed mode (#716) presentational helpers: `embedViewIdForPath(pathname)` (coarse route→view-id map for the route allowlist), `effectiveEmbedProjectTabs(embed)` / `filterEmbedProjectTabs(allow)` (the project-TAB allowlist actually in force — `embed.projectTabs` normalized against `EMBED_PROJECT_TABS`, `undefined` outside embed; the one value every project surface gates on), `isEmbedProjectTabAllowed(tab, allow)` / `resolveEmbedProjectTab(requested, allow)` (used by `ProjectPage` to filter the subnav + fall a hidden tab back to a visible one, and by `MeasurementPropertyPage` for its `portfolio` gate; finer than the coarse view allowlist), and `embedThemeStyle(theme)` (allowlisted `--canonry-embed-*` CSS custom properties with per-value strict color-regex sanitization — CSS-injection guard) |
| `src/router/routes.tsx` | TanStack Router route tree |
| `src/pages/` | One file per page (ProjectPage is largest at 1,600 LOC) |
| `src/components/shared/ChartPrimitives.tsx` | Recharts wrapper — chart components and styling constants |
| `src/components/shared/ToneBadge.tsx` | Status indicator component with tone colors |
| `src/components/project/` | Project page section components (GscSection, TrafficSection, `SiteHealthSection`, etc.) |
| `src/components/project/SiteGraphSigma.tsx` / `site-graph-sigma.ts` | Site Health WebGL map and its Graphology adapter; consumes server-published coordinates only. The map defaults to content links and hides nav/header/footer links; the toggle changes only which edges are DRAWN, never the positions, which the server laid out without them. When `isTemplateDetectionApplied(templateDetection)` is false the toggle is disabled with plain-word copy and nothing is hidden, because the per-link flag proves nothing then. The header strip is ONE line of numbers (`site-map-link-counts`, built by `siteMapLinkCountsLabel`); why the split is worth having, which rule produced it, and any stale-layout warning live in an `InfoTooltip` beside it (`siteMapLinkRuleHelp`), always, in every state, because `applied` means the weaker ubiquity rule that cannot see an editorial link whose wording matches the menu. CUSTOMER-FACING COPY SAYS "links in your page text" and "menu and footer links", never "content link", "template link", "nav", or "chrome": those are our words, and the reader's distinction is WHERE the link was written. The wire vocabulary is unchanged and must stay (`linkKind=content|template|all`, `isTemplate`, `templateDetection`); this split is copy only. Short visible label, detail in a tooltip is the rule across this surface: an InfoTooltip is placed as a SIBLING of a heading, never a child, or its help text joins the heading's accessible name and any `aria-labelledby` landmark that points at it. Site Health tests assert complete independent help literals through mounted controls and real SDK reads. Keep copy and count helpers private unless another production caller needs them; retain compiled style contracts through the shared test-only Tailwind producer. |
| `src/components/project/PageAuditEvidence.tsx` | Site Health "Findings and fixes": the per-factor technical checks. Every check starts COLLAPSED so the page opens scannable; the `<summary>` row carries factor name, score, and pass/partial/fail, which is everything needed to decide what to open. Native `<details>` is the disclosure primitive here, so the toggle is a real button with browser-managed expanded state and closed content stays out of the tab order. Critical defects render in their OWN always-visible section above the checks, so collapsing hides nothing that demands attention. |
| `src/components/project/SiteHealthSection.tsx` | Site Health scan controls and results. Ordinary default selection uses the API scan history's `preferredRunId`, labelled "Most complete scan from latest day"; explicit historical and onboarding active-run selections remain pinned, and a scan started from the header is shown once it finishes (completed or partial) until the operator picks another. Technical factor badges use the API's worst-page `status`, separately from the displayed mean score. The page-budget picker's first choice sends no `maxPages`, so the server applies the project's saved `siteAuditMaxPages`, else the full site; never fill in a number client-side, which would bypass the saved budget. When the project saved a smaller budget, a one-off "Full site" choice sends the 50,000 hard limit explicitly (`oneOffFullSiteChoice`). Project Settings edits the saved budget in `SiteHealthScanSettingsSection` (`ProjectEngineSettingsSection.tsx`): admins only when `isDashboardManagedRunKind('site-audit')`, read-only in embeds and the public demo. `updateProject` sends `siteAuditMaxPages` only when the caller sets it, so every other save keeps the stored value. Budget wording comes from `formatSiteAuditPageBudget` / `formatPageCount` in contracts, shared with the CLI. |
| `src/components/project/AddQueriesSheet.tsx` | The Tracked **Add queries** sheet, Advanced projects only (`AdvancedTrackedPage` in `src/components/project/queries/advanced/AdvancedTrackedPage.tsx` opens it; Simple projects keep **Add query** and the Add query form). Subject is the same three choices for every project: Market, Location, Company. Market sends one addition per line, `{ input: { source: 'manual', text }, audience: { marketKeys: [key] } }`, with no `contexts` (the server applies the market's frozen engines and search locations) and `queryClass` only when Type is not Automatic: the same request the Add query form sends for a market. Location sends `audience: { targetKeys: [key], marketKeys }`, where `marketKeys` is every market in `workspace.markets` with a usage edge for that location, again with no `contexts`: the query takes those markets' engines and search locations and counts in their numbers, which the form's location add does not do. The server adds no markets itself: this rule is the sheet's, and `docs/query-visibility.md` ("CLI and MCP") gives the same request for other callers. The sheet lists those markets read-only on one line ("Counts in"); that the query is asked with those markets' engines and search locations is the `InfoTooltip` beside it. A location in no market sends `{ targetKeys: [key] }` with one of the caller's `contextChoices` (the form's own choices, built in `src/components/project/queries/AddQueriesEntry.tsx`): the only one when there is one, otherwise a required "Search location and engines" select that keeps Review off until chosen. Lines are de-duplicated with `normalizeIdentityText`, the identity the server matches on. The one place picker reads `workspace.scopeOptions` filtered to the Subject's kind and the groups that lead to one (`placesOf`), with `allowGroupSelect={false}`, so a group row only browses and never opens on an empty list, and with `propertyNoun` so the picker says "location", never "property". A Subject change drops the chosen place, because a query has one subject. A Type other than Automatic shows in the closed "More options" summary, because it is sent on every line. Company is disabled, and its reason ("Not available yet") is the option's own description and hover title, with no line under the control. A hover title shows on neither a tap nor keyboard focus, so an `InfoTooltip` after the control says "Company is not available yet."; it comes after the control, never beside the Subject label, because the sheet focuses its first control when it opens and focus opens a help bubble. The form stays one click away through the "Hand-picked locations, templates or saved research" link. The hand-off carries the first line into the form, which holds one query, and the sheet says so when there are more lines; the chosen place is not carried, because a market checked in the form would narrow hand-picked locations to that market. The sheet publishes through its own `useQueryTrackingPublish` and draws the review its caller passes (`renderReview` takes a `TrackingReviewState` and returns `{ changes, actions }`), so it shows the same `TrackingReview` as every other advanced tracking change; `actions` (`TrackingReviewActions`: Publish or Review again, Back and the sweep pause) are pinned in the sheet footer, in reach however long the list is, and Back is off while a publish is in flight. The app's toasts render under a modal sheet, so a refused review or publish keeps the review step up, showing the hook's `error` with Review again (the draft rebuilt against the refreshed workspace, or the reviewed change as it was when the draft's place is gone, so the server says why); Back returns to the draft, which shows the same `role="alert"` line until the next request. A sheet opened without a Radix trigger returns focus to its opener itself. Copy says "query". Visible copy is short labels with the detail one step away: the dialog description is `sr-only`; the Queries hint is the placeholder ("One query per line"), an `InfoTooltip` beside the label ("Blank and repeated lines are skipped.") and the live count ("3 queries") once there are lines, on a line held while empty so the first line typed does not move the form; the form footer says nothing about publishing, because Review does not publish. Escape on an open help bubble closes the bubble, not the sheet (`keepOpenForInner`), so it never costs the draft. `defaultMarketKey` / `defaultLocationKey` start the sheet on a place: Tracked passes the market or the single location its filter is set to, and `defaultLocationKey` also starts Subject on Location. `onOpenComposer` is optional: a caller with no Add query form leaves it out and the sheet shows no hand-picked link. `TrackingAddQueriesSheet` in `queries/AddQueriesEntry.tsx` is the one place that fills `contextChoices` and `renderReview`, so every entry point shows the same review. The location page (`MeasurementPropertyPage`) is the second entry point: `AddLocationQueryButton` (in `queries/AddQueriesEntry.tsx`, re-exported from `DiscoverySection.tsx`) renders "Add query about this location" in the assigned-queries header, for writers only (the page renders nothing for a viewer, and no embed renders the page). It reads `/query-tracking` only once pressed (`queryClient.fetchQuery` in the click handler), so the page load makes no extra request, and shows "Opening…" until that press's read settles, offline included. The sheet opens only when that read resolves and its `scopeOptions` hold this location, with `defaultLocationKey` and no `onOpenComposer`; a failed read, or a workspace without the location (the page's setup read is then refreshed), shows a `role="alert"` line and the next press reads again. Never tie the sheet to a `useQuery` flag that stays set after a failure: every project write refreshes the project's reads, which would open the sheet with no press. The `useQuery` there is enabled only while the sheet is open, so a refused review still refreshes the workspace version. The page reads no runs, so it passes `sweepActive={false}`: the server's sweep refusal shows in the sheet. A publish refreshes the page through the hook's `invalidateQueryTrackingPublication`, which covers every `getApiV1ProjectsByNameMeasurement*` read the page makes. The page lists one Query type, and the server files a query that names the location as Branded (`proposeQueryClassForTarget`), so a new query often lands under the type the list is not showing. `onPublished` (the hook's `onCommitted` result, passed through the sheet) gives the page the published query ids; once its setup read reaches that revision it shows "1 query you added is listed under Branded queries." with a "Show branded queries" button that sets Query type. Do not prefill the sheet's Type from the page's Query type: that is an operator override and would file a query that names the location as Non-brand. |
| `src/components/project/TrackingReview.tsx` | The review of a tracked-query change on an Advanced project: add from the sheet, add from the Add query form, edit and remove (`TrackedQueriesGate` in `DiscoverySection.tsx` gates on `workspace.mode`; Simple projects keep `TrackingPreview` in `src/components/project/queries/SimpleTrackedQueries.tsx`, unchanged). It shows only what the preview response returns. The number grid reads Queries before and after (`limits.queries.current` to `next`, the server's count of the queries the plan asks, so a query that loses its last assignment leaves the count while its row stays; a server that omits `limits` falls back to the post-change `tracked` length, and that length less `diff.added` plus the `diff.removed` rows gone from `tracked`), Answers per sweep (`workload.existingProviderCalls` to `nextSweepProviderCalls`), and `addedProviderCalls` and `removedProviderCalls` as separate cells, never netted. Under the grid one caution line reads "New numbers after the next sweep"; what a publish does to the numbers until then (AI Visibility keeps the last sweep, location pages and competitor results show none, past answers are kept) and that publishing runs no sweep are the `InfoTooltip` beside it, which opens downward because the heading scrolls to the top. A no-op shows neither: its heading already says "No tracking changes". The Changes table has one row per `diff.added`, `diff.reused` and `diff.removed` query: a Change badge, the query, Type, Location links (the server's `assignmentCount`, one per location and search location the query is asked for, so it can pass the number of locations the row's disclosure names; shown as a minus count on a removal) and Search location and engines (one label, or how many combinations). Type, search locations and the per-row "N locations" button (it lists each location with its type, groups, markets and search locations in a full-width row under the query, never inside the narrow Query cell) come from the post-change `tracked` row, so a Removed row leaves them empty: for a scoped removal that row holds only what survives. `diff.unchanged` sits in the same table behind the "N unchanged queries" disclosure, each row with its own Classifications. Publish reads "Publish N changes" (added + reused + removed; the server lists a reused query without saying whether the change alters it, so each one counts) and is off for a no-op ("No tracking changes"), during a publish, and while `sweepActive`, with the sweep notice. After a refused review or publish the caller keeps the review up with `preview: null` and the hook's `error`: it shows the server's message, which takes focus, and Review again, which sends the same change against the refreshed workspace. The caller passes `contextLabels`, so a search location and its engines read as they do in the Add query form. Copy says "location" and "query", never "property". |
| `src/components/project/queries/` | The Queries tab behind `QueriesSection`. `DiscoverySection.tsx` keeps `QueriesSection` (the Tracked and Research tabs), `TrackedQueriesSection`, which reads the workspace, and `TrackedQueriesGate`, which gates on `workspace.mode`. `SimpleTrackedQueries.tsx` is a Simple project's tracked list, Add query form and `TrackingPreview`; `advanced/AdvancedTrackedPage.tsx` is an Advanced project's list, Add queries sheet and `TrackingReview`. Both draw over `use-tracking-composer.ts` (the open form, its draft, the change under review and the rows in view), which the gate calls once above them: a mode change (a first plan published, or the plan removed, from elsewhere) swaps the page and keeps the open form, its draft, the change under review, the search and the page number. The swap redraws the page, so focus is lost, and a Simple page does not draw an open Add queries sheet. Both share `TrackedCells.tsx`, `TrackingComposer.tsx` (the Add, Edit and Remove query forms), `tracked-rows.ts`, `tracking-draft.ts` (draft to request) and `tracking-contexts.ts` (search location and engines labels). `AddQueriesEntry.tsx` holds `TrackingAddQueriesSheet` and `AddLocationQueryButton`; `QueryResearchWorkspace.tsx` and `FindQueriesSection.tsx` are Research. `DiscoverySection.tsx` re-exports `AddLocationQueryButton` and `DiscoverySection`, so pages keep importing from it. The two import each other (`QueryResearchWorkspace.tsx` takes `WorkspaceTab` from the host), and the build prints no circular-import warning, so a file in this folder takes only types and function declarations from `DiscoverySection.tsx`. The folder is a stated exception to "no new component files unless reused across 3+ pages": the tab was one 1,984-line file. |
| `src/components/project/RunAdmissionNotice.tsx` | The AI Visibility notice for a sweep that is refused, or leaves out providers that keep failing on their accounts, from `GET /projects/:name/run-admission` (`useRunAdmission`, read once by `ProjectPage` above both overviews and their loading state). While refused, the header sweep button reads "AI sweeps on hold" and is disabled, because the API would refuse it; the confirm sheet names the providers a sweep leaves out. Copy states when the hold lifts, never that a sweep will run (a project may have no schedule). The settings action appears only for a rejected key and deep-links to `/settings#provider-<name>`; credit is added in the provider's console. Saving a provider invalidates every project's admission (`invalidateProjectQueryDomain(…, 'runAdmission')`). |
| `src/queries/` | TanStack Query hooks for data fetching |
| `src/view-models.ts` | Data transformation from API DTOs to display format |

## Patterns

### Build workflow

`pnpm --filter @ainyc/canonry-web build` builds into a temporary directory before updating `dist/`.
It reuses output only when source, workspace dependencies, configuration, build environment, and output contents match the cache.
The cache lives under `.tmp/web-build/`. `build --force` bypasses it. `pnpm build:web` also copies the SPA into Canonry.
The cache includes Vite's resolved environment, including variable expansion and symlinked environment files.
The web package's `build` command caches `--mode` (`-m`), `--base`, and `--sourcemap` options.
Other Vite options use the native CLI without caching, preserving custom output paths, watch mode, and SSR behavior.
`pnpm dev:web` remains the dashboard development server.

### Simple query evidence

Sentiment is a branded figure: a non-brand answer almost always names the
brand to recommend it, so its favorable share says little. Portfolio overview
sentiment (`SentimentOverviewMetric`) shows only the server's
`sentiment.branded` score, never `overall` (kept in the API for compatibility)
or a client-side blend. Hide the metric and its layout slot when no judged
branded score exists. Keep counts, class scope, confidence and provisional
status in its tooltip, and "branded queries" in its screen-reader text.

The Sentiment block (`SentimentHeadlines`) opens with a title row: the
"Sentiment" heading and its subtitle on the left and, when the caller passes
`manage`, Manage sentiment (`SentimentControls`) on the right. The bar legend
sits under the title. Every query-class view shows only the Branded line
(`headlineClasses` returns `['branded']`). The all-queries and non-brand views
add the non-brand line (`NonBrandCriticism`) under it: the server's non-brand
`coverage.counts.unfavorable` and `.mixed`, never a favorable share, with a
"View answers" button that opens the evidence sheet filtered to
`outcome: ['mixed', 'unfavorable']`. The all-queries view shows the line only
when either count is above zero. With saved answers, the non-brand view also
states loading, an error with Retry, "Analyzing sentiment…" while it runs,
`SENTIMENT_COPY.nonBrand.notRated`, or `nonBrand.none` (`nonBrand.noneSoFar`
while provisional). With no line to show (sentiment off, its source not
resolved, or an unclassified view) a `manage` caller still gives an
administrator the title row and its switch, with "Sentiment is off." only when
settings say `enabled` or `installEnabled` is false.

The Branded line is one full-width line under a small eyebrow header
("Favorable", "With opinion", right-aligned over their columns, `aria-hidden`;
the second's `title` is `SENTIMENT_COPY.rated`): the class label and its ⓘ, a
stacked bar of the class's favorable, mixed and unfavorable counts that takes
all remaining width, then three fixed columns. Favorable holds only the
server's score; With opinion holds only the server's share of answers rated,
`coverage.ratedAnswerRate` in `formatPercent` (3 of 4 answers reads 75.0%),
never a division in the component and never `coverage.judged` over
`coverage.selected` (those count assessments, one per answer and subject, and
only admitted ones). The server counts every eligible answer, admitted or not,
and an answer assessed for several subjects once. Its counts ("3 of 4 answers
rated", `coverage.ratedAnswers` of `coverage.eligibleAnswers`) are its tooltip
and screen-reader text, and Details lists them as "Answers with an opinion"; a
class with eligible answers and none admitted reads a measured 0%. The empty
value appears only with no eligible answers ("No answers yet"), while sentiment
is off ("Sentiment is off.") or from a server too old to send the counts
("Unavailable", which makes no claim about answers), never a second metric or a
sentence; the last column is the Details chevron, a chevron-only button named
"Branded details". The line's state while it has no ratings, or "Partial
results", is a note under its bar.
The header and lines share one column grid (subgrid), so the bars start and end
level and each figure sits under its header; on a phone the bar drops under the
label and figures and the columns stay aligned. Details opens a floating panel
anchored under its button, right-aligned to the line's end, over the content
below rather than pushing it down: a non-modal popover (button with
`aria-expanded` and `aria-controls`, panel `role="group"` named by its class
heading, never `role="menu"`) that follows the button in tab order and closes on outside
pointerdown, Escape (focus returns to the button) and focus leaving, like the
project "More" menu. Only one panel is open at a time, and an open panel lifts
the section's overflow clip. Inside, compact label/value lists with tabular
numbers in a fixed-width panel hold, in order: the coverage rows, "Likely range
(95%)", the most criticized Properties, then a `<p>` caption "Not counted in
the favorable share:" above the checks not yet analyzed and each no-opinion
outcome under its plain label (`OUTCOME_LABEL`). "Most criticized properties"
lists the server's `summary.criticizedProperties` (`mostCriticizedProperties`
maps its `keys` onto the property `breakdowns` in the server's order; the
component never ranks or cuts), with "N of total" beside the title when the
server found more, each Property's "F of J favorable" and a thin outcome bar,
then "View all unfavorable and mixed answers". A Property button opens evidence
scoped to that Property (`scope: 'property'`, keeping a market view's market as
`marketKey`) filtered to mixed and unfavorable. Each segment grows by its own API
count (no UI math) in the `progress-fill-*` tones; the legend names the tones once
the bar has segments; the bar is `role="img"` with every count in its label and
is never a tab stop. Below `SENTIMENT_MIN_RATED` (10) ratings, zero included, the
line's Favorable column shows the app's empty value (`\u2014`, muted) with
"Shown from 10 ratings" as its tooltip and screen-reader text, never "too few"
or a count toward the minimum; the portfolio's branded figure reads "too few"
instead of its score. The bar is then a plain track with no segments (they would
draw the hidden share), and its Details list the rated outcomes and the
"Favorable share: Shown from 10 ratings" row. No ratings draws an empty track
over the line's short state. In Query evidence (`QueryEvidenceSummary`) the
section's actions (Manage queries) sit in a row above the Sentiment block, and
the block carries Manage sentiment in its title row (`manage={Boolean(actions)}`);
an embed has neither. The Advanced report's block always passes `manage`, and
`VisibilityOverview` shows `SentimentControls` on its own only when the report
view does not render. The query editor opens directly under the bars
(`actionPanel`). Branded query rows keep their score beside its rating count.
Non-brand query rows (`SentimentQueryScore`) show only their unfavorable and
mixed counts, which open that query's evidence filtered to them (marked
Provisional while unfinished), or a muted em dash with sr-only "No unfavorable
or mixed answers"; never a favorable share. Only a final read (`complete`, not
provisional, nothing unadmitted) earns that dash or the block's "none": an
unrated, pending, failed, canceled or partial row says its own state.
Evidence verdict badges are toned by outcome (favorable positive, mixed
caution, unfavorable negative, anything else neutral). `VisibilityOverview`
resolves sentiment to the report's sweep with no revision
(`useSentimentResolvedSource(run, null)`), so the sweep is read at its own plan
revision: the report restates an older sweep onto the current plan, which
matches no stored assessment. Coverage and confidence belong in closed Details
disclosures; data-processing disclosure belongs in Enable/Manage sentiment.

Simple projects render `VisibilityTrendSection` ("AI answers over time"), the
competitive summary, By engine, and `EvidenceTable` directly, in that order,
including in embeds and when an unpublished Advanced draft exists. The trend chart is the
first section after the tabs; do not put a summary card or table above it. Do
not replace that layout with `VisibilityWorkspace` when a unified report
becomes available. Published Advanced plans retain their own report workspace
and scope controls.

The query table's evidence rows read the latest completed sweep's own
`GET /runs/:id` snapshots, never the capped timeline alone: newer failed sweeps
can fill that window, and a query answered there still gets its row
(`buildEvidenceFromTimeline`). The timeline holds runs of every status, so a
row's state and change read its history only up to the snapshot's own run; a
cancelled run or a sweep still running after it never moves the row. The
trend's sweep dates and the sentiment backfill's sweeps read `visibilitySweeps`
(every completed or partial sweep, from the whole run list), never the five-row
`recentRuns`.
Non-brand counts on By engine read amber below 70% of their base and green from
it (`coverageTone` in `lib/answer-movement.ts`), never red; branded and
unclassified counts are never toned.

`VisibilityTrendSection` ("AI answers over time") is an AI Visibility card: the
latest point's date and sweep count, one headline figure with its base, the
chart, and a closed Details. It prints no change figure while the first and
latest points measured different queries (`querySetShift`), except mention
share when every query they do not share is branded, and says why in Details.
The server restates every point to the queries tracked now and rejoins a
query's old answers by its text, so two points differ only when a query tracked
now is in the set at one and not the other (its membership at the first
point's first sweep and the latest point's last, replayed from
`basketChanges`), or when either point pools sweeps from both sides of such a
change. A query removed for good, or removed and added back between the two
points, leaves them comparable. A point's
`queryCount` is the queries it has answers for, not the size of the query set,
and the response carries no set size: a point that mixes sweeps counts only
the queries its first and last sweeps differ by (`QuerySetShift.moves`), never
a sum over the changes between them. Model
names live in "What changed" and the point tooltips, never the legend. "What
changed" (`modelChangeRows`, `querySetChanges` in `lib/visibility-trend-helpers.ts`)
lists query-set and model changes by engine, collapsed to one line; a Perplexity
preset (an id without "/") never gets the amber substitution row, and its served
model rides on its row instead. Model notes name engines as the page does
("OpenAI"). The Date ⓘ names the sweep before a change only when it is provably
the adjacent one (`sweepBefore`); a pooled point hides the sweeps inside it. On
a phone the table wraps to the card rather than scrolling.

"Where competitors are winning" (`MentionShare` in
`MentionShare.tsx` plus two `OverviewMetricRow` gap rows in `ProjectPage.tsx`)
uses the same sentence-case heading and flat section layout as By engine.
Its own Non-brand/Branded radiogroup switches the mention share figure, its "X of Y brand mentions" caption and the brand ranking
table (Domain with "(you)", share bar, Mentions, Share) together; a pooled share
shows "All queries" and the "Set a brand name" note instead of the control.
Under a rule, "Mention gaps" and "Citation gaps" read GET /overview's
`mentionGaps` and `gapQueries` over all queries. Show "All queries" above them
and include that scope in each value's accessible text. Show the denominator
once, beside the count, rather than repeating the server's caption. They have
no class split, so the class control never touches them. The section needs no
read beyond /overview.

Above the query table, "By engine" (`CitationVisibilitySection`,
`byEngineClasses`) is one class at a time, Mentioned and Cited query counts per
engine from GET /citations/visibility, one "Competitor cited instead of you"
answer count with its base, and the cited-but-not-named split in Details; no
summary tiles or per-model rate table. Below query evidence, "Past sweeps"
(`PastSweeps`, operator only) starts collapsed and retains one line per sweep:
time, trigger ("Spot check" for a probe) and duration in words, with a partial or failed sweep's error detail kept; the time
opens the run, and RunsPage keeps `RunRow`. "Competitors over time" is the
`CompetitorLandscape` section described under Competitor landscapes, inside
closed "Competitor history" in both Simple and Advanced. Fetch historical
competitors when that disclosure opens. Every class,
metric and window control on these cards, the trend's included, uses
`SegmentedRadioGroup`. On a phone all three fit the card with no inner
scroller, in CSS only: By engine closes up its columns and wraps "Of 11
queries" (`.av-grid-dense`), Past sweeps puts the trigger and duration under
the time (`.av-grid-sweeps`), and Competitors over time gives each brand's name
and Pin/Unpin their own line above its three figures (`.av-grid-brands`). The
desktop grids are unchanged. The Simple context
row and the embed header name no date range ("All time" read over latest-sweep
figures); each card states its own sweep, point or window.

Keep the Latest signals block and suggested queries out of the Simple overview.
The underlying insights and suggestions remain available through the API.

Use `compileQueryClassifier(effectiveBrandNames(project))` for Simple query labels.
Apply the same classifier to measured and pending queries.
If no usable brand identity exists, show `Unclassified`, never `Non-brand`.
Keep the query-class filter separate from the Mentions/Citations control.
Preserve provider and location grouping within each class. Rows sit in one
labelled row group per class, Non-brand first, then Branded, then Unclassified,
each heading counting that class's queries after the filters. Engines read by
their display names (`providerDisplayName`). "new query" marks only the latest
sweep's `addedQueries`; "First mention" stays for an engine new to an old query.
The Answer engine selector filters evidence before query grouping, so counts,
histories, previews, and answer actions use only that engine. Keep it separate
from text search and preserve a selected engine when location changes leave no
matching evidence, with All engines available to recover.
`Find a query` matches query text only, never engines, locations, answers, or
source URLs. Use underline signal tabs, one answer-preview checkbox, and plain
query-class/engine metadata in this table. Keep status and change labels readable
without capsule backgrounds. Native query buttons own keyboard expansion;
timelines announce the selected mention or citation signal.
Mention previews lead with highlighted answer text. Citation previews lead with
captured source URLs, with answer text in a closed disclosure. Keep grounding
fallbacks labelled and domain-only evidence as text; missing answer text never
hides captured sources.
Render preview answers through `AnswerMarkdown`, preserving paragraphs, lists,
safe links and prose highlights. Shorten the parsed text, never raw Markdown.
Latest-run signals use two aligned rows, mention then citation, with no wrapping
separators or duplicate observation summary.
Advanced Measurement uses its own evidence components and frozen Target assignment classes.
Do not replace those classes with the Simple project classifier.

Saved answer source lists use `SourceLink` to show the title and full, wrapping
URL. Only HTTP(S) destinations are clickable. Keep source classification and
counted disclosures in Advanced and Research views.

### API calls (Critical)

**Every web call into the canonry API MUST flow through the generated
`@ainyc/canonry-api-client` SDK.** Raw `fetch()` and `XMLHttpRequest` are
banned in `apps/web/src/` (ESLint-enforced) — the only exceptions are
`src/api.ts` and `src/api-aero.ts`, which are the SDK wrappers /
EventSource consumers respectively.

Why: the generated SDK is regenerated from the OpenAPI spec on every
`pnpm gen`, so types stay in lockstep with the server. Raw `fetch()`
also bypasses the `heyClient` response interceptor that handles 401/403
auth expiry — a missed-fetch login bug is silent until the user
notices their session died.

Two ways to call the API; pick by what you're building:

**1. TanStack Query hooks (preferred for cached reads + mutations)** —
generated `<op>Options(...)` / `<op>QueryKey(...)` / `<op>Mutation(...)`
helpers from `@ainyc/canonry-api-client/react-query`, passing the
exported `heyClient` from `src/api.ts`:

```typescript
import { useQuery } from '@tanstack/react-query'
import { getApiV1ProjectsByNameOptions } from '@ainyc/canonry-api-client/react-query'
import { heyClient } from '../api.js'

function useProject(name: string) {
  return useQuery(getApiV1ProjectsByNameOptions({ client: heyClient, path: { name } }))
}
```

- Cache keys are derived from path + query params automatically.
- Auth-expiry (401/403) flows through the `heyClient` response interceptor.
- Generated types come from the spec; consumer types stay in sync.

`createQueryClient` installs successful-write refresh handling on `heyClient`.
It starts background refreshes of affected generated/composite reads and global
lists, marks inactive reads stale, and never holds a successful write open for
refetches. Cancel only active reads; imperative initial loads must retain their
promises. Run launches refresh run state; completion refreshes results, without
rescanning analytics or live integration reads on launch. Direct SDK calls and API wrappers share
this path; don't add a second ordinary success refetch. Job completion and local
imperative state still use their own refresh flows. New composite query keys
must declare their project identity position in `queries/query-invalidation.ts`.

**2. Typed wrappers in `src/api.ts` (for composites + imperative reads)** —
each wrapper is a thin shim over a generated SDK call that handles `ApiError`
mapping + 204 No Content + base-path resolution. Use them when you need
composite orchestration (parallel fan-out, multi-endpoint queryFn) that the
generated `<op>Options(...)` helpers can't express in a single call.

```typescript
const projects = await fetchProjects()  // returns ApiProject[]
```

If a wrapper you need doesn't exist, **add it to `src/api.ts` calling the
generated SDK function** — don't reach for `fetch()`. The pattern is:

```typescript
export function fetchMyNewThing(name: string): Promise<MyNewDto> {
  return invokeWeb<MyNewDto>(() =>
    getApiV1ProjectsByNameMyNewThing({ client: heyClient, path: { name } }),
  )
}
```

### Query control and measured results

The project context row owns the measurement scope control on AI Visibility and
tracked Queries. Tracked Queries decide it from the query-tracking workspace for
every role. Tabs own recovery. Scope-blind tabs show Project-wide only when
scoped. Scope options come from the server on both surfaces. `projectScopeSlot`
in `lib/project-scope.ts` decides the slot for each tab; embeds get none. The
row's report picker reads `useVisibilityReportFirstPage`, whose key is
`visibilityReportFirstPageQuery`, the same first page the workspace and class
normalization use, so the row adds no request. The tracking picker observes the
Queries body's own workspace key and takes `workspace.scopeOptions`; a scope
change there drops the market. Both pickers bind the trigger to the URL
selection, and the label stays sr-only so `aria-labelledby` still names it.
Both slots read alike (`placeSlot` in `ProjectPage.tsx`): a visible `Place`,
hidden from assistive tech because the picker's own label already names the
trigger; the picker, whose project option reads "All of {project}" through
`rootLabel`; then "N locations · M markets". The counts are the lengths of
lists the server returned, never a recount: `workspace.targets` and
`workspace.markets` on Queries, the report's `scopeOptions` by kind on AI
Visibility. They are the project's totals, so they show only while the whole
project is selected; beside a group, market or location they would read as its
own, and the trigger already names it. An empty list is left out ("1 location",
never "0 markets"). While the report loads, the slot keeps `Place`, a 44px
placeholder and, for the whole project, a second one the size of the counts, so
the tabs below do not move. Below md `Place` sits on its own line above the
picker, so the open menu starts at the page gutter, and the counts take the
line under it. The copy is
`PROJECT_SCOPE_COPY`. The picker says location and place in every label;
`property` and `scope` stay on the wire and in code. The slot's `md:max-w-2xl`
cap in `styles.css` is what fits the label, the trigger and the counts on one
line; `portfolio-route.test.tsx` pins it.

AI Visibility property drilldowns retain an explicit `measurementMarketKey` in
URL, aggregate, evidence, pagination and cache identity. Linked groups use only
server-declared market keys; never infer query geography from a label or shared
property membership. Standalone property questions are grouped by saved market.
Query administration remains an assignment editor; entering it clears the report's
market intersection instead of silently widening a scoped edit. Linked markets
stay under their explicit groups in both pickers; searches include nested markets.
An explicitly selected market survives property navigation even when its group has
multiple markets. Group rows and saved group URLs retain the report's existing
filters; a navigation link alone must not change their totals.

An Advanced Property scope in AI Visibility offers a `Location details` link to
`/properties/$targetKey`. Breakdown rows still change the report scope; the link
lives only on the Property scope and is omitted in embeds and Simple projects.
Links between the report and the Property page carry the search through
`carryVisibilitySearch`, which drops one-shot triggers such as `onboarding`. The
Property page reads `queryClass` from that selection; an unset or unclassified
class resolves to the first class the Property is assigned and is written back,
matching the report's normalization. Its overview, evidence, and competitor reads
take no market, engine, model, location, date range, or saved sweep, so carried
filters are disclosed as `Filters not applied`, never applied. The market
section's overview link returns to the whole-site scope.

The Property page (`MeasurementPropertyPage`) lists the published names and qualified names (`PropertyNamesSection` in `advanced-measurement/PropertyNamesEditor.tsx`). Writers get an inline editor that saves through `upsert-target` into the measurement draft, creating the draft against the active revision when none exists, and never publishes; viewers and embeds get the read-only list. It refuses to write into a draft started from an older revision, flags names saved in the draft and not yet published, and drops an emptied qualified list instead of storing `[]`. A save compares the draft's current names with the ones the editor opened on and shows the conflict notice rather than overwrite a change made elsewhere (the draft ETag covers only the save's own read), and a save that changes nothing never creates a draft: an open draft turns every Property's next step into finishing setup. Inline warnings come from `measurementTargetNameIssues` / `measurementTargetNameIssueMessage` in contracts, the same helper the draft API returns as `upsert-target` warnings, checked against the same brand names: `effectiveBrandNames` of the project read, which the next publish freezes (the published revision's names only when that read fails). "Cited on other queries" reads `shape=other-queries` for the page's class and displayed run: answers to queries assigned to other Properties that cited this Property's pages, outside its rates, each linking the Property it was asked for and reading the answer through that Property's `measurement-question-result`.

In Advanced Query results, a Cited cell with `uncheckedSources` keeps its rate or `Not measured`, adds what the saved links cite (`UNCHECKED_SOURCES_COPY`) and swaps the missing-evidence tooltip for the plain-words "partly saved" one; Location outcomes adds the server's `summary.notMeasuredUnchecked` line. Beside per-property numbers, the older site-wide cited flag is named `<domain> cited (any page)` (`siteCitationLabel` in `lib/format-helpers.ts`): Advanced Project signals badges (only phrases whose `siteCitation` is not false: competitor and Business Profile insights borrow the states for another subject) and the Advanced Competitor history "you" row. Simple surfaces keep the bare label.

`ProjectPage` owns the shared measurement URL selection and the `/queries` route.
`QueriesSection` in `DiscoverySection.tsx` owns tracked assignments and the separate Research workspace; their components live in `src/components/project/queries/`.
Research retains ICP discovery and bounded tests. Promotion must use query-tracking preview and commit.
Advanced tracked query scope and class filters must both honor URL selection. Simple tracked rows have no assignment classes, so retain their complete list and omit the class control even when the shared report URL carries a class filter. Retired scope keys require explicit recovery before scoped edit actions are available; the body keeps that recovery while the context row names the saved scope as unavailable. The tracked body renders no scope picker. Expose assignment membership behind an accessible disclosure. Within a Group, expand Subgroups before a collapsed All properties shortcut; leaf Properties remain expanded and collapsible. Reopening restores the selected Group or an explicit parent of the selected Property. Search results remain visible across matching levels.
Research starts with direct query entry. Run once hides all pattern controls. Repeat modes offer saved patterns as an optional disclosure, not a required Template selector. Allow authorized writers to save named patterns in the browser. Repeat mode selects explicit markets, properties, or configured locations. Never expand groups implicitly. Use the shared research helper for declared variables and reject unresolved placeholders. Show every resolved query and its independent provider location before submission. Preserve editable previews and require a new review after setup changes. Submit exact reviewed queries with explicit provider, model, location, and applicable plan revision to the atomic research batch endpoint. Reuse the request key after an uncertain response. Keep direct and location-only research available without a plan or during hierarchy read failures. Save pattern provenance separately from final text. Show final-text classification and carry saved scope into tracking review. Research labels describe project brand-name/domain checks, not verified property identity. Keep saved answer engine, model, and location visible. Research and both Advanced answer views share `AnswerMarkdown` for contextual heading levels, lists, emphasis, safe external links, and no remote images. Saved answers use normal page scrolling and offer exact-text copying with inline feedback. Keep source details in a counted disclosure, preserve evidence classification, and reflow property answer rows within narrow containers. Closing scoped answers restores focus to their initiating engine button when available.
Use the server-reported research `access.canRun` and `dailyRunLimit` for both direct and repeat research. Do not infer research permission from general `canWrite`; a research-only credential can run queries without broader write authority. Limited accounts use safe provider choices from stored history, never `/settings`, pattern saves, ICP discovery, or tracked-query promotion. Signed-in viewer authority still requires the deployment opt-in on the server. Each destination run counts toward the same project daily cap across browser, API, CLI, and MCP.
After query publication, invalidate the project's query and measurement reads together. A refused preview or commit refreshes the workspace version while preserving the editable draft.
For Advanced Measurement, `VisibilityWorkspace` in `VisibilityTrendSection.tsx` consumes the server's frozen report. On clean URLs, normalize to the selected class using that exact population from the first all-class response; retain its cache timestamp and generated query-key identity so invalidation and scoped pagination still fetch correctly. Normalization writes the URL with `replace: true`, so it adds no history entry. Load Advanced Project signals and competitor history when their disclosures open, while Simple primary metrics still load on arrival.
`VisibilityOverview` renders the Advanced overview: `VisibilityResultsToolbar` above the `VisibilityWorkspace` it keys by the whole selection except the open answer. The toolbar reads `useVisibilityReportFirstPage`, which is not keyed, so it mounts with the first available report and stays mounted, with its focus and open Filters panel, while a filter change reloads the results below. It is absent before the first report, on error, and for the v1 and unmeasured fallbacks. The toolbar row holds Query type, the run state and date, the Filters button, one removable token per non-default URL filter, the Location details link, and Manage queries (never in embeds). Every control value and token reads the URL selection, never the server echo; choice lists come from the displayed report and always keep the URL value. The inline Filters panel (engine, location, model, UTC dates, Results from) starts closed, closes on Escape back to its button, and Clear filters removes only those filters, never scope, market, class or the `runId` drawer. Tokens and toolbar buttons are default-size `Button`s with `min-h-11 text-sm`, never pills. An Advanced explicit date range is a token, not context-row meta.
Keep branded, non-brand, and unknown populations separate. Format server rates without deriving them from counts. Query results show each query once, with property and location details shared only when every engine row has identical context. Keep differing contexts beside their engine. A single-answer rate of 0 or 1 may read No or Yes, unless it carries `unattributed` or `unchecked`, which keeps its count; preserve multi-answer rates/counts and explicit unavailable evidence. Every Cited rate carries `uncheckedSourcesLabel` and every Mentioned rate `unattributedAnswersLabel`, through `excludedAnswersLabel` in `src/lib/format-helpers.ts`, never under the other signal, and always behind a caution `InfoTooltip` beside the rate's own count, never as a visible line (the screen-reader-only trend table keeps it as text); the Advanced trend puts `REPORT_TREND_UNCHECKED_NOTE` behind the same icon after the Cited legend entry when a plotted Cited point left answers out, and the chart still reads it in its description. Engine rows reflow on narrow screens while retaining their mention/citation labels and answer action.
Default the shared URL selection to all queries for Simple and Advanced, preserving explicit query-type links.
Simple history without query labels must show its saved unclassified results on arrival. In the all-query view, omit Simple classes with no current or historical queries when another class has results; keep Advanced unmeasured classes explicit.
Each population opens with its headline strip: the class heading, a caption, and `dl.report-headline` — separate `.report-headline-tile` surfaces with a gap, never a shared border or dividers — for mention coverage, citation coverage, and Locations mentioned (omitted for a Property scope). One column on phones, then the `data-columns` count. Every tile label carries an `InfoTooltip` from `REPORT_HEADLINE_HELP` in Simple, Advanced aggregate and Property scopes alike. A tile prints the server rate with its metric's change inline beside it in `REPORT_CHANGE_COPY` words (`Up 4.2 pts` positive, `Down 4.2 pts` negative, `No change` and a metric's `No earlier value` secondary; an unavailable or inapplicable current value prints nothing), then one supporting line of `numerator of denominator answers|locations`, with a caution icon beside it holding `unattributedAnswersLabel` when the server's mention rate carries `unattributed`, or `uncheckedSourcesLabel` when its citation rate carries `unchecked`; `formatPointDelta` only formats the server delta, and a null rate prints its reason with no change. The class is visible only in the `h2`; each tile repeats it as `sr-only` text beside its value, so every figure still names its own instrument. The caption is the one place the comparison is named: `12 queries · 36 answers · vs Sep 8 sweep`, where the previous sweep is an observed instant that keeps its year unless it falls in the displayed sweep's year, the one population-level `REPORT_CHANGE_COPY` reason replaces the `vs` part, and `no-selected-run` or an absent `comparison` leaves the comparison unnamed; its explanation `InfoTooltip` stays beside it. The trend legend is a checkbox fieldset whose last visible series cannot be hidden; Cited draws dashed with hollow dots. Order: strip, trend, the breakdown (titled `By place`, with Groups and Locations as pressed-state buttons; 4px bars at the server rate, none for a null rate), Location outcomes, Query results, Competitors.
Those collapsed rows are one list, not five components. `Location outcomes`, `Query results` and `Competitors` here, plus `Project signals` and `Competitor history` in `ProjectPage.tsx`, all use `.visibility-disclosure` / `-summary` / `-label` / `-meta` from `styles.css`, so one label weight, one row rhythm, one divider and one focus ring cover the whole stack; they came from two components and read as two designs (64px bold rows against 44px quiet ones, a section gap in the middle, a focus ring on only three). Keep the utilities in the stylesheet rather than at the call sites: `design-tokens.test.ts` compiles the rule, which is the only place drift is visible. The Simple overview is the exception: it shows the same `CompetitorLandscape` as the "Competitors over time" card among its page sections, loaded on arrival. `Project signals` and Advanced `Competitor history` carry no count: their data loads when the row opens, so any number before that would be invented.

The Advanced `Location outcomes` disclosure matches its Query results and Competitors siblings: a bold label and, beside it, the server's own `summary.outcomes.total` as `12 locations` (`1 location` singular). Never sum the buckets to get it; the response schema already requires the partition to sum to `total`, so a drift must stay visible rather than be papered over by a UI count. The buckets keep their labels and order (mentioned and cited, mentioned only, cited only, neither signal, not measured). `REPORT_OUTCOMES_HELP` explains all of it, and its `InfoTooltip` sits in the opened panel beside the bucket list, never inside the `<summary>` — a button there would toggle the disclosure on click and join the summary's accessible name. Its copy states what the server computes in `outcomeCounts` / `targetPresence` and nothing beyond it: the buckets count properties rather than answers, `citedOnly` is the engine using the page as a source without naming it in the answer, `notMeasured` covers both an unmeasured property and a half-measured one (calling that "mentioned but not cited" would assert an absence nothing measured), and one verified signal survives a later uncertain answer. The partition reads a property's own two signals and no competitor's, so neither this copy nor the same sentence on `measurementOutcomeCountsSchema` may say a rival was recommended instead — `citedOnly` never measured one. Give the five buckets five distinct counts in any test fixture, or a rotated tuple list renders one bucket's count under another label and still passes.
Never draw an empty trend chart when every server rate is unavailable. Chart tooltip labels show the observation date without the time. When a chart has rates, retain its history table for screen readers without a duplicate visible disclosure; comparison warnings stay beside the chart. If no rates can be plotted, show the history table for recorded sweeps, including dates and comparison markers for partial measurements.
The scope picker starts with top-level Groups. Browse uses explicit frozen parent-group relationships and property memberships; keep query-context Markets separate, each tagged Market. Search can find nested Groups and Properties. Never infer hierarchy from labels or property counts. Report recovery reads the typed `error.details` through `apiErrorDetails` and `parseVisibilityReportScopeErrorDetails`, never the message text: a retired market reads Market unavailable, offers Show all markets and clears only `measurementMarketKey`, a retired scope reads Place unavailable and offers Show all (named "Show all of {project}" for assistive tech), and any other failure offers Retry. Each of the two labels follows a caution icon and carries its sentence in an `InfoTooltip` (`VISIBILITY_SCOPE_RECOVERY_COPY`), never as a visible line. The engine's location always reads "Search location" ("No search location", "All search locations"), because a query's own locations are listed beside it.
Scope changes must preserve unrelated URL state. `measurementRunId` must never write the global `runId` drawer parameter.
Keep `Run AI sweep` project-wide and admin-gated. Do not offer scoped sweeps or expose query administration in embeds.
Managed deployments also suppress the sweep confirmation and guard its submit handler. The separate competitor-history disclosure retains pinning, follows the shared project/group and query-class selection, and uses its own explicit history window; it stays absent for unsupported Property, Market, and unclassified scopes.

### Invalidation strategy

Pick by intent (documented at every call site in `mutations.ts` /
`run-invalidations.ts`):

- **Exact key** — `getApiV1<op>QueryKey({client: heyClient})`. Use for the
  literal top-level lists (`/projects`, `/runs`). Doesn't touch any
  per-project sub-endpoint.
- **Predicate by op-id prefix** — `query.queryKey[0]._id.startsWith('getApiV1ProjectsByNameBing')`.
  Use for whole-domain invalidations after integration mutations (Bing
  disconnect, GSC sync, GA sync, traffic source connect).

**Don't use `'getApiV1Projects'` as a prefix** — it greedily matches every
per-project sub-endpoint (Bing, GSC, GA, etc.) and churns unrelated caches.
For "the projects list" use the exact-key form.

### Spec gaps (loose-object endpoints)

A handful of endpoints (~41) still return `looseObjectSchema` in the spec —
the SDK types them as `Record<string, unknown>`. Two options when you hit
one:

1. **Add the schema (preferred):** define a Zod schema in
   `packages/contracts`, register it in `packages/api-routes/src/openapi-schemas.ts`,
   flip the route to `jsonResponse('...', 'YourDto')`, run `pnpm gen`. The
   `packages/api-routes/test/no-new-loose-routes.test.ts` count cap will go
   DOWN by one.
2. **Cast at the consumer (only if the schema work is genuinely deferred):**
   call the generated SDK helper and cast the response to the hand-typed
   `Api*` shape:
   ```typescript
   const data = (await queryClient.fetchQuery({
     ...getApiV1ProjectsByNameMyLooseEndpointOptions({ client: heyClient, path: { name } }),
   })) as unknown as ApiMyLooseShape
   ```
   Leave a TODO referencing the schema work.

**Do not add new `looseObjectSchema` routes.** The lock test
(`no-new-loose-routes.test.ts`) caps the current count; new endpoints must
ship with a registered Zod schema.

Base path comes from `window.__CANONRY_CONFIG__.basePath`. Never hardcode `/api/v1`.

### Managed run kinds

`ProjectPage` reads run admission with `selection=manual` for its sweep button
and skipped-provider confirmation, and `selection=scheduled` for the schedule
notice. When those admissions differ, notices name their scope. Held admissions
refresh at the earliest provider retry deadline and stop polling once clear;
deadline refreshes never invalidate saved sweep results.
Provider-settings recovery requires both write access and instance administrator
authority; project-scoped writers receive the administrator recovery instruction.

`isDashboardManagedRunKind(kind)` reads the optional deployment list, with
`managedSweeps: true` as the legacy answer-visibility-only fallback.
`isDashboardManagedSweeps()` delegates to it. When true,
replace answer-visibility launch controls and empty-state launch instructions
for every dashboard role, including admins. `ManagedSweepStatus` reads
`GET /projects/:name/schedule?kind=answer-visibility`; only an enabled schedule
with a valid `nextRunAt` gets a calendar date in the schedule timezone. The
answer-visibility header shows `Next sweep: Sep 23` or a concise running or
unavailable state, without a tooltip, time, or team-ownership copy. Omit the
Advanced default `Recent measurements` label; preserve explicit historical
ranges. The component accepts a schedule kind.
Managed `site-audit` hides viewer scan controls and next-scan settings; admins
retain them. Gate `startScan` and `startAudit` themselves, including recovery
callbacks, and keep all progress, score, map, page, failure, partial and dead-link
evidence visible. Site Health reads the site-audit schedule and falls back to
“Scans are run by your Canonry team” without a date. The admin-only creation
scan in `OnboardingSetupPage` is outside this client policy. Other kinds keep
their existing controls. The operator's manual lever is `canonry run <project>`, and the flag
must never enter authorization checks. Unset/false preserves existing markup.
Keep queued/running signals, baseline results, and failure details visible.
Settings keeps schedule reads but hides create/edit/pause/resume/delete controls.
Aero blocks typed `/run-sweep` at submission and uses `read-only` scope in
managed mode, regardless of a saved write preference; hide its scope toggle.
Test Simple and Advanced behavior through `ProjectPage`: it does not supply
`AdvancedMeasurementOverview.onRunMeasurement`.

### Read-only embed mode (#716)

When the server injects `window.__CANONRY_CONFIG__.embed` (via `canonry serve --embed`), `RootLayout` (`src/App.tsx`) takes a chromeless branch — placed AFTER every hook so Rules of Hooks hold on both paths — rendering only `<Outlet/>` inside a minimal `app-shell-embed` shell with NO sidebar / topbar / mobile nav / footer / drawers / `RunNotificationObserver` / `Toaster` / `AeroBarHost`. The optional `embed.views` allowlist gates the route via `embedViewIdForPath` (a non-allowlisted route renders a `embed-view-unavailable` state instead of the page, so surfaces like `/settings` are not reachable inside the iframe — a presentational gate, NOT a security boundary; the API key scope is the real boundary). The optional `embed.projectTabs` allowlist is a FINER gate. Every project surface reads it through `effectiveEmbedProjectTabs(getEmbedConfig())`, never raw: outside embed that is `undefined` (all tabs); inside embed `filterEmbedProjectTabs` normalizes it against `EMBED_PROJECT_TABS` (`overview`, `search-console`, `local`, `activity`, `backlinks`, `technical-aeo`, `history`, `settings`). That is only the client's render list: the server enforces its own narrower read allowlist (`SERVER_ENFORCED_EMBED_PROJECT_TABS` in `packages/canonry/src/embed.ts`: `overview`, `technical-aeo`), so the other tabs can render while their API reads are refused. `portfolio`, `queries`, `discovery`, and `conversions` are always dropped, even when the host names them. An embed with no list gets every tab in `EMBED_PROJECT_TABS`, and a list with no valid tab falls back to `overview`; the server's boot-wide config already defaults an unset list to `overview` (`packages/canonry/src/embed.ts`). `ProjectPage` filters the subnav to that list, and `resolveEmbedProjectTab` falls a direct-URL hit on a hidden tab back to Overview (or the first allowed tab). A child route with no subnav entry gates on the tab it belongs to, through the same list: the Property detail route (`/projects/$projectName/properties/$targetKey`, `MeasurementPropertyPage`) is governed by `portfolio`, so in every embed it renders "This view is not available here." with a link back to the project overview, and fires no measurement reads. That matches `ProjectPage`, which skips the plan read and renders no Property links when embedded. Site Health retains the stable `technical-aeo` allowlist token. This is what `embed.views` cannot do — every `/projects/*` collapses to the one `project` view id. Same posture as `views`: presentational, NOT a security boundary; the API key scope governs data. The optional `embed.theme` supports `mode`, `bg`, `fg`, and `accent` through `embedThemeStyle` (sanitized, via the React `style` prop). Font overrides are unsupported. Every dashboard uses the bundled Geist files. With embed off, `getEmbedConfig()` returns `null` and the full chrome renders exactly as before.

### DTO types — generated vs hand-typed

`src/api.ts` re-exports the generated `RunDto`, `QueryDto`, `CompetitorDto`
as `ApiRun`, `ApiQuery`, `ApiCompetitor`. Use the `Api*` names — they're
the same shape but the alias makes it clear the source is the spec.

A few `Api*` interfaces remain hand-defined (`ApiProject`, `ApiSnapshot`,
`ApiRunDetail`, etc.) because the generated shape would cascade
`displayName: string | undefined` / `createdAt: string | undefined` drift
through every consumer that assumes those fields are always present.
Migrating each requires consumer-side review; track as separate follow-up
PRs rather than rolling into tooling work.

### Charting and graph rendering

**Recharts only, via ChartPrimitives.tsx, for analytic charts.** Never import
`recharts` directly. ESLint enforces this.

```typescript
import { CHART_TOOLTIP_STYLE, CHART_AXIS_TICK, CHART_SERIES_COLORS } from '../shared/ChartPrimitives'
```

- Never add Chart.js, Highcharts, D3, Plotly, Nivo, or Victory. If Recharts is
  missing a feature, extend `ChartPrimitives.tsx` rather than adding a second
  library.
- Use `CHART_TOOLTIP_STYLE`, `CHART_AXIS_TICK`, `CHART_GRID_STROKE`,
  `CHART_AXIS_STROKE`, and `CHART_SERIES_COLORS` for consistent styling.
- Chart CSS variables (`--chart-series-*`, `--chart-tone-*`, `--chart-neutral-*`, `--chart-tooltip-*`, `--chart-grid`, `--chart-axis`) are registered in `styles.css` and consumed by `ChartPrimitives.tsx`: every Recharts color constant is `var(--chart-*, <hex fallback>)`, so the default dark render is unchanged and a theme can override the ramp at runtime. `test/chart-primitives.test.ts` locks each JS fallback to its CSS default (no two-source drift). Gauges/sparklines share the same `--chart-tone-*` / `--chart-neutral-grid-line` tokens so they can't drift from the charts. `PROVIDER_SERIES_COLORS` stays literal — it encodes engine identity, not tone. Never do string math (slice/alpha-concat) on these constants; a `var()` string would break.
- **Pick the date formatter by what the value MEANS, not by where it renders.** `formatChartDateLabel` (tooltips) and `formatChartDateTick` (axis ticks) are CALENDAR-DATE formatters: they read the `YYYY-MM-DD` prefix and apply no timezone conversion, so a day-stamped value can never shift. A real moment (a sweep timestamp) is an `ObservedInstant` — build it with `observedInstant(iso)` and render it through `formatObservedInstantLabel` / `formatObservedInstantTick`, which localize to the viewer. The branded type is what keeps the two apart; they are indistinguishable at runtime.
- **Never render a synthetic grouping key as a date.** An analytics bucket's `startDate` / `endDate` are boundaries anchored to the window's earliest run — nothing happened at them, and they sit days away from the sweeps inside. Label buckets with `formatBucketDateLabel` / `formatBucketDateTick` (`lib/visibility-trend-helpers.ts`), which read the bucket's real `dataStartDate` / `dataEndDate` / `sweepCount`. The boundary stays the x-axis key only.
- Custom SVG is allowed only for non-chart visualizations (gauges, sparklines,
  timelines) where Recharts is overkill.

**Narrow Site Health exception:** the `/technical-aeo` route is labeled **Site
Health** and renders its site map with stable `sigma@3` through
`@react-sigma/core@5` and `graphology`. This is a WebGL graph renderer, not a
second charting system. Keep all Sigma/Graphology imports inside
`SiteGraphSigma.tsx` and `site-graph-sigma.ts`; every other visual stays on the
Recharts path above.

The browser must never run graph layout physics. It receives the immutable
coordinates published with the crawl snapshot (Graphology ForceAtlas2 runs in a
bounded Node worker during publication). The renderer may pan, zoom, focus,
dim, filter, and derive accessible controls from those positions, but must not
mutate or recompute them. A missing/failed/legacy layout is an explicit
unavailable state, not a client-side fallback layout.

### Design tokens

`src/styles.css` keeps font tokens in the existing `@theme inline` block, but
color and chart tokens live in a separate static, non-inline `@theme` block so
the full foundation is emitted while generated Tailwind utilities compile to
`var(--color-*)` and can be overridden at runtime.
New themeable UI code should use semantic utilities instead of literal palette
classes: `bg-bg`, `bg-surface`, `bg-surface-subtle`,
`bg-surface-hover`, `bg-surface-inset`, `bg-surface-inset-hover`,
`bg-surface-active`, `border-default`,
`border-subtle`, `border-base`, `border-strong`, `text-primary`,
`text-heading`, `text-strong`, `text-secondary`, `text-muted`,
`text-faint`, `text-link`, `text-on-inverse`, `text-on-emphasis`, plus tone
utilities such as `text-positive`, `border-positive`, `bg-positive-soft`, and
`fill-positive` (and the caution/negative/neutral variants).

Current dark defaults: `bg-bg` = `zinc-950`; `bg-surface` = `zinc-900/30`;
`bg-surface-subtle` = `zinc-900/20`; `bg-surface-hover` = `zinc-900/40`;
`bg-surface-inset` = `zinc-800/60`; `bg-surface-inset-hover` = `zinc-800/40`;
`bg-surface-active` = `zinc-800/50`; `border-default` = `zinc-800/60`;
`border-subtle` = `zinc-800/40`; `border-base` = `zinc-800`; `border-strong` =
`zinc-700`; `text-primary` = `zinc-50`; `text-heading` = `zinc-100`;
`text-strong` = `zinc-200`; `text-secondary` = `zinc-400`; `text-muted` =
`zinc-500`; `text-faint` = `zinc-600`; `text-link` = `blue-400`;
`text-on-inverse` = black; `text-on-emphasis` = white (exact legacy button
on-colors). Use `text-heading` / `text-strong` for heading and emphasized
neutral text, `text-primary` for highest-contrast body text, `text-secondary`
for supporting text, and `text-muted` / `text-faint` for labels.

Tone tokens: **positive** = emerald, **caution** = amber, **negative** = rose,
**neutral** = zinc. **info** = sky is a minor accent (opportunity "track" cards,
the suggested-query add action) exposed only as the `info-*` scale below, not a
full tone quartet.

Font: **Geist Sans** (400–800 weights) for UI text, **Geist Mono** for
code/numerics. Globally enabled OpenType features `cv11`, `ss01`, `ss03` give
sharper i/l/I/0 disambiguation. Headings tighten tracking (`-0.015em`,
`-0.02em` on h1).

For off-ladder shades that no role token names, use the raw scales rather than a
literal: neutral `mono-100/200/400/500/600/700/800/900/950` (= the matching
`zinc-*`; one-off dots, focus rings, tracks, dividers, underlines, and exact
primitive states) and the tone scales `positive-*` / `caution-*` / `negative-*`
(= `emerald-*` / `amber-*` / `rose-*`; insight cards, toasts, chips, gauges, and
sparklines), plus the small `info-*` sky scale
(`100/200/300/400/500/800/950`) for info accents. Apply alpha with a Tailwind
opacity modifier on the scale token (`bg-mono-800/30`, `bg-caution-950/25`) —
this is exactly how `styles.css`'s one-off shades migrated with no visual
change. Effect colors live
as `--color-scrollbar-thumb`, `--color-shadow-drop`, `--color-shadow-panel`,
`--color-shadow-hairline`, `--color-shadow-tooltip`, `--color-overlay-hover`,
`--color-overlay-scrim`, and `--color-caution-glow` / `-glow-inset`.

`styles.css` and the entire `apps/web/src` `.tsx` component tree are fully
tokenized (zero literal palette utilities / raw hex outside the `@theme` block) —
the Phase 3 migration is COMPLETE and enforced whole-tree by the ratchet below.
Do not add new literal palette utilities for themeable UI. The fixed provider
identity palettes in `ProviderBadge` (and `ChartPrimitives`' `var(--chart-*, #hex)`
fallbacks) remain literal because they encode engine identity, not semantic tone.

Two migration conventions (decided against the actual codebase, keep slices
consistent):

- **Off-ladder `zinc-900` alpha shades use `bg-bg-elevated/NN`**, not
  `bg-surface-hover` (they compute to the same color: `bg-elevated` is solid
  `zinc-900`, so the opacity modifier reproduces the literal exactly). The named
  `surface-*` role tokens (`bg-surface` = `/30`, `-subtle` = `/20`,
  `-hover` = `/40`) are reserved for the shades they name; the codebase uses
  `bg-bg-elevated/NN` everywhere else (`/40`, `/50`, `/60`, `/70`, `/80`).
- **Placeholder color uses the `placeholder-mono-NNN` shorthand**
  (e.g. `placeholder-mono-600`), not the `placeholder:text-*` variant form.

**Design-token ratchet (Phase 3, COMPLETE + enforced).** The
`design-tokens/no-literal-palette` ESLint rule (`eslint.config.js`) errors on any
raw Tailwind palette utility across the whole `apps/web/src` tree; only
`ProviderBadge` + `ChartPrimitives` are permanently excluded (engine identity /
chart hex fallbacks). The migration allowlist has been emptied and removed, so any
new literal palette utility now fails lint. `pnpm --filter @ainyc/canonry-web scan:colors`
reports per-file counts (now 0 — a progress view; the lint rule is the gate). New
themeable UI must use a semantic or scale token; if you ever introduce a run of
literals, migrate them in the same PR (class-only, no redesign) and keep these
checks green: `design-tokens.test.ts` + a `dashboard-class-baseline.test.tsx`
update if the baselined class lists move + typecheck + lint + build.

Token migration guardrails:

- `test/design-tokens.test.ts` compiles the stylesheet with Tailwind and proves
  semantic utilities reference CSS variables, including opacity modifiers like
  `bg-surface/50`, and that chart-only tokens are emitted before the chart
  bridge consumes them. It guards against accidentally putting color tokens in
  `@theme inline`.
- `test/dashboard-class-baseline.test.tsx` SSR-renders representative routes and
  snapshots stable class lists for later migration PRs; use it as a fast
  migration tripwire before browser visual checks. jsdom cannot compute
  Tailwind v4 `@layer` / `@property` / `color-mix` output reliably, so the
  computed-style spot check is the Tailwind compiler-output assertion.

### Layout and navigation

- **Sidebar navigation** (persistent left, `w-56`, hidden on mobile with full-screen overlay fallback).
- **Compact topbar** with breadcrumb, health pills, and primary action button.
- **Page container** (`max-w-6xl`, centered) for all page content.
- Pages use a `page-header` (title + subtitle + optional actions) followed by sections separated by `page-section-divider`. Project pages instead use the project context row: identity lives in the topbar breadcrumb (plus one visually hidden `h1`, visible below md), and the sweep action lives in the row's `[data-project-actions]`. Embeds keep `page-header`.
- Sidebar main nav items use Lucide icons (`LayoutDashboard`, `Globe`, `Play`, `Settings`).
- The sidebar Projects section shows each project with a colored dot indicating visibility health tone.
- The sidebar Resources section sits at the bottom, with the `Rocket` icon for Setup. Doc links sit in the sidebar footer.

### Accessibility

- Skip-to-content link.
- `aria-current="page"` on active nav items.
- `aria-label` on nav landmarks.
- Focus-visible rings on interactive elements.
- Screen-reader-only labels (`.sr-only`) where needed.

### Component organization

- Don't create new component files unless the component is reused across 3+ pages.
- Section components live in `src/components/project/` for the project page.
- Shared components live in `src/components/shared/`.

### Data display

- Prioritize information density. Analysts want to scan, not scroll through cards.
- Use **data tables** for lists of 3+ structured items (evidence, findings, competitors).
- Use **cards** only for insights/interpretations where narrative matters.
- Use **ToneBadge** for all status indicators. Map tones through helper functions (`toneFromRunStatus`, `toneFromCitationState`, etc.).
- Do not use radial/progress gauges for unbounded counts. They require a real
  bounded scale. Use linear progress only for a real bounded target; raw hits,
  sessions, totals, and other unbounded counts use flat KPI rows.
- Pills are status/tag indicators only. Use tabs, selects, segmented controls,
  checkboxes, or shared rectangular buttons for interactive choices. Topbar
  health pills use `rounded-full` with tone-colored borders.
- **AI Visibility cards:** the Simple overview is a stack of `.overview-brief` cards, each a short `av-card-title`, a compact `av-grid` of counts (`av-n-sm`) with at most one status word per row, and everything else in the shared closed `Disclosure` ("Details"). No hero, progress bars or metric tiles; a count reads "4 of 11" with its base. The one exception is the competitive card ("Where competitors are winning"), which keeps its original `.aeo-hero` / `.competitive-summary` layout: the `MentionShare` brand table with share bars, then the "Mention gaps" and "Citation gaps" rows with their linear bars. Keep a single `.metric-grid` / `.metric-card` definition for the pages that still use metric cards; a duplicate once overrode the column count.
- **Insight cards** use a left-border accent color based on tone (`insight-card-positive`, `insight-card-caution`, `insight-card-negative`).
- **Sparklines** show inline trends in overview project rows.
- Keep 10-11px eyebrow labels only for nonessential section context. Meaningful supporting copy is at least 13px and uses `text-secondary` or stronger.

### Text and tooltips

- **Heavy text belongs in tooltips, not inline.** A data surface shows values, one-line captions, and eyebrow labels — not prose. Multi-sentence explanations (methodology, "what this means", the evidence behind a finding) push the numbers down and break the analyst's scan, so they move into an `InfoTooltip` (`components/shared/InfoTooltip.tsx`) on the relevant heading, label, or row title. The trigger is a real keyboard-reachable button and the copy rides its `aria-label`, so nothing is lost for assistive tech or for tests (`getByRole('button', { name })`).
- **What may stay inline:** the metric value itself, a single-line caption/subtitle, eyebrow section labels, and **empty / onboarding states** (which must instruct — a "connect this integration" empty state is the only content, not heavy text).
- **The test:** if a sentence explains or justifies rather than labels or names, it goes in a tooltip. The section heading gets the info icon; the descriptive paragraph under it should not exist.
- **A note that qualifies a figure goes behind `<InfoTooltip variant="caution">` beside that figure**, not on a line of its own: the answers a rate left out, or tracking changed since the displayed sweep. It is the same button with a triangle in the caution tone and a 24px tap target, and it opens below so the bubble stays inside a phone viewport. The note is still a count: never drop it, and keep its exact shared label as the tooltip and accessible name. In a table cell the count and its icon share a `whitespace-nowrap` line, so a narrow column never drops the icon under the count. The tracking-changed strip is one `role="status"` that shows only `VISIBILITY_TOOLBAR_COPY.trackingChangedLabel` and holds the icon named by `trackingChangedDetail`; a status is not a heading, so the icon is its child on purpose and assistive tech reads the sentence once. Never repeat the detail as `sr-only` text.

### Competitor landscapes

- `CompetitorLandscape` reads the windowed stored-evidence endpoint. Never send
  a historical row into the latest-only `EvidenceTable`; use its returned
  `sampleUrls` when showing source evidence.
- It is the "Competitors over time" card: you and the competitors behind
  mention share (the pins, or with no pins the observed competitors the server
  admitted), by domain, with Mention share, Named and Cited. Details holds the
  base, the brand counts, which competitors count, data-quality notes, other
  competitors (with type and Pin), the company names and other cited sites.
  Never claim no competitors while names were observed.
- Advanced Measurement reads must pass the selected `groupKey`, or explicit
  `scope=all-markets`.
- Stored landscape GETs are embed-safe. Every competitor mutation requires
  `canWrite && !isEmbed()`; market pins create/update a draft and never publish.
- History fallback pins show unavailable metrics, never latest-only counts under
  a historical window.

### Retired Report tab

The dedicated Report UI is removed. Legacy `/projects/:name/report` URLs
redirect to AI Visibility without reading the downloadable-report endpoint.
AI Visibility and published Advanced Measurement retain their measurement
workspaces and metrics. The dedicated Report API, CLI and MCP surfaces are
also retired; replacement reads are documented in `docs/report-retirement.md`.

### UI tests

Use semantic selectors and exported UI copy constants for text assertions.
Keep fixture dates and behavior checks independent of display wording.

## Common Mistakes

- **Importing `recharts` directly** — use `ChartPrimitives.tsx` exports.
- **Adding alternative charting libraries** (Chart.js, D3, Highcharts) — Recharts is the only chart library; the isolated Site Health Sigma/Graphology exception above is not a precedent for other views.
- **Hardcoding `/api/v1`** — use the base path from `window.__CANONRY_CONFIG__`.
- **Using card grids for tabular data** — analysts prefer tables for scanability.
- **Adding decorative gradients or glow effects** — the design system is clean and flat.
- **Hero grids with large descriptive text blocks on the project page** — keep headers compact.
- **Multi-sentence explanatory prose inline in a data view** — move it to an `InfoTooltip` on the heading or row title (empty / onboarding states are the exception).
- **Putting `sr-only` on a `<table>`** — a table box never shrinks below its content, so the 1px `sr-only` width does not apply, and its `nowrap` rows push the page sideways (the Simple trend data table made the overview 1,812px wide at 375px). Hide it through a wrapper: `<div className="sr-only"><table>…</table></div>`. A `table` / `inline-table` display class does the same. `test/sr-only-table.test.tsx` parses every `.tsx` file in `src` and `styles.css` and fails on either form.

## See Also

- Root `PRODUCT.md` / `DESIGN.md` — product and design contract (hierarchy, copy, typography, controls)
- `packages/contracts/` — DTOs returned by the API
- `packages/api-routes/` — backend endpoints the UI calls


### Aero view context

`AeroViewProvider` carries effective Property/Site Health selection to the native
bar. URL-backed report filters use `aero-view.ts`; publish component-owned run/page
selection with `usePublishAeroView`. Never send a carried filter a page does not
apply. Context is frozen per prompt and included in Copy as CLI. The server
validates it; it cannot grant tool access. Join tool events by call ID, retain
intermediate messages, and avoid transcript polling over an active turn. Stop
preserves partial output; interrupted write-capable turns require prompt review.

Aero's New conversation action preserves the current transcript; History lists
and reopens saved conversations. Delete is a separate confirmed action. These
controls use generated SDK operations and are disabled during context changes
or active turns. A prompt carries the displayed conversation ID, so a stale tab
cannot silently send into a different conversation.

## Usage telemetry (`ui.*` events)

`src/lib/ui-telemetry.ts` records page views, feature actions, UI errors and web vitals; `src/lib/ui-telemetry-install.ts` wires it once from `main.tsx` (tests never import it, so they stay silent). Rules:

- **A new feature adds a `ui.action`.** Add the action to `UI_ACTIONS` in `packages/contracts/src/ui-telemetry.ts`. If the feature is a dashboard API write, add its method and route template to `ACTION_BY_ROUTE`; otherwise call `trackUiAction` at the one place the action completes. Never send a free-form name.
- **A new route adds its pattern** to `UI_PAGES` (and a project section to `UI_PROJECT_TABS`); unknown routes report as `other`.
- **Never put free text in an event**: no URLs, project names, query text, error messages or stacks. Pages are route patterns, API failures are route templates, errors are class names. The contract rejects anything else.
- A new error boundary passes a `name` slug so `ui.error` says which boundary caught it.
- **A read or write whose failure status is a normal outcome** (the code handles it as "none yet" or a conflict) adds its method, template and statuses to `EXPECTED_STATUSES`, so it is not reported as a UI error.
- **A new shared filter** either writes a URL search param listed in `FILTER_BY_SEARCH_KEY` (picked up at the router) or calls `trackUiFilterChange(dimension)` when its value changes; a new table search uses `DataTableSearch`, which already reports `search.submit`. Never pass the value or the text.
- **An OAuth start is `integration.connect_started`**; record `integration.connect` only where the connection is confirmed.
