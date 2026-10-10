import { useState } from 'react'
import type { ComponentProps } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Plus } from 'lucide-react'
import { getApiV1ProjectsByNameQueryTrackingOptions } from '@ainyc/canonry-api-client/react-query'

import { heyClient } from '../../../api.js'
import { invalidateQueryTrackingPublication } from '../../../queries/query-invalidation.js'
import { WriteButton } from '../../shared/AccessControls.js'
import { StatusNote } from '../../shared/StatusNote.js'
import { AddQueriesSheet } from '../AddQueriesSheet.js'
import { TrackingReview, TrackingReviewActions } from '../TrackingReview.js'
import { contextInput, contextLabel, contextLabels, uniqueContextInputs } from './tracking-contexts.js'

/** The Add queries sheet with the Add query form's search location and engines choices and the review every tracking change gets. */
export function TrackingAddQueriesSheet({ workspace, sweepActive, ...sheet }: Omit<ComponentProps<typeof AddQueriesSheet>, 'contextChoices' | 'renderReview'> & { sweepActive: boolean }) {
  return (
    <AddQueriesSheet
      {...sheet}
      workspace={workspace}
      contextChoices={uniqueContextInputs(workspace.defaultContexts.map(contextInput)).map(input => ({ label: contextLabel(input), input }))}
      renderReview={review => ({
        changes: <TrackingReview {...review} workspace={workspace} contextLabels={contextLabels} sweepActive={sweepActive} showActions={false} />,
        actions: <TrackingReviewActions {...review} sweepActive={sweepActive} />,
      })}
    />
  )
}

/**
 * "Add query about this location" on the location page: the button, and the
 * Add queries sheet it opens on Location with that location chosen. The
 * tracking workspace is read only once the button is pressed, so loading the
 * page makes no extra request. The sheet opens only when that press's read
 * comes back holding this location. A failed read, or a workspace the page's
 * setup is behind, shows a note instead and the button reads Retry, and a later
 * refresh of the read never opens the sheet without a press. That page has no
 * Add query form, so the sheet links to none. It reads no runs either, so
 * Publish is not paused here: the server refuses a publish during a sweep and
 * the sheet shows the reason.
 */
export function AddLocationQueryButton({ projectName, locationKey, className, onPublished }: {
  projectName: string
  locationKey: string
  className?: string
  /** What the server published, so the page can say where a new query went. */
  onPublished?: ComponentProps<typeof AddQueriesSheet>['onPublished']
}) {
  const queryClient = useQueryClient()
  const [state, setState] = useState<'closed' | 'opening' | 'failed' | 'missing' | 'open'>('closed')
  const options = getApiV1ProjectsByNameQueryTrackingOptions({ client: heyClient, path: { name: projectName } })
  // The press reads. This only follows that read while the sheet is open, so a
  // refused review still refreshes the workspace version under the draft, and
  // it never counts the press's read as stale, so opening does not read twice.
  const workspace = useQuery({ ...options, enabled: state === 'open', staleTime: Infinity }).data
  async function press() {
    setState('opening')
    const read = await queryClient.fetchQuery(options).catch(() => null)
    if (!read) return setState('failed')
    if (read.scopeOptions?.some(option => option.kind === 'property' && option.id === locationKey)) return setState('open')
    setState('missing')
    // The page's setup and this workspace disagree: the setup is read again now, the workspace on the next press.
    void invalidateQueryTrackingPublication(queryClient, projectName)
  }
  // The same button reads again, so the retry keeps the keyboard focus the sheet returns to.
  const retry = state === 'failed' || state === 'missing'
  return (
    <>
      {state === 'failed' ? <span role="alert"><StatusNote icon={AlertTriangle} tone="negative" label="Could not load" detail="Tracked queries did not load." /></span> : null}
      {state === 'missing' ? <span role="alert"><StatusNote icon={AlertTriangle} tone="negative" label="Location not found" detail="This location was not found in tracked queries." /></span> : null}
      <WriteButton type="button" variant="outline" size="sm" className={className} aria-label={retry ? 'Retry adding a query about this location' : undefined} onClick={() => { void press() }}>
        {retry ? null : <Plus aria-hidden="true" size={14} />}
        {state === 'opening' ? 'Opening…' : retry ? 'Retry' : 'Add query about this location'}
      </WriteButton>
      {state === 'open' && workspace ? <TrackingAddQueriesSheet projectName={projectName} workspace={workspace} sweepActive={false} defaultLocationKey={locationKey} onPublished={onPublished} onClose={() => setState('closed')} /> : null}
    </>
  )
}
