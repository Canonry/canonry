import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { EvidenceDetailModal } from '../src/components/layout/EvidenceDetailModal.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(cleanup)

test('source titles retain their full visible URLs and unsafe sources remain readable without links', () => {
  const project = createDashboardFixture({}).dashboard.projects[0]!
  const sourceUrl = `https://hotel.example/rooms/${'ocean-view-'.repeat(16)}?arrival=2026-09-28&guests=2`
  const evidenceUrl = 'https://hotel.example/evidence#room-details'
  const unsafeUrl = 'javascript:alert(1)'
  render(<EvidenceDetailModal project={project} onClose={() => {}} evidence={{
    ...project.visibilityEvidence[0]!,
    answerSnippet: 'The hotel has rooms with an ocean view.',
    answerMentioned: false,
    runHistory: [],
    groundingSources: [
      { uri: sourceUrl, title: 'Hotel rooms and rates' },
      { uri: unsafeUrl, title: 'Untrusted source' },
    ],
    evidenceUrls: [evidenceUrl],
  }} />)

  fireEvent.click(screen.getByRole('button', { name: 'Sources', exact: true }))
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByText('Hotel rooms and rates')).toBeTruthy()
  const source = dialog.getByRole('link', { name: sourceUrl })
  expect(source.getAttribute('href')).toBe(sourceUrl)
  expect(source.getAttribute('target')).toBe('_blank')
  expect(source.getAttribute('rel')).toBe('noopener noreferrer')
  expect(dialog.getByRole('link', { name: evidenceUrl }).getAttribute('href')).toBe(evidenceUrl)
  expect(dialog.getByText('Untrusted source')).toBeTruthy()
  expect(dialog.getByText(unsafeUrl)).toBeTruthy()
  expect(dialog.queryByRole('link', { name: unsafeUrl })).toBeNull()
})

test.each(['auto-fetched', 'historical'])('%s snapshots preserve captured source URLs without grounding metadata', async mode => {
  const project = createDashboardFixture({}).dashboard.projects[0]!
  const seed = project.visibilityEvidence[0]!
  const url = 'https://hotel.example/rooms/captured-source?arrival=2026-09-28'
  const unsafeUrl = 'data:text/html,untrusted'
  const restoreFetch = mockFetch(() => jsonResponse({ snapshots: [{
    query: seed.query,
    provider: seed.provider,
    citationState: 'cited',
    answerMentioned: true,
    answerText: 'An answer with captured source URLs.',
    citedUrls: [url, unsafeUrl],
    citedDomains: ['hotel.example'],
    groundingSources: [],
    searchQueries: [],
  }] }))
  onTestFinished(restoreFetch)
  render(<EvidenceDetailModal project={project} onClose={() => {}} evidence={{
    ...seed,
    answerSnippet: mode === 'auto-fetched' ? '' : 'Latest answer.',
    answerMentioned: true,
    groundingSources: [],
    evidenceUrls: [],
    runHistory: [
      { runId: 'earlier', createdAt: '2026-09-01T12:00:00Z', citationState: 'cited', answerMentioned: true },
      { runId: 'latest', createdAt: '2026-09-28T12:00:00Z', citationState: 'cited', answerMentioned: true },
    ],
  }} />)
  if (mode === 'historical') fireEvent.click(screen.getAllByRole('button', { name: /^Run / })[0]!)
  await screen.findByText('An answer with captured source URLs.')
  fireEvent.click(screen.getByRole('button', { name: 'Sources', exact: true }))
  expect(screen.getByRole('link', { name: url }).getAttribute('href')).toBe(url)
  expect(screen.getByText(unsafeUrl)).toBeTruthy()
  expect(screen.queryByRole('link', { name: unsafeUrl })).toBeNull()
})
