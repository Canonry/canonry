import { describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  triggerSiteAudit: vi.fn(),
  getTechnicalAeoProgress: vi.fn(),
  getTechnicalAeoCrawl: vi.fn(),
  getTechnicalAeoCrawlPages: vi.fn(),
  getTechnicalAeoPageAudit: vi.fn(),
  getTechnicalAeoScore: vi.fn(),
  getTechnicalAeoStructure: vi.fn(),
  getTechnicalAeoInternalLinks: vi.fn(),
  getTechnicalAeoInternalLinkNeighbors: vi.fn(),
  getTechnicalAeoDeadLinks: vi.fn(),
  getSiteHealthSubgraph: vi.fn(),
  getSiteHealthPath: vi.fn(),
  getSiteHealthChanges: vi.fn(),
}))

vi.mock('../src/client.js', () => ({
  createApiClient: () => mocked,
}))

import { TECHNICAL_AEO_CLI_COMMANDS } from '../src/cli-commands/technical-aeo.js'
import {
  technicalAeoChanges,
  technicalAeoCrawlPages,
  technicalAeoDeadLinks,
  technicalAeoInternalLinks,
  technicalAeoPageAudit,
  technicalAeoProgress,
  technicalAeoScore,
  technicalAeoStructure,
} from '../src/commands/technical-aeo.js'

function command(path: string[]) {
  const spec = TECHNICAL_AEO_CLI_COMMANDS.find((candidate) => candidate.path.join(' ') === path.join(' '))
  expect(spec, path.join(' ')).toBeTruthy()
  return spec!
}

function captureStdout(fn: () => Promise<void>): { run: Promise<void>; lines: () => string[] } {
  let output = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    output += String(chunk)
    return true
  })
  return {
    run: fn().finally(() => spy.mockRestore()),
    lines: () => output.split('\n').filter(Boolean),
  }
}

/**
 * Human-format commands print through `console.log`, not `process.stdout`, so
 * `captureStdout` never sees them. Lines are collected as they are written:
 * `mockRestore()` clears `mock.calls`, so reading them afterwards yields
 * nothing and every assertion silently passes against empty output.
 */
async function captureConsole(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(String(args[0])) })
  try {
    await fn()
  } finally {
    spy.mockRestore()
  }
  return lines
}

