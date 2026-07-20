import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, apiKeys } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'
import type { BrandMetricsDto } from '@ainyc/canonry-contracts'

function captureOutput(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
  const logs: string[] = []
  const errors: string[] = []
  const origLog = console.log
  const origError = console.error
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  console.error = (...args: unknown[]) => errors.push(args.join(' '))
  return fn().finally(() => {
    console.log = origLog
    console.error = origError
  }).then(() => ({ stdout: logs.join('\n'), stderr: errors.join('\n') }))
}

/**
 * Deliberately literals, not imported constants: these pin the sentences a user
 * actually reads. The same literals are pinned in
 * `apps/web/test/visibility-trend-helpers.test.ts` — the CLI carries a mirrored
 * copy of the dashboard's copy builder, and identical literals in both suites
 * are what stops one surface softening the caveat the other gives.
 */
const CLOSING_LINE = 'rather than from a real change in how AI answers about you, so compare periods carefully.'

/** `summary` is a LEGACY field an older server used to send, kept here
 *  deliberately: it is the hostile wording this lane replaced, so a surface
 *  that ever renders the server's sentence again instead of building its own
 *  fails these tests loudly. Cast because these fixtures model what a server of
 *  any vintage may put on the wire, not the current full shape. */
const OPENAI_CHANGE = {
  modelIds: ['chat-latest'],
  changeCount: 1,
  unverifiedChangeCount: 0,
  firstChangeDate: '2026-06-24',
  lastChangeDate: '2026-06-24',
  summary: 'The model behind "chat-latest" changed on 2026-06-24, inside this reporting period. '
    + 'Part of any movement in this number comes from that change and not from how often AI names you.',
}

const PERPLEXITY_CHANGE = {
  modelIds: ['sonar-latest'],
  changeCount: 1,
  unverifiedChangeCount: 0,
  firstChangeDate: '2026-06-10',
  lastChangeDate: '2026-06-10',
  summary: 'The model behind "sonar-latest" changed on 2026-06-10, inside this reporting period. '
    + 'Part of any movement in this number comes from that change and not from how often AI names you.',
}

const OPENAI_UNCONFIRMED = {
  modelIds: ['chat-latest'],
  changeCount: 1,
  unverifiedChangeCount: 1,
  firstChangeDate: '2026-05-28',
  lastChangeDate: '2026-05-28',
}

/** Cast because the fixture omits the newer optional fields the CLI degrades over. */
function metricsWith(modelPointerChanges?: Record<string, unknown>): BrandMetricsDto {
  return {
    window: '30d',
    buckets: [],
    overall: { citationRate: 0, cited: 0, total: 0, mentionRate: 0, mentionedCount: 0 },
    byProvider: {},
    trend: 'stable',
    mentionTrend: 'stable',
    queryChanges: [],
    modelAttribution: {
      openai: {
        latestObservation: {
          observedAt: '2026-07-15T12:00:00.000Z',
          state: { status: 'known', model: 'chat-latest' },
        },
        events: [],
      },
    },
    ...(modelPointerChanges ? { modelPointerChanges } : {}),
  } as unknown as BrandMetricsDto
}

