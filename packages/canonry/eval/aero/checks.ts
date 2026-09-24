/**
 * Deterministic rule checks on one Aero turn. Each check is small, runs on
 * the captured trace and answer alone (plus the ground truth), and targets a
 * failure mode seen in real Aero answers: errored tool calls, turns that hit a
 * limit, complete-looking lists built from truncated results, numbers nothing
 * supports, label mix-ups (answers vs questions, named vs cited, pooled
 * query classes), and a net figure that contradicts its own parts. Label and
 * arithmetic checks are heuristics and only ever warn.
 */
import type { CheckResult, GroundTruth, ToolCallTrace, TurnCapture } from './types.js'

export const CHECK_IDS = {
  toolErrors: 'tool-errors',
  turnStatus: 'turn-status',
  truncatedList: 'truncated-list',
  numericGrounding: 'numeric-grounding',
  denominatorLabel: 'label-denominator',
  namedVsCited: 'label-named-vs-cited',
  pooledClasses: 'label-pooled-classes',
  netArithmetic: 'arithmetic-net',
} as const

export function runChecks(capture: TurnCapture, truth: GroundTruth): CheckResult[] {
  return [
    checkToolErrors(capture),
    checkTurnStatus(capture),
    checkTruncatedLists(capture, truth),
    checkNumericGrounding(capture, truth),
    checkDenominatorLabel(capture),
    checkNamedVsCited(capture, truth),
    checkPooledClasses(capture, truth),
    checkNetArithmetic(capture),
  ]
}

// ---------------------------------------------------------------------------
// Shared helpers

/** The result text we have for a call: the full text when captured, else the preview. */
export function toolText(tool: ToolCallTrace): string {
  return tool.resultText ?? tool.resultPreview
}

/** True when some tool result is longer than the text we have for it. */
function evidenceIsPartial(tools: readonly ToolCallTrace[]): boolean {
  return tools.some((tool) => tool.resultText === undefined && tool.resultChars > tool.resultPreview.length)
}

function safeJson(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`
}

// ---------------------------------------------------------------------------
// 1. Tool errors

const TOOL_ERROR_PATTERNS: readonly RegExp[] = [
  /^Tool \S+ not found\b/i,
  /\bis not loaded yet\b/i,
  /\bis not available in this conversation\b/i,
  /^\S+ is not a tool\b/i,
  /\bnot found\b/i,
  /\bnot loaded\b/i,
  /\bnot available\b/i,
  /\bunknown tool\b/i,
  /^error\b/i,
  /^failed\b/i,
  /\b(forbidden|unauthori[sz]ed)\b/i,
  /\btimed out\b/i,
]

/**
 * Whether a result text reads as an error. JSON results only count when the
 * top-level object is an error envelope, so a data row that happens to say
 * "not found" is not mistaken for a failed call.
 */
export function looksLikeToolError(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return /^\{\s*"errors?"\s*:/.test(trimmed) || /^\{\s*"ok"\s*:\s*false\b/.test(trimmed)
  }
  const head = trimmed.slice(0, 300)
  return TOOL_ERROR_PATTERNS.some((pattern) => pattern.test(head))
}

/**
 * The eval's request guard (target.ts, EVAL_BLOCKED_MESSAGE) refuses writes
 * and live provider reads with this code and message. A refused call is the
 * harness's doing, not Aero's, so it warns instead of failing the turn.
 */
const HARNESS_BLOCKED = /\bEVAL_BLOCKED\b|Blocked by the Aero eval harness/

export function isHarnessBlocked(text: string): boolean {
  return HARNESS_BLOCKED.test(text)
}

/**
 * The runtime's answer to a tool name it does not know: pi's bare "Tool X not
 * found", or the rewrites `src/agent/runtime.ts` makes of it ("X is not
 * available in this conversation", or "X is not a tool. Did you mean Y?" when
 * the name is close to one the turn may use).
 */
const UNKNOWN_TOOL = /^(?:Tool (\S+) not found\b|(\S+) is not available in this conversation\b|(\S+) is not a tool\b)/i

/** The tool name an unknown-tool error names, or null for any other text. */
export function unknownToolName(text: string): string | null {
  const match = UNKNOWN_TOOL.exec(text.trim())
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null
}

/** "Did you mean X?" or "Did you mean one of: X, Y?" in the runtime's unknown-tool reply. */
const DID_YOU_MEAN = /\bDid you mean (?:one of: )?([^?]+)\?/

/**
 * The tool names an unknown-tool reply suggests, or [] when it suggests none.
 * The runtime also matches on the part after the prefix (`canonry_`, `aero_`),
 * so a suggestion can be further from the typo than TYPO_DISTANCE.
 */
export function suggestedToolNames(text: string): string[] {
  if (unknownToolName(text) === null) return []
  const match = DID_YOU_MEAN.exec(text)
  if (!match) return []
  return match[1]!.split(',').map((name) => name.trim()).filter((name) => /^\S+$/.test(name))
}

/** Edit distance counting an adjacent transposition as one edit (canrony -> canonry). */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1)
    }
  }
  return d[a.length]![b.length]!
}

/**
 * A misspelled tool name counts as recovered when a later call returned data
 * from a tool within this many edits of it, or from a tool the runtime's reply
 * suggested.
 */
const TYPO_DISTANCE = 2

export function checkToolErrors(capture: TurnCapture): CheckResult {
  const isErrored = (tool: ToolCallTrace) => tool.isError || looksLikeToolError(toolText(tool))
  const errored = capture.tools
    .map((tool, index) => ({ tool, index }))
    .filter(({ tool }) => isErrored(tool))
  const blocked = errored.filter(({ tool }) => isHarnessBlocked(toolText(tool)))
  // A misspelled tool name the model corrected later in the same turn cost a
  // call, not the answer: the grader judges what the answer did with the data.
  const recovered: Array<{ index: number; from: string; to: string }> = []
  const failed = errored.filter(({ tool, index }) => {
    if (isHarnessBlocked(toolText(tool))) return false
    const name = unknownToolName(toolText(tool))
    if (name === null) return true
    const suggested = suggestedToolNames(toolText(tool))
    const fix = capture.tools
      .slice(index + 1)
      .find((later) => !isErrored(later) && (suggested.includes(later.name) || editDistance(later.name, name) <= TYPO_DISTANCE))
    if (!fix) return true
    recovered.push({ index, from: name, to: fix.name })
    return false
  })
  const notes: string[] = []
  if (blocked.length > 0) {
    notes.push(`the eval harness refused ${blocked.length} call(s) (${[...new Set(blocked.map(({ tool }) => tool.name))].join(', ')})`)
  }
  if (recovered.length > 0) {
    const pairs = [...new Set(recovered.map(({ from, to }) => `${from} -> ${to}`))].slice(0, 5).join(', ')
    notes.push(`${recovered.length} misspelled tool name(s) recovered later in the turn (${pairs})`)
  }
  if (failed.length === 0) {
    if (notes.length > 0) return { id: CHECK_IDS.toolErrors, outcome: 'warn', detail: `${notes.join('; ')}; no other tool call errored` }
    return { id: CHECK_IDS.toolErrors, outcome: 'pass', detail: `${capture.tools.length} tool call(s), none errored` }
  }
  const listed = failed
    .slice(0, 5)
    .map(({ tool, index }) => `#${index + 1} ${tool.name}: ${clip(toolText(tool), 120)}`)
    .join('; ')
  const more = failed.length > 5 ? ` (+${failed.length - 5} more)` : ''
  return {
    id: CHECK_IDS.toolErrors,
    outcome: 'fail',
    detail: `${failed.length} of ${capture.tools.length} tool call(s) errored: ${listed}${more}${notes.length > 0 ? `; also ${notes.join('; ')}` : ''}`,
  }
}

