import { describe, expect, it } from 'vitest'
import type { ProjectOverviewWhatChangedDto } from '../src/composites.js'
import { isWhatChangedActiveRun, portfolioWhatChangedItems, whatChangedAllClearDetail } from '../src/what-changed.js'

const ACME = { id: 'proj_acme', name: 'acme', displayName: 'Acme Coatings' }
const BETA = { id: 'proj_beta', name: 'beta co', displayName: '' }

function signal(queryCount: number) {
  return { queryCount, queries: [], truncated: false }
}

/**
 * A project's overview `whatChanged` with these counts. `checked` false is a
 * project never measured; `compared` false is one measured once, with nothing
 * earlier to compare.
 */
function whatChanged(counts: {
  mentions?: number
  citations?: number
  gainedMentions?: number
  gainedCitations?: number
  active?: number
  checked?: boolean
  compared?: boolean
} = {}): ProjectOverviewWhatChangedDto {
  const checked = counts.checked ?? true
  const compared = checked && (counts.compared ?? true)
  return {
    mode: 'simple',
    latestCheck: checked ? { runIds: ['run_latest'], createdAt: '2026-09-08T00:00:00.000Z' } : null,
    comparison: compared
      ? { state: 'available', previousRunIds: ['run_previous'] }
      : { state: 'unavailable', reason: checked ? 'no-previous-check' : 'not-measured' },
    lostMentions: signal(counts.mentions ?? 0),
    lostCitations: signal(counts.citations ?? 0),
    gainedMentions: signal(counts.gainedMentions ?? 0),
    gainedCitations: signal(counts.gainedCitations ?? 0),
    activeRuns: { count: counts.active ?? 0, runIds: [] },
    // The roll-up builds rows from the counts, never from these.
    items: [],
  }
}

const ACME_LOST_MENTIONS = { id: 'attention_proj_acme_lost_mentions', tone: 'negative', title: 'Acme Coatings lost mentions', detail: '2 queries lost a mention in the latest check.', actionLabel: 'Open project', href: '/projects/acme' }
const ACME_LOST_CITATION = { id: 'attention_proj_acme_lost', tone: 'negative', title: 'Acme Coatings lost citations', detail: '1 query lost a citation in the latest check.', actionLabel: 'Open project', href: '/projects/acme' }
// A project without a display name is labelled by its name, and its link encodes it.
const BETA_ACTIVE = { id: 'attention_proj_beta_active', tone: 'neutral', title: 'beta co has active runs', detail: '3 runs in progress.', actionLabel: 'View runs', href: '/runs' }
const BETA_LOST_MENTION = { id: 'attention_proj_beta_lost_mentions', tone: 'negative', title: 'beta co lost mentions', detail: '1 query lost a mention in the latest check.', actionLabel: 'Open project', href: '/projects/beta%20co' }

// The status rows lead nowhere: Overview is the page they sit on.
const ALL_CLEAR = { id: 'attention_stable', tone: 'positive', title: 'All projects stable', detail: 'No mentions or citations changed, and no runs in progress.' }
const BETA_UNCHANGED = { id: 'attention_unchanged', tone: 'neutral', title: '1 project unchanged', detail: 'beta co. No mentions or citations changed since the previous check.' }
const AWAITING = { id: 'attention_awaiting', tone: 'neutral', title: 'Awaiting first measurement', detail: 'Visibility results will appear after the first check.' }

