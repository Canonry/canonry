import { describe, it, expect } from 'vitest'
import {
  CheckStatuses,
  CheckScopes,
  CheckCategories,
  checkResultSchema,
  doctorReportSchema,
  summarizeCheckResults,
  type CheckResultDto,
} from '../src/doctor.js'

describe('CheckStatuses', () => {
  it('exposes the four statuses', () => {
    expect(CheckStatuses.ok).toBe('ok')
    expect(CheckStatuses.warn).toBe('warn')
    expect(CheckStatuses.fail).toBe('fail')
    expect(CheckStatuses.skipped).toBe('skipped')
  })
})

describe('CheckScopes', () => {
  it('exposes global and project scopes', () => {
    expect(CheckScopes.global).toBe('global')
    expect(CheckScopes.project).toBe('project')
  })
})

describe('CheckCategories', () => {
  it('exposes the documented categories', () => {
    expect(CheckCategories.auth).toBe('auth')
    expect(CheckCategories.config).toBe('config')
    expect(CheckCategories.providers).toBe('providers')
    expect(CheckCategories.integrations).toBe('integrations')
    expect(CheckCategories.database).toBe('database')
    expect(CheckCategories.schedules).toBe('schedules')
  })
})

describe('checkResultSchema', () => {
  it('parses a valid check result', () => {
    const result = checkResultSchema.parse({
      id: 'google.auth.connection',
      category: 'auth',
      scope: 'project',
      title: 'GSC OAuth connection',
      status: 'fail',
      code: 'google.auth.token-expired',
      summary: 'Refresh token rejected',
      remediation: 'Run `canonry google connect <project>`',
      details: { principal: 'alice@example.com' },
      durationMs: 42,
    })
    expect(result.code).toBe('google.auth.token-expired')
  })

  it('allows remediation to be null', () => {
    const result = checkResultSchema.parse({
      id: 'config.providers',
      category: 'providers',
      scope: 'global',
      title: 'Provider keys',
      status: 'ok',
      code: 'providers.configured',
      summary: '3 providers configured',
      remediation: null,
      durationMs: 1,
    })
    expect(result.remediation).toBeNull()
  })
})

describe('summarizeCheckResults', () => {
  it('counts each status', () => {
    const results: CheckResultDto[] = [
      { id: 'a', category: 'auth', scope: 'project', title: 'A', status: 'ok', code: 'ok', summary: '', durationMs: 1 },
      { id: 'b', category: 'auth', scope: 'project', title: 'B', status: 'fail', code: 'fail', summary: '', durationMs: 1 },
      { id: 'c', category: 'auth', scope: 'project', title: 'C', status: 'fail', code: 'fail', summary: '', durationMs: 1 },
      { id: 'd', category: 'auth', scope: 'project', title: 'D', status: 'warn', code: 'warn', summary: '', durationMs: 1 },
      { id: 'e', category: 'auth', scope: 'project', title: 'E', status: 'skipped', code: 'skipped', summary: '', durationMs: 1 },
    ]
    expect(summarizeCheckResults(results)).toEqual({ total: 5, ok: 1, warn: 1, fail: 2, skipped: 1 })
  })

  it('returns zeros for an empty list', () => {
    expect(summarizeCheckResults([])).toEqual({ total: 0, ok: 0, warn: 0, fail: 0, skipped: 0 })
  })
})

describe('doctorReportSchema', () => {
  it('parses a complete report', () => {
    const report = doctorReportSchema.parse({
      scope: 'project',
      project: 'demo',
      generatedAt: '2026-04-28T00:00:00.000Z',
      durationMs: 1234,
      summary: { total: 1, ok: 1, warn: 0, fail: 0, skipped: 0 },
      checks: [
        {
          id: 'google.auth.connection',
          category: 'auth',
          scope: 'project',
          title: 'GSC OAuth',
          status: 'ok',
          code: 'google.auth.connected',
          summary: 'Connected',
          durationMs: 12,
        },
      ],
    })
    expect(report.checks).toHaveLength(1)
  })
})
