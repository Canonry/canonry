import { describe, it, expect } from 'vitest'
import { parseJsonColumn } from '../src/json.js'

describe('parseJsonColumn', () => {
  it('returns fallback for null', () => {
    expect(parseJsonColumn(null, [])).toEqual([])
  })

  it('returns fallback for undefined', () => {
    expect(parseJsonColumn(undefined, {})).toEqual({})
  })

  it('returns fallback for empty string', () => {
    expect(parseJsonColumn('', [])).toEqual([])
  })

  it('returns fallback for invalid JSON', () => {
    expect(parseJsonColumn('not-json', [])).toEqual([])
  })

  it('parses valid JSON array', () => {
    expect(parseJsonColumn('["a","b"]', [])).toEqual(['a', 'b'])
  })

  it('parses valid JSON object', () => {
    expect(parseJsonColumn('{"key":"value"}', {})).toEqual({ key: 'value' })
  })

  it('uses typed fallback', () => {
    const fallback = { url: '', events: [] as string[] }
    const result = parseJsonColumn<typeof fallback>(null, fallback)
    expect(result).toBe(fallback)
  })
})