describe('Technical AEO full-crawl CLI', () => {
  it('leaves omitted budgets for the API to normalize into the shared default identity', async () => {
    mocked.triggerSiteAudit.mockResolvedValue({ runId: 'run-defaults', status: 'queued' })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await command(['technical-aeo', 'run']).run({
        positionals: ['acme'],
        values: { wait: false },
        format: 'json',
        dryRun: false,
      })
    } finally {
      log.mockRestore()
    }

    expect(mocked.triggerSiteAudit).toHaveBeenLastCalledWith('acme', expect.objectContaining({
      limit: undefined,
      maxPages: undefined,
      maxEdges: undefined,
      checkDeadLinks: false,
    }))
  })

  it('keeps dead-link checks off unless --check-dead-links is explicitly supplied', async () => {
    mocked.triggerSiteAudit.mockResolvedValue({ runId: 'run-1', status: 'queued' })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await command(['technical-aeo', 'run']).run({
        positionals: ['acme'],
        values: { 'max-pages': '50000', 'max-edges': '1000000', 'max-depth': '12', wait: false },
        format: 'json',
        dryRun: false,
      })
    } finally {
      log.mockRestore()
    }

    expect(mocked.triggerSiteAudit).toHaveBeenLastCalledWith('acme', {
      sitemapUrl: undefined,
      limit: undefined,
      maxPages: 50_000,
      maxEdges: 1_000_000,
      maxDepth: 12,
      checkDeadLinks: false,
    })
  })

  it('registers bounded graph reads under Technical AEO and Site Health aliases', () => {
    expect(TECHNICAL_AEO_CLI_COMMANDS.map((spec) => spec.path.join(' '))).toEqual(expect.arrayContaining([
      'technical-aeo crawl',
      'technical-aeo progress',
      'technical-aeo crawl-pages',
      'technical-aeo page-audit',
      'technical-aeo structure',
      'technical-aeo links',
      'technical-aeo links neighbors',
      'technical-aeo dead-links',
      'technical-aeo subgraph',
      'technical-aeo path',
      'technical-aeo changes',
      'site-health overview',
      'site-health pages',
      'site-health page-audit',
      'site-health structure',
      'site-health links',
      'site-health neighbors',
      'site-health dead-links',
      'site-health subgraph',
      'site-health path',
      'site-health changes',
    ]))
  })

  it('requires an exact run ID for Site Health progress', async () => {
    await expect(command(['technical-aeo', 'progress']).run({
      positionals: ['acme'],
      values: {},
      format: 'json',
      dryRun: false,
    })).rejects.toMatchObject({
      code: 'CLI_USAGE_ERROR',
      message: '--run-id is required',
      displayMessage: expect.stringContaining(
        'Usage: canonry technical-aeo progress <project> --run-id <id> [--format json]',
      ),
    })
    expect(mocked.getTechnicalAeoProgress).not.toHaveBeenCalled()
  })

  it('prints exact stored Site Health progress as JSON', async () => {
    const progress = {
      project: 'acme',
      runId: 'run-1',
      status: 'running',
      phase: 'checking',
      attempt: {
        id: 'attempt-1', state: 'running', pagesDiscovered: 42, pagesFetched: 17,
        pagesEligible: 12, pagesErrored: 1, edgesDiscovered: 88,
        lastUpdatedAt: '2026-08-09T12:00:00.000Z', startedAt: '2026-08-09T11:59:00.000Z',
        finishedAt: null, error: null,
      },
      layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
      error: null,
    }
    mocked.getTechnicalAeoProgress.mockResolvedValue(progress)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await command(['technical-aeo', 'progress']).run({
        positionals: ['acme'],
        values: { 'run-id': 'run-1' },
        format: 'json',
        dryRun: false,
      })
      expect(log).toHaveBeenCalledWith(JSON.stringify(progress, null, 2))
    } finally {
      log.mockRestore()
    }
    expect(mocked.getTechnicalAeoProgress).toHaveBeenCalledWith('acme', 'run-1')
  })

  it('renders durable progress counters without inventing a percentage', async () => {
    mocked.getTechnicalAeoProgress.mockResolvedValue({
      project: 'acme',
      runId: 'run-1',
      status: 'running',
      phase: 'checking',
      attempt: {
        id: 'attempt-1', state: 'running', pagesDiscovered: 42, pagesFetched: 17,
        pagesEligible: 12, pagesErrored: 1, edgesDiscovered: 88,
        lastUpdatedAt: '2026-08-09T12:00:00.000Z', startedAt: '2026-08-09T11:59:00.000Z',
        finishedAt: null, error: null,
      },
      layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
      error: null,
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await technicalAeoProgress('acme', { runId: 'run-1' })
      const output = String(log.mock.calls[0]?.[0])
      expect(output).toContain('Site Health progress: checking (running)')
      expect(output).toContain('Pages: 42 found · 17 checked · 1 failed')
      expect(output).toContain('Eligible: 12 · Links found: 88')
      expect(output).not.toContain('%')
    } finally {
      log.mockRestore()
    }
  })

  it('requires exactly one page selector for page audit evidence', async () => {
    await expect(command(['technical-aeo', 'page-audit']).run({
      positionals: ['acme'],
      values: {},
      format: 'json',
      dryRun: false,
    })).rejects.toMatchObject({
      code: 'CLI_USAGE_ERROR',
      message: '--node-key or --url is required',
    })

    await expect(command(['site-health', 'page-audit']).run({
      positionals: ['acme'],
      values: { 'node-key': 'page:guide', url: 'https://acme.test/guide' },
      format: 'json',
      dryRun: false,
    })).rejects.toMatchObject({
      code: 'CLI_USAGE_ERROR',
      message: '--node-key and --url cannot be combined',
      displayMessage: expect.stringContaining('Usage: canonry site-health page-audit <project>'),
    })
    expect(mocked.getTechnicalAeoPageAudit).not.toHaveBeenCalled()
  })

  it('renders one page score with its exact findings and scan provenance', async () => {
    mocked.getTechnicalAeoPageAudit.mockResolvedValue({
      state: 'ready',
      project: 'acme',
      runId: 'run-1',
      complete: false,
      termination: 'max-pages',
      nodeKey: 'page:guide',
      url: 'https://acme.test/guide',
      auditState: 'success',
      auditScore: 42,
      evidenceState: 'complete',
      factors: [{
        id: 'content-depth',
        name: 'Content Depth',
        weight: 12,
        score: 20,
        status: 'fail',
        applicable: true,
        findings: [{
          type: 'missing',
          code: 'content-depth.word-count.low',
          message: 'Low content depth (120 words).',
        }],
        recommendations: ['Add comprehensive copy.'],
      }],
      criticalDefects: [],
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await technicalAeoPageAudit('acme', { nodeKey: 'page:guide', runId: 'run-1' })
      expect(log).toHaveBeenCalledWith(expect.stringContaining('content-depth.word-count.low'))
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Partial crawl: max-pages'))
    } finally {
      log.mockRestore()
    }
    expect(mocked.getTechnicalAeoPageAudit).toHaveBeenCalledWith('acme', {
      runId: 'run-1',
      nodeKey: 'page:guide',
      url: undefined,
    })
  })

  it('labels score-independent defects and prints each defect severity', async () => {
    mocked.getTechnicalAeoPageAudit.mockResolvedValue({
      state: 'ready',
      project: 'acme',
      runId: 'run-1',
      complete: true,
      termination: null,
      nodeKey: 'page:guide',
      url: 'https://acme.test/guide',
      auditState: 'success',
      auditScore: 84,
      evidenceState: 'complete',
      factors: [],
      criticalDefects: [
        {
          id: 'robots-blocked',
          severity: 'critical',
          detail: 'AI crawlers are blocked.',
          recommendation: 'Allow supported AI crawlers.',
        },
        {
          id: 'missing-llms-txt',
          severity: 'warning',
          detail: 'llms.txt is missing.',
          recommendation: 'Publish llms.txt.',
        },
      ],
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await technicalAeoPageAudit('acme', { nodeKey: 'page:guide', runId: 'run-1' })
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Score-independent defects:'))
      expect(log).toHaveBeenCalledWith(expect.stringContaining('[critical] [robots-blocked] AI crawlers are blocked.'))
      expect(log).toHaveBeenCalledWith(expect.stringContaining('[warning] [missing-llms-txt] llms.txt is missing.'))
    } finally {
      log.mockRestore()
    }
  })

  it('renders every page-audit availability state without inventing evidence', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      mocked.getTechnicalAeoPageAudit.mockResolvedValueOnce({
        state: 'no-crawl',
        project: 'acme',
        runId: null,
      })
      await technicalAeoPageAudit('acme', { nodeKey: 'page:guide' })
      expect(log).toHaveBeenLastCalledWith(expect.stringContaining('No persisted Site Health crawl'))

      mocked.getTechnicalAeoPageAudit.mockResolvedValueOnce({
        state: 'details-unavailable',
        project: 'acme',
        runId: 'run-old',
        complete: false,
        termination: 'max-pages',
      })
      await technicalAeoPageAudit('acme', { nodeKey: 'page:guide', runId: 'run-old' })
      expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/details are unavailable[\s\S]*Run: run-old · partial[\s\S]*Partial crawl: max-pages/))

      mocked.getTechnicalAeoPageAudit.mockResolvedValueOnce({
        state: 'not-found',
        project: 'acme',
        runId: 'run-2',
        complete: true,
        termination: null,
      })
      await technicalAeoPageAudit('acme', { url: 'https://acme.test/missing', runId: 'run-2' })
      expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/not found[\s\S]*Run: run-2 · complete/))

      mocked.getTechnicalAeoPageAudit.mockResolvedValueOnce({
        state: 'not-audited',
        project: 'acme',
        runId: 'run-2',
        complete: true,
        termination: null,
        nodeKey: 'page:asset',
        url: 'https://acme.test/image.png',
        auditState: 'ineligible',
        auditScore: null,
        factors: [],
        criticalDefects: [],
      })
      await technicalAeoPageAudit('acme', { nodeKey: 'page:asset', runId: 'run-2' })
      expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/not scored[\s\S]*page state is ineligible/))
    } finally {
      log.mockRestore()
    }
  })

  it('requires a page selector before calling the bounded neighbors endpoint', async () => {
    await expect(command(['technical-aeo', 'links', 'neighbors']).run({
      positionals: ['acme'],
      values: {},
      format: 'json',
      dryRun: false,
    })).rejects.toMatchObject({
      code: 'CLI_USAGE_ERROR',
      message: '--node-key or --url is required',
    })
    expect(mocked.getTechnicalAeoInternalLinkNeighbors).not.toHaveBeenCalled()
  })

  it('uses Site Health usage in alias handler errors', async () => {
    await expect(command(['site-health', 'path']).run({
      positionals: ['acme'],
      values: {},
      format: 'json',
      dryRun: false,
    })).rejects.toMatchObject({
      code: 'CLI_USAGE_ERROR',
      message: '--to-node-key or --to-url is required',
      displayMessage: expect.stringContaining('Usage: canonry site-health path <project>'),
      details: expect.objectContaining({
        command: 'site-health.path',
        usage: expect.stringContaining('canonry site-health path <project>'),
      }),
    })
  })

  it('writes a JSONL header for completed dead-link checks with zero findings', async () => {
    mocked.getTechnicalAeoDeadLinks.mockResolvedValue({
      project: 'acme',
      runId: 'run-1',
      state: 'complete',
      checkDeadLinks: true,
      checked: 12,
      found: 0,
      unverified: 0,
      total: 0,
      nextCursor: null,
      deadLinks: [],
    })

    const output = captureStdout(() => technicalAeoDeadLinks('acme', { format: 'jsonl' }))
    await output.run

    expect(output.lines().map((line) => JSON.parse(line))).toEqual([
      {
        kind: 'technical-aeo-dead-links-header',
        project: 'acme',
        runId: 'run-1',
        state: 'complete',
        checkDeadLinks: true,
        checked: 12,
        found: 0,
        unverified: 0,
        total: 0,
        nextCursor: null,
      },
    ])
  })

  it('names unchecked links as unchecked, and never counts them as broken', async () => {
    // The reported shape: nothing was broken, six links could not be reached.
    // "0 found" alone would read as a clean bill of health the scan cannot give.
    mocked.getTechnicalAeoDeadLinks.mockResolvedValue({
      project: 'acme',
      runId: 'run-1',
      state: 'complete',
      checkDeadLinks: true,
      checked: 193,
      found: 0,
      unverified: 6,
      total: 0,
      nextCursor: null,
      deadLinks: [],
    })

    const text = (await captureConsole(() => technicalAeoDeadLinks('acme', {}))).join('\n')

    expect(text).toContain('Dead links: 0 found from 193 checked (complete)')
    expect(text).toContain('6 links could not be checked')
    expect(text).not.toContain('6 found')
  })

  it('says nothing about unchecked links when every link was checked', async () => {
    mocked.getTechnicalAeoDeadLinks.mockResolvedValue({
      project: 'acme',
      runId: 'run-1',
      state: 'complete',
      checkDeadLinks: true,
      checked: 193,
      found: 0,
      unverified: 0,
      total: 0,
      nextCursor: null,
      deadLinks: [],
    })

    const text = (await captureConsole(() => technicalAeoDeadLinks('acme', {}))).join('\n')

    expect(text).not.toContain('could not be checked')
  })

  it('preserves crawl-page pagination metadata in JSONL', async () => {
    mocked.getTechnicalAeoCrawlPages.mockResolvedValue({
      project: 'acme',
      runId: 'run-1',
      total: 2,
      nextCursor: 'page-2',
      pages: [{ url: 'https://acme.test/', nodeKey: 'page:root' }],
    })

    const output = captureStdout(() => technicalAeoCrawlPages('acme', { format: 'jsonl' }))
    await output.run

    expect(output.lines().map((line) => JSON.parse(line))).toEqual([
      {
        kind: 'technical-aeo-crawl-pages-header',
        project: 'acme',
        runId: 'run-1',
        total: 2,
        nextCursor: 'page-2',
      },
      { project: 'acme', runId: 'run-1', url: 'https://acme.test/', nodeKey: 'page:root' },
    ])
  })

  it('preserves structure pagination metadata in JSONL', async () => {
    mocked.getTechnicalAeoStructure.mockResolvedValue({
      project: 'acme',
      runId: 'run-1',
      parentPath: '/guides',
      total: 2,
      nextCursor: 'path-2',
      children: [{ path: '/guides/a', pageCount: 1, inventoryEligibleCount: 1 }],
    })

    const output = captureStdout(() => technicalAeoStructure('acme', { format: 'jsonl' }))
    await output.run

    expect(output.lines().map((line) => JSON.parse(line))).toEqual([
      {
        kind: 'technical-aeo-structure-header',
        project: 'acme',
        runId: 'run-1',
        parentPath: '/guides',
        returned: 1,
        nextCursor: 'path-2',
      },
      {
        project: 'acme',
        runId: 'run-1',
        parentPath: '/guides',
        path: '/guides/a',
        pageCount: 1,
        inventoryEligibleCount: 1,
      },
    ])
  })

  it('preserves internal-link pagination metadata in JSONL', async () => {
    mocked.getTechnicalAeoInternalLinks.mockResolvedValue({
      project: 'acme',
      runId: 'run-1',
      total: 2,
      nextCursor: 'link-2',
      edges: [{ sourceUrl: 'https://acme.test/', targetUrl: 'https://acme.test/a', followable: true, occurrences: 1 }],
    })

    const output = captureStdout(() => technicalAeoInternalLinks('acme', { format: 'jsonl' }))
    await output.run

    expect(output.lines().map((line) => JSON.parse(line))).toEqual([
      {
        kind: 'technical-aeo-internal-links-header',
        project: 'acme',
        runId: 'run-1',
        total: 2,
        nextCursor: 'link-2',
      },
      {
        project: 'acme',
        runId: 'run-1',
        sourceUrl: 'https://acme.test/',
        targetUrl: 'https://acme.test/a',
        followable: true,
        occurrences: 1,
      },
    ])
  })

  it('preserves scan IDs and continuation metadata for paged Site Health changes in JSONL', async () => {
    mocked.getSiteHealthChanges.mockResolvedValue({
      project: 'acme',
      state: 'ready',
      fromRunId: 'run-before',
      toRunId: 'run-after',
      versions: { crawlSchema: '1', normalization: '1', indexability: '1', linkScore: '1' },
      filters: { scope: 'all', change: 'all' },
      summaryState: 'exact',
      summary: {
        pages: { added: 1, removed: 0, changed: 2 },
        links: { added: 3, removed: 4, changed: 5 },
      },
      total: 10,
      nextCursor: 'changes-2',
      changes: [{ entity: 'page', change: 'added', key: 'page:/new', changedFields: [], before: null, after: null }],
    })

    const output = captureStdout(() => technicalAeoChanges('acme', { format: 'jsonl' }))
    await output.run

    const rows = output.lines().map((line) => JSON.parse(line))
    expect(rows[0]).toMatchObject({
      kind: 'site-health-changes-header',
      project: 'acme',
      state: 'ready',
      fromRunId: 'run-before',
      toRunId: 'run-after',
      total: 10,
      nextCursor: 'changes-2',
      filters: { scope: 'all', change: 'all' },
      summaryState: 'exact',
    })
    expect(rows[1]).toMatchObject({
      project: 'acme',
      fromRunId: 'run-before',
      toRunId: 'run-after',
      entity: 'page',
      change: 'added',
      key: 'page:/new',
    })
  })

  it('preserves filters and nullable continuation metadata in JSONL', async () => {
    mocked.getSiteHealthChanges.mockResolvedValue({
      project: 'acme',
      state: 'ready',
      fromRunId: 'run-before',
      toRunId: 'run-after',
      versions: { crawlSchema: '1', normalization: '1', indexability: '1', linkScore: '1' },
      filters: { scope: 'pages', change: 'changed' },
      summaryState: 'omitted-on-continuation',
      summary: null,
      total: null,
      nextCursor: null,
      changes: [{
        entity: 'page',
        change: 'changed',
        key: 'page:/pricing',
        changedFields: ['inventoryEligible'],
        before: { url: 'https://acme.test/pricing' },
        after: { url: 'https://acme.test/pricing' },
      }],
    })

    const output = captureStdout(() => technicalAeoChanges('acme', { cursor: 'changes-2', format: 'jsonl' }))
    await output.run

    const rows = output.lines().map((line) => JSON.parse(line))
    expect(rows[0]).toMatchObject({
      kind: 'site-health-changes-header',
      filters: { scope: 'pages', change: 'changed' },
      summaryState: 'omitted-on-continuation',
      summary: null,
      total: null,
      nextCursor: null,
    })
    expect(rows[1]).toMatchObject({
      entity: 'page',
      change: 'changed',
      key: 'page:/pricing',
      changedFields: ['inventoryEligible'],
    })
  })

  it('renders continuation records without assuming an exact summary', async () => {
    mocked.getSiteHealthChanges.mockResolvedValue({
      project: 'acme',
      state: 'ready',
      fromRunId: 'run-before',
      toRunId: 'run-after',
      versions: { crawlSchema: '1', normalization: '1', indexability: '1', linkScore: '1' },
      filters: { scope: 'links', change: 'added' },
      summaryState: 'omitted-on-continuation',
      summary: null,
      total: null,
      nextCursor: null,
      changes: [{
        entity: 'link',
        change: 'added',
        key: 'link:pricing-to-contact',
        changedFields: [],
        before: null,
        after: { sourceUrl: 'https://acme.test/pricing', targetUrl: 'https://acme.test/contact' },
      }],
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await technicalAeoChanges('acme', { cursor: 'changes-2' })
      expect(log).toHaveBeenCalledWith(expect.stringContaining('link added: https://acme.test/pricing → https://acme.test/contact'))
    } finally {
      log.mockRestore()
    }
  })

  it('forwards an individually selected scan ID for Site Health changes', async () => {
    mocked.getSiteHealthChanges.mockClear()
    mocked.getSiteHealthChanges.mockResolvedValue({
      project: 'acme',
      state: 'unavailable',
      reason: 'insufficient-history',
      fromRunId: null,
      toRunId: 'run-after',
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await command(['technical-aeo', 'changes']).run({
        positionals: ['acme'],
        values: { 'to-run-id': 'run-after' },
        format: 'json',
        dryRun: false,
      })
    } finally {
      log.mockRestore()
    }

    expect(mocked.getSiteHealthChanges).toHaveBeenCalledWith('acme', {
      fromRunId: undefined,
      toRunId: 'run-after',
      scope: undefined,
      change: undefined,
      cursor: undefined,
      limit: undefined,
      format: 'json',
    })
  })
})

