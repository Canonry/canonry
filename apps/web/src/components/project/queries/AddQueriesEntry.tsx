import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Plus } from 'lucide-react'
import { getApiV1ProjectsByNameQueryTrackingOptions } from '@ainyc/canonry-api-client/react-query'

import { heyClient } from '../../../api.js'
import { invalidateQueryTrackingPublication } from '../../../queries/query-invalidation.js'
import { WriteButton } from '../../shared/AccessControls.js'
import { StatusNote } from '../../shared/StatusNote.js'
import { AddQueriesForm } from '../AddQueriesForm.js'
import { TrackingReview, TrackingReviewActions } from '../TrackingReview.js'
import { contextLabels, sheetContextChoices } from './tracking-contexts.js'

/** Only known project destinations are accepted when leaving the Add queries page. */
export function useAddQueriesNavigation(projectName: string) {
  const router = useRouter({ warn: false })
  const search = router?.state.location.search ?? {}
  const returnToQueries = (ignoreBlocker = false) => {
    const { addMarket: _market, addLocation: _location, addQueryIds: _queries, returnLocation, ...previous } = search
    if (returnLocation) void router?.navigate({ to: '/projects/$projectName/properties/$targetKey', params: { projectName, targetKey: returnLocation }, search: previous, ignoreBlocker })
    else void router?.navigate({ to: '/projects/$projectName/queries', params: { projectName }, search: previous, ignoreBlocker })
  }
  const openAddPage = (defaults: { market?: string; location?: string; queryIds?: readonly string[]; returnLocation?: string } = {}) => {
    void router?.navigate({
      to: '/projects/$projectName/queries/add', params: { projectName },
      search: previous => ({ ...previous, addMarket: defaults.market, addLocation: defaults.location, addQueryIds: defaults.queryIds?.join(','), returnLocation: defaults.returnLocation }),
    })
  }
  return { search, openAddPage, returnToQueries }
}

/** The Add queries page with the Add query form's search location and engines choices and the review every tracking change gets. */
export function TrackingAddQueriesPage({ workspace, sweepActive, ...form }: Omit<ComponentProps<typeof AddQueriesForm>, 'contextChoices' | 'renderReview'> & { sweepActive: boolean }) {
  // What the plan's rows are asked with, then the project's own setting: a read of every row, so once per workspace.
  const contextChoices = useMemo(() => sheetContextChoices(workspace), [workspace])
  return (
    <AddQueriesForm
      {...form}
      workspace={workspace}
      contextChoices={contextChoices}
      renderReview={review => ({
        changes: <TrackingReview {...review} workspace={workspace} contextLabels={contextLabels} sweepActive={sweepActive} showActions={false} />,
        actions: <TrackingReviewActions {...review} sweepActive={sweepActive} />,
      })}
    />
  )
}

/** Verify the current location still exists before opening its Add queries page. */
export function AddLocationQueryButton({ projectName, locationKey, className, variant = 'outline' }: {
  projectName: string
  locationKey: string
  className?: string
  /** The page's one primary action passes `default`. */
  variant?: ComponentProps<typeof WriteButton>['variant']
}) {
  const queryClient = useQueryClient()
  const [state, setState] = useState<'closed' | 'opening' | 'failed' | 'missing'>('closed')
  const { openAddPage } = useAddQueriesNavigation(projectName)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const options = getApiV1ProjectsByNameQueryTrackingOptions({ client: heyClient, path: { name: projectName } })
  async function press() {
    setState('opening')
    const read = await queryClient.fetchQuery({ ...options, staleTime: 0 }).catch(() => null)
    if (!mounted.current) return
    if (!read) return setState('failed')
    if (read.scopeOptions?.some(option => option.kind === 'property' && option.id === locationKey)) {
      setState('closed')
      openAddPage({ location: locationKey, returnLocation: locationKey })
      return
    }
    setState('missing')
    // The page's setup and this workspace disagree: the setup is read again now, the workspace on the next press.
    void invalidateQueryTrackingPublication(queryClient, projectName)
  }
  // Retry uses the same button so the failure keeps its keyboard focus.
  const retry = state === 'failed' || state === 'missing'
  return (
    <>
      {state === 'failed' ? <span role="alert"><StatusNote icon={AlertTriangle} tone="negative" label="Could not load" detail="Tracked queries did not load." /></span> : null}
      {state === 'missing' ? <span role="alert"><StatusNote icon={AlertTriangle} tone="negative" label="Location not found" detail="This location was not found in tracked queries." /></span> : null}
      <WriteButton type="button" variant={variant} size="sm" className={className} aria-label={retry ? 'Retry adding a query about this location' : undefined} disabled={state === 'opening'} onClick={() => { void press() }}>
        {retry ? null : <Plus aria-hidden="true" size={14} />}
        {state === 'opening' ? 'Opening…' : retry ? 'Retry' : 'Add query about this location'}
      </WriteButton>
    </>
  )
}
