import { describe, expect, it, vi } from 'vitest'
import {
  buildGraderInput,
  fairShares,
  gradeTurn,
  graderCostUsd,
  GraderError,
  normalizeCriteria,
  RUBRIC_SYSTEM_PROMPT,
  SHARED_CRITERIA,
  type GraderClient,
} from '../eval/aero/grader.js'
import type { EvalQuestion, GroundTruth, TurnCapture } from '../eval/aero/types.js'

const question: EvalQuestion = {
  id: 'portfolio-weakest',
  kinds: ['advanced'],
  prompt: 'Which {count} Properties are weakest on non-brand questions?',
  truth: 'portfolio-weakest',
  rubric: ['Names the Properties tied at 0% as tied, not ranked.'],
}

const truth: GroundTruth = {
  builder: 'portfolio-weakest',
  facts: { zeroZero: 41, totalProperties: 140 },
  placeholders: { count: '10' },
  basis: 'measurement overview rows, latest non-brand sweep',
}

const capture: TurnCapture = {
  questionId: 'portfolio-weakest',
  lane: 'admin',
  attempt: 1,
  prompt: 'Which 10 Properties are weakest on non-brand questions?',
  answer: '41 of 140 Properties sit at zero mention and zero citation.',
  tools: [
    {
      name: 'canonry_measurement_portfolio_summary',
      args: { limit: 50, queryClass: 'non-brand' },
      isError: false,
      resultPreview: '{"metrics":',
      resultText: `{"metrics":{"propertiesMentioned":91},"rows":"${'x'.repeat(30_000)}"}`,
      resultChars: 30_040,
      truncated: true,
      truncationNote: '{"keptItems":{"weakestProperties":"21 of 50"}}',
    },
  ],
  status: 'completed',
  toolCalls: 1,
  modelCalls: 2,
  durationMs: 9000,
  costUsd: 0.01,
}

interface FakeMessage {
  stop_reason: string
  stop_details?: { category: string | null } | null
  content: Array<{ type: string; text?: string; thinking?: string }>
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }
}

function fakeClient(message: FakeMessage) {
  const stream = vi.fn((_params: unknown) => ({ finalMessage: async () => message }))
  const client = { messages: { stream } } as unknown as GraderClient
  return { client, stream }
}

function verdictMessage(output: unknown, overrides: Partial<FakeMessage> = {}): FakeMessage {
  return {
    stop_reason: 'end_turn',
    stop_details: null,
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: JSON.stringify(output) },
    ],
    usage: { input_tokens: 10_000, output_tokens: 2_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 1_500 },
    ...overrides,
  }
}

const allPass = [...SHARED_CRITERIA, 'q1'].map((id) => ({ id, pass: true, reason: 'ok' }))