// ---------------------------------------------------------------------------
// 2. Turn status

const STATUS_REASONS: Record<string, string> = {
  'tool-limit': 'the turn hit the tool-call limit',
  'time-limit': 'the turn hit the time limit',
  error: 'the turn ended in an error',
  stopped: 'the turn was stopped before it finished',
}

export function checkTurnStatus(capture: TurnCapture): CheckResult {
  if (capture.error) {
    return { id: CHECK_IDS.turnStatus, outcome: 'fail', detail: `stream error (status ${capture.status}): ${clip(capture.error, 200)}` }
  }
  if (capture.status !== 'completed') {
    const reason = STATUS_REASONS[capture.status] ?? `status is "${capture.status}", not completed`
    return { id: CHECK_IDS.turnStatus, outcome: 'fail', detail: reason }
  }
  if (capture.answer.trim().length === 0) {
    return { id: CHECK_IDS.turnStatus, outcome: 'fail', detail: 'completed with an empty answer' }
  }
  return { id: CHECK_IDS.turnStatus, outcome: 'pass', detail: 'completed' }
}

// ---------------------------------------------------------------------------
// 3. Complete lists from truncated results

/** A Markdown table separator row: only pipes, dashes, colons and spaces. */
function isTableSeparator(line: string): boolean {
  return /^[\s|:-]+$/.test(line) && line.includes('|') && line.includes('--')
}
const BULLET = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+\S/

/**
 * How many items the answer enumerates: bullet and numbered lines, table data
 * rows (header and separator rows excluded), and long inline lists after a
 * colon ("Zero coverage: A, B, C, D and E").
 */
export function countEnumeratedItems(answer: string): number {
  const lines = answer.split('\n')
  let count = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim().startsWith('|')) {
      if (isTableSeparator(line)) continue
      const next = lines[i + 1]
      if (next !== undefined && isTableSeparator(next)) continue // header row
      count++
      continue
    }
    if (BULLET.test(line)) {
      count++
      continue
    }
    const colon = line.indexOf(':')
    if (colon >= 0) {
      const items = line
        .slice(colon + 1)
        .split(/,\s*|\s+and\s+/)
        .map((item) => item.trim().replace(/[.;]$/, ''))
        .filter((item) => item.length > 0 && item.split(/\s+/).length <= 6)
      if (items.length >= 5) count += items.length
    }
  }
  return count
}

/**
 * Largest non-zero "<kept> of <total>" row count a truncation note reports.
 * "<n> of <m> keys" entries count an object's fields, not rows, and are skipped.
 */
export function keptRowCeiling(tool: ToolCallTrace): number | undefined {
  const sources = [tool.truncationNote ?? '']
  const text = toolText(tool)
  // The structured field (`"__truncation": {...}`) or the slice's `__truncation:` line.
  const at = text.indexOf('__truncation')
  if (at >= 0) sources.push(text.slice(at, at + 4_000))
  let ceiling: number | undefined
  for (const source of sources) {
    for (const match of source.matchAll(/(\d+) of \d+(?!\d| keys)/g)) {
      const kept = Number(match[1])
      if (kept > 0 && (ceiling === undefined || kept > ceiling)) ceiling = kept
    }
  }
  return ceiling
}

const ACKNOWLEDGES_PARTIAL =
  /\b(?:truncat\w*|partial\w*|cut off|incomplete|only (?:saw|see|had|got|returned|the first)|first \d+ of|not (?:the )?(?:full|complete|entire)|did not (?:see|get|return) (?:all|every|the rest))\b/i
