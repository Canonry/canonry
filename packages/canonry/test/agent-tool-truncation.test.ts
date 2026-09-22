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

  it('keeps nested model identities and denominators while marking omitted evidence per group', () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ ...evidenceRow(i), sampleUrls: [`https://example.com/${i}`] }))
    const groups = ['model-a', 'model-b'].map(model => ({
      provider: 'openai', model, servedModels: { status: 'unknown' }, snapshotCount: 300,
      evidence: { answeredResults: 300, mentionCredits: 450 },
      project: { mentionCount: 150, shareOfVoice: 100 / 3 },
      observed: rows,
    }))
    const details = {
      observed: rows,
      evidence: { answeredResults: 600, mentionCredits: 900 },
      modelComparison: { basis: 'requested-model', groups, totalGroups: 2, truncated: false },
    }
    const original = JSON.stringify(details)
    const out = truncateToolResult(details)
    const parsed = JSON.parse(out)

    expect(out.length).toBeLessThanOrEqual(CAP)
    expect(parsed.__truncated).toBe(true)
    expect(parsed.evidence).toEqual(details.evidence)
    expect(parsed.modelComparison.groups).toHaveLength(2)
    expect(parsed.modelComparison.totalGroups).toBe(2)
    for (const [index, group] of parsed.modelComparison.groups.entries()) {
      expect(group.model).toBe(groups[index]!.model)
      expect(group.servedModels).toEqual(groups[index]!.servedModels)
      expect(group.evidence).toEqual(groups[index]!.evidence)
      expect(group.project).toEqual(groups[index]!.project)
      expect(group.snapshotCount).toBe(300)
      expect(group.observed).toEqual(rows.slice(0, group.observed.length))
      expect(group.observed.length + (group.__omittedRowsByField?.observed ?? 0)).toBe(300)
    }
    expect(parsed.observed.length + (parsed.__omittedRowsByField?.observed ?? 0)).toBe(300)
    expect(JSON.stringify(details)).toBe(original)
  })

  it('handles nested-only and multiple oversized arrays with path-local counts', () => {
    const rows = Array.from({ length: 300 }, (_, i) => evidenceRow(i))
    const details = { result: { first: rows, second: rows, total: 600 } }
    const out = truncateToolResult(details)
    const parsed = JSON.parse(out)

    expect(out.length).toBeLessThanOrEqual(CAP)
    expect(parsed.result.total).toBe(600)
    expect(parsed.result.__truncated).toBe(true)
    for (const key of ['first', 'second']) {
      expect(parsed.result[key]).toEqual(rows.slice(0, parsed.result[key].length))
      expect(parsed.result[key].length + (parsed.result.__omittedRowsByField[key] ?? 0)).toBe(300)
    }
    expect(details.result.first).toHaveLength(300)
    expect(details.result.second).toHaveLength(300)
  })

  it('does not trim served-model identity arrays before dropping evidence or whole groups', () => {
    const models = Array.from({ length: 80 }, (_, i) => `model-${i}-${'x'.repeat(160)}`)
    const groups = ['requested-a', 'requested-b'].map(model => ({
      provider: 'openai', model,
      servedModels: { status: 'mixed', models, includesUnknown: false },
      snapshotCount: 80,
      observed: Array.from({ length: 60 }, (_, i) => evidenceRow(i)),
    }))
    const details = { modelComparison: { basis: 'requested-model', groups, totalGroups: 2, truncated: false } }
    const original = JSON.stringify(details)
    const out = truncateToolResult(details)
    const parsed = JSON.parse(out)

    expect(out.length).toBeLessThanOrEqual(CAP)
    expect(parsed.modelComparison.groups.length).toBeGreaterThan(0)
    for (const [index, group] of parsed.modelComparison.groups.entries()) {
      expect(group.servedModels).toEqual(groups[index]!.servedModels)
      expect(group.model).toBe(groups[index]!.model)
      expect(group.snapshotCount).toBe(80)
    }
    expect(parsed.modelComparison.groups.length + (parsed.modelComparison.__omittedRowsByField?.groups ?? 0)).toBe(2)
    expect(JSON.stringify(details)).toBe(original)
  })

  it('drops whole nested groups only when their metadata alone exceeds the cap', () => {
    const groups = Array.from({ length: 300 }, (_, i) => ({ ...evidenceRow(i), observed: [] }))
    const out = truncateToolResult({ modelComparison: { groups, totalGroups: groups.length } })
    const parsed = JSON.parse(out)

    expect(out.length).toBeLessThanOrEqual(CAP)
    expect(parsed.modelComparison.groups.length).toBeGreaterThan(0)
    expect(parsed.modelComparison.groups).toEqual(groups.slice(0, parsed.modelComparison.groups.length))
    expect(parsed.modelComparison.groups.length + parsed.modelComparison.__omittedRowsByField.groups).toBe(300)
    expect(parsed.modelComparison.totalGroups).toBe(300)
  })

  it('falls back to a marked string slice for an oversized scalar with nothing to drop', () => {
    const giant = 'y'.repeat(CAP + 5_000)
    const out = truncateToolResult(giant)
    expect(out.length).toBeLessThanOrEqual(CAP + 50)
    expect(out).toContain('truncated')
  })

  it('preserves the scalar fallback for objects with a scalar JSON representation', () => {
    const out = truncateToolResult({ toJSON: () => 'x'.repeat(CAP + 1_000) })
    expect(out.length).toBeLessThanOrEqual(CAP + 50)
    expect(out).toContain('truncated')
  })

  // Both structured paths re-serialize the enclosing document per step, so the
  // shape of the payload, not just its size, decides the cost. These two shapes
  // each stalled the server thread for seconds before the traversals were
  // bounded: 5.2s for the top-level array, 2.1s for many small collections.
  it('bounds a large top-level array without a per-row re-serialization', () => {
    const payload = {
      run: { id: 'run-1', status: 'completed' },
      snapshots: Array.from({ length: 2_400 }, (_, i) => ({
        id: `snap-${i}`, provider: 'openai', answerText: 'y'.repeat(900),
      })),
    }
    expect(JSON.stringify(payload, null, 2).length).toBeGreaterThan(2_000_000)

    const started = Date.now()
    const out = truncateToolResult(payload)
    const elapsedMs = Date.now() - started

    expect(out.length).toBeLessThanOrEqual(CAP + 50)
    expect(elapsedMs).toBeLessThan(1_500)
  })

  it('bounds many small collections that sit under the byte ceiling', () => {
    const data: Record<string, unknown> = {}
    for (let g = 0; g < 800; g++) {
      data[`group_${g}`] = {
        label: `g${g}`,
        rows: Array.from({ length: 4 }, (_, i) => ({
          id: `r-${g}-${i}`, provider: 'openai', answerText: 'y'.repeat(380),
        })),
      }
    }
    const payload = { data }
    // Deliberately UNDER the byte ceiling: size is not what makes this slow.
    const bytes = JSON.stringify(payload, null, 2).length
    expect(bytes).toBeLessThan(2_000_000)

    const started = Date.now()
    const out = truncateToolResult(payload)
    const elapsedMs = Date.now() - started

    expect(out.length).toBeLessThanOrEqual(CAP + 50)
    expect(elapsedMs).toBeLessThan(1_500)
  })

  // The nested-collection path drops one collection per iteration and re-walks
  // (and re-serializes) the whole document each time, so its cost is quadratic
  // in the number of collections. A real 20 MB run payload spent 289 seconds of
  // the server's single thread to emit the same ~19k characters a slice gives.
  // Above the ceiling the marked slice is taken instead.
  it('falls back to the marked slice instead of walking a pathological payload', () => {
    const payload = {
      run: {
        id: 'run-1',
        snapshots: Array.from({ length: 6_000 }, (_, i) => ({
          id: `snap-${i}`,
          queryId: `q-${i}`,
          answerText: 'y'.repeat(400),
        })),
      },
    }
    // Precondition: no TOP-LEVEL array (so the largest-array path cannot take
    // it) and past the structured-truncation ceiling.
    expect(Array.isArray(payload)).toBe(false)
    expect(Object.values(payload).some((v) => Array.isArray(v))).toBe(false)
    expect(JSON.stringify(payload, null, 2).length).toBeGreaterThan(2_000_000)

    const started = Date.now()
    const out = truncateToolResult(payload)
    const elapsedMs = Date.now() - started

    expect(out.length).toBeLessThanOrEqual(CAP + 50)
    // The marked slice ends with the truncation note; the structure-aware path
    // would instead return JSON carrying __truncated, so this discriminates.
    expect(out.trimEnd().endsWith('result too large)')).toBe(true)
    expect(elapsedMs).toBeLessThan(3_000)
  })
})
