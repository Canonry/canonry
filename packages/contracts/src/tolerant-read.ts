import { z } from 'zod'

/**
 * What a tolerant reader returns for a response DTO of type `T`: the same
 * shape, with every closed set of values (an enum, a literal) widened to its
 * primitive, since a newer server may send a value this build never knew.
 */
export type TolerantRead<T> =
  T extends string ? string
    : T extends number ? number
      : T extends boolean ? boolean
        : T extends null | undefined ? T
          : T extends readonly (infer Item)[] ? TolerantRead<Item>[]
            : T extends object ? { [Key in keyof T]: TolerantRead<T[Key]> }
              : T

export interface TolerantReadOptions {
  /**
   * Objects, matched by identity, that keep the keys they do not declare,
   * each value checked against the paired schema. Use it for an object keyed
   * by an open set, such as counts keyed by outcome, where dropping a key a
   * newer server added would leave the known keys summing to less than the
   * total they describe.
   */
  openKeys?: ReadonlyArray<readonly [z.ZodObject, z.ZodType]>
}

/** A schema whose `parse` returns the tolerant read type and that is still an object schema. */
export type TolerantReadSchema<T extends z.ZodObject> = z.ZodType<TolerantRead<z.output<T>>> & z.ZodObject

const WRAPPER_TYPES = new Set(['optional', 'nullable', 'default', 'prefault', 'readonly', 'catch', 'nonoptional'])
const DEPTH_LIMIT = 64

type Def = { type: string } & Record<string, unknown>

function defOf(schema: z.ZodType): Def {
  return schema._zod.def as unknown as Def
}

function cloneWith(schema: z.ZodType, changes: Record<string, unknown>): z.ZodType {
  return schema.clone({ ...defOf(schema), ...changes } as unknown as Parameters<z.ZodType['clone']>[0])
}

function openPrimitive(values: readonly unknown[]): z.ZodType | undefined {
  if (values.length === 0) return undefined
  if (values.every(value => typeof value === 'string')) return z.string()
  if (values.every(value => typeof value === 'number')) return z.number()
  if (values.every(value => typeof value === 'boolean')) return z.boolean()
  return undefined
}

function walk(schema: z.ZodType, open: ReadonlyMap<z.ZodType, z.ZodType>, memo: Map<z.ZodType, z.ZodType>, depth: number): z.ZodType {
  if (depth > DEPTH_LIMIT) throw new Error(`tolerantReadSchema: schema nesting exceeds ${DEPTH_LIMIT} levels`)
  const cached = memo.get(schema)
  if (cached) return cached
  const next = (child: z.ZodType) => walk(child, open, memo, depth + 1)
  const def = defOf(schema)
  let result: z.ZodType = schema
  if (def.type === 'object') {
    // Rebuilt in the default strip mode: a key this reader does not declare is
    // dropped rather than rejecting the response. Cross-field refinements are
    // request rules and are not carried over.
    // A schema that already accepts extra keys (a catchall other than `never`)
    // keeps accepting them.
    const shape = Object.fromEntries(Object.entries((schema as z.ZodObject).shape).map(([key, child]) => [key, next(child as z.ZodType)]))
    const declared = def.catchall as z.ZodType | undefined
    const catchall = open.get(schema) ?? (declared && defOf(declared).type !== 'never' ? next(declared) : undefined)
    result = catchall ? z.object(shape).catchall(catchall) : z.object(shape)
  } else if (WRAPPER_TYPES.has(def.type)) {
    const inner = def.innerType as z.ZodType
    const mapped = next(inner)
    result = mapped === inner ? schema : cloneWith(schema, { innerType: mapped })
  } else if (def.type === 'array') {
    const element = def.element as z.ZodType
    const mapped = next(element)
    result = mapped === element ? schema : cloneWith(schema, { element: mapped })
  } else if (def.type === 'pipe') {
    const input = def.in as z.ZodType, output = def.out as z.ZodType
    const mappedIn = next(input), mappedOut = next(output)
    result = mappedIn === input && mappedOut === output ? schema : cloneWith(schema, { in: mappedIn, out: mappedOut })
  } else if (def.type === 'union') {
    const options = def.options as z.ZodType[]
    const mapped = options.map(next)
    const changed = mapped.some((option, index) => option !== options[index])
    // A discriminated union keys on literal values, which widen here, so it
    // becomes a plain union that tries each member.
    result = !changed ? schema : def.discriminator ? z.union(mapped as [z.ZodType, ...z.ZodType[]]) : cloneWith(schema, { options: mapped })
  } else if (def.type === 'record') {
    const keyType = def.keyType as z.ZodType, valueType = def.valueType as z.ZodType
    // A record keyed by an enum requires every key; an open key set requires none.
    const mappedKey = defOf(keyType).type === 'enum' ? z.string() : keyType
    const mappedValue = next(valueType)
    result = mappedKey === keyType && mappedValue === valueType ? schema : cloneWith(schema, { keyType: mappedKey, valueType: mappedValue })
  } else if (def.type === 'intersection') {
    const left = def.left as z.ZodType, right = def.right as z.ZodType
    const mappedLeft = next(left), mappedRight = next(right)
    result = mappedLeft === left && mappedRight === right ? schema : cloneWith(schema, { left: mappedLeft, right: mappedRight })
  } else if (def.type === 'tuple') {
    const items = def.items as z.ZodType[]
    const rest = def.rest as z.ZodType | null | undefined
    const mappedItems = items.map(next)
    const mappedRest = rest ? next(rest) : rest
    const changed = mappedRest !== rest || mappedItems.some((item, index) => item !== items[index])
    result = changed ? cloneWith(schema, { items: mappedItems, rest: mappedRest }) : schema
  } else if (def.type === 'lazy') {
    const getter = def.getter as () => z.ZodType
    result = z.lazy(() => next(getter()))
  } else if (def.type === 'enum') {
    result = openPrimitive(Object.values(def.entries as Record<string, unknown>)) ?? schema
  } else if (def.type === 'literal') {
    result = openPrimitive(def.values as unknown[]) ?? schema
  }
  memo.set(schema, result)
  return result
}

/**
 * The client-side reader for a strict response DTO.
 *
 * Response DTOs stay strict on the server, where they are the contract a
 * response is checked against. A client that validates a response with the
 * same strict schema rejects the whole response the day a newer server adds a
 * field or a new enum value, which is the version skew between a globally
 * installed CLI or MCP adapter and a server that updated on its own. The
 * reader derived here:
 *
 * - drops object keys it does not declare instead of rejecting them, so what it
 *   returns never carries a field its own output schema does not describe;
 * - reads an enum or literal as its primitive (`string`, `number`, `boolean`),
 *   so a new outcome or state reads through;
 * - keeps the bounds and formats of the fields it knows, and every leaf schema
 *   it does not change by identity, so schema metadata such as a ratio's
 *   declared unit survives.
 */
export function tolerantReadSchema<T extends z.ZodObject>(schema: T, options: TolerantReadOptions = {}): TolerantReadSchema<T> {
  const open = new Map<z.ZodType, z.ZodType>(options.openKeys ?? [])
  return walk(schema, open, new Map(), 0) as unknown as TolerantReadSchema<T>
}
