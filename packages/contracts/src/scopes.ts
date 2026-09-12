/**
 * API-key scope tokens and the read-only classifier.
 *
 * Scopes are an additive `string[]` on every `api_keys` row. The default key
 * written by `canonry init` carries `['*']` (full access). Named write scopes
 * are enforced for privileged surfaces. `read` and named `*.read` scopes mark
 * a key as read-only unless it also carries an explicit write grant: the auth
 * layer denies write HTTP methods while leaving authorized reads open.
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
  const restricted = new Set([
    ADS_WRITE_SCOPE,
    ADS_APPROVE_SCOPE,
    ADS_ACTIVATE_SCOPE,
    RESEARCH_RUN_SCOPE,
    // Account administration is a named, bounded capability. Without listing
    // it here, `users.write` is mistaken for legacy broad write authority and
    // can pass the global gate on unrelated mutation routes.
    'users.write',
  ])
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
 * A key is read-only when it carries `read` or a named `*.read` scope AND
 * carries no write-granting scope (no `*`, no `write`, no `*.write`, and no
 * explicit action authority such as `research.run`).
 *
 * Named observers (for example, `logs.read`) must not inherit legacy broad
 * mutations merely because the caller omitted the bare `read` marker. Empty
 * and unrecognized legacy scope lists retain their existing behavior. Explicit
 * write grants still win, subject to each route's own capability gates.
 */
export function isReadOnlyKey(scopes: readonly string[]): boolean {
  return scopes.some(scope => scope === READ_ONLY_SCOPE || scope.endsWith('.read')) && !scopes.some(grantsWrite)
}
