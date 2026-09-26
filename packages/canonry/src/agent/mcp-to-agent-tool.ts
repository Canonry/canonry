import { Type, type TSchema } from '@sinclair/typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import { randomUUID } from 'node:crypto'
import { RunKinds } from '@ainyc/canonry-contracts'
import { runWithUsageTags, type ApiClient } from '../client.js'
import {
  CanonryMcpToolNames,
  type CanonryMcpRegistryTool,
  type CanonryMcpTool,
  type CanonryMcpToolName,
} from '../mcp/tool-registry.js'

const MAX_TOOL_RESULT_CHARS = 20_000
const TRUNCATION_NOTE = '... (truncated, result too large)'
/**
 * Every truncation says what it cut, under this key. Structured output
 * carries it as a field next to `__truncated`; the plain slice carries it as
 * a `__truncation: {...}` line just before the closing note. Collection
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
/**
 * Ceiling on the input the structured paths will attempt. Each of them
 * re-serializes the enclosing document per step, and a pathological payload
 * once spent 289s of the server's single thread to emit the same 19,397
 * characters a plain slice produces. Above this size, fall through to the
 * marked slice: the structure-aware path exists to keep evidence rows
 * parseable, and at this scale it is discarding almost everything regardless.
 */
const MAX_STRUCTURED_TRUNCATION_CHARS = 2_000_000
/**
 * Bound on the characters the nested path serializes while it searches. Byte
 * size alone does not bound this work: every probe re-serializes the trimmed
 * copy. A real result settles in a few dozen probes; a pathological one
 * spends this and takes the marked slice.
 */
const TRUNCATION_SERIALIZE_BUDGET_CHARS = 64_000_000
/** Lists this long or shorter read as rollups (markets, rankings) and keep their rows longest. */
const SMALL_LIST_ROWS = 25
/** Bounds on the slice fallback's summary line, so it cannot crowd out the result. */
const MAX_SUMMARY_DEPTH = 5
const MAX_SUMMARY_KEYS = 30
const MAX_SUMMARY_SEGMENT_CHARS = 60
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
  /** Collections (or, for the slice, top-level keys) the model sees none of. */
  droppedKeys: string[]
  /** `"<kept> of <total>"` for every collection that lost rows. */
  keptItems: Record<string, string>
  /** Cursors that resume past rows this cut dropped, and how to read those rows. */
  cursors?: Record<string, string>
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
function noteCursor(owner: Record<string, unknown>, ownerPath: string, listPath: string, kept: number, total: number, notes: Record<string, string>): void {
  const key = CURSOR_KEYS.find(candidate => owner[candidate] !== undefined && owner[candidate] !== null)
  if (!key || kept >= total) return
  notes[ownerPath ? `${ownerPath}.${key}` : key] =
    `skips the ${total - kept} rows cut from ${listPath}; to read them, call again with ${kept > 0 ? `limit <= ${kept}` : 'a lower limit'}`
}

interface ListCount {
  count: number
  text: string
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
 * A bare `total` counts the one list with no total of its own (`competitors`
 * beside `citedDomains` + `citedDomainsTotal`). A bare `truncated: true`
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
      const counts = lists.map(([key]) => ownListTotal(numbers, key))
      const uncounted = counts.flatMap((count, index) => count ? [] : [index])
      if (uncounted.length === 1) counts[uncounted[0]!] = bareTotal(numbers)
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
  if (!notes && !hadNote) return value
  const { [PARTIAL_LISTS_KEY]: _previous, ...rest } = value
  return notes ? { [PARTIAL_LISTS_KEY]: notes, ...rest } : rest
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
          noteCursor(object, path, list.path, value.length, list.rows.length, cursors)
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

/** An object or array still open where the slice cuts the text. */
interface OpenContainer {
  kind: 'object' | 'array'
  path: string
  /** The value this container renders, looked up in the original result. */
  value: unknown
  /** Children rendered in full: followed by a comma, or a closed container. */
  complete: number
  childClosed: boolean
  expectKey: boolean
  key?: string
}

function shortSegment(key: string): string {
  return key.length > MAX_SUMMARY_SEGMENT_CHARS ? `${key.slice(0, MAX_SUMMARY_SEGMENT_CHARS)}...` : key
}

function childPath(container: OpenContainer): string {
  if (container.kind === 'array') return `${container.path}[${container.complete}]`
  const key = shortSegment(container.key ?? '')
  return container.path ? `${container.path}.${key}` : key
}

/** Keys JSON.stringify emits for a plain object, in emitted order. */
function serializedKeys(value: unknown): string[] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.toJSON === 'function') return undefined
  return Object.keys(record).filter((key) => {
    const child = record[key]
    return child !== undefined && typeof child !== 'function' && typeof child !== 'symbol'
  })
}

