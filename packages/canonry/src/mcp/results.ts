import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { ZodError, type ZodIssue } from 'zod'
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
    structuredContent: toStructuredContent(result),
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  }
}

export function errorToolResult(error: unknown): CallToolResult {
  const envelope = toCanonryErrorEnvelope(error)
  return {
    isError: true,
    structuredContent: envelope,
    content: [
      {
        type: 'text',
        text: JSON.stringify(envelope, null, 2),
      },
    ],
  }
}

/** MCP structured content must be an object; preserve the legacy text payload verbatim. */
function toStructuredContent(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { items: value }
  if (value !== null && typeof value === 'object') return value as Record<string, unknown>
  return { value }
}

export async function withToolErrors(handler: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonToolResult(await handler())
  } catch (error) {
    return errorToolResult(error)
  }
}

export function toCanonryErrorEnvelope(error: unknown): CanonryErrorEnvelope {
  if (error instanceof ZodError) {
    return {
      error: {
        code: 'VALIDATION_ERROR',
        message: zodErrorMessage(error),
        details: { issues: error.issues.map(formatZodIssue) },
      },
    }
  }

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
    const { code, message, details } = error.error
    return {
      error: {
        code: typeof code === 'string' ? code : 'API_ERROR',
        message: typeof message === 'string' ? message : 'Canonry API error',
        ...(details !== undefined ? { details } : {}),
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

function formatZodIssue(issue: ZodIssue): { path: string; message: string } {
  return { path: issue.path.map(String).join('.'), message: issue.message }
}

function zodErrorMessage(error: ZodError): string {
  const first = error.issues[0]
  if (!first) return 'Input validation failed'
  const path = first.path.map(String).join('.')
  return path ? `${path}: ${first.message}` : first.message
}
