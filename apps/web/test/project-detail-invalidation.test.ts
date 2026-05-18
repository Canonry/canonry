import { describe, it, expect } from 'vitest'
import { isProjectDetailQuery } from '../src/queries/mutations.js'

/**
 * Regression test for the project-page-stops-refreshing bug fixed in this
 * change. The `useAppendQueries` / `useDismissContentTarget` mutations use
 * `isProjectDetailQuery` to invalidate the composite dashboard cache after
 * a write. When `useProjectDashboard` was split out of the legacy
 * `useDashboard` hook, it changed its cache-key prefix from `'projects'`
 * to `'project-dashboard-full'` but the predicate wasn't updated — so
 * newly-added queries / competitors stayed invisible on the project page
 * until a 30-minute staleTime expired.
 *
 * Locking both prefixes in here so a future key rename can't silently
 * resurrect the same bug.
 */
describe('isProjectDetailQuery', () => {
  function q(key: readonly unknown[]) {
    return { queryKey: key }
  }

  it('matches the per-project dashboard key (current — useProjectDashboard)', () => {
    expect(isProjectDetailQuery(q(['project-dashboard-full', 'project-id', 'run-ids-key']))).toBe(true)
    expect(isProjectDetailQuery(q(['project-dashboard-full', null, 'none']))).toBe(true)
  })

  it('matches the legacy portfolio-wide key (useDashboard)', () => {
    expect(isProjectDetailQuery(q(['projects', 'project-id', 'run-ids-key']))).toBe(true)
  })

  it('does not match the slim portfolio overview (useDashboardOverview)', () => {
    // The overview row is invalidated separately by its consumers; we
    // don't want every query/competitor write to churn it.
    expect(isProjectDetailQuery(q(['project-overview-slim', 'project-id', 'cache-bust']))).toBe(false)
  })

  it('does not match generated SDK query keys (object head with `_id`)', () => {
    // The generated SDK uses `[{ _id: 'getApiV1...' }, ...]`. Mutations
    // that need to invalidate generated keys do so with their own
    // predicate; this one is for the hand-rolled tuple keys.
    expect(isProjectDetailQuery(q([{ _id: 'getApiV1ProjectsByName' }, { name: 'p' }]))).toBe(false)
  })

  it('does not match the top-level projects-list key', () => {
    // Just `'projects'` with no projectId tail is the legacy portfolio
    // list, not the per-project detail.
    expect(isProjectDetailQuery(q(['projects']))).toBe(false)
  })

  it('does not match unrelated tuple keys', () => {
    expect(isProjectDetailQuery(q(['runs', 'run-id']))).toBe(false)
    expect(isProjectDetailQuery(q(['something-else']))).toBe(false)
    expect(isProjectDetailQuery(q([]))).toBe(false)
  })
})
