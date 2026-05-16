import { describe, expect, it } from 'vitest'
import { walkPath } from '../src/commands/get.js'

describe('walkPath', () => {
  const fixture = {
    project: { name: 'demand-iq', country: 'US' },
    scores: {
      mention: { value: '15', tone: 'negative' },
      mentionShare: {
        value: '4',
        progress: 4,
        breakdown: {
          perCompetitor: [
            { domain: 'roofr.com', mentionSnapshots: 24, shareOfCompetitiveTotal: 22.2 },
            { domain: 'buildxact.com', mentionSnapshots: 13, shareOfCompetitiveTotal: 12 },
          ],
          projectMentionSnapshots: 5,
        },
      },
    },
    suggestedQueries: { rows: [], totalCandidates: 0 },
    flags: { ready: true, broken: false, missing: null },
  }

  it('returns the root value for empty or "." path', () => {
    expect(walkPath(fixture, '')).toBe(fixture)
    expect(walkPath(fixture, '.')).toBe(fixture)
  })

  it('walks a single-level key', () => {
    expect(walkPath(fixture, 'project')).toEqual({ name: 'demand-iq', country: 'US' })
  })

  it('walks a nested dot path to a scalar', () => {
    expect(walkPath(fixture, 'project.name')).toBe('demand-iq')
    expect(walkPath(fixture, 'scores.mention.value')).toBe('15')
    expect(walkPath(fixture, 'scores.mentionShare.progress')).toBe(4)
  })

  it('walks a nested path to an object', () => {
    expect(walkPath(fixture, 'scores.mentionShare.breakdown')).toEqual({
      perCompetitor: [
        { domain: 'roofr.com', mentionSnapshots: 24, shareOfCompetitiveTotal: 22.2 },
        { domain: 'buildxact.com', mentionSnapshots: 13, shareOfCompetitiveTotal: 12 },
      ],
      projectMentionSnapshots: 5,
    })
  })

  it('walks into an array with [index] syntax', () => {
    expect(walkPath(fixture, 'scores.mentionShare.breakdown.perCompetitor[0].domain')).toBe('roofr.com')
    expect(walkPath(fixture, 'scores.mentionShare.breakdown.perCompetitor[1].mentionSnapshots')).toBe(13)
  })

  it('returns undefined for out-of-range array indices', () => {
    expect(walkPath(fixture, 'scores.mentionShare.breakdown.perCompetitor[99].domain')).toBeUndefined()
  })

  it('returns undefined for missing keys at any level', () => {
    expect(walkPath(fixture, 'scores.nope')).toBeUndefined()
    expect(walkPath(fixture, 'scores.mention.nope.deeper')).toBeUndefined()
  })

  it('returns undefined when path descends past a scalar', () => {
    expect(walkPath(fixture, 'project.name.deeper')).toBeUndefined()
  })

  it('preserves the difference between null, false, and undefined leaves', () => {
    expect(walkPath(fixture, 'flags.ready')).toBe(true)
    expect(walkPath(fixture, 'flags.broken')).toBe(false)
    expect(walkPath(fixture, 'flags.missing')).toBeNull()
    expect(walkPath(fixture, 'flags.gone')).toBeUndefined()
  })

  it('handles bracket-only paths against root arrays', () => {
    const root = [
      { id: 1, name: 'first' },
      { id: 2, name: 'second' },
    ]
    expect(walkPath(root, '[0].name')).toBe('first')
    expect(walkPath(root, '[1].id')).toBe(2)
  })

  it('handles chained brackets foo[0][1]', () => {
    const root = { grid: [[10, 20], [30, 40]] }
    expect(walkPath(root, 'grid[0][1]')).toBe(20)
    expect(walkPath(root, 'grid[1][0]')).toBe(30)
  })

  it('returns undefined on malformed bracket syntax instead of throwing', () => {
    // No closing bracket — defensive path; shouldn't crash, just miss.
    expect(walkPath(fixture, 'scores[bad')).toBeUndefined()
  })

  it('returns undefined when array index syntax is used on a non-array', () => {
    expect(walkPath(fixture, 'project[0]')).toBeUndefined()
  })

  it('returns undefined for non-numeric bracket contents', () => {
    expect(walkPath(fixture, 'scores[abc]')).toBeUndefined()
  })
})
