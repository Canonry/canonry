# Query control and AI visibility

Queries controls future measurement. AI Visibility explains stored results.
Both surfaces use the same API contracts as the CLI and MCP.

## Assign queries

An advanced project adds market and location queries in the **Add queries** sheet:

1. Open the project's **Queries** tab and select **Add queries**.
2. Set **Subject** to **Market** or **Location** and choose one market or one location. A group row only opens the group, and only groups that hold a market (or a location) are listed. Changing **Subject** clears the choice.
3. Enter the queries, one per line. Blank and repeated lines are skipped.
4. Optional: under **More options**, set **Type** to **Branded** or **Non-brand**. **Automatic** leaves the class to the server. Any other choice applies to every line and stays visible beside **More options**.
5. Select **Review**, then check the numbers before and after, and the table of changes.
6. Select **Publish N changes**, which stays at the bottom of the sheet with **Back** and the sweep pause notice.

Each market line becomes one addition for that market with no contexts, so it takes the market's frozen engines, models, and search locations.
Each location line becomes one addition for that location and every market the location already has queries in, again with no contexts. The query is asked with those markets' engines and search locations and counts in those markets' numbers, not only on the location's own page. The sheet lists the markets under the picker (**Counts in**). The info button beside that line says the query is asked with those markets' engines and search locations.
A location with no query in any market has nothing to take them from. The sheet marks it **In no market** and sends the location with one search location and engines: the project's only one, or the one chosen under **Search location and engines** when the project has several. A project with none shows **No search location**, and **Review** stays off.
If the server refuses a review or a publish, for example over the 1,000-query limit, the review shows the reason with **Review again**. **Back** returns to the draft, which is kept.
The link **More ways to add** leads to the Add query form, for hand-picked locations, saved patterns or saved research. That form adds one query at a time, so it opens with the first line only, and the sheet shows **First line only** when there are more. **Company** is not available yet, which the info button after the **Subject** choices says.
When the Tracked view is filtered to one market or one location, the sheet opens with that **Subject** and place already chosen.
A location's page opens the same sheet from **Add query about this location**, above the queries assigned to that location. It starts on **Location** with that location chosen and has no link to the Add query form. After a publish the sheet closes and the page reloads its list. A view-only account does not see the button.
That list shows one query type at a time, and with **Type** on **Automatic** the server files a query that names the location as **Branded**. When a new query is filed under the type the page is not showing, the page says so above the list (for example "1 query you added is listed under Branded queries.") and **Show branded queries** switches **Query type** to it.
A simple site has no sheet: **Add query** opens the Add query form directly.

The Add query form assigns one query at a time:

1. Open the project's **Queries** tab.
2. Open the Add query form or an existing query's assignments.
3. Enter a query, select a saved pattern, or select a saved research result.
4. Select the locations, groups, or markets for the query.
5. For new group or location assignments, select a search location and engines. A market uses its frozen context.
6. Select **Review changes**.
7. Check the resolved queries, assignments, and next-sweep workload.
8. Select **Publish N changes** (**Confirm changes** on a simple site).

An advanced project's review shows the same thing for every change, from the sheet, the form, **Edit** or **Remove**:

- **Queries** and **Answers per sweep**, each as the count now and the count after publishing, with **Answers added** and **Answers removed** kept separate. **Queries** counts the queries the project asks, so a query that loses its last location leaves the count.
- One row per added, reused, and removed query: its Subject, its type, and its location links. A query has one link per location and search location, so the count can be higher than the number of locations. A removed row shows how many links it removes, with the Subject and type it has now. A query asked as Branded for some locations and as Non-brand for others reads **Mixed**. **N locations** under the query lists each location with its own type.
- **Search location and engines**, once above the table when every query is asked the same way, or as a column when queries differ (the type then sits under the Subject). Engines read by name, and the value opens the model ids. Two that differ only by model show their model ids.
- Unchanged queries, behind **N unchanged queries**, each with its own list of locations.
- **New numbers next sweep**, under the counts. Its help says what stays on screen until then: location pages and competitor results show no numbers, AI Visibility keeps showing the last sweep, past answers are kept, and publishing does not run a sweep. A review with no changes shows no such note.
- **Market changes**, when the publish takes a location out of a market: each market with its locations now and after, and **Loses N locations** or **Market emptied**. **Publish** stays off until **Confirm market changes** is ticked. This check is the dashboard's: the CLI, MCP and the API report the same `marketChanges` and publish without it.
- **First answers** with the next scheduled sweep date, beside **Publish**, when the publish adds answers and the page passes that date to the review. While a sweep is queued or running, **Sweep running** shows there and **Publish** is off.

