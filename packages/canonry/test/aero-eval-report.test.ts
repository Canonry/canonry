import { describe, expect, it } from 'vitest'
import { buildReport, failureModes, renderMarkdown, turnPasses } from '../eval/aero/report.js'
import type { CheckResult, EvalLane, GradedTurn, GraderVerdict } from '../eval/aero/types.js'

function turn(opts: {
  questionId: string
  lane?: EvalLane
  attempt?: number
  checks?: CheckResult[]
  verdict?: GraderVerdict | null
  aeroCost?: number | null
  answer?: string
}): GradedTurn {
  const checks = opts.checks ?? [{ id: 'tool-errors', outcome: 'pass', detail: 'ok' }]
  const verdict = opts.verdict === undefined ? passingVerdict() : opts.verdict
  return {
    capture: {
      questionId: opts.questionId,
      lane: opts.lane ?? 'admin',
      attempt: opts.attempt ?? 1,
      prompt: 'q',
      answer: opts.answer ?? 'An answer | with a pipe.',
      tools: [],
      status: 'completed',
      toolCalls: 3,
      modelCalls: 2,
      durationMs: 1000,
      costUsd: opts.aeroCost === undefined ? 0.02 : opts.aeroCost,
    },
    truth: { builder: 'none', facts: {}, basis: 'x' },
    checks,
    verdict,
    pass: turnPasses(checks, verdict),
  }
}

function passingVerdict(): GraderVerdict {
  return {
    pass: true,
    score: 0.9,
    criteria: [{ id: 'grounded', pass: true, reason: 'ok' }],
    unsupportedClaims: [],
    model: 'claude-opus-5',
    costUsd: 0.1,
  }
}

function failingVerdict(): GraderVerdict {
  return {
    pass: false,
    score: 0.3,
    criteria: [
      { id: 'grounded', pass: false, reason: 'Lists 19 Properties as zero; 10 have mentions.' },
      { id: 'q1', pass: false, reason: 'Ranks tied Properties.' },
    ],
    unsupportedClaims: ['Rival Commons gets 9x your mentions'],
    model: 'claude-opus-5',
    costUsd: 0.12,
  }
}

const ungrounded: CheckResult = { id: 'numeric-grounding', outcome: 'fail', detail: '2 of 9 number(s) not found: 47, 3,112' }
const truncatedWarn: CheckResult = { id: 'truncated-list', outcome: 'warn', detail: 'enumerates 39 items but kept 21' }

const baseInput = {
  project: 'demo-project',
  projectKind: 'advanced' as const,
  startedAt: '2026-09-24T10:00:00Z',
  finishedAt: '2026-09-24T10:30:00Z',
  canonryVersion: '5.19.1',
  aeroModel: 'aero-model',
  graderModel: 'claude-opus-5',
  attemptsPerQuestion: 2,
}

describe('turnPasses', () => {
  it('fails on any failing check, else follows the verdict, else the checks alone', () => {
    expect(turnPasses([ungrounded], passingVerdict())).toBe(false)
    expect(turnPasses([truncatedWarn], passingVerdict())).toBe(true)
    expect(turnPasses([], failingVerdict())).toBe(false)
    expect(turnPasses([truncatedWarn], null)).toBe(true)
  })
})