/** The containers open at the end of `shown`, a prefix of the result's serialized JSON. */
function openContainersAt(shown: string, details: unknown): OpenContainer[] {
  const stack: OpenContainer[] = []
  let inString = false
  let escaped = false
  let stringStart = 0
  for (let i = 0; i < shown.length; i++) {
    const ch = shown[i]
    const top = stack.at(-1)
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') {
        inString = false
        if (top?.kind === 'object' && top.expectKey) {
          top.key = JSON.parse(shown.slice(stringStart, i + 1)) as string
          top.expectKey = false
        }
      }
      continue
    }
    if (ch === '"') {
      inString = true
      stringStart = i
    } else if (ch === '{' || ch === '[') {
      let value: unknown = details
      if (top) {
        const parent = top.value as Record<string, unknown> | unknown[] | null | undefined
        value = top.kind === 'array'
          ? (Array.isArray(parent) ? parent[top.complete] : undefined)
          : (parent && typeof parent === 'object' ? (parent as Record<string, unknown>)[top.key ?? ''] : undefined)
      }
      stack.push({
        kind: ch === '{' ? 'object' : 'array',
        path: top ? childPath(top) : '',
        value,
        complete: 0,
        childClosed: false,
        expectKey: ch === '{',
      })
    } else if (ch === '}' || ch === ']') {
      stack.pop()
      const parent = stack.at(-1)
      if (parent) parent.childClosed = true
    } else if (ch === ',' && top) {
      top.complete++
      top.childClosed = false
      top.expectKey = top.kind === 'object'
    }
  }
  return stack
}

/**
 * The `__truncation` line for a plain slice: where the text stops, how much
 * of each collection around that point was shown, and which top-level keys
 * the model never sees (with array lengths). It reads only the shown prefix
 * and the result's own key lists, so it stays cheap on any payload.
 */
function sliceSummaryLine(shown: string, details: unknown): string {
  if (!shown.startsWith('{') && !shown.startsWith('[')) return ''
  const stack = openContainersAt(shown, details)
  const root = stack.at(0)
  const deepest = stack.at(-1)
  if (!root || !deepest) return ''
  const summary: TruncationSummary & { cutAt: string; moreDroppedKeys?: number } = {
    // Between two children the cut is named by their container.
    cutAt: deepest.childClosed || deepest.expectKey ? deepest.path : childPath(deepest),
    droppedKeys: [],
    keptItems: {},
  }
  for (const container of stack.slice(0, MAX_SUMMARY_DEPTH)) {
    const total = container.kind === 'array'
      ? (Array.isArray(container.value) ? container.value.length : undefined)
      : serializedKeys(container.value)?.length
    if (total === undefined) break
    if (container === root && container.kind === 'object') continue
    const shownCount = container.complete + (container.childClosed ? 1 : 0)
    summary.keptItems[container.path || '(root)'] = container.kind === 'array'
      ? `${shownCount} of ${total}`
      : `${shownCount} of ${total} keys`
  }
  const rootKeys = root.kind === 'object' ? serializedKeys(root.value) : undefined
  if (rootKeys) {
    const inProgress = root.expectKey || root.childClosed ? 0 : 1
    const dropped = rootKeys.slice(root.complete + (root.childClosed ? 1 : 0) + inProgress)
    const record = root.value as Record<string, unknown>
    for (const key of dropped.slice(0, MAX_SUMMARY_KEYS)) {
      const label = shortSegment(key)
      summary.droppedKeys.push(label)
      const value = record[key]
      if (Array.isArray(value)) summary.keptItems[label] = `0 of ${value.length}`
    }
    if (dropped.length > MAX_SUMMARY_KEYS) summary.moreDroppedKeys = dropped.length - MAX_SUMMARY_KEYS
  }
  return `${TRUNCATION_SUMMARY_KEY}: ${JSON.stringify(summary)}`
}