const CLAIMS_COMPLETE =
  /\b(?:the )?(?:full|complete|entire) (?:list|set|ranking|breakdown|picture)\b|\ball \d[\d,]*\b|\bevery (?:one|property|location|item|market)\b/i

/**
 * The array a count field describes: `totalProperties` -> an array whose key
 * contains "properties", `citedDomainsTotal` -> "citeddomains", and a bare
 * `total` or `totalEstimate` -> '' (the object's only array, or `items`).
 */
function totalStem(key: string): string | undefined {
  if (/^total(?:Estimate|Count)?$/.test(key)) return ''
  const leading = /^total([A-Z]\w*)$/.exec(key)
  if (leading) return leading[1]!.toLowerCase()
  const trailing = /^(\w+)Total$/.exec(key)
  return trailing ? trailing[1]!.toLowerCase() : undefined
}

/**
 * Truncation the API reported inside its own payload, which the product's
 * result cap never marks: a `truncated` or `*Truncated` flag set to true, or a
 * total larger than the array returned beside it. Only the result object and
 * its direct children are read, so per-row caps (each row's top domains) do
 * not count. Null when the result is not JSON or reports none.
 */
export function apiTruncation(tool: ToolCallTrace): string | null {
  const text = toolText(tool).trim()
  if (!text.startsWith('{')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const found: string[] = []
  const visit = (value: unknown, path: string, depth: number) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const entries = Object.entries(value as Record<string, unknown>).filter(([key]) => !key.startsWith('__'))
    const arrays = entries.filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
    for (const [key, child] of entries) {
      const at = path ? `${path}.${key}` : key
      if (child === true && /^truncated$|Truncated$/.test(key)) {
        found.push(`${at}: true`)
      } else if (typeof child === 'number' && Number.isInteger(child)) {
        const stem = totalStem(key)
        if (stem === undefined) continue
        const sibling = stem === ''
          ? (arrays.length === 1 ? arrays[0] : arrays.find(([name]) => name === 'items'))
          : arrays.find(([name]) => name.toLowerCase().includes(stem))
        if (sibling && sibling[1].length < child) found.push(`${at} ${child} > ${sibling[1].length} ${sibling[0]} returned`)
      }
      if (depth === 0) visit(child, at, 1)
    }
  }
  visit(parsed, '', 0)
  return found.length > 0 ? found.slice(0, 3).join(', ') : null
}

/** JSON count fields: `total`, `totalProperties`, `domainTotal`, `count`, `eligiblePropertyCount`. */
const TOTAL_FIELD = /"(?:total\w*|\w+Total|count|\w+Count)"\s*:\s*(\d+)/g

/**
 * Population sizes the evidence states: count fields in the tool results and
 * the facts, and every number in the system context. "All 40" where 40 is
 * such a total names the population, not a list the answer claims is whole.
 */
function statedTotals(capture: TurnCapture, truth: GroundTruth): Set<number> {
  const totals = new Set<number>()
  for (const text of [...capture.tools.map(toolText), safeJson(truth.facts)]) {
    for (const match of text.matchAll(TOTAL_FIELD)) totals.add(Number(match[1]))
  }
  for (const value of extractEvidenceNumbers(capture.systemContext ?? '')) totals.add(value)
  return totals
}

export function checkTruncatedLists(capture: TurnCapture, truth?: GroundTruth): CheckResult {
  const truncated = capture.tools.filter((tool) => tool.truncated)
  const apiCut = capture.tools.flatMap((tool) => {
    const why = apiTruncation(tool)
    return why ? [{ tool, why }] : []
  })
  if (truncated.length === 0 && apiCut.length === 0) {
    return { id: CHECK_IDS.truncatedList, outcome: 'pass', detail: 'no truncated tool results' }
  }
  const names = [...new Set([...truncated, ...apiCut.map(({ tool }) => tool)].map((tool) => tool.name))].join(', ')
  const apiNote = apiCut.length > 0 ? `; the API returned fewer rows than it has (${apiCut[0]!.why})` : ''
  const acknowledged = ACKNOWLEDGES_PARTIAL.test(capture.answer)
  const ackNote = acknowledged ? 'the answer says the data was partial' : 'the answer does not say the data was partial'
  const enumerated = countEnumeratedItems(capture.answer)
  const ceilings = truncated.map(keptRowCeiling).filter((value): value is number => value !== undefined)
  if (ceilings.length > 0) {
    const kept = Math.max(...ceilings)
    if (enumerated > kept) {
      return {
        id: CHECK_IDS.truncatedList,
        outcome: 'warn',
        detail: `the answer enumerates ${enumerated} items but the truncated result(s) from ${names} kept at most ${kept} rows; ${ackNote}`,
      }
    }
  }
  const totals = statedTotals(capture, truth ?? { builder: 'none', facts: {}, basis: '' })
  const completeClaim = [...capture.answer.matchAll(new RegExp(CLAIMS_COMPLETE.source, 'gi'))].find((match) => {
    const all = /^all (\d[\d,]*)$/i.exec(match[0])
    return !all || !totals.has(Number(all[1]!.replace(/,/g, '')))
  })
  if (completeClaim && !acknowledged) {
    return {
      id: CHECK_IDS.truncatedList,
      outcome: 'warn',
      detail: `the answer claims completeness ("${completeClaim[0]}") after truncated result(s) from ${names}${apiNote}; ${ackNote}`,
    }
  }
  return {
    id: CHECK_IDS.truncatedList,
    outcome: 'pass',
    detail: `truncated result(s) from ${names}${apiNote}; the answer enumerates ${enumerated} item(s) and ${ackNote}`,
  }
}

