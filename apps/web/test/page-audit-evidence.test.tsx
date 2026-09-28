import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { PageAuditEvidence, factorShareOfScoreLabel } from '../src/components/project/PageAuditEvidence.js'

afterEach(cleanup)

test('connects a page score to its exact audit findings and fixes', () => {
  render(
    <PageAuditEvidence
      audit={{
        state: 'ready',
        project: 'citypoint',
        runId: 'run_1',
        complete: true,
        termination: null,
        nodeKey: 'page_services',
        url: 'https://citypoint.example/services',
        auditState: 'complete',
        auditScore: 42,
        evidenceState: 'complete',
        factors: [
          {
            id: 'content-depth',
            name: 'Content depth',
            weight: 12,
            score: 20,
            status: 'fail',
            applicable: true,
            findings: [{ type: 'missing', code: 'content-depth.word-count.low', message: 'Only 120 words were found.' }],
            recommendations: ['Answer the key questions visitors ask on this page.'],
          },
          {
            id: 'structured-data',
            name: 'Structured data',
            weight: 10,
            score: 90,
            status: 'pass',
            applicable: true,
            findings: [{ type: 'found', code: 'structured-data.present', message: 'Valid schema was found.' }],
            recommendations: [],
          },
        ],
        criticalDefects: [{
          id: 'missing-h1',
          severity: 'critical',
          detail: 'No H1 tag was found.',
          recommendation: 'Add one descriptive H1.',
        }],
      }}
      isLoading={false}
      error={null}
      onRetry={vi.fn()}
    />,
  )

  expect(screen.getByRole('heading', { name: 'Findings and fixes for this page' })).not.toBeNull()
  expect(screen.getByLabelText('Score 42 out of 100')).not.toBeNull()
  expect(screen.getByText('No H1 tag was found.')).not.toBeNull()
  expect(screen.getByText('Not counted in the score')).not.toBeNull()
  expect(screen.getByText('Critical')).not.toBeNull()
  const factor = screen.getByText('Content depth').closest('details')
  expect(factor).not.toBeNull()
  // Checks start collapsed, so open it before asserting on what it holds.
  // jsdom keeps closed content in the DOM, so querying without this would
  // assert on markup a reader cannot actually see.
  fireEvent.click(within(factor!).getByText('Content depth'))
  expect(factor!.open).toBe(true)
  expect(within(factor!).getByText('Only 120 words were found.')).not.toBeNull()
  expect(within(factor!).getByText('Answer the key questions visitors ask on this page.')).not.toBeNull()
  expect(screen.queryByText('Structured data')).toBeNull()
})

test('every technical check starts collapsed, and opens on click', () => {
  render(
    <PageAuditEvidence
      audit={{
        state: 'ready', project: 'citypoint', runId: 'run_1', complete: true, termination: null,
        nodeKey: 'page_services', url: 'https://citypoint.example/services',
        auditState: 'complete', auditScore: 42, evidenceState: 'complete', criticalDefects: [],
        factors: [
          {
            id: 'content-depth', name: 'Content depth', weight: 12, score: 20,
            status: 'fail', applicable: true,
            findings: [{ type: 'missing', code: 'content-depth.word-count.low', message: 'Only 120 words were found.' }],
            recommendations: ['Answer the key questions visitors ask on this page.'],
          },
          {
            id: 'ai-crawler-access', name: 'AI crawler access', weight: 20, score: 55,
            status: 'partial', applicable: true,
            findings: [{ type: 'missing', code: 'ai-crawler-access.crawler.blocked', message: 'GPTBot is blocked.' }],
            recommendations: ['Allow GPTBot in robots.txt.'],
          },
        ],
      }}
      isLoading={false}
      error={null}
      onRetry={vi.fn()}
    />,
  )

  // The page opens scannable: nothing is expanded, so the viewport is a list of
  // checks rather than a wall of findings.
  const sections = Array.from(document.querySelectorAll('details'))
  expect(sections).toHaveLength(2)
  expect(sections.every((section) => section.open)).toBe(false)

  // ...and the summary row still carries everything a reader scans for, so the
  // collapse costs no information: name, score, and pass/partial/fail.
  for (const [name, score, state] of [
    ['Content depth', '20/100', 'Fail'],
    ['AI crawler access', '55/100', 'Partial'],
  ]) {
    const section = screen.getByText(name).closest('details')!
    expect(within(section).getByText(score)).not.toBeNull()
    expect(within(section).getByText(state)).not.toBeNull()
  }

  // Clicking the disclosure opens exactly that one.
  const first = screen.getByText('Content depth').closest('details')!
  fireEvent.click(within(first).getByText('Content depth'))
  expect(first.open).toBe(true)
  expect(screen.getByText('AI crawler access').closest('details')!.open).toBe(false)

  // The summary is still there once expanded: it is the row, not a placeholder
  // the expansion replaces.
  expect(within(first).getByText('Content depth')).not.toBeNull()
  expect(within(first).getByText('20/100')).not.toBeNull()
  expect(within(first).getByText('Fail')).not.toBeNull()
  expect(within(first).getByText('Only 120 words were found.')).not.toBeNull()
})

