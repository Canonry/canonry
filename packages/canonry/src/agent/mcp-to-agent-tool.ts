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
 * Ceiling on the input `trimNestedArrays` will attempt. That path drops one
 * group of nested collections per iteration, and each iteration re-walks the
 * whole document (serializing every candidate array to size it) and
 * re-serializes the copy, with a binary search doing so again per step. The
 * cost is quadratic in the number of groups, so a pathological payload spent
 * 289s of the server's single thread to emit the same 19,397 characters a
 * plain slice produces. Above this size, fall through to the marked slice:
 * the structure-aware path exists to keep evidence rows parseable, and at
 * this scale it is discarding almost everything regardless.
 */
const MAX_STRUCTURED_TRUNCATION_CHARS = 2_000_000
/**
 * Bound on trimming passes in the nested path. Byte size alone does not bound
 * this work: 800 collections inside 1.6 MB (under the ceiling above) cost
 * 2.1s, because every pass re-walks the whole document. So the pass count
 * shrinks as the document grows, keeping passes x size at the old worst case
 * (32 passes of a 2 MB document). One pass trims every same-named sibling
 * collection at once (every `rows[].tags`), so a real result settles in a
 * handful of passes however many rows it has.
 */
const TRUNCATION_PASS_BUDGET_CHARS = 64_000_000
const MIN_TRUNCATION_PASSES = 32
const MAX_TRUNCATION_PASSES = 200
/** Bounds on the slice fallback's summary line, so it cannot crowd out the result. */
const MAX_SUMMARY_DEPTH = 5
const MAX_SUMMARY_KEYS = 30
const MAX_SUMMARY_SEGMENT_CHARS = 60

