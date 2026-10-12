import { validationError } from './errors.js'

/** Supported stored selections. Keep each set narrow enough for its data source. */
export const WINDOW_SETS = {
  metrics: ['7d', '30d', '90d', 'all'],
  gaMeasurementAnalysis: ['30d', '60d', '90d'],
  gaSearchLanding: ['7d', '28d', '90d'],
  googleAdsMetrics: ['7d', '14d', '30d'],
  trafficAnalytics: ['7d', '14d', '30d', '90d'],
  organicEvidence: ['60d', '90d'],
} as const

export function parseWindowToken(value: string | number): { days: number } | 'all' | null {
  if (value === 'all') return 'all'
  const token = String(value)
  if (!/^[1-9]\d*d?$/.test(token)) return null
  const days = Number(token.replace(/d$/, ''))
  return Number.isSafeInteger(days) ? { days } : null
}

export function parseWindowIn<const T extends readonly string[]>(
  value: string | number | undefined | null,
  allowed: T,
  options: { field?: string; fallback: T[number] },
): T[number] {
  if (value === undefined || value === null || value === '') return options.fallback
  const token = parseWindowToken(value)
  const normalized = token === 'all' ? token : token ? `${token.days}d` : null
  if (normalized !== null && allowed.includes(normalized)) return normalized
  throw validationError(`Invalid window "${value}". Must be one of: ${allowed.join(', ')}.`, { field: options.field ?? 'window', value, allowed: [...allowed] })
}

export function windowDays<T extends string>(window: T): T extends 'all' ? null : T extends `${infer N extends number}d` ? N : number {
  const token = parseWindowToken(window)
  if (token === null) throw validationError(`Invalid window "${window}".`)
  return (token === 'all' ? null : token.days) as T extends 'all' ? null : T extends `${infer N extends number}d` ? N : number
}

/** Numeric API periods derive from the same canonical tokens without widening their types. */
export function windowDayValues<const T extends readonly `${number}d`[]>(windows: T): { readonly [K in keyof T]: T[K] extends `${infer N extends number}d` ? N : never } {
  return windows.map(value => windowDays(value)) as { readonly [K in keyof T]: T[K] extends `${infer N extends number}d` ? N : never }
}