test('a critical defect stays visible without expanding anything', () => {
  // Critical defects render in their OWN always-visible section, not inside the
  // collapsed checks, so nothing that demands attention is hidden by default.
  render(
    <PageAuditEvidence
      audit={{
        state: 'ready', project: 'citypoint', runId: 'run_1', complete: true, termination: null,
        nodeKey: 'page_home', url: 'https://citypoint.example/',
        auditState: 'complete', auditScore: 42, evidenceState: 'complete',
        factors: [{
          id: 'content-depth', name: 'Content depth', weight: 12, score: 20,
          status: 'fail', applicable: true, findings: [], recommendations: [],
        }],
        criticalDefects: [{
          id: 'missing-h1', severity: 'critical',
          detail: 'No H1 tag was found.', recommendation: 'Add one descriptive H1.',
        }],
      }}
      isLoading={false}
      error={null}
      onRetry={vi.fn()}
    />,
  )

  expect(Array.from(document.querySelectorAll('details')).every((section) => section.open)).toBe(false)
  const defect = screen.getByText('No H1 tag was found.')
  expect(defect.closest('details')).toBeNull()
  expect(screen.getByText('Add one descriptive H1.').closest('details')).toBeNull()
})

test('labels legacy page evidence as scores-only instead of claiming there were no findings', () => {
  render(
    <PageAuditEvidence
      audit={{
        state: 'ready',
        project: 'citypoint',
        runId: 'run_old',
        complete: true,
        termination: null,
        nodeKey: 'page_home',
        url: 'https://citypoint.example/',
        auditState: 'complete',
        auditScore: 61,
        evidenceState: 'scores-only',
        factors: [{
          id: 'content-depth',
          name: 'Content depth',
          weight: 12,
          score: 35,
          status: 'fail',
          applicable: null,
          findings: [],
          recommendations: [],
        }],
        criticalDefects: [],
      }}
      isLoading={false}
      error={null}
      onRetry={vi.fn()}
    />,
  )

  expect(screen.getByText(/saved only the scores, not the findings/i)).not.toBeNull()
  expect(screen.getByText('Content depth')).not.toBeNull()
  expect(screen.queryByText(/No technical findings/)).toBeNull()
})

test('does not infer a clean page from a legacy scan with only passing scores', () => {
  render(
    <PageAuditEvidence
      audit={{
        state: 'ready', project: 'citypoint', runId: 'run_old', complete: true, termination: null,
        nodeKey: 'page_home', url: 'https://citypoint.example/', auditState: 'complete', auditScore: 90,
        evidenceState: 'scores-only', criticalDefects: [],
        factors: [{
          id: 'structured-data', name: 'Structured data', weight: 10, score: 90,
          status: 'pass', applicable: null, findings: [], recommendations: [],
        }],
      }}
      isLoading={false}
      error={null}
      onRetry={vi.fn()}
    />,
  )

  expect(screen.getByText(/saved only the score\. Run a new scan/i)).not.toBeNull()
  expect(screen.queryByText(/No technical findings need attention/)).toBeNull()
})

