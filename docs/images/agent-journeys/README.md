# Journeys review evidence

Synthetic fixtures, rendered from the real `JourneysSection` with the dashboard's
compiled stylesheet. No client traffic or provider calls.

| View | Image |
| --- | --- |
| Visitors: list, selected visitor's visits in time order, second visit open | [visitors-desktop.png](visitors-desktop.png) |
| Agent requests: trust per sequence, likely fake count, one sequence expanded with its trust reasons | [agent-requests-desktop.png](agent-requests-desktop.png) |

The Journeys tab sits with the other project tabs. Visits read left to right
in time order; the marker shape and its label carry the entry class, `//` marks
a new day, and requests that are not GET or HEAD are printed as recorded. The
visit table shows pages and non-GET requests from the API's `events=pages`
filter, with every request one click away.

Agent requests show each sequence's trust level: Verified (IP on the company's
published list), Likely real or Unknown. Likely fake requests are never listed;
the API's count sits beside the totals with an explanation in its tooltip.
