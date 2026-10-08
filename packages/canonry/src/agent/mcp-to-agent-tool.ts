import { Type, type TSchema } from '@earendil-works/pi-ai'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { createHash, randomUUID } from 'node:crypto'
import { MeasurementPortfolioLists, RunKinds, truncateUtf16 } from '@ainyc/canonry-contracts'
import { runWithUsageTags, type ApiClient } from '../client.js'
import {
  CanonryMcpToolNames,
  type CanonryMcpRegistryTool,
  type CanonryMcpTool,
  type CanonryMcpToolName,
} from '../mcp/tool-registry.js'
import { renderRatioUnits, responseComponents, responseSchemasFor } from './tool-result-units.js'

const MAX_TOOL_RESULT_CHARS = 20_000
/**
 * Every truncation says what it cut, under this key. Structured output
 * carries it as a field next to `__truncated`, including bounded fallback
 * projections. Collection
 * paths use `[]` for "every row" (`rows[].tags`) and `[3]` for one row.
 */
const TRUNCATION_SUMMARY_KEY = '__truncation'
/**
 * Lists the TOOL returned only part of, whether or not the cap cut anything:
 * `"4 of 120"` from the tool's own total, or a note when it only says
 * `truncated: true`. The first field of the result, so the model reads it
 * before the rows.
 */
const PARTIAL_LISTS_KEY = '__partialLists'
/** Page cursors that still resume after the last row the tool returned. */
const CURSOR_KEYS = ['nextCursor', 'nextOffset', 'nextPageToken', 'next_cursor']
/** Public compact portfolio selectors identify the sole list owned by the root cursor. */
const PORTFOLIO_PAGE_LISTS = new Map<string, { path: string; totalKey: string }>([
  [MeasurementPortfolioLists['weakest-properties'], { path: 'weakestProperties', totalKey: 'totalProperties' }],
  [MeasurementPortfolioLists['strongest-mentions'], { path: 'mentionRanking.strongest', totalKey: 'eligiblePropertyCount' }],
  [MeasurementPortfolioLists['weakest-mentions'], { path: 'mentionRanking.weakest', totalKey: 'eligiblePropertyCount' }],
  [MeasurementPortfolioLists['excluded-mentions'], { path: 'mentionRanking.excluded', totalKey: 'excludedTotal' }],
  [MeasurementPortfolioLists.markets, { path: 'markets', totalKey: 'totalMarkets' }],
  [MeasurementPortfolioLists['observed-names'], { path: 'answerEvidence.observedNames', totalKey: 'observedNamesTotal' }],
  [MeasurementPortfolioLists['cited-domains'], { path: 'answerEvidence.citedDomains', totalKey: 'citedDomainsTotal' }],
])
/**
 * Ceiling on the input the structured paths will attempt. Each of them
 * re-serializes the enclosing document per step. Above this size a bounded
 * projection keeps complete rows without searching the whole document.
 */
const MAX_STRUCTURED_TRUNCATION_CHARS = 2_000_000
/**
 * Bound on the characters the nested path serializes while it searches. Byte
 * size alone does not bound this work: every probe re-serializes the trimmed
 * copy. A real result settles in a few dozen probes; a pathological one
 * spends this and takes the bounded JSON projection.
 */
const TRUNCATION_SERIALIZE_BUDGET_CHARS = 64_000_000
/** Lists this long or shorter read as rollups (markets, rankings) and keep their rows longest. */
const SMALL_LIST_ROWS = 25
/** Bounds on fallback omission metadata, so it cannot crowd out the result. */
const MAX_SUMMARY_KEYS = 30
const MAX_SUMMARY_PATH_CHARS = 96
const PROJECTION_SUMMARY_CHARS = 5_000
const PROJECTION_METADATA_CHARS = PROJECTION_SUMMARY_CHARS - 500
/** Bounds on the partial-list note: how deep it looks and how many lists it names. */
const MAX_PARTIAL_DEPTH = 4
const MAX_PARTIAL_NOTES = 12

/**
 * Compact JSON, exactly what the model reads in the tool-result text.
 * Indenting cost about 40% more characters for the same rows, all of it
 * taken from the cap.
 */