Every figure comes from the preview response, the same one `canonry query preview` returns. A simple site keeps its shorter review.
If the server refuses the review or the publish, the review shows its message and **Review again**.

Publication starts no provider calls. New assignments await the next project-wide sweep.
An unchanged preview cannot publish another revision.
If another operator changes the workspace, the API refuses the stale preview.

For a simple site, the project is the assignment target.
The server classifies its queries from the project identity.
Advanced assignments can carry an explicit operator classification.

## Edit or remove a query

1. In **Place**, select All of {project}, a location, a group, or a market.
2. Select **Edit** or **Remove** beside the query.
3. Review the selected scope and the proposed changes.
4. Select **Publish N changes** (**Confirm changes** on a simple site).

All of {project} changes every assignment of that query. Other places change only their existing assignments.
An edit preserves the stored engines, models, locations, and unrelated market assignments.
A scoped text edit creates or reuses the new question. Other properties keep the original question and its measured history.
An unchanged edit publishes no revision. Editing a resolved template question does not expand the template again.

The editor preserves existing classifications by default. **Automatic** asks the server to classify the selected assignments again.
An exact assignment can belong to several markets. The API refuses a classification change that also changes an unselected market.
New assignments use **Add queries** (**Add query** on a simple site), not **Edit**.

## Scope definitions

| Scope | Includes |
| --- | --- |
| Project | All measured assignments in the selected definition |
| Group | The properties in a named collection |
| Market | Explicit query, execution-context, and property edges |
| Property | One measured identity and its assigned queries |

A group is not a search location. One property can participate in multiple markets.
Market selection does not include unrelated queries merely because they share a property.
The published plan stores market edges in `reportingScopes`.
Property and group selections constrain a selected market. They do not add every property in that market.
Each market retains its own frozen engines, models, and search locations.

Both reads return server-built scope choices in `scopeOptions`.
Each choice has a `targetCount`: the number of distinct properties it selects. A market with several edges to one property counts that property once.
The visibility report builds its choices from the frozen definition it measures. There, groups and properties list their linked markets in `marketKeys`.
The query workspace builds its choices from the active plan. Tracked assignments have no market intersection, so its groups and properties carry no `marketKeys`. Markets keep their group parent in `parentGroupIds`.
A simple site returns only the project choice.
A report scope or market that is not in the frozen definition returns `400 VALIDATION_ERROR` with typed `details`.
The `reason` is `retired-scope` for a group, market, or property scope, and `retired-market` for a market refinement. `kind` and `key` name the missing selection.

## Query subject

Each tracked row in the workspace and preview responses carries `focus`, its Subject.
The server derives it from the active plan's pairings on every read. Nothing stores it, and no request can set it.

| `focus.kind` | Shown as | When |
| --- | --- | --- |
| `market` (with `key`) | Market | The query sits in exactly one market and covers every location in it, with no pairing outside it. |
| `property` (with `key`) | Location | The query has exactly one location and sits in every market that location belongs to. A location in no market counts. |
| `company` | Company | Every query on a simple site. |
| `custom` | Hand-picked | Any other advanced placement. |
| `not-asked` | Not asked | The query has no pairings. |

Both rules can hold only for a market with one location. Then Type decides: a query that is Branded at every assignment is the Location, otherwise the Market. Type decides nothing else, so a Branded query that covers a market is that Market.
A pairing sits in a market when any of its search locations does.
The Subject can change when a market's locations change. After a location joins a market, that market's existing queries stop being the Market until they cover it.
A location-only add at a location that belongs to a market is Hand-picked until the query joins that location's markets.

Templates expand before publication. Each result retains its template version, bindings, and resolved query text.
Duplicate matching prefers the query ID that the active plan already uses.
Otherwise, matching uses normalized query text.
Shared execution contexts reuse one provider request across multiple property assignments.

## Workspace numbers

The workspace read returns its own counts, so a client prints them without recounting rows.
Each field in this section is optional on the wire, so a client still reads a server that predates it.

