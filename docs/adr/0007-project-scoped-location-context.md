# ADR 0007: Project-Scoped Location Context

## Status

Accepted and implemented.

## Decision

Keep locations project-scoped and use them as run context.

- A project may define zero or more named locations.
- A project may define one `defaultLocation`.
- A run may use the default location, an explicit location, all configured locations, or no location.
- Keywords remain project-wide and are not location-owned.

## Why

- The common workflow is "run this project from location X", not "bind this keyword permanently to location X".
- Project-scoped locations keep the CLI and API simple for agents and operators.
- Keyword-scoped locations create unnecessary fanout in scheduling, exports, diffs, and analytics.
- Canonry will likely need more context axes over time, such as persona, browser surface, and node identity. Location should behave like one reusable run context, not a special-case keyword property.

## Current Implementation

- Projects store `locations` and `defaultLocation`.
- Run creation accepts `location`, `allLocations`, and `noLocation`.
- The job runner resolves the effective location and forwards it to providers.
- Runs and query snapshots store the location label used for that run.
- Snapshot and timeline reads can be filtered by location.

## Consequences

- Location comparisons are run-context comparisons, not keyword-configuration comparisons.
- Deleting a project location does not require keyword reassignment because keywords do not reference locations directly.
- Historical snapshots currently store the location label, not the full immutable location object.
- If finer-grained targeting is needed later, add optional overrides or context profiles on top of the project-scoped model rather than rebuilding around keyword-owned locations.

## Explicit Non-Decision

Canonry does not treat locations as per-keyword state. A future need for keyword-level specialization should be additive and optional.