function serializeResult(value: unknown): string {
  return JSON.stringify(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

interface TruncationSummary {
  /** Collections or projected keys the model sees none of. */
  droppedKeys: string[]
  /** `"<kept> of <total>"` for every collection that lost rows. */
  keptItems: Record<string, string>
  /** Cursors that resume past rows this cut dropped, and how to read those rows. */
  cursors?: Record<string, string>
  /** String prefixes are partial text, never complete quotations or evidence rows. */
  slicedKeys?: Record<string, { keptChars: number; totalChars: number }>
}

type KeptCounts = ReadonlyMap<string, { kept: number; total: number }>

function keptSummary(counts: KeptCounts, cursors: Record<string, string> = {}): TruncationSummary {
  const summary: TruncationSummary = { droppedKeys: [], keptItems: {} }
  for (const [path, { kept, total }] of counts) {
    if (kept >= total) continue
    if (kept === 0) summary.droppedKeys.push(path)
    summary.keptItems[path] = `${kept} of ${total}`
  }
  if (Object.keys(cursors).length > 0) summary.cursors = cursors
  return summary
}

/**
 * A page cut short still carries the tool's cursor, which resumes after the
 * LAST row the tool returned, so following it skips every row cut here.
 * Cursors are opaque, so say so instead of rewriting one.
 */
function noteCursor(owner: Record<string, unknown>, ownerPath: string, listPath: string, kept: number, total: number, notes: Record<string, string>, root = owner): void {
  const cursor = cursorForList(owner, ownerPath, listPath.slice(listPath.lastIndexOf('.') + 1), root)
  if (!cursor || kept >= total) return
  notes[cursor.path] =
    `incomplete page: skips the ${total - kept} rows cut from ${listPath}; re-request the original cursor with ${kept > 0 ? `${cursor.limit} <= ${kept}` : `a lower ${cursor.limit}`}`
}

interface ListCount {
  count: number
  text: string
}

/** Public portfolio and sentiment pages can place cursors outside their selected row owner. */
function cursorForList(owner: Record<string, unknown>, ownerPath: string, listKey: string, root = owner): {
  path: string; value: unknown; parameter: string; limit: string; total?: ListCount
} | undefined {
  const prefix = ownerPath ? `${ownerPath}.` : ''
  if (listKey === 'queries' && isRecord(owner.queryPage) && owner.queryPage.nextCursor !== undefined && owner.queryPage.nextCursor !== null) {
    const page = owner.queryPage
    return {
      path: `${prefix}queryPage.nextCursor`, value: page.nextCursor, parameter: 'queryCursor', limit: 'queryLimit',
      ...(typeof page.total === 'number' ? { total: { count: page.total, text: String(page.total) } } : {}),
    }
  }
  if (listKey === 'attempts' && owner.nextAttemptCursor !== undefined && owner.nextAttemptCursor !== null) {
    return {
      path: `${prefix}nextAttemptCursor`, value: owner.nextAttemptCursor, parameter: 'attemptCursor', limit: 'attemptLimit',
      ...(typeof owner.attemptCount === 'number' ? { total: { count: owner.attemptCount, text: String(owner.attemptCount) } } : {}),
    }
  }
  const selected = typeof root.pageList === 'string' ? PORTFOLIO_PAGE_LISTS.get(root.pageList) : undefined
  const selectedList = selected?.path === `${prefix}${listKey}`
  // Sibling summaries do not own the root continuation, even when they are partial.
  if (selected && owner === root && !selectedList) return undefined
  const cursorOwner = selectedList ? root : owner
  const cursorPrefix = selectedList ? '' : prefix
  const key = CURSOR_KEYS.find(candidate => cursorOwner[candidate] !== undefined && cursorOwner[candidate] !== null)
  if (!key) return undefined
  const total = selectedList ? owner[selected.totalKey] : undefined
  return {
    path: `${cursorPrefix}${key}`, value: cursorOwner[key], parameter: 'cursor', limit: 'limit',
    ...(typeof total === 'number' ? { total: { count: total, text: String(total) } } : {}),
  }
}

/**
 * The tool's own count for the list at `key`, from a sibling that names it:
 * `totalMarkets`, `providerTotal` or `citedDomainsTotal`.
 */
function ownListTotal(numbers: ReadonlyArray<[string, number]>, key: string): ListCount | undefined {
  const lower = key.toLowerCase()
  for (const [field, value] of numbers) {
    if (field === 'total' || field === 'totalEstimate') continue
    if (field === `${key}Total` || field === `${key.replace(/s$/, '')}Total`
      || (/^total[A-Z]/.test(field) && lower.endsWith(field.slice(5).toLowerCase()))) return { count: value, text: String(value) }
  }
  return undefined
}

/** The owner's bare `total` (or `totalEstimate`), which names no list. */
function bareTotal(numbers: ReadonlyArray<[string, number]>): ListCount | undefined {
  const total = numbers.find(([field]) => field === 'total')
  if (total) return { count: total[1], text: String(total[1]) }
  const estimate = numbers.find(([field]) => field === 'totalEstimate')
  return estimate ? { count: estimate[1], text: `about ${estimate[1]}` } : undefined
}

/**
 * Lists the tool itself cut: a total above the rows shown, or a
 * `truncated: true` flag. Reads objects outside list rows only, so per-row
 * flags (a competitor's `questionsTruncated`) stay where they are. A map of
 * many keyed lists is not paired with totals.
 *
 * A bare `total` counts the one list with no total of its own at the
 * result's root, where offset-paged reads return their page
 * (`{snapshots, total}`, `{project, runId, total, pages}`). Below the root
 * it does so only when a cursor, explicit truncation flag, or conventional
 * page-row key identifies it as a collection (`competitors` beside
 * `citedDomains` + `citedDomainsTotal` + `truncated`). Nested aggregate
 * bucket counts need their own list total; their owner's population total
 * (`inventorySummary.total`) does not count bucket rows.
 * A bare `truncated: true`
 * names every list here that no count or `<key>Truncated` explains and that
 * holds rows, since the flag does not say which list it cut. Beside other
 * lists, a list of scalars is an identity (a portfolio's `engines`), not a
 * page, so the bare flag leaves it alone.
 */
function partialLists(root: Record<string, unknown>): Record<string, string> | undefined {
  const notes: Array<[string, string]> = []
  const visit = (object: Record<string, unknown>, path: string, depth: number): void => {
    const lists: Array<[string, unknown[]]> = []
    const numbers: Array<[string, number]> = []
    for (const [key, value] of Object.entries(object)) {
      if (key.startsWith('__')) continue
      if (Array.isArray(value)) lists.push([key, value])
      else if (typeof value === 'number') numbers.push([key, value])
    }
    let noted = false
    if (lists.length <= MAX_SUMMARY_KEYS) {
      const counts = lists.map(([key]) => ownListTotal(numbers, key) ?? cursorForList(object, path, key, root)?.total)
      const uncounted = counts.flatMap((count, index) => count ? [] : [index])
      if (uncounted.length === 1) {
        const index = uncounted[0]!
        const key = lists[index]![0]
        const paged = object === root || cursorForList(object, path, key, root)
          || typeof object.truncated === 'boolean' || typeof object[`${key}Truncated`] === 'boolean'
          || ['items', 'rows', 'results'].includes(key)
        if (paged) counts[index] = bareTotal(numbers)
      }
      for (const [index, [key, rows]] of lists.entries()) {
        const label = path ? `${path}.${key}` : key
        const count = counts[index]
        // A list's count decides, then its own `<key>Truncated`; the bare flag speaks for the rest.
        const ownFlag = object[`${key}Truncated`]
        if (count) {
          if (count.count <= rows.length) continue
          notes.push([label, `${rows.length} of ${count.text}`])
          noted = true
        } else if (ownFlag === true || (object.truncated === true && typeof ownFlag !== 'boolean'
          && (lists.length === 1 || rows.some(isRecord)))) {
          notes.push([label, `${rows.length} shown; the tool cut this list`])
          noted = true
        }
      }
    }
    if (object.truncated === true && !noted) notes.push([path || '(root)', 'the tool cut the lists here'])
    if (depth >= MAX_PARTIAL_DEPTH || notes.length >= MAX_PARTIAL_NOTES) return
    for (const [key, value] of Object.entries(object)) {
      if (!key.startsWith('__') && isRecord(value)) visit(value, path ? `${path}.${key}` : key, depth + 1)
    }
  }
  visit(root, '', 1)
  return notes.length > 0 ? Object.fromEntries(notes.slice(0, MAX_PARTIAL_NOTES)) : undefined
}

/** `value` with its partial-list note as the first field, or `value` itself when it has none. */
function withPartialLists(value: unknown): unknown {
  if (!isRecord(value) || typeof value.toJSON === 'function') return value
  const hadNote = Object.hasOwn(value, PARTIAL_LISTS_KEY)
  const notes = partialLists(value)
  if (!notes && !hadNote && value.nextAttemptCursor == null && !CURSOR_KEYS.some(key => value[key] !== undefined && value[key] !== null) && !Object.values(value).some(child => isRecord(child) && CURSOR_KEYS.some(key => child[key] !== undefined && child[key] !== null))) return value
  const pagination: Record<string, string> = {}
  const visit = (owner: Record<string, unknown>, path: string, depth: number): void => {
    const lists = Object.entries(owner).filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
    const numbers = Object.entries(owner).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    for (const [key, rows] of lists) {
      const cursor = cursorForList(owner, path, key, value)
      if (!cursor || key.startsWith('__') || Object.keys(pagination).length >= MAX_PARTIAL_NOTES) continue
      const label = path ? `${path}.${key}` : key
      const total = cursor.total ?? ownListTotal(numbers, key) ?? (lists.length === 1 ? bareTotal(numbers) : undefined)
      const incomplete = owner.__truncated === true || isRecord(owner.__omittedRowsByField) && typeof owner.__omittedRowsByField[key] === 'number'
      pagination[label] = `showing ${rows.length}${total ? ` of ${total.text}` : ' rows'}; ${incomplete ? `incomplete page: re-request the original cursor with a smaller ${cursor.limit}; the next cursor skips omitted rows` : `pass ${cursor.parameter} ${JSON.stringify(cursor.value)}`}`
    }
    if (depth >= MAX_PARTIAL_DEPTH) return
    for (const [key, child] of Object.entries(owner)) if (!key.startsWith('__') && isRecord(child)) visit(child, path ? `${path}.${key}` : key, depth + 1)
  }
  visit(value, '', 1)
  const { [PARTIAL_LISTS_KEY]: _previous, __pagination: _pagination, ...rest } = value
  return { ...(notes ? { [PARTIAL_LISTS_KEY]: notes } : {}), ...(Object.keys(pagination).length > 0 ? { __pagination: pagination } : {}), ...rest }
}

/** The object key whose array value serializes largest (the one worth trimming). */
function largestArrayKey(obj: Record<string, unknown>): string | undefined {
  let best: string | undefined
  let bestLen = -1
  for (const [k, v] of Object.entries(obj)) {
    if (!Array.isArray(v)) continue
    const len = serializeResult(v).length
    if (len > bestLen) {
      bestLen = len
      best = k
    }
  }
  return best
}

function fitsCap(text: string): boolean {
  return text.length <= MAX_TOOL_RESULT_CHARS
}

/** Largest `n` in `[0, max]` for which `fits(n)` holds, given that `fits(0)` does. */
function largestFitting(max: number, fits: (n: number) => boolean): number {
  // Binary search, not a one-row-at-a-time walk: each probe is a full
  // serialization of the enclosing document, so dropping a single row per
  // iteration was quadratic and cost 5.2s on a 2.6 MB run-shaped result.
  // Serialized length grows with row count, so the search lands on the same
  // prefix the linear walk did.
  let low = 0
  let high = max
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(middle)) low = middle
    else high = middle - 1
  }
  return low
}

