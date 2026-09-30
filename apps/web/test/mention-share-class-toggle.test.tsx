import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { GapAnalysisDto, GapQuery, QueryClass } from '@ainyc/canonry-contracts'
import {
  CompetitiveCard,
  gapQueryLines,
  scopeGaps,
  type CompetitiveGapsState,
  type MentionShareBreakdownVm,
} from '../src/components/project/MentionShare.js'
import { METRIC_TONE_TEXT_CLASS } from '../src/lib/tone-helpers.js'
import type { ProjectCommandCenterVm } from '../src/view-models.js'
import { ainycClassify, ainycGaps, ainycMentionShare } from './ainyc-visibility-fixture.js'

afterEach(cleanup)

type Summary = ProjectCommandCenterVm['mentionShareSummary']

function breakdown(over: Partial<MentionShareBreakdownVm> = {}): MentionShareBreakdownVm {
  return {
    projectMentionSnapshots: 0,
    competitorMentionSnapshots: 0,
    combinedMentionSnapshots: 0,
    perCompetitor: [],
    ranking: [],
    snapshotsWithAnswerText: 0,
    snapshotsTotal: 0,
    score: null,
    ...over,
  }
}

function summary(over: Partial<Summary> = {}): Summary {
  return {
    label: 'Mention Share',
    value: '38.0%',
    delta: '',
    tone: 'caution',
    description: '',
    tooltip: '',
    trend: [],
    scope: 'non-brand',
    breakdown: breakdown(),
    branded: breakdown(),
    ...over,
  } as Summary
}

/**
 * The lopsided shape this whole card exists for: the project is named on
 * every branded answer and loses the category. Pooled it would read as a win.
 */
function lopsided(): Summary {
  return summary({
    tone: 'negative',
    breakdown: breakdown({
      projectMentionSnapshots: 1,
      competitorMentionSnapshots: 9,
      combinedMentionSnapshots: 10,
      perCompetitor: [{ domain: 'rival-one.example', mentionSnapshots: 9, shareOfCompetitiveTotal: 100 }],
      ranking: [
        { kind: 'competitor', domain: 'rival-one.example', mentionSnapshots: 9, share: 0.9 },
        { kind: 'project', domain: null, mentionSnapshots: 1, share: 0.1 },
      ],
      snapshotsWithAnswerText: 32,
      snapshotsTotal: 32,
      score: 10,
    }),
    branded: breakdown({
      projectMentionSnapshots: 20,
      competitorMentionSnapshots: 0,
      combinedMentionSnapshots: 20,
      perCompetitor: [],
      ranking: [
        { kind: 'project', domain: null, mentionSnapshots: 20, share: 1 },
        { kind: 'competitor', domain: 'rival-one.example', mentionSnapshots: 0, share: 0 },
      ],
      snapshotsWithAnswerText: 20,
      snapshotsTotal: 20,
      score: 100,
    }),
  })
}

const CLASSES: Record<string, QueryClass | null> = {
  'best widgets': 'non-brand',
  'widget repair': 'non-brand',
  'cheap widgets': 'non-brand',
  'acme tanks reviews': 'branded',
  'imported question': null,
}
const classify = (text: string) => CLASSES[text] ?? null

function gap(query: string): GapQuery {
  return {
    query,
    queryId: `id-${query}`,
    category: 'gap',
    providers: [],
    competitorsCiting: ['rival-one.example'],
    competitorsMentioned: ['rival-one.example'],
    consistency: { citedRuns: 0, totalRuns: 1, mentionedRuns: 0 },
  }
}

/** Four non-brand queries, one branded, one the classifier cannot place. */
function gapAnalysis(): GapAnalysisDto {
  return {
    cited: [gap('acme tanks reviews'), gap('cheap widgets')],
    gap: [gap('best widgets'), gap('widget repair')],
    uncited: [gap('imported question')],
    mentionedQueries: [gap('acme tanks reviews'), gap('cheap widgets'), gap('widget repair')],
    // A query named and cited instead, and a second one only cited instead.
    mentionGap: [gap('best widgets')],
    notMentioned: [gap('imported question')],
    runId: 'run-latest',
    window: '7d',
  }
}

