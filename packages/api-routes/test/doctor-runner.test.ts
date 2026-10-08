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

  describe('supersededBy', () => {
    const project = { name: 'demo', canonicalDomain: 'example.com' }
    const cause = (status: 'ok' | 'warn' | 'fail'): CheckDefinition => ({
      id: 'demo.auth.connection',
      category: CheckCategories.auth,
      scope: CheckScopes.project,
      title: 'cause',
      run: () => ({ status: CheckStatuses[status], code: `demo.auth.${status}`, summary: 'grant revoked', remediation: 'reconnect' }),
    })
    const symptom = (run: CheckDefinition['run'] = () => ({
      status: CheckStatuses.fail, code: 'demo.sync.repeated-failures', summary: 'The last 3 syncs failed.', remediation: 'fix the cause', details: { consecutiveFailures: 3 },
    })): CheckDefinition => ({
      id: 'demo.sync.recent-failures',
      category: CheckCategories.integrations,
      scope: CheckScopes.project,
      title: 'symptom',
      supersededBy: ['demo.auth.connection'],
      run,
    })

    it('reports a failing symptom as superseded while its cause fails, keeping what it found', async () => {
      // Listed before its cause: supersession is decided after every check ran.
      const report = await runChecks(fakeCtx(project), [symptom(), cause('fail')])

      expect(report.checks.map(check => [check.id, check.status, check.code])).toEqual([
        ['demo.sync.recent-failures', 'skipped', 'demo.sync.recent-failures.superseded'],
        ['demo.auth.connection', 'fail', 'demo.auth.fail'],
      ])
      expect(report.checks[0]).toMatchObject({
        summary: 'Superseded by failing demo.auth.connection, which names the cause. The last 3 syncs failed.',
        remediation: null,
        details: { consecutiveFailures: 3, supersededBy: ['demo.auth.connection'], supersededStatus: 'fail', supersededCode: 'demo.sync.repeated-failures' },
      })
      expect(report.summary).toMatchObject({ total: 2, fail: 1, skipped: 1 })
    })

    it('keeps the symptom failing when its cause passes, only warns, or is not in the pass', async () => {
      for (const status of ['ok', 'warn'] as const) {
        const report = await runChecks(fakeCtx(project), [cause(status), symptom()])
        expect(report.checks[1]).toMatchObject({ status: 'fail', code: 'demo.sync.repeated-failures', remediation: 'fix the cause' })
      }
      const filtered = await runChecks(fakeCtx(project), [cause('fail'), symptom()], { checkIds: ['demo.sync.*'] })
      expect(filtered.checks).toEqual([expect.objectContaining({ status: 'fail', code: 'demo.sync.repeated-failures' })])
    })

    it('keeps the symptom failing when its cause threw or could not reach its provider', async () => {
      // Neither tested what the cause checks, so the symptom's own error is
      // the better evidence and must stay in the alert.
      const threwCause: CheckDefinition = { ...cause('fail'), run: () => { throw new Error('boom') } }
      const threw = await runChecks(fakeCtx(project), [threwCause, symptom()])
      expect(threw.checks.map(check => [check.id, check.status, check.code])).toEqual([
        ['demo.auth.connection', 'fail', 'demo.auth.connection.runtime-error'],
        ['demo.sync.recent-failures', 'fail', 'demo.sync.repeated-failures'],
      ])

      const unreachableCause: CheckDefinition = {
        ...cause('fail'),
        run: () => ({ status: CheckStatuses.fail, code: 'demo.auth.refresh-unreachable', summary: 'Could not reach the provider: fetch failed (ENOTFOUND resolving api.example.com)' }),
      }
      const unreachable = await runChecks(fakeCtx(project), [unreachableCause, symptom()])
      expect(unreachable.checks[1]).toMatchObject({ status: 'fail', code: 'demo.sync.repeated-failures', remediation: 'fix the cause' })
      expect(unreachable.summary).toMatchObject({ fail: 2, skipped: 0 })
    })

    it('leaves a passing symptom and a symptom check that threw as they are', async () => {
      const passing = await runChecks(fakeCtx(project), [cause('fail'), symptom(() => ({ status: CheckStatuses.ok, code: 'demo.sync.ok', summary: 'fine' }))])
      expect(passing.checks[1]).toMatchObject({ status: 'ok', code: 'demo.sync.ok' })

      const threw = await runChecks(fakeCtx(project), [cause('fail'), symptom(() => { throw new Error('boom') })])
      expect(threw.checks[1]).toMatchObject({ status: 'fail', code: 'demo.sync.recent-failures.runtime-error' })
    })
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