/** Drop WHOLE trailing rows until `render(kept)` fits the cap (or nothing is left). */
function trimRowsToFit(rows: readonly unknown[], render: (kept: unknown[]) => string): unknown[] {
  if (rows.length === 0) return []
  const all = rows.slice()
  if (fitsCap(render(all))) return all
  return rows.slice(0, largestFitting(rows.length - 1, (count) => fitsCap(render(rows.slice(0, count)))))
}

/** One list in the copy being trimmed. Lists that share a path (`rows[].tags`) share a stage level. */
interface Collection {
  path: string
  /** Inside a row of another list: per-row detail such as `rows[].namedInstead`. */
  nested: boolean
  /** Holds objects (rows), not scalars (identity lists such as served model IDs). */
  records: boolean
  owner: Record<string, unknown>
  key: string
  rows: unknown[]
}

/**
 * Sets every list's row count, and keeps each owner's omission markers in
 * step: `__truncated` plus per-field counts in `__omittedRowsByField`. An
 * owner whose lists all keep every row stays as it was, so untouched rows
 * gain no marker. Counts the payload already carried are added to, not lost.
 */
function listTrimmer(lists: readonly Collection[]): (counts: readonly number[]) => void {
  const owners = new Map<Record<string, unknown>, number[]>()
  lists.forEach((list, index) => {
    const indexes = owners.get(list.owner)
    if (indexes) indexes.push(index)
    else owners.set(list.owner, [index])
  })
  const markers = [...owners].map(([owner, indexes]) => {
    const previous = owner.__omittedRowsByField
    return {
      owner,
      indexes,
      hadTruncated: Object.hasOwn(owner, '__truncated'),
      priorTruncated: owner.__truncated,
      previous,
      priorOmitted: isRecord(previous) ? previous : undefined,
    }
  })
  return (counts) => {
    lists.forEach((list, index) => { list.owner[list.key] = list.rows.slice(0, counts[index]) })
    for (const { owner, indexes, hadTruncated, priorTruncated, previous, priorOmitted } of markers) {
      const omitted: Record<string, number> = {}
      for (const index of indexes) {
        const { key, rows } = lists[index]!
        const prior = typeof priorOmitted?.[key] === 'number' ? priorOmitted[key] as number : 0
        const count = prior + rows.length - Math.min(counts[index]!, rows.length)
        if (count > 0) omitted[key] = count
      }
      if (Object.keys(omitted).length > 0) {
        owner.__truncated = true
        owner.__omittedRowsByField = { ...priorOmitted, ...omitted }
        continue
      }
      if (hadTruncated) owner.__truncated = priorTruncated
      else delete owner.__truncated
      if (previous === undefined) delete owner.__omittedRowsByField
      else owner.__omittedRowsByField = previous
    }
  }
}

