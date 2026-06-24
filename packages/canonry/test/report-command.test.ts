import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectReportDto } from '@ainyc/canonry-contracts'

function makeReport(): ProjectReportDto {
  return {
    meta: {
      generatedAt: '2026-05-02T00:00:00.000Z',
      project: {
        id: 'p-1',
        name: 'demo',
        displayName: 'Demo',
        canonicalDomain: 'demo.example.com',
        country: 'US',
        language: 'en',
      },
      location: null,
      providerLocationHandling: [],
      periodStart: null,
      periodEnd: null,
      periodDays: 30,
    },
    executiveSummary: {
      citationRate: 0,
      citedQueryCount: 0,
      totalQueryCount: 0,
      mentionRate: 0,
      mentionedQueryCount: 0,
      trend: 'unknown',
      queryCount: 0,
      competitorCount: 0,
      providerCount: 0,
      gsc: null,
      ga: null,
      findings: [],
    },
    citationScorecard: { queries: [], providers: [], matrix: [], providerRates: [] },
    competitorLandscape: { projectCitationCount: 0, competitors: [] },
    mentionLandscape: { projectMentionCount: 0, totalAnswerSnapshots: 0, competitors: [] },
    aiSourceOrigin: { categories: [], topDomains: [] },
    gsc: null,
    ga: null,
    socialReferrals: null,
    aiReferrals: null,
    indexingHealth: null,
    citationsTrend: [],
    whatsChanged: {
      enoughHistory: false,
      headline: 'Building baseline (0 of 4 checks completed). Trends appear after a few more checks.',
      citationRate: null,
      mentionRate: null,
      citedQueryCount: null,
      gscClicksDelta: null,
      aiReferralsDelta: null,
      comparisonWindowDays: 15,
      providerMovements: [],
      wins: [],
      regressions: [],
    },
    insights: [],
    recommendedNextSteps: [],
    actionPlan: [],
    clientSummary: {
      headline: 'No tracked queries have completed a visibility sweep yet',
      overview: 'No visibility data yet.',
      actionItems: [],
      confidenceNotes: [],
    },
    agencyDiagnostics: {
      priorities: [],
      diagnostics: [],
    },
    contentOpportunities: [],
    contentGaps: [],
    groundingSources: [],
  }
}

const getReportMock = vi.fn<() => Promise<ProjectReportDto>>()

vi.mock('../src/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/client.js')>('../src/client.js')
  return {
    ...actual,
    createApiClient: () => ({ getReport: getReportMock }),
  }
})

const { runReportCommand } = await import('../src/commands/report.js')

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-report-cmd-'))
  getReportMock.mockReset()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('runReportCommand', () => {
  it('writes an HTML file with default name pattern when no --output is given', async () => {
    getReportMock.mockResolvedValue(makeReport())

    const cwd = process.cwd()
    process.chdir(tmpDir)
    try {
      const logs: string[] = []
      const origLog = console.log
      console.log = (...parts: unknown[]) => logs.push(parts.join(' '))
      try {
        await runReportCommand('demo', { format: 'text' })
      } finally {
        console.log = origLog
      }

      const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.html'))
      expect(files.length).toBe(1)
      expect(files[0]).toMatch(/^canonry-report-demo-agency-\d{4}-\d{2}-\d{2}\.html$/)

      const html = fs.readFileSync(path.join(tmpDir, files[0]!), 'utf-8')
      expect(html).toMatch(/^<!DOCTYPE html>/)
      expect(html).toContain('id="executive-summary"')
      expect(html).toContain('AI Visibility Report')

      expect(logs.join('\n')).toContain(files[0]!)
    } finally {
      process.chdir(cwd)
    }
  })

  it('respects --output and writes there', async () => {
    getReportMock.mockResolvedValue(makeReport())
    const target = path.join(tmpDir, 'sub', 'custom.html')

    await runReportCommand('demo', { format: 'text', output: target })

    expect(fs.existsSync(target)).toBe(true)
    const html = fs.readFileSync(target, 'utf-8')
    expect(html).toContain('id="executive-summary"')
  })

  it('renders client HTML when --audience client is supplied', async () => {
    getReportMock.mockResolvedValue(makeReport())
    const target = path.join(tmpDir, 'client.html')

    await runReportCommand('demo', { format: 'text', audience: 'client', output: target })

    const html = fs.readFileSync(target, 'utf-8')
    expect(html).toContain('AI Visibility Report')
    expect(html).toContain('id="client-summary"')
    expect(html).not.toContain('id="citation-scorecard"')
  })

  it('forwards --period to the API client', async () => {
    getReportMock.mockResolvedValue(makeReport())
    await runReportCommand('demo', { format: 'json', period: 7 })
    expect(getReportMock).toHaveBeenCalledWith('demo', { period: 7 })
  })

  it('omits the period query entirely when no --period is given', async () => {
    getReportMock.mockResolvedValue(makeReport())
    await runReportCommand('demo', { format: 'json' })
    expect(getReportMock).toHaveBeenCalledWith('demo', undefined)
  })

  it('--format json prints the raw report JSON to stdout, no file written', async () => {
    getReportMock.mockResolvedValue(makeReport())

    const logs: string[] = []
    const origLog = console.log
    console.log = (...parts: unknown[]) => logs.push(parts.join(' '))

    const cwd = process.cwd()
    process.chdir(tmpDir)
    try {
      await runReportCommand('demo', { format: 'json' })
    } finally {
      console.log = origLog
      process.chdir(cwd)
    }

    expect(fs.readdirSync(tmpDir).filter(f => f.endsWith('.html')).length).toBe(0)
    const printed = logs.join('\n')
    const parsed = JSON.parse(printed) as ProjectReportDto
    expect(parsed.meta.project.name).toBe('demo')
  })
})
