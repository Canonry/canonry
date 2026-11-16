import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserSession } from '../src/browser.js'

// The provider SDKs are replaced so each loop's own decisions can be checked: what it does
// when a provider gates an action, and when a call outlives the run's time limit.
const openaiCreate = vi.fn()
const claudeCreate = vi.fn()
const geminiGenerate = vi.fn()
vi.mock('openai', () => ({ default: class { responses = { create: openaiCreate } } }))
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: claudeCreate } } }))
vi.mock('@google/genai', () => ({ Environment: { ENVIRONMENT_BROWSER: 'ENVIRONMENT_BROWSER' }, GoogleGenAI: class { models = { generateContent: geminiGenerate } } }))

const { runClaudeAgent, runGeminiAgent, runOpenAIAgent } = await import('../src/agents.js')

afterEach(() => {
  vi.resetAllMocks()
})

/** A stand-in browser that records every method an agent loop calls on it. */
function fakeSession() {
  const calls: string[] = []
  const target: Record<string, unknown> = { viewport: { width: 1280, height: 800 } }
  const session = new Proxy(target, {
    get(own, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined
      if (prop in own) return own[prop]
      return (..._args: unknown[]) => {
        calls.push(prop)
        if (prop === 'screenshot') return Promise.resolve(Buffer.from('jpeg'))
        if (prop === 'url') return Promise.resolve('https://canonry.ai/')
        return prop === 'record' ? undefined : Promise.resolve(undefined)
      }
    },
  })
  return { session: session as unknown as BrowserSession, calls }
}

const runInput = (session: BrowserSession, overrides: { deadline?: number; signal?: AbortSignal } = {}) => ({
  session,
  startUrl: 'https://canonry.ai/agency-access',
  task: 'Request agency access',
  model: 'm',
  apiKey: 'k',
  deadline: overrides.deadline ?? Date.now() + 60_000,
  maxTurns: 10,
  signal: overrides.signal,
})

/** A provider call that never answers: it rejects only when its signal aborts. */
const hangsUntilAborted = (_params: unknown, options: { signal: AbortSignal }) =>
  new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Request was aborted.'))))

describe('provider safety gates stop an unattended run before the gated action', () => {
  it('OpenAI: a pending safety check ends the run; nothing is clicked and nothing is acknowledged', async () => {
    const { session, calls } = fakeSession()
    openaiCreate.mockResolvedValueOnce({
      id: 'r1',
      status: 'completed',
      output: [{ type: 'computer_call', call_id: 'c1', actions: [{ type: 'click', x: 10, y: 10, button: 'left' }], pending_safety_checks: [{ id: 's1', code: 'malicious_instructions', message: 'The page tells the agent to act against the user.' }] }],
      usage: { input_tokens: 120, output_tokens: 8 },
    })
    const out = await runOpenAIAgent(runInput(session))
    expect(out).toMatchObject({ stop: 'safety-check', stopDetail: 'malicious_instructions: The page tells the agent to act against the user.', safetyChecks: 1, actions: 0, turns: 1 })
    expect(out.usage).toMatchObject({ requests: 1, inputTokens: 120, outputTokens: 8 })
    expect(calls).toEqual(['screenshot'])
    expect(openaiCreate).toHaveBeenCalledTimes(1)
  })

  it('Gemini: an action marked require_confirmation ends the run before it runs', async () => {
    const { session, calls } = fakeSession()
    geminiGenerate.mockResolvedValueOnce({
      candidates: [{
        finishReason: 'STOP',
        content: { role: 'model', parts: [{ functionCall: { name: 'click_at', args: { x: 500, y: 500, safety_decision: { decision: 'require_confirmation', explanation: 'Submits user data to a third party.' } } } }] },
      }],
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 3 },
    })
    const out = await runGeminiAgent(runInput(session))
    expect(out).toMatchObject({ stop: 'safety-check', stopDetail: 'require_confirmation: Submits user data to a third party.', safetyChecks: 1, actions: 0 })
    expect(calls).toEqual(['screenshot'])
    expect(geminiGenerate).toHaveBeenCalledTimes(1)
  })
})

