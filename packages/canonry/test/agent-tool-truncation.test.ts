import { describe, it, expect } from 'vitest'
import { truncateToolResult } from '../src/agent/mcp-to-agent-tool.js'

const CAP = 20_000

/** A row carrying a unique, recognizable marker so the test can prove no row is
 *  split mid-content (every retained row's reasonCode survives intact). */
function evidenceRow(i: number) {
  return { id: `action-${i}`, reasonCode: `R${i}`, evidence: 'x'.repeat(60) }
}

describe('truncateToolResult (OSS-C)', () => {
  it('is byte-identical to compact JSON for a sub-cap result', () => {
    const details = { summary: { total: 2 }, actions: [evidenceRow(0), evidenceRow(1)] }
    expect(truncateToolResult(details)).toBe(JSON.stringify(details))
  })

  it('serializes compactly, so a result pretty JSON would overrun passes whole', () => {
    const actions = Array.from({ length: 150 }, (_, i) => evidenceRow(i))
    const details = { summary: { total: actions.length }, actions }
    expect(JSON.stringify(details, null, 2).length).toBeGreaterThan(CAP)
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(CAP)
    expect(JSON.parse(truncateToolResult(details))).toEqual(details)
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

/** A property-shaped row: its own metrics plus a nested list of names seen instead. */
function propertyRow(i: number, namesSeen = 5) {
  return {
    targetKey: `property-${i}`,
    label: `Harbor Homes ${i}`,
    mentionCoverage: { state: 'available', value: 0, numerator: 0, denominator: 24 },
    citationCoverage: { state: 'available', value: 0, numerator: 0, denominator: 24 },
    namedInstead: Array.from({ length: namesSeen }, (_, n) => ({ name: `Example Residences ${i}-${n}`, answers: n + 1 })),
  }
}

/** The `__truncation` line a plain slice carries just before its closing note. */
function sliceSummary(out: string): { cutAt: string; droppedKeys: string[]; keptItems: Record<string, string>; moreDroppedKeys?: number } {
  const lines = out.split('\n')
  expect(lines.at(-1)).toBe('... (truncated, result too large)')
  const line = lines.at(-2)!
  expect(line.startsWith('__truncation: ')).toBe(true)
  return JSON.parse(line.slice('__truncation: '.length))
}

describe('truncateToolResult never truncates silently', () => {
  it('shrinks long lists evenly in one pass, keeps a short rollup whole, and returns structured JSON', () => {
    // 40 rows, each with its own nested list, next to other collections: the
    // old one-array-per-pass walk ran out of passes here and blind-sliced.
    const rows = Array.from({ length: 40 }, (_, i) => propertyRow(i))
    const markets = Array.from({ length: 150 }, (_, i) => ({ groupKey: `market-${i}`, label: `Market ${i}`, propertyCount: 3, mentionCoverage: { value: 0, numerator: 0, denominator: 24 } }))
    const details = {
      queryClass: 'non-brand',
      metrics: { mentionCoverage: { numerator: 0, denominator: 960 } },
      rows,
      ranking: { strongest: rows.slice(0, 10).map(({ namedInstead: _n, ...row }) => row), eligible: 40 },
      markets,
      totalProperties: 40,
    }
    const original = JSON.stringify(details)
    const out = truncateToolResult(details)
    const parsed = JSON.parse(out)

    expect(out.length).toBeLessThanOrEqual(CAP)
    expect(parsed.__truncated).toBe(true)
    expect(parsed.metrics).toEqual(details.metrics)
    expect(parsed.totalProperties).toBe(40)
    // The 10-row ranking is a rollup: it keeps every row while longer lists can still shrink.
    expect(parsed.ranking).toEqual(details.ranking)
    // Both long lists shrink to one even level (the leading one may keep a row more), never below rollup size.
    expect(parsed.rows.length).toBeGreaterThanOrEqual(25)
    expect(parsed.markets.length).toBeGreaterThanOrEqual(25)
    expect(Math.abs(parsed.rows.length - parsed.markets.length)).toBeLessThanOrEqual(1)
    expect(parsed.__truncation.keptItems.rows).toBe(`${parsed.rows.length} of 40`)
    expect(parsed.__truncation.keptItems.markets).toBe(`${parsed.markets.length} of 150`)
    expect(parsed.markets).toEqual(markets.slice(0, parsed.markets.length))
    // Retained rows keep every other field and carry their own omission count.
    for (const [index, row] of parsed.rows.entries()) {
      const { namedInstead, ...rest } = rows[index]!
      expect(row).toMatchObject(rest)
      expect(row.namedInstead.length + (row.__omittedRowsByField?.namedInstead ?? 0)).toBe(namedInstead.length)
    }
    // Every collection the summary names as cut is accounted for.
    for (const [path, kept] of Object.entries(parsed.__truncation.keptItems as Record<string, string>)) {
      expect(kept).toMatch(/^\d+ of \d+$/)
      if (kept.startsWith('0 of ')) expect(parsed.__truncation.droppedKeys).toContain(path)
    }
    expect(JSON.stringify(details)).toBe(original)
  })

  it('spends leftover room on sibling lists and leaves untouched rows unmarked', () => {
    // Odd rows have long lists, even rows a single entry. Per-row detail is
    // trimmed before a rollup-sized list loses rows, so the group settles on
    // a per-row count, then gives the leading rows one more entry while room
    // remains.
    const rows = Array.from({ length: 20 }, (_, i) => ({
      targetKey: `property-${i}`,
      label: `Harbor Homes ${i}`,
      namedInstead: Array.from({ length: i % 2 === 0 ? 1 : 12 }, (_, n) => ({ name: `Example Residences ${i}-${n}`, note: 'z'.repeat(120) })),
    }))
    const out = truncateToolResult({ summary: { rows: rows.length }, result: { rows } })
    const parsed = JSON.parse(out)

    expect(out.length).toBeLessThanOrEqual(CAP)
    expect(parsed.result.rows).toHaveLength(20)
    expect(parsed.result.__omittedRowsByField).toBeUndefined()
    const keptPerLongRow = parsed.result.rows.filter((_: unknown, i: number) => i % 2 === 1).map((row: { namedInstead: unknown[] }) => row.namedInstead.length)
    expect(Math.min(...keptPerLongRow)).toBeGreaterThan(0)
    expect(Math.max(...keptPerLongRow) - Math.min(...keptPerLongRow)).toBeLessThanOrEqual(1)
    // Non-increasing: the extra entry goes to the leading rows.
    expect(keptPerLongRow).toEqual([...keptPerLongRow].sort((a, b) => b - a))
    let kept = 0
    for (const [i, row] of parsed.result.rows.entries()) {
      kept += row.namedInstead.length
      expect(row.namedInstead).toEqual(rows[i]!.namedInstead.slice(0, row.namedInstead.length))
      if (i % 2 === 0) {
        expect(row.namedInstead).toHaveLength(1)
        expect(row.__truncated).toBeUndefined()
        expect(row.__omittedRowsByField).toBeUndefined()
      } else {
        expect(row.__truncated).toBe(true)
        expect(row.namedInstead.length + row.__omittedRowsByField.namedInstead).toBe(12)
      }
    }
    expect(parsed.__truncation).toEqual({
      droppedKeys: [],
      keptItems: { 'result.rows[].namedInstead': `${kept} of ${10 * 12 + 10}` },
    })
  })

  it('names the trimmed collection on the largest-array and top-level-array paths', () => {
    const actions = Array.from({ length: 600 }, (_, i) => evidenceRow(i))
    const object = JSON.parse(truncateToolResult({ summary: { total: 600 }, actions }))
    expect(object.__truncation).toEqual({ droppedKeys: [], keptItems: { actions: `${object.actions.length} of 600` } })

    const wrapped = JSON.parse(truncateToolResult(actions))
    expect(wrapped.__truncation).toEqual({ droppedKeys: [], keptItems: { items: `${wrapped.items.length} of 600` } })
  })

  it('ends a plain slice with a line naming the cut and unseen top-level keys and their counts', () => {
    // Past the structured ceiling, so the slice is taken. Row text carries
    // quotes, braces, brackets and backslashes the cut scanner must skip.
    const tricky = 'says "{not a brace}" [or a bracket] \\ and, commas '
    const rows = Array.from({ length: 6_000 }, (_, i) => ({ id: `row-${i}`, answerText: tricky.repeat(8) }))
    const details = {
      summary: { answers: 6_000, class: 'non-brand' },
      rows,
      markets: Array.from({ length: 150 }, (_, i) => ({ groupKey: `market-${i}` })),
      sources: { total: 12 },
      total: 6_000,
    }
    expect(JSON.stringify(details, null, 2).length).toBeGreaterThan(2_000_000)

    const out = truncateToolResult(details)
    expect(out.length).toBeLessThanOrEqual(CAP + 50)
    const summary = sliceSummary(out)

    expect(summary.droppedKeys).toEqual(['markets', 'sources', 'total'])
    expect(summary.keptItems.markets).toBe('0 of 150')
    const shownRows = Number(summary.keptItems.rows!.split(' of ')[0])
    expect(summary.keptItems.rows).toBe(`${shownRows} of 6000`)
    // Either inside the next row, or between rows when the cut lands on one.
    expect(summary.cutAt === 'rows' || summary.cutAt.startsWith(`rows[${shownRows}]`)).toBe(true)
    // The count is exact: the last counted row is complete in the text, the
    // next one is not.
    expect(out).toContain(JSON.stringify(rows[shownRows - 1]))
    expect(out).not.toContain(JSON.stringify(rows[shownRows]))
    // Fully shown keys are not listed.
    expect(summary.keptItems.summary).toBeUndefined()
    expect(summary.droppedKeys).not.toContain('summary')
  })

  it('names the cut map when a keyed collection cannot fit even emptied', () => {
    // Hundreds of distinct keys each holding a list: emptying every list
    // still exceeds the cap, so the walk is skipped for the slice.
    const byQuery: Record<string, unknown> = {}
    for (let q = 0; q < 900; q++) byQuery[`best apartments near example ${q}`] = [{ domain: 'example.com', count: q }]
    const extra = Array.from({ length: 50 }, (_, i) => [`key${i}`, i] as const)
    const details = { overall: [{ domain: 'example.com', count: 900 }], byQuery, ...Object.fromEntries(extra) }

    const started = Date.now()
    const out = truncateToolResult(details)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(out.length).toBeLessThanOrEqual(CAP + 50)
    const summary = sliceSummary(out)

    const shownKeys = Number(summary.keptItems.byQuery!.split(' of ')[0])
    expect(summary.keptItems.byQuery).toBe(`${shownKeys} of 900 keys`)
    expect(summary.cutAt.startsWith('byQuery')).toBe(true)
    // Unseen top-level keys are listed up to a bound, with the rest counted.
    expect(summary.droppedKeys).toHaveLength(30)
    expect(summary.droppedKeys[0]).toBe('key0')
    expect(summary.moreDroppedKeys).toBe(20)
  })

  it('adds no key line when the result has no keys to name', () => {
    const out = truncateToolResult('y'.repeat(CAP + 5_000))
    expect(out).not.toContain('__truncation')
    expect(out.endsWith('\n... (truncated, result too large)')).toBe(true)
  })
})

/** A coverage value as the measurement reads return it. */
function coverage(numerator: number, denominator: number) {
  return { state: 'available', value: numerator / denominator, numerator, denominator }
}

/** A portfolio-summary-shaped result: weakest rows with per-row evidence, two rankings, markets. */
function portfolioSummary(limit: number) {
  const ranked = (kind: string) => Array.from({ length: limit }, (_, i) => ({
    targetKey: `${kind}-${i}`, label: `Harbor Homes ${kind} ${i}`, metro: { groupKey: 'metro-1', label: 'Bayside Metro' },
    submarkets: [], queries: 8, mentionCoverage: coverage(12, 24), citationCoverage: coverage(2, 24),
  }))
  return {
    portfolio: { groupKey: null, label: null, measurementScope: 'full' },
    queryClass: 'non-brand',
    engines: ['openai', 'gemini'],
    metrics: { mentionCoverage: coverage(200, 1000) },
    weakestProperties: Array.from({ length: limit }, (_, i) => ({
      ...propertyRow(i),
      metro: { groupKey: `metro-${i % 3}`, label: `Bayside Metro ${i % 3}` },
      submarkets: ['Harbor North'], queries: 8, flags: 0,
      namedInsteadInAnswerText: Array.from({ length: 5 }, (_, n) => ({ name: `Example Residences at Harbor ${i}-${n}`, answers: 3 })),
      citedDomains: Array.from({ length: 5 }, (_, n) => ({ domain: `listing-site-${n}.example.com`, answers: 4 })),
      recommendedInstead: Array.from({ length: 5 }, (_, n) => ({ name: `Example Residences at Harbor ${i}-${n}`, occurrences: 3 })),
    })),
    tiedAtWeakest: { count: 60, note: 'tied Properties are ordered by name, not ranked' },
    mentionRanking: { eligiblePropertyCount: 140, strongest: ranked('strong'), weakest: ranked('weak'), excluded: [], truncated: true },
    markets: Array.from({ length: limit }, (_, i) => ({
      groupKey: `market-${i}`, label: `Market ${i}`, childMarketCount: 2, propertyCount: 14,
      propertiesMentioned: coverage(7, 14), mentionCoverage: coverage(80, 320), citationCoverage: coverage(16, 320),
    })),
    totalMarkets: 12,
    marketsTruncated: true,
    totalProperties: 120,
    truncated: true,
  }
}

describe('truncateToolResult keeps rollups and says what is partial', () => {
  it('trims per-row evidence before any rollup, ranking or requested row loses a row', () => {
    const details = portfolioSummary(10)
    expect(JSON.stringify(details).length).toBeGreaterThan(CAP)
    const out = truncateToolResult(details)
    const parsed = JSON.parse(out)

    expect(out.length).toBeLessThanOrEqual(CAP)
    expect(parsed.weakestProperties).toHaveLength(10)
    expect(parsed.markets).toEqual(details.markets)
    expect(parsed.mentionRanking.strongest).toEqual(details.mentionRanking.strongest)
    expect(parsed.mentionRanking.weakest).toEqual(details.mentionRanking.weakest)
    expect(parsed.tiedAtWeakest).toEqual(details.tiedAtWeakest)
    // Every evidence list shrank to the same count (one more for leading rows), never to nothing.
    for (const key of ['namedInstead', 'namedInsteadInAnswerText', 'citedDomains', 'recommendedInstead'] as const) {
      const kept = parsed.weakestProperties.map((row: Record<string, unknown[]>) => row[key]!.length)
      expect(Math.min(...kept)).toBeGreaterThan(0)
      expect(Math.max(...kept) - Math.min(...kept)).toBeLessThanOrEqual(1)
      const total = kept.reduce((sum: number, n: number) => sum + n, 0)
      if (total < 50) expect(parsed.__truncation.keptItems[`weakestProperties[].${key}`]).toBe(`${total} of 50`)
    }
    expect(Object.keys(parsed.__truncation.keptItems).every(path => path.startsWith('weakestProperties[].'))).toBe(true)
  })

  it('never cuts a short list below a longer one', () => {
    const heavy = (i: number) => ({ id: `row-${i}`, answerText: 'y'.repeat(1_400) })
    const markets = Array.from({ length: 10 }, (_, i) => ({ groupKey: `market-${i}`, note: 'm'.repeat(360) }))
    const whole = JSON.parse(truncateToolResult({ rows: Array.from({ length: 30 }, (_, i) => heavy(i)), markets }))
    // The long list drops to the short one's length before the short one loses anything.
    expect(whole.markets).toEqual(markets)
    expect(whole.rows.length).toBeGreaterThanOrEqual(markets.length)

    const wider = Array.from({ length: 20 }, (_, i) => ({ groupKey: `market-${i}`, note: 'm'.repeat(960) }))
    const both = JSON.parse(truncateToolResult({ rows: Array.from({ length: 30 }, (_, i) => heavy(i)), markets: wider }))
    // When both must shrink, they meet at one level and neither is emptied.
    expect(both.markets.length).toBeGreaterThan(0)
    expect(both.rows.length).toBeGreaterThan(0)
    expect(Math.abs(both.rows.length - both.markets.length)).toBeLessThanOrEqual(1)
  })

  it('keeps some nested sources on every answer it keeps', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      answerId: `a-${i}`, query: `best apartments in bayside ${i}`, provider: 'openai', answerText: 'z'.repeat(400),
      sources: Array.from({ length: 8 }, (_, n) => ({ url: `https://listing-${n}.example.com/bayside/${i}`, domain: `listing-${n}.example.com` })),
    }))
    const parsed = JSON.parse(truncateToolResult({ property: { targetKey: 'p-1', label: 'Harbor Homes' }, answers: { items, nextCursor: 'answers-2' } }))
    expect(parsed.answers.items.length).toBeGreaterThan(0)
    for (const [index, answer] of parsed.answers.items.entries()) {
      expect(answer.sources.length).toBeGreaterThan(0)
      expect(answer.sources).toEqual(items[index]!.sources.slice(0, answer.sources.length))
    }
  })

  it('says a page cursor skips the rows cut from its page, and leaves the cursor as the tool sent it', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ targetKey: `p-${i}`, label: `Harbor Homes ${i}`, note: 'n'.repeat(400) }))
    const parsed = JSON.parse(truncateToolResult({ scope: { kind: 'all' }, properties: { items, nextCursor: 'cursor-100', totalEstimate: 120 } }))
    const kept = parsed.properties.items.length
    expect(kept).toBeGreaterThan(0)
    expect(kept).toBeLessThan(100)
    expect(parsed.properties.nextCursor).toBe('cursor-100')
    expect(parsed.__truncation.cursors).toEqual({
      'properties.nextCursor': `skips the ${100 - kept} rows cut from properties.items; to read them, call again with limit <= ${kept}`,
    })
    expect(parsed.__partialLists).toEqual({ 'properties.items': `${kept} of about 120` })

    // The largest-array path says the same for a cursor beside the list.
    const changes = Array.from({ length: 300 }, (_, i) => evidenceRow(i))
    const flat = JSON.parse(truncateToolResult({ changes, total: 300, nextCursor: 'c-300' }))
    expect(flat.__truncation.cursors).toEqual({
      nextCursor: `skips the ${300 - flat.changes.length} rows cut from changes; to read them, call again with limit <= ${flat.changes.length}`,
    })
  })

  it('names lists the tool itself cut first, even when the cap cut nothing', () => {
    const details = {
      weakestProperties: [propertyRow(0), propertyRow(1)],
      markets: [{ groupKey: 'market-1' }],
      totalMarkets: 1,
      marketsTruncated: false,
      mentionRanking: { strongest: [{ targetKey: 'p-1' }], weakest: [{ targetKey: 'p-2' }], excluded: [], truncated: true },
      // Per-row flags stay on their rows; only the root flag names this list.
      competitors: [{ name: 'Example Residences', questions: ['q1'], questionTotal: 5, questionsTruncated: true }],
      questionsRead: { questions: [{ queryId: 'q1' }], total: 60, truncated: true },
      totalProperties: 120,
      truncated: true,
    }
    const out = truncateToolResult(details)
    expect(out).toBe(JSON.stringify({
      __partialLists: {
        weakestProperties: '2 of 120',
        competitors: '1 shown; the tool cut this list',
        // The flag names each list with rows; the empty `excluded` is not a page the tool cut.
        'mentionRanking.strongest': '1 shown; the tool cut this list',
        'mentionRanking.weakest': '1 shown; the tool cut this list',
        'questionsRead.questions': '1 of 60',
      },
      ...details,
    }))
    // Complete lists get no note.
    expect(truncateToolResult({ markets: [{ groupKey: 'market-1' }], totalMarkets: 1, truncated: false })).toBe('{"markets":[{"groupKey":"market-1"}],"totalMarkets":1,"truncated":false}')
  })

  it('pairs a bare total and flag with the one list that has no count of its own', () => {
    const competitors = Array.from({ length: 10 }, (_, i) => ({ name: `Example Residences ${i}`, occurrences: 12 - i, questions: ['q1'], questionTotal: 1 }))
    const citedDomains = Array.from({ length: 10 }, (_, i) => ({ domain: `listing-${i}.example.com`, answers: 9 - (i % 3) }))
    const property = {
      property: { targetKey: 'p-1', label: 'Harbor Homes' },
      queryClass: 'nonbrand',
      basis: { state: 'available', answeredResults: 40, targetMissResults: 22, recommendationOccurrences: 64 },
      competitors,
      total: 30,
      truncated: true,
      citedDomains,
      citedDomainsTotal: 14,
      citedDomainsAnswers: 31,
    }
    expect(truncateToolResult(property)).toBe(JSON.stringify({
      __partialLists: { competitors: '10 of 30', citedDomains: '10 of 14' },
      ...property,
    }))
    // A complete sibling list stays unnamed.
    expect(JSON.parse(truncateToolResult({ ...property, citedDomainsTotal: 10 })).__partialLists).toEqual({ competitors: '10 of 30' })
    // With no bare total, the flag still names the list no count explains, whatever its sibling shows.
    const { total: _total, ...flagOnly } = property
    expect(JSON.parse(truncateToolResult(flagOnly)).__partialLists).toEqual({
      competitors: '10 shown; the tool cut this list',
      citedDomains: '10 of 14',
    })
    expect(JSON.parse(truncateToolResult({ ...flagOnly, citedDomainsTotal: 10 })).__partialLists).toEqual({
      competitors: '10 shown; the tool cut this list',
    })

    // Two lists with no count of their own: the bare total pairs with neither, and the flag names both.
    expect(JSON.parse(truncateToolResult({ items: [{ id: 1 }, { id: 2 }, { id: 3 }], related: [{ id: 4 }, { id: 5 }], total: 40, truncated: true })).__partialLists).toEqual({
      items: '3 shown; the tool cut this list',
      related: '2 shown; the tool cut this list',
    })
    // A list's own `<key>Truncated: false` keeps the bare flag off it.
    expect(JSON.parse(truncateToolResult({ rows: [{ id: 1 }], rowsTruncated: false, extras: [{ id: 2 }], truncated: true })).__partialLists).toEqual({
      extras: '1 shown; the tool cut this list',
    })
    // A list of scalars beside other lists is an identity, not a page: the flag leaves it alone.
    expect(JSON.parse(truncateToolResult({ engines: ['openai', 'gemini'], weakestProperties: [propertyRow(0)], totalProperties: 40, truncated: true })).__partialLists).toEqual({
      weakestProperties: '1 of 40',
    })
  })

  it('counts rows the cap cut in the partial-list note', () => {
    const changedProperties = Array.from({ length: 50 }, (_, i) => ({ ...propertyRow(i, 0), note: 'c'.repeat(400) }))
    const parsed = JSON.parse(truncateToolResult({ current: { runId: 'run-2' }, comparison: { state: 'available', changedProperties, totalProperties: 90, truncated: true } }))
    const kept = parsed.comparison.changedProperties.length
    expect(kept).toBeLessThan(50)
    expect(Object.keys(parsed)[0]).toBe('__partialLists')
    expect(parsed.__partialLists).toEqual({ 'comparison.changedProperties': `${kept} of 90` })
    expect(parsed.__truncation.keptItems).toEqual({ 'comparison.changedProperties': `${kept} of 50` })
  })
})
