import { describe, expect, it } from 'vitest'
import {
  apiTruncation,
  checkDenominatorLabel,
  checkNamedVsCited,
  checkNetArithmetic,
  checkNumericGrounding,
  checkPooledClasses,
  checkToolErrors,
  checkTruncatedLists,
  checkTurnStatus,
  countEnumeratedItems,
  editDistance,
  extractAnswerNumbers,
  isHarnessBlocked,
  keptRowCeiling,
  looksLikeToolError,
  runChecks,
  suggestedToolNames,
  unknownToolName,
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

  it('warns, not fails, on a misspelled tool name the model corrected later in the turn', () => {
    const typo = tool({
      name: 'canrony_measurement_changes',
      isError: true,
      resultText: 'canrony_measurement_changes is not available in this conversation. Use aero_list_toolkits to see the tools you can load.',
    })
    const recovered = checkToolErrors(capture({ tools: [typo, tool({ name: 'canonry_measurement_changes' })] }))
    expect(recovered.outcome).toBe('warn')
    expect(recovered.detail).toContain('canrony_measurement_changes -> canonry_measurement_changes')

    // Never corrected, or corrected only before the typo: still a failure.
    expect(checkToolErrors(capture({ tools: [typo, tool({ name: 'canonry_visibility_report' })] })).outcome).toBe('fail')
    expect(checkToolErrors(capture({ tools: [tool({ name: 'canonry_measurement_changes' }), typo] })).outcome).toBe('fail')
    // The corrected call errored too: not recovered.
    const alsoFailed = tool({ name: 'canonry_measurement_changes', isError: true, resultText: 'Request failed: 500' })
    expect(checkToolErrors(capture({ tools: [typo, alsoFailed] })).outcome).toBe('fail')
    // A real failure beside a recovered typo still fails, and names both.
    const mixed = checkToolErrors(capture({ tools: [typo, tool({ name: 'canonry_measurement_changes' }), alsoFailed] }))
    expect(mixed.outcome).toBe('fail')
    expect(mixed.detail).toContain('1 misspelled tool name(s) recovered')
  })

  it('warns, not fails, when the model follows the runtime "is not a tool. Did you mean" reply', () => {
    // Exact texts src/agent/runtime.ts (suggestToolName) answers a near-miss name with.
    const single = 'canonry_measurment_changes is not a tool. Did you mean canonry_measurement_changes? Call it again by that exact name.'
    const load = 'canonry_analytic_sources is not a tool. Did you mean canonry_analytics_sources? Call aero_load_toolkit with toolkit "analytics", then call canonry_analytics_sources.'
    const several = 'canonry_run_lst is not a tool. Did you mean one of: canonry_run_list, canonry_runs_list? Call the one you meant by its exact name.'
    expect(unknownToolName(single)).toBe('canonry_measurment_changes')
    expect(suggestedToolNames(single)).toEqual(['canonry_measurement_changes'])
    expect(suggestedToolNames(load)).toEqual(['canonry_analytics_sources'])
    expect(suggestedToolNames(several)).toEqual(['canonry_run_list', 'canonry_runs_list'])
    // Only an unknown-tool reply carries suggestions.
    expect(suggestedToolNames('Did you mean canonry_runs_list?')).toEqual([])
    // Reads as an error even when the trace lost isError.
    expect(looksLikeToolError(single)).toBe(true)

    const typo = tool({ name: 'canonry_measurment_changes', isError: true, resultText: single })
    const recovered = checkToolErrors(capture({ tools: [typo, tool({ name: 'canonry_measurement_changes' })] }))
    expect(recovered.outcome).toBe('warn')
    expect(recovered.detail).toContain('canonry_measurment_changes -> canonry_measurement_changes')
    // Loading the suggested toolkit first is part of the recovery, not a new error.
    const loadTypo = tool({ name: 'canonry_analytic_sources', isError: true, resultText: load })
    const loaded = checkToolErrors(capture({
      tools: [loadTypo, tool({ name: 'aero_load_toolkit', resultText: 'Loaded toolkit "analytics".' }), tool({ name: 'canonry_analytics_sources' })],
    }))
    expect(loaded.outcome).toBe('warn')
    // Never followed: still a failure.
    expect(checkToolErrors(capture({ tools: [typo, tool({ name: 'canonry_visibility_report' })] })).outcome).toBe('fail')

    // The runtime also matches on the name after its prefix, so the suggestion
    // can sit further than TYPO_DISTANCE edits from the typo. Following it recovers.
    const swapped = 'canonry_list_toolkits is not a tool. Did you mean aero_list_toolkits? Call it again by that exact name.'
    expect(editDistance('canonry_list_toolkits', 'aero_list_toolkits')).toBeGreaterThan(2)
    const prefixTypo = tool({ name: 'canonry_list_toolkits', isError: true, resultText: swapped })
    const followed = checkToolErrors(capture({ tools: [prefixTypo, tool({ name: 'aero_list_toolkits' })] }))
    expect(followed.outcome).toBe('warn')
    expect(followed.detail).toContain('canonry_list_toolkits -> aero_list_toolkits')
  })

  it('reads the unknown tool name from both runtime messages and measures typos with transpositions', () => {
    expect(unknownToolName('Tool canonry_foo not found')).toBe('canonry_foo')
    expect(unknownToolName('canronry_analytics_sources is not available in this conversation. Use only the tools listed for you.')).toBe('canronry_analytics_sources')
    expect(unknownToolName('canonry_analytics_sources is not loaded yet. Call aero_load_toolkit with toolkit "analytics".')).toBeNull()
    expect(editDistance('canonyr', 'canonry')).toBe(1)
    expect(editDistance('canrony', 'canonry')).toBe(2)
    expect(editDistance('canronry', 'canonry')).toBe(1)
    expect(editDistance('canonry_run_get', 'canonry_runs_list')).toBeGreaterThan(2)
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

  it('treats truncation the API reports in its payload as truncation', () => {
    const summary = tool({
      resultText: JSON.stringify({
        truncated: true,
        totalProperties: 120,
        weakestProperties: [{ label: 'A', citedDomains: [{ domain: 'listings.example', answers: 3 }], citedDomainsTotal: 40 }],
        mentionRanking: { strongest: [], truncated: false },
      }),
    })
    expect(apiTruncation(summary)).toBe('truncated: true, totalProperties 120 > 1 weakestProperties returned')
    const result = checkTruncatedLists(capture({ answer: 'I have the full picture: every weak Property is below.', tools: [summary] }))
    expect(result.outcome).toBe('warn')
    expect(result.detail).toContain('full picture')
    expect(result.detail).toContain('the API returned fewer rows than it has')
  })

  it('reads a paged total, and ignores per-row caps and product markers', () => {
    const paged = tool({ resultText: JSON.stringify({ properties: { items: [{ label: 'A' }], nextCursor: 'c2', totalEstimate: 12 } }) })
    expect(apiTruncation(paged)).toBe('properties.totalEstimate 12 > 1 items returned')
    // Each row's own top-domain cap is two levels down, not a cut of the result.
    const perRow = tool({ resultText: JSON.stringify({ rows: [{ citedDomains: [], citedDomainsTotal: 40 }], total: 1 }) })
    expect(apiTruncation(perRow)).toBeNull()
    const whole = tool({ resultText: JSON.stringify({ markets: [{ label: 'North' }], totalMarkets: 1, marketsTruncated: false, __truncated: true }) })
    expect(apiTruncation(whole)).toBeNull()
    expect(apiTruncation(tool({ resultText: 'plain text, 3 of 9 rows' }))).toBeNull()
    expect(checkTruncatedLists(capture({ answer: 'All 12 are listed.', tools: [whole] })).outcome).toBe('pass')
  })

  it('does not read "all N" as a completeness claim when N is a population total', () => {
    const summary = tool({ resultText: JSON.stringify({ truncated: true, totalProperties: 140, tiedAtWeakest: { count: 41 }, weakestProperties: [{ label: 'A' }] }) })
    expect(checkTruncatedLists(capture({ answer: 'Across all 140 Properties, 41 tie at zero.', tools: [summary] })).outcome).toBe('pass')
    expect(checkTruncatedLists(capture({ answer: 'The names below cover all 41 tied Properties.', tools: [summary] })).outcome).toBe('pass')
    const systemContext = 'Project shape: an Advanced Measurement portfolio with 150 Properties.'
    expect(checkTruncatedLists(capture({ answer: 'Across all 150 Properties.', tools: [summary], systemContext })).outcome).toBe('pass')
    // Any other count, or a full-list claim, still warns.
    expect(checkTruncatedLists(capture({ answer: 'All 12 weakest are listed.', tools: [summary] })).outcome).toBe('warn')
    expect(checkTruncatedLists(capture({ answer: 'Across all 140 Properties, this is the full list.', tools: [summary] })).detail).toContain('full list')
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

  it("grounds figures stated in Aero's system context", () => {
    const systemContext = 'Project shape: an Advanced Measurement portfolio (plan revision 7) with 160 Properties in 30 groups (20 top-level, 10 nested), 320 branded and 480 non-brand queries.'
    const answer = 'The portfolio has 160 Properties and 480 non-brand queries.'
    expect(checkNumericGrounding(capture({ answer, tools: [summary] }), noTruth).outcome).toBe('fail')
    expect(checkNumericGrounding(capture({ answer, tools: [summary], systemContext }), noTruth).outcome).toBe('pass')
  })

  it("grounds one step of integer arithmetic on the answer's own grounded figures", () => {
    const tied = tool({ resultText: '{"tiedAtWeakest":{"count":40},"limit":10,"answers":1200}' })
    // 30 = 40 - 10; 400 = 1,200 / 3; 50 = 40 + 10.
    const answer = '40 Properties tie at zero. Top 10 shown; 30 more tied. 1,200 answers across 3 engines is 400 queries, 50 rows in all.'
    expect(checkNumericGrounding(capture({ answer, tools: [tied] }), noTruth).outcome).toBe('pass')
    // 47 is no sum, difference or ratio of 40, 10 and 1,200, and small prose integers never add.
    const invented = checkNumericGrounding(capture({ answer: '40 Properties tie at zero; 10 are shown; 47 are in one metro, and 70 answers name a rival.', tools: [tied] }), noTruth)
    expect(invented.outcome).toBe('fail')
    expect(invented.detail).toContain('2 of 4 number(s) not found in any tool result or the ground truth: 47, 70')
    // 42 = 40 + 2, but a small prose integer only ever divides.
    const smallAddend = checkNumericGrounding(capture({ answer: 'Across 2 engines, 40 tie and 42 are named.', tools: [tied] }), noTruth)
    expect(smallAddend.detail).toContain(': 42')
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

  it('does not warn on a "cited instead" heading, column or lead-in over cited domains', () => {
    const heading = '## What gets cited instead\n\n- listings.example (10)\n- rentals.example (4)\n\nNext step: fix the listing.'
    expect(checkNamedVsCited(capture({ answer: heading, tools: [namedInstead] }), noTruth)).toMatchObject({
      outcome: 'pass',
      detail: '"cited instead" heads only lists of cited domains',
    })
    const table = '### Cited instead\n\nThe engines cited these sites:\n\n| Domain | Answers |\n|---|---|\n| listings.example | 10 |\n| www.rentals.example | 4 |'
    expect(checkNamedVsCited(capture({ answer: table, tools: [namedInstead] }), noTruth).outcome).toBe('pass')
    const column = '| Property | Cited instead |\n|---|---|\n| A | listings.example (10) |'
    expect(checkNamedVsCited(capture({ answer: column, tools: [namedInstead] }), noTruth).outcome).toBe('pass')
    const inline = 'Cited instead: listings.example (10), rentals.example (4).'
    expect(checkNamedVsCited(capture({ answer: inline, tools: [namedInstead] }), noTruth).outcome).toBe('pass')
    // Names under the same heading are still names written in the answer text.
    const names = '## Cited instead\n\n- Rival Commons (9)\n- listings.example (3)'
    expect(checkNamedVsCited(capture({ answer: names, tools: [namedInstead] }), noTruth).outcome).toBe('warn')
    // Prose under the heading is not a list to judge by.
    const prose = '## Cited instead\n\nRival Commons shows up most.\n\n- listings.example (3)'
    expect(checkNamedVsCited(capture({ answer: prose, tools: [namedInstead] }), noTruth).outcome).toBe('warn')
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

  it('warns when the lead figure never says its class, even if a class is named further down', () => {
    const answer = 'Here is what changed.\n\n**Mention coverage**: flat. 40.0% (+0.1 pts), 6 more mentions.\n\n## By class\n\nBranded held at 81%; non-brand at 29%.'
    const result = checkPooledClasses(capture({ prompt: 'What changed since the last sweep?', answer }), split)
    expect(result.outcome).toBe('warn')
    expect(result.detail).toContain('40.0%')
    // A class named before or in the lead paragraph scopes it.
    const scoped = 'All figures below are non-brand.\n\n**Mention coverage**: flat. 29% (+0.1 pts).\n\nBranded held at 81%.'
    expect(checkPooledClasses(capture({ prompt: 'What changed?', answer: scoped }), split).outcome).toBe('pass')
  })

  it('passes when the answer or the question names the class, or says it did not pool', () => {
    expect(checkPooledClasses(capture({ answer: 'Non-brand mention coverage is 29%; branded is 81%.' }), split).outcome).toBe('pass')
    expect(
      checkPooledClasses(capture({ prompt: 'How visible are we on non-brand questions?', answer: 'Mention coverage is 29%.' }), split).outcome,
    ).toBe('pass')
    expect(checkPooledClasses(capture({ answer: 'Branded and non-brand are not pooled here: non-brand is 29%.' }), split).outcome).toBe('pass')
  })
})

describe('checkNetArithmetic', () => {
  it('warns when a net figure contradicts its gained and lost parts', () => {
    const result = checkNetArithmetic(capture({ answer: 'Citations churned: 40 gained vs 34 lost, net −6.' }))
    expect(result.outcome).toBe('warn')
    expect(result.detail).toContain('40 gained less 34 lost is +6')
    // The sign can come from the word, and the parts can follow the net figure.
    expect(checkNetArithmetic(capture({ answer: 'A net loss of 6 (34 gained, 40 lost).' })).outcome).toBe('pass')
    expect(checkNetArithmetic(capture({ answer: 'A net gain of 6 (34 gained, 40 lost).' })).outcome).toBe('warn')
  })

  it('checks each net figure against the parts in its own clause', () => {
    const answer = '**Movement:** +40 gained citations, −34 lost (net +6 on citation), and +30 gained mentions, −24 lost (net +6 on mention).'
    expect(checkNetArithmetic(capture({ answer }))).toMatchObject({ outcome: 'pass', detail: '2 net figure(s) match their gained and lost parts' })
    const wrong = '+40 gained citations, −34 lost (net +6 on citation), and +30 gained mentions, −24 lost (net +8 on mention).'
    expect(checkNetArithmetic(capture({ answer: wrong })).detail).toContain('30 gained less 24 lost is +6')
  })

  it('leaves rates, points and unclear clauses alone', () => {
    expect(checkNetArithmetic(capture({ answer: 'Mention rose 4.5 pts: 40 gained, 34 lost, net +4.5 pts.' })).detail).toContain('no net figure')
    expect(checkNetArithmetic(capture({ answer: '12 gained, 3 gained elsewhere, 5 lost, net 9.' })).detail).toContain('no net figure')
    expect(checkNetArithmetic(capture({ answer: 'Our network grew 12 gained and 5 lost.' })).outcome).toBe('pass')
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
      'arithmetic-net',
    ])
  })
})
