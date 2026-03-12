# Optimize AI Provider Calls

## Context

Each visibility run queries every keyword against every provider (e.g., 50 keywords × 3 providers = 150 API calls). There's no caching, so scheduled runs re-query everything even if results haven't changed. Default models are expensive (claude-sonnet-4-6, gpt-4o). Combined, this makes monitoring costly for users with many keywords.

## Plan

### Step 1: Cheaper Default Models (trivial, ~60-70% cost reduction per query)

- `packages/provider-claude/src/normalize.ts:12` — change `DEFAULT_MODEL` from `'claude-sonnet-4-6'` to `'claude-haiku-4-5'`
- `packages/provider-openai/src/normalize.ts:11` — change `DEFAULT_MODEL` from `'gpt-4o'` to `'gpt-4o-mini'`
- Users who already configured a model via settings are unaffected

### Step 2: Claude Parameter Tuning (trivial, ~15-20% additional savings on Claude)

- `packages/provider-claude/src/normalize.ts:60` — reduce `max_tokens` from `4096` to `1024` (citation detection doesn't need long answers)
- `packages/provider-claude/src/normalize.ts:65` — reduce `max_uses` from `5` to `3` (3 web searches is sufficient for a single keyword)

### Step 3: Snapshot Caching with TTL (moderate effort, 75-90% reduction on scheduled runs)

Skip API calls when a recent snapshot exists for the same keyword+provider.

**3a. Add `cacheTtlHours` to config**
- `packages/canonry/src/config.ts` — add `cacheTtlHours?: number` to `CanonryConfig` (default: 6)

**3b. Add `forceRefresh` to API**
- `packages/api-routes/src/runs.ts:16` — add `forceRefresh?: boolean` to Body type
- `packages/api-routes/src/runs.ts:9` — add `forceRefresh` to `onRunCreated` callback signature
- Thread `forceRefresh` through `onRunCreated` calls in `packages/canonry/src/server.ts`

**3c. Add `--force` flag to CLI**
- `packages/canonry/src/commands/run.ts` — pass `forceRefresh: true` when `--force` is set

**3d. Cache logic in JobRunner** (`packages/canonry/src/job-runner.ts`)
- Add `opts?: { forceRefresh?: boolean; cacheTtlHours?: number }` to `executeRun`
- Before each provider call, query `querySnapshots` for same `(keywordId, provider)` where `createdAt >= cutoff`
- If cached: clone snapshot with new `runId`, skip API call
- Track actual API calls per provider (not total keywords) for accurate usage counters

**3e. Add composite DB index**
- `packages/db/src/schema.ts` — add `index('idx_snapshots_kw_provider_created').on(table.keywordId, table.provider, table.createdAt)` to `querySnapshots`

**3f. UI force-refresh option**
- Add a "Force refresh" option to the Run button on the project detail page in `apps/web/`

### Step 4: Concurrent Keyword Processing (moderate effort, ~60-70% wall-time reduction)

Keywords are currently processed sequentially. Process N keywords concurrently.

- `packages/canonry/src/job-runner.ts` — replace sequential `for` loop with concurrency-limited pool
- Add `keywordConcurrency?: number` to `CanonryConfig` (default: 3)
- Implement a lightweight `withConcurrencyLimit` helper (no external deps)
- Rate limiter already uses shared per-provider sliding windows, so concurrent access is safe

### Step 5: OpenAI Prompt Trim (trivial, marginal savings)

- `packages/provider-openai/src/normalize.ts:91` — change `buildPrompt` to just return `keyword` (matches Gemini approach). `tool_choice: 'required'` already forces web search.

### Version Bump

- Bump both `package.json` and `packages/canonry/package.json` (minor version — new features: cache TTL, force refresh, concurrency config)

## Verification

1. `pnpm run typecheck` — ensure no type errors
2. `pnpm run test` — existing tests pass
3. `pnpm run lint` — no lint issues
4. Manual: trigger a run, verify snapshots created. Trigger another run within TTL, verify cached results used (check logs for "cached" messages). Trigger with `--force`, verify fresh API calls.
5. Manual: verify usage counters only count actual API calls, not cached results

## Key Files
- `packages/canonry/src/job-runner.ts` — core orchestration (cache, concurrency)
- `packages/canonry/src/config.ts` — config types
- `packages/canonry/src/server.ts` — threading forceRefresh
- `packages/provider-claude/src/normalize.ts` — model + param changes
- `packages/provider-openai/src/normalize.ts` — model + prompt changes
- `packages/api-routes/src/runs.ts` — forceRefresh API param
- `packages/db/src/schema.ts` — cache index
