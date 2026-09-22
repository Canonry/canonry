/** Offline evaluator for captured `canonry agent ask --format json` events. */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { describeError, evaluateAgentTrace, type AgentEvaluationTrace } from '@ainyc/canonry-contracts'

const expectationSchema = z.object({
  requiredTools: z.array(z.string().min(1)),
  forbiddenTools: z.array(z.string().min(1)),
  requiredText: z.array(z.string().min(1)),
  forbiddenText: z.array(z.string().min(1)),
  maxToolCalls: z.number().int().positive(),
}).strict()
const eventSchema = z.object({
  type: z.string(),
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
  message: z.unknown().optional(),
  status: z.object({ reason: z.string(), modelCalls: z.number().int().nonnegative(), durationMs: z.number().nonnegative() }).optional(),
})
const messageSchema = z.object({ role: z.string(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })) })

try {
  const [expectationsPath, tracePath] = process.argv.slice(2)
  if (!expectationsPath || !tracePath) throw new Error('Usage: pnpm --filter @canonry/canonry exec tsx scripts/eval-aero.ts <expectations.json> <events.jsonl>')
  const expectation = expectationSchema.parse(JSON.parse(readFileSync(expectationsPath, 'utf8')))
  const trace: AgentEvaluationTrace = { answer: '', tools: [], modelCalls: 0, durationMs: 0 }
  let closed = false
  let completed = false
  let error = false
  for (const line of readFileSync(tracePath, 'utf8').split('\n').filter(line => line.trim())) {
    const event = eventSchema.parse(JSON.parse(line))
    if (event.type === 'tool_execution_end' && event.toolName) trace.tools.push({ name: event.toolName, isError: event.isError === true })
    if (event.type === 'message_end') {
      const message = messageSchema.safeParse(event.message)
      if (message.success && message.data.role === 'assistant') trace.answer += message.data.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('') + '\n'
    }
    if (event.type === 'aero_turn_status' && event.status) {
      completed = event.status.reason === 'completed'
      trace.modelCalls = event.status.modelCalls
      trace.durationMs = event.status.durationMs
    }
    if (event.type === 'stream_close') closed = true
    if (event.type === 'error') error = true
  }
  const evaluation = evaluateAgentTrace(trace, expectation)
  const passed = evaluation.passed && completed && closed && !error
  console.log(JSON.stringify({ ...evaluation, completed, closed, error, passed }, null, 2))
  if (!passed) process.exitCode = 1
} catch (error) {
  console.error(JSON.stringify({ error: describeError(error) }))
  process.exitCode = 2
}