/**
 * The sixteen core factors with the share of the score the audit engine
 * records when all of them apply. The weights sum to 111, so a weight printed
 * with a percent sign overstates every factor; the shares add up to 100.
 */
const CORE_FACTOR_SHARES = [
  ['Structured Data (JSON-LD)', 12, 10.9, '10.9%'],
  ['Content Depth', 10, 9, '9.0%'],
  ['Citations & Authority Signals', 8, 7.2, '7.2%'],
  ['E-E-A-T Signals', 8, 7.2, '7.2%'],
  ['FAQ Content', 8, 7.2, '7.2%'],
  ['Schema Completeness', 8, 7.2, '7.2%'],
  ['Content Freshness', 7, 6.3, '6.3%'],
  ['Entity Consistency', 7, 6.3, '6.3%'],
  ['Content Extractability', 6, 5.4, '5.4%'],
  ['Definition Blocks', 6, 5.4, '5.4%'],
  ['Named Entities', 6, 5.4, '5.4%'],
  ['Snippet Eligibility', 6, 5.4, '5.4%'],
  ['AI Access Files (llms.txt, sitemap)', 5, 4.5, '4.5%'],
  ['Schema Validity', 5, 4.5, '4.5%'],
  ['Technical SEO', 5, 4.5, '4.5%'],
  ['AI Crawler Access', 4, 3.6, '3.6%'],
] as const

