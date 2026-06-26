import { describe, it, expect } from 'vitest'
import { truncateToolResult } from '../src/agent/mcp-to-agent-tool.js'

const CAP = 20_000

/** A row carrying a unique, recognizable marker so the test can prove no row is
 *  split mid-content (every retained row's reasonCode survives intact). */
function evidenceRow(i: number) {
  return { id: `action-${i}`, reasonCode: `R${i}`, evidence: 'x'.repeat(60) }
}

describe('truncateToolResult (OSS-C)', () => {
  it('is byte-identical to pretty JSON for a sub-cap result', () => {
    const details = { summary: { total: 2 }, actions: [evidenceRow(0), evidenceRow(1)] }
    expect(truncateToolResult(details)).toBe(JSON.stringify(details, null, 2))
  })

  it('trims an oversized object by WHOLE rows of its largest array, never mid-row', () => {
    const actions = Array.from({ length: 600 }, (_, i) => evidenceRow(i))
    const details = { summary: { total: actions.length }, actions }
    const out = truncateToolResult(details)

    // Still valid, parseable JSON (the old blind slice produced invalid JSON).
    const parsed = JSON.parse(out) as {
      summary: { total: number }
      actions: Array<{ id: string; reasonCode: string; evidence: string }>
      __truncated: boolean
      __omittedRows: number
    }

    expect(out.length).toBeLessThanOrEqual(CAP)
    expect(parsed.__truncated).toBe(true)
    // Non-array fields are preserved intact.
    expect(parsed.summary).toEqual({ total: 600 })
    // Kept rows are a PREFIX of the original, each byte-intact (reasonCode survives).
    expect(parsed.actions.length).toBeGreaterThan(0)
    parsed.actions.forEach((row, i) => expect(row).toEqual(actions[i]))
    // The omitted count is exact: kept + omitted === original.
    expect(parsed.actions.length + parsed.__omittedRows).toBe(actions.length)
    expect(parsed.__omittedRows).toBeGreaterThan(0)
  })

  it('wraps + trims an oversized TOP-LEVEL array with an omitted marker', () => {
    const rows = Array.from({ length: 600 }, (_, i) => evidenceRow(i))
    const out = truncateToolResult(rows)
    const parsed = JSON.parse(out) as {
      items: Array<{ id: string; reasonCode: string }>
      __truncated: boolean
      __omittedRows: number
    }
    expect(out.length).toBeLessThanOrEqual(CAP)
    expect(parsed.__truncated).toBe(true)
    parsed.items.forEach((row, i) => expect(row).toEqual(rows[i]))
    expect(parsed.items.length + parsed.__omittedRows).toBe(rows.length)
  })

  it('falls back to a marked string slice for an oversized scalar with nothing to drop', () => {
    const giant = 'y'.repeat(CAP + 5_000)
    const out = truncateToolResult(giant)
    expect(out.length).toBeLessThanOrEqual(CAP + 50)
    expect(out).toContain('truncated')
  })
})
