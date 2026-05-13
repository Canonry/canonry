import { describe, it, expect } from 'vitest'
import { groupRunsByCreatedAt, pickGroupRepresentative } from '../src/run-helpers.js'

describe('groupRunsByCreatedAt', () => {
  it('returns an empty array for empty input', () => {
    expect(groupRunsByCreatedAt([])).toEqual([])
  })

  it('groups same-timestamp rows together', () => {
    const rows = [
      { id: 'a', createdAt: '2026-05-13T17:23:20.060Z' },
      { id: 'b', createdAt: '2026-05-13T17:23:20.060Z' },
      { id: 'c', createdAt: '2026-05-12T17:23:20.060Z' },
    ]
    const groups = groupRunsByCreatedAt(rows)
    expect(groups).toHaveLength(2)
    expect(groups[0]?.map(r => r.id)).toEqual(['a', 'b'])
    expect(groups[1]?.map(r => r.id)).toEqual(['c'])
  })

  it('emits one group per row when timestamps are all distinct', () => {
    const rows = [
      { id: 'a', createdAt: '2026-05-13T00:00:00Z' },
      { id: 'b', createdAt: '2026-05-12T00:00:00Z' },
      { id: 'c', createdAt: '2026-05-11T00:00:00Z' },
    ]
    const groups = groupRunsByCreatedAt(rows)
    expect(groups).toHaveLength(3)
    expect(groups.every(g => g.length === 1)).toBe(true)
  })

  it('preserves input order within each group', () => {
    const rows = [
      { id: 'z', createdAt: '2026-05-13T17:23:20.060Z' },
      { id: 'a', createdAt: '2026-05-13T17:23:20.060Z' },
      { id: 'm', createdAt: '2026-05-13T17:23:20.060Z' },
    ]
    const groups = groupRunsByCreatedAt(rows)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.map(r => r.id)).toEqual(['z', 'a', 'm'])
  })
})

describe('pickGroupRepresentative', () => {
  it('returns null for an empty group', () => {
    expect(pickGroupRepresentative([])).toBeNull()
  })

  it('returns the single member when the group has one row', () => {
    const only = { id: 'a' }
    expect(pickGroupRepresentative([only])).toBe(only)
  })

  it('returns the lexicographically-greatest id (matches /runs/latest tiebreak)', () => {
    const rows = [
      { id: '00000000-0000-0000-0000-000000000001' },
      { id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' },
      { id: '88888888-8888-8888-8888-888888888888' },
    ]
    const winner = pickGroupRepresentative(rows)
    expect(winner?.id).toBe('ffffffff-ffff-ffff-ffff-ffffffffffff')
  })

  it('is deterministic across input orderings', () => {
    const rows = [
      { id: 'aaa' },
      { id: 'bbb' },
      { id: 'ccc' },
    ]
    const first = pickGroupRepresentative(rows)
    const second = pickGroupRepresentative([...rows].reverse())
    expect(first?.id).toBe('ccc')
    expect(second?.id).toBe('ccc')
  })
})
