/**
 * API-key scope tokens and the read-only classifier.
 *
 * Scopes are an additive `string[]` on every `api_keys` row. The default key
 * written by `canonry init` carries `['*']` (full access). Named write scopes
 * are enforced for privileged surfaces, and the special
 * `read` token below marks a key as **read-only**: the auth layer denies every
 * write HTTP method for such a key while leaving reads open.
 *
 * These live in `contracts` (not `api-routes`) because four surfaces share the
 * same predicate: server enforcement (`auth.ts`), the `readOnly` DTO field
 * (`keys.ts`), the CLI mint path (`key create --read-only`), and the MCP
 * adapter's startup auto-detection.
 */

/** Marks a key as read-only. `canonry key create --read-only` mints `['read']`. */
export const READ_ONLY_SCOPE = 'read'

/** Full access. The default `canonry init` root key carries this. */
export const WILDCARD_SCOPE = '*'

/** Run bounded research without granting tracking or settings writes. */
export const RESEARCH_RUN_SCOPE = 'research.run'

/** Grants creation of a project at the install boundary. */
export const PROJECTS_WRITE_SCOPE = 'projects.write'

/** Grants access to OpenAI Ads campaign mutations. */
export const ADS_WRITE_SCOPE = 'ads.write'

/** Grants human approval of an exact OpenAI Ads activation manifest. */
export const ADS_APPROVE_SCOPE = 'ads.approve'

/** Grants execution of a separately approved OpenAI Ads activation manifest. */
export const ADS_ACTIVATE_SCOPE = 'ads.activate'

/** Grants live, quota-consuming reads from Google Ads and Tag Manager. */
export const GOOGLE_MARKETING_LIVE_READ_SCOPE = 'google-marketing.read-live'

/** Grants connection, selection, snapshot, and contract mutations. */
export const GOOGLE_MARKETING_WRITE_SCOPE = 'google-marketing.write'

/**
 * A scope grants write capability when it is the wildcard, the bare `write`,
 * any `*.write`, or an explicit action grant (`ads.approve`, `ads.activate`,
 * `research.run`). Named action grants do not imply general write access.
 */
function grantsWrite(scope: string): boolean {
  return scope === WILDCARD_SCOPE
    || scope === 'write'
    || scope.endsWith('.write')
    || scope === ADS_APPROVE_SCOPE
    || scope === ADS_ACTIVATE_SCOPE
    || scope === RESEARCH_RUN_SCOPE
}

/** Named mutation grants constrained to explicit routes; null means legacy broad access. */
export function restrictedWriteScopes(scopes: readonly string[]): readonly string[] | null {
  const writes = scopes.filter(grantsWrite)
  const restricted = new Set([ADS_WRITE_SCOPE, ADS_APPROVE_SCOPE, ADS_ACTIVATE_SCOPE, RESEARCH_RUN_SCOPE])
  return writes.length > 0 && writes.every(scope => restricted.has(scope)) ? writes : null
}

/** Delegated consent cannot exceed current account authority. */
export function intersectScopes(authority: readonly string[], requested: readonly string[]): string[] {
  const effective = authority.includes(WILDCARD_SCOPE)
    ? [...requested]
    : authority.filter(scope => requested.includes(scope) || requested.includes(WILDCARD_SCOPE))
  return effective.length > 0 ? effective : [READ_ONLY_SCOPE]
}

/**
 * A key is read-only when it explicitly opts in via the `read` token AND
 * carries no write-granting scope (no `*`, no `write`, no `*.write`, and no
 * explicit action authority such as `research.run`).
 *
 * This is deliberately ADDITIVE: read-only is opt-in. A key that never carries
 * `read` — including an empty or unrecognized scope list — is NOT read-only, so
 * every key that exists today keeps its current behavior. Mixing `read` with a
 * write-granting scope is contradictory and resolves to "not read-only" (the
 * write grant wins), so the `read` marker there is merely informational.
 */
export function isReadOnlyKey(scopes: readonly string[]): boolean {
  return scopes.includes(READ_ONLY_SCOPE) && !scopes.some(grantsWrite)
}
