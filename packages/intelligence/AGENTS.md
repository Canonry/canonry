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
| `src/insight-severity.ts` | `classifyRegressionSeverity({ gscImpressions, recurrenceCount })` — pure tiering rule. Caller supplies the signals (lookups happen in `IntelligenceService`); rule lives here so the dashboard, CLI, and Aero classify identically. |
| `src/insight-grouping.ts` | `groupInsights<T>(insights, keyFn?)` — generic dedup over `(query, provider, type)`. Consumed by report renderer + any future CLI/dashboard list view to collapse repeat alerts. |
| `src/next-steps.ts` | `mapOpportunitiesToNextSteps()` — auto-fills `recommendedNextSteps` from scored content opportunities when the upstream insight-driven builder produced none. Pure mapper consumed by both `api-routes/report.ts` and `canonry/report-renderer.ts`. |
| `src/query-categorize.ts` | `buildBrandTokens()` + `categorizeQueryByIntent()` — brand/lead-gen/industry/other classifier. Compact-token brand matching handles spacing/hyphenation variants ("demand iq" / "demandiq" / "demand-iq" all match `demand-iq.com`). Replaces the regex-only categorizer that lived in `report.ts`. |
| `src/trend-stability.ts` | `isTrendBaseline(points)` + `MIN_TREND_POINTS` — predicate any consumer (renderer, dashboard tile, Aero) calls before showing a trend chart. Suppresses misleading visualizations on small samples. |
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

## See Also

- `packages/canonry/src/intelligence-service.ts` — DB integration layer that calls `analyzeRuns()`
- `packages/contracts/src/intelligence.ts` — DTOs for API/CLI consumers (`InsightDto`, `HealthSnapshotDto`)