/** Every non-empty list in the document, rows' own lists before the list holding them. */
function collectCollections(root: Record<string, unknown>): Collection[] {
  const found: Collection[] = []
  const visit = (object: Record<string, unknown>, path: string, nested: boolean): void => {
    for (const [key, value] of Object.entries(object)) {
      // The notes are rewritten on every step; they are never trim candidates.
      if (object === root && (key === TRUNCATION_SUMMARY_KEY || key === PARTIAL_LISTS_KEY)) continue
      const valuePath = path ? `${path}.${key}` : key
      if (Array.isArray(value)) {
        let records = false
        for (const row of value) {
          if (!isRecord(row)) continue
          records = true
          visit(row, `${valuePath}[]`, true)
        }
        if (value.length > 0) found.push({ path: valuePath, nested, records, owner: object, key, rows: value })
      } else if (isRecord(value)) {
        visit(value, valuePath, nested)
      }
    }
  }
  visit(root, '', false)
  return found
}

/**
 * The order lists give up rows. Each stage shrinks its lists evenly (the
 * longest first, none below the stage floor) before the next one starts, so
 * a short rollup such as `markets` or a ranking loses a row only once no
 * longer list has more rows left than it does.
 */
const TRIM_STAGES: ReadonlyArray<{ applies: (list: Collection) => boolean; floor: number }> = [
  // Lists longer than a rollup, wherever they sit, down to rollup size.
  { applies: (list) => list.records && list.rows.length > SMALL_LIST_ROWS, floor: SMALL_LIST_ROWS },
  // Per-row detail (the names under each Property row), down to one entry a row.
  { applies: (list) => list.records && list.nested, floor: 1 },
  // Every other list, rollups included, down to one row.
  { applies: (list) => list.records && !list.nested, floor: 1 },
  { applies: (list) => list.records && list.nested, floor: 0 },
  { applies: (list) => list.records && !list.nested, floor: 0 },
  // Scalar lists can carry identity (served model IDs), so they go last.
  { applies: (list) => !list.records, floor: 0 },
]

/**
 * What the copy shows now: rows kept per collection path (only lists still
 * reachable count, so rows cut with their parent row are not counted twice),
 * and a note for every page cursor that now skips rows.
 */
function currentSummary(root: Record<string, unknown>, owned: ReadonlyMap<object, ReadonlyMap<string, Collection>>): TruncationSummary {
  const counts = new Map<string, { kept: number; total: number }>()
  const cursors: Record<string, string> = {}
  const visit = (object: Record<string, unknown>, path: string): void => {
    const lists = owned.get(object)
    for (const [key, value] of Object.entries(object)) {
      if (object === root && (key === TRUNCATION_SUMMARY_KEY || key === PARTIAL_LISTS_KEY)) continue
      const valuePath = path ? `${path}.${key}` : key
      if (Array.isArray(value)) {
        const list = lists?.get(key)
        if (list) {
          const count = counts.get(list.path) ?? { kept: 0, total: 0 }
          count.kept += value.length
          count.total += list.rows.length
          counts.set(list.path, count)
          noteCursor(object, path, list.path, value.length, list.rows.length, cursors, root)
        }
        for (const row of value) if (isRecord(row)) visit(row, `${valuePath}[]`)
      } else if (isRecord(value)) {
        visit(value, valuePath)
      }
    }
  }
  visit(root, '')
  return keptSummary(counts, cursors)
}

/**
 * Lower bound on what the nested path can reach: every outermost collection
 * emptied, no markers. A map-shaped result (hundreds of keyed collections)
 * cannot fit even then, so it skips the walk instead of spending every probe
 * to learn that.
 */
function emptiedFloorChars(root: Record<string, unknown>): number {
  return JSON.stringify(root, (_key, value: unknown) => (Array.isArray(value) ? [] : value)).length
}

/**
 * Fallback for nested/multiple collections; only a serialized copy is changed.
 * Walks `TRIM_STAGES` until the copy fits, keeps the highest even level of
 * the stage that made it fit (plus one more row for its leading lists while
 * room remains), then gives rows back to earlier stages, latest first.
 */
function trimNestedArrays(full: string): string | undefined {
  const copy: unknown = JSON.parse(full)
  if (!isRecord(copy)) return undefined
  copy.__truncated = true
  copy[TRUNCATION_SUMMARY_KEY] = keptSummary(new Map())
  if (emptiedFloorChars(copy) > MAX_TOOL_RESULT_CHARS) return undefined
  const lists = collectCollections(copy)
  const owned = new Map<object, Map<string, Collection>>()
  for (const list of lists) {
    const byKey = owned.get(list.owner) ?? new Map<string, Collection>()
    byKey.set(list.key, list)
    owned.set(list.owner, byKey)
  }
  const stagesOf = lists.map(list => TRIM_STAGES.flatMap((stage, index) => (stage.applies(list) ? [index] : [])))
  const levels = TRIM_STAGES.map(() => Infinity)
  let boosted: { stage: number; lists: ReadonlySet<number> } | undefined
  const capOf = (index: number): number => stagesOf[index]!.reduce((cap, stage) => Math.min(
    cap,
    levels[stage]! + (boosted?.stage === stage && boosted.lists.has(index) ? 1 : 0),
  ), Infinity)
  const trim = listTrimmer(lists)
  let spent = 0
  const render = (): string => {
    trim(lists.map((_, index) => capOf(index)))
    copy[TRUNCATION_SUMMARY_KEY] = currentSummary(copy, owned)
    const text = serializeResult(withPartialLists(copy))
    spent += text.length
    return text
  }
  // Once the budget is spent every probe reads as too big, so each search
  // settles on a state already known to fit.
  const fits = (): boolean => spent <= TRUNCATION_SERIALIZE_BUDGET_CHARS && fitsCap(render())
  const members = (stage: number): number[] => lists.flatMap((_, index) => (stagesOf[index]!.includes(stage) ? [index] : []))
  const longest = (indexes: number[]): number => indexes.reduce((max, index) => Math.max(max, lists[index]!.rows.length), 0)

  let out = render()
  let fittedAt = -1
  for (let stage = 0; stage < TRIM_STAGES.length && !fitsCap(out); stage++) {
    if (spent > TRUNCATION_SERIALIZE_BUDGET_CHARS) return undefined
    const { floor } = TRIM_STAGES[stage]!
    const indexes = members(stage)
    const top = longest(indexes)
    if (top <= floor) continue
    levels[stage] = floor
    out = render()
    if (!fitsCap(out)) continue
    fittedAt = stage
    // Rendering at `top` did not fit (the previous stage's end state), so
    // search below it.
    const level = floor + largestFitting(top - floor - 1, (n) => {
      levels[stage] = floor + n
      return fits()
    })
    levels[stage] = level
    const cut = indexes.filter(index => lists[index]!.rows.length > level && capOf(index) === level)
    const extra = largestFitting(cut.length, (n) => {
      boosted = { stage, lists: new Set(cut.slice(0, n)) }
      return fits()
    })
    boosted = { stage, lists: new Set(cut.slice(0, extra)) }
    out = render()
  }
  if (!fitsCap(out)) return undefined
  for (let stage = fittedAt - 1; stage >= 0; stage--) {
    const floor = levels[stage]!
    const top = longest(members(stage))
    if (floor === Infinity || top <= floor) continue
    levels[stage] = floor + largestFitting(top - floor, (n) => {
      levels[stage] = floor + n
      return fits()
    })
  }
  out = render()
  return fitsCap(out) ? out : undefined
}

