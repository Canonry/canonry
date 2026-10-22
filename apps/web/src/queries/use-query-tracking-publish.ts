import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  QueryTrackingCommitRequest,
  QueryTrackingCommitResponse,
  QueryTrackingPreviewRequest,
  QueryTrackingPreviewResponse,
  QueryTrackingWorkspaceResponse,
} from '@canonry/canonry-contracts'
import {
  getApiV1ProjectsByNameQueryTrackingQueryKey,
  postApiV1ProjectsByNameQueryTrackingCommitMutation,
  postApiV1ProjectsByNameQueryTrackingPreviewMutation,
} from '@canonry/canonry-api-client/react-query'
import { heyClient } from '../api.js'
import { extractApiErrorInfo } from '../lib/extract-error-message.js'
import { addToast } from '../lib/toast-store.js'
import { trackingReviewRows, trackingChangeSummary } from '../components/project/queries/tracking-review-model.js'
import { invalidateQueryTrackingPublication } from './query-invalidation.js'

/**
 * The generated SDK throws the API's error envelope, not an Error. Show its
 * message (a sweep refusal names the run, a limit refusal gives the counts)
 * and keep the fallback for a body that is not a Canonry error.
 */
function trackingErrorDetail(error: unknown, fallback: string): string {
  const info = extractApiErrorInfo(error)
  if (info.code === 'QUERY_TRACKING_PREVIEW_STALE') return 'Tracking changed since this review. Review again.'
  if (info.details?.check === 'query-limit-exceeded' && typeof info.details.next === 'number' && typeof info.details.max === 'number') return `This change would track ${info.details.next.toLocaleString('en-US')} queries. The limit is ${info.details.max.toLocaleString('en-US')}. Add fewer, or stop some first.`
  if (Array.isArray(info.details?.issues)) {
    const long = info.details.issues.find((issue: unknown) => issue !== null && typeof issue === 'object' && 'code' in issue && issue.code === 'too_big' && 'origin' in issue && issue.origin === 'string' && 'maximum' in issue && typeof issue.maximum === 'number') as { maximum: number } | undefined
    return long ? `A query holds at most ${long.maximum.toLocaleString('en-US')} characters.` : 'This change could not be read. Go back and check each line.'
  }
  return error instanceof Error || info.code ? info.message : fallback
}

/**
 * Review a tracked-query change, then publish it. Owns the pending review,
 * both requests, their cache refresh and their toasts, so every surface that
 * publishes tracking behaves the same. `error` is the last refusal, until the
 * next request: a modal sheet covers the toasts, so it shows this itself.
 */
export function useQueryTrackingPublish(projectName: string, { onCommitted }: {
  /** Runs once a publish succeeds, before the cache refresh, with what the server published. */
  onCommitted?: (result: QueryTrackingCommitResponse) => void
} = {}) {
  const queryClient = useQueryClient()
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const reviewed = useRef<{ preview: QueryTrackingPreviewResponse; rows: ReturnType<typeof trackingReviewRows> } | null>(null)
  const [preview, setPreview] = useState<QueryTrackingPreviewResponse | null>(null)
  const [lastError, setLastError] = useState<{ title: string; detail: string } | null>(null)
  const previewMutation = useMutation({
    ...postApiV1ProjectsByNameQueryTrackingPreviewMutation(),
    meta: { skipGlobalErrorToast: true },
    onSuccess: (result) => {
      const workspace = queryClient.getQueryData<QueryTrackingWorkspaceResponse>(getApiV1ProjectsByNameQueryTrackingQueryKey({ client: heyClient, path: { name: projectName } }))
      reviewed.current = { preview: result, rows: trackingReviewRows(result, workspace?.tracked) }
      setPreview(result)
    },
    onError: async (error) => {
      const refusal = { title: 'Could not review tracking changes', detail: trackingErrorDetail(error, 'Update the draft and review it again.') }
      setPreview(null)
      setLastError(refusal)
      // Refresh the optimistic version while keeping the user's draft intact.
      await queryClient.invalidateQueries({
        queryKey: getApiV1ProjectsByNameQueryTrackingQueryKey({ client: heyClient, path: { name: projectName } }),
      })
      addToast({ ...refusal, tone: 'negative' })
    },
  })
  const commitMutation = useMutation({
    ...postApiV1ProjectsByNameQueryTrackingCommitMutation(),
    meta: { skipGlobalErrorToast: true },
    onSuccess: async (result) => {
      const review = reviewed.current
      reviewed.current = null
      const changed = review?.rows.filter(row => row.counted) ?? []
      const remaining = changed.filter(row => row.label !== 'Removed')
      const title = result.mode === 'advanced' && review ? trackingChangeSummary(review.rows) : ''
      const allStopped = remaining.every(row => row.label === 'Stopped' && review?.preview.tracked.find(tracked => tracked.queryId === row.row.queryId)?.assignments.length === 0)
      const moved = result.mode === 'advanced' && (result.active?.revision ?? 0) > (review?.preview.active?.revision ?? 0)
      setPreview(null)
      // A parent can retire this form while the request is out. Its old callback must never close a newer draft.
      if (mounted.current) onCommitted?.(result)
      await invalidateQueryTrackingPublication(queryClient, projectName)
      addToast({
        title: result.committed ? title || 'Tracked queries updated' : 'No tracked-query change',
        detail: result.committed && moved ? 'New numbers next sweep' : undefined,
        cta: result.committed && result.mode === 'advanced' && remaining.length > 0 ? { label: 'View', intent: 'view-tracked-queries', projectName, ...(remaining.length === 1 ? { queryId: remaining[0]!.row.queryId } : { status: allStopped ? 'not-asked' : 'all' }) } : undefined,
        tone: result.committed ? 'positive' : 'neutral',
        dedupeKey: `query-tracking:commit:${projectName}`,
        dedupeMode: 'replace',
      })
    },
    onError: async (error) => {
      const refusal = { title: 'Could not update tracked queries', detail: trackingErrorDetail(error, 'The review may be stale. Review the changes again.') }
      setPreview(null)
      setLastError(refusal)
      // A concurrent publication can make both the review and the report stale.
      await invalidateQueryTrackingPublication(queryClient, projectName)
      addToast({ ...refusal, tone: 'negative' })
    },
  })

  return {
    preview,
    error: lastError,
    isPreviewing: previewMutation.isPending,
    isCommitting: commitMutation.isPending,
    requestPreview: (body: QueryTrackingPreviewRequest) => {
      setPreview(null)
      setLastError(null)
      previewMutation.mutate({ client: heyClient, path: { name: projectName }, body })
    },
    commit: (body: QueryTrackingCommitRequest) => {
      setLastError(null)
      commitMutation.mutate({ client: heyClient, path: { name: projectName }, body })
    },
  }
}