describe('gradeTurn', () => {
  it('streams one request with adaptive thinking, the cached rubric and a JSON schema, and returns the verdict', async () => {
    const { client, stream } = fakeClient(verdictMessage({ criteria: allPass, unsupportedClaims: [], score: 0.9, pass: true }))
    const verdict = await gradeTurn(capture, truth, question, { client })

    expect(stream).toHaveBeenCalledTimes(1)
    const params = stream.mock.calls[0]![0] as {
      model: string
      thinking: unknown
      system: unknown
      output_config: { format: { type: string; schema: { properties: Record<string, unknown> } } }
      messages: Array<{ content: string }>
    }
    expect(params.model).toBe('claude-opus-5')
    expect(params.thinking).toEqual({ type: 'adaptive' })
    expect(params.system).toEqual([{ type: 'text', text: RUBRIC_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }])
    expect(params.output_config.format.type).toBe('json_schema')
    expect(params.output_config.format.schema.properties).toHaveProperty('criteria')
    expect(params.output_config.format.schema.properties).toHaveProperty('unsupportedClaims')
    // The per-turn content lives in the user message, after the cached prefix.
    expect(params.messages[0].content).toContain('<answer>\n41 of 140 Properties')
    expect(params.messages[0].content).toContain('q1: Names the Properties tied at 0% as tied')

    expect(verdict.pass).toBe(true)
    expect(verdict.score).toBe(0.9)
    expect(verdict.model).toBe('claude-opus-5')
    expect(verdict.criteria.map((criterion) => criterion.id)).toEqual([...SHARED_CRITERIA, 'q1'])
    // 10,000 x $5 + 1,500 x $0.50 + 2,000 x $25 per million.
    expect(verdict.costUsd).toBeCloseTo(0.10075, 8)
  })

  it('never passes a verdict with a failing criterion, and fails missing criteria', async () => {
    const criteria = allPass
      .filter((criterion) => criterion.id !== 'q1')
      .map((criterion) => (criterion.id === 'market-grouping' ? { ...criterion, pass: false, reason: 'A placed in Metro B' } : criterion))
    const { client } = fakeClient(
      verdictMessage({ criteria, unsupportedClaims: ['A is in Metro B'], score: 1.4, pass: true }),
    )
    const verdict = await gradeTurn(capture, truth, question, { client, model: 'claude-sonnet-5' })
    expect(verdict.pass).toBe(false)
    expect(verdict.score).toBe(1)
    expect(verdict.criteria.find((criterion) => criterion.id === 'q1')).toEqual({
      id: 'q1',
      pass: false,
      reason: 'the grader returned no verdict for this criterion',
    })
    expect(verdict.unsupportedClaims).toEqual(['A is in Metro B'])
  })

  it('throws a GraderError with the cost on a refusal, before reading the content', async () => {
    const { client } = fakeClient(
      verdictMessage({}, { stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [{ type: 'text', text: '{"crit' }] }),
    )
    const error = await gradeTurn(capture, truth, question, { client }).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(GraderError)
    expect((error as GraderError).message).toContain('cyber')
    expect((error as GraderError).costUsd).not.toBeNull()
  })

  it('throws on max_tokens and on a reply that does not match the schema', async () => {
    const truncated = fakeClient(verdictMessage({}, { stop_reason: 'max_tokens' }))
    await expect(gradeTurn(capture, truth, question, { client: truncated.client })).rejects.toThrow(/max_tokens/)
    const malformed = fakeClient(verdictMessage({ criteria: 'nope' }))
    await expect(gradeTurn(capture, truth, question, { client: malformed.client })).rejects.toThrow(/unreadable verdict/)
  })
})

