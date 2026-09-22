/** Deterministic checks for saved or replayed analyst turns. No model judges. */
export interface AgentEvaluationExpectation {
  requiredTools: string[]
  forbiddenTools: string[]
  requiredText: string[]
  forbiddenText: string[]
  maxToolCalls: number
}

export interface AgentEvaluationTrace {
  answer: string
  tools: Array<{ name: string; isError: boolean }>
  modelCalls: number
  durationMs: number
}

export function evaluateAgentTrace(trace: AgentEvaluationTrace, expectation: AgentEvaluationExpectation) {
  const checks = [
    ...expectation.requiredTools.map(name => ({ name: `used:${name}`, passed: trace.tools.some(tool => tool.name === name && !tool.isError) })),
    ...expectation.forbiddenTools.map(name => ({ name: `avoided:${name}`, passed: !trace.tools.some(tool => tool.name === name) })),
    ...expectation.requiredText.map(text => ({ name: `included:${text}`, passed: trace.answer.toLocaleLowerCase().includes(text.toLocaleLowerCase()) })),
    ...expectation.forbiddenText.map(text => ({ name: `excluded:${text}`, passed: !trace.answer.toLocaleLowerCase().includes(text.toLocaleLowerCase()) })),
    { name: 'tool-budget', passed: trace.tools.length <= expectation.maxToolCalls },
    { name: 'tool-success', passed: trace.tools.every(tool => !tool.isError) },
  ]
  return {
    passed: checks.every(check => check.passed),
    passedChecks: checks.filter(check => check.passed).length,
    totalChecks: checks.length,
    checks,
    toolCalls: trace.tools.length,
    modelCalls: trace.modelCalls,
    durationMs: trace.durationMs,
  }
}
