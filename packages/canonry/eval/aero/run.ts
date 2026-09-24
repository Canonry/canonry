/**
 * Aero eval CLI. Asks Aero a question set about one project, on a database
 * COPY served in-process with every background loop off, and grades each
 * answer with deterministic checks plus a Claude grader against ground truth
 * computed from the same copy.
 *
 *   pnpm --filter @canonry/canonry exec tsx eval/aero/run.ts \
 *     --db /tmp/aero-eval/copy.db --source-config-dir ~/.canonry \
 *     --project <name> [--set ~/.canonry-evals/<client>.json] \
 *     [--lanes admin,viewer] [--attempts 3] [--only id,id] \
 *     [--grader-model claude-opus-5] [--no-grader] [--max-cost-usd 20] \
 *     [--out <dir>] [--dry-run]
 *
 * Reports (report.json, report.md) go to --out, default
 * ~/.canonry-evals/reports/<project>-<timestamp>, never inside this
 * repository: they carry the project's data.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { parse as parseYaml } from 'yaml'
import type { CanonryConfig } from '../../src/config.js'
import { runChecks } from './checks.js'
import { DEFAULT_GRADER_MODEL, GraderError, gradeTurn } from './grader.js'
import { buildGroundTruth, type GroundTruthContext } from './ground-truth.js'
import { buildReport, renderMarkdown, turnPasses } from './report.js'
import { createRunner, fillPrompt } from './runner.js'
import { detectProjectKind, startTarget, type EvalTarget } from './target.js'
import type {
  CheckResult,
  EvalLane,
  EvalQuestion,
  EvalQuestionSet,
  GradedTurn,
  GraderVerdict,
  GroundTruth,
  ProjectKind,
} from './types.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../../../..')
const QUESTIONS_DIR = path.join(HERE, 'questions')
const LANES: readonly EvalLane[] = ['admin', 'viewer']
const GRADER_CONCURRENCY = 3

export interface CliOptions {
  db: string
  sourceConfigDir: string
  project: string
  sets: string[]
  lanes: EvalLane[]
  attempts: number
  only: Set<string> | null
  graderModel: string
  grade: boolean
  maxCostUsd: number | null
  out: string | null
  dryRun: boolean
  turnTimeoutMs: number | undefined
}

const USAGE = `Usage: tsx eval/aero/run.ts --db <database copy> --source-config-dir <canonry config dir> --project <name>
  --set <file>            question set JSON (repeatable; default: the generic set for the project kind)
  --lanes admin,viewer    lanes to ask on (default both; viewer needs agent.allowViewers)
  --attempts <n>          attempts per question and lane (default 3)
  --only <id,id>          only these question ids
  --grader-model <model>  Claude model that grades (default ${DEFAULT_GRADER_MODEL})
  --no-grader             deterministic checks only, no Claude grading
  --max-cost-usd <n>      stop starting turns once estimated spend passes this
  --turn-timeout-s <n>    client-side ceiling per turn (default 900)
  --out <dir>             where report.json and report.md go (outside this repository)
  --dry-run               print the plan and ground truth; no model calls`

function fail(message: string): never {
  throw new Error(`${message}\n\n${USAGE}`)
}

function expandHome(p: string): string {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p
}

export function parseCli(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string' },
      'source-config-dir': { type: 'string' },
      'config-dir': { type: 'string' },
      project: { type: 'string' },
      set: { type: 'string', multiple: true },
      lanes: { type: 'string' },
      attempts: { type: 'string' },
      only: { type: 'string' },
      'grader-model': { type: 'string' },
      'no-grader': { type: 'boolean' },
      'max-cost-usd': { type: 'string' },
      'turn-timeout-s': { type: 'string' },
      out: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  })
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    process.exit(0)
  }
  const configDir = values['source-config-dir'] ?? values['config-dir']
  if (!values.db) fail('--db is required.')
  if (!configDir) fail('--source-config-dir is required.')
  if (!values.project) fail('--project is required.')
  const lanes = (values.lanes ?? 'admin,viewer').split(',').map(lane => lane.trim()).filter(Boolean)
  for (const lane of lanes) if (!LANES.includes(lane as EvalLane)) fail(`Unknown lane "${lane}".`)
  const attempts = Number(values.attempts ?? '3')
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20) fail('--attempts must be a whole number from 1 to 20.')
  const maxCost = values['max-cost-usd'] === undefined ? null : Number(values['max-cost-usd'])
  if (maxCost !== null && (!Number.isFinite(maxCost) || maxCost <= 0)) fail('--max-cost-usd must be a positive number.')
  const timeoutS = values['turn-timeout-s'] === undefined ? undefined : Number(values['turn-timeout-s'])
  if (timeoutS !== undefined && (!Number.isFinite(timeoutS) || timeoutS < 10)) fail('--turn-timeout-s must be at least 10.')
  const only = values.only ? new Set(values.only.split(',').map(id => id.trim()).filter(Boolean)) : null
  return {
    db: path.resolve(expandHome(values.db)),
    sourceConfigDir: path.resolve(expandHome(configDir)),
    project: values.project,
    sets: (values.set ?? []).map(set => path.resolve(expandHome(set))),
    lanes: [...new Set(lanes)] as EvalLane[],
    attempts,
    only,
    graderModel: values['grader-model'] ?? DEFAULT_GRADER_MODEL,
    grade: !values['no-grader'],
    maxCostUsd: maxCost,
    out: values.out ? path.resolve(expandHome(values.out)) : null,
    dryRun: values['dry-run'] === true,
    turnTimeoutMs: timeoutS === undefined ? undefined : timeoutS * 1000,
  }
}

// ───────────────────────────── question sets ─────────────────────────────

function validateSet(value: unknown, source: string): EvalQuestionSet {
  const set = value as Partial<EvalQuestionSet> | null
  if (!set || typeof set !== 'object' || typeof set.name !== 'string' || !Array.isArray(set.questions)) {
    throw new Error(`${source}: a question set needs "name" and "questions".`)
  }
  for (const [index, q] of set.questions.entries()) {
    const where = `${source} question ${index + 1}`
    if (!q || typeof q.id !== 'string' || !q.id) throw new Error(`${where}: "id" is required.`)
    if (!Array.isArray(q.kinds) || q.kinds.some(kind => !['advanced', 'simple', 'legacy'].includes(kind))) throw new Error(`${where} (${q.id}): "kinds" must list advanced, simple or legacy.`)
    if (typeof q.prompt !== 'string' || !q.prompt.trim()) throw new Error(`${where} (${q.id}): "prompt" is required.`)
    if (typeof q.truth !== 'string' || !q.truth) throw new Error(`${where} (${q.id}): "truth" is required (use "none" for rubric-only questions).`)
    if (q.lanes !== undefined && (!Array.isArray(q.lanes) || q.lanes.some(lane => !LANES.includes(lane)))) throw new Error(`${where} (${q.id}): "lanes" must list admin or viewer.`)
    if (q.rubric !== undefined && (!Array.isArray(q.rubric) || q.rubric.some(line => typeof line !== 'string'))) throw new Error(`${where} (${q.id}): "rubric" must be a list of strings.`)
  }
  return set as EvalQuestionSet
}

export function loadQuestionSets(files: string[], kind: ProjectKind): { sets: EvalQuestionSet[]; files: string[] } {
  const chosen = files.length > 0
    ? files
    : fs.readdirSync(QUESTIONS_DIR).filter(file => file.endsWith('.json')).sort().map(file => path.join(QUESTIONS_DIR, file))
  const loaded = chosen.map(file => ({ file, set: validateSet(JSON.parse(fs.readFileSync(file, 'utf8')), path.basename(file)) }))
  // The generic sets are chosen by kind; an explicit set is taken whole and filtered per question in planTurns.
  const kept = files.length > 0 ? loaded : loaded.filter(({ set }) => set.questions.some(q => q.kinds.includes(kind)))
  const seen = new Map<string, string>()
  for (const { set } of kept) {
    for (const q of set.questions) {
      const other = seen.get(q.id)
      if (other) throw new Error(`Question id "${q.id}" appears in both ${other} and ${set.name}; ids must be unique across sets.`)
      seen.set(q.id, set.name)
    }
  }
  return { sets: kept.map(({ set }) => set), files: kept.map(({ file }) => file) }
}

export interface PlannedTurn {
  question: EvalQuestion
  lane: EvalLane
  attempt: number
}

/**
 * Attempt-major order: every question gets its first attempt before any gets
 * a second, so a run stopped by the cost cap still covers the whole set.
 */
