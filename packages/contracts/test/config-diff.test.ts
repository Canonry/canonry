import { describe, expect, it } from 'vitest'
import { applyPreviewDtoSchema, diffProjectConfigState, projectConfigStateSchema, type ProjectConfigState } from '../src/config-diff.js'

const state = (overrides: Partial<ProjectConfigState> = {}): ProjectConfigState => ({
  project: { id: 'project-1', name: 'example' },
  configRevision: 1,
  fields: { displayName: 'Example' },
  queries: [],
  competitors: [],
  schedule: null,
  notifications: [],
  managed: { queries: true, competitors: true, schedule: true, notifications: true },
  detachedSnapshotCount: 0,
  ...overrides,
})

describe('diffProjectConfigState', () => {
  it('reports no changes for equal state', () => {
    const before = state()
    expect(diffProjectConfigState(before, before)).toMatchObject({ action: 'none', changed: false, fields: {} })
  })

  it('reports created fields and child resources', () => {
    const result = diffProjectConfigState(null, state({
      project: { id: 'new-project', name: 'created' },
      configRevision: 1,
      fields: { displayName: 'Created' },
      queries: [{ id: 'q1', text: 'new query' }],
      competitors: [{ id: 'c1', domain: 'new.example', aliases: [] }],
    }))
    expect(result).toMatchObject({
      action: 'create',
      project: { id: null, name: 'created' },
      changed: true,
      queries: { added: ['new query'], removed: [] },
      competitors: { added: ['new.example'], removed: [] },
    })
  })

  it('treats query casing and surrounding whitespace as unchanged', () => {
    const result = diffProjectConfigState(
      state({ queries: [{ id: 'q1', text: 'How To Repair Roofs' }] }),
      state({ queries: [{ id: 'q2', text: '  how to repair roofs  ' }] }),
    )
    expect(result.queries).toMatchObject({ added: [], removed: [], unchangedCount: 1 })
  })

  it('deduplicates query identity while retaining exact additions and removals', () => {
    const before = state({ queries: [{ id: 'a', text: 'Unchanged' }, { id: 'b', text: 'Removed' }] })
    const after = state({ queries: [{ id: 'c', text: ' unchanged ' }, { id: 'd', text: 'UNCHANGED' }, { id: 'e', text: 'Added' }], detachedSnapshotCount: 2 })
    expect(diffProjectConfigState(before, after).queries).toEqual({ managed: true, added: ['Added'], removed: ['Removed'], unchangedCount: 1, snapshotsDetached: 2 })
  })

  it('keeps field and schedule values contract typed and accepts lifecycle effects and dropped aliases', () => {
    const before = state({ fields: { displayName: 'Example' } })
    const after = state({
      fields: { displayName: 'Changed', providers: ['gemini'] },
      schedule: { cron: '0 9 * * *', timezone: 'UTC', providers: ['gemini'], enabled: true },
    })
    const result = diffProjectConfigState(before, after, {
      droppedAliases: [{ domain: 'old.example', alias: 'Old Brand', reason: 'other-competitor' }],
      effects: ['competitor-rescore', 'schedule-reload'],
    })
    expect(projectConfigStateSchema.parse(after)).toEqual(after)
    expect(applyPreviewDtoSchema.parse(result)).toEqual(result)
    expect(result.fields).toMatchObject({ displayName: { before: 'Example', after: 'Changed' } })
    expect(result.competitors.droppedAliases).toEqual([{ domain: 'old.example', alias: 'Old Brand', reason: 'other-competitor' }])
    expect(result.effects).toEqual(['competitor-rescore', 'schedule-reload'])
  })
})
