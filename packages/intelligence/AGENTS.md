# intelligence

## Purpose

Pure analysis library for computing intelligence insights from run data. Takes run snapshots as input and produces regression/gain/opportunity insights plus health metrics. No database access, no side effects — pure functions only.

## Key Files

| File | Role |
|------|------|
| `src/analyzer.ts` | `analyzeRuns()` — main entry point, orchestrates all analysis |
| `src/regressions.ts` | Detects queries that lost citation between runs |
| `src/gains.ts` | Detects queries that gained citation between runs |
| `src/health.ts` | Computes overall and per-provider citation health metrics |
| `src/causes.ts` | Root cause analysis for regressions (competitor displacement, etc.) |
| `src/insights.ts` | Transforms raw analysis into user-facing insight objects |
| `src/observation-coverage.ts` | `observedKeys(run, keyOf)` — what a run actually measured, so a missing snapshot row is never read as "not cited". See "Absence is not a negative observation" below. |
| `src/insight-severity.ts` | `classifyRegressionSeverity({ gscImpressions, recurrenceCount })` — pure tiering rule. Caller supplies the signals (lookups happen in `IntelligenceService`); rule lives here so the dashboard, CLI, and Aero classify identically. |
| `src/query-categorize.ts` | `buildBrandTokens()` + `categorizeQueryByIntent()` — brand/lead-gen/industry/other classifier. Uses contracts' exact approved-alias matcher across spacing/hyphenation variants; suffix stripping and fuzzy/edit-distance attribution are forbidden. |
| `src/competitor-landscape-history.ts` | Stored-evidence competitor aggregation. Global pins intentionally reinterpret history; competitors frozen only in an old Advanced revision match answer text only in snapshots from that revision. Stored classifications retain exact-host identity until deterministic registrable-domain aggregation. |
| `src/types.ts` | Shared types: `RunData`, `Snapshot`, `AnalysisResult`, `Insight` |
| `src/index.ts` | Barrel re-export of all modules |

## Patterns

### Usage

```typescript
import { analyzeRuns } from '@ainyc/canonry-intelligence'
import type { RunData, AnalysisResult } from '@ainyc/canonry-intelligence'

const result: AnalysisResult = analyzeRuns(currentRun, previousRun)
// result.regressions, result.gains, result.health, result.insights
```

### Design principles

- **No I/O**: This package never touches the database, network, or filesystem. Callers provide `RunData`, receive `AnalysisResult`.
- **Deterministic**: Same inputs always produce the same outputs. No randomness, no timestamps.
- **Consumed by**: `IntelligenceService` in `packages/canonry/` which handles DB reads/writes.

### Absence is not a negative observation (Critical)

`RunData.snapshots` records what a run OBSERVED, not what is true. A provider
call that throws writes no snapshot row at all — that is what `status='partial'`
means — so a sweep can be missing whole (query × provider) pairs. **A missing
row must never be read as "not cited".**

Any detector that claims a TRANSITION ("started being cited", "dropped off")
has to confirm the relevant side observed the thing before claiming it moved.
Use `observedKeys(run, keyOf)` from `observation-coverage.ts`, keyed the same
way that detector keys its cited set. Which side depends on which direction the
claim runs: a GAIN or pickup is claimed from absence in the baseline, so the
baseline must have observed it; a LOSS is claimed from absence in the current
run, so the current run must have.

Measured against a baseline sweep where one provider errored, skipping this
produced 6 false insights for a site where nothing had changed.

`detectRegressions` and `detectPersistentGaps` are correct by construction —
the first iterates the current run's rows and requires a prior CITED
observation, the second breaks a streak on any run missing the query.
`packages/intelligence/test/observation-coverage.test.ts` covers every detector
in both directions: the hole is suppressed AND the real transition still fires.
Add a new detector to that suite.

## See Also

- `packages/canonry/src/intelligence-service.ts` — DB integration layer that calls `analyzeRuns()`
- `packages/contracts/src/intelligence.ts` — DTOs for API/CLI consumers (`InsightDto`, `HealthSnapshotDto`)
