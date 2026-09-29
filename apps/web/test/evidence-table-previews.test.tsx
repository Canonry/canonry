import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { EvidenceTable } from '../src/components/project/EvidenceTable.js'
import { createDashboardFixture } from '../src/mock-data.js'
import type { CitationInsightVm } from '../src/view-models.js'

const { openEvidence } = vi.hoisted(() => ({ openEvidence: vi.fn() }))

vi.mock('../src/hooks/use-drawer.js', () => ({
  useDrawer: () => ({ openEvidence }),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const answerSnippet = 'Northwind makes widgets for local businesses.'
const sourceUrl = 'https://northwind.example/widgets'

function renderPreview(overrides: Partial<CitationInsightVm> = {}, mode: 'mentions' | 'citations' = 'citations') {
  const seed = createDashboardFixture({}).dashboard.projects[0]!.visibilityEvidence[0]!
  render(<EvidenceTable evidence={[{
    ...seed,
    id: 'saved-widget-answer',
    query: 'Best widgets',
    queryClass: 'non-brand',
    answerSnippet,
    matchedTerms: ['Northwind'],
    citedDomains: ['northwind.example'],
    evidenceUrls: [sourceUrl],
    groundingSources: [{ uri: sourceUrl, title: 'Northwind widgets' }],
    mentionedCompetitorDomains: [],
    recommendedCompetitors: [],
    ...overrides,
  }]} />)
  fireEvent.click(screen.getByRole('tab', { name: mode === 'citations' ? 'Citations' : 'Mentions' }))
  fireEvent.click(screen.getByRole('button', { name: 'Best widgets', exact: true }))
}

function answerDisclosure(): HTMLDetailsElement {
  const summary = screen.getByText('Answer text', { selector: 'summary' })
  expect(summary.parentElement?.tagName).toBe('DETAILS')
  return summary.parentElement as HTMLDetailsElement
}

test('mentions show the highlighted answer directly without a disclosure', () => {
  renderPreview({}, 'mentions')

  const brand = screen.getByText('Northwind', { exact: true })
  expect(brand.className).toContain('answer-highlight-brand')
  expect(brand.closest('details')).toBeNull()
  expect(brand.closest('p')?.textContent).toBe(answerSnippet)
})

test.each(['mentions', 'citations'] as const)('%s preview renders readable headings, paragraphs and lists', mode => {
  renderPreview({ answerSnippet: '# Local agencies\n\n**Northwind** supports local teams.\n\n- Technical reviews\n- Content planning\n\nCompare their services.' }, mode)
  if (mode === 'citations') fireEvent.click(screen.getByText('Answer text', { selector: 'summary' }))

  expect(screen.getByRole('heading', { name: 'Local agencies', level: 4 })).toBeTruthy()
  expect(screen.getByText('Technical reviews').closest('li')).toBeTruthy()
  expect(screen.getByText('Content planning').closest('li')).toBeTruthy()
  expect(screen.getByText('Compare their services.').closest('p')?.textContent).toBe('Compare their services.')
  expect(screen.getByText('Northwind', { selector: 'mark' }).closest('strong')).toBeTruthy()
  expect(document.querySelector('.answer-markdown')?.textContent).not.toContain('**')
})

test('citations lead with titled source URLs and keep answer text collapsed', () => {
  renderPreview()

  const link = screen.getByRole('link', { name: sourceUrl })
  expect(link.getAttribute('href')).toBe(sourceUrl)
  expect(screen.getByText('Northwind widgets')).toBeTruthy()
  const details = answerDisclosure()
  expect(details.open).toBe(false)
  expect(link.closest('details')).toBeNull()
  expect(link.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.queryByText('Northwind', { exact: true })).toBeNull()

  fireEvent.click(screen.getByText('Answer text', { selector: 'summary' }))
  expect(details.open).toBe(true)
  expect(screen.getByText('Northwind', { exact: true }).closest('details')).toBe(details)
  fireEvent.click(screen.getByText('Answer text', { selector: 'summary' }))
  expect(details.open).toBe(false)
})

test('switching tabs retains the expanded query and changes the preview emphasis', () => {
  renderPreview({}, 'mentions')

  fireEvent.click(screen.getByRole('tab', { name: 'Citations' }))
  expect(answerDisclosure().open).toBe(false)
  expect(screen.getByRole('link', { name: sourceUrl })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Best widgets', exact: true }).getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(screen.getByText('Answer text', { selector: 'summary' }))
  expect(answerDisclosure().open).toBe(true)

  fireEvent.click(screen.getByRole('tab', { name: 'Mentions' }))
  expect(screen.queryByText('Answer text', { selector: 'summary' })).toBeNull()
  expect(screen.getByText('Northwind', { exact: true }).closest('details')).toBeNull()

  fireEvent.click(screen.getByRole('tab', { name: 'Citations' }))
  expect(answerDisclosure().open).toBe(false)
})

test('citations preserve captured source links when answer text is missing', () => {
  renderPreview({ answerSnippet: '' })

  expect(screen.getByRole('link', { name: sourceUrl }).getAttribute('href')).toBe(sourceUrl)
  expect(screen.getByText('No answer text captured for this run.')).toBeTruthy()
})

test('citations fall back to saved evidence URLs without grounding sources', () => {
  renderPreview({ groundingSources: [] })

  expect(screen.getByRole('link', { name: sourceUrl }).getAttribute('href')).toBe(sourceUrl)
  expect(answerDisclosure().open).toBe(false)
})

test('grounding-only fallback names the recorded evidence without calling it a cited source', () => {
  renderPreview({ evidenceUrls: [] })

  expect(screen.getByText('Grounding sources', { exact: true })).toBeTruthy()
  expect(screen.queryByText('Cited sources', { exact: true })).toBeNull()
  expect(screen.getByRole('link', { name: sourceUrl }).getAttribute('href')).toBe(sourceUrl)
  expect(screen.getByText('Northwind widgets')).toBeTruthy()
})

test('saved citation URLs take precedence over other grounding URLs', () => {
  const groundingUrl = 'https://research.example/widgets'
  renderPreview({ groundingSources: [{ uri: groundingUrl, title: 'Other grounding evidence' }] })

  expect(screen.getByText('Cited sources', { exact: true })).toBeTruthy()
  expect(screen.getByRole('link', { name: sourceUrl })).toBeTruthy()
  expect(screen.queryByRole('link', { name: groundingUrl })).toBeNull()
})

test('citation previews cap sources at six and expand the full list in place', () => {
  const urls = Array.from({ length: 7 }, (_, index) => `https://northwind.example/source-${index}`)
  renderPreview({ evidenceUrls: urls, groundingSources: [] })

  expect(screen.getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(urls.slice(0, 6))
  expect(screen.queryByRole('link', { name: urls[6] })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'View all sources', exact: true }))
  expect(screen.getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(urls)
  expect(openEvidence).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Show fewer sources', exact: true }))
  expect(screen.getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(urls.slice(0, 6))
})

test('URL-backed sources retain source-side competitor classification independently of answer mentions', () => {
  const competitorUrl = 'https://www.rival.example/widgets'
  const mentionOnlyUrl = 'https://mentioned.example/widgets'
  renderPreview({
    evidenceUrls: [competitorUrl, mentionOnlyUrl],
    groundingSources: [],
    citedDomains: ['rival.example', 'mentioned.example'],
    citedCompetitorDomains: ['rival.example'],
    mentionedCompetitorDomains: ['mentioned.example'],
  })

  const competitorSource = screen.getByRole('link', { name: competitorUrl }).closest('li')!
  expect(within(competitorSource).getByText(/competitor source/i)).toBeTruthy()
  const mentionOnlySource = screen.getByRole('link', { name: mentionOnlyUrl }).closest('li')!
  expect(within(mentionOnlySource).queryByText(/competitor source/i)).toBeNull()
})

test('citations keep recorded domains as text when no source URL was captured', () => {
  renderPreview({ groundingSources: [], evidenceUrls: [] })

  const domain = screen.getByText('northwind.example', { exact: true })
  expect(domain.closest('a')).toBeNull()
  expect(domain.closest('details')).toBeNull()
  expect(answerDisclosure().open).toBe(false)
})

test('source-less citations expose an empty state while preserving the answer disclosure', () => {
  renderPreview({ groundingSources: [], evidenceUrls: [], citedDomains: [] })

  expect(screen.getByText('No cited sources captured for this run.')).toBeTruthy()
  expect(answerDisclosure().open).toBe(false)
  fireEvent.click(screen.getByText('Answer text', { selector: 'summary' }))
  expect(screen.getByText('Northwind', { exact: true }).closest('details')).toBe(answerDisclosure())
})

test('unsafe captured source URLs remain readable without becoming links', () => {
  const unsafeUrl = 'javascript:alert(1)'
  renderPreview({
    groundingSources: [{ uri: unsafeUrl, title: 'Recorded unsafe source' }],
    evidenceUrls: [unsafeUrl],
    citedDomains: [],
  })

  expect(screen.getByText('Recorded unsafe source')).toBeTruthy()
  expect(screen.getByText(unsafeUrl, { exact: true }).closest('a')).toBeNull()
  expect(screen.queryByRole('link', { name: unsafeUrl })).toBeNull()
})
