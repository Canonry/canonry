import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduleDto } from '@canonry/canonry-contracts'

const mockGetSchedule = vi.fn()
const mockPutSchedule = vi.fn()
vi.mock('../src/client.js', () => ({
  createApiClient: () => ({ getSchedule: mockGetSchedule, putSchedule: mockPutSchedule }),
}))

const { invokeCli } = await import('./cli-test-utils.js')
const { printSchedule, setSchedule } = await import('../src/commands/schedule.js')

const scan: ScheduleDto = {
  id: 'schedule-1', projectId: 'project-1', kind: 'site-audit', cronExpr: '', preset: null,
  recurrence: { everyDays: 7, startDate: '2026-11-12', time: '07:00' },
  timezone: 'UTC', enabled: true, providers: [], sourceId: null,
  siteAudit: { checkDeadLinks: false, includeGeo: false, includeAgentSkills: true },
  lastRunAt: null, nextRunAt: '2026-11-12T07:00:00.000Z', createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
}

describe('schedule set: site-audit scan checks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSchedule.mockResolvedValue(scan)
    mockPutSchedule.mockImplementation(async (_project: string, body: Record<string, unknown>) => ({ ...scan, siteAudit: body.siteAudit ?? scan.siteAudit }))
  })

  it('turns on dead links and location checks without restating the timing', async () => {
    const result = await invokeCli(['schedule', 'set', 'demo', '--kind', 'site-audit', '--check-dead-links', '--include-geo', '--format', 'json'])
    expect(result.exitCode).toBeUndefined()
    const [, body] = mockPutSchedule.mock.calls[0]!
    expect(body).toMatchObject({
      kind: 'site-audit',
      recurrence: scan.recurrence,
      siteAudit: { checkDeadLinks: true, includeGeo: true, includeAgentSkills: true },
      expectedUpdatedAt: scan.updatedAt,
    })
  })

  it('resets to the default checks', async () => {
    await invokeCli(['schedule', 'set', 'demo', '--kind', 'site-audit', '--default-checks', '--format', 'json'])
    expect(mockPutSchedule.mock.calls[0]![1]).toMatchObject({ siteAudit: null })
  })

  it('refuses check flags on another kind, and a reset mixed with check flags', async () => {
    const wrongKind = await invokeCli(['schedule', 'set', 'demo', '--kind', 'data-refresh', '--preset', 'daily', '--check-dead-links'])
    expect(wrongKind.exitCode).toBe(1)
    expect(wrongKind.stderr).toMatch(/--kind site-audit/)
    const mixed = await invokeCli(['schedule', 'set', 'demo', '--kind', 'site-audit', '--check-dead-links', '--default-checks'])
    expect(mixed.exitCode).toBe(1)
    expect(mockPutSchedule).not.toHaveBeenCalled()
  })

  it('leaves the checks out of the request when only the timing changes, so the server keeps them', async () => {
    await setSchedule('demo', { kind: 'site-audit', everyDays: '7', startDate: '2026-11-13', at: '09:00' })
    expect(mockPutSchedule.mock.calls[0]![1]).not.toHaveProperty('siteAudit')
  })

  it('prints what each scheduled scan checks', () => {
    const lines: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line) })
    printSchedule({ ...scan, siteAudit: { checkDeadLinks: true, includeGeo: true, includeAgentSkills: true } })
    log.mockRestore()
    expect(lines).toContain('  Checks:    full site, dead links, location, agent checks')
  })
})
