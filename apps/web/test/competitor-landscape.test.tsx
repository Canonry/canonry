import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import {
  CompetitorLandscape,
  type CompetitorLandscapeData,
  type CompetitorLandscapeRow,
} from '../src/components/project/CompetitorLandscape.js'
import { METRIC_TONE_TEXT_CLASS } from '../src/lib/tone-helpers.js'
import { ainycLandscape } from './ainyc-visibility-fixture.js'

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
    basis: 'tracked',
    availability: 'measured',
    reason: null,
    project: row({ domain: 'canonry.example', label: 'Canonry', surfaceClass: 'own', pinned: false, shareOfVoice: 50 }),
    pinned: [row({ domain: 'pinned.example', label: 'Pinned zero', pinned: true, mentionCount: 0, shareOfVoice: 0, citationCount: 0 })],
    observed: [row({ domain: 'observed.example', label: 'Observed rival', mentionCount: 5, shareOfVoice: null })],
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
    filters: { scope: 'project', groupKey: null, provider: null, queryClass: 'non-brand', location: null, runId: null },
    truncated: false,
    marketState: null,
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
    shareOfVoice: null,
  }))
}

function grid() {
  return screen.getByRole('table', { name: 'Competitors over time' })
}

/** Your row, named by the project's display name: "Canonry (you)". */
const YOU = /\(you\)$/

function gridRow(name: string | RegExp) {
  return within(grid()).getByRole('rowheader', { name }).closest('tr')!
}

function detailsList(container: HTMLElement) {
  const details = container.querySelector<HTMLDetailsElement>('details.av-details')!
  // A bullet that opens a list reads as its summary line.
  return {
    details,
    bullets: [...details.querySelectorAll(':scope > ul > li')]
      .map(item => (item.querySelector(':scope > details > summary') ?? item).textContent),
  }
}