export function planTurns(sets: EvalQuestionSet[], kind: ProjectKind, lanes: EvalLane[], attempts: number, only: Set<string> | null): PlannedTurn[] {
  const questions = sets.flatMap(set => set.questions).filter(q => q.kinds.includes(kind) && (!only || only.has(q.id)))
  const plan: PlannedTurn[] = []
  for (let attempt = 1; attempt <= attempts; attempt++) {
    for (const question of questions) {
      for (const lane of question.lanes ?? LANES) {
        if (lanes.includes(lane)) plan.push({ question, lane, attempt })
      }
    }
  }
  return plan
}

/** The question as the grader sees it: placeholders filled in the rubric too. */
function filledQuestion(question: EvalQuestion, truth: GroundTruth): EvalQuestion {
  const values = truth.placeholders ?? {}
  return {
    ...question,
    prompt: fillPrompt(question.prompt, values).text,
    ...(question.rubric ? { rubric: question.rubric.map(line => fillPrompt(line, values).text) } : {}),
  }
}

// ───────────────────────────── ground truth ─────────────────────────────

/**
 * One truth per builder, read over HTTP from the served copy. A builder that
 * fails does not stop the run: its questions are graded against a note that
 * the facts are unavailable, and questions needing its placeholders are skipped.
 */
