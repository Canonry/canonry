import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { ApiClient } from '../client.js'
import { canonryMcpTools } from '../mcp/tool-registry.js'
import { buildMcpAgentTools } from './mcp-to-agent-tool.js'

/**
 * Context Aero tools close over so the LLM can never target a different
 * project. The MCP-to-agent adapter strips `project` from each tool's
 * visible schema and injects `projectName` at call time.
 */
export interface ToolContext {
  client: ApiClient
  projectName: string
}

/**
 * Read-only Aero tools — every read tool from the MCP registry, with the
 * Aero-excluded set filtered out. Adding a new read tool to
 * `mcp/tool-registry.ts` automatically exposes it here.
 */
export function buildReadTools(ctx: ToolContext): AgentTool[] {
  return buildMcpAgentTools(canonryMcpTools, ctx, { readOnly: true })
}

/**
 * Full tool set — every read + write tool from the MCP registry, minus the
 * Aero-excluded set (e.g., `canonry_agent_clear`, which would erase the
 * operator's context mid-turn). New MCP tools flow into Aero automatically.
 */
export function buildAllTools(ctx: ToolContext): AgentTool[] {
  return buildMcpAgentTools(canonryMcpTools, ctx)
}
