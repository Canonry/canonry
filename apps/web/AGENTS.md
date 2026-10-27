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
| `src/components/project/SiteHealthSection.tsx` | Site Health scan controls and results. Agent integration checks default on and can be disabled for a scan; geographic checks default off. `site-health-check-help.ts` owns the plain-language info-icon copy shared by settings, factor rows, and per-page findings. Help buttons stay outside row/disclosure triggers. Ordinary default selection uses the API scan history's `preferredRunId`, labelled "Latest scan" with the selection rule in an adjacent info icon; explicit historical and onboarding active-run selections remain pinned, and a scan started from the header is shown once it finishes (completed or partial) until the operator picks another. Technical factor badges use the API's worst-page `status`, separately from the displayed mean score. The page-budget picker's first choice sends no `maxPages`, so the server applies the project's saved `siteAuditMaxPages`, else the full site; never fill in a number client-side, which would bypass the saved budget. When the project saved a smaller budget, a one-off "Full site" choice sends the 50,000 hard limit explicitly (`oneOffFullSiteChoice`). Project Settings edits the saved budget in `SiteHealthScanSettingsSection` (`ProjectEngineSettingsSection.tsx`): admins only when `isDashboardManagedRunKind('site-audit')`, read-only in embeds and the public demo. `updateProject` sends `siteAuditMaxPages` only when the caller sets it, so every other save keeps the stored value. Budget wording comes from `formatSiteAuditPageBudget` / `formatPageCount` in contracts, shared with the CLI. |
| `src/components/project/RunAdmissionNotice.tsx` | The AI Visibility notice for a sweep that is refused, or leaves out providers that keep failing on their accounts, from `GET /projects/:name/run-admission` (`useRunAdmission`, read once by `ProjectPage` above both overviews and their loading state). While refused, the header sweep button reads "AI sweeps on hold" and is disabled, because the API would refuse it; the confirm sheet names the providers a sweep leaves out. Copy states when the hold lifts, never that a sweep will run (a project may have no schedule). The settings action appears only for a rejected key and deep-links to `/settings#provider-<name>`; credit is added in the provider's console. Saving a provider invalidates every project's admission (`invalidateProjectQueryDomain(…, 'runAdmission')`). |
| `src/queries/` | TanStack Query hooks for data fetching |
| `src/view-models.ts` | Data transformation from API DTOs to display format |

## Patterns

### SEO

`components/project/SeoDataSection.tsx` owns `/projects/:name/seo-data`, labelled SEO.
The public demo uses seeded stored evidence and hides execution-configuration
notices; refresh and profile writes remain unavailable.
Saved profiles define Simple or Advanced scope; `seoProfileId` selects a profile,
and `seoRunId` links Activity to a specific refresh. The project context row has
no separate SEO scope picker. Reads use the generated SDK and pin evidence tables
to `overview.evidenceRunId`; the newest job's status can change while the prior
completed or partial snapshot stays visible. Freshness uses that selected
`evidenceRun`, never the project-wide last-completed timestamp. Overview Activity,
Past checks, and run history use `RunDetailLink` to open SEO refreshes through
`seoRunId`, preserving Advanced context and clearing stale profile/drawer IDs.
Summary values come from the API,
including top-ten counts. Evidence pages use the server's total and pagination.
Profile setup stores source, targets, explicit keywords, locale, capabilities,
and plan revision; its dataset choices intersect source and scope capabilities
when the API supplies them. Credentials and internal request accounting remain host-only;
customer pages may show research metrics such as CPC and estimated traffic value.
Profile creation requires a configured source with a usable dataset. Unconfigured
hosts retain saved evidence and show administrator guidance; unavailable Advanced
scopes show the API's plan recovery instruction. Keyword-only setup
omits target and ranked-row controls. Editor dismissal restores its opener's
focus; saving focuses the profile selector. Failed refresh links retain profile
navigation and require an explicit return to latest data.
Access uses the context's `canRun` and `canWrite` independently, with embed/demo
write gates. Refresh first obtains a bounded intent and reuses the same intent
and idempotency key after an ambiguous transport failure. Definitive validation
refusals release that pending request so the next explicit action can obtain a
fresh intent. Only active jobs poll; terminal transitions refresh the SEO query
domain. `seo-data-section.test.tsx` owns mounted SDK selection and lifecycle
coverage; API tests own authorization, storage, provider dispatch, and arithmetic.

