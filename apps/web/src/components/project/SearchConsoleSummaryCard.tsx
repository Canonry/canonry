import { ToneBadge } from '../shared/ToneBadge.js'
import { formatTimestamp } from '../../lib/format-helpers.js'

export function SearchConsoleSummaryCard({
  eyebrow,
  title,
  status,
  tone,
  targetLabel,
  targetValue,
  coverageValue,
  note,
  updatedAt,
  active,
  onClick,
}: {
  eyebrow: string
  title: string
  status: string
  tone: 'positive' | 'caution' | 'negative' | 'neutral'
  targetLabel: string
  targetValue: string
  coverageValue: string
  note: string
  updatedAt: string | null
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`surface-card w-full text-left transition-colors ${
        active
          ? 'border-mono-200 bg-bg-elevated/50'
          : 'hover:border-strong hover:bg-bg-elevated/40'
      }`}
    >
      <div className="section-head">
        <div className="min-w-0">
          <p className="eyebrow eyebrow-soft">{eyebrow}</p>
          <h3>{title}</h3>
        </div>
        <ToneBadge tone={tone}>{status}</ToneBadge>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-default bg-surface-subtle p-3">
          <p className="text-xs uppercase tracking-wide text-muted">{targetLabel}</p>
          <p className="mt-1 truncate text-sm text-strong">{targetValue}</p>
        </div>
        <div className="rounded-lg border border-default bg-surface-subtle p-3">
          <p className="text-xs uppercase tracking-wide text-muted">Coverage</p>
          <p className="mt-1 text-sm text-strong">{coverageValue}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-1 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
        <span>{note}</span>
        <span>{updatedAt ? `Updated ${formatTimestamp(updatedAt)}` : 'No recent sync yet'}</span>
      </div>
    </button>
  )
}
