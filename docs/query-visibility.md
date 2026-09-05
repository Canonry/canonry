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
**Research → Test queries** uses saved, bounded query batches.
Neither process adds queries to official tracking automatically.
**Review for tracking** sends selected results through the same assignment preview.

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

Preview input contains `expectedWorkspaceVersion`, `additions`, and `removals`.
Commit input adds the returned `previewToken` and `reviewedAt` to that exact request.
The server binds the review time to the token and refuses expired reviews.
The API returns the actual active revision after publication.
Preview and commit require write access. Stored workspace and visibility reads do not.

The project API prefix is `/api/v1/projects/:name`.
Its four endpoint suffixes are `/query-tracking`, `/query-tracking/preview`, `/query-tracking/commit`, and `/visibility-report`.
