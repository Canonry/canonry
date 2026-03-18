export function ProviderBadge({ provider }: { provider: string }) {
  const colors: Record<string, string> = {
    gemini: 'border-blue-800/50 bg-blue-950/40 text-blue-300',
    openai: 'border-green-800/50 bg-green-950/40 text-green-300',
    claude: 'border-amber-800/50 bg-amber-950/40 text-amber-300',
    local: 'border-purple-800/50 bg-purple-950/40 text-purple-300',
  }
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${colors[provider] ?? 'border-zinc-700 bg-zinc-800 text-zinc-300'}`}>
      {provider}
    </span>
  )
}
