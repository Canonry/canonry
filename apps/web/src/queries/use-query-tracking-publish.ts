import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  QueryTrackingCommitRequest,
  QueryTrackingPreviewRequest,
  QueryTrackingPreviewResponse,
} from '@ainyc/canonry-contracts'
import {
  getApiV1ProjectsByNameQueryTrackingQueryKey,
  postApiV1ProjectsByNameQueryTrackingCommitMutation,
  postApiV1ProjectsByNameQueryTrackingPreviewMutation,
} from '@ainyc/canonry-api-client/react-query'
import { heyClient } from '../api.js'
import { extractApiErrorInfo } from '../lib/extract-error-message.js'
import { addToast } from '../lib/toast-store.js'
import { invalidateQueryTrackingPublication } from './query-invalidation.js'

/**
 * The generated SDK throws the API's error envelope, not an Error. Show its
 * message (a sweep refusal names the run, a limit refusal gives the counts)
 * and keep the fallback for a body that is not a Canonry error.
 */
function trackingErrorDetail(error: unknown, fallback: string): string {
  const info = extractApiErrorInfo(error)
  return error instanceof Error || info.code ? info.message : fallback
}

/**
 * Review a tracked-query change, then publish it. Owns the pending review,
 * both requests, their cache refresh and their toasts, so every surface that
 * publishes tracking behaves the same.
 */
export function useQueryTrackingPublish(projectName: string, { onCommitted }: {
  /** Runs once a publish succeeds, before the cache refresh. */
  onCommitted?: () => void
} = {}) {
  const queryClient = useQueryClient()
  const [preview, setPreview] = useState<QueryTrackingPreviewResponse | null>(null)
  const previewMutation = useMutation({
    ...postApiV1ProjectsByNameQueryTrackingPreviewMutation(),
    meta: { skipGlobalErrorToast: true },
    onSuccess: (result) => setPreview(result),
    onError: async (error) => {
      setPreview(null)
      // Refresh the optimistic version while keeping the user's draft intact.
      await queryClient.invalidateQueries({
        queryKey: getApiV1ProjectsByNameQueryTrackingQueryKey({ client: heyClient, path: { name: projectName } }),
      })
      addToast({
        title: 'Could not review tracking changes',
        detail: trackingErrorDetail(error, 'Update the draft and review it again.'),
        tone: 'negative',
      })
    },
  })
  const commitMutation = useMutation({
    ...postApiV1ProjectsByNameQueryTrackingCommitMutation(),
    meta: { skipGlobalErrorToast: true },
    onSuccess: async (result) => {
      setPreview(null)
      onCommitted?.()
      await invalidateQueryTrackingPublication(queryClient, projectName)
      addToast({
        title: result.committed ? 'Tracked queries updated' : 'No tracked-query change',
        detail: result.committed && result.mode === 'advanced' ? 'New numbers after the next sweep.' : undefined,
        tone: result.committed ? 'positive' : 'neutral',
        dedupeKey: `query-tracking:commit:${projectName}`,
        dedupeMode: 'replace',
      })
    },
    onError: async (error) => {
      setPreview(null)
      // A concurrent publication can make both the review and the report stale.
      await invalidateQueryTrackingPublication(queryClient, projectName)
      addToast({
        title: 'Could not confirm tracking changes',
        detail: trackingErrorDetail(error, 'The review may be stale. Review the changes again.'),
        tone: 'negative',
      })
    },
  })

  return {
    preview,
    isPreviewing: previewMutation.isPending,
    isCommitting: commitMutation.isPending,
    requestPreview: (body: QueryTrackingPreviewRequest) => {
      setPreview(null)
      previewMutation.mutate({ client: heyClient, path: { name: projectName }, body })
    },
    commit: (body: QueryTrackingCommitRequest) => commitMutation.mutate({
      client: heyClient,
      path: { name: projectName },
      body,
    }),
  }
}
