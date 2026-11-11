import type { ReactNode } from 'react'
import type { RunPreviewDto } from '@canonry/canonry-contracts'

import type { ApiQuery } from '../../api.js'
import { MANAGED_SWEEPS_COPY, ManagedSweepStatus } from '../project/ManagedSweepStatus.js'
import { RunPreviewSummary, type RunPreviewDetail } from '../project/RunAdmissionNotice.js'
import { connectionUsesProviderAccount } from '../settings/ProviderConnectionTest.js'

/** What the first check does, for the info icon beside its heading. */
export function firstCheckHelp(brand: string, usesAccount: boolean): string {
  return `Asks each AI engine your queries and records whether answers mention ${brand} and whether they cite its site.${usesAccount ? ' It uses your provider account.' : ''}`
}

/** The check spends a provider account unless every planned engine is a Local model server; until the preview loads, assume it does. */
export function previewUsesProviderAccount(preview: RunPreviewDto | undefined): boolean {
  return preview ? preview.engines.some(engine => connectionUsesProviderAccount(engine.provider)) : true
}

/**
 * The first AI Visibility check before it starts: the server's preview of what
 * it asks, the saved queries, and the actions that start it or step back.
 */
export function FirstCheckReview({ preview, details, queries, usesAccount, alert, actions }: {
  /** The server's preview of this exact launch, read fresh. */
  preview: { data?: RunPreviewDto; isFetching: boolean; isError: boolean; refetch: () => unknown }
  /** Rows that lead the check's details, such as its website and market. */
  details: readonly RunPreviewDetail[]
  queries: readonly ApiQuery[]
  usesAccount: boolean
  /** Why the check cannot start, or why queuing it failed. */
  alert: string | null
  /** The buttons in the step's navigation row. */
  actions: ReactNode
}) {
  return (
    <div className="compact-stack">
      <RunPreviewSummary
        preview={preview.data}
        pending={preview.isFetching}
        failed={preview.isError}
        onRetry={() => { void preview.refetch() }}
        details={details}
      />
      <details>
        <summary className="cursor-pointer py-2 text-label-14 text-link">Review saved queries</summary>
        <ul className="detail-list mt-2" aria-label="Queries in this check">
          {queries.map(query => <li key={query.id}>{query.query}</li>)}
        </ul>
      </details>
      <p className="text-copy-13 text-secondary">{usesAccount ? 'Runs once using your provider account. No schedule is created.' : 'Runs once. No schedule is created.'}</p>
      {alert ? (
        <div role="alert" className="rounded-md border border-negative bg-negative-soft p-3 text-label-14 text-negative">
          <p>{alert}</p>
        </div>
      ) : null}
      <div className="setup-nav">{actions}</div>
    </div>
  )
}

/** The first check where the deployment runs sweeps itself: its schedule, nothing to start here. */
export function ManagedFirstCheck({ projectName, error, actions }: {
  projectName: string | null
  error: string | null
  /** The buttons in the step's navigation row. */
  actions: ReactNode
}) {
  return (
    <div className="compact-stack">
      {projectName ? <ManagedSweepStatus projectName={projectName} /> : <p className="text-copy-14 text-secondary">{MANAGED_SWEEPS_COPY}</p>}
      {error && <p role="alert" className="text-copy-14 text-negative">{error}</p>}
      <div className="setup-nav">{actions}</div>
    </div>
  )
}
