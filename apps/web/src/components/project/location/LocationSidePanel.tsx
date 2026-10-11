import { useId, type ReactNode } from 'react'
import { Info, Lock } from 'lucide-react'
import type { MeasurementPlanResponse } from '@ainyc/canonry-api-client'

import { InfoTooltip } from '../../shared/InfoTooltip.js'
import { StatusNote } from '../../shared/StatusNote.js'
import { PropertyNamesSection } from '../advanced-measurement/PropertyNamesEditor.js'
import { matcherLabel } from '../advanced-measurement/v2-overview-adapter.js'

type PlanV2 = Extract<NonNullable<MeasurementPlanResponse['active']>['plan'], { schemaVersion: 2 }>

/**
 * What an answer is matched to this location by, beside what it is tracked
 * for: the site pages a cited link is credited through, and the names a
 * mention is read by. Both are the published setup's own lists. Site pages
 * are set in measurement setup, so here they are read-only for everyone.
 * Names keep their editor (`PropertyNamesSection`), which a writer opens in
 * place and a viewer never sees.
 *
 * Beside the tracked section the panel is one column. Under it, in a frame of
 * 40rem or more, its two lists sit side by side.
 */
export function LocationSidePanel({ projectName, target, activeRevision, publishedBrandNames, setupAction }: {
  projectName: string
  target: PlanV2['targets'][number]
  activeRevision: number
  publishedBrandNames: readonly string[]
  /** The one action beside an empty list of site pages, for a writer: the setup that holds them. */
  setupAction?: ReactNode
}) {
  const pagesId = useId()
  const urls = target.urlMatchers.map(matcherLabel)
  return (
    <div className="@container">
      <div className="grid content-start gap-x-8 gap-y-6 @[40rem]:grid-cols-2">
        <section aria-labelledby={pagesId} className="min-w-0">
          <div className="section-head section-head-inline flex-wrap items-center">
            {/* The count is a sibling of the heading, so it stays out of the section's name. */}
            <div className="flex items-center gap-1">
              <h2 id={pagesId} className="text-base font-semibold text-heading">Site pages we match</h2>
              <InfoTooltip placement="bottom" text="A cited source URL is credited to this location when it matches one of these. The most specific match wins, so a URL covered by two locations at the same specificity is flagged for review instead of being credited to either." />
              <span className="ml-1 text-sm tabular-nums text-secondary">{urls.length}<span className="sr-only"> {urls.length === 1 ? 'page' : 'pages'}</span></span>
            </div>
            <StatusNote icon={Lock} label="Read-only" detail="Site pages are set in measurement setup." />
          </div>
          {urls.length === 0 ? (
            <StatusNote icon={Info} label="No site pages" action={setupAction} />
          ) : (
            <ul aria-label="Site pages matched to this location" className="space-y-1.5">
              {urls.map(url => <li key={url} className="break-all text-[13px] leading-5 text-secondary">{url}</li>)}
            </ul>
          )}
        </section>
        <PropertyNamesSection
          projectName={projectName}
          targetKey={target.stableKey}
          published={target}
          activeRevision={activeRevision}
          publishedBrandNames={publishedBrandNames}
        />
      </div>
    </div>
  )
}