describe('the time limit aborts calls already in flight', () => {
  it('OpenAI: a call still running at the deadline ends the run at the limit, keeping the usage so far', async () => {
    const { session } = fakeSession()
    openaiCreate
      .mockResolvedValueOnce({ id: 'r1', status: 'completed', output: [{ type: 'computer_call', call_id: 'c1', actions: [{ type: 'wait' }] }], usage: { input_tokens: 90, output_tokens: 4 } })
      .mockImplementationOnce(hangsUntilAborted)
    const deadline = Date.now() + 150
    const out = await runOpenAIAgent(runInput(session, { deadline, signal: AbortSignal.timeout(200) }))
    expect(out).toMatchObject({ stop: 'time-limit', turns: 1, actions: 1, usage: { requests: 1, inputTokens: 90 } })
    // Each call is also given only the run's remaining time.
    const options = openaiCreate.mock.calls[1]?.[1] as { timeout: number; signal: AbortSignal }
    expect(options.timeout).toBeLessThanOrEqual(1_000)
    expect(options.signal.aborted).toBe(true)
  })

  it('Claude: a first call that outlives the deadline ends the run at the limit, not as a broken run', async () => {
    const { session } = fakeSession()
    claudeCreate.mockImplementationOnce(hangsUntilAborted)
    const out = await runClaudeAgent(runInput(session, { deadline: Date.now() + 100, signal: AbortSignal.timeout(150) }))
    expect(out).toMatchObject({ stop: 'time-limit', turns: 0, actions: 0 })
  })

  it('reads an abort before the deadline as a cancel', async () => {
    const { session } = fakeSession()
    claudeCreate.mockImplementationOnce(hangsUntilAborted)
    const out = await runClaudeAgent(runInput(session, { deadline: Date.now() + 60_000, signal: AbortSignal.timeout(50) }))
    expect(out.stop).toBe('cancelled')
  })
})

describe('terminal states that are not a finish', () => {
  it.each([
    ['a finished answer', { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ANSWER: x' }] }], output_text: 'ANSWER: x' }, { stop: 'final', answer: 'ANSWER: x' }],
    ['a refusal with no browser action', { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'I can’t help with that.' }] }], output_text: '' }, { stop: 'refusal', answer: 'I can’t help with that.', stopDetail: 'I can’t help with that.' }],
    ['a response cut short', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [], output_text: 'ANSWER: par' }, { stop: 'incomplete', answer: 'ANSWER: par', stopDetail: 'max_output_tokens' }],
  ])('OpenAI: %s', async (_label, resp, want) => {
    const { openAIResponseStop } = await import('../src/agents.js')
    expect(openAIResponseStop(resp)).toEqual(want)
  })

  it.each([
    [undefined, 'final'], ['STOP', 'final'], ['MAX_TOKENS', 'incomplete'], ['SAFETY', 'refusal'], ['PROHIBITED_CONTENT', 'refusal'], ['MALFORMED_FUNCTION_CALL', 'malformed_function_call'],
  ])('Gemini finish reason %s → %s', async (reason, want) => {
    const { geminiFinishStop } = await import('../src/agents.js')
    expect(geminiFinishStop(reason)).toBe(want)
  })

  it.each([
    ['end_turn', 'final'], ['max_tokens', 'incomplete'], ['model_context_window_exceeded', 'incomplete'], ['refusal', 'refusal'],
  ])('Claude stop reason %s → %s', async (reason, want) => {
    const { claudeFinishStop } = await import('../src/agents.js')
    expect(claudeFinishStop(reason)).toBe(want)
  })

  it.each([
    ['no safety decision', {}, null],
    ['a decision marked allowed', { safety_decision: { decision: 'allowed' } }, null],
    ['one that needs confirmation', { safety_decision: { decision: 'require_confirmation', explanation: 'Submits user data.' } }, 'require_confirmation: Submits user data.'],
    ['a blocked action', { safety_decision: { decision: 'blocked' } }, 'blocked'],
  ])('Gemini safety: %s', async (_label, args, want) => {
    const { geminiSafetyStop } = await import('../src/agents.js')
    expect(geminiSafetyStop(args)).toBe(want)
  })
})
