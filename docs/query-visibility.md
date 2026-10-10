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
Each location line becomes one addition for that location and every market the location already has queries in, again with no contexts. The query is asked with those markets' engines and search locations and counts in those markets' numbers, not only on the location's own page. The sheet lists the markets under the picker (**Counts in** and **Engines and search locations come from**).
A location with no query in any market has nothing to take them from. The sheet says so and sends the location with one search location and engines: the project's only one, or the one chosen under **Search location and engines** when the project has several.
If the server refuses a review or a publish, for example over the 1,000-query limit, the review shows the reason with **Review again**. **Back** returns to the draft, which is kept.
The link **Hand-picked locations, templates or saved research** leads to the Add query form. That form adds one query at a time, so it opens with the first line only. **Company** is not available yet.
When the Tracked view is filtered to one market or one location, the sheet opens with that **Subject** and place already chosen.
A location's page opens the same sheet from **Add query about this location**, above the queries assigned to that location. It starts on **Location** with that location chosen and has no link to the Add query form. After a publish the sheet closes and the page reloads its list. A view-only account does not see the button.
That list shows one query type at a time, and with **Type** on **Automatic** the server files a query that names the location as **Branded**. When a new query is filed under the type the page is not showing, the page says so above the list (for example "1 query you added is listed under Branded queries.") and **Show branded queries** switches **Query type** to it.
A simple site has no sheet: **Add query** opens the Add query form directly.

The Add query form assigns one query at a time:

1. Open the project's **Queries** tab.
2. Open the Add query form or an existing query's assignments.
3. Enter a query, select a template, or select a saved research result.
4. Select the properties, groups, or markets for the query.
5. For new group or property assignments, select a search location and engines. A market uses its frozen context.
6. Select **Review changes**.
7. Check the resolved queries, assignments, and next-sweep workload.
8. Select **Publish N changes** (**Confirm changes** on a simple site).

An advanced project's review shows the same thing for every change, from the sheet, the form, **Edit** or **Remove**:

- **Queries** and **Answers per sweep**, each as the count now and the count after publishing, with **Answers added** and **Answers removed** kept separate. **Queries** counts the queries the project asks, so a query that loses its last assignment leaves the count.
- One row per added, reused, and removed query: its type, its location assignments, and its search location and engines. A query has one assignment per location and search location, so the count can be higher than the number of locations. A removed row shows how many assignments it removes. **Classifications** lists each location.
- Unchanged queries, behind **N unchanged queries**, each with its own **Classifications**.

Every figure comes from the preview response, the same one `canonry query preview` returns. A simple site keeps its shorter review.
If the server refuses the review or the publish, the review shows its message and **Review again**.

Publication starts no provider calls. New assignments await the next project-wide sweep.
An unchanged preview cannot publish another revision.
If another operator changes the workspace, the API refuses the stale preview.

For a simple site, the project is the assignment target.
The server classifies its queries from the project identity.
Advanced assignments can carry an explicit operator classification.

## Edit or remove a query

1. Select Whole site, a property, a group, or a market.
2. Select **Edit** or **Remove** beside the query.
3. Review the selected scope and the proposed changes.
4. Select **Publish N changes** (**Confirm changes** on a simple site).

Whole site changes every assignment of that query. Other scopes change only their existing assignments.
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

Templates expand before publication. Each result retains its template version, bindings, and resolved query text.
Duplicate matching prefers the query ID that the active plan already uses.
Otherwise, matching uses normalized query text.
Shared execution contexts reuse one provider request across multiple property assignments.

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

Each population also carries `comparison`, its change since the previous eligible sweep.
That sweep is the whole-project sweep immediately before the selected run. Spot checks and probe runs never qualify.
The date window and a selected run do not limit it, so the previous sweep can predate the date window.
A change requires both sweeps to be complete, with a comparable definition and the same engines and models.
Otherwise `comparison.reason` names the cause, such as `partial-run` or `model-changed`.
Each available `delta` is the current rate minus the previous rate. An unavailable change is not a zero change.
When the previous sweep cannot be read, `comparison` is absent and the rest of the report still loads.

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

## Research and operator controls

**Research → Find queries** uses the existing ICP discovery process.
**Research → Test queries** starts with direct query entry.
An optional pattern repeats a query across explicit markets, properties, or configured locations.
Groups are not research destinations.
Neither process adds queries to official tracking automatically.
**Review for tracking** sends selected results through the same assignment preview.

### Repeat research across destinations

1. Select the repeat mode.
2. Select each destination explicitly.
3. Enter one query pattern per line, such as `Best apartments in {market}`.
4. Select the answer engine and model.
5. Open the preview.
6. Check each destination, resolved query, and location context.
7. Edit individual queries or location contexts as required.
8. Start the reviewed queries.

