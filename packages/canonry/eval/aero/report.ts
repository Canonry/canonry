/**
 * Aggregates graded turns into per-question pass rates and renders a short
 * Markdown report: a table of questions, the top failure modes, then the
 * evidence behind each failing turn.
 */
import type {
  CheckResult,
  EvalReport,
  GradedTurn,
  GraderVerdict,
  ProjectKind,
  QuestionSummary,
} from './types.js'

/**
 * A turn passes when no check failed and the grader passed it. With no
 * verdict (grading skipped or it errored), the checks alone decide.
 */
export function turnPasses(checks: readonly CheckResult[], verdict: GraderVerdict | null): boolean {
  if (checks.some((check) => check.outcome === 'fail')) return false
  return verdict === null ? true : verdict.pass
}

export interface BuildReportInput {
  project: string
  projectKind: ProjectKind
  startedAt: string
  finishedAt: string
  canonryVersion: string
  aeroModel: string
  graderModel: string
  attemptsPerQuestion: number
  turns: GradedTurn[]
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1
}

/** Sum of the known costs; null when none is known. */
function sumKnown(values: ReadonlyArray<number | null | undefined>): number | null {
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return known.length === 0 ? null : known.reduce((total, value) => total + value, 0)
}

export function summarizeQuestions(turns: readonly GradedTurn[]): QuestionSummary[] {
  const groups = new Map<string, QuestionSummary>()
  for (const turn of turns) {
    const key = `${turn.capture.questionId}\u0000${turn.capture.lane}`
    let summary = groups.get(key)
    if (!summary) {
      summary = {
        questionId: turn.capture.questionId,
        lane: turn.capture.lane,
        attempts: 0,
        passes: 0,
        passRate: 0,
        failingChecks: {},
        failingCriteria: {},
      }
      groups.set(key, summary)
    }
    summary.attempts++
    if (turn.pass) summary.passes++
    for (const check of turn.checks) if (check.outcome === 'fail') increment(summary.failingChecks, check.id)
    for (const criterion of turn.verdict?.criteria ?? []) if (!criterion.pass) increment(summary.failingCriteria, criterion.id)
  }
  for (const summary of groups.values()) summary.passRate = summary.attempts === 0 ? 0 : summary.passes / summary.attempts
  return [...groups.values()]
}

export function buildReport(input: BuildReportInput): EvalReport {
  const { turns } = input
  const passes = turns.filter((turn) => turn.pass).length
  return {
    project: input.project,
    projectKind: input.projectKind,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    canonryVersion: input.canonryVersion,
    aeroModel: input.aeroModel,
    graderModel: input.graderModel,
    attemptsPerQuestion: input.attemptsPerQuestion,
    turns,
    summary: summarizeQuestions(turns),
    overallPassRate: turns.length === 0 ? 0 : passes / turns.length,
    costUsd: {
      aero: sumKnown(turns.map((turn) => turn.capture.costUsd)),
      grader: sumKnown(turns.map((turn) => turn.verdict?.costUsd)),
    },
  }
}

// ---------------------------------------------------------------------------
// Markdown

export interface FailureMode {
  /** "check tool-errors", "criterion grounded", "warn truncated-list", "criterion q-id:q1". */
  key: string
  kind: 'check' | 'criterion' | 'warn'
  /** Turns showing this failure. */
  turns: number
  /** Distinct "question (lane)" labels, in first-seen order. */
  where: string[]
}

/** Question-specific criteria (q1, q2) mean different things per question, so key them by question. */
function criterionKey(questionId: string, criterionId: string): string {
  return /^q\d+$/.test(criterionId) ? `${questionId}:${criterionId}` : criterionId
}

export function failureModes(turns: readonly GradedTurn[]): FailureMode[] {
  const modes = new Map<string, FailureMode>()
  const add = (kind: FailureMode['kind'], id: string, where: string) => {
    const key = `${kind} ${id}`
    let mode = modes.get(key)
    if (!mode) {
      mode = { key, kind, turns: 0, where: [] }
      modes.set(key, mode)
    }
    mode.turns++
    if (!mode.where.includes(where)) mode.where.push(where)
  }
  for (const turn of turns) {
    const where = `${turn.capture.questionId} (${turn.capture.lane})`
    const seen = new Set<string>()
    const once = (kind: FailureMode['kind'], id: string) => {
      if (seen.has(`${kind} ${id}`)) return
      seen.add(`${kind} ${id}`)
      add(kind, id, where)
    }
    for (const check of turn.checks) {
      if (check.outcome === 'fail') once('check', check.id)
      else if (check.outcome === 'warn') once('warn', check.id)
    }
    for (const criterion of turn.verdict?.criteria ?? []) {
      if (!criterion.pass) once('criterion', criterionKey(turn.capture.questionId, criterion.id))
    }
  }
  const rank = { check: 0, criterion: 0, warn: 1 } as const
  return [...modes.values()].sort((a, b) => rank[a.kind] - rank[b.kind] || b.turns - a.turns || a.key.localeCompare(b.key))
}

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`
}

function dollars(value: number | null): string {
  if (value === null) return 'unknown'
  return value < 0.01 && value > 0 ? '<$0.01' : `$${value.toFixed(2)}`
}

/** One line of text safe inside a Markdown table cell. */
function cell(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()
}

function snippet(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`
}

