import { z } from 'zod'
import type { SourceCategory } from './source-categories.js'

export type MetricsWindow = '7d' | '30d' | '90d' | 'all'
export type TrendDirection = 'improving' | 'declining' | 'stable'
export type GapCategory = 'cited' | 'gap' | 'uncited'

export const visibilityMetricModeSchema = z.enum(['answer', 'citation'])
export type VisibilityMetricMode = z.infer<typeof visibilityMetricModeSchema>
export const VisibilityMetricModes = visibilityMetricModeSchema.enum

export interface TimeBucket {
  startDate: string
  endDate: string
  citationRate: number
  cited: number
  total: number
  keywordCount: number
  answerRate: number
  answerMentionedCount: number
}

export interface KeywordChangeEvent {
  date: string
  delta: number
  label: string
}

export interface ProviderMetric {
  citationRate: number
  cited: number
  total: number
  answerRate: number
  answerMentionedCount: number
}

export interface BrandMetricsDto {
  window: MetricsWindow
  buckets: TimeBucket[]
  overall: ProviderMetric
  byProvider: Record<string, ProviderMetric>
  trend: TrendDirection
  answerTrend: TrendDirection
  keywordChanges: KeywordChangeEvent[]
}

export interface GapKeyword {
  keyword: string
  keywordId: string
  category: GapCategory
  providers: string[]
  competitorsCiting: string[]
  consistency: { citedRuns: number; totalRuns: number; mentionedRuns: number }
}

export interface GapAnalysisDto {
  cited: GapKeyword[]
  gap: GapKeyword[]
  uncited: GapKeyword[]
  mentionedKeywords: GapKeyword[]
  mentionGap: GapKeyword[]
  notMentioned: GapKeyword[]
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

export function parseWindow(value?: string): MetricsWindow {
  if (value === '7d' || value === '30d' || value === '90d' || value === 'all') return value
  return 'all'
}

export function windowCutoff(window: MetricsWindow): string | null {
  if (window === 'all') return null
  const days = window === '7d' ? 7 : window === '30d' ? 30 : 90
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString()
}