// ---------------------------------------------------------------------------
// 4. Numeric grounding

export interface AnswerNumber {
  /** The number as written, e.g. "1,212", "26.2%", "$0.42". */
  raw: string
  value: number
  /** Decimal places as written, which sets the rounding tolerance. */
  decimals: number
  /** A percentage or percentage points. */
  percent: boolean
  /** Hedged ("about", "~"): matched within 5%. */
  approx: boolean
}

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?'
const STRIP_PATTERNS: readonly RegExp[] = [
  /```[\s\S]*?```/g, // fenced code
  /`[^`\n]*`/g, // inline code
  /\]\([^)]*\)/g, // markdown link targets
  /\bhttps?:\/\/\S+/gi, // bare URLs
  /\b\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?/g, // ISO dates and timestamps
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, // slash dates
  /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?m\.?)?/gi, // clock times
  /\bv?\d+\.\d+\.\d+(?:[-.][\w.]+)?\b/g, // versions
  new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, 'gi'), // Sept 23, 2026
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}(?:\\s+\\d{4})?\\b`, 'gi'), // 23 September
]

const RANK_HEADER = /^(?:#|no\.?|n|rank|ranking|pos\.?|position|order)$/i

/**
 * Blank out what is not a claim: code, links, dates, times, versions, list
 * ordinals and rank columns. Replaced with spaces so words stay separated.
 */
function stripNonClaims(answer: string): string {
  let text = answer
  for (const pattern of STRIP_PATTERNS) text = text.replace(pattern, (match) => ' '.repeat(match.length))
  const lines = text.split('\n')
  let rankColumns = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!
    line = line.replace(/^(\s*(?:#{1,6}\s*)?)\d{1,3}[.)](?=\s)/, (_match, lead: string) => `${lead}  `)
    if (line.trim().startsWith('|')) {
      const cells = splitRow(line)
      const next = lines[i + 1]
      if (isTableSeparator(line)) {
        lines[i] = line
        continue
      }
      if (next !== undefined && isTableSeparator(next)) {
        rankColumns = new Set(cells.flatMap((cell, index) => (RANK_HEADER.test(cell.trim()) ? [index] : [])))
        lines[i] = line
        continue
      }
      if (rankColumns.size > 0) line = cells.map((cell, index) => (rankColumns.has(index) ? ' ' : cell)).join('|')
    } else {
      rankColumns = new Set()
    }
    lines[i] = line
  }
  return lines.join('\n')
}

function splitRow(line: string): string[] {
  return line.split(/(?<!\\)\|/)
}

const ANSWER_NUMBER = /[$€£]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g
const HEDGE_BEFORE = /(?:~|≈|\babout|\baround|\broughly|\bapproximately|\bapprox\.?|\bnearly|\balmost|\bclose to|\bsome)\s*$/i
const BOUND_BEFORE = /(?:\bover|\bmore than|\bunder|\bless than|\bat least|\bat most|\bup to|\bfewer than|\bbelow|\babove|[<>≤≥])\s*$/i

/**
 * Numbers in the answer worth grounding, with years, ordinals and small prose
 * integers left out. `includeSmallIntegers` keeps 0 to 3, for arithmetic
 * operands ("across 3 engines") that are never grounded themselves.
 */
export function extractAnswerNumbers(answer: string, opts: { includeSmallIntegers?: boolean } = {}): AnswerNumber[] {
  const text = stripNonClaims(answer)
  const found: AnswerNumber[] = []
  for (const match of text.matchAll(ANSWER_NUMBER)) {
    const raw = match[0]
    const start = match.index
    const end = start + raw.length
    const before = text[start - 1] ?? ''
    const beforeTwo = text[start - 2] ?? ''
    // Glued to a word or identifier (B2, v5, 4100N, id-6ab3), or a rank (#3).
    if (/[\p{L}_#]/u.test(before)) continue
    if (before === '.' && /\d/.test(beforeTwo)) continue
    if (before === '-' && /[\p{L}\d]/u.test(beforeTwo) && !/\d/.test(beforeTwo)) continue
    const after = text.slice(end, end + 24)
    let percent = false
    if (/^\s?%/.test(after) || /^\s+(?:percent|per cent|percentage points?|points?|pts?|pp)\b/i.test(after) || /^(?:pts?|pp)\b/i.test(after)) {
      percent = true
    } else if (/^(?:x|×)(?![\p{L}\d])/u.test(after)) {
      // multiplier: "9x", checked as the plain number
    } else if (/^[\p{L}\d_]/u.test(after)) {
      continue // 4100N, 8th, 24h, 10am: a name, an ordinal or a unit we do not check
    }
    const digits = raw.replace(/[$€£,]/g, '')
    const value = Number(digits)
    if (!Number.isFinite(value)) continue
    const decimals = digits.includes('.') ? digits.split('.')[1]!.length : 0
    const isInteger = decimals === 0
    const hasGrouping = raw.includes(',')
    if (!percent && isInteger && !hasGrouping && digits.length === 4 && value >= 1900 && value <= 2100) continue // a year
    if (!percent && isInteger && value <= 3 && !opts.includeSmallIntegers) continue // small integers in prose
    const lead = text.slice(Math.max(0, start - 24), start)
    if (BOUND_BEFORE.test(lead)) continue // "over 1,000" is a bound, not a figure
    found.push({ raw: percent ? `${raw}%` : raw, value, decimals, percent, approx: HEDGE_BEFORE.test(lead) })
  }
  return found
}

/** Every number in a piece of evidence text, as sorted unique values. */
export function extractEvidenceNumbers(text: string): number[] {
  const values = new Set<number>()
  for (const match of text.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)) {
    const raw = match[0]
    if (raw.includes(',')) {
      values.add(Number(raw.replace(/,/g, '')))
      // "[12,345]" in JSON is two numbers, not twelve thousand: keep both readings.
      for (const part of raw.split(',')) values.add(Number(part))
    } else {
      values.add(Number(raw))
    }
  }
  return [...values].filter(Number.isFinite).sort((a, b) => a - b)
}

/** Whether any value in the sorted array falls in [low, high]. */
function anyInRange(sorted: readonly number[], low: number, high: number): boolean {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sorted[mid]! < low) lo = mid + 1
    else hi = mid
  }
  return lo < sorted.length && sorted[lo]! <= high
}

const PERCENT_TOLERANCE = 0.5
const APPROX_TOLERANCE = 0.05
/** Bound on pair search per source, so a huge result cannot stall the check. */
const MAX_DENOMINATORS = 5_000

/** A source's values read as percentages: 0-1 rates scaled up, plus values already in 0-100. */
function percentScale(source: readonly number[]): number[] {
  const scaled = new Set<number>()
  for (const value of source) {
    if (value <= 1) scaled.add(value * 100)
    if (value <= 100) scaled.add(value)
  }
  return [...scaled].sort((a, b) => a - b)
}

/**
 * A percentage stated directly, as a 0-1 rate, as a/b, as a change (a - b) / b,
 * or as a percentage-point gap between two rates, all from one source.
 */
function percentGrounded(pct: number, sources: readonly number[][]): boolean {
  const low = pct - PERCENT_TOLERANCE
  const high = pct + PERCENT_TOLERANCE
  for (const source of sources) {
    if (anyInRange(source, low, high)) return true
    if (anyInRange(source, low / 100, high / 100)) return true
    let checked = 0
    for (const b of source) {
      if (b <= 0) continue
      if (++checked > MAX_DENOMINATORS) break
      if (anyInRange(source, (low * b) / 100, (high * b) / 100)) return true
      // A change: (a - b) / b, so a = b * (1 + pct/100).
      if (anyInRange(source, b * (1 + low / 100), b * (1 + high / 100))) return true
    }
    const rates = percentScale(source)
    for (const rate of rates.slice(0, MAX_DENOMINATORS)) {
      if (anyInRange(rates, rate + low, rate + high)) return true
    }
  }
  return false
}

function valueGrounded(num: AnswerNumber, sources: readonly number[][]): boolean {
  if (num.percent) return percentGrounded(num.value, sources)
  const step = 0.5 * 10 ** -num.decimals
  const spread = num.approx ? Math.max(step, Math.abs(num.value) * APPROX_TOLERANCE) : step
  // Rounding: 1211.6 supports "1,212"; exact values sit inside the interval too.
  return sources.some((source) => anyInRange(source, num.value - spread, num.value + spread - 1e-12))
}

/** Largest divisor a count ratio may use, e.g. answers / engines or answers / locations. */
const MAX_RATIO_DIVISOR = 12

/**
 * An integer derived in one step from two integers the answer itself states
 * and grounds: a + b, a - b, or a / b exactly with b a small count (1,200
 * answers over 3 engines is 400 queries). Operands are the answer's own
 * figures, not any number in the evidence: a large tool result holds enough
 * small integers to sum to almost anything, which would ground invented
 * counts. For the same reason 0 to 3 ("2 engines") only ever divide.
 */
function integerDerived(value: number, operands: ReadonlyMap<number, number>): boolean {
  const has = (operand: number, other: number) => (operands.get(operand) ?? 0) > (operand === other ? 1 : 0)
  for (const a of operands.keys()) {
    if (a <= 3 || a === value) continue
    const addend = value - a
    if (addend > 3 && has(addend, a)) return true // a + b
    const subtrahend = a - value
    if (subtrahend > 3 && has(subtrahend, a)) return true // a - b
    const divisor = a / value
    if (Number.isInteger(divisor) && divisor >= 2 && divisor <= MAX_RATIO_DIVISOR && has(divisor, a)) return true // a / b
  }
  return false
}

export interface GroundingResult {
  ungrounded: AnswerNumber[]
  checked: number
  partialEvidence: boolean
}

export function groundAnswerNumbers(capture: TurnCapture, truth: GroundTruth): GroundingResult {
  const numbers = extractAnswerNumbers(capture.answer)
  const texts = [
    ...capture.tools.map((tool) => `${toolText(tool)}\n${tool.truncationNote ?? ''}\n${safeJson(tool.args)}`),
    `${safeJson(truth.facts)}\n${safeJson(truth.placeholders)}\n${truth.basis}`,
    capture.prompt,
    // The project context Aero's system prompt stated (Property and query counts).
    capture.systemContext ?? '',
  ]
  const sources = texts.map(extractEvidenceNumbers)
  // Percentages the answer derives from its own (separately grounded) figures.
  const own = [...new Set(numbers.filter((num) => !num.percent).map((num) => num.value))].sort((a, b) => a - b)
  const direct = numbers.filter((num) => valueGrounded(num, num.percent ? [...sources, own] : sources))
  // Integers derived from the answer's own grounded integers, one operation deep.
  const operands = new Map<number, number>()
  for (const num of extractAnswerNumbers(capture.answer, { includeSmallIntegers: true })) {
    if (num.percent || num.approx || num.decimals > 0) continue
    if (num.value > 3 && !direct.some((grounded) => grounded.raw === num.raw)) continue
    operands.set(num.value, (operands.get(num.value) ?? 0) + 1)
  }
  const ungrounded = numbers.filter((num) => {
    if (direct.includes(num)) return false
    return num.percent || num.approx || num.decimals > 0 || !integerDerived(num.value, operands)
  })
  return { ungrounded, checked: numbers.length, partialEvidence: evidenceIsPartial(capture.tools) }
}

export function checkNumericGrounding(capture: TurnCapture, truth: GroundTruth): CheckResult {
  const { ungrounded, checked, partialEvidence } = groundAnswerNumbers(capture, truth)
  if (ungrounded.length === 0) {
    return { id: CHECK_IDS.numericGrounding, outcome: 'pass', detail: `${checked} number(s) checked, all grounded` }
  }
  const unique = [...new Set(ungrounded.map((num) => num.raw))]
  const listed = unique.slice(0, 12).join(', ') + (unique.length > 12 ? ` (+${unique.length - 12} more)` : '')
  const caveat = partialEvidence
    ? '; some tool results were captured only as previews, so this may be a false alarm'
    : ''
  return {
    id: CHECK_IDS.numericGrounding,
    outcome: partialEvidence ? 'warn' : 'fail',
    detail: `${unique.length} of ${checked} number(s) not found in any tool result or the ground truth: ${listed}${caveat}`,
  }
}

// ---------------------------------------------------------------------------
// 5. Denominator labels: answers, not questions

const QUESTION_WORD = '(?:questions|queries|prompts)'
const DENOMINATOR_AS_QUESTIONS: readonly RegExp[] = [
  new RegExp(`\\b\\d[\\d,]*\\s*/\\s*\\d[\\d,]*\\s+${QUESTION_WORD}\\b`, 'i'), // 4/12 questions
  new RegExp(`\\bout of (?:the |all )?\\d[\\d,]*\\s+${QUESTION_WORD}\\b`, 'i'), // out of 24 questions
  // Denom (questions); "denominator is 24 answers (8 questions x 3 engines)" is fine.
  new RegExp(`\\bdenom\\w*(?:(?!answer)[^\\n|.]){1,25}\\b${QUESTION_WORD}\\b`, 'i'),
  new RegExp(`\\b${QUESTION_WORD}\\s*\\)?(?:(?!answer)[^\\n|.]){0,10}\\bdenom\\w*`, 'i'),
]

/** Keys whose value is an answer count (question x engine), in tool JSON. */
const ANSWER_COUNT_KEY = /"(?:answers|answerCount|answerTotal|totalAnswers|denominator)"\s*:\s*(\d+)/g

export function checkDenominatorLabel(capture: TurnCapture): CheckResult {
  const direct = DENOMINATOR_AS_QUESTIONS.map((pattern) => pattern.exec(capture.answer)).find((match) => match !== null)
  if (direct) {
    return {
      id: CHECK_IDS.denominatorLabel,
      outcome: 'warn',
      detail: `a denominator is labeled as questions ("${clip(direct[0], 60)}"); coverage denominators count answers (questions x engines)`,
    }
  }
  // "5 of 24 questions" where 24 is an answer count in the data.
  const answerCounts = new Set<string>()
  for (const tool of capture.tools) {
    for (const match of toolText(tool).matchAll(ANSWER_COUNT_KEY)) answerCounts.add(match[1]!)
  }
  if (answerCounts.size > 0) {
    for (const match of capture.answer.matchAll(new RegExp(`\\b\\d[\\d,]*\\s+of\\s+(\\d[\\d,]*)\\s+${QUESTION_WORD}\\b`, 'gi'))) {
      if (answerCounts.has(match[1]!.replace(/,/g, ''))) {
        return {
          id: CHECK_IDS.denominatorLabel,
          outcome: 'warn',
          detail: `"${clip(match[0], 60)}": ${match[1]} is an answer count in the tool data, not a question count`,
        }
      }
    }
  }
  return { id: CHECK_IDS.denominatorLabel, outcome: 'pass', detail: 'no denominator labeled as questions' }
}

// ---------------------------------------------------------------------------
// 6. Named instead is not cited instead

const NAMED_INSTEAD_DATA = /recommended_?instead|named_?instead|recommended_?competitors/i
const CITED_INSTEAD: readonly RegExp[] = [
  /\bcited instead\b/i,
  /\bcit(?:ed|es|ing)\b[^.\n|]{1,60}\binstead of (?:you|your|the property|the brand|them)\b/i,
  /\binstead of (?:you|your \w+)\b[^.\n|]{1,40}\bcit(?:ed|es|ing|ations?)\b/i,
]

/** A host name such as listings.example or www.example.com. */
const DOMAIN = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/i

function tableCells(line: string): string[] {
  return splitRow(line.trim()).slice(1, -1)
}

/**
 * Whether a "cited instead" phrase is about domains: it names one itself
 * ("cited listings.example instead of you"), or it heads a list of them (the
 * rest of its line, the table column it heads, or the bullets or table rows
 * right under it). Cited domains are citations, so that framing is correct.
 */
function citedInsteadOverDomains(answer: string, match: RegExpMatchArray): boolean {
  if (DOMAIN.test(match[0])) return true
  const at = match.index ?? 0
  const lines = answer.split('\n')
  let offset = 0
  let row = 0
  while (row < lines.length - 1 && offset + lines[row]!.length < at) offset += lines[row++]!.length + 1
  const line = lines[row]!
  const items: string[] = []
  if (line.trim().startsWith('|')) {
    // A table header: the cells under it in the same column.
    const column = tableCells(line).findIndex((cell) => CITED_INSTEAD.some((pattern) => pattern.test(cell)))
    if (column < 0) return false
    for (const next of lines.slice(row + 1)) {
      if (!next.trim().startsWith('|')) break
      if (!isTableSeparator(next)) items.push(tableCells(next)[column] ?? '')
    }
  } else {
    const rest = line.slice(at - offset + match[0].length).replace(/^[\s:—–*_)-]+/, '').trim()
    if (rest) {
      items.push(...rest.split(/,\s*|;\s*/))
    } else {
      // A heading: the bullets or table data rows below it, after at most one
      // lead-in line ending in a colon ("The engines cited these sites:").
      let leadIn = false
      for (let next = row + 1; next < lines.length && items.length < 12; next++) {
        const text = lines[next]!
        if (!text.trim()) {
          if (items.length > 0) break
          continue
        }
        if (text.trim().startsWith('|')) {
          const following = lines[next + 1]
          if (!isTableSeparator(text) && !(following !== undefined && isTableSeparator(following))) items.push(tableCells(text).join(' '))
        } else if (BULLET.test(text)) {
          items.push(text)
        } else if (items.length === 0 && !leadIn && /:\W*$/.test(text.trim())) {
          leadIn = true
        } else {
          break
        }
      }
    }
  }
  const listed = items.map((item) => item.trim()).filter((item) => item.length > 0)
  return listed.length > 0 && listed.every((item) => DOMAIN.test(item))
}

export function checkNamedVsCited(capture: TurnCapture, truth: GroundTruth): CheckResult {
  const matches = CITED_INSTEAD.flatMap((pattern) => [...capture.answer.matchAll(new RegExp(pattern.source, 'gi'))])
  const phrase = matches.find((match) => !citedInsteadOverDomains(capture.answer, match))
  if (!phrase) {
    return {
      id: CHECK_IDS.namedVsCited,
      outcome: 'pass',
      detail: matches.length > 0 ? '"cited instead" heads only lists of cited domains' : 'no "cited instead" framing',
    }
  }
  const evidence = [...capture.tools.map((tool) => `${tool.name}\n${toolText(tool)}`), safeJson(truth.facts)].join('\n')
  if (!NAMED_INSTEAD_DATA.test(evidence)) {
    return {
      id: CHECK_IDS.namedVsCited,
      outcome: 'pass',
      detail: `"${clip(phrase[0], 60)}" appears, but no named-instead data was seen to contradict it`,
    }
  }
  return {
    id: CHECK_IDS.namedVsCited,
    outcome: 'warn',
    detail: `"${clip(phrase[0], 60)}": the data holds names written in the answer text (named instead), not citations`,
  }
}

// ---------------------------------------------------------------------------
// 7. Branded and non-brand kept apart

const CLASS_SPLIT_IN_TRUTH = /non-?brand|"branded"|query_?class/i
const POOLED_PHRASE =
  /\b(?:across (?:all|both) (?:query )?(?:classes|queries|questions|prompts)|all (?:queries|questions) combined|branded and non-?brand(?:ed)? (?:combined|together|pooled)|combin\w+ (?:branded|brand) and non-?brand\w*|(?<!not |never |n't )pooled|(?<!not |never |n't )blended)\b/i
const MENTIONS_CLASS = /\bnon-?brand(?:ed)?\b|\bunbranded\b|\bbranded\b|\bbrand(?:ed)? (?:queries|questions)\b/i
const RATE_CLAIM =
  /\d+(?:\.\d+)?\s?%[^.\n]{0,60}\b(?:mention\w*|cit\w+|named|visib\w*|coverage)\b|\b(?:mention\w*|cit\w+|named|visib\w*|coverage)\b[^.\n]{1,60}\d+(?:\.\d+)?\s?%/i

export function checkPooledClasses(capture: TurnCapture, truth: GroundTruth): CheckResult {
  const truthText = `${safeJson(truth.facts)}\n${safeJson(truth.placeholders)}`
  if (!CLASS_SPLIT_IN_TRUTH.test(truthText)) {
    return { id: CHECK_IDS.pooledClasses, outcome: 'pass', detail: 'not applicable: the ground truth does not split query classes' }
  }
  const pooled = POOLED_PHRASE.exec(capture.answer)
  if (pooled) {
    return {
      id: CHECK_IDS.pooledClasses,
      outcome: 'warn',
      detail: `pooled phrasing ("${clip(pooled[0], 60)}") while the ground truth separates branded and non-brand`,
    }
  }
  // A question that names its class ("non-brand visibility") scopes the answer too.
  if (MENTIONS_CLASS.test(capture.prompt)) {
    return { id: CHECK_IDS.pooledClasses, outcome: 'pass', detail: 'the question names its query class' }
  }
  if (RATE_CLAIM.test(capture.answer) && !MENTIONS_CLASS.test(capture.answer)) {
    return {
      id: CHECK_IDS.pooledClasses,
      outcome: 'warn',
      detail: 'reports visibility rates without saying whether they are branded or non-brand',
    }
  }
  // The lead figure sets what the reader takes away: a class named further
  // down does not scope a headline rate that never said its class.
  const lead = leadRateBlock(capture.answer)
  if (lead && !MENTIONS_CLASS.test(lead.upTo)) {
    return {
      id: CHECK_IDS.pooledClasses,
      outcome: 'warn',
      detail: `the lead figure ("${clip(lead.rate, 80)}") does not say whether it is branded or non-brand; a class named later does not scope it`,
    }
  }
  return { id: CHECK_IDS.pooledClasses, outcome: 'pass', detail: 'query classes kept apart' }
}

const PERCENT_FIGURE = /\d+(?:\.\d+)?\s?%/
const VISIBILITY_WORD = /\b(?:mention\w*|cit(?:ed|es|ing|ation\w*)|visib\w*|coverage)\b/i

/**
 * The answer's first paragraph that states a visibility rate (a percentage
 * and a visibility word anywhere in it, since "**Mention coverage**: flat.
 * 40.0%" splits them across sentences), with everything before it: earlier
 * paragraphs and headings may set the class for it.
 */
function leadRateBlock(answer: string): { rate: string; upTo: string } | null {
  let seen = ''
  for (const block of answer.split(/\n\s*\n/)) {
    seen += `${block}\n\n`
    const figure = PERCENT_FIGURE.exec(block)
    if (!figure || !VISIBILITY_WORD.test(block)) continue
    const flat = block.replace(/\s+/g, ' ')
    const at = flat.search(PERCENT_FIGURE)
    // Start the quote at a word boundary, up to 50 characters before the figure.
    const from = at <= 50 ? 0 : flat.indexOf(' ', at - 50) + 1
    return { rate: flat.slice(from, at + figure[0].length + 10).trim(), upTo: seen }
  }
  return null
}

// ---------------------------------------------------------------------------
// 8. A net figure that contradicts its own parts

const NOT_A_RATE = String.raw`(?!\s?(?:%|pp\b|pts?\b|points?\b|percent))`
/** A whole count ("40", "1,200") before a word: not the tail of a decimal, not a rate or points. */
const LEAD_COUNT = String.raw`(?<![\d.,])(\d+(?:,\d{3})*)${NOT_A_RATE}`
/** A whole count ending the match: not the head of a decimal, not a rate or points. */
const TAIL_COUNT = String.raw`(\d+(?:,\d{3})*)(?![.,]?\d)${NOT_A_RATE}`
/** "40 gained", "+40 gained citations", "gained 40". */
const GAINED = new RegExp(String.raw`${LEAD_COUNT}\s+(?:\w+\s+)?(?:gained|gains|added)\b|\b(?:gained|gains|added)(?::\s*|\s+)${TAIL_COUNT}`, 'gi')
/** "34 lost", "-34 lost", "lost 34". */
const LOST = new RegExp(String.raw`${LEAD_COUNT}\s+(?:\w+\s+)?(?:lost|losses|dropped|removed)\b|\b(?:lost|losses|dropped|removed)(?::\s*|\s+)${TAIL_COUNT}`, 'gi')
/** "net -6", "net +6 on mention", "net change of 6", "a net loss of 6". */
const NET = new RegExp(String.raw`\bnet\b(?:\s+(change|move|movement|result|effect|shift|gain|increase|loss|decrease|drop))?(?:\s+(?:of|is|was)|\s*[=:])?\s*(?:\(\s*)?([+\-−–]\s?)?${TAIL_COUNT}`, 'gi')

interface CountHit {
  start: number
  end: number
  value: number
}

function countHits(pattern: RegExp, text: string, skip: readonly CountHit[]): CountHit[] {
  return [...text.matchAll(pattern)]
    .map((match) => ({ start: match.index, end: match.index + match[0].length, value: Number((match[1] ?? match[2] ?? '').replace(/,/g, '')) }))
    .filter((hit) => Number.isFinite(hit.value) && !skip.some((net) => hit.start < net.end && net.start < hit.end))
}

/**
 * Warns when a signed net count contradicts the gained and lost counts written
 * beside it ("40 gained, 34 lost, net -6"). Conservative: a net figure is only
 * checked when exactly one gained and one lost count sit in its own clause
 * (after the previous net figure on the line, or else after it), and only
 * counts are read, never rates or points.
 */
export function checkNetArithmetic(capture: TurnCapture): CheckResult {
  let checked = 0
  for (const line of capture.answer.split('\n')) {
    const nets = [...line.matchAll(NET)].map((match) => {
      const word = (match[1] ?? '').toLowerCase()
      const symbol = (match[2] ?? '').trim()
      const sign = /^[-−–]$/.test(symbol) || /^(?:loss|decrease|drop)$/.test(word) ? -1 : symbol === '+' || /^(?:gain|increase)$/.test(word) ? 1 : 0
      return { start: match.index, end: match.index + match[0].length, value: Number(match[3]!.replace(/,/g, '')), sign, raw: match[0].trim() }
    })
    if (nets.length === 0) continue
    const gained = countHits(GAINED, line, nets)
    const lost = countHits(LOST, line, nets)
    for (const [index, net] of nets.entries()) {
      const from = index === 0 ? 0 : nets[index - 1]!.end
      const to = nets[index + 1]?.start ?? line.length
      const within = (low: number, high: number) => (hit: CountHit) => hit.start >= low && hit.end <= high
      let gains = gained.filter(within(from, net.start))
      let losses = lost.filter(within(from, net.start))
      if (gains.length !== 1 || losses.length !== 1) {
        gains = gained.filter(within(net.end, to))
        losses = lost.filter(within(net.end, to))
      }
      if (gains.length !== 1 || losses.length !== 1) continue
      checked++
      const expected = gains[0]!.value - losses[0]!.value
      const stated = net.sign === 0 ? Math.abs(expected) === net.value : net.sign * net.value === expected
      if (!stated) {
        const shown = expected > 0 ? `+${expected}` : String(expected)
        return {
          id: CHECK_IDS.netArithmetic,
          outcome: 'warn',
          detail: `"${clip(net.raw, 40)}" contradicts its parts: ${gains[0]!.value} gained less ${losses[0]!.value} lost is ${shown}`,
        }
      }
    }
  }
  return {
    id: CHECK_IDS.netArithmetic,
    outcome: 'pass',
    detail: checked > 0 ? `${checked} net figure(s) match their gained and lost parts` : 'no net figure with gained and lost parts beside it',
  }
}
