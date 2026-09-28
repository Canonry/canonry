import type { SentimentSelection, SentimentSummary, SentimentEvidenceSelection } from '@ainyc/canonry-contracts'
import type { VisibilitySelectionState } from '../lib/measurement-view-url.js'

export function sentimentSelectionFromVisibility(selection: VisibilitySelectionState, mode: 'simple' | 'advanced', evaluationDefinitionId?: string): SentimentSelection {
  return { mode, scope: selection.measurementScope, scopeKey: selection.measurementScopeKey, marketKey: selection.marketKey,
    queryClass: selection.queryClass === 'non-brand' ? 'non-brand' : 'branded', provider: selection.provider, model: selection.model, location: selection.location,
    runId: selection.measurementRunId, revision: selection.revision, evaluationDefinitionId }
}
/** Simple renders its saved snapshot group; its visible engine control replaces carried Advanced provider/model/run/revision filters. */
export function sentimentSelectionForSimpleEvidence(selection: SentimentSelection, evidence: readonly { provider: string; sourceRunId?: string | null }[], provider?: string): SentimentSelection {
  const ids = [...new Set(evidence.filter(item => !provider || item.provider === provider).map(item => item.sourceRunId).filter((id): id is string => Boolean(id)))].sort()
  return { ...selection, mode: 'simple', provider: provider || undefined, model: undefined, revision: undefined, runId: ids.length === 1 ? ids[0] : undefined, runIds: ids.length > 1 ? ids : undefined }
}
/** Includes every source, subject/scope and evaluator dimension; cursors never cross this key. */
export function sentimentQueryKey(projectName: string, surface: string, selection?: SentimentEvidenceSelection, cursor?: string) {
  return ['sentiment', projectName, surface, selection ?? null, cursor ?? null] as const
}

import { useQuery, type Query } from '@tanstack/react-query'
import { fetchSentiment, fetchSentimentSettings, fetchSentimentJobs } from '../api.js'

export function useSentiment(projectName: string, selection: SentimentSelection, sourceReady = true) {
  const settings = useQuery({ queryKey: sentimentQueryKey(projectName, 'settings'), queryFn: () => fetchSentimentSettings(projectName), retry: false, staleTime: 0, refetchOnWindowFocus: 'always' })
  const readSummary = (queryClass: 'branded' | 'non-brand') => {
    const selected = { ...selection, queryClass }
    return { queryKey: sentimentQueryKey(projectName, 'summary', selected), queryFn: () => fetchSentiment(projectName, selected), enabled: sourceReady && Boolean(settings.data?.enabled && settings.data.installEnabled), retry: false, staleTime: 0, refetchOnWindowFocus: 'always' as const, refetchInterval: (query: Query<SentimentSummary>) => ['processing', 'partial'].includes(query.state.data?.state ?? '') ? 5000 : false }
  }
  const branded = useQuery(readSummary('branded'))
  const nonBrand = useQuery(readSummary('non-brand'))

  const jobs = useQuery({ queryKey: sentimentQueryKey(projectName, 'jobs'), queryFn: () => fetchSentimentJobs(projectName), enabled: Boolean(settings.data?.actions.configure), retry: false, refetchOnWindowFocus: 'always', refetchInterval: query => query.state.data?.jobs.some(job => job.state === 'pending' || job.state === 'running' || job.state === 'waiting-to-retry') ? 5000 : false })
  return { settings, branded, nonBrand, jobs }
}