function renderCard(
  over: Partial<Summary> = {},
  { competitorDomains = ['rival-one.example'], gaps = { status: 'ready', data: gapAnalysis() }, hasBaseline = true }: {
    competitorDomains?: string[]
    gaps?: CompetitiveGapsState
    hasBaseline?: boolean
  } = {},
) {
  return render(
    <CompetitiveCard
      summary={{ ...lopsided(), ...over }}
      competitorDomains={competitorDomains}
      gaps={gaps}
      classify={classify}
      hasBaseline={hasBaseline}
    />,
  )
}

function card(): HTMLElement {
  return document.querySelector('section[aria-labelledby]') as HTMLElement
}

/** What a sighted reader sees: the `sr-only` class suffixes are left out. */
function visibleText(element: Element): string {
  const clone = element.cloneNode(true) as Element
  for (const hidden of clone.querySelectorAll('.sr-only')) hidden.remove()
  return clone.textContent ?? ''
}

function rows(): string[][] {
  return [...card().querySelectorAll('.av-grid tbody tr')].map(row => [...row.children].map(visibleText))
}

function bullets(): string[] {
  return [...card().querySelectorAll('.av-details-list li')].map(item => item.textContent ?? '')
}

function shareValue(): HTMLElement {
  return card().querySelector('.av-grid tbody tr:first-child td > span') as HTMLElement
}

