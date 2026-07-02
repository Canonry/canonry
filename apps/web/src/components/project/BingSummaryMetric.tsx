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
    ? 'text-positive-400'
    : tone === 'negative'
      ? 'text-negative-400'
      : 'text-strong'

  return (
    <div className="rounded-lg border border-default bg-surface-subtle p-3">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-2 text-2xl font-semibold ${valueClass}`}>{value}</p>
    </div>
  )
}
