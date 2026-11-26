import { describe, expect, it } from 'vitest'
import { overviewActivityRuns, type OverviewActivityRun } from '../src/overview-activity.js'

function run(id: string, fields: Partial<OverviewActivityRun> & Pick<OverviewActivityRun, 'status' | 'createdAt'>): OverviewActivityRun {
  return { id, projectId: 'proj_a', kind: 'gsc-sync', trigger: 'scheduled', ...fields }
}

describe('overviewActivityRuns', () => {
  it('keeps each job\'s latest run only when it failed or is still working, newest first', () => {
    const runs = [
      // GSC failed, then succeeded: fixed, so not listed.
      run('gsc-1', { status: 'failed', createdAt: '2026-11-20T00:00:00.000Z' }),
      run('gsc-2', { status: 'completed', createdAt: '2026-11-21T00:00:00.000Z' }),
      // GA succeeded, then failed: listed with its latest run.
      run('ga-1', { kind: 'ga-sync', status: 'completed', createdAt: '2026-11-20T00:00:00.000Z' }),
      run('ga-2', { kind: 'ga-sync', status: 'failed', createdAt: '2026-11-22T00:00:00.000Z' }),
      // A sweep in progress, and another project's partial sweep.
      run('sweep-a', { kind: 'answer-visibility', status: 'running', createdAt: '2026-11-23T00:00:00.000Z' }),
      run('sweep-b', { projectId: 'proj_b', kind: 'answer-visibility', status: 'partial', createdAt: '2026-11-19T00:00:00.000Z' }),
      // A cancelled audit is the audit's latest state.
      run('audit', { kind: 'site-audit', status: 'cancelled', createdAt: '2026-11-18T00:00:00.000Z' }),
    ]
    expect(overviewActivityRuns(runs).map(row => row.id)).toEqual(['sweep-a', 'ga-2', 'sweep-b', 'audit'])
  })

  it('reads each project and kind apart: one project\'s success never hides another\'s failure', () => {
    expect(overviewActivityRuns([
      run('a-ok', { projectId: 'proj_a', status: 'completed', createdAt: '2026-11-22T00:00:00.000Z' }),
      run('b-failed', { projectId: 'proj_b', status: 'failed', createdAt: '2026-11-21T00:00:00.000Z' }),
    ]).map(row => row.id)).toEqual(['b-failed'])
  })

  it('never counts a probe, even one newer than the job\'s last real run', () => {
    expect(overviewActivityRuns([
      run('real', { kind: 'answer-visibility', status: 'failed', createdAt: '2026-11-20T00:00:00.000Z' }),
      run('probe', { kind: 'answer-visibility', status: 'completed', trigger: 'probe', createdAt: '2026-11-21T00:00:00.000Z' }),
    ]).map(row => row.id)).toEqual(['real'])
  })

  it('breaks a tie on time by id, whatever order the runs arrive in', () => {
    const tie = '2026-11-21T00:00:00.000Z'
    const older = run('run-a', { status: 'failed', createdAt: tie })
    const newer = run('run-b', { status: 'completed', createdAt: tie })
    expect(overviewActivityRuns([older, newer])).toEqual([])
    expect(overviewActivityRuns([newer, older])).toEqual([])
  })

  // `--all-locations` stores one run per location with the same createdAt and
  // random ids, so a tie on time must never let one location hide another.
  it('keeps each location apart, so a completed sibling never hides a failed one', () => {
    const at = '2026-11-21T00:00:00.000Z'
    const runs = [
      run('z-michigan', { kind: 'answer-visibility', location: 'michigan', status: 'completed', createdAt: at }),
      run('a-florida', { kind: 'answer-visibility', location: 'florida', status: 'failed', createdAt: at }),
      run('m-texas', { kind: 'answer-visibility', location: 'texas', status: 'queued', createdAt: at }),
    ]
    expect(overviewActivityRuns(runs).map(row => row.id)).toEqual(['m-texas', 'a-florida'])
  })

  it('never lets a spot check or another source stand in for a failed job', () => {
    const runs = [
      run('sweep-failed', { kind: 'answer-visibility', status: 'failed', createdAt: '2026-11-20T00:00:00.000Z' }),
      // A later spot check of two queries, and a later plan-scoped one, both completed.
      run('spot-queries', { kind: 'answer-visibility', status: 'completed', createdAt: '2026-11-21T00:00:00.000Z', queries: ['best roofer'] }),
      run('spot-scope', { kind: 'answer-visibility', status: 'completed', createdAt: '2026-11-22T00:00:00.000Z', measurementScope: { groups: ['metro'] } }),
      // One traffic source failing while another syncs fine.
      run('traffic-a', { kind: 'traffic-sync', sourceId: 'source-a', status: 'failed', createdAt: '2026-11-19T00:00:00.000Z' }),
      run('traffic-b', { kind: 'traffic-sync', sourceId: 'source-b', status: 'completed', createdAt: '2026-11-22T00:00:00.000Z' }),
    ]
    expect(overviewActivityRuns(runs).map(row => row.id)).toEqual(['sweep-failed', 'traffic-a'])
  })

  it('lists nothing when every job\'s latest run completed, or there are no runs', () => {
    expect(overviewActivityRuns([run('ok', { status: 'completed', createdAt: '2026-11-21T00:00:00.000Z' })])).toEqual([])
    expect(overviewActivityRuns([])).toEqual([])
  })
})
