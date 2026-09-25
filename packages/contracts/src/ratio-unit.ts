import { z } from 'zod'

/**
 * The unit a ratio number carries on the wire.
 *
 * - `fraction`: 0..1, so 0.0207 is 2.07%.
 * - `percent`: 0..100, so 2.07 is 2.07%.
 *
 * The same field name means different things on different endpoints
 * (`percentage` is a fraction in the source reads but 0..100 in the index
 * coverage reads; `citationRate` is a fraction in analytics but 0..100 in the
 * report), so a reader can never infer the unit from the name. Each ratio
 * field declares it on its schema instead, and `formatPercent` takes it.
 */
export const ratioUnitSchema = z.enum(['fraction', 'percent'])
export type RatioUnit = z.infer<typeof ratioUnitSchema>
export const RatioUnits = ratioUnitSchema.enum

/**
 * Schema metadata key for a ratio's unit. Zod copies metadata into JSON
 * Schema, so it reaches the OpenAPI document and MCP output schemas; the `x-`
 * prefix keeps it a valid OpenAPI vendor extension.
 */
export const RATIO_UNIT_META_KEY = 'x-unit'

/**
 * Declares a ratio's unit on a number schema. Apply it last on the number:
 * Zod metadata belongs to one schema instance, so a later `.min()` or `.int()`
 * returns a copy without it. Wrapping in `.optional()` or `.nullable()`
 * afterwards is fine.
 */
function withRatioUnit<T extends z.ZodNumber>(schema: T, unit: RatioUnit): T {
  return schema.meta({ [RATIO_UNIT_META_KEY]: unit })
}

/** A 0..1 share or rate. */
export function fraction<T extends z.ZodNumber = z.ZodNumber>(schema?: T): T {
  return withRatioUnit(schema ?? (z.number() as T), RatioUnits.fraction)
}

/** A 0..100 percent. */
export function percent<T extends z.ZodNumber = z.ZodNumber>(schema?: T): T {
  return withRatioUnit(schema ?? (z.number() as T), RatioUnits.percent)
}

const WRAPPER_TYPES = new Set(['optional', 'nullable', 'default', 'prefault', 'readonly', 'nonoptional', 'catch'])

/** The schema under `.optional()`, `.nullable()`, `.default()` and friends. */
export function unwrapRatioSchema(schema: z.ZodType): z.ZodType {
  let current = schema
  for (let depth = 0; depth < 16; depth++) {
    const def = current._zod.def as { type: string; innerType?: z.ZodType }
    if (!WRAPPER_TYPES.has(def.type) || !def.innerType) return current
    current = def.innerType
  }
  return current
}

/** The unit declared on a number schema (through its wrappers), if any. */
export function ratioUnitOf(schema: z.ZodType): RatioUnit | undefined {
  const unit = z.globalRegistry.get(unwrapRatioSchema(schema))?.[RATIO_UNIT_META_KEY]
  const parsed = ratioUnitSchema.safeParse(unit)
  return parsed.success ? parsed.data : undefined
}

/**
 * Field names that read as a ratio: a name ending in rate, share, ratio,
 * percent, percentage, pct, coverage or fraction, or a bare `ctr`. A number
 * under such a name has to declare its unit, because the name alone says
 * nothing about whether 2.07 means 2.07% or 207%.
 */
export const RATIO_FIELD_NAME_PATTERN = /(?:rate|share|ratio|percent|percentage|pct|coverage|fraction)$|^ctr$/i

/** One node of a JSON Schema document, as `z.toJSONSchema` emits it. */
type JsonSchemaNode = Readonly<Record<string, unknown>>

const COMPOSITION_KEYS = ['anyOf', 'oneOf', 'allOf'] as const
const DEFINITION_KEYS = ['definitions', '$defs'] as const
const REF_DEPTH_LIMIT = 16

function isSchemaNode(value: unknown): value is JsonSchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function schemaNodes(value: unknown): JsonSchemaNode[] {
  if (Array.isArray(value)) return value.filter(isSchemaNode)
  return isSchemaNode(value) ? [value] : []
}

/** Union and intersection members: `.nullable()` and `z.union` land here. */
function compositionMembers(node: JsonSchemaNode): JsonSchemaNode[] {
  return COMPOSITION_KEYS.flatMap(key => schemaNodes(node[key]))
}

/** The element schemas of an array, a single `items` schema or a tuple's list. */
function itemSchemas(node: JsonSchemaNode): JsonSchemaNode[] {
  return schemaNodes(node.items)
}

/** The value schemas of a record. */
function recordValueSchemas(node: JsonSchemaNode): JsonSchemaNode[] {
  const patternValues = isSchemaNode(node.patternProperties) ? Object.values(node.patternProperties) : []
  return [...schemaNodes(node.additionalProperties), ...patternValues.filter(isSchemaNode)]
}

