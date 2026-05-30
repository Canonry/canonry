import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { DoctorReportDto } from '@ainyc/canonry-contracts'
import { CliError } from '../src/cli-error.js'

const mockRunDoctor = vi.fn()
const mockListProjects = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    runDoctor: mockRunDoctor,
    listProjects: mockListProjects,
  }),
}))

/** Capture `process.stdout.write` (the jsonl path) rather than console.log. */
function captureStdout(fn: () => Promise<void>): { run: Promise<void>; lines: () => string[] } {
  let buf = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    buf += String(chunk)
    return true
  })
  const run = fn().finally(() => spy.mockRestore())
  return { run, lines: () => buf.split('\n').filter(Boolean) }
}

const { doctorCommand } = await import('../src/commands/doctor.js')

const okReport: DoctorReportDto = {
  scope: 'project',
  project: 'demo',
  generatedAt: '2026-04-28T00:00:00.000Z',
  durationMs: 5,
  summary: { total: 1, ok: 1, warn: 0, fail: 0, skipped: 0 },
  checks: [
    {
      id: 'google.auth.connection',
      category: 'auth',
      scope: 'project',
      title: 'GSC OAuth connection',
      status: 'ok',
      code: 'google.auth.connected',
      summary: 'Connected',
      remediation: null,
      durationMs: 3,
    },
  ],
}

const failingReport: DoctorReportDto = {
  scope: 'project',
  project: 'demo',
  generatedAt: '2026-04-28T00:00:00.000Z',
  durationMs: 10,
  summary: { total: 2, ok: 0, warn: 0, fail: 2, skipped: 0 },
  checks: [
    {
      id: 'google.auth.connection',
      category: 'auth',
      scope: 'project',
      title: 'GSC OAuth connection',
      status: 'fail',
      code: 'google.auth.refresh-failed',
      summary: 'Refresh token rejected',
      remediation: 'Run `canonry google connect demo --type gsc`',
      details: { error: 'invalid_grant' },
      durationMs: 7,
    },
    {
      id: 'google.auth.property-access',
      category: 'auth',
      scope: 'project',
      title: 'GSC property access',
      status: 'fail',
      code: 'google.auth.property-not-accessible',
      summary: 'Selected property is not accessible',
      remediation: 'Re-select the property',
      durationMs: 3,
    },
  ],
}