describe('CompetitiveCard class control', () => {
  it('defaults to non-brand and never shows the branded figure beside it', () => {
    renderCard()
    const group = screen.getByRole('radiogroup', { name: 'Query type' })
    expect(within(group).getByRole('radio', { name: 'Non-brand' }).getAttribute('aria-checked')).toBe('true')
    expect(within(group).getByRole('radio', { name: 'Branded' }).getAttribute('aria-checked')).toBe('false')

    expect(rows()).toEqual([
      ['Mention share', '10.0% 1 of 10 tracked-brand mentions'],
      ['rival-one.example', '90.0% 9 of 10'],
      ['Named instead of you', '1 of 3 queries'],
      ['Cited instead of you', '2 of 3 queries'],
    ])
    // 100 is the branded score. It must not be on screen while non-brand is.
    expect(card().textContent).not.toContain('100%')
    expect(card().querySelector<HTMLDetailsElement>('details.av-details')!.open).toBe(false)
    expect(bullets()).toEqual([
      'Base: 32 non-brand answers',
      'Named and cited instead: "best widgets"',
      'Cited instead: "widget repair"',
    ])
  })

  it('names the class in each figure\'s own accessible text', () => {
    renderCard()
    for (const cell of card().querySelectorAll('.av-grid td')) {
      expect(cell.querySelector('.sr-only')?.textContent).toBe(' · non-brand queries')
    }
  })

  it('shows the API share to one decimal, with the sign set apart and never doubled', () => {
    // 1 of 3 named brands is 33.333333 on the wire.
    renderCard({
      breakdown: breakdown({
        projectMentionSnapshots: 1,
        competitorMentionSnapshots: 2,
        combinedMentionSnapshots: 3,
        perCompetitor: [{ domain: 'rival-one.example', mentionSnapshots: 2, shareOfCompetitiveTotal: 100 }],
        ranking: [
          { kind: 'competitor', domain: 'rival-one.example', mentionSnapshots: 2, share: 2 / 3 },
          { kind: 'project', domain: null, mentionSnapshots: 1, share: 1 / 3 },
        ],
        snapshotsWithAnswerText: 3,
        snapshotsTotal: 3,
        score: 33.333333,
      }),
    })
    expect(visibleText(shareValue())).toBe('33.3%')
    expect(shareValue().querySelector('.text-faint')?.textContent).toBe('%')
    expect(card().textContent).not.toContain('%%')
  })

  it('switching to Branded swaps the figure, the gap counts, the Details and the spoken class together', () => {
    renderCard()
    fireEvent.click(screen.getByRole('radio', { name: 'Branded' }))

    // Every tracked competitor is listed, at its branded count of zero, so
    // "no competitor was named here" is visible rather than absent.
    expect(rows()).toEqual([
      ['Mention share', '100% 20 of 20 tracked-brand mentions'],
      ['rival-one.example', '0% 0 of 20'],
      ['Named instead of you', '0 of 1 query'],
      ['Cited instead of you', '0 of 1 query'],
    ])
    expect(bullets()).toEqual([
      'Base: 20 branded answers',
    ])
    expect(card().textContent).not.toContain('10.0%')
    expect(card().querySelector('.av-grid td .sr-only')?.textContent).toBe(' · branded queries')
  })

  it('never tone-colours a branded figure, because the band is calibrated for placement', () => {
    // Resolved from the shared tone map so the assertion tracks the design
    // tokens rather than pinning a literal colour class.
    const negative = METRIC_TONE_TEXT_CLASS.negative
    renderCard()
    expect(shareValue().className).toContain(negative)

    fireEvent.click(screen.getByRole('radio', { name: 'Branded' }))
    expect(shareValue().className).toContain('text-primary')
    expect(shareValue().className).not.toContain(negative)
  })

  it('pooled renders no control, says so, counts every query and offers the recovery step', () => {
    renderCard({ scope: 'pooled' })
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(card().querySelector('.mention-share-class')?.textContent).toBe('All answers')
    expect(rows().slice(2)).toEqual([
      ['Named instead of you', '1 of 5 queries'],
      ['Cited instead of you', '2 of 5 queries'],
    ])
    expect(bullets()).toContain('Base: 32 answers')
    expect(bullets().at(-1)).toBe('Set a brand name to split branded from non-brand.')
    // A pooled figure is not a competitive read, so it is never tone-coloured.
    expect(shareValue().className).toContain('text-primary')
    // And it is never labelled with a class it was not split by.
    expect(visibleText(card())).not.toMatch(/Non-brand|Branded/)
  })

  it('hides the control when the project has no branded queries at all', () => {
    renderCard({ branded: breakdown() })
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(card().querySelector('.mention-share-class')?.textContent).toBe('Non-brand')
    expect(rows()[0]).toEqual(['Mention share', '10.0% 1 of 10 tracked-brand mentions'])
  })

  it('renders no share figure when there is no competitive frame', () => {
    renderCard({}, { competitorDomains: [] })
    expect(rows()[0]).toEqual(['Mention share', 'Add competitors'])
    expect(card().querySelector('.mention-share-value-text')?.textContent).toBe('Add competitors')
    expect(bullets()[0]).toBe('Mention share: you were named in 1 of 32 answers')
  })

  it('arrow keys move the selection across the two classes and wrap', () => {
    renderCard()
    const group = screen.getByRole('radiogroup')
    const branded = within(group).getByRole('radio', { name: 'Branded' })

    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(branded.getAttribute('aria-checked')).toBe('true')
    expect(bullets()[0]).toBe('Base: 20 branded answers')

    // Wraps back around rather than dead-ending.
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(within(group).getByRole('radio', { name: 'Non-brand' }).getAttribute('aria-checked')).toBe('true')
  })

  it('distinguishes a failed overview fetch from a project that has never swept', () => {
    // Both produce all-zero counters. The dashboard fan-out swallows an
    // /overview rejection, so there is no error banner to contradict a false
    // "no sweep has run yet" on a project with a year of sweeps.
    const empty = { breakdown: breakdown(), branded: breakdown() }

    renderCard({ ...empty, unavailable: true })
    expect(rows()[0]).toEqual(['Mention share', 'No data'])
    expect(bullets()[0]).toBe('Mention share: could not load, refresh to retry')
    expect(card().textContent).not.toContain('no sweep has run yet')

    cleanup()
    renderCard(empty)
    expect(bullets()[0]).toBe('Mention share: no sweep has run yet')
    expect(card().textContent).not.toContain('could not load')
  })

  it('keeps the heading name free of the tooltip paragraph', () => {
    renderCard()
    const heading = screen.getByRole('heading', { level: 2 })
    // A heading takes its accessible name from its content, so the tooltip has
    // to be a sibling. Nesting it made the heading announce the methodology.
    expect(heading.textContent).toBe('Where competitors beat you')
    expect(heading.querySelector('button')).toBeNull()
    expect(card().getAttribute('aria-labelledby')).toBe(heading.id)
    // The tooltip explains the rendered scope, never a class that is not on screen.
    const tip = heading.parentElement!.querySelector('button[aria-label]')!.getAttribute('aria-label')!
    expect(tip).toMatch(/^Queries that do not contain your name\. Mention share: your share of tracked-brand mentions/)
    expect(tip).toContain('Named instead of you: queries where an engine named a tracked competitor and none named you.')
  })

  it('renders a truthful state instead of vanishing when a run named nobody', () => {
    renderCard({
      breakdown: breakdown({ snapshotsWithAnswerText: 24, snapshotsTotal: 24 }),
      branded: breakdown(),
    })
    expect(rows()[0]).toEqual(['Mention share', 'No mentions'])
    expect(bullets().slice(0, 2)).toEqual(['Mention share: no brand named in 24 answers', 'Base: 24 non-brand answers'])
  })
})