async function buildTruths(builders: string[], ctx: GroundTruthContext, log: (line: string) => void): Promise<Map<string, GroundTruth>> {
  const truths = new Map<string, GroundTruth>()
  for (const builder of builders) {
    try {
      truths.set(builder, await buildGroundTruth(builder, ctx))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`ground truth "${builder}" failed: ${message}`)
      truths.set(builder, { builder, facts: { unavailable: message }, basis: `Ground truth could not be computed: ${message}` })
    }
  }
  return truths
}

// ───────────────────────────── output ─────────────────────────────

function defaultOutDir(project: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z')
  const safe = project.replace(/[^\w-]+/g, '-')
  return path.join(os.homedir(), '.canonry-evals', 'reports', `${safe}-${stamp}`)
}

function assertOutsideRepo(dir: string): void {
  const relative = path.relative(REPO_ROOT, dir)
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    throw new Error(`--out ${dir} is inside the repository. Reports carry project data; write them outside it.`)
  }
}

function writePrivate(file: string, contents: string): void {
  fs.writeFileSync(file, contents, { encoding: 'utf8', mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

function money(value: number | null): string {
  return value === null ? 'unknown' : `$${value.toFixed(value < 1 ? 4 : 2)}`
}

function graderKey(sourceConfigDir: string): { apiKey?: string; source: string } {
  if (process.env.ANTHROPIC_API_KEY) return { apiKey: process.env.ANTHROPIC_API_KEY, source: 'ANTHROPIC_API_KEY' }
  try {
    const raw = parseYaml(fs.readFileSync(path.join(sourceConfigDir, 'config.yaml'), 'utf8')) as CanonryConfig | null
    const key = raw?.providers?.claude?.apiKey
    if (key) return { apiKey: key, source: 'the config\'s claude provider key' }
  } catch {
    // Fall through to the SDK's own credentials.
  }
  return { source: 'the Anthropic SDK default credentials' }
}

// ───────────────────────────── main ─────────────────────────────

interface Prepared {
  target: EvalTarget
  kind: ProjectKind
  files: string[]
  plan: PlannedTurn[]
  truths: Map<string, GroundTruth>
}

/** Serve the copy, learn the project kind, pick the questions, and compute their ground truth. */
async function prepare(opts: CliOptions, log: (line: string) => void): Promise<Prepared> {
  const target = await startTarget({ db: opts.db, sourceConfigDir: opts.sourceConfigDir, project: opts.project, log })
  try {
    for (const note of target.notes) log(note)
    const kind = detectProjectKind(target.db, target.projectId!)
    const { sets, files } = loadQuestionSets(opts.sets, kind)
    let lanes = opts.lanes
    if (lanes.includes('viewer') && !target.laneAvailable('viewer')) {
      log(`viewer lane unavailable: ${target.viewerUnavailableReason}`)
      lanes = lanes.filter(lane => lane !== 'viewer')
    }
    const plan = planTurns(sets, kind, lanes, opts.attempts, opts.only)
    if (plan.length === 0) throw new Error(`No questions apply to this ${kind} project with the chosen sets, lanes and ids.`)
    log(`${opts.project} is ${kind}; sets ${files.map(file => path.basename(file)).join(', ')}; ${plan.length} turns planned`)
    const truths = await buildTruths(
      [...new Set(plan.map(turn => turn.question.truth))],
      { baseUrl: target.baseUrl, headers: target.adminHeaders, project: opts.project, kind },
      log,
    )
    return { target, kind, files, plan, truths }
  } catch (error) {
    await target.close()
    throw error
  }
}

function printPlan(opts: CliOptions, prepared: Prepared): void {
  const { target, kind, files, plan, truths } = prepared
  const questions = [...new Map(plan.map(turn => [turn.question.id, turn.question])).values()]
  const lanesUsed = [...new Set(plan.map(turn => turn.lane))]
  const perAttempt = plan.filter(turn => turn.attempt === 1).length
  const out: string[] = []
  out.push('Aero eval plan (dry run: no model calls)')
  out.push(`  project:   ${opts.project} (${kind})`)
  out.push(`  database:  ${target.dbPath}`)
  out.push(`  sets:      ${files.map(file => path.basename(file)).join(', ')}`)
  out.push(`  lanes:     ${lanesUsed.join(', ')}${opts.lanes.includes('viewer') && !target.laneAvailable('viewer') ? ` (viewer skipped: ${target.viewerUnavailableReason})` : ''}`)
  out.push(`  aero:      ${target.configuredAeroModel} (from the config; a stored conversation row can override it)`)
  out.push(`  turns:     ${questions.length} questions, ${perAttempt} question-lanes x ${opts.attempts} attempts = ${plan.length}`)
  out.push(`  grader:    ${opts.grade ? opts.graderModel : 'off (--no-grader)'}${opts.maxCostUsd !== null ? `; stop starting turns past ${money(opts.maxCostUsd)}` : ''}`)
  out.push('')
  out.push('Questions:')
  for (const question of questions) {
    const truth = truths.get(question.truth)!
    const { text, missing } = fillPrompt(question.prompt, truth.placeholders)
    const lanes = [...new Set(plan.filter(turn => turn.question.id === question.id).map(turn => turn.lane))]
    out.push(`  ${question.id}  [${lanes.join(', ')}]  truth=${question.truth}${missing.length ? `  SKIPPED: no value for {${missing.join('}, {')}}` : ''}`)
    out.push(`    ${text}`)
  }
  out.push('')
  out.push('Ground truth:')
  for (const [builder, truth] of truths) {
    out.push(`  ${builder}: ${truth.basis}`)
    if (truth.placeholders && Object.keys(truth.placeholders).length > 0) out.push(`    placeholders: ${JSON.stringify(truth.placeholders)}`)
    out.push(JSON.stringify(truth.facts, null, 2).split('\n').map(line => `    ${line}`).join('\n'))
  }
  process.stdout.write(`${out.join('\n')}\n`)
}

/** Set by the signal handler: `stopping` ends the turn loop after the current turn. */
interface RunState {
  phase: 'setup' | 'turns'
  stopping: boolean
}

async function runTurns(opts: CliOptions, prepared: Prepared, log: (line: string) => void, outDir: string, startedAt: string, state: RunState): Promise<void> {
  const { target, kind, plan, truths } = prepared
  const grader = opts.grade ? graderKey(opts.sourceConfigDir) : null
  if (grader) log(`grader ${opts.graderModel} uses ${grader.source}`)
  if (opts.maxCostUsd !== null) log(`cost cap ${money(opts.maxCostUsd)}; turns whose cost is unknown count as $0 toward it`)

  const runner = createRunner(target, { project: opts.project, timeoutMs: opts.turnTimeoutMs })
  const graded: GradedTurn[] = []
  const pendingGrades = new Set<Promise<void>>()
  let spend = 0
  let unknownCosts = 0
  let skippedForCost = 0
  const skippedForPlaceholders = new Set<string>()

  const grade = async (slot: number, turn: GradedTurn, question: EvalQuestion) => {
    let verdict: GraderVerdict | null = null
    const extra: CheckResult[] = []
    try {
      verdict = await gradeTurn(turn.capture, turn.truth, question, { model: opts.graderModel, apiKey: grader?.apiKey })
      spend += verdict.costUsd ?? 0
    } catch (error) {
      spend += error instanceof GraderError ? error.costUsd ?? 0 : 0
      // Grading was asked for and produced no verdict: the turn is unverified,
      // so it must not pass on the rule checks alone.
      extra.push({ id: 'grader-error', outcome: 'fail', detail: `not graded: ${error instanceof Error ? error.message : String(error)}` })
    }
    const checks = [...turn.checks, ...extra]
    graded[slot] = { ...turn, checks, verdict, pass: turnPasses(checks, verdict) }
  }

  for (const [index, planned] of plan.entries()) {
    if (state.stopping) break
    if (opts.maxCostUsd !== null && spend >= opts.maxCostUsd) {
      skippedForCost = plan.length - index
      log(`estimated spend ${money(spend)} passed the cap; not starting the remaining ${skippedForCost} turns`)
      break
    }
    const truth = truths.get(planned.question.truth)!
    const { text, missing } = fillPrompt(planned.question.prompt, truth.placeholders)
    if (missing.length > 0) {
      if (!skippedForPlaceholders.has(planned.question.id)) log(`skipping ${planned.question.id}: ground truth gave no value for {${missing.join('}, {')}}`)
      skippedForPlaceholders.add(planned.question.id)
      continue
    }
    const capture = await runner.ask({ questionId: planned.question.id, prompt: text, lane: planned.lane, attempt: planned.attempt })
    if (capture.costUsd === null) unknownCosts++
    spend += capture.costUsd ?? 0
    const checks = runChecks(capture, truth)
    const slot = graded.length
    const turn: GradedTurn = { capture, truth, checks, verdict: null, pass: turnPasses(checks, null) }
    graded.push(turn)
    const failing = checks.filter(check => check.outcome === 'fail').map(check => check.id)
    log(`[${index + 1}/${plan.length}] ${planned.question.id} ${planned.lane} #${planned.attempt}: ${capture.status}, ${capture.toolCalls} tools${capture.tools.some(tool => tool.truncated) ? ' (truncated results)' : ''}, ${(capture.durationMs / 1000).toFixed(1)}s, ${money(capture.costUsd)}${failing.length ? `, failed ${failing.join(', ')}` : ''}${capture.error ? `, error: ${capture.error.slice(0, 160)}` : ''}`)
    if (grader) {
      const job: Promise<void> = grade(slot, turn, filledQuestion(planned.question, truth)).finally(() => pendingGrades.delete(job))
      pendingGrades.add(job)
      if (pendingGrades.size >= GRADER_CONCURRENCY) await Promise.race(pendingGrades)
    }
  }
  if (pendingGrades.size > 0) log(`waiting for ${pendingGrades.size} grading(s)`)
  await Promise.all(pendingGrades)

  const { PACKAGE_VERSION } = await import('../../src/package-version.js')
  const report = buildReport({
    project: opts.project,
    projectKind: kind,
    startedAt,
    finishedAt: new Date().toISOString(),
    canonryVersion: PACKAGE_VERSION,
    aeroModel: runner.modelsSeen.size > 0 ? [...runner.modelsSeen].join(', ') : target.configuredAeroModel,
    graderModel: opts.grade ? opts.graderModel : 'none (--no-grader)',
    attemptsPerQuestion: opts.attempts,
    turns: graded,
  })
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 })
  writePrivate(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writePrivate(path.join(outDir, 'report.md'), renderMarkdown(report))

  const passed = graded.filter(turn => turn.pass).length
  log(`done: ${passed}/${graded.length} turns passed; Aero ${money(report.costUsd.aero)}, grader ${money(report.costUsd.grader)} (estimated total spend ${money(spend)}, failed gradings included)`)
  if (unknownCosts > 0) log(`${unknownCosts} turn(s) had no priced usage rows; their Aero cost is unknown`)
  if (skippedForCost > 0) log(`${skippedForCost} turn(s) not run because of --max-cost-usd`)
  if (state.stopping) log('stopped early by interrupt; the report is partial')
  if (target.blocked.length > 0) {
    const counts = new Map<string, number>()
    for (const entry of target.blocked) counts.set(`${entry.method} ${entry.path}`, (counts.get(`${entry.method} ${entry.path}`) ?? 0) + 1)
    log(`the guard refused ${target.blocked.length} request(s): ${[...counts].map(([key, count]) => `${key} x${count}`).join('; ')}`)
  }
  log(`report: ${path.join(outDir, 'report.md')}`)
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const log = (line: string) => process.stderr.write(`[aero-eval] ${line}\n`)
  const opts = parseCli(argv)
  const outDir = opts.out ?? defaultOutDir(opts.project)
  if (!opts.dryRun) assertOutsideRepo(outDir)
  const startedAt = new Date().toISOString()
  // During setup an interrupt exits at once (the target removes its temp
  // config on exit); during turns the first one finishes the current turn and
  // writes a partial report, and a second exits at once.
  const state: RunState = { phase: 'setup', stopping: false }
  const onSignal = () => {
    if (state.phase === 'setup' || state.stopping) {
      log('interrupted: exiting now')
      process.exit(130)
    }
    state.stopping = true
    log('interrupt: finishing the current turn, then writing a partial report (press again to exit now)')
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  try {
    const prepared = await prepare(opts, log)
    try {
      state.phase = 'turns'
      if (opts.dryRun) printPlan(opts, prepared)
      else await runTurns(opts, prepared, log, outDir, startedAt, state)
    } finally {
      await prepared.target.close()
    }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(`[aero-eval] ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
}