Each tracked row carries `queryClasses`, its Type: the distinct classes across every plan assignment of the query (one per location and search location), sorted. Two classes mean Mixed, none means Not set.
A row's per-location `assignments[].queryClass` shows one class per location, so it can list fewer classes than `queryClasses`.
A simple site's row carries the one Type the project classifier gives it, or none when the project has no usable brand name.

`summary` counts the tracked rows:

| Field | Counts |
| --- | --- |
| `asked`, `notAsked` | Rows with and without a pairing. Together they are the row count. Every row on a simple site is asked. |
| `byClass` | Asked rows by Type: `branded`, `nonBrand`, `mixed`, `unknown` (shown as Not set). A mixed row counts under neither Branded nor Non-brand. |
| `byFocus` | Asked rows by Subject: `market`, `property`, `company`, `custom`. |
| `assignments` | Location links: plan assignments (`total`, `branded`, `nonBrand`, `unknown`), the unit of a preview row's `assignmentCount`. One query at one location with two search locations is two. All zero on a simple site. |
| `answersPerSweep` | Provider answers one sweep asks for. A preview that changes nothing reports the same number as `workload.existingProviderCalls`. |
| `structure` | `targets`, `markets`, `groups`, `topLevelGroups`, and `competitors` (distinct domains across groups). |

`byClass` and `byFocus` each add up to `asked`.
An advanced portfolio's read also returns `limits.queries`, with `next` equal to `current` because a read changes nothing.
`current` is the compiler's count of assigned queries, and equals `summary.asked` for every plan the compiler published.
`limits.queries.left` is the room under `max`, 0 when the plan is over it.

Each place carries its own counts:

| Place | Fields |
| --- | --- |
| `targets[]` | `marketKeys` (on `targets[]`; `scopeOptions` location choices still carry none): markets holding an edge for the location. `counts.propertyQueries`: rows whose Subject is this location. `counts.marketQueries`: rows whose Subject is a market holding it. `counts.customQueries`: hand-picked rows paired with it. |
| `markets[]` | `targetKeys`: the distinct locations its edges name. `counts.marketQueries`: rows whose Subject is this market. `counts.propertyQueries`: rows whose Subject is one of its locations. |
| `groups[]` | `counts.queries`: distinct queries paired with a member location. `counts.markets`: markets whose `groupKey` is this group. |

Every place also has `counts.answersPerSweep`: the answers of the distinct executions the place has a usage edge on.
An execution shared by two locations counts once in each, so place values do not add up to `summary.answersPerSweep`.
`markets[].counts.marketQueries` add up to `byFocus.market`, and `targets[].counts.propertyQueries` add up to `byFocus.property`.

A plan published before query control froze pattern records keeps only the source. Such a row reads `provenance.source: template` with no `template` record.
Adding the query to another place keeps that source.

## Read results

1. Open **AI Visibility**.
2. Select a scope and query type.
3. Select an answer engine, model, location, date range, or measured run when required.
4. Open a group or property to narrow the results.
5. Select **View answers** beside a query.

The summary, trends, query rows, answers, and competitors use the same selection.
Query search changes the list, not the summary denominator.
The API returns counts, rates, and unavailable states. The browser does not derive rates.

Branded and non-brand queries remain separate populations.
**All classes** shows separate sections, not a pooled score.
Historical simple results without a frozen classification appear under **Unclassified**.
Unknown or incomplete evidence is not a measured zero.

The Advanced Measurement overview (`GET /measurement-overview`, `canonry measurement-plan property`, `canonry_measurement_overview`), measurement changes (`GET /measurement-changes`) and the revision report (`GET /measurement-report`) also read one query class: non-brand when the request names none. Branded is a separate read. `queryClass=all` pools both classes into one rate and is served only when requested; the response echoes `queryClass: all` and the CLI heading says the queries were pooled. A schema v1 revision records no class, so its report covers every answer and echoes `queryClass: null`.
The overview reads a market with `scope=market&marketKey=<key>`: only that market's queries, the same population this page shows for the market. A `marketKey` sent with any other scope is refused (400), never ignored. A group with the same name reads every query its Properties carry, so its figure is not the market's. The response `scope` names the kind and label it read.

After a tracking change, a sweep of the new plan has to complete before these five reads show it. That is the default, so a script can start a sweep on it:

- The overview and three location reads (`GET /measurement-property-evidence`, `/measurement-property-competitors` and `/measurement-property-questions`) answer `not_measured`.
- Answer text (`GET /measurement-question-result`) refuses a result of the older sweep (422 `MEASUREMENT_RUN_REVISION_MISMATCH`).

