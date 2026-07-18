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

/** Grants access to OpenAI Ads campaign mutations. */
export const ADS_WRITE_SCOPE = 'ads.write'

/** Grants human approval of an exact OpenAI Ads activation manifest. */
export const ADS_APPROVE_SCOPE = 'ads.approve'

/** Grants execution of a separately approved OpenAI Ads activation manifest. */
export const ADS_ACTIVATE_SCOPE = 'ads.activate'

/**
 * A scope grants write capability when it is the wildcard, the bare `write`,
 * any `*.write`, or the explicit `ads.approve` / `ads.activate` authority.
 */
function grantsWrite(scope: string): boolean {
  return scope === WILDCARD_SCOPE
    || scope === 'write'
    || scope.endsWith('.write')
    || scope === ADS_APPROVE_SCOPE
    || scope === ADS_ACTIVATE_SCOPE
}

/**
 * A key is read-only when it explicitly opts in via the `read` token AND
 * carries no write-granting scope (no `*`, no `write`, no `*.write`, and no
 * explicit `ads.approve` / `ads.activate` authority).
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
