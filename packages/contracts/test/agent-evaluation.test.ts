import { expect, it } from 'vitest'
import { evaluateAgentTrace } from '../src/agent-evaluation.js'

const expected = { requiredTools: ['aero_inspect_view'], forbiddenTools: ['canonry_run_trigger'], requiredText: ['0/10', 'non-brand', 'model-changed'], forbiddenText: ['50% overall'], maxToolCalls: 2 }
it('grades exact known evidence and tool use with reproducible counts', () => {
  const result = evaluateAgentTrace({ answer: 'Non-brand 0/10. Comparison unavailable: model-changed.', tools: [{ name: 'aero_inspect_view', isError: false }], modelCalls: 2, durationMs: 42 }, expected)
  expect(result).toMatchObject({ passed: true, passedChecks: 8, totalChecks: 8, toolCalls: 1, modelCalls: 2, durationMs: 42 })
})
it('rejects fabricated pooled conclusions, absent reads, forbidden writes and excess calls', () => {
  const result = evaluateAgentTrace({ answer: '50% overall', tools: Array.from({ length: 3 }, () => ({ name: 'canonry_run_trigger', isError: true })), modelCalls: 4, durationMs: 100 }, expected)
  expect(result).toMatchObject({ passed: false, passedChecks: 0, totalChecks: 8, toolCalls: 3 })
})
