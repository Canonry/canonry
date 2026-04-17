import { Agent, type AgentOptions } from '@mariozechner/pi-agent-core'

export type { AgentEvent, AgentMessage, AgentState, AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'

export interface AeroAgentOptions extends AgentOptions {
  /** Canonry project name this session is scoped to. Used downstream for tool ACLs and session persistence. */
  projectName: string
}

/**
 * Construct a pi-agent-core `Agent` scoped to a canonry project.
 *
 * Stack 1 scaffold: returns a vanilla `Agent`. Upcoming stacks will wire
 * `convertToLlm`, `transformContext`, persistence via event subscription,
 * and the `beforeToolCall` policy gate.
 */
export function createAeroAgent(options: AeroAgentOptions): Agent {
  const { projectName: _projectName, ...agentOptions } = options
  return new Agent(agentOptions)
}