describe('CompetitiveCard gap counts', () => {
  it('waits for GET /analytics/gaps without inventing counts', () => {
    renderCard({}, { gaps: { status: 'loading' } })
    expect(rows().slice(2)).toEqual([
      ['Named instead of you', 'Loading…'],
      ['Cited instead of you', 'Loading…'],
    ])
    expect(bullets().some(line => line.includes('instead'))).toBe(false)
  })

  it('says a failed read failed, and keeps mention share', () => {
    renderCard({}, { gaps: { status: 'error' } })
    expect(rows()).toEqual([
      ['Mention share', '10.0% 1 of 10 tracked-brand mentions'],
      ['rival-one.example', '90.0% 9 of 10'],
      ['Named instead of you', 'Could not load'],
      ['Cited instead of you', 'Could not load'],
    ])
  })

  it('says "No queries" for a class with none in the latest sweep', () => {
    renderCard({}, { gaps: { status: 'ready', data: { ...gapAnalysis(), cited: [gap('cheap widgets')], gap: [gap('best widgets')] } } })
    fireEvent.click(screen.getByRole('radio', { name: 'Branded' }))
    expect(rows().slice(2)).toEqual([
      ['Named instead of you', 'No queries'],
      ['Cited instead of you', 'No queries'],
    ])
  })

  it('before the first sweep says what will appear, with no figures, control or Details', () => {
    renderCard({}, { hasBaseline: false, gaps: { status: 'loading' } })
    expect(card().textContent).toContain('Competitive mention and citation gaps appear after the first AI Visibility sweep.')
    expect(card().querySelector('table')).toBeNull()
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(card().querySelector('details')).toBeNull()
  })
})

describe('CompetitiveCard empty-class copy', () => {
  it('an all-branded basket says so instead of claiming nothing is tracked', () => {
    // The default selection is non-brand, which is empty here, but 20 branded
    // snapshots sit one click away. "none tracked" would contradict the control
    // beside it, and the server already names this state.
    renderCard({ breakdown: breakdown() })
    expect(rows()[0]).toEqual(['Mention share', 'No non-brand queries'])
    expect(bullets()[0]).toBe('Mention share: every tracked query names your brand')
    expect(card().textContent).not.toContain('none tracked')
    // The branded data is reachable, and reads normally once selected.
    fireEvent.click(screen.getByRole('radio', { name: 'Branded' }))
    expect(rows()[0]).toEqual(['Mention share', '100% 20 of 20 tracked-brand mentions'])
  })

  it('still says "no sweep has run yet" when the project really tracks nothing', () => {
    renderCard({ breakdown: breakdown({ snapshotsTotal: 0 }), branded: breakdown({ snapshotsTotal: 0 }) })
    expect(bullets()[0]).toBe('Mention share: no sweep has run yet')
    expect(card().textContent).not.toContain('No non-brand queries')
  })
})

