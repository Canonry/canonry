/**
 * Deterministic rule checks on one Aero turn. Each check is small, runs on
 * the captured trace and answer alone (plus the ground truth), and targets a
 * failure mode seen in real Aero answers: errored tool calls, turns that hit a
 * limit, complete-looking lists built from truncated results, numbers nothing
 * supports, and label mix-ups (answers vs questions, named vs cited, pooled
 * query classes). Label checks are heuristics and only ever warn.
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
} as const

export function runChecks(capture: TurnCapture, truth: GroundTruth): CheckResult[] {
  return [
    checkToolErrors(capture),
    checkTurnStatus(capture),
    checkTruncatedLists(capture),
    checkNumericGrounding(capture, truth),
    checkDenominatorLabel(capture),
    checkNamedVsCited(capture, truth),
    checkPooledClasses(capture, truth),
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

export function checkToolErrors(capture: TurnCapture): CheckResult {
  const errored = capture.tools
    .map((tool, index) => ({ tool, index }))
    .filter(({ tool }) => tool.isError || looksLikeToolError(toolText(tool)))
  const blocked = errored.filter(({ tool }) => isHarnessBlocked(toolText(tool)))
  const failed = errored.filter(({ tool }) => !isHarnessBlocked(toolText(tool)))
  const blockedNote = blocked.length > 0
    ? `the eval harness refused ${blocked.length} call(s) (${[...new Set(blocked.map(({ tool }) => tool.name))].join(', ')})`
    : ''
  if (failed.length === 0) {
    if (blocked.length > 0) return { id: CHECK_IDS.toolErrors, outcome: 'warn', detail: `${blockedNote}; no other tool call errored` }
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
    detail: `${failed.length} of ${capture.tools.length} tool call(s) errored: ${listed}${more}${blockedNote ? `; also ${blockedNote}` : ''}`,
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
  /\b(?:the )?(?:full|complete|entire) (?:list|set|ranking|breakdown)\b|\ball \d[\d,]*\b|\bevery (?:one|property|location|item|market)\b/i

export function checkTruncatedLists(capture: TurnCapture): CheckResult {
  const truncated = capture.tools.filter((tool) => tool.truncated)
  if (truncated.length === 0) {
    return { id: CHECK_IDS.truncatedList, outcome: 'pass', detail: 'no truncated tool results' }
  }
  const names = [...new Set(truncated.map((tool) => tool.name))].join(', ')
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
  const completeClaim = CLAIMS_COMPLETE.exec(capture.answer)
  if (completeClaim && !acknowledged) {
    return {
      id: CHECK_IDS.truncatedList,
      outcome: 'warn',
      detail: `the answer claims completeness ("${completeClaim[0]}") after truncated result(s) from ${names}; ${ackNote}`,
    }
  }
  return {
    id: CHECK_IDS.truncatedList,
    outcome: 'pass',
    detail: `truncated result(s) from ${names}; the answer enumerates ${enumerated} item(s) and ${ackNote}`,
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

/** Numbers in the answer worth grounding, with years, ordinals and small prose integers left out. */
export function extractAnswerNumbers(answer: string): AnswerNumber[] {
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
    if (!percent && isInteger && value <= 3) continue // small integers in prose
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
  ]
  const sources = texts.map(extractEvidenceNumbers)
  // Percentages the answer derives from its own (separately grounded) figures.
  const own = [...new Set(numbers.filter((num) => !num.percent).map((num) => num.value))].sort((a, b) => a - b)
  const ungrounded = numbers.filter((num) => !valueGrounded(num, num.percent ? [...sources, own] : sources))
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

export function checkNamedVsCited(capture: TurnCapture, truth: GroundTruth): CheckResult {
  const phrase = CITED_INSTEAD.map((pattern) => pattern.exec(capture.answer)).find((match) => match !== null)
  if (!phrase) {
    return { id: CHECK_IDS.namedVsCited, outcome: 'pass', detail: 'no "cited instead" framing' }
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
  if (RATE_CLAIM.test(capture.answer) && !MENTIONS_CLASS.test(capture.answer) && !MENTIONS_CLASS.test(capture.prompt)) {
    return {
      id: CHECK_IDS.pooledClasses,
      outcome: 'warn',
      detail: 'reports visibility rates without saying whether they are branded or non-brand',
    }
  }
  return { id: CHECK_IDS.pooledClasses, outcome: 'pass', detail: 'query classes kept apart' }
}
