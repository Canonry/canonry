import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { CliError } from '../cli-error.js'

type CanonryErrorEnvelope = {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export function jsonToolResult(value: unknown): CallToolResult {
  const result = value === undefined ? { ok: true } : value
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  }
}

export function errorToolResult(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify(toCanonryErrorEnvelope(error), null, 2),
      },
    ],
  }
}

export async function withToolErrors(handler: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonToolResult(await handler())
  } catch (error) {
    return errorToolResult(error)
  }
}

export function toCanonryErrorEnvelope(error: unknown): CanonryErrorEnvelope {
  if (error instanceof CliError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    }
  }

  if (hasErrorEnvelope(error)) {
    return {
      error: {
        code: String(error.error.code ?? 'API_ERROR'),
        message: String(error.error.message ?? 'Canonry API error'),
        ...(error.error.details !== undefined ? { details: error.error.details } : {}),
      },
    }
  }

  if (error instanceof Error) {
    return {
      error: {
        code: 'MCP_TOOL_ERROR',
        message: error.message,
      },
    }
  }

  return {
    error: {
      code: 'MCP_TOOL_ERROR',
      message: 'Unknown MCP tool error',
    },
  }
}

function hasErrorEnvelope(value: unknown): value is { error: { code?: unknown; message?: unknown; details?: unknown } } {
  if (!value || typeof value !== 'object' || !('error' in value)) return false
  const error = (value as { error?: unknown }).error
  return Boolean(error && typeof error === 'object')
}