describe('doctorCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('forwards project + check filters to the client', async () => {
    mockRunDoctor.mockResolvedValue(okReport)
    await doctorCommand({ project: 'demo', checks: ['google.*'], format: 'json' })
    expect(mockRunDoctor).toHaveBeenCalledWith({ project: 'demo', checkIds: ['google.*'] })
  })

  it('prints JSON when format=json and exits 0 on ok', async () => {
    mockRunDoctor.mockResolvedValue(okReport)
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await doctorCommand({ project: 'demo', format: 'json' })
    } finally {
      console.log = origLog
    }
    expect(JSON.parse(logs.join(''))).toEqual(okReport)
  })

  it('prints a human report and exits with CliError when any check fails', async () => {
    mockRunDoctor.mockResolvedValue(failingReport)
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await expect(doctorCommand({ project: 'demo' })).rejects.toBeInstanceOf(CliError)
    } finally {
      console.log = origLog
    }
    const text = logs.join('\n')
    expect(text).toContain('canonry doctor — project "demo"')
    expect(text).toContain('[fail] google.auth.connection')
    expect(text).toContain('Refresh token rejected')
    expect(text).toContain('canonry google connect demo --type gsc')
  })

  it('CliError carries the failing check ids in details', async () => {
    mockRunDoctor.mockResolvedValue(failingReport)
    const origLog = console.log
    console.log = () => undefined
    try {
      await expect(doctorCommand({ project: 'demo' })).rejects.toMatchObject({
        code: 'DOCTOR_CHECKS_FAILED',
        exitCode: 1,
        details: {
          scope: 'project',
          project: 'demo',
          failed: ['google.auth.connection', 'google.auth.property-access'],
        },
      })
    } finally {
      console.log = origLog
    }
  })

  it('runs global doctor when no project given', async () => {
    const globalReport: DoctorReportDto = {
      scope: 'global',
      project: null,
      generatedAt: '2026-04-28T00:00:00.000Z',
      durationMs: 1,
      summary: { total: 1, ok: 1, warn: 0, fail: 0, skipped: 0 },
      checks: [
        {
          id: 'config.providers',
          category: 'providers',
          scope: 'global',
          title: 'Provider keys',
          status: 'ok',
          code: 'providers.configured',
          summary: '2 of 4 providers configured',
          durationMs: 1,
        },
      ],
    }
    mockRunDoctor.mockResolvedValue(globalReport)
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await doctorCommand({})
    } finally {
      console.log = origLog
    }
    expect(mockRunDoctor).toHaveBeenCalledWith({ project: undefined, checkIds: undefined })
    expect(logs.join('\n')).toContain('canonry doctor — global')
  })

  it('format=jsonl emits one self-contained check per line — no envelope to unwrap', async () => {
    mockRunDoctor.mockResolvedValue(okReport)
    const cap = captureStdout(() => doctorCommand({ project: 'demo', format: 'jsonl' }))
    await cap.run
    const lines = cap.lines()
    expect(lines).toHaveLength(1)
    // Each line parses on its own — the agent never guesses `.checks`/`.results`.
    const record = JSON.parse(lines[0]!)
    expect(record).toMatchObject({
      project: 'demo',
      id: 'google.auth.connection',
      status: 'ok',
      summary: 'Connected',
    })
  })

  it('format=jsonl tags each line with project=null for global scope', async () => {
    const globalReport: DoctorReportDto = {
      scope: 'global',
      project: null,
      generatedAt: '2026-04-28T00:00:00.000Z',
      durationMs: 1,
      summary: { total: 1, ok: 1, warn: 0, fail: 0, skipped: 0 },
      checks: [
        {
          id: 'config.providers',
          category: 'providers',
          scope: 'global',
          title: 'Provider keys',
          status: 'ok',
          code: 'providers.configured',
          summary: '2 of 4 providers configured',
          durationMs: 1,
        },
      ],
    }
    mockRunDoctor.mockResolvedValue(globalReport)
    const cap = captureStdout(() => doctorCommand({ format: 'jsonl' }))
    await cap.run
    expect(JSON.parse(cap.lines()[0]!)).toMatchObject({ project: null, id: 'config.providers' })
  })

  it('format=jsonl emits every check line, then still throws on failures (exit code preserved)', async () => {
    mockRunDoctor.mockResolvedValue(failingReport)
    const cap = captureStdout(() => doctorCommand({ project: 'demo', format: 'jsonl' }))
    await expect(cap.run).rejects.toMatchObject({ code: 'DOCTOR_CHECKS_FAILED', exitCode: 1 })
    const records = cap.lines().map(l => JSON.parse(l))
    expect(records).toHaveLength(2)
    expect(records.map(r => r.id)).toEqual(['google.auth.connection', 'google.auth.property-access'])
    expect(records.every(r => r.project === 'demo')).toBe(true)
  })

  it('--all --format jsonl flattens global + per-project checks with a project discriminator', async () => {
    const globalReport: DoctorReportDto = {
      scope: 'global',
      project: null,
      generatedAt: '2026-04-28T00:00:00.000Z',
      durationMs: 1,
      summary: { total: 1, ok: 1, warn: 0, fail: 0, skipped: 0 },
      checks: [
        {
          id: 'config.providers',
          category: 'providers',
          scope: 'global',
          title: 'Provider keys',
          status: 'ok',
          code: 'providers.configured',
          summary: 'ok',
          durationMs: 1,
        },
      ],
    }
    mockListProjects.mockResolvedValue([{ name: 'demo' }])
    mockRunDoctor
      .mockResolvedValueOnce(globalReport) // global checks
      .mockResolvedValueOnce(okReport) // project "demo"
    const cap = captureStdout(() => doctorCommand({ all: true, format: 'jsonl' }))
    await cap.run
    const records = cap.lines().map(l => JSON.parse(l))
    expect(records).toEqual([
      { project: null, ...globalReport.checks[0] },
      { project: 'demo', ...okReport.checks[0] },
    ])
  })
})
