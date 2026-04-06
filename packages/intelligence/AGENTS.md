# intelligence

## Purpose

Pure analysis library for computing intelligence insights from run data. Takes run snapshots as input and produces regression/gain/opportunity insights plus health metrics. No database access, no side effects — pure functions only.

## Key Files

| File | Role |
|------|------|
| `src/analyzer.ts` | `analyzeRuns()` — main entry point, orchestrates all analysis |
| `src/regressions.ts` | Detects keywords that lost citation between runs |
| `src/gains.ts` | Detects keywords that gained citation between runs |
| `src/health.ts` | Computes overall and per-provider citation health metrics |
| `src/causes.ts` | Root cause analysis for regressions (competitor displacement, etc.) |
| `src/insights.ts` | Transforms raw analysis into user-facing insight objects |
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