describe('CompetitorLandscape', () => {
  test('reads ainyc as the approved card: you and the tracked competitor, the rest in a closed Details', () => {
    const { container } = renderLandscape({ landscape: ainycLandscape(), canWrite: false })

    expect(screen.getByRole('heading', { name: 'Competitors over time' })).toBeTruthy()
    expect(container.querySelector('.av-card-meta')?.textContent).toBe('Non-brand · last 30 days · tracked competitors only')
    expect(within(grid()).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Brand', 'Type', 'Mention share', 'Named', 'Cited'])

    const you = gridRow(YOU)
    expect(you.textContent).toBe('Canonry (you)Your brand31.7%13 of 8817 of 88')
    // 31.7% sits in the mention-share caution band, and the whole row reads in it.
    expect(you.querySelectorAll('.text-caution-400')).toHaveLength(3)
    const rival = gridRow('pbjmarketing.com')
    expect(rival.textContent).toBe('pbjmarketing.comCompetitor68.3%28 of 8828 of 88')
    expect(rival.querySelector('.text-caution-400')).toBeNull()
    expect(within(grid()).getAllByRole('rowheader')).toHaveLength(2)

    const { details, bullets } = detailsList(container)
    expect(details.open).toBe(false)
    expect(bullets).toEqual([
      'Base: 2 sweeps, 88 answers',
      'Mention share: you 13, pbjmarketing.com 28 of 41 tracked-brand mentions',
      'Answers with source links: 86',
      // No other competitor site; the 59 company names are listed separately.
      'Other competitors seen: none',
      'Incomplete source lists: 2 answers, not counted as misses',
      'Sample pages cited',
      'Company names in answers: top 50 of 59',
      'Other sites cited: top 100',
    ])
    expect(container.textContent).not.toMatch(/not tracked|Share of voice/)
  })

  test('opens the names and other-site lists inside Details', () => {
    renderLandscape({ landscape: ainycLandscape() })

    const names = screen.getByText(/Company names in answers/).closest('details')!
    expect(names.open).toBe(false)
    fireEvent.click(within(names).getByText(/Company names in answers/))
    expect(within(names).getByText('PBJ Marketing · 25 answers')).toBeTruthy()
    expect(within(names).getByText('Klikcy · 1 answer')).toBeTruthy()

    const sites = screen.getByText(/Other sites cited/).closest('details')!
    fireEvent.click(within(sites).getByText(/Other sites cited/))
    expect(within(sites).getByText('webtonic.io · Unclassified · 27 citations')).toBeTruthy()
    expect(within(sites).getByText('https://www.webtonic.io/locations/new-york-city-geo-aeo')).toBeTruthy()
  })

  test('names the whole list when the server did not cut it', () => {
    const observedNames = [{ name: 'Harbor Lofts', answerCount: 3 }, { name: 'Pier Flats', answerCount: 2 }]
    renderLandscape({ landscape: landscape({ observedNames, observedNamesTotal: 75 }) })
    expect(screen.getByText(/Company names in answers/).textContent).toBe('Company names in answers: top 2 of 75')
    expect(screen.getByText('Harbor Lofts · 3 answers')).toBeTruthy()
    cleanup()
    renderLandscape({ landscape: landscape({ observedNames, observedNamesTotal: 2 }) })
    expect(screen.getByText(/Company names in answers/).textContent).toBe('Company names in answers: 2')
    // Not truncated, so the site list is a plain count.
    expect(screen.getByText(/Other sites cited/).textContent).toBe('Other sites cited: 1')
  })

  test.each([
    { kind: 'project' },
    { kind: 'group', groupKey: 'north' },
    { kind: 'all-markets' },
  ] as const)('keeps every pin in the grid and other competitors in Details, in $kind scope', (scope) => {
    const pinned = Array.from({ length: 7 }, (_, index) => row({
      domain: `pinned-${index}.example`, label: `Pinned rival ${index}`, pinned: true,
    }))
    renderLandscape({ landscape: landscape({ scope, pinned, observed: observedRows(8) }) })

    for (const pin of pinned) expect(within(grid()).getByRole('rowheader', { name: `${pin.label} ${pin.domain}` })).toBeTruthy()
    expect(within(grid()).queryByRole('rowheader', { name: /observed-1\.example/ })).toBeNull()

    const others = screen.getByText(/Other competitors seen/).closest('details')!
    expect(others.querySelector('summary')?.textContent).toBe('Other competitors seen: 8')
    const table = within(others).getByRole('table', { name: 'Other competitors seen' })
    expect(within(table).getAllByRole('rowheader')).toHaveLength(8)
    // The Type column survives in the list where types differ.
    expect(within(table).getAllByRole('cell').filter(cell => cell.textContent === 'Competitor')).toHaveLength(8)
  })

  test('keeps pins and actions to operators, never viewers or embeds', () => {
    const onPin = vi.fn()
    const onUnpin = vi.fn()
    renderLandscape({ onPin, onUnpin })

    fireEvent.click(screen.getByRole('button', { name: 'Unpin pinned.example' }))
    expect(onUnpin).toHaveBeenCalledWith('pinned.example')
    fireEvent.click(screen.getByRole('button', { name: 'Pin observed.example' }))
    expect(onPin).toHaveBeenCalledWith('observed.example')
    cleanup()

    for (const access of [{ canWrite: false, isEmbed: false }, { canWrite: true, isEmbed: true }]) {
      renderLandscape({ ...access, landscape: landscape({ observed: observedRows(8) }) })
      expect(within(grid()).getAllByRole('columnheader')).toHaveLength(5)
      expect(screen.queryByRole('button', { name: /^(Pin|Unpin) / })).toBeNull()
      expect(screen.queryByText('Manage competitors')).toBeNull()
      expect(screen.getByRole('table', { name: 'Other competitors seen' })).toBeTruthy()
      cleanup()
    }
  })

  test('says what each data-quality note means only when it applies', () => {
    const data = landscape()
    const { container, props, rerender } = renderLandscape({ landscape: data })
    expect(detailsList(container).bullets).toEqual(expect.arrayContaining([
      'No answer text: 2 answers, left out of mention share',
      'Incomplete source lists: 1 answer, not counted as misses',
      'Left out: 3 answers from spot checks or unfinished sweeps',
    ]))

    rerender(<CompetitorLandscape {...props} landscape={{
      ...data,
      evidence: { ...data.evidence, missingAnswerTextResults: 0, incompleteSourceResults: 0, excludedProbeResults: 0, excludedNonCompletedResults: 0 },
    }} />)
    expect(container.textContent).not.toMatch(/No answer text|Incomplete source lists|Left out/)
  })

  test('counts citations over every answer, text or not', () => {
    // 20 answers with text plus 2 that kept only a source list.
    renderLandscape()
    const you = gridRow(YOU)
    expect(you.textContent).toBe('Canonry (you)Your brand50.0%4 of 207 of 22')
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

    const brandRow = gridRow(YOU)
    expect(within(brandRow).getAllByText('Not measured')).toHaveLength(3)
    expect(brandRow.textContent).not.toMatch(/(^|[^\d.])0(\.0)?%/)

    rerender(<CompetitorLandscape {...props} landscape={landscape({
      scope,
      project: row({ domain: 'canonry.example', label: 'Canonry', surfaceClass: 'own', shareOfVoice: 0, mentionCount: 0, citationCount: 0 }),
      evidence: { ...emptyEvidence, answeredResults: 1 },
    })} />)
    // A measured zero share is exact, so it reads 0% with no decimal.
    expect(gridRow(YOU).textContent).toBe('Canonry (you)Your brand0%0 of 10 of 1')
  })

  test('shows stored source URLs for other competitors, never a link to latest evidence', () => {
    renderLandscape()

    const others = screen.getByRole('table', { name: 'Other competitors seen' })
    const rowElement = within(others).getByRole('rowheader', { name: 'Observed rival observed.example' }).closest('tr')!
    expect(rowElement.querySelector('a')).toBeNull()
    expect(screen.queryByRole('button', { name: /View evidence/i })).toBeNull()
    const sources = within(rowElement).getByText('Source URLs').closest('details')!
    expect(sources.open).toBe(false)
    fireEvent.click(within(sources).getByText('Source URLs'))
    expect(within(sources).getByText('https://rival.example/compare')).toBeTruthy()
  })

  test('uses the selected time window and supports keyboard selection', () => {
    const onWindowChange = vi.fn()
    const { container } = renderLandscape({ onWindowChange, window: '90d', landscape: landscape({ window: '90d' }) })

    expect(container.querySelector('.av-card-meta')?.textContent).toBe('Non-brand · last 90 days · tracked competitors only')
    const control = screen.getByRole('radiogroup', { name: 'Competitors over time window' })
    expect(within(control).getAllByRole('radio').map(option => option.textContent)).toEqual(['7 days', '30 days', '90 days', 'All'])
    fireEvent.keyDown(control, { key: 'ArrowLeft' })
    expect(onWindowChange).toHaveBeenCalledWith('30d')
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

  test('retains pinned fallback data and offers retry when history fails', () => {
    const onRetry = vi.fn()
    renderLandscape({
      landscape: undefined,
      pinnedFallback: [row({ domain: 'saved.example', label: 'Saved pin', pinned: true, mentionCount: 0, shareOfVoice: 0 })],
      error: 'Could not load observed competitors.',
      onRetry,
    })

    expect(screen.getByRole('alert').textContent).toContain('Could not load observed competitors.')
    expect(within(grid()).getByRole('rowheader', { name: 'Saved pin saved.example' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry competitors over time' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  test('does not present latest-only fallback counts as windowed history', () => {
    renderLandscape({
      landscape: undefined,
      pinnedFallback: [row({ domain: 'saved.example', label: 'Saved pin', pinned: true, mentionCount: 91, citationCount: 42, shareOfVoice: 67 })],
      error: 'Could not load observed competitors.',
    })
    const pinRow = gridRow('Saved pin saved.example')
    expect(within(pinRow).getAllByText('Unavailable')).toHaveLength(3)
    expect(pinRow.textContent).not.toContain('91')
    expect(pinRow.textContent).not.toContain('42')
    expect(pinRow.textContent).not.toContain('67.0%')
  })

  test('names an Advanced Measurement market in the card meta', () => {
    const { container } = renderLandscape({ scopeLabel: 'North market' })

    expect(container.querySelector('.av-card-meta')?.textContent).toBe('North market · Non-brand · last 30 days · tracked competitors only')
    expect(screen.getAllByRole('table', { name: 'Competitors over time' })).toHaveLength(1)
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

    // In view under the grid: it explains why a just-added competitor has no row yet.
    expect([...document.querySelectorAll('.av-card-body p')].map(line => line.textContent)).toContain('Pending publication: 1 competitor')
  })
})

test('explains unmeasured share without hiding counts', () => {
  const data = landscape({ basis: null, availability: 'not-measured', reason: 'no-competitors', pinned: [], observed: [], project: row({ surfaceClass: 'own', mentionCount: 34, shareOfVoice: null }) })
  const { container } = renderLandscape({ landscape: data })
  expect(screen.getByText('Mention share: no competitors configured')).toBeTruthy()
  expect(within(gridRow(YOU)).getByText('Not measured')).toBeTruthy()
  expect(within(gridRow(YOU)).getByText('34')).toBeTruthy()
  expect(detailsList(container).bullets).not.toContain('Tracked competitors only')
  // Neither the one-decimal nor the exact-100 form of a share may appear.
  expect(screen.queryByText(/100(\.0)?%/)).toBeNull()
})

test('an observed basis puts the admitted competitors in the grid and says so', () => {
  const admitted = row({ domain: 'admitted.example', mentionCount: 6, shareOfVoice: 30 })
  const below = row({ domain: 'below.example', mentionCount: 2, shareOfVoice: null })
  const { container } = renderLandscape({ landscape: landscape({ basis: 'observed', pinned: [], observed: [admitted, below] }) })

  expect(within(grid()).getAllByRole('rowheader').map(cell => cell.textContent)).toEqual(['Canonry (you)', 'Rival admitted.example'])
  expect(screen.getByRole('button', { name: 'Pin admitted.example' })).toBeTruthy()
  expect(container.querySelector('.av-card-meta')?.textContent).toBe('Non-brand · last 30 days · observed competitors only')
  expect(detailsList(container).bullets).toEqual(expect.arrayContaining([
    'Mention share: you 4, admitted.example 6 of 11 brand mentions',
    'Other competitors seen: 1',
  ]))
})

test('explains why a class must be selected, and never tones a pooled share', () => {
  const { container } = renderLandscape({ landscape: landscape({
    availability: 'not-measured',
    reason: 'select-query-class',
    project: row({ shareOfVoice: null }),
    pinned: [],
    observed: [],
    filters: { scope: 'project', groupKey: null, provider: null, queryClass: 'all', location: null, runId: null },
  }) })
  expect(screen.getByText('Mention share: no query type selected')).toBeTruthy()
  expect(container.querySelector('.av-card-meta')?.textContent).toBe('All queries · last 30 days · tracked competitors only')
  expect(gridRow(YOU).querySelector('.text-caution-400, .text-negative-400, .text-positive-400')).toBeNull()
})

describe('CompetitorLandscape restored figures (a cleanup never removes data)', () => {
  /** What the card shows without opening Details: the lines under the grid. */
  function visibleNotes(container: HTMLElement): string[] {
    return [...container.querySelectorAll('.av-card-body p')].map(line => line.textContent ?? '')
  }

  test('says in the meta line whether the rows are tracked or observed competitors', () => {
    const { container } = renderLandscape({ landscape: ainycLandscape(), canWrite: false })
    expect(container.querySelector('.av-card-meta')?.textContent).toBe('Non-brand · last 30 days · tracked competitors only')
    expect(detailsList(container).bullets).not.toContain('Tracked competitors only')
    cleanup()
    const admitted = row({ domain: 'admitted.example', mentionCount: 6, shareOfVoice: 30 })
    const observed = renderLandscape({ landscape: landscape({ basis: 'observed', pinned: [], observed: [admitted] }) })
    expect(observed.container.querySelector('.av-card-meta')?.textContent).toBe('Non-brand · last 30 days · observed competitors only')
  })

  test('says "No pinned competitors." when none are pinned', () => {
    const { container } = renderLandscape({ landscape: landscape({ basis: null, reason: 'no-competitors', pinned: [], observed: [] }) })
    expect(visibleNotes(container)).toContain('No pinned competitors.')
    cleanup()
    const pinned = renderLandscape()
    expect(visibleNotes(pinned.container)).not.toContain('No pinned competitors.')
  })

  test('names your row by the project\'s display name, as before the cleanup', () => {
    renderLandscape({ landscape: ainycLandscape(), canWrite: false })
    const you = within(grid()).getAllByRole('rowheader')[0]!
    expect(you.textContent).toBe('Canonry (you)')
    expect(you.querySelector('.av-of')?.textContent).toBe('(you)')
    cleanup()
    // A project with no name to show still reads as yours.
    renderLandscape({ landscape: landscape({ project: row({ domain: 'canonry.example', label: ' ', surfaceClass: 'own', shareOfVoice: 50 }) }) })
    expect(within(grid()).getAllByRole('rowheader')[0]!.textContent).toBe('You')
  })

  test('restores the Type column in the main grid', () => {
    renderLandscape({ landscape: ainycLandscape(), canWrite: false })
    expect(within(grid()).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Brand', 'Type', 'Mention share', 'Named', 'Cited'])
    expect(gridRow(YOU).querySelectorAll('td')[0]!.textContent).toBe('Your brand')
    expect(gridRow('pbjmarketing.com').querySelectorAll('td')[0]!.textContent).toBe('Competitor')
  })

  test('shows a display name beside its domain, and the domain alone when the name only repeats it', () => {
    const named = row({ domain: 'harbor.example', label: 'Harbor Lofts', pinned: true })
    renderLandscape({ landscape: landscape({ pinned: [named] }) })
    expect(within(grid()).getByRole('rowheader', { name: 'Harbor Lofts harbor.example' })).toBeTruthy()
    cleanup()
    // ainyc's generated label "pbjmarketing" says nothing the domain does not.
    renderLandscape({ landscape: ainycLandscape() })
    expect(within(grid()).getByRole('rowheader', { name: 'pbjmarketing.com' })).toBeTruthy()
    const sites = screen.getByText(/Other sites cited/).closest('details')!
    fireEvent.click(within(sites).getByText(/Other sites cited/))
    expect(within(sites).getByText('webtonic.io · Unclassified · 27 citations')).toBeTruthy()
  })

  test('names a curated source by its display name and domain in Other sites cited', () => {
    renderLandscape()
    const sites = screen.getByText(/Other sites cited/).closest('details')!
    fireEvent.click(within(sites).getByText(/Other sites cited/))
    expect(within(sites).getByText('Review site (review.example) · Editorial · 7 citations')).toBeTruthy()
  })

  test('restores the source-link count and says when no other competitor was seen', () => {
    const { container } = renderLandscape({ landscape: ainycLandscape() })
    expect(detailsList(container).bullets).toEqual(expect.arrayContaining([
      'Answers with source links: 86',
      'Other competitors seen: none',
    ]))
    cleanup()
    const withOthers = renderLandscape()
    expect(detailsList(withOthers.container).bullets).not.toContain('Other competitors seen: none')
  })

  test('says in the tooltip that company names are observations', () => {
    renderLandscape()
    const heading = screen.getByRole('heading', { name: 'Competitors over time' })
    const tip = heading.parentElement!.querySelector('button[aria-label]')!.getAttribute('aria-label')!
    expect(tip).toContain('Company names in answers are observations. Only competitor sites count toward mention share.')
  })

  test('shows data-quality warnings without opening Details, in caution colour', () => {
    const { container } = renderLandscape()
    const warning = [...container.querySelectorAll('.av-card-body p')].find(line => line.textContent === 'Answer data incomplete · Citation data incomplete')!
    expect(warning).toBeTruthy()
    expect(warning.className).toContain(METRIC_TONE_TEXT_CLASS.caution)
    cleanup()
    const complete = renderLandscape({ landscape: ainycLandscape() })
    // ainyc has two incomplete source lists and every answer's text.
    expect(visibleNotes(complete.container)).toContain('Citation data incomplete')
  })

  test('says why mention share is missing without opening Details', () => {
    const { container } = renderLandscape({ landscape: landscape({ basis: null, availability: 'not-measured', reason: 'no-competitors', pinned: [], observed: [] }) })
    expect(visibleNotes(container)).toContain('Mention share: no competitors configured')
    expect(detailsList(container).bullets).not.toContain('Mention share: no competitors configured')
  })

  test('shows competitors pending publication without opening Details', () => {
    const { container } = renderLandscape({
      landscape: landscape({ marketState: { activeRevision: 7, draft: { etag: '"mpd_7"', pendingCompetitorDomains: ['pending.example', 'later.example'] } } }),
    })
    expect(visibleNotes(container)).toContain('Pending publication: 2 competitors')
  })

  test('counts the other competitors seen in the card body, with the table left in Details', () => {
    const { container } = renderLandscape({ landscape: landscape({ observed: observedRows(8) }) })
    expect(visibleNotes(container)).toContain('8 other competitors seen')
    expect(screen.getByText(/Other competitors seen/).closest('details')?.classList.contains('av-subdetails')).toBe(true)
    cleanup()
    const truncated = renderLandscape({ landscape: landscape({ observed: observedRows(100), truncated: true }) })
    expect(visibleNotes(truncated.container)).toContain('100 or more other competitors seen')
  })
})
