import crypto from 'node:crypto'
import { agentToolEvents, type DatabaseClient } from '@ainyc/canonry-db'
import type { AgentOptions } from '@mariozechner/pi-agent-core'
import type { ImageContent, TextContent } from '@mariozechner/pi-ai'

export const AeroToolEventStatuses = {
  success: 'success',
  error: 'error',
} as const

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return 0
  }
}

function nonNegativeInteger(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return 0
  return Math.round(value)
}

function resultTextChars(content: readonly (TextContent | ImageContent)[]): number {
  let total = 0
  for (const block of content) {
    if (block.type === 'text') {
      total += block.text.length
    } else {
      total += block.data.length
    }
  }
  return total
}

export interface CreateAeroToolUsageHooksArgs {
  db: DatabaseClient
  projectId?: string
  agentSessionId?: string
  metadata?: Record<string, unknown>
}

/**
 * Durable, best-effort tool-call telemetry for long Aero sessions. The hooks
 * are observational only: they never block, rewrite, or fail the tool result.
 */
export function createAeroToolUsageHooks(
  args: CreateAeroToolUsageHooksArgs,
): Pick<AgentOptions, 'beforeToolCall' | 'afterToolCall'> {
  const startedAt = new Map<string, number>()

  return {
    beforeToolCall: async ({ toolCall }) => {
      startedAt.set(toolCall.id, Date.now())
      return undefined
    },
    afterToolCall: async ({ assistantMessage, toolCall, args: toolArgs, result, isError, context }) => {
      const start = startedAt.get(toolCall.id)
      startedAt.delete(toolCall.id)
      recordAgentToolEvent({
        db: args.db,
        projectId: args.projectId,
        agentSessionId: args.agentSessionId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        assistantResponseId: assistantMessage.responseId,
        provider: assistantMessage.provider,
        model: assistantMessage.model,
        status: isError ? AeroToolEventStatuses.error : AeroToolEventStatuses.success,
        durationMs: start === undefined ? 0 : Date.now() - start,
        argsBytes: jsonBytes(toolArgs),
        resultTextChars: resultTextChars(result.content),
        resultBytes: jsonBytes(result),
        metadata: {
          ...args.metadata,
          toolCount: context.tools?.length ?? 0,
        },
      })
      return undefined
    },
  }
}

interface RecordAgentToolEventArgs {
  db: DatabaseClient
  projectId?: string
  agentSessionId?: string
  toolCallId: string
  toolName: string
  assistantResponseId?: string
  provider?: string
  model?: string
  status: string
  durationMs?: number
  argsBytes?: number
  resultTextChars?: number
  resultBytes?: number
  metadata?: Record<string, unknown>
}

export function recordAgentToolEvent(args: RecordAgentToolEventArgs): void {
  try {
    args.db.insert(agentToolEvents).values({
      id: crypto.randomUUID(),
      projectId: args.projectId,
      agentSessionId: args.agentSessionId,
      toolCallId: args.toolCallId,
      toolName: args.toolName,
      assistantResponseId: args.assistantResponseId,
      provider: args.provider,
      model: args.model,
      status: args.status,
      durationMs: nonNegativeInteger(args.durationMs),
      argsBytes: nonNegativeInteger(args.argsBytes),
      resultTextChars: nonNegativeInteger(args.resultTextChars),
      resultBytes: nonNegativeInteger(args.resultBytes),
      metadata: args.metadata,
      createdAt: new Date().toISOString(),
    }).run()
  } catch {
    // Tool telemetry is diagnostic only; do not fail or modify the tool result.
  }
}