/**
 * Rows kept in the outer lists of a serialized result: the rows a caller asked
 * for (Properties, markets, ranked entries), not the detail inside each row.
 * The notes are not counted.
 */
function keptRowTotal(serialized: string): number {
  const count = (value: unknown): number => {
    if (Array.isArray(value)) return value.length
    if (!isRecord(value)) return 0
    return Object.entries(value).reduce((sum, [key, child]) => (key.startsWith('__') ? sum : sum + count(child)), 0)
  }
  try {
    return count(JSON.parse(serialized))
  } catch {
    return 0
  }
}

/** Whether a document holds any non-empty list besides `primary`, at any depth. */
function hasOtherLists(value: unknown, primary: unknown[]): boolean {
  if (Array.isArray(value)) {
    if (value !== primary && value.length > 0) return true
    return value.some(row => (isRecord(row) || Array.isArray(row)) && hasOtherLists(row, primary))
  }
  return isRecord(value) && Object.values(value).some(child => hasOtherLists(child, primary))
}

/** Bounded display paths keep long query-text keys from consuming the omission reserve. */
function projectionPath(path: string): string {
  if (path.length <= MAX_SUMMARY_PATH_CHARS) return path
  const digest = createHash('sha256').update(path).digest('hex').slice(0, 12)
  return `${truncateUtf16(path, 48)}...#${digest}${path.slice(-24)}`
}

/**
 * Bounded fallback for very large results or an exhausted fair-share search.
 * Arrays keep complete original rows. Scalar text retains an explicitly marked
 * prefix; omission metadata has its own bound and cannot erase retained totals.
 *
 * With `partialRows`, a row whole-row cuts cannot show (the first row of a
 * list with no room for it whole, or a row alone over the cap) is shown
 * projected (`items[0].markdown` under `slicedKeys`), and the map records
 * that list's path and the row's index. The result then carries the tool's
 * own list notes first, as whole-row cuts do, with `reserve` characters
 * taken from the rows to make room for them.
 */
function boundedProjection(full: string, partialRows?: Map<string, number>, reserve = 0): string {
  const value: unknown = JSON.parse(full)
  let summary: TruncationSummary & { moreDroppedKeys?: number; moreMetadataEntries?: number; projection: string } = {
    droppedKeys: [], keptItems: {},
    projection: partialRows
      ? 'Array rows are complete unless slicedKeys or droppedKeys name a field inside one; sliced strings are partial prefixes and omitted fields are not evidence. Never follow a cursor from a cut page; re-request the original cursor with a smaller limit.'
      : 'Only complete array rows and marked partial string prefixes are shown; omitted fields are not evidence. Never follow a cursor from a cut page; re-request the original cursor with a smaller limit.',
  }
  const skippedMetadata = (): void => { summary.moreMetadataEntries = (summary.moreMetadataEntries ?? 0) + 1 }
  const record = <T>(entries: Record<string, T>, path: string, value: T): boolean => {
    if (Object.keys(entries).length >= MAX_SUMMARY_KEYS) { skippedMetadata(); return false }
    const key = projectionPath(path)
    entries[key] = value
    if (serializeResult(summary).length <= PROJECTION_METADATA_CHARS) return true
    delete entries[key]
    skippedMetadata()
    return false
  }
  let dropped = 0
  const omit = (path: string): void => {
    dropped++
    if (summary.droppedKeys.length < MAX_SUMMARY_KEYS) {
      summary.droppedKeys.push(projectionPath(path))
      if (serializeResult(summary).length > PROJECTION_METADATA_CHARS) summary.droppedKeys.pop()
    }
    if (dropped > summary.droppedKeys.length) summary.moreDroppedKeys = dropped - summary.droppedKeys.length
  }
  /** Owners of a list that lost rows, marked so their page notes read as incomplete. */
  const cutOwners = new Set<Record<string, unknown>>()
  const project = (input: unknown, budget: number, path: string, owner?: Record<string, unknown>, ownerPath = ''): string | undefined => {
    if (Array.isArray(input)) {
      const rows: string[] = []
      let used = 2
      for (const row of input) {
        const text = serializeResult(row)
        const cost = text.length + (rows.length > 0 ? 1 : 0)
        if (used + cost <= budget) {
          rows.push(text)
          used += cost
          continue
        }
        if (partialRows && (rows.length === 0 || text.length > MAX_TOOL_RESULT_CHARS)) {
          const before = { summary: serializeResult(summary), dropped }
          const partial = project(row, budget - used - (rows.length > 0 ? 1 : 0), `${path || 'items'}[${rows.length}]`)
          if (partial !== undefined && partial !== '{}' && partial !== '[]') {
            partialRows.set(path || 'items', rows.length)
            rows.push(partial)
          } else {
            // A row with no field left to show is dropped like any other, without naming its fields.
            summary = JSON.parse(before.summary) as typeof summary
            dropped = before.dropped
          }
        }
        break
      }
      if (rows.length < input.length) {
        if (partialRows && owner) cutOwners.add(owner)
        record(summary.keptItems, path || 'items', `${rows.length} of ${input.length}`)
        if (rows.length === 0) omit(path || 'items')
        if (owner) {
          const cursors: Record<string, string> = {}
          noteCursor(owner, ownerPath, path, rows.length, input.length, cursors, isRecord(value) ? value : owner)
          for (const [cursor, note] of Object.entries(cursors)) {
            record(summary.cursors ??= {}, cursor, note.replace(path, projectionPath(path)))
          }
        }
      }
      return `[${rows.join(',')}]`
    }
    if (!isRecord(input)) {
      const text = serializeResult(input)
      if (text.length <= budget) return text
      if (typeof input === 'string' && budget > 2) {
        // Escaping can double the displayed size, so search serialized prefixes.
        // No probe handles more input characters than the remaining output budget.
        const kept = largestFitting(Math.min(input.length, budget - 2), length => serializeResult(truncateUtf16(input, length)).length <= budget)
        const prefix = truncateUtf16(input, kept)
        if (prefix.length > 0 && record(summary.slicedKeys ??= {}, path || '(root)', { keptChars: prefix.length, totalChars: input.length })) return serializeResult(prefix)
      }
      omit(path || '(root)')
      return undefined
    }
    // Preserve small identity values and totals before spending room on evidence.
    // With partial rows, a list or object too large to show whole also waits for
    // its smaller siblings, so a document shown in part cannot crowd out `warnings`.
    const priority = ([key, child]: [string, unknown]): number => key === 'queryPage' && isRecord(child) ? 0
      : typeof child === 'string' && child.length > budget ? 2
        : typeof child !== 'object' || child === null ? 0
          : partialRows && serializeResult(child).length > budget ? 2 : 1
    const fields = Object.entries(input).filter(([key]) => !key.startsWith('__'))
      .map(field => ({ field, rank: priority(field) }))
      .sort((a, b) => a.rank - b.rank)
      .map(({ field }) => field)
    const shown: string[] = []
    let used = 2
    for (const [key, child] of fields) {
      const childPath = path ? `${path}.${key}` : key
      const prefix = `${JSON.stringify(key)}:`
      const allowance = budget - used - prefix.length - (shown.length > 0 ? 1 : 0)
      if (allowance < 2) { omit(childPath); continue }
      const text = project(child, allowance, childPath, input, path)
      if (text === undefined) continue
      shown.push(prefix + text)
      used += prefix.length + text.length + (shown.length > 1 ? 1 : 0)
    }
    // The root is marked below; a nested owner of a cut list is marked as whole-row cuts mark it.
    if (path && cutOwners.has(input)) shown.push('"__truncated":true')
    return `{${shown.join(',')}}`
  }
  const projected = project(value, MAX_TOOL_RESULT_CHARS - PROJECTION_SUMMARY_CHARS - reserve, '')
  const shown: unknown = projected === undefined ? {} : JSON.parse(projected)
  const output = isRecord(shown) ? shown : { items: shown }
  const result = { ...output, __truncated: true, [TRUNCATION_SUMMARY_KEY]: summary }
  return serializeResult(partialRows ? withPartialLists(result) : result)
}