describe('CompetitiveCard mention counts', () => {
  it('lists the server ranking as sent: its order and its counts, you first', () => {
    // Deliberately not in mention order: the rows must print the server's
    // own order, counts and shares, never re-sort or re-derive them.
    renderCard({
      breakdown: breakdown({
        projectMentionSnapshots: 1,
        competitorMentionSnapshots: 9,
        combinedMentionSnapshots: 10,
        ranking: [
          { kind: 'competitor', domain: 'rival-two.example', mentionSnapshots: 2, share: 0.2 },
          { kind: 'project', domain: null, mentionSnapshots: 1, share: 0.1 },
          { kind: 'competitor', domain: 'rival-one.example', mentionSnapshots: 7, share: 0.7 },
        ],
        snapshotsWithAnswerText: 32,
        snapshotsTotal: 32,
        score: 10,
      }),
    }, { competitorDomains: ['rival-one.example', 'rival-two.example'] })
    expect(rows().slice(0, 3)).toEqual([
      ['Mention share', '10.0% 1 of 10 tracked-brand mentions'],
      ['rival-two.example', '20.0% 2 of 10'],
      ['rival-one.example', '70.0% 7 of 10'],
    ])
  })

  it('reads ainyc\'s stored latest sweep as the approved card', () => {
    render(<CompetitiveCard summary={ainycMentionShare()} competitorDomains={['pbjmarketing.com']} gaps={{ status: 'ready', data: ainycGaps() }} classify={ainycClassify} hasBaseline />)
    expect(rows()).toEqual([
      ['Mention share', '33.3% 7 of 21 tracked-brand mentions'],
      ['pbjmarketing.com', '66.7% 14 of 21'],
      ['Named instead of you', '1 of 11 queries'],
      ['Cited instead of you', '1 of 11 queries'],
    ])
    expect(shareValue().className).toContain(METRIC_TONE_TEXT_CLASS.caution)
    expect(bullets()).toEqual([
      'Base: 44 non-brand answers',
      'Named and cited instead: "best AEO agency New York"',
    ])

    fireEvent.click(screen.getByRole('radio', { name: 'Branded' }))
    expect(rows()).toEqual([
      ['Mention share', '100% 12 of 12 tracked-brand mentions'],
      ['pbjmarketing.com', '0% 0 of 12'],
      ['Named instead of you', '0 of 3 queries'],
      ['Cited instead of you', '0 of 3 queries'],
    ])
    expect(bullets()).toEqual([
      'Base: 12 branded answers',
    ])
  })
})

describe('scopeGaps and gapQueryLines', () => {
  it('splits the latest sweep\'s lanes by class and counts each query once', () => {
    const data = gapAnalysis()
    expect(scopeGaps(data, 'non-brand', classify)).toEqual({ total: 3, named: ['best widgets'], cited: ['best widgets', 'widget repair'] })
    expect(scopeGaps(data, 'branded', classify)).toEqual({ total: 1, named: [], cited: [] })
    // An unclassifiable query belongs to neither class, only to the pooled read.
    expect(scopeGaps(data, 'pooled', classify)).toEqual({ total: 5, named: ['best widgets'], cited: ['best widgets', 'widget repair'] })
    // Lanes can repeat a query id (mention lanes mirror citation lanes); the denominator does not.
    expect(scopeGaps({ ...data, uncited: [...data.uncited, gap('best widgets')] }, 'non-brand', classify).total).toBe(3)
  })

  it('names a query in both lanes once, and each lane\'s others separately', () => {
    expect(gapQueryLines(['a', 'b'], ['a', 'c'])).toEqual([
      'Named and cited instead: "a"',
      'Named instead: "b"',
      'Cited instead: "c"',
    ])
    expect(gapQueryLines([], [])).toEqual([])
    expect(gapQueryLines(['x', 'y'], [])).toEqual(['Named instead: "x", "y"'])
  })
})