/** A weight printed as a percent: `12%`, but not the `2%` inside `7.2%`. */
const WEIGHT_AS_PERCENT = /(?<![\d.])(?:1[02]|[4-8])%/

function coreScore(recorded: boolean) {
  return {
    project: 'acme', hasData: true, runId: 'run-1', runStatus: 'completed',
    sitemapUrl: 'https://acme.test/sitemap.xml', auditedAt: '2026-09-20T12:00:00.000Z',
    aggregateScore: 84, pagesDiscovered: 40, pagesAudited: 39, pagesSkipped: 1, pagesErrored: 0,
    deltaScore: null, trend: null, previousScore: null, previousAuditedAt: null,
    factors: CORE_FACTOR_SHARES.map(([name, weight, sharePct]) => ({
      id: name.toLowerCase().replace(/[^a-z]+/g, '-'), name, weight,
      sharePct: recorded ? sharePct : null,
      avgScore: 84, status: 'pass', pagesPassing: 39, pagesPartial: 0, pagesFailing: 0,
    })),
    crossCuttingIssues: [],
    prioritizedFixes: [],
  }
}

describe('Technical AEO factor shares in the CLI', () => {
  it('prints each factor share of the site score, and the shares add up to 100%', async () => {
    mocked.getTechnicalAeoScore.mockResolvedValue(coreScore(true))
    const [output] = await captureConsole(() => technicalAeoScore('acme', {}))
    const lines = output!.split('\n')
    const header = lines.find((line) => line.startsWith('Factor'))!
    expect(header).toMatch(/Factor\s+Share\s+Avg\s+Status\s+Pass\/Part\/Fail/)
    expect(header).not.toMatch(/\bWt\b/)

    const shown = CORE_FACTOR_SHARES.map(([name, , , formatted]) => {
      const row = lines.find((line) => line.startsWith(name.slice(0, 31)))!
      expect(row.slice(32).trim().split(/\s+/)[0], name).toBe(formatted)
      return Number.parseFloat(formatted)
    })
    expect(Number(shown.reduce((sum, share) => sum + share, 0).toFixed(1))).toBe(100)
    expect(output).not.toMatch(WEIGHT_AS_PERCENT)
  })

  it('prints a dash, never the weight, for a scan that did not record shares', async () => {
    mocked.getTechnicalAeoScore.mockResolvedValue(coreScore(false))
    const [output] = await captureConsole(() => technicalAeoScore('acme', {}))
    for (const [name] of CORE_FACTOR_SHARES) {
      const row = output!.split('\n').find((line) => line.startsWith(name.slice(0, 31)))!
      expect(row.slice(32).trim().split(/\s+/)[0], name).toBe('—')
    }
    expect(output).not.toMatch(WEIGHT_AS_PERCENT)
  })

  it('returns the share and the weight side by side in JSON', async () => {
    mocked.getTechnicalAeoScore.mockResolvedValue(coreScore(true))
    const [output] = await captureConsole(() => technicalAeoScore('acme', { format: 'json' }))
    const parsed = JSON.parse(output!) as { factors: Array<{ name: string; weight: number; sharePct: number | null }> }
    expect(parsed.factors.map(({ name, weight, sharePct }) => [name, weight, sharePct]))
      .toEqual(CORE_FACTOR_SHARES.map(([name, weight, sharePct]) => [name, weight, sharePct]))
  })

  it('prints what share of the page score each audited factor is worth, and nothing when unrecorded', async () => {
    mocked.getTechnicalAeoPageAudit.mockResolvedValue({
      state: 'ready', project: 'acme', runId: 'run-1', complete: true, termination: null,
      nodeKey: 'page:guide', url: 'https://acme.test/guide', auditState: 'success', auditScore: 42,
      evidenceState: 'complete', criticalDefects: [],
      factors: [
        {
          id: 'content-depth', name: 'Content Depth', weight: 10, score: 20, sharePct: 9.7,
          status: 'fail', applicable: true, findings: [], recommendations: [],
        },
        {
          id: 'ai-crawler-access', name: 'AI Crawler Access', weight: 4, score: 55, sharePct: null,
          status: 'partial', applicable: true, findings: [], recommendations: [],
        },
      ],
    })
    const [output] = await captureConsole(() => technicalAeoPageAudit('acme', { nodeKey: 'page:guide' }))
    const lines = output!.split('\n')
    expect(lines).toContain('  Content Depth: 20/100 (fail) · worth 9.7% of the page score')
    expect(lines).toContain('  AI Crawler Access: 55/100 (partial)')
    expect(output).not.toMatch(/(?<![\d.])(?:10|4)%/)
  })
})