/**
 * Rows a cut result shows of the list at a projection `path` (`data.results`),
 * 0 when the cut left it out. Lists inside a row are not compared.
 */
function rowsShown(cut: unknown, path: string): number {
  if (path.includes('[')) return Infinity
  const list = path.split('.').reduce<unknown>((owner, key) => (isRecord(owner) ? owner[key] : undefined), cut)
  return Array.isArray(list) ? list.length : 0
}

/**
 * `whole`, or a projection of `full` that shows in part a row `whole` drops
 * and no whole-row cut can show. Decided per list, so a sibling list
 * (`images`, `warnings`) that keeps its rows does not keep the document out.
 */
function withPartialRows(full: string, whole: string): string {
  const rescued = new Map<string, number>()
  let partial = boundedProjection(full, rescued)
  // The restored list notes can outgrow the summary's reserve; take their room from the rows.
  if (!fitsCap(partial)) {
    const { [PARTIAL_LISTS_KEY]: lists, __pagination: pagination } = JSON.parse(partial) as Record<string, unknown>
    rescued.clear()
    partial = boundedProjection(full, rescued, serializeResult({ lists, pagination }).length)
  }
  if (!fitsCap(partial)) return whole
  const cut: unknown = JSON.parse(whole)
  return [...rescued].some(([path, index]) => rowsShown(cut, path) <= index) ? partial : whole
}

export interface TruncateToolResultOptions {
  /**
   * Show in part a row whole-row cuts drop and can never show (a row alone
   * over the cap, or a first row with no room for it whole), its fields
   * marked under `slicedKeys` and `droppedKeys`. For remote tools, whose rows
   * are fetched documents rather than native evidence rows.
   */
  partialRows?: boolean
}

/**
 * Render a tool result as compact JSON text under the size cap WITHOUT
 * cutting a row mid-structure. The previous behavior blind-sliced the
 * serialized string, which could split an array element halfway, hand the
 * model invalid JSON, and silently drop a cited evidence row mid-object.
 * Structure-aware instead:
 *  - object whose largest field is an array: drop WHOLE trailing rows from that
 *    array until it fits, stamping `__truncated` + `__omittedRows` on the object;
 *  - top-level array: same, wrapped as `{ items, __truncated, __omittedRows }`;
 *  - nested/multiple arrays: shrink lists in `TRIM_STAGES` order (per-row
 *    detail first, short rollups last), same-named sibling collections
 *    together, with each owning object carrying `__truncated` and per-field
 *    counts in `__omittedRowsByField`; of this and the largest-array cut, the
 *    one keeping more rows across every list wins;
 *  - any other still-oversized value (a giant scalar / string with nothing
 *    structured to drop): a bounded JSON projection, the last resort.
 * Every truncation also names what it cut under `__truncation`: a field on the
 * structured output and on fallback projections. A page cut short
 * says there that its cursor skips the cut rows. Lists the tool itself cut
 * (its own total above the rows, or `truncated: true`) are named first, under
 * `__partialLists`, whether or not the cap cut anything. Retained evidence
 * rows stay byte-intact; grouping envelopes carry their own omission markers.
 * The structured output stays parseable JSON. Only the model-facing text is
 * trimmed; the programmatic `details` is never touched. Oversized scalar strings
 * retain only explicitly marked partial prefixes; strings inside array rows
 * are never sliced, unless `partialRows` is set and a whole-row cut would
 * drop a row it can never show.
 */
export function truncateToolResult(details: unknown, options: TruncateToolResultOptions = {}): string {
  const annotated = withPartialLists(details)
  const full = serializeResult(annotated)
  if (full.length <= MAX_TOOL_RESULT_CHARS) return full
  const whole = truncateWholeRows(details, full)
  return options.partialRows ? withPartialRows(full, whole) : whole
}

