import { describe, expect, it } from 'vitest'
import {
  checkDenominatorLabel,
  checkNamedVsCited,
  checkNumericGrounding,
  checkPooledClasses,
  checkToolErrors,
  checkTruncatedLists,
  checkTurnStatus,
  countEnumeratedItems,
  extractAnswerNumbers,
  isHarnessBlocked,
  keptRowCeiling,
  looksLikeToolError,
  runChecks,
} from '../eval/aero/checks.js'
import { EVAL_BLOCKED_MESSAGE } from '../eval/aero/target.js'
import type { GroundTruth, ToolCallTrace, TurnCapture } from '../eval/aero/types.js'

function tool(overrides: Partial<ToolCallTrace> = {}): ToolCallTrace {
  const resultText = overrides.resultText ?? '{"ok":true}'
  return {
    name: 'canonry_measurement_portfolio_summary',
    args: {},
    isError: false,
    resultPreview: resultText.slice(0, 400),
    resultText,
    resultChars: resultText.length,
    truncated: false,
    ...overrides,
  }
}

function capture(overrides: Partial<TurnCapture> = {}): TurnCapture {
  return {
    questionId: 'portfolio-weakest',
    lane: 'admin',
    attempt: 1,
    prompt: 'Which Properties are weakest?',
    answer: 'All good.',
    tools: [],
    status: 'completed',
    toolCalls: 0,
    modelCalls: 1,
    durationMs: 1000,
    costUsd: null,
    ...overrides,
  }
}

const noTruth: GroundTruth = { builder: 'none', facts: {}, basis: 'rubric only' }

describe('checkToolErrors', () => {
  it('passes when every call returned data', () => {
    const result = checkToolErrors(capture({ tools: [tool(), tool({ name: 'canonry_measurement_overview' })] }))
    expect(result.outcome).toBe('pass')
  })

  it('fails on isError and on the runtime "not loaded" guidance text', () => {
    const result = checkToolErrors(
      capture({
        tools: [
          tool({ isError: true, resultText: 'Request failed: 500' }),
          tool({
            name: 'canonry_analytics_sources',
            resultText: 'canonry_analytics_sources is not loaded yet. Call canonry_load_toolkit with toolkit "analytics", then call canonry_analytics_sources again.',
          }),
          tool({ name: 'canonry_gsc_coverage', resultText: 'canonry_gsc_coverage is not available in this conversation. Use only the tools listed for you.' }),
        ],
      }),
    )
    expect(result.outcome).toBe('fail')
    expect(result.detail).toContain('3 of 3')
    expect(result.detail).toContain('canonry_analytics_sources')
  })

  it('warns, not fails, when only the eval harness guard refused a call', () => {
    const refusal = JSON.stringify({ error: { code: 'EVAL_BLOCKED', message: EVAL_BLOCKED_MESSAGE } })
    const blockedOnly = checkToolErrors(capture({
      tools: [tool(), tool({ name: 'canonry_doctor', isError: true, resultText: `Error: ${EVAL_BLOCKED_MESSAGE}` })],
    }))
    expect(blockedOnly.outcome).toBe('warn')
    expect(blockedOnly.detail).toContain('canonry_doctor')
    expect(isHarnessBlocked(refusal)).toBe(true)

    const mixed = checkToolErrors(capture({
      tools: [
        tool({ name: 'canonry_doctor', isError: true, resultText: refusal }),
        tool({ isError: true, resultText: 'Request failed: 500' }),
      ],
    }))
    expect(mixed.outcome).toBe('fail')
    expect(mixed.detail).toContain('1 of 2')
    expect(mixed.detail).toContain('harness refused 1')
  })

  it('does not treat a data row that says "not found" as an error', () => {
    expect(looksLikeToolError('{"rows":[{"status":"not found","url":"/a"}]}')).toBe(false)
    expect(looksLikeToolError('{"error":{"code":"NOT_FOUND","message":"Project not found"}}')).toBe(true)
    expect(looksLikeToolError('Tool canonry_foo not found')).toBe(true)
  })
})

describe('checkTurnStatus', () => {
  it('passes a completed turn with an answer', () => {
    expect(checkTurnStatus(capture()).outcome).toBe('pass')
  })

  it.each(['tool-limit', 'time-limit', 'error', 'stopped'])('fails status %s', (status) => {
    expect(checkTurnStatus(capture({ status })).outcome).toBe('fail')
  })

  it('fails a stream error and an empty answer', () => {
    expect(checkTurnStatus(capture({ error: 'socket hang up' })).outcome).toBe('fail')
    expect(checkTurnStatus(capture({ answer: '  ' })).detail).toContain('empty answer')
  })
})

