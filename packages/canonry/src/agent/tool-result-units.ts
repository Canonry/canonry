import { buildOpenApiDocument } from '@ainyc/canonry-api-routes'
import { RATIO_UNIT_META_KEY, formatPercent, ratioUnitSchema, type RatioUnit } from '@ainyc/canonry-contracts'

/**
 * Aero reads tool results as JSON text, and a bare ratio there is ambiguous:
 * the same field name is a 0..1 fraction on one endpoint and 0..100 on
 * another, so the model read a 0.0207 source share as "0.02%" when it is
 * 2.07%. Every ratio field declares its unit on its schema (`x-unit`, see
 * contracts `ratio-unit.ts`), and the OpenAPI response schema of each tool's
 * operation carries it. This renders those numbers as the percent text the
 * CLI, dashboard and reports show (`formatPercent`), in the model-facing text
 * only; the tool's programmatic result keeps the raw number.
 */

type JsonSchema = Record<string, unknown>

interface OpenApiDocument {
  paths: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }> }>>
  components?: { schemas?: Record<string, JsonSchema> }
}

const SUCCESS_STATUSES = ['200', '201', '202'] as const
const MAX_DEPTH = 40
const MAX_REF_HOPS = 8

let cachedDocument: OpenApiDocument | undefined

function openApiDocument(): OpenApiDocument {
  cachedDocument ??= buildOpenApiDocument() as unknown as OpenApiDocument
  return cachedDocument
}

/** The component schemas `$ref`s resolve against. */
export function responseComponents(): Record<string, JsonSchema> {
  return openApiDocument().components?.schemas ?? {}
}

/**
 * The JSON response schemas of a tool's operations (`GET /api/v1/...`), in
 * order. An operation with no JSON success response contributes nothing.
 */
export function responseSchemasFor(operations: readonly string[]): JsonSchema[] {
  const paths = openApiDocument().paths
  return operations.flatMap((operation) => {
    const space = operation.indexOf(' ')
    if (space < 0) return []
    const responses = paths[operation.slice(space + 1)]?.[operation.slice(0, space).toLowerCase()]?.responses
    const schema = SUCCESS_STATUSES.map(status => responses?.[status]?.content?.['application/json']?.schema).find(Boolean)
    return schema ? [schema] : []
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function resolve(schema: JsonSchema, components: Record<string, JsonSchema>): JsonSchema {
  let current = schema
  for (let hop = 0; hop < MAX_REF_HOPS && typeof current.$ref === 'string'; hop++) {
    const next = components[current.$ref.replace('#/components/schemas/', '')]
    if (!next) break
    current = next
  }
  return current
}

function members(schema: JsonSchema): JsonSchema[] {
  return (['allOf', 'anyOf', 'oneOf'] as const).flatMap(key => (Array.isArray(schema[key]) ? schema[key] as JsonSchema[] : []))
}

function unitOf(schema: JsonSchema, components: Record<string, JsonSchema>): RatioUnit | undefined {
  const own = ratioUnitSchema.safeParse(schema[RATIO_UNIT_META_KEY])
  if (own.success) return own.data
  for (const member of members(schema)) {
    const unit = unitOf(resolve(member, components), components)
    if (unit) return unit
  }
  return undefined
}

function render(schema: JsonSchema, value: unknown, components: Record<string, JsonSchema>, depth: number): unknown {
  if (depth > MAX_DEPTH) return value
  const node = resolve(schema, components)
  if (typeof value === 'number') {
    const unit = unitOf(node, components)
    return unit ? formatPercent(value, unit) : value
  }
  // A union member renders only the fields it declares; a number another member
  // already turned into text is no longer a number, so members never compete.
  let current = value
  for (const member of members(node)) current = render(member, current, components, depth + 1)

  if (Array.isArray(current) && isRecord(node.items)) {
    const items = node.items
    let changed = false
    const out = current.map((item: unknown) => {
      const rendered = render(items, item, components, depth + 1)
      if (rendered !== item) changed = true
      return rendered
    })
    return changed ? out : current
  }
  if (isRecord(current)) {
    const properties = isRecord(node.properties) ? node.properties as Record<string, JsonSchema> : {}
    const extra = isRecord(node.additionalProperties) ? node.additionalProperties : undefined
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(current)) {
      const childSchema = properties[key] ?? extra
      const rendered = childSchema ? render(childSchema, child, components, depth + 1) : child
      if (rendered !== child) changed = true
      out[key] = rendered
    }
    return changed ? out : current
  }
  return current
}

/**
 * Renders every number `schema` declares a ratio as its percent text. Returns
 * the value itself when nothing changes, and never mutates it.
 */
export function renderRatioUnits(schema: JsonSchema | undefined, value: unknown, components: Record<string, JsonSchema> = {}): unknown {
  return schema ? render(schema, value, components, 0) : value
}
