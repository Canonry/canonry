import { afterEach, describe, expect, it, vi } from 'vitest'
import { skippedProviderRunError, type ProviderAccountStreak, type RunAdmissionDto, type RunDetailDto } from '@ainyc/canonry-contracts'

// What the CLI prints about providers held back because they keep failing on
// their accounts: the next sweep's admission in `canonry status`, and a run's
// skipped providers in `canonry run` and `canonry run show`. A refused
// scheduled sweep leaves no run, so these lines are the only CLI trace of it.

const mockGetProject = vi.fn()
const mockGetLatestRun = vi.fn()
const mockTriggerRun = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    getProject: mockGetProject,
    getLatestRun: mockGetLatestRun,
    triggerRun: mockTriggerRun,
  }),
}))

const { showStatus } = await import('../src/commands/status.js')
const { printRunDetail, triggerRun } = await import('../src/commands/run.js')

const OPENAI: ProviderAccountStreak = {
  code: 'PROVIDER_BILLING',
  consecutiveRuns: 10,
  since: '2026-10-01T00:00:00.000Z',
  latestRunId: 'run-9',
  retryAfter: '2026-10-08T09:00:00.000Z',
}
const CLAUDE: ProviderAccountStreak = { ...OPENAI, code: 'PROVIDER_AUTH' }
const OPENAI_LINE = 'openai (PROVIDER_BILLING): failed on its account in each of its last 10 runs; called again after 2026-10-08T09:00:00.000Z'
const FIX_LINE = "Fix the key, access or billing in the provider's console. Saving a new key, model or endpoint (canonry settings provider <name>) retries at once; canonry run 'acme co' --force calls every provider now."

const RUN: RunDetailDto = {
  id: 'run-10',
  projectId: 'p-1',
  kind: 'answer-visibility',
  status: 'partial',
  trigger: 'scheduled',
  createdAt: '2026-10-07T09:00:00.000Z',
}

async function captured(fn: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')) })
  try {
    await fn()
  } finally {
    spy.mockRestore()
  }
  return lines.join('\n').split('\n')
}

function statusWith(admission: RunAdmissionDto | undefined) {
  mockGetProject.mockResolvedValue({ id: 'p-1', name: 'acme co', displayName: 'Acme', canonicalDomain: 'acme.example', country: 'US', language: 'en' })
  mockGetLatestRun.mockResolvedValue({ totalRuns: 10, run: RUN, ...(admission ? { admission } : {}) })
}

afterEach(() => { vi.clearAllMocks() })

describe('canonry status', () => {
  it('says when the next sweep is refused, with every held provider and the way out', async () => {
    statusWith({ refused: true, retryAfter: OPENAI.retryAfter, providers: { claude: CLAUDE, openai: OPENAI } })
    const lines = await captured(() => showStatus('acme co'))
    const tail = lines.slice(lines.findIndex(line => line.includes('Next sweep')))
    expect(tail).toEqual([
      '  Next sweep: refused (PROVIDERS_FAILING). Every provider it would call keeps failing on its account; scheduled sweeps skip their slots until 2026-10-08T09:00:00.000Z.',
      '    claude (PROVIDER_AUTH): failed on its account in each of its last 10 runs; called again after 2026-10-08T09:00:00.000Z',
      `    ${OPENAI_LINE}`,
      `  ${FIX_LINE}`,
    ])
  })

  it('names the provider a sweep would skip', async () => {
    statusWith({ refused: false, retryAfter: null, providers: { openai: OPENAI } })
    const lines = await captured(() => showStatus('acme co'))
    expect(lines).toContain('  Next sweep: skips a provider that keeps failing on its account; the rest run.')
    expect(lines).toContain(`    ${OPENAI_LINE}`)
  })

  it('prints nothing about admission while every provider is called, or from a server without it', async () => {
    for (const admission of [{ refused: false, retryAfter: null, providers: {} }, undefined]) {
      statusWith(admission)
      const lines = await captured(() => showStatus('acme co'))
      expect(lines.some(line => line.includes('Next sweep') || line.includes('--force'))).toBe(false)
    }
  })

  it('puts the API admission in its JSON as sent, and leaves it out for a server without it', async () => {
    const admission: RunAdmissionDto = { refused: true, retryAfter: OPENAI.retryAfter, providers: { openai: OPENAI } }
    statusWith(admission)
    expect(JSON.parse((await captured(() => showStatus('acme co', 'json'))).join('\n')).admission).toEqual(admission)

    statusWith(undefined)
    expect(JSON.parse((await captured(() => showStatus('acme co', 'json'))).join('\n'))).not.toHaveProperty('admission')
  })
})

describe('a run that skipped a provider', () => {
  it('canonry run show prints one Skipped line instead of the skip entry', async () => {
    const lines = await captured(() => printRunDetail({
      ...RUN,
      skippedProviders: { openai: OPENAI },
      error: { providers: { openai: skippedProviderRunError('openai', OPENAI), gemini: { message: 'Request timed out.', code: 'TIMEOUT' } } },
    }))
    expect(lines).toContain(`  Skipped:  ${OPENAI_LINE}`)
    expect(lines).toContain('  Error (gemini): Request timed out.')
    expect(lines.some(line => line.startsWith('  Error (openai)'))).toBe(false)
  })

  it('canonry run says which providers the queued run will not call', async () => {
    mockTriggerRun.mockResolvedValue({ ...RUN, status: 'queued', skippedProviders: { openai: OPENAI } })
    const lines = await captured(() => triggerRun('acme co'))
    expect(lines.slice(lines.indexOf('Not calling a provider that keeps failing on its account:'))).toEqual([
      'Not calling a provider that keeps failing on its account:',
      `  ${OPENAI_LINE}`,
      FIX_LINE,
    ])
  })
})