describe('checkTruncatedLists', () => {
  const truncatedSummary = tool({
    truncated: true,
    truncationNote: '{"droppedKeys":["markets","mentionRanking"],"keptItems":{"weakestProperties":"21 of 50","markets":"0 of 120"}}',
  })

  it('reads the kept-row ceiling from the note and from a structured __truncation field', () => {
    expect(keptRowCeiling(truncatedSummary)).toBe(21)
    const structured = tool({
      truncated: true,
      resultText: '{\n  "rows": [],\n  "__truncated": true,\n  "__truncation": {\n    "droppedKeys": [],\n    "keptItems": {\n      "rows": "12 of 80"\n    }\n  }\n}',
    })
    expect(keptRowCeiling(structured)).toBe(12)
    const keysOnly = tool({ truncated: true, truncationNote: 'plain slice; cut at rows[3]; kept rows[3] 4 of 9 keys, rows 3 of 40' })
    expect(keptRowCeiling(keysOnly)).toBe(3)
  })

  it('warns when the answer lists more items than the truncated result kept', () => {
    const rows = Array.from({ length: 24 }, (_, i) => `| Property ${i + 4} | 0/24 | 0/24 |`).join('\n')
    const answer = `Your weakest Properties, all at zero:\n\n| Property | Mention | Citation |\n|---|---|---|\n${rows}`
    const result = checkTruncatedLists(capture({ answer, tools: [truncatedSummary] }))
    expect(result.outcome).toBe('warn')
    expect(result.detail).toContain('24 items')
    expect(result.detail).toContain('at most 21')
  })

  it('counts inline lists after a colon', () => {
    expect(countEnumeratedItems('Also at zero: North Yard, Elm Court, Bay Commons, River Flats and Oak Park.')).toBe(5)
    expect(countEnumeratedItems('| a | b |\n|---|---|\n| 1 | 2 |\n- one\n- two\n3. three')).toBe(4)
  })

  it('warns on a completeness claim built on a truncated result the answer does not flag', () => {
    const result = checkTruncatedLists(
      capture({ answer: 'All 41 Properties at zero are in these two regions.', tools: [tool({ truncated: true })] }),
    )
    expect(result.outcome).toBe('warn')
    expect(result.detail).toContain('All 41')
  })

  it('passes a short list that says the data was partial', () => {
    const result = checkTruncatedLists(
      capture({
        answer: 'The summary was truncated, so this is only the first 5 of the weakest rows:\n- A\n- B\n- C\n- D\n- E',
        tools: [truncatedSummary],
      }),
    )
    expect(result.outcome).toBe('pass')
    expect(result.detail).toContain('says the data was partial')
  })
})

describe('extractAnswerNumbers', () => {
  it('skips years, dates, ordinals, rank columns, code, URLs, names and small prose integers', () => {
    const answer = [
      '## Weakest (non-brand, Mar 17, 2026 sweep)',
      '',
      '| # | Property | Mention |',
      '|---|---|---|',
      '| 7 | Unit 4100N | 0/24 |',
      '',
      '1. Fix it first: 2 engines named Rival Commons 9x as often.',
      'Version 5.19.1 ran at 13:57 on 2026-09-24 with `limit=50` (https://example.com/p/123). It ranks 8th. Over 1,000 answers.',
    ].join('\n')
    expect(extractAnswerNumbers(answer).map((num) => num.raw)).toEqual(['24', '9'])
  })

  it('keeps percentages, money and hedged figures', () => {
    const nums = extractAnswerNumbers('Mention coverage is 26.2% (about 1,200 answers), down 5pp, costing $15.20.')
    expect(nums.map((num) => [num.raw, num.percent, num.approx])).toEqual([
      ['26.2%', true, false],
      ['1,200', false, true],
      ['5%', true, false],
      ['$15.20', false, false],
    ])
  })
})

describe('checkNumericGrounding', () => {
  const summary = tool({
    resultText: JSON.stringify({ metrics: { propertiesMentioned: 91, totalProperties: 140, mentions: 318, answers: 1212, citations: 151 } }, null, 2),
  })

  it('passes numbers found in tool results, rates derivable from them, and hedged roundings', () => {
    const answer =
      '91 of 140 Properties were named at least once. The Property was named in 318 of 1,212 answers (26.2%) and cited in 151 (12.5%), about 1,200 answers in all.'
    const result = checkNumericGrounding(capture({ answer, tools: [summary] }), noTruth)
    expect(result.outcome).toBe('pass')
  })

  it('grounds a percentage-point gap between two rates', () => {
    const rates = tool({ resultText: '{"previous":{"mentionRate":0.2153},"current":{"mentionRate":0.2623}}' })
    const answer = 'Non-brand mention coverage rose from 21.5% on Mar 3 to 26.2% on Mar 17 (+4.7 pts).'
    expect(checkNumericGrounding(capture({ answer, tools: [rates] }), noTruth).outcome).toBe('pass')
    const wrong = 'Non-brand mention coverage rose from 21.5% to 26.2%, a gain of 11.5 pts.'
    expect(checkNumericGrounding(capture({ answer: wrong, tools: [rates] }), noTruth).detail).toContain('11.5%')
  })

  it('uses ground-truth facts as evidence', () => {
    const truth: GroundTruth = { builder: 'portfolio-weakest', facts: { zeroZero: 41 }, basis: 'overview rows' }
    const result = checkNumericGrounding(capture({ answer: '41 Properties sit at zero mention and zero citation.', tools: [summary] }), truth)
    expect(result.outcome).toBe('pass')
  })

  it('fails and lists numbers nothing supports', () => {
    const answer = 'Your own site appears in 318 answers; 47 Properties are invisible and 3,112 answers cite aggregators.'
    const result = checkNumericGrounding(capture({ answer, tools: [summary] }), noTruth)
    expect(result.outcome).toBe('fail')
    expect(result.detail).toContain('47')
    expect(result.detail).toContain('3,112')
    expect(result.detail).not.toContain('318')
  })

  it('only warns when some results were captured as previews', () => {
    const preview = tool({ resultText: undefined, resultPreview: '{"metrics":{', resultChars: 18_000 })
    const result = checkNumericGrounding(capture({ answer: 'There are 3,112 answers.', tools: [preview] }), noTruth)
    expect(result.outcome).toBe('warn')
    expect(result.detail).toContain('previews')
  })
})

