export function formatRatio(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0%'
  return `${(value * 100).toFixed(1)}%`
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString('en-US')
}

export function formatDate(iso: string): string {
  if (!iso) return '—'
  try {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
    const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }
    const d = dateOnly && dateOnly[1] && dateOnly[2] && dateOnly[3]
      ? new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])))
      : new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleDateString('en-US', dateOnly ? { ...options, timeZone: 'UTC' } : options)
  } catch {
    return iso
  }
}

export function formatIsoDate(iso: string): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const yyyy = d.getUTCFullYear()
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(d.getUTCDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
  } catch {
    return iso
  }
}

export function formatDateRange(start: string, end: string): string {
  if (!start && !end) return ''
  if (start && end) return `${formatDate(start)} → ${formatDate(end)}`
  return formatDate(start || end)
}
