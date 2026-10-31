import { afterEach, expect, test } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'

import { EvidenceDetailModal } from '../src/components/layout/EvidenceDetailModal.js'
import { createDashboardFixture } from '../src/mock-data.js'

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
