import { Type, type TSchema } from '@sinclair/typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import type { ApiClient } from '../client.js'
import {
  CanonryMcpToolNames,
  type CanonryMcpRegistryTool,
  type CanonryMcpTool,
  type CanonryMcpToolName,
} from '../mcp/tool-registry.js'

const MAX_TOOL_RESULT_CHARS = 20_000
const TRUNCATION_NOTE = '... (truncated — result too large)'

/** Pretty JSON, exactly what the model reads in the tool-result text. */
function serializeResult(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/** The object key whose array value serializes largest (the one worth trimming). */
function largestArrayKey(obj: Record<string, unknown>): string | undefined {
  let best: string | undefined
  let bestLen = -1
  for (const [k, v] of Object.entries(obj)) {
    if (!Array.isArray(v)) continue
    const len = serializeResult(v).length
    if (len > bestLen) {
      bestLen = len
      best = k
    }
  }
  return best
}

/** Drop WHOLE trailing rows until `render(kept)` fits the cap (or nothing is left). */
function trimRowsToFit(rows: readonly unknown[], render: (kept: unknown[]) => string): unknown[] {
  let kept = rows.slice()
  while (kept.length > 0 && render(kept).length > MAX_TOOL_RESULT_CHARS) {
    kept = kept.slice(0, -1)
  }
  return kept
}

/**
 * Render a tool result as JSON text under the size cap WITHOUT cutting a row
 * mid-structure. The previous behavior blind-sliced the serialized string,
 * which could split an array element halfway, hand the model invalid JSON, and
 * silently drop a cited evidence row mid-object. Structure-aware instead:
 *  - object whose largest field is an array: drop WHOLE trailing rows from that
 *    array until it fits, stamping `__truncated` + `__omittedRows` on the object;
 *  - top-level array: same, wrapped as `{ items, __truncated, __omittedRows }`;
 *  - any other still-oversized value (a giant scalar / string with nothing
 *    structured to drop): a marked string slice, the last resort.
 * Every RETAINED row stays byte-intact and the structured output stays parseable
 * JSON. Only the model-facing text is trimmed; the programmatic `details`
 * envelope is never touched.
 */
export function truncateToolResult(details: unknown): string {
  const full = serializeResult(details)
  if (full.length <= MAX_TOOL_RESULT_CHARS) return full

  // Top-level array: trim whole elements, wrap with the marker (always fits, an
  // empty `items` is tiny).
  if (Array.isArray(details)) {
    const kept = trimRowsToFit(details, (rows) =>
      serializeResult({ items: rows, __truncated: true, __omittedRows: details.length - rows.length }),
    )
    return serializeResult({ items: kept, __truncated: true, __omittedRows: details.length - kept.length })
  }

  // Object whose largest field is an array (the ads-artifact shape): trim that
  // array by whole rows, keep every other field intact.
  if (details && typeof details === 'object') {
    const obj = details as Record<string, unknown>
    const arrayKey = largestArrayKey(obj)
    if (arrayKey) {
      const rows = obj[arrayKey] as unknown[]
      const kept = trimRowsToFit(rows, (r) =>
        serializeResult({ ...obj, [arrayKey]: r, __truncated: true, __omittedRows: rows.length - r.length }),
      )
      const out = serializeResult({
        ...obj,
        [arrayKey]: kept,
        __truncated: true,
        __omittedRows: rows.length - kept.length,
      })
      // Falls through to the last resort only when the non-array fields ALONE
      // already blow the cap (nothing structured left to drop).
      if (out.length <= MAX_TOOL_RESULT_CHARS) return out
    }
  }

  return full.slice(0, MAX_TOOL_RESULT_CHARS) + '\n' + TRUNCATION_NOTE
}

function textResult<T>(details: T): AgentToolResult<T> {
  return {
    content: [{ type: 'text', text: truncateToolResult(details) }],
    details,
  }
}

export interface AgentMcpAdapterContext {
  client: ApiClient
  projectName: string
}

interface JsonObjectSchema {
  type?: string
  properties?: Record<string, unknown>
  required?: string[]
  [k: string]: unknown
}

/**
 * MCP tools take `project` as input; Aero closes over `projectName` so the
 * LLM cannot target the wrong project. This strips the `project` property
 * (and its `required` entry) from a JSON Schema so the visible schema
 * matches what Aero sees, while the runtime injects `ctx.projectName`
 * before calling the underlying handler.
 */
function stripProjectFromJsonSchema(jsonSchema: unknown): {
  schema: unknown
  hadProject: boolean
} {
  if (!jsonSchema || typeof jsonSchema !== 'object') {
    return { schema: jsonSchema, hadProject: false }
  }
  const obj = jsonSchema as JsonObjectSchema
  const properties = obj.properties
  if (!properties || typeof properties !== 'object' || !('project' in properties)) {
    return { schema: jsonSchema, hadProject: false }
  }
  const { project: _project, ...remainingProps } = properties as Record<string, unknown>
  const required = Array.isArray(obj.required)
    ? obj.required.filter((name) => name !== 'project')
    : obj.required
  const stripped: JsonObjectSchema = { ...obj, properties: remainingProps }
  if (required === undefined) {
    delete stripped.required
  } else {
    stripped.required = required as string[]
  }
  return { schema: stripped, hadProject: true }
}

/**
 * Convert a CanonryMcpTool into an AgentTool that pi-agent-core can register.
 *
 * - Strips top-level `project` from the schema and injects `ctx.projectName`
 *   so the LLM cannot target the wrong project (mirrors the existing Aero
 *   tool pattern).
 * - Wraps the JSON Schema in `Type.Unsafe` so pi-agent-core's TSchema-typed
 *   `parameters` field accepts it without conversion.
 * - Wraps the handler result in pi-agent-core's `AgentToolResult` envelope
 *   with a 20 KB truncation guard.
 */
export function mcpToAgentTool(
  tool: CanonryMcpTool,
  ctx: AgentMcpAdapterContext,
): AgentTool {
  const { schema: visibleSchema, hadProject } = stripProjectFromJsonSchema(tool.inputJsonSchema)
  const parameters = Type.Unsafe<Record<string, unknown>>(visibleSchema as object) as TSchema

  const execute = async (
    _toolCallId: string,
    params: Record<string, unknown>,
  ): Promise<AgentToolResult<unknown>> => {
    const handlerInput = hadProject ? { ...params, project: ctx.projectName } : params
    const result = await tool.handler(ctx.client, handlerInput as never)
    return textResult(result)
  }

  return {
    name: tool.name,
    label: tool.title,
    description: tool.description,
    parameters,
    execute,
  } as AgentTool
}

/**
 * Tools that exist in the MCP registry for completeness but should not be
 * exposed to the built-in Aero agent. Aero clearing its own conversation is
 * a foot-gun (it would erase the user's context mid-turn).
 */
export const AERO_EXCLUDED_MCP_TOOLS: ReadonlySet<CanonryMcpToolName> = new Set([
  CanonryMcpToolNames.canonry_agent_clear,
])

export interface BuildMcpAgentToolsOptions {
  /** Filter to read-only tools when true. */
  readOnly?: boolean
  /** Optional allow-list for profile-specific tool surfaces. */
  includeNames?: ReadonlySet<CanonryMcpToolName>
}

/**
 * Build the AgentTool list Aero registers — every MCP tool except the
 * exclusion set, optionally narrowed to reads only. Adding a new tool to
 * `tool-registry.ts` is enough to make it available to Aero; no separate
 * registration is required.
 */
export function buildMcpAgentTools(
  registry: readonly CanonryMcpRegistryTool[],
  ctx: AgentMcpAdapterContext,
  opts: BuildMcpAgentToolsOptions = {},
): AgentTool[] {
  return registry
    .filter((tool) => !AERO_EXCLUDED_MCP_TOOLS.has(tool.name))
    .filter((tool) => (opts.includeNames ? opts.includeNames.has(tool.name) : true))
    .filter((tool) => (opts.readOnly ? tool.access === 'read' : true))
    .map((tool) => mcpToAgentTool(tool, ctx))
}
