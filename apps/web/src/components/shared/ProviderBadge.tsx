export function ProviderBadge({ provider }: { provider: string }) {
  // Fixed engine-identity palettes (permanent no-literal-palette exclusion): the
  // dark-canvas default. The stable `provider-badge--<engine>` class lets the
  // light theme flip only the CANVAS polarity (light tint + darker ink) in
  // styles.css while keeping the identity hue — see `[data-theme='light']` there.
  const colors: Record<string, string> = {
    gemini: 'border-blue-800/50 bg-blue-950/40 text-blue-300',
    openai: 'border-green-800/50 bg-green-950/40 text-green-300',
    claude: 'border-amber-800/50 bg-amber-950/40 text-amber-300',
    perplexity: 'border-teal-800/50 bg-teal-950/40 text-teal-300',
    local: 'border-purple-800/50 bg-purple-950/40 text-purple-300',
  }
  const known = Object.hasOwn(colors, provider)
  const tone = known
    ? `provider-badge--${provider} ${colors[provider]}`
    : 'border-zinc-700 bg-zinc-800 text-zinc-300'
  return (
    <span
      className={`provider-badge inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}
    >
      {provider}
    </span>
  )
}