Organic competitors and Search gaps are opt-in whole-domain datasets at project
scope, including Advanced projects. The editor uses the API's scope capabilities;
it never widens a Property or market selection. Search gaps require up to five
explicit comparison domains. The saved-run gap filter resets pagination and stays
available on empty results; Shared includes searches where the competitor ranks
higher. Missing describes the source database, not a live Google absence. Rival
positions and signed gaps render server values. Activity identifies each comparison
domain and its shared or missing population so partial failures remain actionable.
All visible discovery and gap columns sort through the API before pagination,
with missing values last in either direction. Headers toggle ascending/descending,
show `aria-sort`, and reset to page 1 while retaining the selected refresh and
gap filter. The prior rows stay mounted during sorting so keyboard focus survives.

The status line reads `Updated <date>` from the evidence run, `Next refresh <date>`
from the project's `seo-sync` schedule (none when it is missing or paused), and at
most one caution caveat (`refreshCaveat`): the newest refresh ending without data,
else the shown refresh's failed searches ("2 searches failed"), else a partial
refresh, each with its sentence in the tooltip. It hides while a refresh runs.
Market rankings (`MarketRankingsView`) are an outcome view, every figure the API's:
`GET market-rankings/summary` gives the Google rank counts (bands and labels from
`marketRankingBands(depth, totals)`, so a 10- or 20-result depth drops the bands it
cannot fill) and the regions or markets under the scope. Their table shows five
at a time in the API's needs-work order; its headers re-sort that complete list in
the browser, and a row opens its region or market through `seoRegion` /
`seoMarket` (both kept when a region's market opens; the trail leads back to All
markets; a lone market gets no table). The queries read `GET market-rankings` ten
at a time with the scope, `outcome` (Needs work by default, All when nothing needs
work), `q` from Find a query (settled after typing pauses, cleared at once) and
`sort` (`rank` by default; the Query and Google rank headers toggle). Show, order
and search live in the URL (`seoShow`, `seoSort`, `seoQ`, written with `replace`,
one update per change: two in a row would build the second from the stale URL), so
a reload or shared link reopens the investigation, and a sr-only status line
announces each settled result count. The figures' caption names what they leave
out (partly checked, failed, not searched) so they reconcile with the total, and
Rival ahead sits apart because it overlaps them. Details open in a full-width row
under the query, the ranking page first as a `SourceLink`. Tooltips here use the
clamped bottom placement. Failed and
Not searched rows say so, a partly checked row reads "Not in top <row depth>" with
the summary's requested depth in its tooltip (the API never counts it under Not in
top <requested depth>; Show offers Partly checked, like Failed and Not searched, only
when there are some), and the ranking page lives in Details. A new filter, order or search returns to page 1.

### OpenRouter sweep models

Global Settings stores one OpenRouter key and quota. Project Answer engines and
the first-sweep setup select concrete models through the same picker
(`components/shared/OpenRouterModelPicker.tsx`). Answer engines stages added
models, with a note and a primary Save engines until they are saved. The AI
Visibility setup step shows an administrator the picker inline, and Save models
stores the routes through the same project update. Vendor filters appear only
for vendors in the catalog; an empty catalog says the list could not load, never
that a search matched nothing. The bare
`openrouter` connection never counts as an automatically selected sweep engine.
Each `openrouter:<vendor/model>` selection keeps its own checkbox, result row,
filter value and comparison history; use `providerDisplayName` to identify the
model via OpenRouter alongside direct providers. Search behavior is automatic,
with no search-backend controls. Aero and classifiers choose their own models.

### Search answer services

Render answer services from `/settings` data (`kind`, `connection`, `selectionKind`, `profiles`, `workflows`), never from a vendor name. `lib/provider-routes.ts` rebuilds route families from the catalog. A routed connection (OpenRouter, an answer service) is never an engine checkbox or a preselected engine; answer-service profiles are opt-in rows, never part of "All configured engines", never the research default, and never count toward setup readiness. Research results show the server's `evidence` and `citationMeasured` as returned, without deriving counts.

### Build workflow

