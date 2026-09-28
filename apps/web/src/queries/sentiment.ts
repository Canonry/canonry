import type { SentimentSelection, SentimentSummary, SentimentEvidenceSelection, SentimentJobSummary } from '@ainyc/canonry-contracts'
import type { VisibilitySelectionState } from '../lib/measurement-view-url.js'

export function sentimentSelectionFromVisibility(selection: VisibilitySelectionState, mode: 'simple' | 'advanced', evaluationDefinitionId?: string): SentimentSelection {
  return { mode, scope: selection.measurementScope, scopeKey: selection.measurementScopeKey, marketKey: selection.marketKey,
    queryClass: selection.queryClass === 'non-brand' ? 'non-brand' : 'branded', provider: selection.provider, model: selection.model, location: selection.location,
    runId: selection.measurementRunId, revision: selection.revision, evaluationDefinitionId }
}
/**
 * Simple renders its saved snapshot group; its visible engine control replaces carried Advanced provider/model/run/revision filters.
 * A Simple project has no Property, group or market, so an Advanced scope carried in from a stale or shared URL is reset to the
 * whole project; left in place, the server skips every Simple run and both headlines read Unavailable.
 */
export function sentimentSelectionForSimpleEvidence(selection: SentimentSelection, evidence: readonly { provider: string; sourceRunId?: string | null }[], provider?: string): SentimentSelection {
  const ids = [...new Set(evidence.filter(item => !provider || item.provider === provider).map(item => item.sourceRunId).filter((id): id is string => Boolean(id)))].sort()
  return { ...selection, mode: 'simple', scope: 'project', scopeKey: undefined, marketKey: undefined, provider: provider || undefined, model: undefined, revision: undefined, runId: ids.length === 1 ? ids[0] : undefined, runIds: ids.length > 1 ? ids : undefined }
}
/** Includes every source, subject/scope and evaluator dimension; cursors never cross this key. */
export function sentimentQueryKey(projectName: string, surface: string, selection?: SentimentEvidenceSelection, cursor?: string) {
  return ['sentiment', projectName, surface, selection ?? null, cursor ?? null] as const
}

const SENTIMENT_POLL_MS = 5000
const ACTIVE_JOB_STATES: ReadonlySet<SentimentJobSummary['state']> = new Set(['pending', 'running', 'waiting-to-retry'])
function sentimentJobActive(job: SentimentJobSummary): boolean { return ACTIVE_JOB_STATES.has(job.state) }
/**
 * True while the worker still owes this summary a result: assessments pending,
 * running or waiting to retry. `partial` alone is not enough: failed and canceled
 * assessments are terminal, and an unadmitted gap is not work in flight, so
 * polling on `partial` would never stop.
 */
function sentimentWorkInFlight(summary: SentimentSummary | undefined): boolean {
  const counts = summary?.coverage.counts
  return Boolean(counts && counts.pending + counts.running + counts['waiting-to-retry'] > 0)
}
/** Poll a class summary only while its own work is in flight or a job the administrator can see is still active. */
export function sentimentSummaryRefetchInterval(summary: SentimentSummary | undefined, jobsActive: boolean): number | false {
  return sentimentWorkInFlight(summary) || jobsActive ? SENTIMENT_POLL_MS : false
}

import { useQuery, type Query } from '@tanstack/react-query'
import { fetchSentiment, fetchSentimentSettings, fetchSentimentJobs } from '../api.js'

export function useSentiment(projectName: string, selection: SentimentSelection, sourceReady = true) {
  const settings = useQuery({ queryKey: sentimentQueryKey(projectName, 'settings'), queryFn: () => fetchSentimentSettings(projectName), retry: false, staleTime: 0, refetchOnWindowFocus: 'always' })
  const jobs = useQuery({ queryKey: sentimentQueryKey(projectName, 'jobs'), queryFn: () => fetchSentimentJobs(projectName), enabled: Boolean(settings.data?.actions.configure), retry: false, refetchOnWindowFocus: 'always', refetchInterval: query => query.state.data?.jobs.some(sentimentJobActive) ? SENTIMENT_POLL_MS : false })
  const jobsActive = Boolean(jobs.data?.jobs.some(sentimentJobActive))
  const readSummary = (queryClass: 'branded' | 'non-brand') => {
    const selected = { ...selection, queryClass }
    return { queryKey: sentimentQueryKey(projectName, 'summary', selected), queryFn: () => fetchSentiment(projectName, selected), enabled: sourceReady && Boolean(settings.data?.enabled && settings.data.installEnabled), retry: false, staleTime: 0, refetchOnWindowFocus: 'always' as const, refetchInterval: (query: Query<SentimentSummary>) => sentimentSummaryRefetchInterval(query.state.data, jobsActive) }
  }
  const branded = useQuery(readSummary('branded'))
  const nonBrand = useQuery(readSummary('non-brand'))
  return { settings, branded, nonBrand, jobs }
}
