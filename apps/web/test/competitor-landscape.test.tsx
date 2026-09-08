import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import {
  CompetitorLandscape,
  type CompetitorLandscapeData,
  type CompetitorLandscapeRow,
} from '../src/components/project/CompetitorLandscape.js'

afterEach(cleanup)

function row(overrides: Partial<CompetitorLandscapeRow> = {}): CompetitorLandscapeRow {
  return {
    domain: 'rival.example',
    label: 'Rival',
    surfaceClass: 'direct-competitor',
    pinned: false,
    mentionCount: 4,
    shareOfVoice: 20,
    citationCount: 7,
    answeredResults: 12,
    firstSeenAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: '2026-08-20T00:00:00.000Z',
    sampleUrls: ['https://rival.example/compare'],
    ...overrides,
  }
}

function landscape(overrides: Partial<CompetitorLandscapeData> = {}): CompetitorLandscapeData {
  return {
    window: '30d',
    scope: { kind: 'project' },
    project: row({ domain: 'canonry.example', label: 'Canonry', surfaceClass: 'own', pinned: false, shareOfVoice: 50 }),
    pinned: [row({ domain: 'pinned.example', label: 'Pinned zero', pinned: true, mentionCount: 0, shareOfVoice: 0, citationCount: 0 })],
    observed: [row({ domain: 'observed.example', label: 'Observed rival', mentionCount: 5, shareOfVoice: 25 })],
    otherSources: [row({ domain: 'review.example', label: 'Review site', surfaceClass: 'editorial-media', mentionCount: 0, shareOfVoice: null, sampleUrls: ['https://review.example/list'] })],
    evidence: {
      answeredResults: 20,
      sourceResults: 21,
      missingAnswerTextResults: 2,
      mentionCredits: 11,
      incompleteSourceResults: 1,
      excludedProbeResults: 2,
      excludedNonCompletedResults: 1,
    },
    ...overrides,
  }
}

function renderLandscape(overrides: Partial<React.ComponentProps<typeof CompetitorLandscape>> = {}) {
  const props: React.ComponentProps<typeof CompetitorLandscape> = {
    window: '30d',
    landscape: landscape(),
    canWrite: true,
    isEmbed: false,
    onWindowChange: vi.fn(),
    onPin: vi.fn(),
    onUnpin: vi.fn(),
    onAddCompetitor: vi.fn(),
    ...overrides,
  }
  return { ...render(<CompetitorLandscape {...props} />), props }
}

function observedRows(count: number) {
  return Array.from({ length: count }, (_, index) => row({
    domain: `observed-${index + 1}.example`,
    label: `Observed rival ${index + 1}`,
    mentionCount: count - index,
  }))
}