/** The node a local `#/...` JSON pointer names, or undefined when it names nothing here. */
function resolvePointer(root: JsonSchemaNode, ref: string): JsonSchemaNode | undefined {
  if (!ref.startsWith('#/')) return undefined
  let node: unknown = root
  for (const segment of ref.slice(2).split('/')) {
    if (!isSchemaNode(node)) return undefined
    node = node[segment.replace(/~1/g, '/').replace(/~0/g, '~')]
  }
  return isSchemaNode(node) ? node : undefined
}

/**
 * Follows local `$ref`s so a ratio behind a shared definition is judged by
 * what it points at. A reference into another document stays as it is: there
 * is nothing here to read, so it is neither a number nor a declared unit.
 */
function dereference(node: JsonSchemaNode, root: JsonSchemaNode): JsonSchemaNode {
  let current = node
  for (let depth = 0; depth < REF_DEPTH_LIMIT && typeof current.$ref === 'string'; depth++) {
    const target = resolvePointer(root, current.$ref)
    if (target === undefined) return current
    current = target
  }
  return current
}

function isNumberType(type: unknown): boolean {
  const types = Array.isArray(type) ? type : [type]
  return types.includes('number') || types.includes('integer')
}

/**
 * True when the schema is a number, a union holding one, or an array or record
 * whose elements are numbers. An object with named properties is not: each of
 * its properties is judged by its own name.
 */
function holdsNumbers(node: JsonSchemaNode, root: JsonSchemaNode, depth = 0): boolean {
  if (depth > REF_DEPTH_LIMIT) return false
  const schema = dereference(node, root)
  if (isNumberType(schema.type)) return true
  return [...compositionMembers(schema), ...itemSchemas(schema), ...recordValueSchemas(schema)]
    .some(child => holdsNumbers(child, root, depth + 1))
}

/**
 * The unit a schema declares on itself or on the number inside it: a union
 * member (`.nullable()`), an array item or a record value. A value that is not
 * one of the known units counts as no declaration at all.
 */
function declaredUnit(node: JsonSchemaNode, root: JsonSchemaNode, depth = 0): RatioUnit | undefined {
  if (depth > REF_DEPTH_LIMIT) return undefined
  const schema = dereference(node, root)
  const own = ratioUnitSchema.safeParse(schema[RATIO_UNIT_META_KEY])
  if (own.success) return own.data
  for (const child of [...compositionMembers(schema), ...itemSchemas(schema), ...recordValueSchemas(schema)]) {
    const unit = declaredUnit(child, root, depth + 1)
    if (unit !== undefined) return unit
  }
  return undefined
}

function collectUndeclared(
  node: JsonSchemaNode,
  path: string,
  root: JsonSchemaNode,
  notARatio: Readonly<Record<string, string>>,
  out: Set<string>,
): void {
  const properties = isSchemaNode(node.properties) ? node.properties : {}
  for (const [key, child] of Object.entries(properties)) {
    if (!isSchemaNode(child)) continue
    const childPath = `${path}.${key}`
    if (
      RATIO_FIELD_NAME_PATTERN.test(key)
      && !Object.hasOwn(notARatio, key)
      && holdsNumbers(child, root)
      && declaredUnit(child, root) === undefined
    ) {
      out.add(childPath)
    }
    collectUndeclared(child, childPath, root, notARatio, out)
  }
  for (const item of itemSchemas(node)) collectUndeclared(item, `${path}[]`, root, notARatio, out)
  for (const value of recordValueSchemas(node)) collectUndeclared(value, `${path}.*`, root, notARatio, out)
  for (const member of compositionMembers(node)) collectUndeclared(member, path, root, notARatio, out)
}

/**
 * Every ratio-named number in a JSON Schema document that does not declare its
 * unit, as sorted paths from `rootPath`: `.key` for a property, `[]` for an
 * array item, `.*` for a record value, and `#/definitions/<name>` for a shared
 * definition. A field counts when its name matches `RATIO_FIELD_NAME_PATTERN`
 * and its schema holds numbers (directly, through `.nullable()` or a union, or
 * as the elements of an array or record); it is declared when that number
 * carries a known `x-unit`.
 *
 * `notARatio` maps a field name that reads as a ratio but is not one (a day
 * count, a multiplier) to the reason, and exempts that name everywhere.
 */
export function undeclaredRatioFields(
  jsonSchema: JsonSchemaNode,
  rootPath: string,
  notARatio: Readonly<Record<string, string>> = {},
): string[] {
  const out = new Set<string>()
  collectUndeclared(jsonSchema, rootPath, jsonSchema, notARatio, out)
  for (const key of DEFINITION_KEYS) {
    const definitions = isSchemaNode(jsonSchema[key]) ? jsonSchema[key] : {}
    for (const [name, definition] of Object.entries(definitions)) {
      if (isSchemaNode(definition)) collectUndeclared(definition, `${rootPath}#/${key}/${name}`, jsonSchema, notARatio, out)
    }
  }
  return [...out].sort()
}