describe('portfolioWhatChangedItems', () => {
  it('lists each project\'s rows from its counts, in project order: mentions, citations, runs in progress', () => {
    expect(portfolioWhatChangedItems([
      { project: ACME, whatChanged: whatChanged({ mentions: 2, citations: 1 }) },
      { project: BETA, whatChanged: whatChanged({ mentions: 1, active: 3 }) },
    ])).toEqual([ACME_LOST_MENTIONS, ACME_LOST_CITATION, BETA_LOST_MENTION, BETA_ACTIVE])
  })

  it('counts runs in progress from the fresher source when given, not the overview', () => {
    // The overview, read before the run started, saw none; the run list sees three.
    expect(portfolioWhatChangedItems([{ project: BETA, whatChanged: whatChanged({ active: 0 }), activeRuns: 3 }])).toEqual([BETA_ACTIVE])
    // A run the overview saw has since finished.
    expect(portfolioWhatChangedItems([{ project: BETA, whatChanged: whatChanged({ active: 2 }), activeRuns: 0 }])).toEqual([ALL_CLEAR])
  })

  it('names a project whose overview could not be read instead of calling the portfolio clear', () => {
    expect(portfolioWhatChangedItems([
      { project: ACME, whatChanged: null },
      { project: BETA, whatChanged: whatChanged() },
    ])).toEqual([
      BETA_UNCHANGED,
      { id: 'attention_unread', tone: 'caution', title: '1 project couldn\'t be loaded', detail: 'Acme Coatings. Its changes are unknown.' },
    ])
  })

  it('lists the readable projects\' rows, then names every unread project', () => {
    expect(portfolioWhatChangedItems([
      { project: ACME, whatChanged: null },
      { project: BETA, whatChanged: whatChanged({ mentions: 1 }) },
      { project: { id: 'proj_cove', name: 'cove', displayName: 'Cove Dental' }, whatChanged: null },
    ])).toEqual([
      BETA_LOST_MENTION,
      { id: 'attention_unread', tone: 'caution', title: '2 projects couldn\'t be loaded', detail: 'Acme Coatings, Cove Dental. Their changes are unknown.' },
    ])
  })

  // Runs in progress are known from the run list even when the overview is not.
  it('keeps an unread project\'s runs in progress from the fresher source', () => {
    expect(portfolioWhatChangedItems([{ project: BETA, whatChanged: null, activeRuns: 3 }])).toEqual([
      BETA_ACTIVE,
      { id: 'attention_unread', tone: 'caution', title: '1 project couldn\'t be loaded', detail: 'beta co. Its changes are unknown.' },
    ])
  })

  it('says all clear only when every project was read, nothing changed and one has a check', () => {
    expect(portfolioWhatChangedItems([
      { project: ACME, whatChanged: whatChanged() },
      { project: BETA, whatChanged: whatChanged({ checked: false }) },
    ])).toEqual([ALL_CLEAR])
  })

  it('awaits the first measurement when no project has a check yet', () => {
    expect(portfolioWhatChangedItems([
      { project: ACME, whatChanged: whatChanged({ checked: false }) },
      { project: BETA, whatChanged: whatChanged({ checked: false }) },
    ])).toEqual([AWAITING])
  })

  // A first sweep still running is news, not a reason to wait quietly.
  it('lists a run in progress before any project has a check', () => {
    expect(portfolioWhatChangedItems([{ project: BETA, whatChanged: whatChanged({ checked: false, active: 3 }) }])).toEqual([BETA_ACTIVE])
  })

  it('has no rows without projects', () => {
    expect(portfolioWhatChangedItems([])).toEqual([])
  })

  it('gives gains alone a positive row per signal, with the same link as a loss', () => {
    expect(portfolioWhatChangedItems([{ project: BETA, whatChanged: whatChanged({ gainedMentions: 1, gainedCitations: 4 }) }])).toEqual([
      { id: 'attention_proj_beta_gained_mentions', tone: 'positive', title: 'beta co gained mentions', detail: '1 query gained a mention in the latest check.', actionLabel: 'Open project', href: '/projects/beta%20co' },
      { id: 'attention_proj_beta_gained_citations', tone: 'positive', title: 'beta co gained citations', detail: '4 queries gained a citation in the latest check.', actionLabel: 'Open project', href: '/projects/beta%20co' },
    ])
  })

  // A query can lose a signal on one engine and gain it on another, so both
  // counts can name it: the row's tone follows the larger count.
  it.each([
    { lostCount: 24, gainedCount: 18, tone: 'negative', detail: '24 queries lost a mention and 18 gained one in the latest check.' },
    { lostCount: 1, gainedCount: 3, tone: 'positive', detail: '1 query lost a mention and 3 gained one in the latest check.' },
    { lostCount: 2, gainedCount: 2, tone: 'neutral', detail: '2 queries lost a mention and 2 gained one in the latest check.' },
  ])('shares one mentions row when $lostCount lost and $gainedCount gained, toned $tone', ({ lostCount, gainedCount, tone, detail }) => {
    expect(portfolioWhatChangedItems([{ project: ACME, whatChanged: whatChanged({ mentions: lostCount, gainedMentions: gainedCount }) }])).toEqual([
      { id: 'attention_proj_acme_mentions_changed', tone, title: 'Acme Coatings mentions changed', detail, actionLabel: 'Open project', href: '/projects/acme' },
    ])
  })

  it('counts citations apart from mentions: a mention gain never softens a citation loss', () => {
    expect(portfolioWhatChangedItems([{ project: ACME, whatChanged: whatChanged({ gainedMentions: 5, citations: 1 }) }])).toEqual([
      { id: 'attention_proj_acme_gained_mentions', tone: 'positive', title: 'Acme Coatings gained mentions', detail: '5 queries gained a mention in the latest check.', actionLabel: 'Open project', href: '/projects/acme' },
      ACME_LOST_CITATION,
    ])
  })

  it('keeps a loss-only row as it was when a server reports no gains', () => {
    const { gainedMentions: _mentions, gainedCitations: _citations, ...older } = whatChanged({ mentions: 2, citations: 1 })
    expect(portfolioWhatChangedItems([{ project: ACME, whatChanged: older }])).toEqual([ACME_LOST_MENTIONS, ACME_LOST_CITATION])
  })

  it('says all clear only when every measured project was compared, and names the ones that were not', () => {
    const cove = { id: 'proj_cove', name: 'cove', displayName: 'Cove Dental' }
    // A first check (or one under another model) has nothing to compare: never "stable".
    expect(portfolioWhatChangedItems([
      { project: ACME, whatChanged: whatChanged({ compared: false }) },
      { project: BETA, whatChanged: whatChanged() },
      { project: cove, whatChanged: whatChanged({ checked: false }) },
    ])).toEqual([
      BETA_UNCHANGED,
      { id: 'attention_not_compared', tone: 'neutral', title: '1 project not compared', detail: 'Acme Coatings. Its latest check had no comparable check before it.' },
    ])
    expect(portfolioWhatChangedItems([
      { project: ACME, whatChanged: whatChanged({ compared: false }) },
      { project: cove, whatChanged: whatChanged({ compared: false }) },
    ])).toEqual([
      { id: 'attention_not_compared', tone: 'neutral', title: '2 projects not compared', detail: 'Acme Coatings, Cove Dental. Their latest check had no comparable check before it.' },
    ])
  })

  // A server before 7.123.0 reports losses only: its quiet is "no losses", never "no change".
  it('calls nothing unchanged from a server that measured no gains, and words the all-clear for losses only', () => {
    const older = (counts: Parameters<typeof whatChanged>[0] = {}) => {
      const { gainedMentions: _mentions, gainedCitations: _citations, ...rest } = whatChanged(counts)
      return rest
    }
    expect(portfolioWhatChangedItems([{ project: ACME, whatChanged: older() }, { project: BETA, whatChanged: older() }])).toEqual([
      { ...ALL_CLEAR, detail: 'No lost mentions or citations, and no runs in progress.' },
    ])
    expect(portfolioWhatChangedItems([{ project: ACME, whatChanged: older({ mentions: 2 }) }, { project: BETA, whatChanged: older() }])).toEqual([ACME_LOST_MENTIONS])
    expect(whatChangedAllClearDetail(older())).toBe('No lost mentions or citations, and no runs in progress.')
    expect(whatChangedAllClearDetail(whatChanged())).toBe('No mentions or citations changed, and no runs in progress.')
  })

  it('names the projects compared and unchanged after the changes, and never one with nothing to compare', () => {
    const cove = { id: 'proj_cove', name: 'cove', displayName: 'Cove Dental' }
    const dune = { id: 'proj_dune', name: 'dune', displayName: 'Dune Spa' }
    expect(portfolioWhatChangedItems([
      { project: ACME, whatChanged: whatChanged({ mentions: 2 }) },
      { project: BETA, whatChanged: whatChanged() },
      { project: cove, whatChanged: whatChanged() },
      // Measured once: nothing to compare, so it is not called unchanged.
      { project: dune, whatChanged: whatChanged({ compared: false }) },
      // A run in progress is news, so the project is not unchanged either.
      { project: { id: 'proj_elm', name: 'elm', displayName: 'Elm Law' }, whatChanged: whatChanged(), activeRuns: 1 },
      { project: { id: 'proj_fir', name: 'fir', displayName: 'Fir Hotel' }, whatChanged: null },
    ])).toEqual([
      ACME_LOST_MENTIONS,
      { id: 'attention_proj_elm_active', tone: 'neutral', title: 'Elm Law has active runs', detail: '1 run in progress.', actionLabel: 'View runs', href: '/runs' },
      { id: 'attention_unchanged', tone: 'neutral', title: '2 projects unchanged', detail: 'beta co, Cove Dental. No mentions or citations changed since the previous check.' },
      { id: 'attention_not_compared', tone: 'neutral', title: '1 project not compared', detail: 'Dune Spa. Its latest check had no comparable check before it.' },
      { id: 'attention_unread', tone: 'caution', title: '1 project couldn\'t be loaded', detail: 'Fir Hotel. Its changes are unknown.' },
    ])
  })
})

describe('isWhatChangedActiveRun', () => {
  it.each([
    { run: { kind: 'answer-visibility', status: 'queued', trigger: 'manual' }, active: true },
    { run: { kind: 'answer-visibility', status: 'running', trigger: 'scheduled' }, active: true },
    { run: { kind: 'answer-visibility', status: 'completed', trigger: 'manual' }, active: false },
    { run: { kind: 'answer-visibility', status: 'partial', trigger: 'manual' }, active: false },
    { run: { kind: 'answer-visibility', status: 'failed', trigger: 'manual' }, active: false },
    { run: { kind: 'answer-visibility', status: 'cancelled', trigger: 'manual' }, active: false },
    // A probe is an operator check, never the project's progress.
    { run: { kind: 'answer-visibility', status: 'running', trigger: 'probe' }, active: false },
    // Integration syncs are not AI Visibility sweeps.
    { run: { kind: 'gsc-sync', status: 'running', trigger: 'scheduled' }, active: false },
  ])('$run.kind $run.status $run.trigger is in progress: $active', ({ run, active }) => {
    expect(isWhatChangedActiveRun(run)).toBe(active)
  })
})
