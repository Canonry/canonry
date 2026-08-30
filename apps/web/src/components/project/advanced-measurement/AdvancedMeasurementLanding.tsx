import type { ReactNode } from 'react'
import type { MeasurementPortfolioSummaryResponse } from '@ainyc/canonry-api-client'

import { Button } from '../../ui/button.js'
import {
  AdvancedMeasurementOverview,
  type AdvancedMeasurementOverviewReport,
  type AdvancedMeasurementViewRequest,
} from './AdvancedMeasurementOverview.js'
import { advancedMeasurementSetupActionLabel, type AdvancedMeasurementMode } from './model.js'

export interface AdvancedMeasurementLandingProps {
  mode: AdvancedMeasurementMode
  canEdit: boolean
  simpleOverview: ReactNode
  report?: AdvancedMeasurementOverviewReport
  reportState?: 'loading' | 'ready' | 'error'
  onOpenSetup?: () => void
  onRunMeasurement?: () => void | Promise<void>
  onRetryReport?: () => void
  onViewChange?: (view: AdvancedMeasurementViewRequest) => void
  onLoadMore?: (cursor: string) => void
  onPropertyExpand?: (targetKey: string) => void
  onRetryEvidence?: () => void
  onLoadMoreEvidence?: () => void
  portfolioSummary?: MeasurementPortfolioSummaryResponse
  portfolioSummaryState?: 'loading' | 'ready' | 'error'
  onRetryPortfolioSummary?: () => void
  projectTrend?: ReactNode
  changesRail?: ReactNode
  renderGroupLink?: (group: { id: string; name: string }) => ReactNode
  renderPortfolioLink?: () => ReactNode
  /** Passed straight through so the overview table can link a Property to its own page. */
  renderPropertyLink?: (property: { id: string; name: string }) => ReactNode
  isRunningMeasurement?: boolean
  isOpeningSetup?: boolean
  isViewLoading?: boolean
  isLoadingMore?: boolean
  isLoadMoreError?: boolean
  viewSearch?: string
}

export function AdvancedMeasurementLanding({
  mode,
  canEdit,
  simpleOverview,
  report,
  reportState = 'ready',
  onOpenSetup,
  onRunMeasurement,
  onRetryReport,
  onViewChange,
  onLoadMore,
  onPropertyExpand,
  onRetryEvidence,
  onLoadMoreEvidence,
  portfolioSummary,
  portfolioSummaryState,
  onRetryPortfolioSummary,
  projectTrend,
  changesRail,
  renderGroupLink,
  renderPortfolioLink,
  renderPropertyLink,
  isRunningMeasurement,
  isOpeningSetup,
  isViewLoading,
  isLoadingMore,
  isLoadMoreError,
  viewSearch,
}: AdvancedMeasurementLandingProps) {
  if (mode.surface === 'simple-overview') {
    return simpleOverview
  }

  return (
    <div className="space-y-4">
      {/*
        Editing a published plan lives in Settings. On the results surface it
        was a control with nothing to do with reading the numbers, breaking the
        page between the headline and the table. Republish stays here because
        it reports pending work rather than offering a detour.
      */}
      {mode.setupAction === 'republish' && !report && canEdit && onOpenSetup ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="sm" disabled={isOpeningSetup} onClick={onOpenSetup}>
            {isOpeningSetup ? 'Opening setup…' : advancedMeasurementSetupActionLabel(mode.setupAction)}
          </Button>
          <p className="supporting-copy m-0">Unpublished changes are waiting to go live.</p>
        </div>
      ) : null}
      {reportState === 'loading' ? (
        <div className="h-32 animate-pulse rounded-md bg-surface-subtle" aria-label="Loading advanced measurement report" />
      ) : reportState === 'error' && !report ? (
        <div role="alert" className="border-y border-negative-800/40 bg-negative-950/20 py-4 text-sm text-negative">
          <p>Could not load the advanced measurement report.</p>
          {onRetryReport ? <Button className="mt-3" type="button" size="sm" variant="outline" onClick={onRetryReport}>Retry report</Button> : null}
        </div>
      ) : report ? (
        <AdvancedMeasurementOverview
          report={report}
          canEdit={canEdit}
          onRunMeasurement={onRunMeasurement}
          onRepublishSetup={onOpenSetup}
          onViewChange={onViewChange}
          onLoadMore={onLoadMore}
          onPropertyExpand={onPropertyExpand}
          onRetryEvidence={onRetryEvidence}
          onLoadMoreEvidence={onLoadMoreEvidence}
          portfolioSummary={portfolioSummary}
          portfolioSummaryState={portfolioSummaryState}
          onRetryPortfolioSummary={onRetryPortfolioSummary}
          projectTrend={projectTrend}
          changesRail={changesRail}
          renderGroupLink={renderGroupLink}
          renderPortfolioLink={renderPortfolioLink}
          renderPropertyLink={renderPropertyLink}
          isRunningMeasurement={isRunningMeasurement}
          isRepublishingSetup={isOpeningSetup}
          isViewLoading={isViewLoading}
          isLoadingMore={isLoadingMore}
          isLoadMoreError={isLoadMoreError}
          viewSearch={viewSearch}
        />
      ) : (
        <div role="status" className="border-y border-caution-800/40 bg-caution-950/20 py-4 text-sm text-secondary">
          No advanced measurement report is available yet.
        </div>
      )}
    </div>
  )
}
