import { afterEach, describe, expect, it, vi } from 'vitest'
import { storedIssuePages, storedIssues, unavailableIssues } from './fixtures/site-audit-issues.js'

const client = vi.hoisted(() => ({ getSiteAuditIssues: vi.fn(), getSiteAuditIssuePages: vi.fn() }))
vi.mock('../src/client.js', () => ({ createApiClient: () => client }))

import { TECHNICAL_AEO_CLI_COMMANDS } from '../src/cli-commands/technical-aeo.js'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

async function invoke(args: string[], format: 'json' | 'jsonl' | 'text' = 'json'): Promise<string> {
  let output = ''
  const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => { output += `${values.map(String).join(' ')}\n` })
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { output += String(chunk); return true })
  try {
    await dispatchRegisteredCommand(args, format, TECHNICAL_AEO_CLI_COMMANDS)
    return output
  } finally {
    log.mockRestore()
    write.mockRestore()
  }
}

describe('stored Site Health issue CLI', () => {
  it.each(['site-health', 'technical-aeo'])('%s preserves issue and page DTOs and exact scan selection', async root => {
    client.getSiteAuditIssues.mockResolvedValue(storedIssues)
    const list = await invoke([root, 'issues', 'sample-store', '--run-id', 'scan-2026-10-10', '--cursor', 'opaque-current', '--limit', '2', '--stored-only'])
    expect(JSON.parse(list)).toEqual(storedIssues)
    expect(client.getSiteAuditIssues).toHaveBeenCalledWith('sample-store', {
      runId: 'scan-2026-10-10', cursor: 'opaque-current', limit: 2, format: 'json',
    })
    client.getSiteAuditIssuePages.mockResolvedValue(storedIssuePages)
    const pages = await invoke([root, 'issue-pages', 'sample-store', '--issue-id', 'duplicate-title-sample', '--run-id', 'scan-2026-10-10', '--limit', '1', '--stored-only'])
    expect(JSON.parse(pages)).toEqual(storedIssuePages)
    expect(client.getSiteAuditIssuePages).toHaveBeenCalledWith('sample-store', 'duplicate-title-sample', {
      issueId: 'duplicate-title-sample', runId: 'scan-2026-10-10', limit: 1, cursor: undefined, format: 'json',
    })
  })

  it('keeps scan provenance and pagination on every JSONL record', async () => {
    client.getSiteAuditIssues.mockResolvedValue(storedIssues)
    const lines = (await invoke(['site-health', 'issues', 'sample-store'], 'jsonl')).trim().split('\n').map(line => JSON.parse(line))
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(line).toMatchObject({
      project: 'sample-store', runId: 'scan-2026-10-10', attemptId: 'attempt-sample',
      auditedAt: '2026-10-10T14:00:00.000Z', state: 'partial', complete: false,
      coverage: { crossPage: 'available', pagesWithoutFindingEvidence: 1, omittedFindings: 2 },
      total: 4, nextCursor: 'opaque-issues-next',
    })
    expect(lines[0]).toMatchObject({ kind: 'site-health-issues-header' })
    expect(lines[1]).toMatchObject({ kind: 'site-health-issue', id: 'duplicate-title-sample', affectedPages: 2 })
    expect(lines[0]).not.toHaveProperty('issues')

    client.getSiteAuditIssuePages.mockResolvedValue(storedIssuePages)
    const pageLines = (await invoke(['site-health', 'issue-pages', 'sample-store', '--issue-id', 'duplicate-title-sample'], 'jsonl')).trim().split('\n').map(line => JSON.parse(line))
    expect(pageLines).toHaveLength(2)
    expect(pageLines[0]).toMatchObject({ kind: 'site-health-issue-pages-header', issueId: 'duplicate-title-sample', nextCursor: 'opaque-pages-next' })
    expect(pageLines[1]).toMatchObject({
      kind: 'site-health-issue-page', issueId: 'duplicate-title-sample', runId: 'scan-2026-10-10',
      url: 'https://sample.example/alpha', recommendationsScope: 'factor', recommendationsTruncated: true,
    })
  })

  it('prints an explicit unavailable JSONL header even when no findings were retained', async () => {
    client.getSiteAuditIssues.mockResolvedValue(unavailableIssues)
    const lines = (await invoke(['site-health', 'issues', 'sample-store'], 'jsonl')).trim().split('\n').map(line => JSON.parse(line))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ state: 'unavailable', total: null, nextCursor: null, coverage: { pageFindings: 'unavailable', crossPage: 'unavailable' } })
  })

  it('makes partial and unavailable coverage visible in human output', async () => {
    client.getSiteAuditIssues.mockResolvedValue(storedIssues)
    const partial = await invoke(['site-health', 'issues', 'sample-store'], 'text')
    expect(partial).toContain('audited 2026-10-10T14:00:00.000Z')
    expect(partial).toContain('Evidence: partial · crawl partial (max-pages)')
    expect(partial).toContain('1 audited page(s) lack finding evidence; 2 malformed or uncoded finding(s) omitted.')
    expect(partial).toContain('[advisory] title.duplicate · 2 page(s)')
    expect(partial).toContain('Next cursor: opaque-issues-next')
    client.getSiteAuditIssues.mockResolvedValue(unavailableIssues)
    const unavailable = await invoke(['site-health', 'issues', 'sample-store'], 'text')
    expect(unavailable).toContain('Evidence: unavailable')
    expect(unavailable).toContain('Total in this stored selection: unknown.')
    expect(unavailable).not.toContain('No issues')
  })

  it('labels recommendations as factor guidance rather than issue-specific fixes', async () => {
    client.getSiteAuditIssuePages.mockResolvedValue(storedIssuePages)
    const output = await invoke(['site-health', 'issue-pages', 'sample-store', '--issue-id', 'duplicate-title-sample'], 'text')
    expect(output).toContain('Guidance for this page’s whole factor (not issue-specific):')
    expect(output).toContain('Review titles and descriptions for this page.')
    expect(output).toContain('Additional guidance was omitted')
  })

  it('shows critical defect severity and labels its recommendation as issue-specific', async () => {
    const defectPage = { ...storedIssuePages.pages[0]!, message: 'Page declares noindex.',
      recommendations: ['Review whether this page should allow indexing.'],
      recommendationsScope: 'issue', recommendationsTruncated: false }
    client.getSiteAuditIssues.mockResolvedValue({
      ...storedIssues, total: 1, nextCursor: null,
      issues: [{ ...storedIssues.issues[0], source: 'critical-defect', severity: 'critical',
        id: 'defect-noindex', code: 'robots.noindex', findingType: 'missing', disposition: 'actionable',
        affectedPages: 1, message: 'Page declares noindex.', examples: [defectPage], examplesTruncated: false }],
    })
    const list = await invoke(['site-health', 'issues', 'sample-store'], 'text')
    expect(list).toContain('[actionable · critical] robots.noindex · 1 page(s)')
    client.getSiteAuditIssuePages.mockResolvedValue({
      ...storedIssuePages, issueId: 'defect-noindex', total: 1, nextCursor: null, pages: [defectPage],
    })
    const detail = await invoke(['site-health', 'issue-pages', 'sample-store', '--issue-id', 'defect-noindex'], 'text')
    expect(detail).toContain('Guidance for this issue:')
    expect(detail).toContain('Review whether this page should allow indexing.')
    expect(detail).not.toContain('whole factor')
  })

  it.each(['0', '101', '2.5', '2junk'])('rejects invalid --limit %s before reading evidence', async limit => {
    await expect(invoke(['site-health', 'issues', 'sample-store', '--limit', limit])).rejects.toMatchObject({ code: 'CLI_USAGE_ERROR' })
    expect(client.getSiteAuditIssues).not.toHaveBeenCalled()
  })

  it('requires an issue identity and names the invoked alias in the error', async () => {
    await expect(invoke(['site-health', 'issue-pages', 'sample-store'])).rejects.toMatchObject({
      code: 'CLI_USAGE_ERROR', details: { command: 'site-health.issue-pages' },
    })
    expect(client.getSiteAuditIssuePages).not.toHaveBeenCalled()
  })
})