describe('CompetitiveCard restored figures (a cleanup never removes data)', () => {
  it('restores each tracked competitor\'s mention share as a grid row under yours', () => {
    // rival-two is tracked and was never named: it still gets a row, at 0%.
    renderCard({
      breakdown: breakdown({
        projectMentionSnapshots: 1,
        competitorMentionSnapshots: 9,
        combinedMentionSnapshots: 10,
        ranking: [
          { kind: 'competitor', domain: 'rival-one.example', mentionSnapshots: 9, share: 0.9 },
          { kind: 'project', domain: null, mentionSnapshots: 1, share: 0.1 },
          { kind: 'competitor', domain: 'rival-two.example', mentionSnapshots: 0, share: 0 },
        ],
        snapshotsWithAnswerText: 32,
        snapshotsTotal: 32,
        score: 10,
      }),
    }, { competitorDomains: ['rival-one.example', 'rival-two.example'] })
    expect(rows().slice(0, 3)).toEqual([
      ['Mention share', '10.0% 1 of 10 tracked-brand mentions'],
      ['rival-one.example', '90.0% 9 of 10'],
      ['rival-two.example', '0% 0 of 10'],
    ])
    // Each competitor row names its class to assistive tech, like every figure.
    for (const cell of [...card().querySelectorAll('.av-grid tbody tr')].slice(1, 3).map(row => row.querySelector('td')!)) {
      expect(cell.querySelector('.sr-only')?.textContent).toBe(' · non-brand queries')
    }
    // The counts now sit in the grid, so Details no longer repeats them.
    expect(bullets().some(line => line.includes('tracked-brand mentions'))).toBe(false)
  })

  it('shows your mentions out of every tracked-brand mention beside the share', () => {
    renderCard()
    const cell = card().querySelector('.av-grid tbody tr:first-child td')!
    expect(cell.querySelector('.av-of')?.textContent).toBe('1 of 10 tracked-brand mentions')
  })

  it('switches the competitor rows with the class control', () => {
    renderCard()
    fireEvent.click(screen.getByRole('radio', { name: 'Branded' }))
    expect(rows().slice(0, 2)).toEqual([
      ['Mention share', '100% 20 of 20 tracked-brand mentions'],
      ['rival-one.example', '0% 0 of 20'],
    ])
  })

  it('names the latest sweep as the card\'s time basis', () => {
    renderCard()
    expect(card().querySelector('.av-card-head .av-card-meta')?.textContent).toBe('Latest sweep')
  })

  it('tone-colours non-brand gap counts with the server\'s gap bands, never branded ones', () => {
    // 1 of 3 and 2 of 3 are both at or over 30%: negative.
    renderCard()
    const gapFigures = () => [...card().querySelectorAll('.av-grid tbody tr')].slice(-2).map(row => row.querySelector('.av-n')!.className)
    for (const className of gapFigures()) expect(className).toContain(METRIC_TONE_TEXT_CLASS.negative)
    cleanup()
    // No gap at all is positive.
    renderCard({}, { gaps: { status: 'ready', data: { ...gapAnalysis(), gap: [], mentionGap: [] } } })
    for (const className of gapFigures()) expect(className).toContain(METRIC_TONE_TEXT_CLASS.positive)
    fireEvent.click(screen.getByRole('radio', { name: 'Branded' }))
    for (const className of gapFigures()) expect(className).toContain('text-primary')
  })

  it('says what mentioned and cited mean in the card tooltip', () => {
    renderCard()
    const heading = screen.getByRole('heading', { level: 2 })
    const tip = heading.parentElement!.querySelector('button[aria-label]')!.getAttribute('aria-label')!
    expect(tip).toContain('Mentioned means the brand is in the answer text. Cited means its site is in the sources. Neither implies the other.')
  })

  it('asks for a brand name when classes cannot be split', () => {
    renderCard({ scope: 'pooled' })
    expect(bullets()).toContain('Set a brand name to split branded from non-brand.')
  })
})