describe('buildReport', () => {
  const turns = [
    turn({ questionId: 'weakest', attempt: 1 }),
    turn({ questionId: 'weakest', attempt: 2, checks: [ungrounded, truncatedWarn], verdict: failingVerdict() }),
    turn({ questionId: 'weakest', lane: 'viewer', verdict: null, aeroCost: null }),
    turn({ questionId: 'sources', checks: [ungrounded], verdict: failingVerdict() }),
  ]

  it('summarizes pass rates per question and lane with failing check and criterion counts', () => {
    const report = buildReport({ ...baseInput, turns })
    expect(report.summary).toEqual([
      {
        questionId: 'weakest',
        lane: 'admin',
        attempts: 2,
        passes: 1,
        passRate: 0.5,
        failingChecks: { 'numeric-grounding': 1 },
        failingCriteria: { grounded: 1, q1: 1 },
      },
      { questionId: 'weakest', lane: 'viewer', attempts: 1, passes: 1, passRate: 1, failingChecks: {}, failingCriteria: {} },
      {
        questionId: 'sources',
        lane: 'admin',
        attempts: 1,
        passes: 0,
        passRate: 0,
        failingChecks: { 'numeric-grounding': 1 },
        failingCriteria: { grounded: 1, q1: 1 },
      },
    ])
    expect(report.overallPassRate).toBe(0.5)
  })

  it('sums known costs and reports null when none is known', () => {
    const report = buildReport({ ...baseInput, turns })
    expect(report.costUsd.aero).toBeCloseTo(0.06, 8)
    expect(report.costUsd.grader).toBeCloseTo(0.34, 8)
    const unknown = buildReport({ ...baseInput, turns: [turn({ questionId: 'x', verdict: null, aeroCost: null })] })
    expect(unknown.costUsd).toEqual({ aero: null, grader: null })
    expect(buildReport({ ...baseInput, turns: [] }).overallPassRate).toBe(0)
  })

  it('ranks failure modes, keys question rubric lines by question, and lists warnings after failures', () => {
    const modes = failureModes(turns)
    expect(modes.map((mode) => [mode.key, mode.turns])).toEqual([
      ['check numeric-grounding', 2],
      ['criterion grounded', 2],
      ['criterion sources:q1', 1],
      ['criterion weakest:q1', 1],
      ['warn truncated-list', 1],
    ])
    expect(modes[0]!.where).toEqual(['weakest (admin)', 'sources (admin)'])
  })
})

describe('renderMarkdown', () => {
  it('renders the overall line, the question table, failure modes and evidence for failing turns only', () => {
    const turns = [
      turn({ questionId: 'weakest' }),
      turn({ questionId: 'weakest', attempt: 2, checks: [ungrounded, truncatedWarn], verdict: failingVerdict() }),
    ]
    const markdown = renderMarkdown(buildReport({ ...baseInput, turns }))
    expect(markdown).toContain('# Aero eval: demo-project (advanced)')
    expect(markdown).toContain('**Overall: 1 of 2 turns passed (50%).**')
    expect(markdown).toContain('Cost: Aero $0.04, grader $0.22.')
    expect(markdown).toContain('| weakest | admin | 1/2 (50%) | numeric-grounding x1 | grounded x1, q1 x1 |')
    expect(markdown).toContain('1. check numeric-grounding: 1 turn(s), in weakest (admin)')
    expect(markdown).toContain('### weakest (admin), attempt 2')
    expect(markdown).toContain('- check numeric-grounding (fail): 2 of 9 number(s) not found: 47, 3,112')
    expect(markdown).toContain('- check truncated-list (warn): enumerates 39 items but kept 21')
    expect(markdown).toContain('- criterion grounded: Lists 19 Properties as zero; 10 have mentions.')
    expect(markdown).toContain('- unsupported: "Rival Commons gets 9x your mentions"')
    expect(markdown).not.toContain('attempt 1')
    expect(markdown).not.toMatch(/\u2014/)
  })

  it('escapes pipes in table cells and caps the evidence section', () => {
    const turns = Array.from({ length: 4 }, (_, i) =>
      turn({ questionId: 'a|b', attempt: i + 1, checks: [ungrounded], verdict: null }),
    )
    const markdown = renderMarkdown(buildReport({ ...baseInput, turns }), { maxEvidenceTurns: 2 })
    expect(markdown).toContain('| a\\|b | admin | 0/4 (0%) |')
    expect(markdown).toContain('2 more failing turn(s) not shown.')
    expect(markdown).toContain('not graded')
  })

  it('says so when nothing failed', () => {
    const markdown = renderMarkdown(buildReport({ ...baseInput, turns: [turn({ questionId: 'ok' })] }))
    expect(markdown).toContain('## Top failure modes\n\nNone.')
    expect(markdown).toContain('No failing turns.')
  })
})