test('shows a truthful retry state when page audit evidence cannot be loaded', () => {
  const onRetry = vi.fn()
  render(<PageAuditEvidence audit={undefined} isLoading={false} error={new Error('offline')} onRetry={onRetry} />)

  expect(screen.getByRole('alert').textContent).toContain('Findings could not be loaded.')
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(onRetry).toHaveBeenCalledOnce()
})

test('renders repeated finding codes as distinct occurrences without duplicate React keys', () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

  render(
    <PageAuditEvidence
      audit={{
        state: 'ready', project: 'citypoint', runId: 'run_1', complete: true, termination: null,
        nodeKey: 'page_home', url: 'https://citypoint.example/', auditState: 'complete', auditScore: 20,
        evidenceState: 'complete', criticalDefects: [],
        factors: [{
          id: 'ai-crawler-access', name: 'AI crawler access', weight: 20, score: 20,
          status: 'fail', applicable: true, recommendations: [],
          findings: [
            { type: 'missing', code: 'ai-crawler-access.crawler.blocked', message: 'GPTBot is blocked.' },
            { type: 'missing', code: 'ai-crawler-access.crawler.blocked', message: 'ClaudeBot is blocked.' },
          ],
        }],
      }}
      isLoading={false}
      error={null}
      onRetry={vi.fn()}
    />,
  )

  expect(screen.getByText('GPTBot is blocked.')).not.toBeNull()
  expect(screen.getByText('ClaudeBot is blocked.')).not.toBeNull()
  expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key')
  consoleError.mockRestore()
})

test('says what share of the page score a check is worth, never its weight as a percent', () => {
  // Engine shares on a page with no FAQ: content depth has weight 10 but is
  // worth 9.7% of this page's score, and a check that did not record a share
  // shows no share at all.
  render(
    <PageAuditEvidence
      audit={{
        state: 'ready', project: 'citypoint', runId: 'run_1', complete: true, termination: null,
        nodeKey: 'page_services', url: 'https://citypoint.example/services',
        auditState: 'complete', auditScore: 42, evidenceState: 'complete', criticalDefects: [],
        factors: [
          {
            id: 'content-depth', name: 'Content depth', weight: 10, score: 20, sharePct: 9.7,
            status: 'fail', applicable: true, findings: [], recommendations: ['Answer the key questions.'],
          },
          {
            id: 'ai-crawler-access', name: 'AI crawler access', weight: 4, score: 55, sharePct: null,
            status: 'partial', applicable: true, findings: [], recommendations: ['Allow GPTBot.'],
          },
        ],
      }}
      isLoading={false}
      error={null}
      onRetry={vi.fn()}
    />,
  )

  const recorded = screen.getByText('Content depth').closest('details')!
  fireEvent.click(within(recorded).getByText('Content depth'))
  expect(within(recorded).getByText('Worth 9.7% of the page score')).not.toBeNull()
  expect(factorShareOfScoreLabel(9.7, 'page')).toBe('Worth 9.7% of the page score')

  const notRecorded = screen.getByText('AI crawler access').closest('details')!
  fireEvent.click(within(notRecorded).getByText('AI crawler access'))
  expect(within(notRecorded).getByText('Allow GPTBot.')).not.toBeNull()
  expect(within(notRecorded).queryByText(/of the page score/)).toBeNull()

  // Neither weight (10, 4) is printed as a percent anywhere.
  expect(document.body.textContent).not.toMatch(/(?<![\d.])(?:10|4)%/)
})