describe('CompetitorLandscape', () => {
  test.each([
    { kind: 'project' },
    { kind: 'group', groupKey: 'north' },
    { kind: 'all-markets' },
  ] as const)('shows all pins and five observed competitors in $kind scope', (scope) => {
    const pinned = Array.from({ length: 7 }, (_, index) => row({
      domain: `pinned-${index}.example`, label: `Pinned rival ${index}`, pinned: true,
    }))
    renderLandscape({ landscape: landscape({ scope, pinned, observed: observedRows(8) }) })

    for (const pin of pinned) expect(screen.getByRole('rowheader', { name: pin.label })).toBeTruthy()
    expect(screen.getByRole('rowheader', { name: 'Observed rival 5' })).toBeTruthy()
    expect(screen.queryByRole('rowheader', { name: 'Observed rival 6' })).toBeNull()
    expect(screen.getByText('Showing 5 of 8 observed competitors.')).toBeTruthy()
    const brand = screen.getByRole('rowheader', { name: /Canonry/ }).closest('tr')!
    expect(within(brand).getByText('50.0%')).toBeTruthy()

    const showAll = screen.getByRole('button', { name: 'Show all 8 observed competitors' })
    expect(showAll.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(showAll)
    expect(screen.getByRole('rowheader', { name: 'Observed rival 8' })).toBeTruthy()
    expect(screen.getByText('Showing 8 of 8 observed competitors.')).toBeTruthy()
    expect(within(brand).getByText('50.0%')).toBeTruthy()
    expect(screen.getByText('20 answers')).toBeTruthy()

    const showFewer = screen.getByRole('button', { name: 'Show fewer observed competitors' })
    expect(showFewer.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(showFewer)
    expect(screen.queryByRole('rowheader', { name: 'Observed rival 6' })).toBeNull()
    for (const pin of pinned) expect(screen.getByRole('rowheader', { name: pin.label })).toBeTruthy()
  })

  test.each([0, 1, 5])('does not offer expansion for %s observed competitors', (count) => {
    renderLandscape({ landscape: landscape({ observed: observedRows(count) }) })
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull()
    expect(screen.queryByText(/Showing \d+ of \d+ observed competitors/)).toBeNull()
  })

  test.each([
    { kind: 'project' },
    { kind: 'group', groupKey: 'north' },
    { kind: 'all-markets' },
  ] as const)('keeps empty observations and detailed evidence notes out of the default $kind view', (scope) => {
    renderLandscape({ landscape: landscape({
      scope,
      observed: [],
      truncated: true,
      evidence: {
        answeredResults: 44,
        sourceResults: 42,
        missingAnswerTextResults: 0,
        mentionCredits: 12,
        incompleteSourceResults: 42,
        excludedProbeResults: 2,
        excludedNonCompletedResults: 1,
      },
    }) })

    expect(screen.queryByText('Observed in this window')).toBeNull()
    expect(screen.getByRole('rowheader', { name: 'Pinned zero' })).toBeTruthy()
    const disclosure = screen.getByText('About these results').closest('details')!
    expect(disclosure.open).toBe(false)
    const summary = disclosure.querySelector('summary')!
    expect(within(summary).getByText('44 answers')).toBeTruthy()
    expect(within(summary).getByText('Citation data incomplete')).toBeTruthy()
    expect(within(summary).queryByText(/100/)).toBeNull()
    expect(screen.getByText(/42 results have incomplete source lists/).closest('details')).toBe(disclosure)
    expect(screen.getByText(/All pinned competitors are included/).closest('details')).toBe(disclosure)

    fireEvent.click(summary)
    expect(disclosure.open).toBe(true)
    expect(within(disclosure).getByText('42 results include source URLs.')).toBeTruthy()
    expect(within(disclosure).getByText('3 test or unfinished results are excluded.')).toBeTruthy()
    expect(within(disclosure).getByText('No additional competitors were identified in this period.')).toBeTruthy()
  })

  test('only shows data-quality warnings when the corresponding evidence is incomplete', () => {
    const data = landscape()
    const { props, rerender } = renderLandscape({ landscape: {
      ...data,
      evidence: { ...data.evidence, incompleteSourceResults: 0 },
    } })
    expect(screen.queryByText('Citation data incomplete')).toBeNull()
    expect(screen.getByText('Answer data incomplete').closest('summary')).not.toBeNull()
    expect(screen.getByText(/2 results have no answer text/).closest('details')?.open).toBe(false)

    rerender(<CompetitorLandscape {...props} landscape={{
      ...data,
      evidence: { ...data.evidence, answeredResults: 1, missingAnswerTextResults: 0, incompleteSourceResults: 0 },
    }} />)
    expect(screen.queryByText('Answer data incomplete')).toBeNull()
    expect(screen.queryByText('Citation data incomplete')).toBeNull()
    expect(screen.getByText('1 answer')).toBeTruthy()
  })

  test.each([
    { canWrite: false, isEmbed: false },
    { canWrite: true, isEmbed: true },
  ])('allows read-only expansion without revealing write actions (%j)', (access) => {
    renderLandscape({ ...access, landscape: landscape({ observed: observedRows(8) }) })
    fireEvent.click(screen.getByRole('button', { name: 'Show all 8 observed competitors' }))
    expect(screen.getByRole('rowheader', { name: 'Observed rival 8' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^(Pin|Unpin) / })).toBeNull()
    expect(screen.queryByText('Manage competitors')).toBeNull()
  })

  test('keeps expansion during a refresh but resets it for a different window or market', () => {
    const data = landscape({ observed: observedRows(8) })
    const { props, rerender } = renderLandscape({ landscape: data })
    fireEvent.click(screen.getByRole('button', { name: 'Show all 8 observed competitors' }))
    rerender(<CompetitorLandscape {...props} landscape={{ ...data, observed: observedRows(9) }} />)
    expect(screen.getByRole('rowheader', { name: 'Observed rival 9' })).toBeTruthy()

    rerender(<CompetitorLandscape {...props} window="7d" landscape={{ ...data, window: '7d' }} />)
    expect(screen.queryByRole('rowheader', { name: 'Observed rival 6' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show all 8 observed competitors' }))
    rerender(<CompetitorLandscape {...props} window="7d" landscape={{ ...data, window: '7d', scope: { kind: 'group', groupKey: 'north' } }} />)
    expect(screen.queryByRole('rowheader', { name: 'Observed rival 6' })).toBeNull()
  })

  test('keeps zero-observation pins before observed competitors in one semantic table', () => {
    const { container } = renderLandscape()

    const table = screen.getByRole('table', { name: 'Competitor landscape' })
    const pinnedHeading = within(table).getByText('Pinned')
    expect(pinnedHeading).not.toBeNull()
    expect(pinnedHeading.getAttribute('scope')).toBe('rowgroup')
    expect(within(table).getByText('Observed in this window')).not.toBeNull()
    expect(within(table).getByRole('rowheader', { name: 'Pinned zero' })).not.toBeNull()
    expect(within(table).getByRole('rowheader', { name: 'Observed rival' })).not.toBeNull()
    expect(within(table).getByText('0.0%')).not.toBeNull()

    const text = container.querySelector('table')?.textContent ?? ''
    expect(text.indexOf('Pinned zero')).toBeLessThan(text.indexOf('Observed rival'))
  })

  test.each([
    { kind: 'project' },
    { kind: 'group', groupKey: 'north' },
    { kind: 'all-markets' },
  ] as const)('marks an empty $kind history window as unmeasured while retaining measured zeroes', (scope) => {
    const emptyEvidence = {
      answeredResults: 0,
      sourceResults: 0,
      missingAnswerTextResults: 0,
      mentionCredits: 0,
      incompleteSourceResults: 0,
      excludedProbeResults: 0,
      excludedNonCompletedResults: 0,
    }
    const { rerender, props } = renderLandscape({ landscape: landscape({ scope, evidence: emptyEvidence }) })

    const brandRow = screen.getByRole('rowheader', { name: /Canonry/ }).closest('tr')!
    expect(within(brandRow).getAllByText('Not measured')).toHaveLength(3)
    expect(brandRow.textContent).not.toContain('0.0%')

    rerender(<CompetitorLandscape {...props} landscape={landscape({
      scope,
      project: row({ domain: 'canonry.example', label: 'Canonry', surfaceClass: 'own', shareOfVoice: 0, mentionCount: 0, citationCount: 0 }),
      evidence: { ...emptyEvidence, answeredResults: 1 },
    })} />)
    const measuredZeroRow = screen.getByRole('rowheader', { name: /Canonry/ }).closest('tr')!
    expect(within(measuredZeroRow).getByText('0.0%')).toBeTruthy()
    expect(within(measuredZeroRow).getAllByText('0')).toHaveLength(2)
  })

  test('does not link historical rows to the latest-only evidence table', () => {
    renderLandscape()

    const rowElement = screen.getByRole('row', { name: /Observed rival/ })
    fireEvent.click(rowElement)
    expect(screen.queryByRole('button', { name: /View evidence/i })).toBeNull()
    expect(rowElement.querySelector('a')).toBeNull()
    const sources = within(rowElement).getByText('Source URLs').closest('details')!
    expect(sources.open).toBe(false)
    fireEvent.click(within(sources).getByText('Source URLs'))
    expect(within(sources).getByText('https://rival.example/compare')).not.toBeNull()
  })

  test('uses the selected time window and supports keyboard selection', () => {
    const onWindowChange = vi.fn()
    renderLandscape({ onWindowChange })

    const control = screen.getByRole('radiogroup', { name: 'Competitor history window' })
    fireEvent.keyDown(control, { key: 'ArrowLeft' })

    expect(onWindowChange).toHaveBeenCalledWith('7d')
  })

  test('tucks custom entry behind manage controls and reports the added domain', () => {
    const onAddCompetitor = vi.fn()
    renderLandscape({ onAddCompetitor })

    const disclosure = screen.getByText('Manage competitors').closest('details')!
    expect(disclosure.open).toBe(false)
    fireEvent.click(within(disclosure).getByText('Manage competitors'))
    expect(disclosure.open).toBe(true)
    fireEvent.change(screen.getByLabelText('Competitor domain'), { target: { value: 'custom.example' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add competitor' }))

    expect(onAddCompetitor).toHaveBeenCalledWith('custom.example')
  })

  test('reveals the stored URLs behind other observed sources', () => {
    renderLandscape()

    const disclosure = screen.getByText('Other observed sources (1)').closest('details')!
    expect(disclosure.open).toBe(false)
    fireEvent.click(within(disclosure).getByText('Other observed sources (1)'))
    expect(within(disclosure).getByText('https://review.example/list')).not.toBeNull()
  })

  test('keeps custom input and reports a failed add instead of clearing it', async () => {
    const onAddCompetitor = vi.fn().mockResolvedValue(false)
    renderLandscape({ onAddCompetitor })

    const disclosure = screen.getByText('Manage competitors').closest('details')!
    fireEvent.click(within(disclosure).getByText('Manage competitors'))
    const input = screen.getByLabelText('Competitor domain')
    fireEvent.change(input, { target: { value: 'custom.example' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add competitor' }))

    await waitFor(() => expect(onAddCompetitor).toHaveBeenCalledWith('custom.example'))
    expect((input as HTMLInputElement).value).toBe('custom.example')
    expect(screen.getByRole('alert').textContent).toContain('Could not add competitor. Try again.')
  })

  test('keeps add pending until the mutation settles', async () => {
    let resolveAdd: ((value: boolean) => void) | undefined
    const onAddCompetitor = vi.fn(() => new Promise<boolean>((resolve) => { resolveAdd = resolve }))
    renderLandscape({ onAddCompetitor })

    const disclosure = screen.getByText('Manage competitors').closest('details')!
    fireEvent.click(within(disclosure).getByText('Manage competitors'))
    fireEvent.change(screen.getByLabelText('Competitor domain'), { target: { value: 'custom.example' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add competitor' }))

    expect((screen.getByRole('button', { name: 'Adding…' }) as HTMLButtonElement).disabled).toBe(true)
    resolveAdd?.(true)
    await waitFor(() => expect((screen.getByLabelText('Competitor domain') as HTMLInputElement).value).toBe(''))
  })

  test('hides all mutating controls for viewers and embeds', () => {
    const { rerender } = renderLandscape({ canWrite: false })

    expect(screen.queryByText('Manage competitors')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Pin observed.example' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Unpin pinned.example' })).toBeNull()

    rerender(
      <CompetitorLandscape
        window="30d"
        landscape={landscape()}
        canWrite
        isEmbed
        onWindowChange={vi.fn()}
        onPin={vi.fn()}
        onUnpin={vi.fn()}
        onAddCompetitor={vi.fn()}
      />,
    )

    expect(screen.queryByText('Manage competitors')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Pin observed.example' })).toBeNull()
  })

  test('retains pinned fallback data and offers retry when observed history fails', () => {
    const onRetry = vi.fn()
    renderLandscape({
      landscape: undefined,
      pinnedFallback: [row({ domain: 'saved.example', label: 'Saved pin', pinned: true, mentionCount: 0, shareOfVoice: 0 })],
      error: 'Could not load observed competitors.',
      onRetry,
    })

    expect(screen.getByRole('alert').textContent).toContain('Could not load observed competitors.')
    expect(screen.getByRole('rowheader', { name: 'Saved pin' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry competitor history' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  test('labels an Advanced Measurement market without changing the table structure', () => {
    renderLandscape({ scopeLabel: 'North market' })

    expect(screen.getByText('North market')).not.toBeNull()
    expect(screen.getAllByRole('table', { name: 'Competitor landscape' })).toHaveLength(1)
  })

  test('does not present latest-only fallback counts as windowed history', () => {
    renderLandscape({
      landscape: undefined,
      pinnedFallback: [row({ domain: 'saved.example', label: 'Saved pin', pinned: true, mentionCount: 91, citationCount: 42, shareOfVoice: 67 })],
      error: 'Could not load observed competitors.',
    })
    const pinRow = screen.getByRole('rowheader', { name: 'Saved pin' }).closest('tr')!
    expect(within(pinRow).getAllByText('Unavailable')).toHaveLength(3)
    expect(pinRow.textContent).not.toContain('91')
    expect(pinRow.textContent).not.toContain('42')
    expect(pinRow.textContent).not.toContain('67.0%')
  })

  test('states when ranked observed rows are truncated while pins remain complete', () => {
    renderLandscape({ landscape: landscape({ truncated: true }) })

    const note = screen.getByText('Lists include up to 100 observed competitors and 100 other sources. All pinned competitors are included.')
    expect(note.closest('details')?.open).toBe(false)
  })

  test('marks Advanced draft-only competitors as pending publication', () => {
    renderLandscape({
      landscape: landscape({
        scope: { kind: 'group', groupKey: 'north' },
        marketState: {
          activeRevision: 7,
          draft: { etag: '"mpd_7"', pendingCompetitorDomains: ['pending.example'] },
        },
      }),
    })

    expect(screen.getByText('1 competitor is pending publication for this market.')).not.toBeNull()
  })
})

test('renders the server basis and explains unmeasured share without hiding counts', () => {
  const data = landscape({ basis: null, availability: 'not-measured', reason: 'no-competitors', pinned: [], observed: [], project: row({ surfaceClass: 'own', mentionCount: 34, shareOfVoice: null }) })
  renderLandscape({ landscape: data })
  expect(screen.getByText('No competitors configured.')).toBeTruthy()
  expect(screen.getByText('Not measured')).toBeTruthy()
  expect(screen.getByText('34')).toBeTruthy()
  expect(screen.queryByText('100.0%')).toBeNull()
})
test('renders the observed basis beside the supplied value', () => {
  renderLandscape({ landscape: landscape({ basis: 'observed', availability: 'measured', reason: null }) })
  expect(screen.getByText('50.0% · observed competitors')).toBeTruthy()
})
test('explains why a class must be selected', () => {
  renderLandscape({ landscape: landscape({ availability: 'not-measured', reason: 'select-query-class', project: row({ shareOfVoice: null }), pinned: [], observed: [] }) })
  expect(screen.getByText('Select a query class.')).toBeTruthy()
})