/** Pretty JSON, exactly what the model reads in the tool-result text. */
function serializeResult(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

interface TruncationSummary {
  /** Collections (or, for the slice, top-level keys) the model sees none of. */
  droppedKeys: string[]
  /** `"<kept> of <total>"` for every collection that lost rows. */
  keptItems: Record<string, string>
}

type KeptCounts = ReadonlyMap<string, { kept: number; total: number }>

function keptSummary(counts: KeptCounts): TruncationSummary {
  const summary: TruncationSummary = { droppedKeys: [], keptItems: {} }
  for (const [path, { kept, total }] of counts) {
    if (kept === 0) summary.droppedKeys.push(path)
    summary.keptItems[path] = `${kept} of ${total}`
  }
  return summary
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

interface NestedArrayCandidate {
  owner: Record<string, unknown>
  key: string
  rows: unknown[]
}

/**
 * Leaf collections that share a path (`rows[].tags` under every row) and so
 * are trimmed together, in one pass, to the same per-collection row count.
 */
interface CandidateGroup {
  path: string
  members: NestedArrayCandidate[]
  size: number
  hasRecordRows: boolean
}

/** Prefer evidence collections inside groups before dropping the groups themselves. */
function nestedArrayGroups(root: Record<string, unknown>): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup>()
  const visit = (object: Record<string, unknown>, path: string): boolean => {
    let containsRecordCollection = false
    for (const [key, value] of Object.entries(object)) {
      // The summary is rewritten on every step; it is never a trim candidate.
      if (object === root && key === TRUNCATION_SUMMARY_KEY) continue
      const valuePath = path ? `${path}.${key}` : key
      if (Array.isArray(value)) {
        let hasNestedRecords = false
        let hasRecordRows = false
        for (const row of value) {
          if (row && typeof row === 'object' && !Array.isArray(row)) {
            hasRecordRows = true
            hasNestedRecords = visit(row as Record<string, unknown>, `${valuePath}[]`) || hasNestedRecords
          }
        }
        if (value.length > 0 && !hasNestedRecords) {
          const id = `${Number(hasRecordRows)}:${valuePath}`
          const group = groups.get(id) ?? { path: valuePath, members: [], size: 0, hasRecordRows }
          group.members.push({ owner: object, key, rows: value })
          group.size += serializeResult(value).length
          groups.set(id, group)
        }
        containsRecordCollection = hasRecordRows || hasNestedRecords || containsRecordCollection
      } else if (value && typeof value === 'object') {
        containsRecordCollection = visit(value as Record<string, unknown>, valuePath) || containsRecordCollection
      }
    }
    return containsRecordCollection
  }
  visit(root, '')
  // Scalar arrays can carry identity metadata (for example served model IDs).
  // Drop evidence rows or whole groups first, preserving metadata on every
  // retained group. Scalar-only payloads still have a bounded fallback.
  return [...groups.values()].sort((left, right) =>
    Number(right.hasRecordRows) - Number(left.hasRecordRows) || right.size - left.size,
  )
}

/**
 * Trims one collection to a row count and keeps its owner's omission marker
 * in step. A group member with no more rows than the count keeps its rows and
 * its owner stays as it was, so untouched rows gain no marker.
 */
function memberTrimmer({ owner, key, rows }: NestedArrayCandidate): (count: number) => number {
  const hadTruncated = Object.hasOwn(owner, '__truncated')
  const priorTruncated = owner.__truncated
  const previous = owner.__omittedRowsByField
  const priorOmitted = previous && typeof previous === 'object' && !Array.isArray(previous)
    ? previous as Record<string, unknown>
    : undefined
  const priorValue = priorOmitted?.[key]
  const priorCount = typeof priorValue === 'number' ? priorValue : 0
  return (count) => {
    const kept = Math.min(count, rows.length)
    owner[key] = rows.slice(0, kept)
    const omitted = priorCount + rows.length - kept
    if (omitted > 0) {
      owner.__truncated = true
      owner.__omittedRowsByField = { ...priorOmitted, [key]: omitted }
      return kept
    }
    if (hadTruncated) owner.__truncated = priorTruncated
    else delete owner.__truncated
    if (previous === undefined) delete owner.__omittedRowsByField
    else owner.__omittedRowsByField = previous
    return kept
  }
}

/**
 * Lower bound on what the nested path can reach: every outermost collection
 * emptied, no markers. A map-shaped result (hundreds of keyed collections)
 * cannot fit even then, so it skips the walk instead of spending every pass
 * to learn that.
 */
function emptiedFloorChars(root: Record<string, unknown>): number {
  return JSON.stringify(root, (_key, value: unknown) => (Array.isArray(value) ? [] : value), 2).length
}

/** Fallback for nested/multiple collections; only a serialized copy is changed. */
function trimNestedArrays(full: string): string | undefined {
  const parsed: unknown = JSON.parse(full)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const copy = parsed as Record<string, unknown>
  const counts = new Map<string, { kept: number; total: number }>()
  copy.__truncated = true
  copy[TRUNCATION_SUMMARY_KEY] = keptSummary(counts)
  if (emptiedFloorChars(copy) > MAX_TOOL_RESULT_CHARS) return undefined
  let out = serializeResult(copy)
  // The per-pass re-walk is load-bearing: it lets a leaf collection be dropped
  // before the group owning it, and keeps scalar identity arrays out of reach
  // until groups are droppable. So bound the NUMBER of passes rather than
  // restructuring the search. A pathological payload exhausts the budget and
  // takes the marked slice; a normal one never approaches it.
  const passLimit = Math.min(
    MAX_TRUNCATION_PASSES,
    Math.max(MIN_TRUNCATION_PASSES, Math.floor(TRUNCATION_PASS_BUDGET_CHARS / full.length)),
  )
  let passes = 0
  while (!fitsCap(out)) {
    if (++passes > passLimit) return undefined
    const group = nestedArrayGroups(copy).at(0)
    if (!group) return undefined
    const trimmers = group.members.map(memberTrimmer)
    const total = group.members.reduce((sum, member) => sum + member.rows.length, 0)
    const longest = group.members.reduce((max, member) => Math.max(max, member.rows.length), 0)
    const prior = counts.get(group.path) ?? { kept: 0, total: 0 }
    // Every member keeps `count` rows; the first `extra` members keep one more.
    const keep = (count: number, extra = 0): string => {
      const kept = trimmers.reduce((sum, trim, index) => sum + trim(index < extra ? count + 1 : count), 0)
      counts.set(group.path, { kept: prior.kept + kept, total: prior.total + total })
      copy[TRUNCATION_SUMMARY_KEY] = keptSummary(counts)
      return serializeResult(copy)
    }
    out = keep(0)
    if (!fitsCap(out)) continue
    // Retain the largest whole-row prefix that fits, then spend what a uniform
    // count leaves over on one more row for the leading members.
    const count = largestFitting(longest - 1, (n) => fitsCap(keep(n)))
    const extra = trimmers.length > 1 ? largestFitting(trimmers.length - 1, (n) => fitsCap(keep(count, n))) : 0
    out = keep(count, extra)
  }
  return out
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

/** The containers open at the end of `shown`, a prefix of the result's pretty JSON. */
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
 * Render a tool result as JSON text under the size cap WITHOUT cutting a row
 * mid-structure. The previous behavior blind-sliced the serialized string,
 * which could split an array element halfway, hand the model invalid JSON, and
 * silently drop a cited evidence row mid-object. Structure-aware instead:
 *  - object whose largest field is an array: drop WHOLE trailing rows from that
 *    array until it fits, stamping `__truncated` + `__omittedRows` on the object;
 *  - top-level array: same, wrapped as `{ items, __truncated, __omittedRows }`;
 *  - nested/multiple arrays: trim whole evidence rows, same-named sibling
 *    collections together, with each owning object carrying `__truncated` and
 *    per-field counts in `__omittedRowsByField`;
 *  - any other still-oversized value (a giant scalar / string with nothing
 *    structured to drop): a marked string slice, the last resort.
 * Every truncation also names what it cut under `__truncation`: a field on the
 * structured output, a line before the note on the slice. Retained evidence
 * rows stay byte-intact; grouping envelopes carry their own omission markers.
 * The structured output stays parseable JSON. Only the model-facing text is
 * trimmed; the programmatic `details` is never touched.
 */
export function truncateToolResult(details: unknown): string {
  const full = serializeResult(details)
  if (full.length <= MAX_TOOL_RESULT_CHARS) return full

  // Bound the work BEFORE any structured path. Each of them re-serializes the
  // enclosing document per step, so a guard in front of only the nested path
  // left the top-level-array and largest-array paths exposed. Past this size
  // they discard nearly everything they walk, so the walk is cost without
  // benefit.
  if (full.length > MAX_STRUCTURED_TRUNCATION_CHARS) return markedSlice(full, details)

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
    if (arrayKey) {
      const rows = obj[arrayKey] as unknown[]
      const render = (kept: unknown[]): string => serializeResult({
        ...obj,
        [arrayKey]: kept,
        __truncated: true,
        __omittedRows: rows.length - kept.length,
        [TRUNCATION_SUMMARY_KEY]: keptSummary(new Map([[arrayKey, { kept: kept.length, total: rows.length }]])),
      })
      const out = render(trimRowsToFit(rows, render))
      // When other lists sit beside the largest one (a summary with rows,
      // rankings and markets), cutting only the largest keeps every other
      // list whole and can leave one or two primary rows. Trimming the nested
      // lists instead may keep more of them; take whichever keeps more rows.
      const otherLists = Object.entries(obj).some(([key, value]) => key !== arrayKey && Array.isArray(value) && value.length > 0)
      const nested = otherLists ? trimNestedArrays(full) : undefined
      if (fitsCap(out) && nested !== undefined && keptRows(nested, arrayKey) > keptRows(out, arrayKey)) return nested
      // Falls through to the last resort only when the non-array fields ALONE
      // already blow the cap (nothing structured left to drop).
      if (fitsCap(out)) return out
      if (nested !== undefined) return nested
    }
    const nested = trimNestedArrays(full)
    if (nested !== undefined) return nested
  }

  return markedSlice(full, details)
}

/** Rows of `key` that survived in a serialized truncation result. */
function keptRows(serialized: string, key: string): number {
  try {
    const parsed = JSON.parse(serialized) as Record<string, unknown>
    return Array.isArray(parsed[key]) ? (parsed[key] as unknown[]).length : 0
  } catch {
    return 0
  }
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
