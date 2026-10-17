import { useEffect, useRef } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { RunDto } from '@canonry/canonry-contracts'

/** Every contributing run, not just the latest: older runs can finish later. */
export function competitorEvidenceRevision(runs: readonly Pick<RunDto, 'id' | 'kind' | 'status' | 'trigger'>[]): string {
  return JSON.stringify(runs
    .filter(run => run.kind === 'answer-visibility' && run.trigger !== 'probe'
      && (run.status === 'completed' || run.status === 'partial'))
    .map(run => [run.id, run.status] as const)
    .sort(([left], [right]) => left.localeCompare(right)))
}

export async function invalidateCompetitorLandscapes(
  queryClient: Pick<QueryClient, 'invalidateQueries' | 'cancelQueries'>,
  projectName: string,
  refetchType: 'active' | 'none' = 'active',
): Promise<void> {
  const predicate = (query: { queryKey: readonly unknown[] }) => {
    const key = query.queryKey[0] as { _id?: string; path?: { name?: string } } | undefined
    return key?._id === 'getApiV1ProjectsByNameAnalyticsCompetitors' && key.path?.name === projectName
  }
  // invalidateQueries alone deduplicates an initial request with no cached
  // data, even with cancelRefetch enabled. A changed revision must supersede
  // that old request too, or its result can hide a new competitor until focus.
  if (refetchType === 'active') await queryClient.cancelQueries({ predicate })
  return queryClient.invalidateQueries({ predicate, refetchType })
}

/** Polling and embeds have no completion notification; evidence changes own the refresh. */
export function useCompetitorLandscapeRefresh(projectName: string, revision: string, enabled: boolean): void {
  const queryClient = useQueryClient()
  const previous = useRef({ projectName, revision, enabled })
  useEffect(() => {
    const before = previous.current
    previous.current = { projectName, revision, enabled }
    // Mounts, project navigation and re-enabling already fetch through useQuery.
    if (!enabled || !before.enabled || before.projectName !== projectName || before.revision === revision) return
    void invalidateCompetitorLandscapes(queryClient, projectName)
  }, [enabled, projectName, queryClient, revision])
}
