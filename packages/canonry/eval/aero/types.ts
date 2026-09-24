/**
 * Shared contract for the Aero eval. The eval asks the real Aero questions
 * about a real project (a database copy, never a live instance), captures the
 * tool trace and answer, and grades each answer twice: deterministic rule
 * checks, and a Claude grader that compares it with ground truth computed from
 * the project's own data. Nothing here is specific to any client: client
 * question sets are private JSON files outside the repository.
 */

/** Which lane asks: the operator (install key) or a signed-in viewer. */
export type EvalLane = 'admin' | 'viewer'

/** What kind of project a question applies to. */
export type ProjectKind = 'advanced' | 'simple' | 'legacy'

/** One question, generic (a template) or from a private client set. */
export interface EvalQuestion {
  /** Stable id, unique within a set, used in reports. */
  id: string
  /** Project kinds this question applies to. */
  kinds: ProjectKind[]
  /** The prompt sent to Aero. May contain {placeholders} filled by ground truth. */
  prompt: string
  /**
   * Ground-truth builder to run for this question (see ground-truth.ts), e.g.
   * 'portfolio-weakest', 'sweep-changes', 'sources-nonbrand', 'none' for
   * product/how-it-works questions graded on the rubric alone.
   */
  truth: string
  /** Extra rubric lines for the grader, beyond the shared rubric. */
  rubric?: string[]
  /** Lanes to ask on. Default both. */
  lanes?: EvalLane[]
}

export interface EvalQuestionSet {
  name: string
  questions: EvalQuestion[]
}

/** Facts the answer should agree with, computed from the project's data. */
export interface GroundTruth {
  builder: string
  /** Compact JSON the grader sees; keep it well under 20K chars. */
  facts: unknown
  /** Values for {placeholders} in the prompt. */
  placeholders?: Record<string, string>
  /** Human-readable note on how the facts were computed (for the report). */
  basis: string
}

/** One tool call Aero made during a turn. */
export interface ToolCallTrace {
  name: string
  args: unknown
  isError: boolean
  /** First 400 chars of the result text the model saw. */
  resultPreview: string
  /**
   * The full result text the model saw (already capped near 20K chars by the
   * tool-result truncation). Optional: when present, the numeric-grounding
   * check and the grader see every number Aero saw, not just the preview.
   */
  resultText?: string
  resultChars: number
  /** True when the result carried a truncation note. */
  truncated: boolean
  /** Human-readable summary of what truncation dropped, when present. */
  truncationNote?: string
  /**
   * The lists the tool itself returned partially (its `__partialLists` field),
   * e.g. `weakestProperties 10 of 40`. Not a harness cut: set independently of
   * `truncated`.
   */
  partialNote?: string
  /** The misspelled tool name the model wrote, when the runtime corrected it. */
  requestedName?: string
  durationMs?: number
}

/** Everything captured from one Aero turn. */
export interface TurnCapture {
  questionId: string
  lane: EvalLane
  attempt: number
  prompt: string
  answer: string
  tools: ToolCallTrace[]
  /** aero_turn_status reason: completed | tool-limit | time-limit | error | stopped. */
  status: string
  toolCalls: number
  modelCalls: number
  durationMs: number
  /** Stream-level error text, if any. */
  error?: string
  /** LLM spend for this turn, from llm_usage_events, in USD. Null when unknown. */
  costUsd: number | null
  /**
   * Project context Aero's system prompt carried for this turn (the
   * project-shape text: plan revision, Property and group counts, per-class
   * query counts). Figures stated there are grounded for the checks and the
   * grader. Absent when the target could not compute it.
   */
  systemContext?: string
}

export type CheckOutcome = 'pass' | 'fail' | 'warn'

/** One deterministic rule check on a turn. */
export interface CheckResult {
  id: string
  outcome: CheckOutcome
  detail: string
}

/** One grader criterion. */
export interface GraderCriterion {
  id: string
  pass: boolean
  reason: string
}

export interface GraderVerdict {
  /** Overall: the answer is correct, grounded and useful for this question. */
  pass: boolean
  /** 0 to 1. */
  score: number
  criteria: GraderCriterion[]
  /** Claims in the answer the grader found unsupported by the facts or tool results. */
  unsupportedClaims: string[]
  model: string
  costUsd: number | null
}

export interface GradedTurn {
  capture: TurnCapture
  truth: GroundTruth
  checks: CheckResult[]
  verdict: GraderVerdict | null
  /** Pass = no failing check and the grader passed it. */
  pass: boolean
}

export interface QuestionSummary {
  questionId: string
  lane: EvalLane
  attempts: number
  passes: number
  passRate: number
  /** Check ids that failed at least once, with counts. */
  failingChecks: Record<string, number>
  /** Grader criteria that failed at least once, with counts. */
  failingCriteria: Record<string, number>
}

export interface EvalReport {
  project: string
  projectKind: ProjectKind
  startedAt: string
  finishedAt: string
  canonryVersion: string
  aeroModel: string
  graderModel: string
  attemptsPerQuestion: number
  turns: GradedTurn[]
  summary: QuestionSummary[]
  overallPassRate: number
  costUsd: { aero: number | null; grader: number | null }
}
