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
      periodStart: null,
      periodEnd: null,
    },
    executiveSummary: {
      citationRate: 0,
      trend: 'unknown',
      keywordCount: 0,
      competitorCount: 0,
      providerCount: 0,
      gsc: null,
      ga: null,
      findings: [],
    },
    citationScorecard: { keywords: [], providers: [], matrix: [], providerRates: [] },
    competitorLandscape: { projectCitationCount: 0, competitors: [] },
    aiSourceOrigin: { categories: [], topDomains: [] },
    gsc: null,
    ga: null,
    socialReferrals: null,
    aiReferrals: null,
    indexingHealth: null,
    citationsTrend: [],
    insights: [],
    recommendedNextSteps: [],
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
      expect(files[0]).toMatch(/^canonry-report-demo-\d{4}-\d{2}-\d{2}\.html$/)

      const html = fs.readFileSync(path.join(tmpDir, files[0]!), 'utf-8')
      expect(html).toMatch(/^<!DOCTYPE html>/)
      expect(html).toContain('id="executive-summary"')

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
