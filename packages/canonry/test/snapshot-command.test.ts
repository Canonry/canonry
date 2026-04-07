import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes } from '@ainyc/canonry-api-routes'
import { invokeCli } from './cli-test-utils.js'
import { formatSnapshotText, formatSnapshotMarkdown, writeSnapshotMarkdown } from '../src/commands/snapshot.js'
import { writeSnapshotPdf } from '../src/snapshot-pdf.js'

const SNAPSHOT_FIXTURE = {
  companyName: 'Acme Corp',
  domain: 'acme.example.com',
  homepageUrl: 'https://acme.example.com',
  generatedAt: '2026-03-29T12:00:00.000Z',
  phrases: ['best enterprise widget provider', 'who offers enterprise widget support'],
  competitors: ['widgetco.com', 'superwidgets.com'],
  profile: {
    industry: 'Manufacturing',
    summary: 'Acme Corp sells enterprise widget manufacturing and support services.',
    services: ['Widget manufacturing', 'Widget support'],
    categoryTerms: ['enterprise widgets', 'widget support'],
  },
  audit: {
    url: 'https://acme.example.com',
    finalUrl: 'https://acme.example.com',
    auditedAt: '2026-03-29T12:00:00.000Z',
    overallScore: 58,
    overallGrade: 'D+',
    summary: 'Overall grade D+ with weak schema completeness.',
    factors: [
      {
        id: 'schema-completeness',
        name: 'Schema Completeness',
        weight: 8,
        score: 2,
        grade: 'F',
        status: 'fail',
        findings: [{ type: 'missing', message: 'No Organization schema detected.' }],
        recommendations: ['Add Organization and Service schema.'],
      },
    ],
  },
  queryResults: [
    {
      phrase: 'best enterprise widget provider',
      providerResults: [
        {
          provider: 'openai',
          displayName: 'OpenAI',
          model: 'gpt-5.4',
          mentioned: false,
          cited: false,
          describedAccurately: 'not-mentioned',
          accuracyNotes: null,
          incorrectClaims: [],
          recommendedCompetitors: ['widgetco.com'],
          citedDomains: ['widgetco.com'],
          groundingSources: [],
          searchQueries: ['best enterprise widget provider'],
          answerText: 'WidgetCo is a strong option.',
          error: null,
        },
      ],
    },
    {
      phrase: 'who offers enterprise widget support',
      providerResults: [
        {
          provider: 'claude',
          displayName: 'Claude',
          model: 'claude-sonnet-4-6',
          mentioned: true,
          cited: true,
          describedAccurately: 'yes',
          accuracyNotes: 'Acme appears with an accurate service description.',
          incorrectClaims: [],
          recommendedCompetitors: ['superwidgets.com'],
          citedDomains: ['acme.example.com', 'superwidgets.com'],
          groundingSources: [],
          searchQueries: ['who offers enterprise widget support'],
          answerText: 'Acme Corp provides enterprise widget support.',
          error: null,
        },
      ],
    },
  ],
  summary: {
    totalQueries: 2,
    totalProviders: 1,
    totalComparisons: 2,
    mentionCount: 1,
    citationCount: 1,
    topCompetitors: [
      { name: 'widgetco.com', count: 1 },
      { name: 'superwidgets.com', count: 1 },
    ],
    visibilityGap: 'Acme Corp was mentioned in 1/2 provider responses and cited in 1/2.',
    whatThisMeans: ['Category visibility is inconsistent and competitors still win broad prompts.'],
    recommendedActions: ['Add Organization and Service schema.'],
  },
}