/**
 * Last resort: a plain slice of the serialized text. It still names what was
 * cut, in a `__truncation` line before the closing note, sized so the slice,
 * the line and the note stay within the cap plus the note.
 */
function markedSlice(full: string, details: unknown): string {
  let cut = MAX_TOOL_RESULT_CHARS
  // The line describes the text shown before `cut`, and its own length moves
  // `cut`; a couple of rounds settle it.
  for (let attempt = 0; attempt < 4; attempt++) {
    const line = sliceSummaryLine(full.slice(0, cut), details)
    const cost = line ? line.length + 1 : 0
    if (cut + cost <= MAX_TOOL_RESULT_CHARS) {
      return full.slice(0, cut) + '\n' + (line ? line + '\n' : '') + TRUNCATION_NOTE
    }
    cut = MAX_TOOL_RESULT_CHARS - cost - attempt * 16
  }
  return full.slice(0, MAX_TOOL_RESULT_CHARS) + '\n' + TRUNCATION_NOTE
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
 *    structured to drop): a marked string slice, the last resort.
 * Every truncation also names what it cut under `__truncation`: a field on the
 * structured output, a line before the note on the slice. A page cut short
 * says there that its cursor skips the cut rows. Lists the tool itself cut
 * (its own total above the rows, or `truncated: true`) are named first, under
 * `__partialLists`, whether or not the cap cut anything. Retained evidence
 * rows stay byte-intact; grouping envelopes carry their own omission markers.
 * The structured output stays parseable JSON. Only the model-facing text is
 * trimmed; the programmatic `details` is never touched.
 */
export function truncateToolResult(details: unknown): string {
  const annotated = withPartialLists(details)
  const full = serializeResult(annotated)
  if (full.length <= MAX_TOOL_RESULT_CHARS) return full

  // Bound the work BEFORE any structured path. Each of them re-serializes the
  // enclosing document per step, so a guard in front of only the nested path
  // left the top-level-array and largest-array paths exposed. Past this size
  // they discard nearly everything they walk, so the walk is cost without
  // benefit.
  if (full.length > MAX_STRUCTURED_TRUNCATION_CHARS) return markedSlice(full, annotated)

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
    if (!arrayKey) return trimNestedArrays(full) ?? markedSlice(full, annotated)
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

  return markedSlice(full, annotated)
}

function textResult<T>(details: T): AgentToolResult<T> {
  return {
    content: [{ type: 'text', text: truncateToolResult(details) }],
    details,
  }
}

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
 *   with a 20 KB truncation guard.
 */
export function mcpToAgentTool(
  tool: CanonryMcpTool,
  ctx: AgentMcpAdapterContext,
): AgentTool {
  const { schema: visibleSchema, hadProject } = stripProjectFromJsonSchema(tool.inputJsonSchema)
  const parameters = Type.Unsafe<Record<string, unknown>>(visibleSchema as object) as TSchema

  const execute = async (
    _toolCallId: string,
    params: Record<string, unknown>,
  ): Promise<AgentToolResult<unknown>> => {
    const handlerInput = hadProject ? { ...params, project: ctx.projectName } : params
    const result = await runWithUsageTags(ctx.client, { mcpTool: tool.name, mcpCall: randomUUID() }, () =>
      tool.handler(ctx.client, handlerInput as never))
    return textResult(result)
  }

  return {
    name: tool.name,
    label: tool.title,
    description: tool.description,
    parameters,
    execute,
  } as AgentTool
}

/**
 * Tools that exist in the MCP registry for completeness but should not be
 * exposed to the built-in Aero agent. Aero clearing its own conversation is
 * a foot-gun (it would erase the user's context mid-turn).
 */
export const AERO_EXCLUDED_MCP_TOOLS: ReadonlySet<CanonryMcpToolName> = new Set([
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
