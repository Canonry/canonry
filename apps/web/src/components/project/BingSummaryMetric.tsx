export function BingSummaryMetric({
  label,
  value,
  tone,
}: {
  label: string
  value: string | number
  tone: 'positive' | 'negative' | 'neutral'
}) {
  const valueClass = tone === 'positive'
    ? 'text-emerald-400'
    : tone === 'negative'
      ? 'text-rose-400'
      : 'text-zinc-200'

  return (
    <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3">
      <p className="text-xs uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-2 text-2xl font-semibold ${valueClass}`}>{value}</p>
    </div>
  )
}