`pnpm --filter @canonry/canonry-web build` builds into a temporary directory before updating `dist/`.
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
latest point's date and sweep count, one headline figure, the chart, and a
closed Details that opens on the latest point's base ("21 of 132 answers").
When the project tracks both branded and non-brand queries and has a brand
name (`queryClassSplit`), a Non-brand | Branded | All toggle leads the controls,
opens on Non-brand, and sends `queryClass` to the metrics route, so every rate,
point and query-set change reads that class's answers only. Mention share is
non-brand already: it reads the unsplit response and the toggle steps aside.
While the first and latest points measured different queries
(`querySetShift`) the change figure turns muted and a "Queries changed" caution
icon carries the reason in its tooltip, except mention share when every query
they do not share is branded; Details says why with dates. Never a sentence in
the readout itself.
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

### Activity tab

`ActivitySection` orders Server activity, Site traffic (GA4's overview), AI
traffic history, then the GA4 detail sections (Traffic by channel, Social, Top
landing pages, Google organic search traffic). `ActivitySection` owns the one
7d/30d/90d control and shows it in the Site traffic heading in every GA4 state;
`ClickThroughActivity` renders the AI traffic history in its `between` slot,
outside every GA4 state, so a disconnected GA4 removes neither. Site traffic is
`SiteTrafficCard` over `/ga/overview` (complete days ending yesterday against
the previous period, as GA4 counts them): five figure slots whose labels are
pickers (picking a figure already shown swaps the two; the choice is kept in
this browser), and the chosen figure by day with the previous period dashed.
Every figure and change is the API's; colour follows `gaOverviewChangeTone`,
so a falling bounce rate reads as good news. Under each section's figures, its
charts and tables are closed `.visibility-disclosure` rows (`DisclosureRow`)
that mount their detail only while open, each summary carrying the API's
count, or "None in this period". Never drop a figure while restyling this tab;
the site-wide sessions chart disappeared once that way.

### API calls (Critical)

A connected Search Engines tab reads stored evidence on mount. Google property
and sitemap lists load on explicit actions; a connection awaiting its first
property may load that picker on mount. The latest stored GSC sync failure
supplies the initial error signal, and live property errors appear on opening
setup or refreshing properties. Both resubmit actions wait for a sitemap load.

**Every web call into the canonry API MUST flow through the generated
`@canonry/canonry-api-client` SDK.** Raw `fetch()` and `XMLHttpRequest` are
banned in `apps/web/src/` (lint-enforced) — the only exceptions are
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
helpers from `@canonry/canonry-api-client/react-query`, passing the
exported `heyClient` from `src/api.ts`:

```typescript
import { useQuery } from '@tanstack/react-query'
import { getApiV1ProjectsByNameOptions } from '@canonry/canonry-api-client/react-query'
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

An Advanced Property scope in AI Visibility offers a `Property details` link to
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

In Advanced Query results, a Cited cell with `uncheckedSources` keeps its rate or `Not measured`, adds what the saved links cite (`UNCHECKED_SOURCES_COPY`) and swaps the missing-evidence tooltip for the plain-words "partly saved" one; Property outcomes adds the server's `summary.notMeasuredUnchecked` line. Beside per-property numbers, the older site-wide cited flag is named `<domain> cited (any page)` (`siteCitationLabel` in `lib/format-helpers.ts`): Advanced Project signals badges (only phrases whose `siteCitation` is not false: competitor and Business Profile insights borrow the states for another subject) and the Advanced Competitor history "you" row. Simple surfaces keep the bare label.

`ProjectPage` owns the shared measurement URL selection and the `/queries` route.
`QueriesSection` in `DiscoverySection.tsx` owns tracked assignments and the separate Research workspace.
Research retains ICP discovery and bounded tests. Promotion must use query-tracking preview and commit.
Advanced tracked query scope and class filters must both honor URL selection. Simple tracked rows have no assignment classes, so retain their complete list and omit the class control even when the shared report URL carries a class filter. Retired scope keys require explicit recovery before scoped edit actions are available; the body keeps that recovery while the context row names the saved scope as unavailable. The tracked body renders no scope picker. Expose assignment membership behind an accessible disclosure. Within a Group, expand Subgroups before a collapsed All properties shortcut; leaf Properties remain expanded and collapsible. Reopening restores the selected Group or an explicit parent of the selected Property. Search results remain visible across matching levels.
Research starts with direct query entry. Run once hides all pattern controls. Repeat modes offer saved patterns as an optional disclosure, not a required Template selector. Allow authorized writers to save named patterns in the browser. Repeat mode selects explicit markets, properties, or configured locations. Never expand groups implicitly. Use the shared research helper for declared variables and reject unresolved placeholders. Show every resolved query and its independent provider location before submission. Preserve editable previews and require a new review after setup changes. Submit exact reviewed queries with explicit provider, model, location, and applicable plan revision to the atomic research batch endpoint. Reuse the request key after an uncertain response. Keep direct and location-only research available without a plan or during hierarchy read failures. Save pattern provenance separately from final text. Show final-text classification and carry saved scope into tracking review. Research labels describe project brand-name/domain checks, not verified property identity. Keep saved answer engine, model, and location visible. Research and both Advanced answer views share `AnswerMarkdown` for contextual heading levels, lists, emphasis, safe external links, and no remote images. Saved answers use normal page scrolling and offer exact-text copying with inline feedback. Keep source details in a counted disclosure, preserve evidence classification, and reflow property answer rows within narrow containers. Closing scoped answers restores focus to their initiating engine button when available.
Use the server-reported research `access.canRun` and `dailyRunLimit` for both direct and repeat research. Do not infer research permission from general `canWrite`; a research-only credential can run queries without broader write authority. Limited accounts use safe provider choices from stored history, never `/settings`, pattern saves, ICP discovery, or tracked-query promotion. Signed-in viewer authority still requires the deployment opt-in on the server. Each destination run counts toward the same project daily cap across browser, API, CLI, and MCP.
After query publication, invalidate the project's query and measurement reads together. A refused preview or commit refreshes the workspace version while preserving the editable draft.
For Advanced Measurement, `VisibilityWorkspace` in `VisibilityTrendSection.tsx` consumes the server's frozen report. On clean URLs, normalize to the selected class using that exact population from the first all-class response; retain its cache timestamp and generated query-key identity so invalidation and scoped pagination still fetch correctly. Normalization writes the URL with `replace: true`, so it adds no history entry. Load Advanced Project signals and competitor history when their disclosures open, while Simple primary metrics still load on arrival.
`VisibilityOverview` renders the Advanced overview: `VisibilityResultsToolbar` above the `VisibilityWorkspace` it keys by the whole selection except the open answer. The toolbar reads `useVisibilityReportFirstPage`, which is not keyed, so it mounts with the first available report and stays mounted, with its focus and open Filters panel, while a filter change reloads the results below. It is absent before the first report, on error, and for the v1 and unmeasured fallbacks. The toolbar row holds Query type, the run state and date, the Filters button, one removable token per non-default URL filter, the Property details link, and Manage queries (never in embeds). Every control value and token reads the URL selection, never the server echo; choice lists come from the displayed report and always keep the URL value. The inline Filters panel (engine, location, model, UTC dates, Results from) starts closed, closes on Escape back to its button, and Clear filters removes only those filters, never scope, market, class or the `runId` drawer. Tokens and toolbar buttons use the shared rectangular `Button` sizes and `text-button-14`, never pills. An Advanced explicit date range is a token, not context-row meta.
Keep branded, non-brand, and unknown populations separate. Format server rates without deriving them from counts. Query results show each query once, with property and location details shared only when every engine row has identical context. Keep differing contexts beside their engine. A single-answer rate of 0 or 1 may read No or Yes, unless it carries `unattributed` or `unchecked`, which keeps its count; preserve multi-answer rates/counts and explicit unavailable evidence. Every Cited rate shows `uncheckedSourcesLabel` and every Mentioned rate `unattributedAnswersLabel`, through `excludedAnswersLabel` in `src/lib/format-helpers.ts`, never under the other signal; the Advanced trend adds `REPORT_TREND_UNCHECKED_NOTE` when a plotted Cited point left answers out. Engine rows reflow on narrow screens while retaining their mention/citation labels and answer action.
Default the shared URL selection to all queries for Simple and Advanced, preserving explicit query-type links.
Simple history without query labels must show its saved unclassified results on arrival. In the all-query view, omit Simple classes with no current or historical queries when another class has results; keep Advanced unmeasured classes explicit.
Each population opens with its headline strip: the class heading, a caption, and `dl.report-headline` — separate `.report-headline-tile` surfaces with a gap, never a shared border or dividers — for mention coverage, citation coverage, and Properties mentioned (omitted for a Property scope). One column on phones, then the `data-columns` count. Every tile label carries an `InfoTooltip` from `REPORT_HEADLINE_HELP` in Simple, Advanced aggregate and Property scopes alike. A tile prints the server rate with its metric's change inline beside it in `REPORT_CHANGE_COPY` words (`Up 4.2 pts` positive, `Down 4.2 pts` negative, `No change` and a metric's `No earlier value` secondary; an unavailable or inapplicable current value prints nothing), then one supporting line of `numerator of denominator answers|properties`, plus a second line from `unattributedAnswersLabel` when the server's mention rate carries `unattributed`, or from `uncheckedSourcesLabel` when its citation rate carries `unchecked`; `formatPointDelta` only formats the server delta, and a null rate prints its reason with no change. The class is visible only in the `h2`; each tile repeats it as `sr-only` text beside its value, so every figure still names its own instrument. The caption is the one place the comparison is named: `12 queries · 36 answers · vs Sep 8 sweep`, where the previous sweep is an observed instant that keeps its year unless it falls in the displayed sweep's year, the one population-level `REPORT_CHANGE_COPY` reason replaces the `vs` part, and `no-selected-run` or an absent `comparison` leaves the comparison unnamed; its explanation `InfoTooltip` stays beside it. The trend legend is a checkbox fieldset whose last visible series cannot be hidden; Cited draws dashed with hollow dots. Order: strip, trend, Scope breakdown (4px bars at the server rate, none for a null rate), Property outcomes, Query results, Competitors.
Those collapsed rows are one list, not five components. `Property outcomes`, `Query results` and `Competitors` here, plus `Project signals` and `Competitor history` in `ProjectPage.tsx`, all use `.visibility-disclosure` / `-summary` / `-label` / `-meta` from `styles.css`, so one label weight, one row rhythm, one divider and one focus ring cover the whole stack; they came from two components and read as two designs (64px bold rows against 44px quiet ones, a section gap in the middle, a focus ring on only three). Keep the utilities in the stylesheet rather than at the call sites: `design-tokens.test.ts` compiles the rule, which is the only place drift is visible. The Simple overview is the exception: it shows the same `CompetitorLandscape` as the "Competitors over time" card among its page sections, loaded on arrival. `Project signals` and Advanced `Competitor history` carry no count: their data loads when the row opens, so any number before that would be invented.

The Advanced `Property outcomes` disclosure matches its Query results and Competitors siblings: a bold label and, beside it, the server's own `summary.outcomes.total` as `12 properties` (`1 property` singular). Never sum the buckets to get it; the response schema already requires the partition to sum to `total`, so a drift must stay visible rather than be papered over by a UI count. The buckets keep their labels and order (mentioned and cited, mentioned only, cited only, neither signal, not measured). `REPORT_OUTCOMES_HELP` explains all of it, and its `InfoTooltip` sits in the opened panel beside the bucket list, never inside the `<summary>` — a button there would toggle the disclosure on click and join the summary's accessible name. Its copy states what the server computes in `outcomeCounts` / `targetPresence` and nothing beyond it: the buckets count properties rather than answers, `citedOnly` is the engine using the page as a source without naming it in the answer, `notMeasured` covers both an unmeasured property and a half-measured one (calling that "mentioned but not cited" would assert an absence nothing measured), and one verified signal survives a later uncertain answer. The partition reads a property's own two signals and no competitor's, so neither this copy nor the same sentence on `measurementOutcomeCountsSchema` may say a rival was recommended instead — `citedOnly` never measured one. Give the five buckets five distinct counts in any test fixture, or a rotated tuple list renders one bucket's count under another label and still passes.
Never draw an empty trend chart when every server rate is unavailable. Chart tooltip labels show the observation date without the time. When a chart has rates, retain its history table for screen readers without a duplicate visible disclosure; comparison warnings stay beside the chart. If no rates can be plotted, show the history table for recorded sweeps, including dates and comparison markers for partial measurements.
The scope picker starts with top-level Groups. Browse uses explicit frozen parent-group relationships and property memberships; keep query-context Markets separate. Search can find nested Groups and Properties. Never infer hierarchy from labels or property counts. Report recovery reads the typed `error.details` through `apiErrorDetails` and `parseVisibilityReportScopeErrorDetails`, never the message text: a retired market offers Show all markets and clears only `measurementMarketKey`, a retired scope offers Show whole site, and any other failure offers Retry.
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
`recharts` directly. Lint enforces this.

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

`DESIGN.md` is the visual contract. `src/geist.css` defines the Geist palette,
typography presets, and named materials. `src/styles.css` maps them to Canonry's
semantic roles and shared component classes. Update both the implementation and
`DESIGN.md` when changing a foundation rule.

Color and chart tokens remain in a static, non-inline `@theme` block so the
full foundation is emitted and generated utilities reference `var(--color-*)`.
This keeps scoped light/dark themes live. Do not inline themeable color values.
Use semantic utilities (`bg-bg`, `bg-surface`, `border-default`, `text-primary`,
`text-secondary`, `text-link`, `text-on-inverse`) and tone utilities
(`text-positive`, `border-negative`, `bg-caution-soft`). The existing `mono-*`
and tone scales are compatibility aliases into Geist, not Tailwind zinc,
emerald, or rose palettes. Prefer a named semantic role over an off-ladder shade.

The UI uses locally bundled Geist Sans and Geist Mono. Choose a complete
`text-heading-*`, `text-label-*`, `text-copy-*`, or `text-button-*` preset rather
than assembling size, weight, line-height, and tracking separately. Labels are
for single lines; copy is for multiline content. Use the preset's strong or
mono variant when appropriate. Metadata and chart labels have a 12px minimum;
meaningful supporting copy is at least 13px. `lib/utils.ts` keeps typography
and text-color classes in separate `tailwind-merge` groups so `cn()` retains
both and callers can replace the default text role.

Use one named `material-*` preset on a bounded surface. It owns fill, outline,
radius, and shadow. Do not stack material classes or add another border/shadow
on the same edge. Layout classes still own padding and dimensions. A viewport
attached sheet keeps its attached edges square. See `DESIGN.md` for the role
map; preserve focus handling and accessible names when changing chrome.

The shared topbar's `ThemeSelector` uses icon options in `SegmentedRadioGroup`
for Light/Dark/System and saves the choice in `canonry:theme`. Preserve its
accessible names, tooltips, roving focus, and arrow-key selection.
`ThemeProvider` wraps `AuthGate`, applies the resolved mode to the document root,
and follows OS/storage changes; Dark remains the initial default. The inline
bootstrap in `index.html` resolves the same preference before paint, after the
server's config injection. Keep both paths aligned. Embeds keep their own mode
(dark when omitted) and custom colors, with no standalone selector. Theme
overrides must reach floating layers too: a portal outside a themed container
does not inherit its tokens. Native controls use the corresponding `color-scheme`.
Keep chart/provider identity and the accessible Site Health state palette
separate from semantic UI colors.

**Design-token ratchet.** `design-tokens/no-literal-palette` in `.oxlintrc.json`
rejects raw Tailwind palettes throughout `apps/web/src`. Only `ProviderBadge`
and `ChartPrimitives` are excluded for provider identity and chart fallbacks.
`pnpm --filter @canonry/canonry-web scan:colors` is a progress report; lint is the
gate. Keep chart fallback values synchronized with their CSS defaults.

Validation owns different risks:

- `test/design-tokens.test.ts` compiles Tailwind output to check theme variables,
  readable typography, and material behavior. jsdom cannot reliably calculate
  Tailwind v4 layers, properties, or color mixing.
- `test/dashboard-class-baseline.test.tsx` checks representative route markup.
  Inspect changed class baselines before accepting them.
- Browser checks cover desktop/narrow layouts, both themes, charts, and floating
  controls with actual bundled fonts. Typecheck, type-aware lint, and build
  remain required at final validation.

### Onboarding state and draft recovery

- Public domain/name/locale and unsaved query/competitor inputs restore from allowlisted session storage scoped by base path and project. Scan consent and provider credentials never persist. Saving clears the saved field's draft; Reset restores persisted project/query state, while Skip or leaving preserves unsaved inputs.
- Completion leads with a compact Project saved heading, one sweep status and Open project. Optional setup is a flat list: Connect your agent opens `/agent-setup`, and the data-source details start closed. Keep promotional demos and repeated explanatory paragraphs off this finish step. It derives scan/sweep outcomes from their latest saved runs. Distinguish never started, skipped, queued, running, partial, failed, cancelled and completed; name previous saved evidence separately. Provider/query readiness determines the next action.
- Bare setup without a run offers Run first scan and a way to continue without scanning. Show the first scan's 100-page cap at the decision.

### Layout and navigation

- **Sidebar navigation** (persistent left, `w-56`, hidden on mobile with full-screen overlay fallback).
- The full-screen navigation uses the shared Radix dialog behavior: focus starts
  on Close, stays inside while open, and returns to Open navigation after Close,
  Escape, or route navigation. Closed navigation is unmounted; background content
  is unavailable to pointer and assistive-technology interaction while open.
- **Compact topbar** with breadcrumb, health pills, and primary action button.
- **Page container** (`max-w-6xl`, centered) for all page content.
- **Aero bar lane.** While the floating Aero bar shows, `RootLayout` adds `main-area-agent-bar` to `.main-area` (the wrapper holding the page): bottom padding plus a matching root `scroll-padding-bottom`, so the bar never covers a control. Product links and the version live in the sidebar and mobile navigation, outside the page. Pages never pad for the bar themselves.
- Pages use a `page-header` (title + subtitle + optional actions) followed by sections separated by `page-section-divider`. Project pages instead use the project context row: identity lives in the topbar breadcrumb (plus one visually hidden `h1`, visible below md), and the sweep action lives in the row's `[data-project-actions]`. Embeds keep `page-header`.
- Sidebar main nav items use Lucide icons (`LayoutDashboard`, `Globe`, `Play`, `Settings`).
- The sidebar Projects section shows each project with a colored dot indicating visibility health tone.
- The sidebar Resources section sits at the bottom, with the `Rocket` icon for Setup. Doc links sit in the sidebar footer.
- `AgentSetupPage.tsx` owns `/agent-setup`, shared by desktop/mobile navigation and onboarding. Hosted setup leads with the canonical URL from `mcp.hosted` health, then client OAuth sign-in/consent and a stored-read verification prompt. Never infer hosted readiness or its URL from browser origin or transport availability. Readiness describes server prerequisites, not public reachability or a client connection; missing metadata stays unconfirmed. The explicit `dashboard.showLocalAgentSetup` setting (default true) controls local plugin, CLI, and stdio MCP instructions independently of readiness or account role. When false, omit the local disclosure, local-install CTA on `/setup`, and administrator CLI recovery instructions; use contact-administrator guidance. When true, local setup remains collapsed and targets the browser instance and base path. `showResourceLinks` also hides optional GitHub guides from visible links and copied prompts; client help articles remain available. Keep fresh-install setup separate, preserve existing credentials and scopes, and do not offer connection controls in public demos or embeds.

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
- **Insight cards** use soft background tints based on tone (`insight-card-positive`, `insight-card-caution`, `insight-card-negative`).
- **Sparklines** show inline trends in overview project rows.
- Use `text-label-12` for nonessential section context; never use 10–11px text. Meaningful supporting copy is at least 13px and uses `text-secondary` or stronger.

### Text and tooltips

- **Heavy text belongs in tooltips, not inline.** A data surface shows values, one-line captions, and eyebrow labels — not prose. Multi-sentence explanations (methodology, "what this means", the evidence behind a finding) push the numbers down and break the analyst's scan, so they move into an `InfoTooltip` (`components/shared/InfoTooltip.tsx`) on the relevant heading, label, or row title. The trigger is a real keyboard-reachable button and the copy rides its `aria-label`, so nothing is lost for assistive tech or for tests (`getByRole('button', { name })`).
- **What may stay inline:** the metric value itself, a single-line caption/subtitle, eyebrow section labels, and **empty / onboarding states** (which must instruct — a "connect this integration" empty state is the only content, not heavy text).
- **The test:** if a sentence explains or justifies rather than labels or names, it goes in a tooltip. The section heading gets the info icon; the descriptive paragraph under it should not exist.

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

The trailing tool group owns progress between calls; never add a second typing
row in those gaps. Keep its status mounted, name the current phase, and stop
progress when the final answer arrives, before transcript persistence finishes.

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