describe('snapshot command', () => {
  let tmpDir: string
  let app: ReturnType<typeof Fastify>
  let originalConfigDir: string | undefined
  let originalTelemetryDisabled: string | undefined
  let originalCi: string | undefined

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-snapshot-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })

    originalConfigDir = process.env.CANONRY_CONFIG_DIR
    originalTelemetryDisabled = process.env.CANONRY_TELEMETRY_DISABLED
    originalCi = process.env.CI
    process.env.CANONRY_CONFIG_DIR = tmpDir
    process.env.CANONRY_TELEMETRY_DISABLED = '1'
    process.env.CI = '1'

    const dbPath = path.join(tmpDir, 'test.db')
    const db = createClient(dbPath)
    migrate(db)

    app = Fastify()
    app.register(apiRoutes, {
      db,
      skipAuth: true,
      onSnapshotRequested: async () => SNAPSHOT_FIXTURE,
    })
    await app.listen({ host: '127.0.0.1', port: 0 })

    const address = app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    fs.writeFileSync(
      path.join(tmpDir, 'config.yaml'),
      JSON.stringify({
        apiUrl: `http://127.0.0.1:${port}`,
        database: dbPath,
        apiKey: 'cnry_test',
        providers: {},
      }),
      'utf-8',
    )
  })

  afterEach(async () => {
    await app.close()
    if (originalConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = originalConfigDir
    if (originalTelemetryDisabled === undefined) delete process.env.CANONRY_TELEMETRY_DISABLED
    else process.env.CANONRY_TELEMETRY_DISABLED = originalTelemetryDisabled
    if (originalCi === undefined) delete process.env.CI
    else process.env.CI = originalCi
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('prints snapshot JSON via the CLI', async () => {
    const result = await invokeCli([
      'snapshot',
      'Acme Corp',
      '--domain',
      'acme.example.com',
      '--format',
      'json',
    ])

    expect(result.exitCode).toBe(undefined)
    expect(result.stderr).toBe('')
    const parsed = JSON.parse(result.stdout) as typeof SNAPSHOT_FIXTURE
    expect(parsed.audit.overallScore).toBe(58)
    expect(parsed.summary.topCompetitors[0]?.name).toBe('widgetco.com')
  })

  it('creates a markdown report when --md is provided', async () => {
    const originalCwd = process.cwd()
    process.chdir(tmpDir)
    try {
      const result = await invokeCli([
        'snapshot',
        'Acme Corp',
        '--domain',
        'acme.example.com',
        '--md',
      ])

      expect(result.exitCode).toBe(undefined)
      expect(result.stdout).toContain('Markdown saved:')
      const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.md'))
      expect(files.length).toBeGreaterThanOrEqual(1)
      const mdFile = files.find(f => f.includes('acme-corp-snapshot'))!
      expect(mdFile).toBeDefined()
      const content = fs.readFileSync(path.join(tmpDir, mdFile), 'utf-8')
      expect(content).toContain('# AI Perception Snapshot: Acme Corp')
    } finally {
      process.chdir(originalCwd)
    }
  })

  it('creates a markdown report at --output path', async () => {
    const mdPath = path.join(tmpDir, 'acme-report.md')
    const result = await invokeCli([
      'snapshot',
      'Acme Corp',
      '--domain',
      'acme.example.com',
      '--output',
      mdPath,
    ])

    expect(result.exitCode).toBe(undefined)
    expect(fs.existsSync(mdPath)).toBe(true)
    const content = fs.readFileSync(mdPath, 'utf-8')
    expect(content).toContain('# AI Perception Snapshot: Acme Corp')
    expect(content).toContain('58/100 (D+)')
    expect(result.stdout).toContain('Markdown saved:')
  })

  it('creates a PDF report when --pdf is provided', async () => {
    const originalCwd = process.cwd()
    process.chdir(tmpDir)
    try {
      const result = await invokeCli([
        'snapshot',
        'Acme Corp',
        '--domain',
        'acme.example.com',
        '--pdf',
      ])

      expect(result.exitCode).toBe(undefined)
      const pdfFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.pdf'))
      expect(pdfFiles.length).toBeGreaterThanOrEqual(1)
      const pdfFile = pdfFiles.find(f => f.includes('acme-corp-snapshot'))!
      expect(pdfFile).toBeDefined()
      expect(fs.readFileSync(path.join(tmpDir, pdfFile)).subarray(0, 5).toString('utf-8')).toBe('%PDF-')
      expect(result.stdout).toContain('PDF saved:')
    } finally {
      process.chdir(originalCwd)
    }
  })

  it('formats text output with visibility and competitor details', () => {
    const text = formatSnapshotText(SNAPSHOT_FIXTURE)
    expect(text).toContain('AEO audit: 58/100 (D+)')
    expect(text).toContain('Top competitors AI recommended instead: widgetco.com (1), superwidgets.com (1)')
    expect(text).toContain('OpenAI')
    expect(text).toContain('recommended instead: widgetco.com')
  })

  it('formats markdown with all report sections', () => {
    const md = formatSnapshotMarkdown(SNAPSHOT_FIXTURE)
    expect(md).toContain('# AI Perception Snapshot: Acme Corp')
    expect(md).toContain('**AEO Audit Score:** 58/100 (D+)')
    expect(md).toContain('## Visibility Gap')
    expect(md).toContain('Acme Corp was mentioned in 1/2 provider responses')
    expect(md).toContain('## Competitors AI Recommends Instead')
    expect(md).toContain('| widgetco.com | 1 |')
    expect(md).toContain('## Provider Comparison')
    expect(md).toContain('### "best enterprise widget provider"')
    expect(md).toContain('| OpenAI | No | No |')
    expect(md).toContain('| Claude | Yes | Yes |')
    expect(md).toContain('## Audit Factors')
    expect(md).toContain('| Schema Completeness |')
    expect(md).toContain('Generated by [Canonry]')
  })

  it('writes a standalone markdown report to a file', () => {
    const mdPath = path.join(tmpDir, 'standalone.md')
    const savedPath = writeSnapshotMarkdown(SNAPSHOT_FIXTURE, mdPath)

    expect(savedPath).toBe(mdPath)
    const content = fs.readFileSync(savedPath, 'utf-8')
    expect(content).toContain('# AI Perception Snapshot: Acme Corp')
  })

  it('writes a standalone PDF report', async () => {
    const pdfPath = path.join(tmpDir, 'standalone.pdf')
    const savedPath = await writeSnapshotPdf(SNAPSHOT_FIXTURE, pdfPath)

    expect(savedPath).toBe(pdfPath)
    expect(fs.readFileSync(savedPath).subarray(0, 5).toString('utf-8')).toBe('%PDF-')
  })
})