describe('analytics command', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let client: ApiClient
  let close: () => Promise<void>

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-analytics-test-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = tmpDir

    const dbPath = path.join(tmpDir, 'data.db')
    const configPath = path.join(tmpDir, 'config.yaml')

    const db = createClient(dbPath)
    migrate(db)

    const apiKeyPlain = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const hashed = crypto.createHash('sha256').update(apiKeyPlain).digest('hex')
    db.insert(apiKeys).values({ id: crypto.randomUUID(), name: 'test', keyHash: hashed, keyPrefix: apiKeyPlain.slice(0, 8), createdAt: new Date().toISOString() }).run()

    const config = {
      apiUrl: 'http://localhost:0',
      database: dbPath,
      apiKey: apiKeyPlain,
    }

    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')

    const app = await createServer({ config: config as Parameters<typeof createServer>[0]['config'], db, logger: false })
    await app.listen({ host: '127.0.0.1', port: 0 })

    const addr = app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    config.apiUrl = `http://127.0.0.1:${port}`
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')

    close = () => app.close()
    client = new ApiClient(config.apiUrl, apiKeyPlain)

    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })
  })

  afterEach(async () => {
    await close()
    if (origConfigDir === undefined) {
      delete process.env.CANONRY_CONFIG_DIR
    } else {
      process.env.CANONRY_CONFIG_DIR = origConfigDir
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('prints metrics section for empty project', async () => {
    const { showAnalytics } = await import('../src/commands/analytics.js')
    const { stdout } = await captureOutput(() => showAnalytics('test-proj', { feature: 'metrics' }))
    expect(stdout).toMatch(/Citation Rate Trends/)
    expect(stdout).toMatch(/Overall:/)
  })

  it('prints latest model evidence and ordered attribution events', async () => {
    const metricsSpy = vi.spyOn(ApiClient.prototype, 'getAnalyticsMetrics').mockResolvedValue({
      window: '30d',
      buckets: [],
      overall: { citationRate: 0, cited: 0, total: 0, mentionRate: 0, mentionedCount: 0 },
      byProvider: {},
      trend: 'stable',
      mentionTrend: 'stable',
      queryChanges: [],
      modelAttribution: {
        claude: {
          latestObservation: {
            observedAt: '2026-07-14T12:00:00.000Z',
            state: { status: 'known', model: 'claude-sonnet-5' },
          },
          events: [{
            observedAt: '2026-07-10T12:00:00.000Z',
            bucketStartDate: '2026-07-10T00:00:00.000Z',
            from: { status: 'known', model: 'claude-opus-5' },
            to: { status: 'known', model: 'claude-sonnet-5' },
          }],
        },
      },
    })
    try {
      const { showAnalytics } = await import('../src/commands/analytics.js')
      const { stdout } = await captureOutput(() => showAnalytics('test-proj', { feature: 'metrics' }))
      expect(stdout).toContain('Model Evidence:')
      expect(stdout).toContain('claude: latest known claude-sonnet-5 at 2026-07-14T12:00:00.000Z')
      expect(stdout).toContain('2026-07-10T12:00:00.000Z  known claude-opus-5 → known claude-sonnet-5')
      // Neither optional field is set, so neither annotation appears.
      expect(stdout).not.toContain('(on or before)')
      expect(stdout).not.toContain('Showing the latest')
    } finally {
      metricsSpy.mockRestore()
    }
  })

  it('dates an anchored change as "on or before" and reports a capped event list', async () => {
    const metricsSpy = vi.spyOn(ApiClient.prototype, 'getAnalyticsMetrics').mockResolvedValue({
      window: '30d',
      buckets: [],
      overall: { citationRate: 0, cited: 0, total: 0, mentionRate: 0, mentionedCount: 0 },
      byProvider: {},
      trend: 'stable',
      mentionTrend: 'stable',
      queryChanges: [],
      modelAttribution: {
        perplexity: {
          latestObservation: {
            observedAt: '2026-07-15T12:00:00.000Z',
            state: { status: 'known', model: 'sonar-pro' },
          },
          events: [
            {
              observedAt: '2026-07-02T12:00:00.000Z',
              bucketStartDate: '2026-07-02T00:00:00.000Z',
              from: { status: 'known', model: 'sonar' },
              to: { status: 'known', model: 'sonar-pro' },
              fromPreWindowAnchor: true,
            },
            {
              observedAt: '2026-07-15T12:00:00.000Z',
              bucketStartDate: '2026-07-15T00:00:00.000Z',
              from: { status: 'known', model: 'sonar' },
              to: { status: 'known', model: 'sonar-pro' },
            },
          ],
          eventTotal: 84,
        },
      },
    })
    try {
      const { showAnalytics } = await import('../src/commands/analytics.js')
      const { stdout } = await captureOutput(() => showAnalytics('test-proj', { feature: 'metrics' }))
      expect(stdout).toContain('2026-07-02T12:00:00.000Z (on or before)  known sonar → known sonar-pro')
      // The in-window transition keeps its exact date.
      expect(stdout).toContain('2026-07-15T12:00:00.000Z  known sonar → known sonar-pro')
      expect(stdout).toContain('Showing the latest 2 of 84 model changes.')
    } finally {
      metricsSpy.mockRestore()
    }
  })

  it('reports what the engines answered with, the substitution, and an incomplete history', async () => {
    const metricsSpy = vi.spyOn(ApiClient.prototype, 'getAnalyticsMetrics').mockResolvedValue({
      window: '30d',
      buckets: [],
      overall: { citationRate: 0, cited: 0, total: 0, mentionRate: 0, mentionedCount: 0 },
      byProvider: {},
      trend: 'stable',
      mentionTrend: 'stable',
      queryChanges: [],
      modelAttribution: {
        openai: {
          latestObservation: {
            observedAt: '2026-07-15T12:00:00.000Z',
            state: { status: 'known', model: 'gpt-5.6' },
          },
          events: [
            {
              observedAt: '2026-07-02T12:00:00.000Z',
              bucketStartDate: '2026-07-02T00:00:00.000Z',
              from: { status: 'known', model: 'gpt-5.4' },
              to: { status: 'known', model: 'gpt-5.6' },
              fromPreWindowAnchor: true,
              anchorObservedAt: '2026-06-20T12:00:00.000Z',
            },
          ],
          eventTotal: 1,
          anchorUnavailable: true,
        },
      },
      servedModelAttribution: {
        openai: {
          latestObservation: {
            observedAt: '2026-07-15T12:00:00.000Z',
            state: { status: 'known', model: 'gpt-5.6-sol' },
          },
          events: [],
          eventTotal: 0,
          latestServedModelIds: ['gpt-5.6-sol'],
        },
      },
      modelServiceMismatch: {
        openai: {
          observedAt: '2026-07-15T12:00:00.000Z',
          configured: { status: 'known', model: 'gpt-5.6' },
          served: { status: 'known', model: 'gpt-5.6-sol' },
        },
      },
    })
    try {
      const { showAnalytics } = await import('../src/commands/analytics.js')
      const { stdout } = await captureOutput(() => showAnalytics('test-proj', { feature: 'metrics' }))
      // An anchored change now carries its lower bound, so the operator reads a
      // closed range instead of an open-ended "sometime earlier".
      expect(stdout).toContain('(on or before)')
      expect(stdout).toContain('[last seen known gpt-5.4 on 2026-06-20T12:00:00.000Z]')
      expect(stdout).toContain('We did not look far enough back to be sure this is every change.')
      // The served lane, in plain language.
      expect(stdout).toContain('What the Engines Answered With:')
      expect(stdout).toContain('openai: gpt-5.6-sol at 2026-07-15T12:00:00.000Z — not the known gpt-5.6 you selected')
    } finally {
      metricsSpy.mockRestore()
    }
  })

  it('names the engine the reader knows and prints the caveat above the numbers', async () => {
    const metricsSpy = vi.spyOn(ApiClient.prototype, 'getAnalyticsMetrics')
      .mockResolvedValue(metricsWith({ openai: OPENAI_CHANGE }))
    try {
      const { showAnalytics } = await import('../src/commands/analytics.js')
      const { stdout } = await captureOutput(() => showAnalytics('test-proj', { feature: 'metrics' }))
      const note = stdout.split('\n').find(line => line.includes('The model behind'))!
      expect(note.trim()).toBe(
        'The model behind ChatGPT was updated on 2026-06-24, inside this period. '
        + `Some of the movement in these numbers may come from this update ${CLOSING_LINE}`,
      )
      // "chat-latest" is an internal model id. An agency owner reads engines.
      expect(note).not.toContain('chat-latest')
      // Above the FIRST number, not merely above the model sections at the
      // bottom: an operator who has already read the rates has already formed
      // the reading this note exists to correct.
      expect(stdout.indexOf('Model Updates Behind These Numbers:')).toBeLessThan(stdout.indexOf('Overall:'))
    } finally {
      metricsSpy.mockRestore()
    }
  })

  it('states one fact per engine and closes with a single consequence', async () => {
    const metricsSpy = vi.spyOn(ApiClient.prototype, 'getAnalyticsMetrics')
      .mockResolvedValue(metricsWith({ openai: OPENAI_CHANGE, perplexity: PERPLEXITY_CHANGE }))
    try {
      const { showAnalytics } = await import('../src/commands/analytics.js')
      const { stdout } = await captureOutput(() => showAnalytics('test-proj', { feature: 'metrics' }))
      const note = stdout.split('\n').find(line => line.includes('The model behind'))!
      expect(note.trim()).toBe(
        'The model behind ChatGPT was updated on 2026-06-24, inside this period. '
        + 'The model behind Perplexity was updated on 2026-06-10, inside this period. '
        + `Some of the movement in these numbers may come from these updates ${CLOSING_LINE}`,
      )
      // Two engines are two facts and ONE warning; repeating the consequence
      // per engine read as two separate alarms about the same numbers.
      const sentences = note.trim().split('. ').map(s => s.trim())
      expect(new Set(sentences).size).toBe(sentences.length)
    } finally {
      metricsSpy.mockRestore()
    }
  })

  it('never states an unconfirmed update as fact, and never hides it either', async () => {
    const metricsSpy = vi.spyOn(ApiClient.prototype, 'getAnalyticsMetrics')
      .mockResolvedValue(metricsWith({ openai: OPENAI_UNCONFIRMED }))
    try {
      const { showAnalytics } = await import('../src/commands/analytics.js')
      const { stdout } = await captureOutput(() => showAnalytics('test-proj', { feature: 'metrics' }))
      const note = stdout.split('\n').find(line => line.includes('The model behind'))!
      expect(note.trim()).toBe(
        'The model behind ChatGPT may have been updated on 2026-05-28, inside this period, though that is not confirmed. '
        + `If so, some of the movement in these numbers may come from this update ${CLOSING_LINE}`,
      )
      expect(note).not.toContain('was updated')
    } finally {
      metricsSpy.mockRestore()
    }
  })

  it('says so quietly, and low in the output, when an engine can be updated but nothing is on record', async () => {
    const metricsSpy = vi.spyOn(ApiClient.prototype, 'getAnalyticsMetrics')
      .mockResolvedValue(metricsWith({ openai: { ...OPENAI_CHANGE, changeCount: 0, unverifiedChangeCount: 0 } }))
    try {
      const { showAnalytics } = await import('../src/commands/analytics.js')
      const { stdout } = await captureOutput(() => showAnalytics('test-proj', { feature: 'metrics' }))
      // Silence here is indistinguishable from a record nobody has updated in
      // six months, so the common case still says something — just not above
      // the numbers, where it would be noise on every single run.
      expect(stdout).toContain('No model updates are on record for ChatGPT in this period.')
      expect(stdout.indexOf('No model updates are on record')).toBeGreaterThan(stdout.indexOf('Overall:'))
    } finally {
      metricsSpy.mockRestore()
    }
  })

  it('prints how recently the update record was checked, since a terminal has no tooltip', async () => {
    // The dashboard hides this sentence in a tooltip. The CLI has nowhere to
    // hide it, and dropping it is what makes "nothing on record" read as proof
    // that nothing happened rather than as the age of our knowledge.
    const metricsSpy = vi.spyOn(ApiClient.prototype, 'getAnalyticsMetrics')
      .mockResolvedValue(metricsWith({
        openai: {
          modelIds: ['chat-latest'],
          changeCount: 0,
          unverifiedChangeCount: 0,
          knownGoodAsOf: '2026-07-20',
          checkedThroughPeriodEnd: true,
        },
      }))
    try {
      const { showAnalytics } = await import('../src/commands/analytics.js')
      const { stdout } = await captureOutput(() => showAnalytics('test-proj', { feature: 'metrics' }))
      expect(stdout).toContain('We last checked for model updates on 2026-07-20.')
    } finally {
      metricsSpy.mockRestore()
    }
  })

  it('says out loud when the period runs past the last check', async () => {
    const metricsSpy = vi.spyOn(ApiClient.prototype, 'getAnalyticsMetrics')
      .mockResolvedValue(metricsWith({
        openai: { ...OPENAI_CHANGE, knownGoodAsOf: '2026-07-20', checkedThroughPeriodEnd: false },
      }))
    try {
      const { showAnalytics } = await import('../src/commands/analytics.js')
      const { stdout } = await captureOutput(() => showAnalytics('test-proj', { feature: 'metrics' }))
      // Finding one update must never imply we found all of them.
      expect(stdout).toContain(
        'We last checked for model updates on 2026-07-20, and this period runs past that date,'
        + ' so there may be later updates we do not know about.',
      )
    } finally {
      metricsSpy.mockRestore()
    }
  })

  it('prints nothing when the server omits the field or reports no exposure', async () => {
    const metricsSpy = vi.spyOn(ApiClient.prototype, 'getAnalyticsMetrics').mockResolvedValue(metricsWith())
    try {
      const { showAnalytics } = await import('../src/commands/analytics.js')
      const older = await captureOutput(() => showAnalytics('test-proj', { feature: 'metrics' }))
      expect(older.stdout).toContain('Model Evidence:')
      expect(older.stdout).not.toContain('Model Updates Behind These Numbers:')
      expect(older.stdout).not.toContain('The model behind')

      metricsSpy.mockResolvedValue(metricsWith({}))
      const unchanged = await captureOutput(() => showAnalytics('test-proj', { feature: 'metrics' }))
      expect(unchanged.stdout).not.toContain('Model Updates Behind These Numbers:')
      expect(unchanged.stdout).not.toContain('The model behind')
    } finally {
      metricsSpy.mockRestore()
    }
  })

  /**
   * The copy is the deliverable. Pinned so a later edit cannot quietly
   * reintroduce the internal words an agency owner does not speak.
   */
  it('keeps the note free of internal vocabulary and em-dashes', async () => {
    const metricsSpy = vi.spyOn(ApiClient.prototype, 'getAnalyticsMetrics')
      .mockResolvedValue(metricsWith({ openai: OPENAI_CHANGE }))
    try {
      const { showAnalytics } = await import('../src/commands/analytics.js')
      const { stdout } = await captureOutput(() => showAnalytics('test-proj', { feature: 'metrics' }))
      const note = stdout.split('\n').find(line => line.includes('The model behind'))!
      for (const banned of ['pointer', 'alias', 'snapshot', 'drift', 'attribution', 'divergence']) {
        expect(note.toLowerCase()).not.toContain(banned)
      }
      expect(note).not.toContain('—')
    } finally {
      metricsSpy.mockRestore()
    }
  })

  it('prints gap analysis section for empty project', async () => {
    const { showAnalytics } = await import('../src/commands/analytics.js')
    const { stdout } = await captureOutput(() => showAnalytics('test-proj', { feature: 'gaps' }))
    expect(stdout).toMatch(/Brand Gap Analysis/)
    expect(stdout).toMatch(/Cited:/)
    expect(stdout).toMatch(/Gap:/)
    expect(stdout).toMatch(/Uncited:/)
  })

  it('prints source breakdown section for empty project', async () => {
    const { showAnalytics } = await import('../src/commands/analytics.js')
    const { stdout } = await captureOutput(() => showAnalytics('test-proj', { feature: 'sources' }))
    expect(stdout).toMatch(/Source Origin Breakdown/)
  })

  it('prints all sections when no feature is specified', async () => {
    const { showAnalytics } = await import('../src/commands/analytics.js')
    const { stdout } = await captureOutput(() => showAnalytics('test-proj', {}))
    expect(stdout).toMatch(/Citation Rate Trends/)
    expect(stdout).toMatch(/Brand Gap Analysis/)
    expect(stdout).toMatch(/Source Origin Breakdown/)
  })

  it('outputs valid JSON when --format json is set', async () => {
    const { showAnalytics } = await import('../src/commands/analytics.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await showAnalytics('test-proj', { format: 'json' })
    } finally {
      console.log = origLog
    }
    const output = logs.join('\n')
    const parsed = JSON.parse(output)
    expect(parsed).toHaveProperty('metrics')
    expect(parsed).toHaveProperty('gaps')
    expect(parsed).toHaveProperty('sources')
  })

  it('outputs only the requested feature when --feature is set with --format json', async () => {
    const { showAnalytics } = await import('../src/commands/analytics.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await showAnalytics('test-proj', { feature: 'metrics', format: 'json' })
    } finally {
      console.log = origLog
    }
    const parsed = JSON.parse(logs.join('\n'))
    expect(parsed).toHaveProperty('metrics')
    expect(parsed).not.toHaveProperty('gaps')
    expect(parsed).not.toHaveProperty('sources')
  })

  it('metrics JSON passes through the per-bucket provider contract (byProvider + buckets)', async () => {
    const { showAnalytics } = await import('../src/commands/analytics.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await showAnalytics('test-proj', { feature: 'metrics', format: 'json' })
    } finally {
      console.log = origLog
    }
    const metrics = JSON.parse(logs.join('\n')).metrics as { byProvider: unknown; buckets: unknown[] }
    // The CLI emits the full BrandMetricsDto, so the per-bucket provider
    // breakdown the dashboard chart consumes is reachable via `--format json`
    // (parity). Per-bucket content is asserted in api-routes analytics.test.ts.
    expect(typeof metrics.byProvider).toBe('object')
    expect(Array.isArray(metrics.buckets)).toBe(true)
  })

  it('passes window param to metrics endpoint', async () => {
    const { showAnalytics } = await import('../src/commands/analytics.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await showAnalytics('test-proj', { feature: 'metrics', format: 'json', window: '7d' })
    } finally {
      console.log = origLog
    }
    const parsed = JSON.parse(logs.join('\n'))
    expect((parsed.metrics as { window: string }).window).toBe('7d')
  })
  it('dates the timeline from the real sweeps and says the dates are UTC', async () => {
    // A bucket whose synthetic boundary (2026-07-10) is 10 days away from the
    // sweeps it actually contains — the production shape. Printing the boundary
    // would date the reading to a day nothing ran on.
    const metricsSpy = vi.spyOn(ApiClient.prototype, 'getAnalyticsMetrics').mockResolvedValue({
      window: 'all',
      buckets: [
        {
          startDate: '2026-05-15T00:00:00.000Z', endDate: '2026-05-29T00:00:00.000Z',
          dataStartDate: '2026-05-15T19:38:00.000Z', dataEndDate: '2026-05-15T19:38:00.000Z', sweepCount: 1,
          citationRate: 0.25, cited: 1, total: 4, queryCount: 4, mentionRate: 0.5, mentionedCount: 2,
          mentionShare: { rate: null, projectMentionSnapshots: 0, competitorMentionSnapshots: 0 },
          byProvider: { gemini: { citationRate: 0.25, cited: 1, total: 4, mentionRate: 0.5, mentionedCount: 2 } },
          modelEvidenceByProvider: {},
        },
        {
          startDate: '2026-07-10T00:00:00.000Z', endDate: '2026-07-24T00:00:00.000Z',
          dataStartDate: '2026-07-14T09:00:00.000Z', dataEndDate: '2026-07-20T01:52:51.000Z', sweepCount: 2,
          citationRate: 0.75, cited: 3, total: 4, queryCount: 4, mentionRate: 0.5, mentionedCount: 2,
          mentionShare: { rate: null, projectMentionSnapshots: 0, competitorMentionSnapshots: 0 },
          byProvider: { gemini: { citationRate: 0.75, cited: 3, total: 4, mentionRate: 0.5, mentionedCount: 2 } },
          modelEvidenceByProvider: {},
        },
      ],
      overall: { citationRate: 0.5, cited: 4, total: 8, mentionRate: 0.5, mentionedCount: 4 },
      byProvider: {},
      trend: 'improving',
      mentionTrend: 'stable',
      queryChanges: [],
      modelAttribution: {},
    })
    try {
      const { showAnalytics } = await import('../src/commands/analytics.js')
      const { stdout } = await captureOutput(() => showAnalytics('test-proj', { feature: 'metrics' }))

      // The CLI has no viewer timezone, so it stays UTC — and says so rather
      // than letting the reader assume local time.
      expect(stdout).toContain('Timeline (dates in UTC):')
      expect(stdout).toContain('By Provider Timeline (dates in UTC):')

      // Real sweep dates, and pooling is stated instead of hidden.
      expect(stdout).toContain('2026-05-15')
      expect(stdout).toContain('2026-07-14 \u2192 2026-07-20 (2 sweeps)')

      // Never the synthetic boundary.
      expect(stdout).not.toContain('2026-07-10')
    } finally {
      metricsSpy.mockRestore()
    }
  })

  it('says so plainly when an older server omits the real sweep dates', async () => {
    const legacyBucket = {
      startDate: '2026-07-10T00:00:00.000Z', endDate: '2026-07-24T00:00:00.000Z',
      citationRate: 0.5, cited: 2, total: 4, queryCount: 4, mentionRate: 0.5, mentionedCount: 2,
      mentionShare: { rate: null, projectMentionSnapshots: 0, competitorMentionSnapshots: 0 },
      byProvider: {},
      modelEvidenceByProvider: {},
    }
    const metricsSpy = vi.spyOn(ApiClient.prototype, 'getAnalyticsMetrics').mockResolvedValue({
      window: 'all',
      buckets: [legacyBucket as unknown as BrandMetricsDto['buckets'][number]],
      overall: { citationRate: 0.5, cited: 2, total: 4, mentionRate: 0.5, mentionedCount: 2 },
      byProvider: {},
      trend: 'stable',
      mentionTrend: 'stable',
      queryChanges: [],
      modelAttribution: {},
    })
    try {
      const { showAnalytics } = await import('../src/commands/analytics.js')
      const { stdout } = await captureOutput(() => showAnalytics('test-proj', { feature: 'metrics' }))
      expect(stdout).toContain('date unavailable')
      // Falling back to the boundary would be worse than saying nothing.
      expect(stdout).not.toContain('2026-07-10')
    } finally {
      metricsSpy.mockRestore()
    }
  })
})
