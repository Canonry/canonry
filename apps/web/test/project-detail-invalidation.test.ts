import { describe, it, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { isProjectDetailQuery } from '../src/queries/mutations.js'
import { patchProjectDashboardCache } from '../src/pages/ProjectPage.js'
import type { ApiProject } from '../src/api.js'

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

/**
 * Regression test for the cross-project cache corruption in
 * `handleUpdateProject`: the detail-cache patch matched on the key head
 * (`'project-dashboard-full'`) alone, so saving project A's engine settings
 * overwrote the cached `.project` of every OTHER project that had been
 * visited this session. `useProjectDashboard` builds `commandCenter` from
 * that entry, so project B's settings screen then rendered project A — and
 * the form saved to A.
 */
describe('patchProjectDashboardCache', () => {
  function project(id: string, name: string, providerModels: Record<string, string> = {}): ApiProject {
    return {
      id,
      name,
      displayName: name,
      canonicalDomain: `${name}.com`,
      ownedDomains: [],
      aliases: [],
      country: 'US',
      language: 'en',
      tags: [],
      labels: {},
      providers: ['openai'],
      providerModels,
      locations: [],
      defaultLocation: null,
      autoExtractBacklinks: false,
      configSource: 'cli',
      configRevision: 1,
    } as unknown as ApiProject
  }

  function seed(queryClient: QueryClient, p: ApiProject, runIdsKey = 'run-1') {
    queryClient.setQueryData(['project-dashboard-full', p.id, runIdsKey], { project: p, queries: [] })
  }

  function cached(queryClient: QueryClient, projectId: string, runIdsKey = 'run-1') {
    return queryClient.getQueryData<{ project: ApiProject }>(['project-dashboard-full', projectId, runIdsKey])
  }

  it('patches only the edited project and leaves other projects untouched', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const a = project('id-a', 'client-a')
    const b = project('id-b', 'client-b')
    seed(queryClient, a)
    seed(queryClient, b)

    const savedA = project('id-a', 'client-a', { openai: 'gpt-5' })
    patchProjectDashboardCache(queryClient, savedA)

    expect(cached(queryClient, 'id-a')?.project.providerModels).toEqual({ openai: 'gpt-5' })
    // The whole point: B still holds B, not A.
    expect(cached(queryClient, 'id-b')?.project).toBe(b)
    expect(cached(queryClient, 'id-b')?.project.id).toBe('id-b')
    expect(cached(queryClient, 'id-b')?.project.providerModels).toEqual({})

    queryClient.clear()
  })

  it('patches every run-ids revision of the edited project', () => {
    // A project accumulates one detail entry per completed-sweep revision;
    // all of them are the same project and all must pick up the save.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const a = project('id-a', 'client-a')
    seed(queryClient, a, 'run-1')
    seed(queryClient, a, 'run-2')

    patchProjectDashboardCache(queryClient, project('id-a', 'client-a', { openai: 'gpt-5' }))

    expect(cached(queryClient, 'id-a', 'run-1')?.project.providerModels).toEqual({ openai: 'gpt-5' })
    expect(cached(queryClient, 'id-a', 'run-2')?.project.providerModels).toEqual({ openai: 'gpt-5' })

    queryClient.clear()
  })

  it('leaves non-dashboard cache entries and shapes without a `project` field alone', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const a = project('id-a', 'client-a')
    // Same id in the tail position, different head — must not match.
    queryClient.setQueryData(['project-overview-slim', 'id-a', 'run-1'], { project: a })
    queryClient.setQueryData(['project-dashboard-full', 'id-a', 'none'], { queries: [] })

    patchProjectDashboardCache(queryClient, project('id-a', 'client-a', { openai: 'gpt-5' }))

    expect(queryClient.getQueryData<{ project: ApiProject }>(['project-overview-slim', 'id-a', 'run-1'])?.project).toBe(a)
    expect(queryClient.getQueryData(['project-dashboard-full', 'id-a', 'none'])).toEqual({ queries: [] })

    queryClient.clear()
  })
})
