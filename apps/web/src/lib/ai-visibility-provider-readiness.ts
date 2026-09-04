export const CDP_PROVIDER_NAME = 'cdp:chatgpt'

export function normalizeProviderName(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Mirror the answer-visibility server preflight: an explicit project provider
 * list is an allowlist; an empty list falls back to every runnable provider.
 * `undefined` means one of the authoritative readiness reads is still pending.
 */
export function resolveAiVisibilityProviderReadiness({
  projectProviders,
  configuredApiProviders,
  cdpConfigured,
}: {
  projectProviders: readonly string[]
  configuredApiProviders: readonly string[] | undefined
  cdpConfigured: boolean | undefined
}): boolean | undefined {
  const selected = projectProviders.map(normalizeProviderName)
  const selectedSet = new Set(selected)
  const canUseApiProvider = selected.length === 0
    || selected.some(provider => provider !== CDP_PROVIDER_NAME)
  const canUseCdp = selected.length === 0 || selectedSet.has(CDP_PROVIDER_NAME)

  if (canUseApiProvider && configuredApiProviders !== undefined) {
    const apiReady = configuredApiProviders
      .map(normalizeProviderName)
      .some(provider => selected.length === 0 || selectedSet.has(provider))
    if (apiReady) return true
  }
  if (canUseCdp && cdpConfigured === true) return true

  const apiPending = canUseApiProvider && configuredApiProviders === undefined
  const cdpPending = canUseCdp && cdpConfigured === undefined
  if (apiPending || cdpPending) return undefined
  return false
}
