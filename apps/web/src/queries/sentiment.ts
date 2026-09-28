import type { SentimentSelection } from '@ainyc/canonry-contracts'
import type { VisibilitySelectionState } from '../lib/measurement-view-url.js'

export function sentimentSelectionFromVisibility(selection: VisibilitySelectionState, mode: 'simple' | 'advanced', evaluationDefinitionId?: string): SentimentSelection {
  return { mode, scope: selection.measurementScope, scopeKey: selection.measurementScopeKey, marketKey: selection.marketKey,
    queryClass: selection.queryClass === 'non-brand' ? 'non-brand' : 'branded', provider: selection.provider, model: selection.model, location: selection.location,
    runId: selection.measurementRunId, revision: selection.revision, evaluationDefinitionId }
}
/** Includes every source, subject/scope and evaluator dimension; cursors never cross this key. */
export function sentimentQueryKey(projectName: string, surface: string, selection?: SentimentSelection, cursor?: string) {
  return ['sentiment', projectName, surface, selection ?? null, cursor ?? null] as const
}

import { useQuery } from '@tanstack/react-query'
import { fetchSentiment, fetchSentimentSettings, fetchSentimentJobs } from '../api.js'

export function useSentiment(projectName: string, selection: SentimentSelection) {
  const settings = useQuery({ queryKey: sentimentQueryKey(projectName, 'settings'), queryFn: () => fetchSentimentSettings(projectName), retry: false, staleTime: 0, refetchOnWindowFocus: 'always' })
  const summary = useQuery({ queryKey: sentimentQueryKey(projectName, 'summary', selection), queryFn: () => fetchSentiment(projectName, selection), enabled: selection.queryClass === 'branded', retry: false, staleTime: 0, refetchOnWindowFocus: 'always', refetchInterval: query => query.state.data?.state === 'processing' || query.state.data?.state === 'partial' ? 5000 : false })
  const jobs = useQuery({ queryKey: sentimentQueryKey(projectName, 'jobs'), queryFn: () => fetchSentimentJobs(projectName), retry: false, refetchOnWindowFocus: 'always', refetchInterval: query => query.state.data?.jobs.some(job => job.state === 'pending' || job.state === 'running' || job.state === 'waiting-to-retry') ? 5000 : false })
  return { settings, summary, jobs }
}