Send `fallback=last-sweep` to read the last completed sweep instead: `--fallback last-sweep` on `canonry measurement-plan property` and `property-evidence`, `"fallback":"last-sweep"` in a `measurement-plan advanced` input, or `fallback` on the five MCP tools.
The sweep is read under the plan it ran with, so its numbers are the ones it had before the change. With the param, `runId` may name that sweep; any other run of an older plan is still refused. The response `measurement` then carries four more fields:

| Field | Meaning |
| --- | --- |
| `activeRevision` | The plan in effect now. |
| `measuredRevision` | The plan the shown sweep ran with (the active plan after a label-only change). Null when no sweep is shown. |
| `awaitingSweep` | True when the two differ, or no sweep is shown. |
| `trackingChangedAt` | When the plan in effect now was published. |

When `awaitingSweep` is true and `measuredRevision` is not null, the numbers are from the `completedAt` sweep. With `measuredRevision` null there is no sweep yet. Queries removed since still count and queries added since do not. The human CLI output adds one line with both dates.
A location or type that sweep did not ask has no numbers, never a zero. Two reads say why and two do not:

- The overview and `/measurement-property-competitors` answer `no_population` (`not measured (not in last sweep)` in the CLI).
- `/measurement-property-evidence` and `/measurement-property-questions` return an empty page with no reason. With `awaitingSweep` true, check the overview before reading an empty page as "nothing found".

The labels of an older sweep are the sweep-time ones too. A label-only publish made between the sweep and the tracking change is not carried: a location it renamed reads under its older name, and a market it added reads `no_population`. Take current names from `GET /measurement-plan`.
The param is refused (400) with `from` or `to`. Probe runs, spot checks and partial sweeps are never the last sweep. Portfolio summary, measurement changes and data quality do not take the param and still answer not measured after a tracking change; `runId=latest` still reads no sweep.

Each population also carries `comparison`, its change since the previous eligible sweep.
That sweep is the whole-project sweep immediately before the selected run. Spot checks and probe runs never qualify.
The date window and a selected run do not limit it, so the previous sweep can predate the date window.
A change requires both sweeps to be complete, with a comparable definition and the same engines and models.
Otherwise `comparison.reason` names the cause, such as `partial-run` or `model-changed`.
Each available `delta` is the current rate minus the previous rate. An unavailable change is not a zero change.
When the previous sweep cannot be read, `comparison` is absent and the rest of the report still loads.

## Results per query and engine

`GET /query-tracking/results` (`canonry query results <project>`, `canonry_query_tracking_results`) returns Mentioned and Cited for every tracked query per engine, from one stored sweep, in one call.
It reads stored evidence only and never starts a sweep.

| Input | Meaning |
| --- | --- |
| `scope`, `scopeKey` | The place: `project` (the default), or a `group`, `market` or `property` key. The key is resolved against the active plan. A key the active plan does not hold is a 400. A key it holds that the sweep never measured returns no rows. |
| `runId` | One completed or partial whole-project sweep. Omit it for the default sweep. A probe or a scoped run is refused. |

The default sweep is the newest completed or partial whole-project sweep comparable to the active plan, else the newest of any plan. This is the sweep AI Visibility shows by default.
A simple project has no plan. Its default sweep is the newest of its last 100 sweeps that was sent with the engines, models, search location, country and language the project uses now, else the newest.
So a newer run of one engine, at another search location or with none never hides the full sweep before it. Among the sweeps sent that way, a sweep of the whole query list is preferred over a newer run of only some queries (`canonry run --query`). An all-locations run is one run per search location, and only the one at the project's default search location counts as sent that way. AI Visibility still opens on the newest sweep of a simple project.
`run` names it: `id`, `createdAt`, `completedAt`, `status`, `revision` (null on a simple project) and `matchesCurrentTracking`.
`matchesCurrentTracking` is false when tracking changed after that sweep. A label-only republish keeps it true.
On a simple project, tracking is the tracked queries and the project's names, sites, engines, models, search location, country and language. An older sweep that recorded none of them is never a match.
`run` is null and `rows` is empty until a sweep finishes. `engines` lists every engine the sweep asked.

