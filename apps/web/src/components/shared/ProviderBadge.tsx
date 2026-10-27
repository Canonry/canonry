import { isOpenRouterRoute } from '@canonry/canonry-contracts'
import { providerDisplayName } from '../../lib/visibility-trend-helpers.js'

const PROVIDER_BADGE_ENGINES = new Set(['gemini', 'openai', 'claude', 'perplexity', 'muse', 'local'])

export function ProviderBadge({ provider }: { provider: string }) {
  // Theme-scoped CSS preserves each engine's identity hue across canvas modes.
  const tone = PROVIDER_BADGE_ENGINES.has(provider)
    ? `provider-badge--${provider}`
    : 'border-neutral bg-neutral-soft text-neutral'
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-label-12-strong normal-case ${tone}`}
    >
      {isOpenRouterRoute(provider) ? providerDisplayName(provider) : provider}
    </span>
  )
}