A pattern substitutes text. For Atlanta, `Best apartments in {market}` becomes `Best apartments in Atlanta`.
`{market}` and `{submarket}` use the market label. `{property}` and `{propertyBrand}` use the property label.
`{location}` uses the selected location label.
Unknown variables block the preview.

The destination does not set the answer engine's location context.
Each preview shows a configured location or **No location context** separately.
Location repetition uses the selected configured locations.
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
Commit input adds the returned `previewToken` and `reviewedAt` to that exact request.
The server binds the review time to the token and refuses expired reviews.
The API returns the actual active revision after publication.
On an advanced portfolio, a commit that changes anything returns `409 RUN_IN_PROGRESS` with `details.reason: sweep-in-progress` while a sweep is queued or running, including a long provider-batch sweep.
A simple basket returns the same code only when a catalog change meets a planless sweep.
The message names the run. Preview and commit the change again after it finishes (a review expires after 15 minutes), or stop it with `canonry run cancel <project> <run-id>`.
An all-locations sweep is several runs: the message then gives their count, `details.activeRunIds` lists them, and each one must finish or be cancelled.
Previews and no-op confirmations remain available during a sweep.
A setup publish (`draft-action` with `publish`) is refused the same way, unless it is identical to the active revision.
An advanced preview also returns `limits.queries`: distinct assigned queries now (`current`), after the change (`next`), and the limit (`max`, 1,000).
A commit that grows the plan past the limit returns `400` with `details.check: query-limit-exceeded`. A plan already over the limit may still shrink.
Preview and commit require write access. Stored workspace and visibility reads do not.

The project API prefix is `/api/v1/projects/:name`.
Its four endpoint suffixes are `/query-tracking`, `/query-tracking/preview`, `/query-tracking/commit`, and `/visibility-report`.

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

An answer is unattributable for a rate when it verifies a mention of none of that rate's Properties and leaves at least one of them unresolved. Mention coverage leaves it out of both the numerator and the denominator and reports how many answers it left out as `unattributed` beside the denominator (absent means none). The answer's own `mentioned` stays `null` with `mentionUnavailableReason: identity-ambiguous`; it is never counted as not mentioned. The rate is unavailable with reason `identity-ambiguous` only when no attributable answer remains. The visibility report, the Advanced Measurement overview and portfolio summary (as `unattributed` on the metric value), the revision report, the CLI apply the same rule. Every surface that shows the rate states the count beside it, including the Property page, the overview table and its engine rows, and the CLI engine rows: "12 of 1152 answers could not be tied to one property". A Property with left-out answers and no verified mention has an unknown mention outcome: Property outcomes count it as not measured, never as cited only or neither, matching Properties mentioned.

An answer is unchecked for a citation rate when it was saved but its source-link capture was incomplete. Citation coverage leaves it out of both the numerator and the denominator, even when it captured a link to the Property, and reports the count as `unchecked` beside the denominator (absent means none). Among saved answers, the rate is unavailable with reason `evidence-incomplete` only when every one is unchecked; a missing answer (no saved observation) still withholds the rate, as below. The trend chart notes that Cited counts only checked answers whenever a plotted point left some out. The visibility report (summary, Property, group and query rows, trend points, competitor citation coverage), the Advanced Measurement overview, portfolio summary, rankings and changes, and the revision report apply the same rule. Every surface that shows the rate states the count beside it, including the CLI Property line and engine rows: "2 of 1152 answers had sources that could not be checked". A Property with unchecked answers and no captured citation counts as not measured in Property outcomes, never as mentioned only or neither. Simple projects never report `unchecked`: their citation state comes from stored cited domains, not URL capture, so the rule does not apply.

`GET /projects/:name/visibility-report` exposes frozen coverage with separate query-class populations for Simple and Advanced Measurement. Its history window preserves comparison boundaries, and the latest summary retains its measurement date. The dedicated client and HTML Report surfaces are retired in [Canonry 7](report-retirement.md).

A saved positive citation remains visible in answer details even when source capture was incomplete, but citation coverage does not count it. Aggregate mention and citation coverage require a saved answer for every selected expected answer: a missing answer withholds the rate and never shrinks the denominator. To restore the rate, fill the run: `canonry run fill <run-id>` asks only the missing answers and saves them in the same run, so the rate returns without a new sweep. `canonry run completeness <run-id>` lists what is missing and whether a fill is allowed; a fill is refused once the run is more than 24 hours old, after the plan was republished, or once a newer sweep exists (full rules in the [CLI reference](../skills/canonry/references/canonry-cli.md)). An answer that was saved with no text is not missing, so a fill cannot replace it: it leaves mention coverage blank until the next sweep, while citation coverage still counts it when its source links were captured. A saved answer leaves a denominator in two cases only: unattributable answers leave mention coverage (`unattributed`), and unchecked answers leave citation coverage (`unchecked`). Provider and location filters narrow the expected population before completeness is evaluated. Property reach is existential: one verified occurrence establishes reach even when a different answer is uncertain.
