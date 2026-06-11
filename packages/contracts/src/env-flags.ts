/**
 * Canonical boolean env-flag parser. Accepts `1`, `true`, `yes`, `on`
 * (case-insensitive, whitespace-trimmed); everything else — including
 * undefined and empty string — is false.
 *
 * Every env-driven feature flag must parse through this one function.
 * Before it existed, `CANONRY_ALLOW_PRIVATE_WEBHOOKS` was checked with
 * strict `=== '1'` at registration time but the truthy set at emit time,
 * so an operator setting `=true` had their callback URL rejected at
 * bootstrap yet allowed at delivery — config drift between two halves of
 * the same feature.
 */
export function parseBooleanFlag(value: string | undefined): boolean {
  if (value == null) return false
  const v = value.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}
