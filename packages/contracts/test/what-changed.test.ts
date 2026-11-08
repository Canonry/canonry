import { describe, expect, it } from 'vitest'
import type { ProjectOverviewWhatChangedDto } from '../src/composites.js'
import { portfolioWhatChangedItems } from '../src/what-changed.js'

const NOTHING_LOST = { queryCount: 0, queries: [], truncated: false }

function project(items: ProjectOverviewWhatChangedDto['items'], checked: boolean): ProjectOverviewWhatChangedDto {
  return {
    mode: 'simple',
    latestCheck: checked ? { runIds: ['run_latest'], createdAt: '2026-09-08T00:00:00.000Z' } : null,
    comparison: checked ? { state: 'available', previousRunIds: ['run_previous'] } : { state: 'unavailable', reason: 'not-measured' },
    lostMentions: NOTHING_LOST,
    lostCitations: NOTHING_LOST,
    activeRuns: { count: 0, runIds: [] },
    items,
  }
}

const ACME_LOST = { id: 'attention_acme_lost_mentions', tone: 'negative' as const, title: 'Acme lost mentions', detail: '2 queries lost a mention in the latest check.', actionLabel: 'Open project', href: '/projects/acme' }
const ACME_ACTIVE = { id: 'attention_acme_active', tone: 'neutral' as const, title: 'Acme has active runs', detail: '1 run in progress.', actionLabel: 'View runs', href: '/runs' }
const BETA_LOST = { id: 'attention_beta_lost', tone: 'negative' as const, title: 'Beta lost citations', detail: '1 query lost a citation in the latest check.', actionLabel: 'Open project', href: '/projects/beta' }

// The all-clear and awaiting rows lead nowhere: Overview is the page they sit on.
const ALL_CLEAR = { id: 'attention_stable', tone: 'positive', title: 'All projects stable', detail: 'No lost mentions or citations, and no runs in progress.' }
const AWAITING = { id: 'attention_awaiting', tone: 'neutral', title: 'Awaiting first measurement', detail: 'Visibility results will appear after the first check.' }

describe('portfolioWhatChangedItems', () => {
  it('lists every project\'s rows in project order, unchanged', () => {
    expect(portfolioWhatChangedItems([
      project([ACME_LOST, ACME_ACTIVE], true),
      project([], true),
      project([BETA_LOST], true),
    ])).toEqual([ACME_LOST, ACME_ACTIVE, BETA_LOST])
  })

  it('lists the projects it could read when another project\'s overview failed', () => {
    expect(portfolioWhatChangedItems([null, project([BETA_LOST], true)])).toEqual([BETA_LOST])
  })

  it('says all clear when nothing changed and any project has a check, with no destination', () => {
    expect(portfolioWhatChangedItems([project([], true), project([], false), null])).toEqual([ALL_CLEAR])
  })

  it('awaits the first measurement when no project has a check yet', () => {
    expect(portfolioWhatChangedItems([project([], false), null])).toEqual([AWAITING])
    expect(portfolioWhatChangedItems([null])).toEqual([AWAITING])
  })

  // A first sweep still running is news, not a reason to wait quietly.
  it('lists a run in progress before any project has a check', () => {
    expect(portfolioWhatChangedItems([project([ACME_ACTIVE], false)])).toEqual([ACME_ACTIVE])
  })

  it('has no rows without projects', () => {
    expect(portfolioWhatChangedItems([])).toEqual([])
  })
})
