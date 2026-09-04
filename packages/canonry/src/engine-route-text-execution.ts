import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
} from '@mariozechner/pi-ai'
import type { EngineConnectionConfig } from '@ainyc/canonry-contracts'
import { getSharedProviderExecutionGate } from './provider-execution-gate.js'

type TextRouteConnection = Pick<EngineConnectionConfig, 'id' | 'quota'>

/** The credential boundary, not the individual configured route, owns the budget. */
export function engineRouteConnectionScope(connection: TextRouteConnection): string {
  return `connection:${connection.id}`
}

export function getEngineRouteTextExecutionGate(connection: TextRouteConnection) {
  return getSharedProviderExecutionGate(
    engineRouteConnectionScope(connection),
    connection.quota.maxConcurrency,
    connection.quota.maxRequestsPerMinute,
  )
}

/**
 * One execution boundary for every generic OpenAI-compatible text call.
 * Native providers deliberately never pass through this route-only helper.
 */
export function runEngineRouteText<T>(
  connection: TextRouteConnection,
  task: () => Promise<T>,
): Promise<T> {
  return getEngineRouteTextExecutionGate(connection).run(task)
}

/**
 * `streamSimple` returns before its upstream stream completes, so `run()` by
 * itself would release the connection slot too early. Proxy every event and
 * hold the shared gate through the source stream's terminal result instead.
 */
export function streamEngineRouteText(
  connection: TextRouteConnection,
  source: () => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream()
  void runEngineRouteText(connection, async () => {
    const input = await source()
    for await (const event of input) output.push(event)
    output.end(await input.result())
  }).catch(() => {
    // Provider stream functions are required to encode errors as stream events.
    // This only handles an invalid custom stream function without leaking a gate.
    output.end()
  })
  return output
}