Each row is one query under one class: `queryId`, `queryText`, `queryClass` and `engines[]`.
`queryClass` is a class the workspace row carries in `queryClasses`, or `unknown` when it carries none. A query asked as Branded for one location and Non-brand for another has two rows. The two are never combined.
A row is returned only when the sweep asked every pairing of that query and class in the place exactly as it is asked now: same location, class, text, engines, models and search location.
A query that was moved, re-typed or reworded since has no row until the next sweep, and neither has one whose engines, models or search location changed. `pendingRows` counts those query and class pairs.
On a simple project the engines, models, search location, country and language are project settings. Changing one withholds every row until a sweep is sent that way, and the workspace marks every query `awaiting-sweep` until then. A run named by `runId` that was sent another way returns no rows either. A new name or site keeps the rows and sets `matchesCurrentTracking` to false.
The project read returns every tracked query, about 0.5 MB per 1,000 queries on three engines. Pass `scope` and `scopeKey` to read one place.

Each `engines[]` entry reads only the answers of that row's own executions:

| Field | Counts |
| --- | --- |
| `expectedAnswers` | Answers the sweep asked this engine for: one per search location the row is asked at. |
| `answers` | Answers saved. |
| `mentionedAnswers` | Saved answers whose text names a location the row covers in the place. |
| `citedAnswers` | Saved answers with fully saved sources that cite a location the row covers in the place. |
| `uncheckedSourceAnswers` | Saved answers whose sources were only partly saved. They are in neither side of the cited count. |
| `mentioned`, `cited` | True when any answer shows it. False only when every expected answer was checked and none did. Null is not checked, never no. |

`mentioned` reads answer text and `cited` reads sources. Neither is computed from the other.
In a place, a row covers only the locations it is paired with there, so a market query read for one location counts an answer only when it names or cites that location.
A simple project is read at project scope only: one row per tracked query, measured when the sweep asked that query with the same text under the same class.

The CLI table prints two glyphs per engine, the mention first, under this legend:

```text
M mentioned · m not mentioned · C cited · c not cited · - not checked
```

## Revision continuity

A label-only publication uses the existing comparable-revision chain.
A material assignment change retains the previous measured revision until the next sweep.
That result uses its own frozen assignment graph, classes, and identities.
The interface identifies the measured revision and pending assignments.
It never applies the new graph to old answers.

Trend points identify definition or model changes.
The trend includes up to 100 recent measured runs within the selected date range.
Historical evidence without enough provenance does not claim comparability.
The measurement run selection uses `measurementRunId` in the browser URL.
It does not open the global `runId` drawer.

### Out-of-date setup draft

A setup draft is a copy of the revision that was active when the draft was started, so a tracking publish made after that is not in it.
Publishing such a draft returns `409 MEASUREMENT_PLAN_REVISION_CONFLICT` with `details.check: draft-out-of-date`.
`details.draftBase` is the draft's `baseActiveRevision`, the revision it was started from, and is `null` for a draft started when no plan was active.
`details.active` is the active revision number, the same value as `details.actualActiveRevision`, and is `null` after a deactivation.
The API, `canonry measurement-plan advanced <project> draft-action` and the MCP tool `canonry_measurement_draft_action` all return it, whichever `expectedActiveRevision` the request names.
To publish, run the `discard` action, run `create` with the active revision, make the edits again, then run `publish`. The dashboard already asks for this.
After a deactivation no plan is active, so the new draft starts empty.
Every other draft action, a competitor pin included, still works on an out-of-date draft, but that draft cannot be published.
`canonry apply` and the legacy `canonry measurement-plan publish <project> <yaml|json>` use no draft and are not refused.
A legacy publish is accepted only when no plan or a schema v1 plan is active. It moves the active revision, so it also puts an open draft out of date.

## Research and operator controls

**Research → Find queries** uses the existing ICP discovery process.
**Research → Test queries** starts with direct query entry.
An optional pattern repeats a query across explicit markets, properties, or configured locations.
Groups are not research destinations.
Neither process adds queries to official tracking automatically.
**Review for tracking** sends selected results through the same assignment preview.

### Repeat research across destinations

The dashboard names a run's market or property its **Subject**, shows a property as a Location, and calls the engine's location the **Search location**.
The API, CLI, and MCP keep `scope`, `property`, and `location`.

1. Select the run mode: **Repeat across markets**, **Repeat across locations**, or **Repeat across search locations**.
2. Select each market, location, or search location yourself.
3. Enter one **Pattern** per line, such as `Best apartments in {market}`.
4. Select the **Engine** and **Model**.
5. Open the preview.
6. Check each Subject, resolved query, and **Search location**.
7. Edit individual queries or search locations as required.
8. Start the reviewed queries.