describe('buildGraderInput', () => {
  it('shows the filled prompt, truth, trace and answer, and marks shortened tool text', () => {
    const input = buildGraderInput(capture, truth, question, 5_000)
    expect(input).toContain('Which 10 Properties are weakest')
    expect(input).toContain('"zeroZero": 41')
    expect(input).toContain('truncated_for_aero="true"')
    expect(input).toContain('shortened_for_grader="true" shown_chars="5000"')
    expect(input).toContain('21 of 50')
    expect(input).toContain('"queryClass": "non-brand"')
  })

  it('keeps the cached system prompt free of per-turn content', () => {
    expect(RUBRIC_SYSTEM_PROMPT).not.toContain(capture.answer)
    expect(RUBRIC_SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it("shows Aero's system context for the turn, or says none was recorded", () => {
    const systemContext = 'Project shape: an Advanced Measurement portfolio with 140 Properties and 24 non-brand queries.'
    expect(buildGraderInput({ ...capture, systemContext }, truth, question)).toContain(`<system_context>\n${systemContext}\n</system_context>`)
    expect(buildGraderInput(capture, truth, question)).toContain('<system_context>\nnone recorded\n</system_context>')
  })

  const call = (name: string, resultText: string, args: unknown = {}, extra: Partial<TurnCapture['tools'][number]> = {}) => ({
    name,
    args,
    isError: false,
    resultPreview: resultText.slice(0, 400),
    resultText,
    resultChars: resultText.length,
    truncated: false,
    ...extra,
  })

  it('splits the tool-text budget fairly, so a late result is not starved by early ones', () => {
    const big = (tag: string) => `${tag}${'x'.repeat(29_990)}`
    const tools = [
      call('canonry_measurement_overview', big('first')),
      call('canonry_measurement_changes', big('second')),
      call('canonry_analytics_sources', 'small result'),
      call('canonry_measurement_property_evidence', big('decisive')),
    ]
    const input = buildGraderInput({ ...capture, tools, toolCalls: 4 }, truth, question, 30_000)
    // The small result is whole; the three large ones share what is left equally.
    expect(input).toContain('small result')
    const share = Math.floor((30_000 - 'small result'.length) / 3)
    expect(input.match(new RegExp(`shown_chars="${share}"`, 'g'))).toHaveLength(3)
    expect(input).toContain('decisive')
  })

  it('stubs catalog and errored calls outside the budget, points repeats back, and compacts JSON', () => {
    const catalog = call('aero_list_toolkits', JSON.stringify({ toolkits: Array.from({ length: 200 }, (_, i) => `kit-${i}`) }))
    const failed = call('canrony_measurement_changes', 'canrony_measurement_changes is not available in this conversation.', {}, { isError: true })
    const data = call('canonry_measurement_overview', JSON.stringify({ rows: [{ label: 'Harbor', mention: 3 }] }, null, 2), { limit: 10 })
    const again = call('canonry_measurement_overview', data.resultText, { limit: 10 })
    const input = buildGraderInput({ ...capture, tools: [catalog, failed, data, again], toolCalls: 4 }, truth, question, 1_000)

    expect(input).toMatch(/name="aero_list_toolkits"[^>]*stub="catalog" shortened_for_grader="true" shown_chars="300"/)
    expect(input).toMatch(/name="canrony_measurement_changes" error="true"[^>]*stub="error">/)
    expect(input).toContain('canrony_measurement_changes is not available in this conversation.')
    // The data call got the whole budget, compacted; the repeat points back to it.
    expect(input).toContain('{"rows":[{"label":"Harbor","mention":3}]}')
    expect(input).toMatch(/<tool index="4" [^>]*same_result_as="3">/)
    expect(input).toContain('(the same result as tool 3)')
  })

  it('marks a call captured only as a preview as shortened', () => {
    const preview = { ...call('canonry_measurement_overview', '{"rows":['), resultText: undefined, resultChars: 18_000 }
    expect(buildGraderInput({ ...capture, tools: [preview] }, truth, question)).toContain('shortened_for_grader="true" shown_chars="9"')
  })

  it('tells the grader to judge from what it was shown, and how to read shortened text and per-name counts', () => {
    expect(RUBRIC_SYSTEM_PROMPT).toContain('Never use outside knowledge')
    expect(RUBRIC_SYSTEM_PROMPT).toContain('is unverified, not unsupported')
    expect(RUBRIC_SYSTEM_PROMPT).toContain('Figures stated in the system context are grounded')
    expect(RUBRIC_SYSTEM_PROMPT).toContain('is not the complete population')
    expect(RUBRIC_SYSTEM_PROMPT).toContain('A per-name count written as (N), (Nx) or N times is a count of answers')
    expect(RUBRIC_SYSTEM_PROMPT).toContain('The first N rows of a list the tool or the facts sort by the metric are a valid top or worst N')
    expect(RUBRIC_SYSTEM_PROMPT).toContain('Fail a criterion only for its own concern')
    expect(RUBRIC_SYSTEM_PROMPT).toContain('Headlining or recommending a class-pooled coverage figure fails')
    expect(RUBRIC_SYSTEM_PROMPT).toContain('so does an invented product feature, setting, channel or integration')
    expect(RUBRIC_SYSTEM_PROMPT).not.toMatch(/\u2014/)
  })
})

describe('fairShares', () => {
  it('gives short results their whole length and splits the rest evenly, whatever the order', () => {
    expect(fairShares([100, 50_000, 50_000], 10_100)).toEqual([100, 5_000, 5_000])
    expect(fairShares([50_000, 100, 50_000], 10_100)).toEqual([5_000, 100, 5_000])
    expect(fairShares([10, 20], 1_000)).toEqual([10, 20])
    expect(fairShares([], 1_000)).toEqual([])
    const shares = fairShares([7_000, 9_000, 30_000, 2_000], 12_000)
    expect(shares.reduce((sum, share) => sum + share, 0)).toBeLessThanOrEqual(12_000)
    expect(shares[3]).toBe(2_000)
  })
})

describe('normalizeCriteria', () => {
  it('orders by expected ids, dedupes, and keeps unexpected ids at the end', () => {
    const result = normalizeCriteria(
      [
        { id: 'extra', pass: true, reason: 'x' },
        { id: 'b', pass: true, reason: 'first' },
        { id: 'b', pass: false, reason: 'second' },
      ],
      ['a', 'b'],
    )
    expect(result.map((criterion) => [criterion.id, criterion.pass])).toEqual([
      ['a', false],
      ['b', true],
      ['extra', true],
    ])
  })
})

describe('graderCostUsd', () => {
  it('prices cache writes at 1.25x input and returns null for unknown models', () => {
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 0 }
    expect(graderCostUsd('claude-opus-5', usage)).toBeCloseTo(6.25, 8)
    expect(graderCostUsd('some-other-model', usage)).toBeNull()
  })
})
