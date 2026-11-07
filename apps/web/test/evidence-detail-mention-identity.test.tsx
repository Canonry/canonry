import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { CitationStates, VisibilityStates } from '@canonry/canonry-contracts'

import { EvidenceDetailModal } from '../src/components/layout/EvidenceDetailModal.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(cleanup)

const REASON = 'The answer uses your name, but sentiment found it is about something else, so it does not count as a mention.'

test('an answer whose name match sentiment judged wrong-subject reads as a different subject, with the reason', () => {
  const project = createDashboardFixture({}).dashboard.projects[0]!
  render(<EvidenceDetailModal project={project} onClose={() => {}} evidence={{
    ...project.visibilityEvidence[0]!,
    answerSnippet: 'Acme Hardware on Main Street sells lumber.',
    answerMentioned: false,
    visibilityState: 'not-visible',
    matchedTerms: ['Acme'],
    mentionIdentity: 'wrong-subject',
    runHistory: [],
  }} />)

  const dialog = within(screen.getByRole('dialog'))
  // The status says why the name does not count, in the hero and beside the mention status.
  expect(dialog.getAllByText('Different subject')).toHaveLength(2)
  expect(dialog.getByText(REASON)).toBeTruthy()
  expect(dialog.getByRole('button', { name: REASON })).toBeTruthy()
  expect(dialog.getByText('Not mentioned')).toBeTruthy()
  // The matched name stays visible as evidence.
  expect(dialog.getByText('Acme', { selector: '.mention-chip' })).toBeTruthy()
})


test.each([
  { mode: 'current', citationState: CitationStates.cited },
  { mode: 'current', citationState: CitationStates['not-cited'] },
  { mode: 'auto-fetched', citationState: CitationStates.cited },
  { mode: 'historical', citationState: CitationStates.cited },
] as const)('$mode $citationState evidence without a mention assessment remains unmeasured', async ({ mode, citationState }) => {
  const project = createDashboardFixture().dashboard.projects[0]!
  const seed = project.visibilityEvidence[0]!
  const source = 'https://example.com/recorded-source'
  onTestFinished(mockFetch(() => jsonResponse({ snapshots: [{
    query: seed.query, provider: seed.provider,
    citationState,
    answerText: 'Recorded answer without a mention assessment.',
    citedDomains: ['example.com'], citedUrls: [source], groundingSources: [], searchQueries: [],
  }] })))
  render(<EvidenceDetailModal project={project} onClose={() => {}} evidence={{
    ...seed, citationState,
    answerSnippet: mode === 'auto-fetched' ? '' : mode === 'historical' ? 'Latest measured answer.' : 'Recorded answer without a mention assessment.',
    answerMentioned: mode === 'historical' ? true : undefined,
    visibilityState: mode === 'historical' ? VisibilityStates.visible : undefined,
    matchedTerms: [], mentionIdentity: null,
    citedDomains: ['example.com'], evidenceUrls: [source], groundingSources: [],
    runHistory: mode === 'current' ? [] : [
      { runId: 'earlier', createdAt: '2026-09-01T12:00:00Z', citationState },
      { runId: 'latest', createdAt: '2026-09-28T12:00:00Z', citationState },
    ],
  }} />)
  if (mode === 'historical') {
    const history = screen.getAllByRole('button', { name: /^Run .*Mention not measured/ })
    expect(history).toHaveLength(2)
    fireEvent.click(history[0]!)
  }
  await screen.findByText('Recorded answer without a mention assessment.')
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByText('This answer has no recorded mention assessment')).toBeTruthy()
  expect(dialog.getByText('Mention not measured', { selector: '.mention-status-label' })).toBeTruthy()
  expect(dialog.queryByText('Not mentioned')).toBeNull()
  expect(dialog.queryByText('Mentioned')).toBeNull()
  expect(dialog.queryByText('None of these appear in the answer text.')).toBeNull()
  fireEvent.click(dialog.getByRole('button', { name: 'Sources', exact: true }))
  expect(dialog.getByRole('link', { name: source }).getAttribute('href')).toBe(source)
})

test.each([
  { answerMentioned: false, visibilityState: VisibilityStates.visible, expected: 'Not mentioned', absent: 'Mentioned' },
  { answerMentioned: true, visibilityState: VisibilityStates['not-visible'], expected: 'Mentioned', absent: 'Not mentioned' },
])('the recorded boolean $answerMentioned wins over a stale legacy mention state', ({ answerMentioned, visibilityState, expected, absent }) => {
  const project = createDashboardFixture().dashboard.projects[0]!
  render(<EvidenceDetailModal project={project} onClose={() => {}} evidence={{
    ...project.visibilityEvidence[0]!, answerSnippet: 'An independently assessed answer.',
    citationState: answerMentioned ? CitationStates['not-cited'] : CitationStates.cited,
    answerMentioned, visibilityState, mentionIdentity: null, runHistory: [],
  }} />)
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByText(expected)).toBeTruthy()
  expect(dialog.queryByText(absent)).toBeNull()
})