/** The cut `truncateToolResult` makes for a `full` text over the cap, keeping retained rows whole. */
function truncateWholeRows(details: unknown, full: string): string {
  // Bound the work BEFORE any structured path. Each of them re-serializes the
  // enclosing document per step, so a guard in front of only the nested path
  // left the top-level-array and largest-array paths exposed. Past this size
  // they discard nearly everything they walk, so project complete rows in
  // a single bounded pass instead.
  if (full.length > MAX_STRUCTURED_TRUNCATION_CHARS) return boundedProjection(full)

  // Top-level array: trim whole elements, wrap with the marker (always fits, an
  // empty `items` is tiny).
  if (Array.isArray(details)) {
    const render = (rows: unknown[]): string => serializeResult({
      items: rows,
      __truncated: true,
      __omittedRows: details.length - rows.length,
      [TRUNCATION_SUMMARY_KEY]: keptSummary(new Map([['items', { kept: rows.length, total: details.length }]])),
    })
    return render(trimRowsToFit(details, render))
  }

  // Object whose largest field is an array (the ads-artifact shape): trim that
  // array by whole rows, keep every other field intact.
  if (details && typeof details === 'object') {
    const obj = details as Record<string, unknown>
    const arrayKey = largestArrayKey(obj)
    if (!arrayKey) return trimNestedArrays(full) ?? boundedProjection(full)
    const rows = obj[arrayKey] as unknown[]
    const render = (kept: unknown[]): string => {
      const cursors: Record<string, string> = {}
      noteCursor(obj, '', arrayKey, kept.length, rows.length, cursors)
      return serializeResult(withPartialLists({
        ...obj,
        [arrayKey]: kept,
        __truncated: true,
        __omittedRows: rows.length - kept.length,
        [TRUNCATION_SUMMARY_KEY]: keptSummary(new Map([[arrayKey, { kept: kept.length, total: rows.length }]]), cursors),
      }))
    }
    const out = render(trimRowsToFit(rows, render))
    // When other lists sit beside or inside the largest one (a summary with
    // rows, rankings and markets), cutting only the largest keeps every
    // other list whole and can leave one or two primary rows. The staged
    // trim may keep more; take whichever keeps more outer rows across every
    // list. `out` misses the cap only when the non-array fields ALONE blow
    // it, and then only the staged trim or the last resort is left.
    const nested = !fitsCap(out) || hasOtherLists(obj, rows) ? trimNestedArrays(full) : undefined
    if (fitsCap(out) && (nested === undefined || keptRowTotal(nested) <= keptRowTotal(out))) return out
    if (nested !== undefined) return nested
  }

  return boundedProjection(full)
}

/**
 * The model reads `content`; code reads `details`. Ratios the response schemas
 * declare are shown as percent text in `content` only (see tool-result-units.ts).
 */
function textResult<T>(details: T, responseSchemas: readonly Record<string, unknown>[] = []): AgentToolResult<T> {
  const components = responseSchemas.length > 0 ? responseComponents() : {}
  const shown = responseSchemas.reduce<unknown>((value, schema) => renderRatioUnits(schema, value, components), details)
  return {
    content: [{ type: 'text', text: truncateToolResult(shown) }],
    details,
  }
}

/** Verified stored reads whose identical results can be referenced within a turn. */
const MEMO_STORED_READS: ReadonlySet<string> = new Set([
  CanonryMcpToolNames.canonry_competitor_landscape,
  CanonryMcpToolNames.canonry_measurement_overview,
  CanonryMcpToolNames.canonry_measurement_portfolio_summary,
  CanonryMcpToolNames.canonry_measurement_property_evidence,
  CanonryMcpToolNames.canonry_measurement_property_questions,
  CanonryMcpToolNames.canonry_measurement_question_result,
  CanonryMcpToolNames.canonry_measurement_property_competitors,
  CanonryMcpToolNames.canonry_measurement_changes,
  CanonryMcpToolNames.canonry_visibility_report,
  CanonryMcpToolNames.canonry_visibility_stats,
  CanonryMcpToolNames.canonry_visibility_compare,
  CanonryMcpToolNames.canonry_sentiment,
  CanonryMcpToolNames.canonry_sentiment_settings,
  CanonryMcpToolNames.canonry_sentiment_evidence,
  CanonryMcpToolNames.canonry_sentiment_compare,
  CanonryMcpToolNames.canonry_sentiment_backfill_preview,
  CanonryMcpToolNames.canonry_insights_list,
])
/** Paging handles apply to dynamic stored reads even when memoization is unsafe. */
const STORED_PAGE_READS: ReadonlySet<string> = new Set([
  ...MEMO_STORED_READS,
  CanonryMcpToolNames.canonry_project_overview,
  CanonryMcpToolNames.canonry_measurement_data_quality,
  CanonryMcpToolNames.canonry_sentiment_job,
  CanonryMcpToolNames.canonry_sentiment_jobs,
])
const storedReadTools = new WeakSet<AgentTool>()
const storedPageReadTools = new WeakSet<AgentTool>()

/** Only local adapter reads that do not call live providers may be memoized. */
export function isStoredReadTool(tool: AgentTool): boolean { return storedReadTools.has(tool) }

/** Verified native stored reads, including job polling, may use turn-local page references. */
export function isStoredPageReadTool(tool: AgentTool): boolean { return storedPageReadTools.has(tool) }

export interface AgentMcpAdapterContext {
  client: ApiClient
  projectName: string
}

interface JsonObjectSchema {
  type?: string
  properties?: Record<string, unknown>
  required?: string[]
  [k: string]: unknown
}

/**
 * MCP tools take `project` as input; Aero closes over `projectName` so the
 * LLM cannot target the wrong project. This strips the `project` property
 * (and its `required` entry) from a JSON Schema so the visible schema
 * matches what Aero sees, while the runtime injects `ctx.projectName`
 * before calling the underlying handler.
 */
function stripProjectFromJsonSchema(jsonSchema: unknown): {
  schema: unknown
  hadProject: boolean
} {
  if (!jsonSchema || typeof jsonSchema !== 'object') {
    return { schema: jsonSchema, hadProject: false }
  }
  const obj = jsonSchema as JsonObjectSchema
  const properties = obj.properties
  if (!properties || typeof properties !== 'object' || !('project' in properties)) {
    return { schema: jsonSchema, hadProject: false }
  }
  const { project: _project, ...remainingProps } = properties as Record<string, unknown>
  const required = Array.isArray(obj.required)
    ? obj.required.filter((name) => name !== 'project')
    : obj.required
  const stripped: JsonObjectSchema = { ...obj, properties: remainingProps }
  if (required === undefined) {
    delete stripped.required
  } else {
    stripped.required = required as string[]
  }
  return { schema: stripped, hadProject: true }
}

