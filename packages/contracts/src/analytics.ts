import type { SourceCategory } from './source-categories.js'

export type MetricsWindow = '7d' | '30d' | '90d' | 'all'
export type TrendDirection = 'improving' | 'declining' | 'stable'
export type GapCategory = 'cited' | 'gap' | 'uncited'

export interface TimeBucket {
  startDate: string
  endDate: string
  citationRate: number
  cited: number
  total: number
}

export interface ProviderMetric {
  citationRate: number
  cited: number
  total: number
}

export interface BrandMetricsDto {
  window: MetricsWindow
  buckets: TimeBucket[]
  overall: ProviderMetric
  byProvider: Record<string, ProviderMetric>
  trend: TrendDirection
}

export interface GapKeyword {
  keyword: string
  keywordId: string
  category: GapCategory
  providers: string[]
  competitorsCiting: string[]
  consistency: { citedRuns: number; totalRuns: number }
}

export interface GapAnalysisDto {
  cited: GapKeyword[]
  gap: GapKeyword[]
  uncited: GapKeyword[]
  runId: string
  window: MetricsWindow
}

export interface SourceCategoryCount {
  category: SourceCategory
  label: string
  count: number
  percentage: number
  topDomains: Array<{ domain: string; count: number }>
}

export interface SourceBreakdownDto {
  overall: SourceCategoryCount[]
  byKeyword: Record<string, SourceCategoryCount[]>
  runId: string
  window: MetricsWindow
}