describe('checkDenominatorLabel', () => {
  it('warns on a Denom (questions) header and on N/M questions', () => {
    expect(checkDenominatorLabel(capture({ answer: '| Property | Mention | Denom (questions) |\n|---|---|---|\n| A | 0 | 24 |' })).outcome).toBe('warn')
    expect(checkDenominatorLabel(capture({ answer: 'Named in 5/24 questions.' })).outcome).toBe('warn')
  })

  it('warns when "of N questions" uses an answer count from the data', () => {
    const tools = [tool({ resultText: '{"rows":[{"label":"A","mentions":5,"answers":24}]}' })]
    const result = checkDenominatorLabel(capture({ answer: 'A was named in 5 of 24 questions.', tools }))
    expect(result.outcome).toBe('warn')
    expect(result.detail).toContain('answer count')
  })

  it('passes answer-labeled denominators, even when questions explain them', () => {
    const answer = 'Named in 5 of 24 answers. The denominator is 24 answers (8 questions x 3 engines).'
    expect(checkDenominatorLabel(capture({ answer })).outcome).toBe('pass')
  })
})

describe('checkNamedVsCited', () => {
  const namedInstead = tool({ resultText: '{"weakestProperties":[{"label":"A","recommendedInstead":[{"name":"Rival Commons","occurrences":9}]}]}' })

  it('warns when named-instead data is described as citations', () => {
    const answer = '| Property | Cited instead of you |\n|---|---|\n| A | Rival Commons (9) |'
    const result = checkNamedVsCited(capture({ answer, tools: [namedInstead] }), noTruth)
    expect(result.outcome).toBe('warn')
  })

  it('passes "named instead" wording', () => {
    const answer = 'Engines named Rival Commons instead of A in 9 answers.'
    expect(checkNamedVsCited(capture({ answer, tools: [namedInstead] }), noTruth).outcome).toBe('pass')
  })

  it('does not warn without named-instead data', () => {
    const answer = 'Engines cited rivalcommons.example instead of your site.'
    expect(checkNamedVsCited(capture({ answer, tools: [tool()] }), noTruth).outcome).toBe('pass')
  })
})

describe('checkPooledClasses', () => {
  const split: GroundTruth = { builder: 'sources-nonbrand', facts: { nonBrand: { answers: 1212 }, branded: { answers: 1212 } }, basis: 'x' }

  it('is not applicable when the truth does not split classes', () => {
    expect(checkPooledClasses(capture({ answer: 'Across all queries, mention is 40%.' }), noTruth).outcome).toBe('pass')
  })

  it('warns on pooled phrasing', () => {
    const result = checkPooledClasses(capture({ answer: 'Across all queries, your mention coverage is 40%.' }), split)
    expect(result.outcome).toBe('warn')
  })

  it('warns on rates with no class named anywhere', () => {
    expect(checkPooledClasses(capture({ answer: 'Mention coverage is 29% and citation coverage 13%.' }), split).outcome).toBe('warn')
  })

  it('passes when the answer or the question names the class, or says it did not pool', () => {
    expect(checkPooledClasses(capture({ answer: 'Non-brand mention coverage is 29%; branded is 81%.' }), split).outcome).toBe('pass')
    expect(
      checkPooledClasses(capture({ prompt: 'How visible are we on non-brand questions?', answer: 'Mention coverage is 29%.' }), split).outcome,
    ).toBe('pass')
    expect(checkPooledClasses(capture({ answer: 'Branded and non-brand are not pooled here: non-brand is 29%.' }), split).outcome).toBe('pass')
  })
})

describe('runChecks', () => {
  it('returns every check in a fixed order', () => {
    expect(runChecks(capture(), noTruth).map((check) => check.id)).toEqual([
      'tool-errors',
      'turn-status',
      'truncated-list',
      'numeric-grounding',
      'label-denominator',
      'label-named-vs-cited',
      'label-pooled-classes',
    ])
  })
})
