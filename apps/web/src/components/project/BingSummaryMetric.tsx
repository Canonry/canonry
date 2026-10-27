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
    <div className="material-base p-3">
      <p className="text-label-12 normal-case text-muted">{label}</p>
      <p className={`mt-2 text-copy-24-strong ${valueClass}`}>{value}</p>
    </div>
  )
}
