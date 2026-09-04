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

describe('CompetitorLandscape', () => {
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

  test('states when ranked observed rows are truncated while pins remain complete', () => {
    renderLandscape({ landscape: landscape({ truncated: true }) })

    expect(screen.getByText('Showing the top 100 observed competitors and other sources. Pinned competitors are complete.')).not.toBeNull()
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
