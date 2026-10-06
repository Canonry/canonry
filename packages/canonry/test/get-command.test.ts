import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeCliRead, prepareCliReadFixture } from './cli-read-fixture.js'
import { invokeCli } from './cli-test-utils.js'

describe('walkPath', () => {
  let cleanup = () => {}
  beforeEach(() => { cleanup = prepareCliReadFixture() })
  afterEach(() => { cleanup() })
  const fixture = {
    project: { name: 'acme-iq', country: 'US' },
    scores: {
      mention: { value: '15', tone: 'negative' },
      mentionShare: {
        value: '4',
        progress: 4,
        breakdown: {
          perCompetitor: [
            { domain: 'quotebird.test', mentionSnapshots: 24, shareOfCompetitiveTotal: 22.2 },
            { domain: 'bidhammer.test', mentionSnapshots: 13, shareOfCompetitiveTotal: 12 },
          ],
          projectMentionSnapshots: 5,
        },
      },
    },
    suggestedQueries: { rows: [], totalCandidates: 0 },
    flags: { ready: true, broken: false, missing: null },
  }

  async function readPath(payload: unknown, field: string, from = 'overview'): Promise<unknown> {
    const expected = { pathname: `/prefix/api/v1/projects/acme-iq/${from}` }
    const result = await invokeCliRead(['get', 'acme-iq', field, ...(from === 'overview' ? [] : ['--from', from]), '--format', 'json'], payload, expected)
    if (result.exitCode !== undefined) {
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      expect(JSON.parse(result.stderr)).toEqual({ error: {
        code: 'PATH_NOT_FOUND', message: `Path "${field}" not found in ${from} response for project "acme-iq".`,
        details: { project: 'acme-iq', path: field, from },
      } })
      return undefined
    }
    expect(result.stderr).toBe('')
    const value: unknown = JSON.parse(result.stdout)
    const text = await invokeCliRead(['get', 'acme-iq', field, ...(from === 'overview' ? [] : ['--from', from])], payload, expected)
    expect(text.exitCode).toBeUndefined()
    expect(text.stderr).toBe('')
    expect(text.stdout).toBe(typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : String(value))
    return value
  }

  it('returns the root value for empty or "." path', async () => {
    expect(await readPath(fixture, '.')).toEqual(fixture)
    const empty = await invokeCli(['get', 'acme-iq', '', '--format', 'json'])
    expect(empty.exitCode).toBe(1)
    expect(empty.stdout).toBe('')
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
    expect(JSON.parse(empty.stderr).error).toMatchObject({ code: 'CLI_USAGE_ERROR', message: 'path is required (e.g. "scores.mentionShare.value")' })
  })

  it('walks a single-level key', async () => {
    for (const source of ['overview', 'doctor', 'runs', 'queries', 'competitors']) {
      expect(await readPath(fixture, 'project', source)).toEqual({ name: 'acme-iq', country: 'US' })
    }
    const invalid = await invokeCli(['get', 'acme-iq', 'project', '--from', 'unknown', '--format', 'json'])
    expect(invalid.exitCode).toBe(1)
    expect(invalid.stdout).toBe('')
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
    expect(JSON.parse(invalid.stderr)).toEqual({ error: {
      code: 'INVALID_GET_SOURCE', message: 'Unknown --from value "unknown". Valid: overview, doctor, runs, queries, competitors.',
      details: { from: 'unknown', valid: ['overview', 'doctor', 'runs', 'queries', 'competitors'] },
    } })
  })

  it('walks a nested dot path to a scalar', async () => {
    expect(await readPath(fixture, 'project.name')).toBe('acme-iq')
    expect(await readPath(fixture, 'scores.mention.value')).toBe('15')
    expect(await readPath(fixture, 'scores.mentionShare.progress')).toBe(4)
  })

  it('walks a nested path to an object', async () => {
    expect(await readPath(fixture, 'scores.mentionShare.breakdown')).toEqual({
      perCompetitor: [
        { domain: 'quotebird.test', mentionSnapshots: 24, shareOfCompetitiveTotal: 22.2 },
        { domain: 'bidhammer.test', mentionSnapshots: 13, shareOfCompetitiveTotal: 12 },
      ],
      projectMentionSnapshots: 5,
    })
  })

  it('walks into an array with [index] syntax', async () => {
    expect(await readPath(fixture, 'scores.mentionShare.breakdown.perCompetitor[0].domain')).toBe('quotebird.test')
    expect(await readPath(fixture, 'scores.mentionShare.breakdown.perCompetitor[1].mentionSnapshots')).toBe(13)
  })

  it('returns undefined for out-of-range array indices', async () => {
    expect(await readPath(fixture, 'scores.mentionShare.breakdown.perCompetitor[99].domain')).toBeUndefined()
  })

  it('returns undefined for missing keys at any level', async () => {
    expect(await readPath(fixture, 'scores.nope')).toBeUndefined()
    expect(await readPath(fixture, 'scores.mention.nope.deeper')).toBeUndefined()
  })

  it('returns undefined when path descends past a scalar', async () => {
    expect(await readPath(fixture, 'project.name.deeper')).toBeUndefined()
    expect(await readPath(fixture, 'project.name.length')).toBeUndefined()
  })

  it('preserves the difference between null, false, and undefined leaves', async () => {
    expect(await readPath(fixture, 'flags.ready')).toBe(true)
    expect(await readPath(fixture, 'flags.broken')).toBe(false)
    expect(await readPath(fixture, 'flags.missing')).toBeNull()
    expect(await readPath(fixture, 'flags.gone')).toBeUndefined()
  })

  it('handles bracket-only paths against root arrays', async () => {
    const root = [
      { id: 1, name: 'first' },
      { id: 2, name: 'second' },
    ]
    expect(await readPath(root, '[0].name', 'queries')).toBe('first')
    expect(await readPath(root, '[1].id', 'queries')).toBe(2)
  })

  it('handles chained brackets foo[0][1]', async () => {
    const root = { grid: [[10, 20], [30, 40]] }
    expect(await readPath(root, 'grid[0][1]')).toBe(20)
    expect(await readPath(root, 'grid[1][0]')).toBe(30)
  })

  it('returns undefined on malformed bracket syntax instead of throwing', async () => {
    // No closing bracket — defensive path; shouldn't crash, just miss.
    expect(await readPath(fixture, 'scores[bad')).toBeUndefined()
  })

  it('returns undefined when array index syntax is used on a non-array', async () => {
    expect(await readPath(fixture, 'project[0]')).toBeUndefined()
    expect(await readPath({ project: { ...fixture.project, '0': 'not-an-array' } }, 'project[0]')).toBeUndefined()
  })

  it('returns undefined for non-numeric bracket contents', async () => {
    expect(await readPath(fixture, 'scores.mentionShare.breakdown.perCompetitor[abc].domain')).toBeUndefined()
    expect(await readPath(fixture, 'scores.mentionShare.breakdown.perCompetitor[1].domain')).toBe('bidhammer.test')
  })
})
