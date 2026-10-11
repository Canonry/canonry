import { describe, expect, it } from 'vitest'
import { diffProjectConfigState, type ProjectConfigState } from '../src/config-diff.js'

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
})