A pattern substitutes text. For Atlanta, `Best apartments in {market}` becomes `Best apartments in Atlanta`.
`{market}` and `{submarket}` use the market label. `{property}` and `{propertyBrand}` use the property label.
`{location}` uses the search location's label, never the Subject's.
When a pattern repeated across locations holds `{location}`, the form marks it **Uses search location**.
A name the pattern does not recognize blocks the preview.

The Subject does not set the search location.
Each preview row shows a configured search location or **No search location** separately. The CLI prints that state as `No location context`.
Repeating across search locations uses the selected configured locations.
Advanced portfolios can select explicit published markets or properties.
Simple portfolios can repeat across configured locations without a measurement plan.

Authorized writers can save named patterns in the browser.
Saved patterns are optional authoring aids, not active measurement templates.
When a saved pattern is used, each run retains its version and resolved text separately from the final edited query.
Its original name-binding location is frozen at preview time; editing the answer engine location does not change that provenance.
Viewers with Research access can reuse patterns, but cannot save patterns or change tracking.

A reviewed batch contains at most 20 destination runs and 50 total query executions.
Two queries across three destinations produce six executions.
The API saves all destination runs together or saves none.
The existing runner processes each saved run independently, so individual results can fail.
Every destination run counts toward the viewer's daily limit.
Retries with the unchanged request and key return the same saved runs, even after provider, location, or template defaults change.
Research history loads older runs on demand. API and MCP list responses include an opaque `nextCursor`; pass it as `cursor` to continue.
The CLI accepts `research list --cursor <cursor>`. Its JSON output preserves the full response, including engine choices, access limits, and pagination.

The operator's project-wide **Run AI sweep** remains admin-gated.
Group and property selection does not start a scoped sweep.
Embeds expose measured results, not query publication or saved research administration.

## CLI and MCP

| Action | CLI | MCP |
| --- | --- | --- |
| Read assignments | `canonry query workspace <project>` | `canonry_query_tracking_workspace` |
| Read results per query and engine | `canonry query results <project> [--scope <kind> --scope-key <key>] [--run <id>]` | `canonry_query_tracking_results` |
| Preview changes | `canonry query preview <project> <json\|->` | `canonry_query_tracking_preview` |
| Publish changes | `canonry query commit <project> <json\|->` | `canonry_query_tracking_commit` |
| Read visibility | `canonry measurement-plan visibility <project> [<json\|->]` | `canonry_visibility_report` |
| Start one Research run | `canonry research run <project> <query...>` | `canonry_research_run_start` |
| Start reviewed destinations | `canonry research batch <project> <json-file\|->` | `canonry_research_batch_start` |

Preview input contains `expectedWorkspaceVersion`, `additions`, and `removals`, with an optional `edits` array.
Each edit contains `queryId`, an optional audience, and resolved `text` or `queryClass`.
An omitted `queryClass` preserves classification. A `null` value requests automatic classification.
The server retains the exact execution contexts. An edit cannot replace those contexts.
The **Add queries** sheet works out a location's markets in the browser, so a CLI, MCP or Aero add states them itself.
To count a location query in its markets as the sheet does, send `audience: { "targetKeys": [<location>], "marketKeys": [<its markets>] }` with no `contexts`. Its markets are every market in the workspace whose `usageEdges` name that location.
A location in no market has none to take engines from: send `audience: { "targetKeys": [<location>] }` with explicit `contexts` (the sheet sends one). Sent for a location that is in a market, that request counts on the location alone.

