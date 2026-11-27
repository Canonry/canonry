import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { VisibilityStates } from '@canonry/canonry-contracts'

import { EVIDENCE_EMPTY_COPY, EvidenceDetailModal } from '../src/components/layout/EvidenceDetailModal.js'
import { createDashboardFixture } from '../src/mock-data.js'
import type { CitationInsightVm, RunHistoryPoint } from '../src/view-models.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(cleanup)

// Some ICU builds put a narrow no-break space before AM/PM.
const plain = (text: string | null | undefined) => (text ?? '').replace(/\u202f/g, ' ')

/** A local wall-clock instant this year, so labels read the same in any test time zone. */
const at = (month: number, day: number, hour: number, minute: number) =>
  new Date(new Date().getFullYear(), month - 1, day, hour, minute).toISOString()

const NO_SOURCES = { citedDomains: [], citedCompetitorDomains: [], groundingSources: [], evidenceUrls: [], runHistory: [] }

function renderModal(overrides: Partial<CitationInsightVm>) {
  const project = createDashboardFixture({}).dashboard.projects[0]!
  render(<EvidenceDetailModal project={project} onClose={() => {}} evidence={{ ...project.visibilityEvidence[0]!, ...overrides }} />)
  return within(screen.getByRole('dialog'))
}

function twoChecks(): RunHistoryPoint[] {
  return [
    { runId: 'run_old', createdAt: at(11, 5, 10, 0), citationState: 'cited', answerMentioned: true },
    { runId: 'run_new', createdAt: at(11, 7, 9, 15), citationState: 'cited', answerMentioned: true },
  ]
}

test('check chips name their day, and add the time when two checks share one', () => {
  const dialog = renderModal({
    answerMentioned: true,
    visibilityState: VisibilityStates.visible,
    runHistory: [
      { runId: 'run_a', createdAt: at(11, 5, 10, 0), citationState: 'cited', answerMentioned: true },
      { runId: 'run_b', createdAt: at(11, 7, 9, 15), citationState: 'cited', answerMentioned: false },
      { runId: 'run_c', createdAt: at(11, 7, 15, 40), citationState: 'cited', answerMentioned: true },
    ],
  })
  expect(dialog.getByText('Check history')).toBeTruthy()
  const chips = dialog.getAllByRole('button', { name: /^Check / })
  expect(chips.map(chip => plain(chip.textContent))).toEqual(['Nov 5', 'Nov 7, 9:15 AM', 'Nov 7, 3:40 PM'])
  expect(chips.map(chip => plain(chip.getAttribute('aria-label')))).toEqual([
    'Check Nov 5: Mentioned',
    'Check Nov 7, 9:15 AM: Not mentioned',
    'Check Nov 7, 3:40 PM: Mentioned',
  ])
})

test('a mentioned answer states its verdict once, in mention wording', () => {
  const dialog = renderModal({
    answerSnippet: 'Citypoint Dental takes same-day emergency appointments.',
    answerMentioned: true,
    visibilityState: VisibilityStates.visible,
    historyScope: 'provider',
    visibilityChangeLabel: 'Mentioned in the last 2 checks',
    // The summary the dashboard builds restates the verdict; the hero already says it.
    summary: 'Your brand or domain is mentioned in AI answers for "emergency dentist brooklyn".',
    runHistory: [],
  })
  expect(dialog.getAllByText(/Your brand or domain is mentioned/).map(node => node.textContent)).toEqual([
    'Your brand or domain is mentioned in this answer',
  ])
  expect(dialog.getByText('Gemini · mentioned in the last 2 checks')).toBeTruthy()
  expect(dialog.getByText('Why you\'re mentioned')).toBeTruthy()
  expect(dialog.queryByText(/visible/i)).toBeNull()
})

test.each([
  {
    state: 'a recorded answer with no links',
    overrides: { answerSnippet: 'An answer that links nowhere.', answerMentioned: false, visibilityState: VisibilityStates['not-visible'] },
    copy: EVIDENCE_EMPTY_COPY.noSources,
  },
  {
    state: 'a check that recorded no answer',
    overrides: { answerSnippet: '', answerMentioned: false, visibilityState: VisibilityStates['not-visible'] },
    copy: EVIDENCE_EMPTY_COPY.sourcesNotRecorded,
  },
  {
    state: 'a query not checked yet',
    overrides: { answerSnippet: '', answerMentioned: undefined, visibilityState: 'pending' as const },
    copy: EVIDENCE_EMPTY_COPY.sourcesPending,
  },
])('the Sources tab is truthful and readable for $state', ({ overrides, copy }) => {
  const dialog = renderModal({ ...NO_SOURCES, ...overrides })
  fireEvent.click(dialog.getByRole('button', { name: 'Sources', exact: true }))
  const empty = dialog.getByText(copy)
  expect(empty.className).toContain('text-secondary')
  expect(empty.className).not.toContain('text-faint')
  expect(dialog.queryByText(/No source data/)).toBeNull()
})

test('an answer with neither a mention assessment nor sources says so plainly', () => {
  const dialog = renderModal({
    ...NO_SOURCES,
    answerSnippet: 'Recorded answer without an assessment.',
    answerMentioned: undefined,
    visibilityState: undefined,
    mentionedCompetitorDomains: [],
    recommendedCompetitors: [],
  })
  const empty = dialog.getByText(EVIDENCE_EMPTY_COPY.nothingRecorded)
  expect(empty.className).toContain('text-secondary')
  expect(dialog.queryByText(/visibility data/)).toBeNull()
})

test.each([
  { outcome: 'saved no answer', response: () => jsonResponse({ snapshots: [] }), note: 'This check saved no answer for this query.' },
  { outcome: 'cannot be loaded', response: () => jsonResponse({ error: { code: 'INTERNAL', message: 'boom' } }, 500), note: 'Could not load this check.' },
])('a past check that $outcome says so in place of its answer', async ({ response, note }) => {
  onTestFinished(mockFetch(response))
  const dialog = renderModal({ answerMentioned: true, visibilityState: VisibilityStates.visible, runHistory: twoChecks() })
  fireEvent.click(dialog.getAllByRole('button', { name: /^Check / })[0]!)
  const answer = await dialog.findByText(note)
  expect(answer.className).toContain('text-secondary')
  expect(dialog.queryByText('No answer text recorded for this check')).toBeNull()
  expect(plain(dialog.getByText(/^Viewing the check from/).textContent)).toContain('Viewing the check from Nov 5, 10:00 AM · Mentioned')
})
