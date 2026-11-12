import { describe, expect, it } from 'vitest'
import type { ProjectOverviewWhatChangedDto } from '../src/composites.js'
import { isWhatChangedActiveRun, portfolioWhatChangedItems } from '../src/what-changed.js'

const ACME = { id: 'proj_acme', name: 'acme', displayName: 'Acme Coatings' }
const BETA = { id: 'proj_beta', name: 'beta co', displayName: '' }

function lost(queryCount: number) {
  return { queryCount, queries: [], truncated: false }
}

/** A project's overview `whatChanged` with these counts; `checked` false is a project never measured. */
function whatChanged(counts: { mentions?: number; citations?: number; active?: number; checked?: boolean } = {}): ProjectOverviewWhatChangedDto {
  const checked = counts.checked ?? true
  return {
    mode: 'simple',
    latestCheck: checked ? { runIds: ['run_latest'], createdAt: '2026-09-08T00:00:00.000Z' } : null,
    comparison: checked ? { state: 'available', previousRunIds: ['run_previous'] } : { state: 'unavailable', reason: 'not-measured' },
    lostMentions: lost(counts.mentions ?? 0),
    lostCitations: lost(counts.citations ?? 0),
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
const ALL_CLEAR = { id: 'attention_stable', tone: 'positive', title: 'All projects stable', detail: 'No lost mentions or citations, and no runs in progress.' }
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
      { id: 'attention_unread', tone: 'caution', title: '1 project couldn\'t be loaded', detail: 'Acme Coatings. Its lost mentions and citations are unknown.' },
    ])
  })

  it('lists the readable projects\' rows, then names every unread project', () => {
    expect(portfolioWhatChangedItems([
      { project: ACME, whatChanged: null },
      { project: BETA, whatChanged: whatChanged({ mentions: 1 }) },
      { project: { id: 'proj_cove', name: 'cove', displayName: 'Cove Dental' }, whatChanged: null },
    ])).toEqual([
      BETA_LOST_MENTION,
      { id: 'attention_unread', tone: 'caution', title: '2 projects couldn\'t be loaded', detail: 'Acme Coatings, Cove Dental. Their lost mentions and citations are unknown.' },
    ])
  })

  // Runs in progress are known from the run list even when the overview is not.
  it('keeps an unread project\'s runs in progress from the fresher source', () => {
    expect(portfolioWhatChangedItems([{ project: BETA, whatChanged: null, activeRuns: 3 }])).toEqual([
      BETA_ACTIVE,
      { id: 'attention_unread', tone: 'caution', title: '1 project couldn\'t be loaded', detail: 'beta co. Its lost mentions and citations are unknown.' },
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