Preview output adds `changes`, one row per added, reused, or removed query.
Each row lists the query's locations (`targetKeys`) and markets (`marketKeys`) `before` in the active plan and `after` in the reviewed change.
A scoped removal or move keeps its remaining placement in `after`. Simple projects list no locations or markets, and a no-op returns an empty `changes`.
An advanced preview also returns `marketChanges`, one row per market whose locations change: `marketKey`, its locations `before` and `after` (each a `targetKeys` list), `removedTargetKeys`, and `emptied`.
A market has no stored list of locations. It holds only the locations that still have a query in it, so stopping a query, or moving it to another Subject or location, can remove a location from a market or empty it.
An emptied market stays in the plan with no location and takes no later addition, so read `marketChanges` before you commit.
An addition that names the emptied market alone is refused with `Select at least one location, group or market.`
One that names it with a location or a group, or beside another market through a pattern that uses `{market}`, is refused with `Market "<key>" has no selected location.`
Any other addition that names it beside another market is accepted and placed in the other market only, so compare `changes[].after.marketKeys` with the markets you sent.
The server reports the change and refuses nothing for it: a commit from the CLI, MCP or the API publishes as before. A preview that changes no market returns an empty list, and a simple project returns no `marketChanges`.
Commit input adds the returned `previewToken` and `reviewedAt` to that exact request.
The server binds the review time to the token and refuses expired reviews.
The API returns the actual active revision after publication.
On an advanced portfolio, a commit that changes anything returns `409 RUN_IN_PROGRESS` with `details.reason: sweep-in-progress` while a sweep is queued or running, including a long provider-batch sweep.
A simple basket returns the same code only when a catalog change meets a planless sweep.
The message names the run. Preview and commit the change again after it finishes (a review expires after 15 minutes), or stop it with `canonry run cancel <project> <run-id>`.
An all-locations sweep is several runs: the message then gives their count, `details.activeRunIds` lists them, and each one must finish or be cancelled.
Previews and no-op confirmations remain available during a sweep.
A setup publish (`draft-action` with `publish`) is refused the same way, unless it is identical to the active revision.
It is also refused with `409 MEASUREMENT_PLAN_REVISION_CONFLICT` (`details.check: draft-out-of-date`) when the active revision moved after the draft was started: see [Out-of-date setup draft](#out-of-date-setup-draft).
An advanced preview also returns `limits.queries`: distinct assigned queries now (`current`), after the change (`next`), and the limit (`max`, 1,000).
`limits.queries.left` is the room under the limit now and after the change (`max` minus each count), and is 0, never negative, for a plan over the limit.
A commit that grows the plan past the limit returns `400` with `details.check: query-limit-exceeded`. A plan already over the limit may still shrink.
Preview and commit require write access. Stored workspace, results and visibility reads do not.

The project API prefix is `/api/v1/projects/:name`.
Its five endpoint suffixes are `/query-tracking`, `/query-tracking/results`, `/query-tracking/preview`, `/query-tracking/commit`, and `/visibility-report`.

Research uses `POST /research/runs` for one run and `POST /research/batches` for reviewed destinations.
The batch request contains a required `idempotencyKey` and a `runs` array.
Every run specifies exact query text, `provider`, `model`, and `location` (a configured object or `null`).
A market or property scope also specifies its key and `expectedPlanRevision`.
Optional `templateId` and `templateVersion` fields belong inside that run's `template` object.
The API receives final query text and does not expand patterns or groups.

Example reviewed input for a Simple portfolio:

```json
{
  "idempotencyKey": "research-review-2026-09-10-1",
  "runs": [
    {
      "queries": ["Best apartments in Atlanta"],
      "provider": "openai",
      "model": "your-configured-model",
      "location": null
    },
    {
      "queries": ["Best apartments in Boston"],
      "provider": "openai",
      "model": "your-configured-model",
      "location": null
    }
  ]
}
```

Before submission, replace `your-configured-model` with the reviewed model ID.
For Advanced destinations, add `scope: {kind, key, expectedPlanRevision}` to each run.
If a response is uncertain, retry the unchanged file with the same key.
For a different batch, use a new key.
`--wait` waits for all accepted runs. `--format jsonl` emits one complete record per destination.


Mentions read the answer's prose. Before any project, Property, or competitor alias is matched, citation markup written into the answer text is removed: link chips such as `([example.com](https://example.com/page))`, links labelled with a URL, a path, a lowercase host such as `example.com`, or a citation number, reference definitions, footnote and `[1]` markers, bare `http(s)://` URLs, and provider citation markers. A link labelled with ordinary words, or with a brand-cased name that is also a domain (`Example.ai`), keeps its label, and a host written in prose (`example.com` or `www.example.com`) still counts. A name that appears only in a citation chip or a cited URL path is therefore not a mention, and a Property's URL matchers apply only to cited URLs. Recommended competitors ignore names that appear only in a chip.

Advanced Property identities may include `identityAliases`: explicit qualified phrases containing the Property alias plus identifying context. They survive draft edits and publication; changing them creates a material comparison boundary. They are not a Simple project's `qualifiedAliases`, which are bare project aliases the operator marks as the brand's own names for sentiment only and which never narrow or widen a mention. The reader keeps unresolved identity as unknown for that Property. A multi-entity answer ("Harbor Point can refer to several places") can establish a mention through a qualified phrase or a source URL belonging to that Property. A clarifying question ("Which Harbor Point do you mean?") names the Property in two cases only: the answer cites one of the Property's own pages (a source link its URL rule matches), or the Property's branded query names it, as "is Harbor Point a good place to live" does. A non-brand query that contains the name, such as "best apartments near Harbor Point", uses it as a place and settles nothing, and a schema v1 revision records no query class, so only the Property's own page settles it there. The query is read with the same longest-name rule as the answer, so a query naming "Harbor Point East" does not name "Harbor Point". Otherwise the clarifying answer stays unverified. A Property with qualified phrases still needs one of them, or its own page, in the answer. The raw answer and its citation evidence remain available.

An answer is unattributable for a rate when it verifies a mention of none of that rate's Properties and leaves at least one of them unresolved. Mention coverage leaves it out of both the numerator and the denominator and reports how many answers it left out as `unattributed` beside the denominator (absent means none). The answer's own `mentioned` stays `null` with `mentionUnavailableReason: identity-ambiguous`; it is never counted as not mentioned. The rate is unavailable with reason `identity-ambiguous` only when no attributable answer remains. The visibility report, the Advanced Measurement overview and portfolio summary (as `unattributed` on the metric value), the revision report, the CLI apply the same rule. Every surface that shows the rate states the count beside it, including the Property page, the overview table and its engine rows, and the CLI engine rows: "12 of 1152 answers could not be tied to one property". The CLI prints that sentence; the dashboard keeps it behind a caution icon beside the rate's count, as the icon's tooltip and accessible name. A Property with left-out answers and no verified mention has an unknown mention outcome: Property outcomes count it as not measured, never as cited only or neither, matching Properties mentioned.

An answer is unchecked for a citation rate when it was saved but its source-link capture was incomplete. Citation coverage leaves it out of both the numerator and the denominator, even when it captured a link to the Property, and reports the count as `unchecked` beside the denominator (absent means none). Among saved answers, the rate is unavailable with reason `evidence-incomplete` only when every one is unchecked; a missing answer (no saved observation) still withholds the rate, as below. The trend chart notes that Cited counts only checked answers whenever a plotted point left some out, behind a caution icon after the Cited legend entry. The visibility report (summary, Property, group and query rows, trend points, competitor citation coverage), the Advanced Measurement overview, portfolio summary, rankings and changes, and the revision report apply the same rule. Every surface that shows the rate states the count beside it, including the CLI Property line and engine rows: "2 of 1152 answers had sources that could not be checked". The dashboard keeps that sentence behind the same caution icon beside the rate's count. A Property with unchecked answers and no captured citation counts as not measured in Property outcomes, never as mentioned only or neither. Simple projects never report `unchecked`: their citation state comes from stored cited domains, not URL capture, so the rule does not apply.

`GET /projects/:name/visibility-report` exposes frozen coverage with separate query-class populations for Simple and Advanced Measurement. Its history window preserves comparison boundaries, and the latest summary retains its measurement date. The dedicated client and HTML Report surfaces are retired in [Canonry 7](report-retirement.md).

A saved positive citation remains visible in answer details even when source capture was incomplete, but citation coverage does not count it. Aggregate mention and citation coverage require a saved answer for every selected expected answer: a missing answer withholds the rate and never shrinks the denominator. To restore the rate, fill the run: `canonry run fill <run-id>` asks only the missing answers and saves them in the same run, so the rate returns without a new sweep. `canonry run completeness <run-id>` lists what is missing and whether a fill is allowed; a fill is refused once the run is more than 24 hours old, after the plan was republished, or once a newer sweep exists (full rules in the [CLI reference](../skills/canonry/references/canonry-cli.md)). An answer that was saved with no text is not missing, so a fill cannot replace it: it leaves mention coverage blank until the next sweep, while citation coverage still counts it when its source links were captured. A saved answer leaves a denominator in two cases only: unattributable answers leave mention coverage (`unattributed`), and unchecked answers leave citation coverage (`unchecked`). Provider and location filters narrow the expected population before completeness is evaluated. Property reach is existential: one verified occurrence establishes reach even when a different answer is uncertain.
