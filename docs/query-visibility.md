# Query control and AI visibility

Queries controls future measurement. AI Visibility explains stored results.
Both surfaces use the same API contracts as the CLI and MCP.

## Assign queries

1. Open the project's **Queries** tab.
2. Select **Add query** or open an existing query's assignments.
3. Enter a query, select a template, or select a saved research result.
4. Select the properties, groups, or markets for the query.
5. For new group or property assignments, select a search location and engines. A market uses its frozen context.
6. Select **Review changes**.
7. Check the resolved queries, assignments, and next-sweep workload.
8. Select **Confirm changes**.

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
4. Select **Confirm changes**.

Whole site changes every assignment of that query. Other scopes change only their existing assignments.
An edit preserves the stored engines, models, locations, and unrelated market assignments.
A scoped text edit creates or reuses the new question. Other properties keep the original question and its measured history.
An unchanged edit publishes no revision. Editing a resolved template question does not expand the template again.

The editor preserves existing classifications by default. **Automatic** asks the server to classify the selected assignments again.
An exact assignment can belong to several markets. The API refuses a classification change that also changes an unselected market.
New assignments use **Add query**, not **Edit**.

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
Viewers with Research access can reuse patterns, but cannot save patterns or change tracking.

A reviewed batch contains at most 20 destination runs and 50 total query executions.
Two queries across three destinations produce six executions.
The API saves all destination runs together or saves none.
The existing runner processes each saved run independently, so individual results can fail.
Every destination run counts toward the viewer's daily limit.
Retries with the unchanged request and key return the same saved runs.

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
Commit input adds the returned `previewToken` and `reviewedAt` to that exact request.
The server binds the review time to the token and refuses expired reviews.
The API returns the actual active revision after publication.
A catalog change returns `409 RUN_IN_PROGRESS` while a queued or running sweep still uses the live query catalog.
Retry the reviewed change after that sweep finishes. No-op confirmations and plan-only edits remain available.
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
