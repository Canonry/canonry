import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MentionShare, type MentionShareBreakdownVm } from '../src/components/project/MentionShare.js'
import { METRIC_TONE_TEXT_CLASS } from '../src/lib/tone-helpers.js'
import type { ProjectCommandCenterVm } from '../src/view-models.js'

afterEach(cleanup)

type Summary = ProjectCommandCenterVm['mentionShareSummary']

function breakdown(over: Partial<MentionShareBreakdownVm> = {}): MentionShareBreakdownVm {
  return {
    projectMentionSnapshots: 0,
    competitorMentionSnapshots: 0,
    perCompetitor: [],
    snapshotsWithAnswerText: 0,
    snapshotsTotal: 0,
    score: null,
    ...over,
  }
}

function summary(over: Partial<Summary> = {}): Summary {
  return {
    label: 'Mention Share',
    value: '38',
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
 * The lopsided shape this whole feature exists for: the project is named on
 * every branded answer and loses the category. Pooled it would read as a win.
 */
function lopsided(): Summary {
  return summary({
    tone: 'negative',
    breakdown: breakdown({
      projectMentionSnapshots: 1,
      competitorMentionSnapshots: 9,
      perCompetitor: [{ domain: 'rival-one.example', mentionSnapshots: 9, shareOfCompetitiveTotal: 100 }],
      snapshotsWithAnswerText: 32,
      snapshotsTotal: 32,
      score: 10,
    }),
    branded: breakdown({
      projectMentionSnapshots: 20,
      competitorMentionSnapshots: 0,
      perCompetitor: [],
      snapshotsWithAnswerText: 20,
      snapshotsTotal: 20,
      score: 100,
    }),
  })
}

function renderShare(over: Partial<Summary> = {}, competitorDomains = ['rival-one.example']) {
  return render(
    <MentionShare
      summary={{ ...lopsided(), ...over }}
      projectLabel="Acme Tanks"
      competitorDomains={competitorDomains}
    />,
  )
}

function block(): HTMLElement {
  return document.querySelector('.mention-share') as HTMLElement
}

describe('MentionShare class control', () => {
  it('defaults to non-brand and never shows the branded figure beside it', () => {
    renderShare()
    const group = screen.getByRole('radiogroup')
    expect(within(group).getByRole('radio', { name: 'Non-brand' }).getAttribute('aria-checked')).toBe('true')
    expect(within(group).getByRole('radio', { name: 'Branded' }).getAttribute('aria-checked')).toBe('false')

    // The competitive figure, and only it.
    expect(block().querySelector('.mention-share-value')?.textContent).toBe('10%')
    expect(block().textContent).toContain('Non-brand · 1 of 10 brand mentions')
    // 100 is the branded score. It must not be on screen while non-brand is.
    expect(block().textContent).not.toContain('100%')
    expect(block().textContent).not.toContain('Branded ·')
    // Each row is its share of the 10 brand mentions, most mentioned first.
    const shares = [...block().querySelectorAll('.mention-share-rows .mention-share-row')]
      .map(row => row.querySelector('.mention-share-share')?.textContent)
    expect(shares).toEqual(['90.0%', '10.0%'])
  })

  it('switching to Branded swaps the denominator, the caption word, and the rows together', () => {
    renderShare()
    fireEvent.click(screen.getByRole('radio', { name: 'Branded' }))

    expect(block().querySelector('.mention-share-value')?.textContent).toBe('100%')
    expect(block().textContent).toContain('Branded · 20 of 20 brand mentions')
    // The non-brand figure is now absent, not merely de-emphasised.
    expect(block().textContent).not.toContain('Non-brand ·')
    expect(block().textContent).not.toContain('1 of 10')

    // Every tracked competitor still gets a row, at its branded count of zero,
    // so "no competitor was named here" is visible rather than an absent row.
    const rows = block().querySelectorAll('.mention-share-rows .mention-share-row')
    expect(rows).toHaveLength(2)
    expect(rows[1]!.textContent).toContain('rival-one.example')
    // An exact zero and an exact whole read without a decimal in the shared format.
    expect(rows[1]!.querySelector('.mention-share-share')?.textContent).toBe('0%')
    expect(rows[0]!.querySelector('.mention-share-share')?.textContent).toBe('100%')
  })

  it('never tone-colours a branded figure, because the band is calibrated for placement', () => {
    // Resolved from the shared tone map so the assertion tracks the design
    // tokens rather than pinning a literal colour class.
    const negative = METRIC_TONE_TEXT_CLASS.negative
    renderShare()
    expect(block().querySelector('.mention-share-value')!.className).toContain(negative)

    fireEvent.click(screen.getByRole('radio', { name: 'Branded' }))
    const brandedValue = block().querySelector('.mention-share-value')!
    expect(brandedValue.className).toContain('text-secondary')
    expect(brandedValue.className).not.toContain(negative)
  })

  it('pooled renders no control, says so, and offers the recovery step', () => {
    renderShare({ scope: 'pooled' })
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(block().querySelector('.mention-share-class')?.textContent).toBe('All queries')
    expect(block().textContent).toContain('All queries · 1 of 10 brand mentions')
    expect(block().textContent).toContain('Set a brand name to split branded from non-brand.')
    // A pooled figure is not a competitive read, so it is never tone-coloured.
    expect(block().querySelector('.mention-share-value')!.className).toContain('text-secondary')
    // And it is never labelled with a class it was not split by.
    expect(block().textContent).not.toContain('Non-brand')
    expect(block().textContent).not.toContain('Branded')
  })

  it('hides the control when the project has no branded queries at all', () => {
    renderShare({ branded: breakdown() })
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(block().querySelector('.mention-share-class')?.textContent).toBe('Non-brand')
    expect(block().textContent).toContain('Non-brand · 1 of 10 brand mentions')
  })

  it('renders no share figure and no ranking when there is no competitive frame', () => {
    renderShare({}, [])
    expect(block().textContent).not.toContain('%')
    expect(block().querySelector('.mention-share-rows')).toBeNull()
    expect(block().querySelector('.mention-share-value-text')?.textContent).toBe('Add competitors')
    expect(block().textContent).toContain('you were named in 1 of 32 answers')
  })

  it('arrow keys move the selection across the two classes and wrap', () => {
    renderShare()
    const group = screen.getByRole('radiogroup')
    const branded = within(group).getByRole('radio', { name: 'Branded' })

    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(branded.getAttribute('aria-checked')).toBe('true')
    expect(block().textContent).toContain('Branded ·')

    // Wraps back around rather than dead-ending.
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(within(group).getByRole('radio', { name: 'Non-brand' }).getAttribute('aria-checked')).toBe('true')
  })

  it('distinguishes a failed overview fetch from a project that has never swept', () => {
    // Both produce all-zero counters. The dashboard fan-out swallows an
    // /overview rejection, so there is no error banner to contradict a false
    // "no sweep has run yet" on a project with a year of sweeps.
    const empty = { breakdown: breakdown(), branded: breakdown() }

    renderShare({ ...empty, unavailable: true })
    expect(block().querySelector('.mention-share-value-text')?.textContent).toBe('No data')
    expect(block().textContent).toContain('could not load, refresh to retry')
    expect(block().textContent).not.toContain('no sweep has run yet')

    cleanup()
    renderShare(empty)
    expect(block().textContent).toContain('no sweep has run yet')
    expect(block().textContent).not.toContain('could not load')
  })

  it('keeps the heading name free of the tooltip paragraph', () => {
    renderShare()
    const heading = screen.getByRole('heading', { level: 3 })
    // A heading takes its accessible name from its content, so the tooltip has
    // to be a sibling. Nesting it made the h3 announce the whole methodology.
    expect(heading.textContent).toBe('Mention share')
    expect(heading.querySelector('button')).toBeNull()
    // And the radiogroup is still labelled by it.
    expect(screen.getByRole('radiogroup').getAttribute('aria-labelledby')).toBe(heading.id)
  })

  it('renders a truthful state instead of vanishing when a run named nobody', () => {
    // The old component returned null here and silently deleted real evidence.
    renderShare({
      breakdown: breakdown({ snapshotsWithAnswerText: 24, snapshotsTotal: 24 }),
      branded: breakdown(),
    })
    expect(block().querySelector('.mention-share-value-text')?.textContent).toBe('No mentions')
    expect(block().textContent).toContain('no brand named in 24 answers')
    expect(block().querySelector('.mention-share-rows')).toBeNull()
  })
})

describe('MentionShare empty-class copy', () => {
  it('an all-branded basket says so instead of claiming nothing is tracked', () => {
    // The default selection is non-brand, which is empty here, but 20 branded
    // snapshots sit one click away. "none tracked" would contradict the control
    // beside it, and the server already names this state.
    renderShare({ breakdown: breakdown() })
    expect(block().querySelector('.mention-share-value-text')?.textContent).toBe('No non-brand queries')
    expect(block().textContent).toContain('every tracked query names your brand')
    expect(block().textContent).not.toContain('none tracked')
    // The branded data is reachable, and reads normally once selected.
    fireEvent.click(screen.getByRole('radio', { name: 'Branded' }))
    expect(block().querySelector('.mention-share-value')?.textContent).toBe('100%')
  })

  it('still says "none tracked" when the project really tracks nothing', () => {
    renderShare({ breakdown: breakdown({ snapshotsTotal: 0 }), branded: breakdown({ snapshotsTotal: 0 }) })
    expect(block().textContent).toContain('no sweep has run yet')

    cleanup()
    // A run happened for branded, none for non-brand, and no branded queries
    // either: nothing is tracked in either class beyond the run itself.
    renderShare({ breakdown: breakdown(), branded: breakdown() , unavailable: false })
    expect(block().textContent).not.toContain('No non-brand queries')
  })
})

describe('MentionShare ranking semantics', () => {
  it('exposes the columns to assistive tech, not just to the eye', () => {
    renderShare()
    const table = screen.getByRole('table')
    expect(table).toBeTruthy()

    // Column headers exist and are associated by scope, so a value is announced
    // with what it means rather than as a bare number.
    const columnHeaders = within(table).getAllByRole('columnheader')
    expect(columnHeaders.map(h => h.textContent?.replace(/\s+/g, ' ').trim())).toEqual(
      expect.arrayContaining(['Domain', 'Share']),
    )
    for (const header of columnHeaders) {
      if (header.getAttribute('aria-hidden') === 'true') continue
      expect(header.getAttribute('scope')).toBe('col')
    }

    // Each row is identified by its domain, as a row header.
    const rowHeaders = within(table).getAllByRole('rowheader')
    expect(rowHeaders[0]!.getAttribute('scope')).toBe('row')
    expect(rowHeaders.map(h => h.textContent)).toContain('rival-one.example')

    // The bar restates the share cell, so it is decorative and hidden.
    expect(table.querySelector('.mention-share-bar')!.closest('[aria-hidden="true"]')).toBeTruthy()
  })
})
