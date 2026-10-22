import { z } from 'zod'

/**
 * Routed provider families: one connection (credentials, quota, execution gate)
 * whose concrete measurement targets are `<connection>:<selection>` route keys.
 *
 * OpenRouter is a `model` family (any catalog model slug); a hosted answer
 * service is a `profile` family (a closed set its descriptor declares). The
 * bare connection is never a measurement target, so connecting one never adds
 * an engine to a project that selects "all configured engines".
 *
 * Families are plain data so the server, the CLI and the dashboard resolve
 * route keys the same way. Resolvers take the family list as an argument and
 * stay pure; callers pass the families of the adapters they know about.
 */
export const providerSelectionKindSchema = z.enum(['model', 'profile'])
export type ProviderSelectionKind = z.infer<typeof providerSelectionKindSchema>
export const ProviderSelectionKinds = providerSelectionKindSchema.enum

export interface ProviderRouteFamily {
  /** The connection name, which owns credentials, quota and the shared gate. */
  connection: string
  selectionKind: ProviderSelectionKind
  /** The closed set of selections, or null for an open set validated by `selectionPattern`. */
  selections: readonly string[] | null
  selectionPattern?: RegExp
  /** Selections that match the pattern but are routers, never fixed measurement targets. */
  excludedSelectionPrefixes?: readonly string[]
}

/** Canonical OpenRouter model slugs. Routing aliases are not fixed sweep models. */
export const OPENROUTER_MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/

export const OPENROUTER_ROUTE_FAMILY: ProviderRouteFamily = {
  connection: 'openrouter',
  selectionKind: ProviderSelectionKinds.model,
  selections: null,
  selectionPattern: OPENROUTER_MODEL_PATTERN,
  excludedSelectionPrefixes: ['openrouter/', 'typesafe/'],
}

/** The families every caller knows without being told: OpenRouter only. */
export const DEFAULT_PROVIDER_ROUTE_FAMILIES: readonly ProviderRouteFamily[] = [OPENROUTER_ROUTE_FAMILY]

/** A profile family from a closed list of profile ids. */
export function profileRouteFamily(connection: string, profileIds: readonly string[]): ProviderRouteFamily {
  return { connection, selectionKind: ProviderSelectionKinds.profile, selections: [...profileIds] }
}

/** The selection a route key names within one family, or undefined when it is not a valid route of it. */
export function routeSelection(name: string, family: ProviderRouteFamily): string | undefined {
  const prefix = `${family.connection}:`
  if (!name.startsWith(prefix)) return undefined
  const selection = name.slice(prefix.length)
  if (!selection) return undefined
  if (family.selections) return family.selections.includes(selection) ? selection : undefined
  const pattern = family.selectionPattern
  if (!pattern) return undefined
  pattern.lastIndex = 0
  if (!pattern.test(selection)) return undefined
  return (family.excludedSelectionPrefixes ?? []).some(prefixValue => selection.startsWith(prefixValue)) ? undefined : selection
}

export interface ResolvedProviderRoute {
  name: string
  connection: string
  selection: string
  family: ProviderRouteFamily
}

/** Resolve a route key against the known families. */
export function resolveProviderRoute(name: string, families: readonly ProviderRouteFamily[] = DEFAULT_PROVIDER_ROUTE_FAMILIES): ResolvedProviderRoute | undefined {
  for (const family of families) {
    const selection = routeSelection(name, family)
    if (selection !== undefined) return { name, connection: family.connection, selection, family }
  }
  return undefined
}

/** Build a route key and reject a selection the family does not accept. */
export function providerRouteName(family: ProviderRouteFamily, selection: string): string {
  const route = `${family.connection}:${selection.trim()}`
  if (routeSelection(route, family) === undefined) {
    throw new Error(`"${selection}" is not a valid ${family.selectionKind} for ${family.connection}.`)
  }
  return route
}

/** The connection that owns credentials, quota and the gate for a provider key. */
export function routeConnectionName(name: string, families: readonly ProviderRouteFamily[] = DEFAULT_PROVIDER_ROUTE_FAMILIES): string {
  return resolveProviderRoute(name, families)?.connection ?? name
}

/** Whether a name is the bare connection of a routed family (never a measurement target). */
export function isRouteFamilyConnection(name: string, families: readonly ProviderRouteFamily[] = DEFAULT_PROVIDER_ROUTE_FAMILIES): boolean {
  return families.some(family => family.connection === name)
}

/**
 * Whether a provider key names one concrete measurement target: not a bare
 * routed connection, and not a malformed route under one.
 */
export function isConcreteProviderName(name: string, families: readonly ProviderRouteFamily[] = DEFAULT_PROVIDER_ROUTE_FAMILIES): boolean {
  for (const family of families) {
    if (name === family.connection) return false
    if (name.startsWith(`${family.connection}:`)) return routeSelection(name, family) !== undefined
  }
  return true
}

/** A route is available when its connection is; any other name must be listed itself. */
export function isRouteAvailable(name: string, available: readonly string[], families: readonly ProviderRouteFamily[] = DEFAULT_PROVIDER_ROUTE_FAMILIES): boolean {
  if (available.includes(name)) return true
  const route = resolveProviderRoute(name, families)
  return route !== undefined && available.includes(route.connection)
}

/** Families of a list of adapters (or adapter descriptions), with the defaults first and no duplicates. */
export function routeFamiliesOf(items: readonly { routes?: ProviderRouteFamily }[] | undefined): ProviderRouteFamily[] {
  const byConnection = new Map<string, ProviderRouteFamily>()
  for (const family of DEFAULT_PROVIDER_ROUTE_FAMILIES) byConnection.set(family.connection, family)
  for (const item of items ?? []) {
    if (item.routes) byConnection.set(item.routes.connection, item.routes)
  }
  return [...byConnection.values()]
}
