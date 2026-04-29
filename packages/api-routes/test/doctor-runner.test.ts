import { describe, it, expect } from 'vitest'
import { CheckCategories, CheckScopes, CheckStatuses } from '@ainyc/canonry-contracts'
import { runChecks, matchesCheckId } from '../src/doctor/runner.js'
import type { CheckDefinition, DoctorContext } from '../src/doctor/types.js'

const fakeCtx = (project?: { name: string; canonicalDomain: string }): DoctorContext => ({
  db: {} as DoctorContext['db'],
  project: project ? { id: 'p1', name: project.name, canonicalDomain: project.canonicalDomain, displayName: project.name } : null,
})

const okCheck = (id: string, scope: 'global' | 'project'): CheckDefinition => ({
  id,
  category: CheckCategories.config,
  scope: scope === 'global' ? CheckScopes.global : CheckScopes.project,
  title: id,
  run: () => ({ status: CheckStatuses.ok, code: `${id}.ok`, summary: 'fine' }),
})

const failCheck = (id: string, scope: 'global' | 'project'): CheckDefinition => ({
  id,
  category: CheckCategories.auth,
  scope: scope === 'global' ? CheckScopes.global : CheckScopes.project,
  title: id,
  run: () => ({ status: CheckStatuses.fail, code: `${id}.broken`, summary: 'broken', remediation: 'fix it' }),
})

describe('matchesCheckId', () => {
  it('matches exact ids', () => {
    expect(matchesCheckId('google.auth.connection', ['google.auth.connection'])).toBe(true)
    expect(matchesCheckId('google.auth.connection', ['ga.auth.connection'])).toBe(false)
  })

  it('matches wildcard prefix', () => {
    expect(matchesCheckId('google.auth.connection', ['google.*'])).toBe(true)
    expect(matchesCheckId('google.auth.connection', ['google.auth.*'])).toBe(true)
    expect(matchesCheckId('ga.auth.connection', ['google.*'])).toBe(false)
  })

  it('matches when filters list is empty', () => {
    expect(matchesCheckId('anything', [])).toBe(true)
  })

  it('matches if any filter matches', () => {
    expect(matchesCheckId('google.auth.connection', ['ga.*', 'google.auth.*'])).toBe(true)
  })
})

describe('runChecks', () => {
  it('runs only project-scoped checks when ctx has a project', async () => {
    const checks = [okCheck('a', 'global'), okCheck('b', 'project'), failCheck('c', 'project')]
    const report = await runChecks(fakeCtx({ name: 'demo', canonicalDomain: 'example.com' }), checks)
    expect(report.scope).toBe('project')
    expect(report.project).toBe('demo')
    expect(report.checks.map(c => c.id)).toEqual(['b', 'c'])
    expect(report.summary).toMatchObject({ total: 2, ok: 1, fail: 1 })
  })

  it('runs only global-scoped checks when ctx has no project', async () => {
    const checks = [okCheck('a', 'global'), okCheck('b', 'project')]
    const report = await runChecks(fakeCtx(), checks)
    expect(report.scope).toBe('global')
    expect(report.project).toBeNull()
    expect(report.checks.map(c => c.id)).toEqual(['a'])
  })

  it('filters by check id', async () => {
    const checks = [okCheck('google.auth.connection', 'project'), okCheck('ga.auth.connection', 'project'), okCheck('config.providers', 'project')]
    const report = await runChecks(fakeCtx({ name: 'demo', canonicalDomain: 'example.com' }), checks, { checkIds: ['google.*'] })
    expect(report.checks.map(c => c.id)).toEqual(['google.auth.connection'])
  })

  it('captures runtime errors as fail with runtime-error code', async () => {
    const broken: CheckDefinition = {
      id: 'broken',
      category: CheckCategories.config,
      scope: CheckScopes.project,
      title: 'broken',
      run: () => { throw new Error('boom') },
    }
    const report = await runChecks(fakeCtx({ name: 'demo', canonicalDomain: 'example.com' }), [broken])
    expect(report.checks).toHaveLength(1)
    expect(report.checks[0]!.status).toBe('fail')
    expect(report.checks[0]!.code).toBe('broken.runtime-error')
    expect(report.checks[0]!.details).toMatchObject({ error: 'boom' })
  })

  it('measures durationMs per check and overall', async () => {
    const slow: CheckDefinition = {
      id: 'slow',
      category: CheckCategories.config,
      scope: CheckScopes.global,
      title: 'slow',
      run: async () => {
        await new Promise(resolve => setTimeout(resolve, 20))
        return { status: CheckStatuses.ok, code: 'slow.ok', summary: 'done' }
      },
    }
    const report = await runChecks(fakeCtx(), [slow])
    expect(report.checks[0]!.durationMs).toBeGreaterThanOrEqual(15)
    // Outer measurement is wall-clock from before the loop until after; it
    // cannot be smaller than the per-check value (which uses Date.now too).
    expect(report.durationMs).toBeGreaterThanOrEqual(report.checks[0]!.durationMs - 1)
  })
})