/**
 * Convert a CanonryMcpTool into an AgentTool that pi-agent-core can register.
 *
 * - Strips top-level `project` from the schema and injects `ctx.projectName`
 *   so the LLM cannot target the wrong project (mirrors the existing Aero
 *   tool pattern).
 * - Wraps the JSON Schema in `Type.Unsafe` so pi-agent-core's TSchema-typed
 *   `parameters` field accepts it without conversion.
 * - Wraps the handler result in pi-agent-core's `AgentToolResult` envelope
 *   with a 20 KB truncation guard, showing declared ratios as percents.
 */
export function mcpToAgentTool(
  tool: CanonryMcpTool,
  ctx: AgentMcpAdapterContext,
): AgentTool {
  const { schema: visibleSchema, hadProject } = stripProjectFromJsonSchema(tool.inputJsonSchema)
  const parameters = Type.Unsafe<Record<string, unknown>>(visibleSchema as object) as TSchema
  const responseSchemas = responseSchemasFor(tool.openApiOperations)

  const execute = async (
    _toolCallId: string,
    params: Record<string, unknown>,
  ): Promise<AgentToolResult<unknown>> => {
    const handlerInput = hadProject ? { ...params, project: ctx.projectName } : params
    const result = await runWithUsageTags(ctx.client, { mcpTool: tool.name, mcpCall: randomUUID() }, () =>
      tool.handler(ctx.client, handlerInput as never))
    return textResult(result, responseSchemas)
  }

  const adapted = {
    name: tool.name,
    label: tool.title,
    description: tool.description,
    parameters,
    execute,
  } as AgentTool
  if (tool.access === 'read' && MEMO_STORED_READS.has(tool.name)) storedReadTools.add(adapted)
  if (tool.access === 'read' && STORED_PAGE_READS.has(tool.name)) storedPageReadTools.add(adapted)
  return adapted
}

/**
 * Tools that exist in the MCP registry for completeness but should not be
 * exposed to the built-in Aero agent. Aero clearing its own conversation is
 * a foot-gun (it would erase the user's context mid-turn).
 */
export const AERO_EXCLUDED_MCP_TOOLS: ReadonlySet<CanonryMcpToolName> = new Set([
  // Aero reads stored sentiment. Configuration and backfill submission can
  // start paid classifier work and remain operator actions.
  'canonry_sentiment_configure',
  'canonry_sentiment_backfill',

  CanonryMcpToolNames.canonry_agent_clear,
  CanonryMcpToolNames.canonry_agent_conversations_new,
  CanonryMcpToolNames.canonry_agent_conversations_resume,
  CanonryMcpToolNames.canonry_agent_conversations_delete,
  CanonryMcpToolNames.canonry_results_clear,
])

/**
 * Tools withheld from Aero when the install manages sweeps. The operator owns
 * when sweeps run and what they cost, so Aero may not start or fill a sweep,
 * or write a schedule. `canonry_apply_config` is here because an applied spec
 * replaces the project's schedule. Enforced on the tool surface rather than in
 * the dashboard so the API and `canonry agent ask` get the same rule. The
 * host's own `canonry run` and `canonry schedule` commands are unaffected.
 *
 * `canonry_run_cancel` stays, because Aero can still start site audits and
 * syncs and must be able to stop them. It refuses sweeps instead; see
 * `refuseManagedSweepCancel`.
 */
export const AERO_MANAGED_SWEEP_MCP_TOOLS: ReadonlySet<CanonryMcpToolName> = new Set([
  CanonryMcpToolNames.canonry_run_trigger,
  CanonryMcpToolNames.canonry_run_fill,
  CanonryMcpToolNames.canonry_schedule_set,
  CanonryMcpToolNames.canonry_schedule_delete,
  CanonryMcpToolNames.canonry_apply_config,
])

export const MANAGED_SWEEP_CANCEL_REFUSAL =
  'This install manages answer-visibility sweeps, so Aero cannot cancel one. Ask the operator to cancel it.'

/**
 * On a managed install, look the run up before cancelling it and refuse when
 * it is an answer-visibility sweep. Other run kinds cancel as before.
 */
function refuseManagedSweepCancel(tool: AgentTool, ctx: AgentMcpAdapterContext): AgentTool {
  const cancel = tool.execute
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      const runId = (params as { runId?: unknown }).runId
      if (typeof runId === 'string') {
        const run = await ctx.client.getRun(runId)
        if (run.kind === RunKinds['answer-visibility']) throw new Error(MANAGED_SWEEP_CANCEL_REFUSAL)
      }
      return cancel(toolCallId, params, ...rest)
    },
  } as AgentTool
}

export interface BuildMcpAgentToolsOptions {
  /** Filter to read-only tools when true. */
  readOnly?: boolean
  /** Optional allow-list for profile-specific tool surfaces. */
  includeNames?: ReadonlySet<CanonryMcpToolName>
  /**
   * Withhold the writes in `AERO_MANAGED_SWEEP_MCP_TOOLS` and make
   * `canonry_run_cancel` refuse sweeps.
   */
  managedSweeps?: boolean
}

/**
 * Build the AgentTool list Aero registers — every MCP tool except the
 * exclusion set, optionally narrowed to reads only. Adding a new tool to
 * `tool-registry.ts` is enough to make it available to Aero; no separate
 * registration is required.
 */
export function buildMcpAgentTools(
  registry: readonly CanonryMcpRegistryTool[],
  ctx: AgentMcpAdapterContext,
  opts: BuildMcpAgentToolsOptions = {},
): AgentTool[] {
  return registry
    .filter((tool) => !AERO_EXCLUDED_MCP_TOOLS.has(tool.name))
    .filter((tool) => (opts.includeNames ? opts.includeNames.has(tool.name) : true))
    .filter((tool) => (opts.readOnly ? tool.access === 'read' : true))
    .filter((tool) => (opts.managedSweeps ? !AERO_MANAGED_SWEEP_MCP_TOOLS.has(tool.name) : true))
    .map((tool) => {
      const agentTool = mcpToAgentTool(tool, ctx)
      return opts.managedSweeps && tool.name === CanonryMcpToolNames.canonry_run_cancel
        ? refuseManagedSweepCancel(agentTool, ctx)
        : agentTool
    })
}