function topCounts(counts: Record<string, number>, limit: number): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (entries.length === 0) return '-'
  const shown = entries.slice(0, limit).map(([id, count]) => `${id} x${count}`)
  return shown.join(', ') + (entries.length > limit ? `, +${entries.length - limit} more` : '')
}

export interface RenderOptions {
  /** Most failure modes listed (default 8). */
  maxModes?: number
  /** Most failing turns given an evidence section (default 25). */
  maxEvidenceTurns?: number
  /** Characters kept per evidence line (default 280). */
  snippetChars?: number
}

export function renderMarkdown(report: EvalReport, opts: RenderOptions = {}): string {
  const maxModes = opts.maxModes ?? 8
  const maxEvidenceTurns = opts.maxEvidenceTurns ?? 25
  const snippetChars = opts.snippetChars ?? 280
  const passed = report.turns.filter((turn) => turn.pass).length
  const graded = report.turns.filter((turn) => turn.verdict !== null).length
  const out: string[] = []

  out.push(`# Aero eval: ${report.project} (${report.projectKind})`)
  out.push('')
  out.push(
    `Canonry ${report.canonryVersion}, Aero model ${report.aeroModel}, grader ${report.graderModel}, ` +
      `${report.attemptsPerQuestion} attempt(s) per question, ${report.startedAt} to ${report.finishedAt}.`,
  )
  out.push('')
  out.push(
    `**Overall: ${passed} of ${report.turns.length} turns passed (${percent(report.overallPassRate)}).** ` +
      `Graded by Claude: ${graded} of ${report.turns.length}. ` +
      `Cost: Aero ${dollars(report.costUsd.aero)}, grader ${dollars(report.costUsd.grader)}.`,
  )
  out.push('')

  out.push('| Question | Lane | Passed | Failing checks | Failing criteria |')
  out.push('|---|---|---|---|---|')
  for (const summary of report.summary) {
    out.push(
      `| ${cell(summary.questionId)} | ${summary.lane} | ${summary.passes}/${summary.attempts} (${percent(summary.passRate)}) | ` +
        `${cell(topCounts(summary.failingChecks, 3))} | ${cell(topCounts(summary.failingCriteria, 3))} |`,
    )
  }
  out.push('')

  const modes = failureModes(report.turns)
  out.push('## Top failure modes')
  out.push('')
  if (modes.length === 0) {
    out.push('None.')
  } else {
    modes.slice(0, maxModes).forEach((mode, index) => {
      const where = mode.where.slice(0, 4).join(', ') + (mode.where.length > 4 ? `, +${mode.where.length - 4} more` : '')
      out.push(`${index + 1}. ${mode.key}: ${mode.turns} turn(s), in ${where}`)
    })
    if (modes.length > maxModes) out.push(`\n${modes.length - maxModes} more failure mode(s) not shown.`)
  }
  out.push('')

  const failing = report.turns.filter((turn) => !turn.pass)
  out.push('## Evidence')
  out.push('')
  if (failing.length === 0) out.push('No failing turns.')
  for (const turn of failing.slice(0, maxEvidenceTurns)) {
    out.push(...renderTurnEvidence(turn, snippetChars))
    out.push('')
  }
  if (failing.length > maxEvidenceTurns) out.push(`${failing.length - maxEvidenceTurns} more failing turn(s) not shown.`)
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function renderTurnEvidence(turn: GradedTurn, snippetChars: number): string[] {
  const { capture, verdict } = turn
  const lines = [`### ${capture.questionId} (${capture.lane}), attempt ${capture.attempt}`, '']
  const status = capture.status === 'completed' ? '' : `, status ${capture.status}`
  const score = verdict ? `, grader score ${verdict.score.toFixed(2)}` : ', not graded'
  lines.push(`${capture.toolCalls} tool call(s)${status}${score}.`)
  for (const check of turn.checks) {
    if (check.outcome !== 'pass') lines.push(`- check ${check.id} (${check.outcome}): ${snippet(check.detail, snippetChars)}`)
  }
  for (const criterion of verdict?.criteria ?? []) {
    if (!criterion.pass) lines.push(`- criterion ${criterion.id}: ${snippet(criterion.reason, snippetChars)}`)
  }
  for (const claim of (verdict?.unsupportedClaims ?? []).slice(0, 3)) lines.push(`- unsupported: "${snippet(claim, snippetChars)}"`)
  const extra = (verdict?.unsupportedClaims.length ?? 0) - 3
  if (extra > 0) lines.push(`- ${extra} more unsupported claim(s)`)
  if (capture.answer.trim()) lines.push('', `> ${snippet(capture.answer, snippetChars)}`)
  return lines
}
