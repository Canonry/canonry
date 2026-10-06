import type {
  ConversionTrackingContract,
  ConversionTrackingFindingCode,
  ConversionTrackingIntegrityFindingDto,
  ConversionTrackingIntegrityAssessmentDto,
  ConversionTrackingIntegrityStatus,
  GoogleAdsConnectionState,
} from '@ainyc/canonry-contracts'

import type { MetricTone } from '../../view-models.js'
import { formatTimestamp } from '../../lib/format-helpers.js'
import { WriteButton } from '../shared/AccessControls.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { Button } from '../ui/button.js'

type ProviderState = GoogleAdsConnectionState | 'unavailable'
type SnapshotState = 'loading' | 'unavailable'

export type ConversionIntegrityWorkspaceState = ConversionTrackingIntegrityStatus
  | 'not-configured'
  | 'static-mismatch'
  | 'contract-selection-required'
  | 'assessment-loading'
  | 'assessment-unavailable'

export interface ConversionIntegrityConnectionVm {
  state: ProviderState
  selection: string | null
  /** Bounded snapshot count from the provider's stored-snapshot page. */
  snapshotCount: number
  /** The snapshot read has not reached a usable result yet. */
  snapshotState?: SnapshotState
  /** A failed snapshot read must not be represented as an empty evidence set. */
  snapshotError?: string | null
  /** A short, customer-facing summary of the selected provider evidence. */
  evidence: string
  lastSnapshotAt: string | null
}

export interface ConversionIntegritySnapshotVm {
  id: string
  provider: 'google-ads' | 'gtm'
  kind: string
  capturedAt: string
}

export interface ConversionIntegrityWorkspaceVm {
  contract: ConversionTrackingContract | null
  assessment: ConversionTrackingIntegrityAssessmentDto | null
  /** Multiple saved contracts require an explicit operator choice before assessment. */
  contractSelectionRequired?: boolean
  /** The selected contract's integrity read is in progress or unavailable. */
  assessmentState?: 'loading' | 'unavailable'
  assessmentError?: string | null
  googleAds: ConversionIntegrityConnectionVm
  gtm: ConversionIntegrityConnectionVm
  /** The newest stored observations only. The API owns the full history. */
  snapshots: ConversionIntegritySnapshotVm[]
  /** Exact stored observations the selected integrity assessment compared. */
  assessmentEvidenceSnapshots?: ConversionIntegritySnapshotVm[]
}

export type ConversionIntegrityPrimaryAction =
  | 'connect-google-ads'
  | 'select-google-ads'
  | 'sync-google-ads'
  | 'connect-gtm'
  | 'select-gtm'
  | 'sync-gtm'
  | 'declare-contract'
  | 'sync-static-evidence'
  | 'review-findings'
  | 'review-runtime-verification'
  | 'retry-connection-status'
  | 'select-contract'
  | 'retry-integrity'
  | 'waiting-for-integrity'

type PrimaryActionPresentation = {
  id: ConversionIntegrityPrimaryAction
  label: string
  detail: string
}

const EMPTY_CONNECTION: ConversionIntegrityConnectionVm = {
  state: 'not-connected',
  selection: null,
  snapshotCount: 0,
  evidence: 'No stored evidence yet.',
  lastSnapshotAt: null,
}

export const EMPTY_CONVERSION_INTEGRITY_WORKSPACE: ConversionIntegrityWorkspaceVm = {
  contract: null,
  assessment: null,
  googleAds: EMPTY_CONNECTION,
  gtm: EMPTY_CONNECTION,
  snapshots: [],
}

export function conversionIntegrityState(workspace: ConversionIntegrityWorkspaceVm): ConversionIntegrityWorkspaceState {
  if (workspace.contractSelectionRequired) return 'contract-selection-required'
  if (workspace.assessmentState === 'loading') return 'assessment-loading'
  if (workspace.assessmentState === 'unavailable') return 'assessment-unavailable'
  if (hasStaticMismatch(workspace)) return 'static-mismatch'
  // A stored contract is configuration evidence in its own right. The
  // integrity endpoint enriches that state once it has compared provider
  // snapshots, but a short query transition must not make a declared
  // conversion look like it does not exist.
  return workspace.assessment?.status ?? (workspace.contract ? 'configured' : 'not-configured')
}

export function conversionIntegrityPresentation(
  state: ConversionIntegrityWorkspaceState,
): { label: string; detail: string; tone: MetricTone } {
  switch (state) {
    case 'configured':
      return {
        label: 'Configured',
        detail: 'The conversion is declared, but the static configuration is not yet proven consistent.',
        tone: 'caution',
      }
    case 'static-mismatch':
      return {
        label: 'Static mismatch',
        detail: 'Stored configuration does not match the declared conversion. Review the failing checks before relying on it.',
        tone: 'negative',
      }
    case 'statically-consistent':
      return {
        label: 'Statically consistent',
        detail: 'Stored Google Ads and Tag Manager configuration aligns with the declared conversion.',
        tone: 'positive',
      }
    case 'runtime-unverified':
      return {
        label: 'Runtime verification needed',
        detail: 'The stored configuration aligns, but a real browser event has not been observed.',
        tone: 'caution',
      }
    case 'observed':
      return {
        label: 'Observed',
        detail: 'Stored static evidence and a runtime observation support this conversion path.',
        tone: 'positive',
      }
    case 'not-configured':
      return {
        label: 'Setup needed',
        detail: 'Connect both providers, select their resources, then declare the conversion Canonry should inspect.',
        tone: 'neutral',
      }
    case 'contract-selection-required':
      return {
        label: 'Choose conversion',
        detail: 'Choose one of the declared conversions before Canonry evaluates its evidence.',
        tone: 'neutral',
      }
    case 'assessment-loading':
      return {
        label: 'Checking configuration',
        detail: 'Canonry is loading the selected conversion assessment.',
        tone: 'neutral',
      }
    case 'assessment-unavailable':
      return {
        label: 'Assessment unavailable',
        detail: 'The selected conversion could not be assessed. Retry before treating static evidence as current.',
        tone: 'negative',
      }
  }
}

/**
 * Google Ads and Tag Manager are INDEPENDENT providers: separate OAuth, separate
 * APIs, separate selections. Nothing about choosing an Ads customer is a
 * prerequisite for authorizing Tag Manager.
 *
 * The setup list used to advance strictly, showing a button only on the first
 * incomplete row, which implied a dependency that does not exist. The cost is
 * not theoretical: a Google Ads developer token still awaiting Basic approval
 * pins Ads at `selection-required` indefinitely, and that left Tag Manager
 * unreachable in the UI even though it needs no developer token and would have
 * connected in seconds.
 *
 * Each provider now owns its own next step. The conversion step is deliberately
 * still gated on both, because a contract genuinely names resources from each.
 */
function googleAdsSetupAction(
  workspace: ConversionIntegrityWorkspaceVm,
): PrimaryActionPresentation | null {
  switch (workspace.googleAds.state) {
    case 'not-connected':
      return {
        id: 'connect-google-ads',
        label: 'Connect Google Ads',
        detail: 'Canonry only queries data; connect a Google Ads user with the Read-only role.',
      }
    case 'selection-required':
      return {
        id: 'select-google-ads',
        label: 'Select Google Ads account',
        detail: 'Choose the customer account Canonry should inspect.',
      }
    case 'stale':
      return {
        id: 'sync-google-ads',
        label: 'Refresh Google Ads evidence',
        detail: 'Read the selected account again and save a new sanitized observation.',
      }
    default:
      return null
  }
}

function gtmSetupAction(
  workspace: ConversionIntegrityWorkspaceVm,
): PrimaryActionPresentation | null {
  switch (workspace.gtm.state) {
    case 'not-connected':
      return {
        id: 'connect-gtm',
        label: 'Connect Google Tag Manager',
        detail: 'Authorize read-only Tag Manager access for this project.',
      }
    case 'selection-required':
      return {
        id: 'select-gtm',
        label: 'Select Tag Manager container',
        detail: 'Choose the account and container Canonry should inspect.',
      }
    case 'stale':
      return {
        id: 'sync-gtm',
        label: 'Refresh Tag Manager evidence',
        detail: 'Read the selected container again and save a new sanitized observation.',
      }
    default:
      return null
  }
}

function conversionIntegrityPrimaryAction(
  workspace: ConversionIntegrityWorkspaceVm,
): PrimaryActionPresentation {
  if (workspace.googleAds.state === 'not-connected') {
    return {
      id: 'connect-google-ads',
      label: 'Connect Google Ads',
      detail: 'Canonry only queries data; connect a Google Ads user with the Read-only role.',
    }
  }
  if (workspace.googleAds.state === 'unavailable' || workspace.gtm.state === 'unavailable') {
    return {
      id: 'retry-connection-status',
      label: 'Retry connection status',
      detail: 'Retry the stored connection reads before starting another provider action.',
    }
  }
  if (workspace.googleAds.state === 'selection-required') {
    return {
      id: 'select-google-ads',
      label: 'Select Google Ads account',
      detail: 'Choose the customer account Canonry should inspect.',
    }
  }
  if (workspace.googleAds.state === 'stale') {
    return {
      id: 'sync-google-ads',
      label: 'Refresh Google Ads evidence',
      detail: 'Read the selected account again and save a new sanitized observation.',
    }
  }
  if (workspace.gtm.state === 'not-connected') {
    return {
      id: 'connect-gtm',
      label: 'Connect Google Tag Manager',
      detail: 'Authorize read-only Tag Manager access for this project.',
    }
  }
  if (workspace.gtm.state === 'selection-required') {
    return {
      id: 'select-gtm',
      label: 'Select Tag Manager container',
      detail: 'Choose the account and container Canonry should inspect.',
    }
  }
  if (workspace.gtm.state === 'stale') {
    return {
      id: 'sync-gtm',
      label: 'Refresh Tag Manager evidence',
      detail: 'Read the selected container again and save a new sanitized observation.',
    }
  }
  if (workspace.contractSelectionRequired) {
    return {
      id: 'select-contract',
      label: 'Select conversion',
      detail: 'Choose the declared conversion Canonry should assess.',
    }
  }
  if (!workspace.contract) {
    return {
      id: 'declare-contract',
      label: 'Declare conversion',
      detail: 'Name the website event, Google Ads action, and Tag Manager tag that must agree.',
    }
  }
  if (workspace.assessmentState === 'loading') {
    return {
      id: 'waiting-for-integrity',
      label: 'Checking configuration…',
      detail: 'Canonry is loading the selected conversion assessment.',
    }
  }
  if (workspace.assessmentState === 'unavailable') {
    return {
      id: 'retry-integrity',
      label: 'Retry assessment',
      detail: 'Retry the selected conversion assessment before acting on its evidence.',
    }
  }
  if (workspace.assessment?.status === 'runtime-unverified') {
    return {
      id: 'review-runtime-verification',
      label: 'Review runtime verification',
      detail: 'Static configuration is aligned. Verify a real browser event separately.',
    }
  }
  if (workspace.assessment?.status === 'configured' && hasNonPassingFindings(workspace)) {
    return {
      id: 'review-findings',
      label: 'Review findings',
      detail: 'Resolve the mismatched or unknown checks before treating this conversion as ready.',
    }
  }
  return {
    id: 'sync-static-evidence',
    label: 'Refresh static evidence',
    detail: 'Queue fresh read-only Google Ads and Tag Manager observations.',
  }
}

function hasStaticMismatch(workspace: ConversionIntegrityWorkspaceVm): boolean {
  return workspace.assessment?.status === 'configured'
    && workspace.assessment.findings.some((finding) => finding.outcome === 'fail')
}

function hasNonPassingFindings(workspace: ConversionIntegrityWorkspaceVm): boolean {
  return workspace.assessment?.status === 'configured'
    && workspace.assessment.findings.some((finding) => finding.outcome !== 'pass')
}

function providerStatePresentation(state: ProviderState): { label: string; tone: MetricTone } {
  switch (state) {
    case 'connected':
      return { label: 'Connected', tone: 'positive' }
    case 'stale':
      return { label: 'Needs refresh', tone: 'caution' }
    case 'selection-required':
      return { label: 'Selection needed', tone: 'caution' }
    case 'not-connected':
      return { label: 'Not connected', tone: 'neutral' }
    case 'unavailable':
      return { label: 'Unavailable', tone: 'negative' }
  }
}

function evidenceStepTone(
  step: 'configured' | 'static' | 'runtime',
  state: ConversionIntegrityWorkspaceState,
): MetricTone {
  if (step === 'configured') {
    return state === 'not-configured' || state === 'contract-selection-required' ? 'neutral' : 'positive'
  }
  if (step === 'static') {
    if (state === 'assessment-unavailable') return 'negative'
    if (state === 'assessment-loading') return 'neutral'
    if (state === 'static-mismatch') return 'negative'
    return state === 'statically-consistent' || state === 'runtime-unverified' || state === 'observed'
      ? 'positive'
      : state === 'configured' ? 'caution' : 'neutral'
  }
  return state === 'observed' ? 'positive' : state === 'runtime-unverified' ? 'caution' : 'neutral'
}

function evidenceStepLabel(
  step: 'configured' | 'static' | 'runtime',
  state: ConversionIntegrityWorkspaceState,
): string {
  if (step === 'configured') {
    return state === 'not-configured' ? 'Not declared' : state === 'contract-selection-required' ? 'Choose conversion' : 'Declared'
  }
  if (step === 'static') {
    if (state === 'assessment-unavailable') return 'Unavailable'
    if (state === 'assessment-loading') return 'Checking'
    if (state === 'static-mismatch') return 'Mismatch'
    return state === 'statically-consistent' || state === 'runtime-unverified' || state === 'observed'
      ? 'Consistent'
      : state === 'configured' ? 'Needs review' : 'Not checked'
  }
  return state === 'observed' ? 'Observed' : state === 'runtime-unverified' ? 'Not observed' : 'Not checked'
}

function shortIdentifier(value: string): string {
  if (value.length <= 12) return value
  return `…${value.slice(-10)}`
}

function contractGoalSummary(contract: ConversionTrackingContract): string {
  const checks: string[] = []
  if (contract.googleAds.requirePrimaryAction) checks.push('primary action')
  if (contract.googleAds.requireBiddableGoal) checks.push('biddable goal')
  return checks.length > 0 ? checks.join(' and ') : 'No bidding-goal assertion'
}

function runtimeSummary(contract: ConversionTrackingContract): string {
  const checks: string[] = []
  if (contract.runtime.requireTransactionId) checks.push('transaction ID')
  if (contract.runtime.requireValue) checks.push('value')
  if (contract.runtime.requireCurrency) checks.push('currency')
  return checks.length > 0 ? checks.join(', ') : 'No additional event fields required'
}

const FINDING_LABELS: Record<ConversionTrackingFindingCode, string> = {
  'ads-connection-missing': 'Google Ads connection is available',
  'ads-conversion-action-missing': 'Google Ads conversion action exists and is enabled',
  'ads-goal-missing': 'Google Ads goal includes the conversion action',
  'ads-goal-not-biddable': 'Google Ads goal is available for bidding',
  'ads-action-not-primary': 'Google Ads action is primary',
  'gtm-connection-missing': 'Tag Manager connection is available',
  'gtm-live-graph-missing': 'Tag Manager configuration is available',
  'gtm-tag-missing': 'Required Tag Manager tag exists',
  'gtm-tag-unrecognized': 'Tag Manager tag type is supported',
  'gtm-tag-paused': 'Tag Manager tag is active',
  'gtm-trigger-missing': 'Required Tag Manager trigger is linked',
  'gtm-variable-missing': 'Required Tag Manager variable is linked',
  'gtm-event-mismatch': 'Tag Manager event matches the declaration',
  'gtm-hostname-mismatch': 'Tag Manager host matches the production site',
  'gtm-value-mapping-missing': 'Conversion value mapping is present',
  'gtm-transaction-id-mapping-missing': 'Transaction ID mapping is present',
  'gtm-currency-mapping-missing': 'Currency mapping is present',
  'gtm-conversion-id-mismatch': 'Google conversion ID matches',
  'gtm-conversion-label-mismatch': 'Google conversion label matches',
  'runtime-event-not-observed': 'Website event was observed',
  'runtime-gtm-not-observed': 'Tag Manager firing was observed',
  'runtime-ads-not-observed': 'Google Ads conversion was observed',
}

function findingPresentation(finding: ConversionTrackingIntegrityFindingDto): { label: string; tone: MetricTone; outcome: string } {
  if (finding.outcome === 'pass') return { label: FINDING_LABELS[finding.code], tone: 'positive', outcome: 'Pass' }
  if (finding.outcome === 'fail') return { label: FINDING_LABELS[finding.code], tone: 'negative', outcome: 'Fail' }
  return { label: FINDING_LABELS[finding.code], tone: 'caution', outcome: 'Unknown' }
}

function runtimeHostSummary(contract: ConversionTrackingContract): string {
  return contract.runtime.productionHosts.length > 0
    ? contract.runtime.productionHosts.join(', ')
    : 'the declared production site'
}

function runtimeFieldSummary(contract: ConversionTrackingContract): string {
  const fields: string[] = []
  if (contract.runtime.requireTransactionId) fields.push('transaction ID')
  if (contract.runtime.requireValue) fields.push('conversion value')
  if (contract.runtime.requireCurrency) fields.push('currency')
  return fields.length > 0 ? fields.join(', ') : 'no additional event fields'
}

function assessmentSnapshotSource(snapshot: ConversionIntegritySnapshotVm): string {
  return snapshot.provider === 'google-ads' ? 'Google Ads' : 'Tag Manager'
}

function providerRow({
  label,
  connection,
  changeSelectionLabel,
  onChangeSelection,
  actionPending,
}: {
  label: string
  connection: ConversionIntegrityConnectionVm
  changeSelectionLabel?: string
  onChangeSelection?: () => void
  actionPending: boolean
}) {
  const state = providerStatePresentation(connection.state)
  const snapshotAvailabilityText = connection.snapshotState === 'loading'
    ? 'Loading stored snapshots'
    : connection.snapshotState === 'unavailable'
      ? 'Stored snapshots unavailable'
      : connection.snapshotCount === 0
        ? 'No stored snapshots'
        : null
  return (
    <tr>
      <td className="font-medium text-heading">{label}</td>
      <td><ToneBadge tone={state.tone}>{state.label}</ToneBadge></td>
      <td className="text-secondary">{connection.selection ?? 'No selection'}</td>
      <td>
        <p className="text-secondary">{connection.evidence}</p>
        {snapshotAvailabilityText ? (
          <p className="mt-1 text-sm text-secondary">{snapshotAvailabilityText}</p>
        ) : (
          <p className="mt-1 text-[11px] text-muted">
            {connection.snapshotCount} stored {connection.snapshotCount === 1 ? 'snapshot' : 'snapshots'}{connection.lastSnapshotAt ? `, latest ${formatTimestamp(connection.lastSnapshotAt)}` : ''}
          </p>
        )}
        {connection.snapshotError ? <p role="alert" className="mt-1 text-sm text-negative">{connection.snapshotError}</p> : null}
      </td>
      <td>
        {changeSelectionLabel && onChangeSelection ? (
          <WriteButton type="button" variant="outline" size="sm" disabled={actionPending} onClick={onChangeSelection}>
            {changeSelectionLabel}
          </WriteButton>
        ) : <span className="text-sm text-secondary">Use the next step above</span>}
      </td>
    </tr>
  )
}

/**
 * The one multi-sentence explanation this panel keeps, on the tooltip rather
 * than in the layout. It exists because the gate is otherwise unexplained: the
 * two connections are independent, but a conversion names resources from each,
 * so it is the only genuinely dependent action here.
 */
const CONVERSION_TO_CHECK_HELP = 'A conversion names the website event, the Google Ads conversion action, and the Tag Manager tag that must agree. It needs both connections selected because it references resources from each.'

const CONVERSION_TO_CHECK_BLOCKED = 'Available once Google Ads and Tag Manager are connected.'

/**
 * Shown ONLY before anything is connected.
 *
 * Every other state keeps explanation in an InfoTooltip, because a data surface
 * shows values rather than prose. An onboarding state is the documented
 * exception: there is no data to push down, and a reader who does not know what
 * the feature is cannot decide whether to connect two Google accounts to it.
 */
const CONVERSION_INTEGRITY_PURPOSE = 'Check that a conversion is wired the same way in Google Ads and Tag Manager, so the numbers you optimise against are the ones your site actually sends. Canonry only reads the configuration; it never changes or publishes it.'

function ConversionIntegritySetup({
  workspace,
  onPrimaryAction,
  onChangeGoogleAdsSelection,
  onChangeGtmSelection,
  actionPending,
  actionError,
}: {
  workspace: ConversionIntegrityWorkspaceVm
  onPrimaryAction?: (action: ConversionIntegrityPrimaryAction) => void
  onChangeGoogleAdsSelection?: () => void
  onChangeGtmSelection?: () => void
  actionPending: boolean
  actionError: string | null
}) {
  const googleAdsReady = workspace.googleAds.state === 'connected'
  const gtmReady = workspace.gtm.state === 'connected'
  // A provider read that failed is the one case that outranks everything: the
  // states below are not trustworthy until it is retried, so it takes over the
  // whole list rather than showing two buttons over stale data.
  // Each provider owns its own failure. Deriving one flag from Google Ads put
  // Retry beside the healthy row whenever only Tag Manager was unavailable, and
  // removed it from the row that had actually failed.
  const googleAdsUnavailable = workspace.googleAds.state === 'unavailable'
  const gtmUnavailable = workspace.gtm.state === 'unavailable'
  const connectionUnavailable = googleAdsUnavailable || gtmUnavailable
    || workspace.gtm.state === 'unavailable'
  const retryAction: PrimaryActionPresentation = {
    id: 'retry-connection-status',
    label: 'Retry connection status',
    detail: 'Retry the stored connection reads before starting another provider action.',
  }
  // Both connections read Ready permanently once they settle, so they share ONE
  // compact status line instead of two full-width rows that outweigh the action
  // below them. There is no 1/2/3 numbering: the providers are independent, and
  // a sequence that is permanently two-thirds complete describes nothing.
  // Neither provider settled: the one state where the reader may not know what
  // this feature is, so the purpose is stated on the page instead of in a tooltip.
  const nothingConnected = !googleAdsReady && !gtmReady

  const connections = [
    {
      title: 'Google Ads',
      state: workspace.googleAds.state,
      ready: googleAdsReady,
      summary: workspace.googleAds.selection,
      changeLabel: 'Change Google Ads account',
      onChange: onChangeGoogleAdsSelection,
      action: googleAdsUnavailable ? retryAction : googleAdsSetupAction(workspace),
    },
    {
      title: 'Tag Manager',
      state: workspace.gtm.state,
      ready: gtmReady,
      summary: workspace.gtm.selection,
      changeLabel: 'Change Tag Manager container',
      onChange: onChangeGtmSelection,
      action: gtmUnavailable ? retryAction : gtmSetupAction(workspace),
    },
  ]
  // Genuinely dependent: a contract names resources from BOTH providers, so
  // this stays gated where the connections no longer are.
  const conversionAction = googleAdsReady && gtmReady && !connectionUnavailable
    ? conversionIntegrityPrimaryAction(workspace)
    : null

  return (
    <section className="page-section" aria-labelledby="conversion-integrity-title">
      <div className="section-head mb-4">
        <div>
          <p className="eyebrow">Google marketing</p>
          <div className="mt-1 flex items-center gap-1.5">
            <h2 id="conversion-integrity-title" className="text-xl font-semibold tracking-[-0.02em] text-heading">
              Conversion Integrity
            </h2>
            <InfoTooltip text="Canonry reads your Google configuration and never changes or publishes it. Connect Google Ads and Tag Manager, then choose one website conversion to check across both." />
          </div>
          {nothingConnected ? (
            <p className="mt-2 max-w-2xl text-sm leading-6 text-secondary">{CONVERSION_INTEGRITY_PURPOSE}</p>
          ) : null}
        </div>
      </div>

      <div className="max-w-3xl">
        {/* The recurring action leads. Declaring a conversion is the only thing
            an operator returns to; the connections settle once. */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-y border-default py-4">
          <div className="flex items-center gap-1.5">
            <h3 className="text-sm font-semibold text-heading">Conversion to check</h3>
            <InfoTooltip text={CONVERSION_TO_CHECK_HELP} />
          </div>
          {conversionAction && onPrimaryAction ? (
            <WriteButton
              type="button"
              disabled={actionPending}
              onClick={() => onPrimaryAction(conversionAction.id)}
            >
              {actionPending ? 'Working…' : conversionAction.label}
            </WriteButton>
          ) : (
            <p className="text-sm text-secondary">{CONVERSION_TO_CHECK_BLOCKED}</p>
          )}
        </div>

        <ul className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-default py-3">
          {connections.map((connection) => {
            const badge = connection.ready
              ? { label: 'Ready', tone: 'positive' as MetricTone }
              : providerStatePresentation(connection.state)
            const action = connection.action
            return (
              <li key={connection.title} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-heading">{connection.title}</span>
                <ToneBadge tone={badge.tone}>{badge.label}</ToneBadge>
                {connection.summary ? (
                  <span className="min-w-0 truncate text-secondary">{connection.summary}</span>
                ) : null}
                {action && onPrimaryAction ? (
                  action.id === 'retry-connection-status' ? (
                    <Button type="button" variant="outline" size="sm" disabled={actionPending} onClick={() => onPrimaryAction(action.id)}>
                      {actionPending ? 'Working…' : action.label}
                    </Button>
                  ) : (
                    <WriteButton type="button" variant="outline" size="sm" disabled={actionPending} onClick={() => onPrimaryAction(action.id)}>
                      {actionPending ? 'Working…' : action.label}
                    </WriteButton>
                  )
                ) : null}
                {connection.summary && connection.onChange ? (
                  <WriteButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={connection.changeLabel}
                    disabled={actionPending}
                    onClick={connection.onChange}
                  >
                    Change
                  </WriteButton>
                ) : null}
              </li>
            )
          })}
        </ul>

        {actionError ? <p role="alert" className="mt-3 text-sm text-negative">{actionError}</p> : null}
      </div>
    </section>
  )
}

export function ConversionIntegritySection({
  workspace = EMPTY_CONVERSION_INTEGRITY_WORKSPACE,
  onPrimaryAction,
  actionPending = false,
  actionError = null,
  contracts = [],
  selectedContractId = null,
  onSelectContract,
  contractError = null,
  onRetryContracts,
  onRetryEvidence,
  onChangeGoogleAdsSelection,
  onChangeGtmSelection,
  onAddContract,
}: {
  workspace?: ConversionIntegrityWorkspaceVm
  /** The route adapter owns provider SDK mutations and passes this narrow action back in. */
  onPrimaryAction?: (action: ConversionIntegrityPrimaryAction) => void
  actionPending?: boolean
  actionError?: string | null
  contracts?: ConversionTrackingContract[]
  selectedContractId?: string | null
  onSelectContract?: (contractId: string) => void
  contractError?: string | null
  onRetryContracts?: () => void
  onRetryEvidence?: () => void
  /** Opens the route-owned Google Ads selection form for an existing connection. */
  onChangeGoogleAdsSelection?: () => void
  /** Opens the route-owned Tag Manager selection form for an existing connection. */
  onChangeGtmSelection?: () => void
  /** Opens the route-owned contract form without replacing an existing contract. */
  onAddContract?: () => void
}) {
  const state = conversionIntegrityState(workspace)
  const presentation = conversionIntegrityPresentation(state)
  const action = conversionIntegrityPrimaryAction(workspace)
  const findings = workspace.assessment?.findings ?? []
  const nonPassingFindings = findings.filter((finding) => finding.outcome !== 'pass')
  const passingFindings = findings.filter((finding) => finding.outcome === 'pass')
  const findingsTone: MetricTone = nonPassingFindings.some((finding) => finding.outcome === 'fail') ? 'negative' : 'caution'
  const setupIncomplete = contracts.length === 0
    && workspace.contract === null
    && !workspace.contractSelectionRequired
    && contractError === null

  if (setupIncomplete) {
    return (
      <ConversionIntegritySetup
        workspace={workspace}
        onPrimaryAction={onPrimaryAction}
        onChangeGoogleAdsSelection={onChangeGoogleAdsSelection}
        onChangeGtmSelection={onChangeGtmSelection}
        actionPending={actionPending}
        actionError={actionError}
      />
    )
  }

  return (
    <section className="page-section" aria-labelledby="conversion-integrity-title">
      <div className="section-head mb-5">
        <div>
          <p className="eyebrow">Google marketing</p>
          <h2 id="conversion-integrity-title" className="mt-1 text-xl font-semibold tracking-[-0.02em] text-heading">
            Conversion Integrity
          </h2>
          <p className="lede mt-2">
            Follow one declared website event through Tag Manager, Google Ads, and the evidence Canonry can verify.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4 border-y border-default py-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ToneBadge tone={presentation.tone}>{presentation.label}</ToneBadge>
            {workspace.assessment?.evaluatedAt ? (
              <span className="text-[11px] text-muted">Assessed {formatTimestamp(workspace.assessment.evaluatedAt)}</span>
            ) : null}
          </div>
          <p className="supporting-copy mt-2 max-w-2xl">{presentation.detail}</p>
          {workspace.assessmentEvidenceSnapshots?.length ? (
            <details className="inline-disclosure mt-3 max-w-2xl">
              <summary>Evidence used for this assessment</summary>
              <ul className="mt-3 space-y-2 text-sm leading-6 text-secondary">
                {workspace.assessmentEvidenceSnapshots.map((snapshot) => (
                  <li key={snapshot.id} className="break-words">
                    {assessmentSnapshotSource(snapshot)} {snapshot.kind}, captured {formatTimestamp(snapshot.capturedAt)}
                    <span className="ml-1 font-mono text-[11px] text-muted">({snapshot.id})</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
        <div className="shrink-0 lg:max-w-xs">
          {onPrimaryAction ? (
            action.id === 'review-findings'
              || action.id === 'review-runtime-verification'
              || action.id === 'retry-connection-status'
              || action.id === 'select-contract'
              || action.id === 'retry-integrity'
              || action.id === 'waiting-for-integrity' ? (
              <Button
                type="button"
                disabled={actionPending || action.id === 'waiting-for-integrity'}
                onClick={() => onPrimaryAction(action.id)}
              >
                {actionPending ? 'Working…' : action.label}
              </Button>
            ) : (
              <WriteButton
                type="button"
                disabled={actionPending}
                onClick={() => onPrimaryAction(action.id)}
              >
                {actionPending ? 'Working…' : action.label}
              </WriteButton>
            )
          ) : action.id === 'review-findings' ? (
            <Button asChild type="button">
              <a href="#conversion-integrity-findings">Review findings</a>
            </Button>
          ) : state === 'runtime-unverified' ? (
            <Button asChild type="button">
              <a href="#conversion-integrity-runtime-guidance">Review runtime verification</a>
            </Button>
          ) : null}
          <p className="mt-2 text-sm leading-5 text-secondary">{action.detail}</p>
          {actionError ? <p role="alert" className="mt-2 text-sm text-negative">{actionError}</p> : null}
        </div>
      </div>

      <section className="page-section-divider" aria-labelledby="conversion-integrity-contract-title">
        <div className="section-head section-head-inline">
          <div className="min-w-0">
            <p className="eyebrow eyebrow-soft">Declared conversion</p>
            <h3 id="conversion-integrity-contract-title" className="min-w-0 break-words text-base font-semibold text-heading">
              {workspace.contract?.name ?? (workspace.contractSelectionRequired ? 'Choose a conversion' : 'No conversion declared')}
            </h3>
          </div>
          {contracts.length > 0 && onAddContract ? (
            <WriteButton type="button" variant="outline" size="sm" disabled={actionPending} onClick={onAddContract}>
              Add conversion
            </WriteButton>
          ) : null}
        </div>
        {contracts.length > 1 ? (
          <label htmlFor="conversion-integrity-contract-select" className="mb-5 block max-w-xl text-sm font-medium text-secondary">
            Conversion to inspect
            <select
              id="conversion-integrity-contract-select"
              className="mt-1 w-full rounded-md border border-base bg-bg px-3 py-2 text-sm text-heading outline-none transition-colors focus:border-mono-500 focus:ring-2 focus:ring-mono-500/30"
              value={selectedContractId ?? ''}
              onChange={(event) => onSelectContract?.(event.target.value)}
            >
              <option value="">Choose a declared conversion</option>
              {contracts.map((contract) => <option key={contract.id} value={contract.id}>{contract.name}</option>)}
            </select>
          </label>
        ) : null}
        {workspace.contract ? (
          <>
            <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 xl:grid-cols-4">
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">Website event</dt>
                <dd className="mt-1 text-sm font-medium text-heading">{workspace.contract.eventName}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">Google Ads goal</dt>
                <dd className="mt-1 text-sm text-secondary">{contractGoalSummary(workspace.contract)}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">Tag Manager</dt>
                <dd className="mt-1 text-sm text-secondary">
                  {workspace.contract.gtm.triggerIds.length} {workspace.contract.gtm.triggerIds.length === 1 ? 'trigger' : 'triggers'} and {workspace.contract.gtm.variableIds.length} {workspace.contract.gtm.variableIds.length === 1 ? 'variable' : 'variables'} required
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">Runtime event fields</dt>
                <dd className="mt-1 text-sm text-secondary">{runtimeSummary(workspace.contract)}</dd>
              </div>
            </dl>
            <details className="inline-disclosure mt-5">
              <summary>Show declared identifiers</summary>
              <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                <div><dt className="text-muted">Google Ads customer</dt><dd className="mt-0.5 font-mono text-secondary">{shortIdentifier(workspace.contract.googleAds.customerId)}</dd></div>
                <div><dt className="text-muted">Google Ads conversion action</dt><dd className="mt-0.5 font-mono text-secondary">{shortIdentifier(workspace.contract.googleAds.conversionActionId)}</dd></div>
                <div><dt className="text-muted">Tag Manager container</dt><dd className="mt-0.5 font-mono text-secondary">{shortIdentifier(workspace.contract.gtm.containerId)}</dd></div>
                <div><dt className="text-muted">Tag Manager tag</dt><dd className="mt-0.5 font-mono text-secondary">{shortIdentifier(workspace.contract.gtm.tagId)}</dd></div>
              </dl>
            </details>
          </>
        ) : (
          <p className="supporting-copy max-w-2xl">
            {workspace.contractSelectionRequired
              ? 'Choose a declared conversion before Canonry evaluates the configuration.'
              : 'A contract makes the expected event and provider identifiers explicit before Canonry evaluates the configuration.'}
          </p>
        )}
        {contractError ? (
          <div role="alert" className="mt-4 flex flex-wrap items-center gap-3 text-sm text-negative">
            <span>{contractError}</span>
            {onRetryContracts ? <Button type="button" variant="outline" onClick={onRetryContracts}>Retry contracts</Button> : null}
          </div>
        ) : null}
        {workspace.assessmentError ? <p role="alert" className="mt-4 text-sm text-negative">{workspace.assessmentError}</p> : null}
      </section>

      {nonPassingFindings.length > 0 ? (
        <section id="conversion-integrity-findings" tabIndex={-1} className="page-section-divider" aria-labelledby="conversion-integrity-findings-title">
          <div className="section-head section-head-inline">
            <div>
              <p className="eyebrow eyebrow-soft">Assessment findings</p>
              <h3 id="conversion-integrity-findings-title" className="text-base font-semibold text-heading">Checks to review</h3>
            </div>
            <ToneBadge tone={findingsTone}>{nonPassingFindings.length} {nonPassingFindings.length === 1 ? 'check' : 'checks'}</ToneBadge>
          </div>
          <ul className="divide-y divide-default border-y border-default">
            {nonPassingFindings.map((finding) => {
              const item = findingPresentation(finding)
              return (
                <li key={`${finding.code}:${finding.subject}`} className="py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 break-words text-sm font-medium text-heading">{item.label}</p>
                    <ToneBadge tone={item.tone}>{item.outcome}</ToneBadge>
                  </div>
                  <p className="mt-1 break-words text-sm text-secondary">Related item: {finding.subject}</p>
                  <p className="mt-1 font-mono text-[11px] text-muted">Diagnostic: {finding.code}</p>
                  {finding.evidenceIds.length > 0 ? (
                    <p className="mt-1 break-words font-mono text-[11px] text-muted">Evidence: {finding.evidenceIds.join(', ')}</p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      <section className="page-section-divider" aria-labelledby="conversion-integrity-progression-title">
        <div className="section-head section-head-inline">
          <div className="flex items-center gap-1.5">
            <h3 id="conversion-integrity-progression-title" className="text-base font-semibold text-heading">Evidence progression</h3>
            <InfoTooltip text="Configured means a contract exists. Static configuration is checked only against saved Google Ads and Tag Manager evidence. Observed requires separate runtime evidence." />
          </div>
        </div>
        <ol className="divide-y divide-default border-y border-default">
          {[
            { key: 'configured' as const, title: 'Declared', detail: 'The event and provider identifiers are recorded in one project contract.' },
            { key: 'static' as const, title: 'Static configuration', detail: 'Sanitized Google Ads and Tag Manager snapshots are compared with that contract.' },
            { key: 'runtime' as const, title: 'Runtime observation', detail: 'A real browser event, tag firing, and recorded conversion are verified separately.' },
          ].map((step) => {
            const tone = evidenceStepTone(step.key, state)
            return (
              <li key={step.key} className="grid gap-3 py-3 sm:grid-cols-[minmax(10rem,0.7fr)_minmax(0,1fr)_auto] sm:items-center">
                <div className="flex items-center gap-2">
                  <span aria-hidden="true" className={`size-2 rounded-full ${tone === 'positive' ? 'bg-positive-fill' : tone === 'caution' ? 'bg-caution-fill' : tone === 'negative' ? 'bg-negative-fill' : 'bg-neutral-fill'}`} />
                  <span className="text-sm font-medium text-heading">{step.title}</span>
                </div>
                <p className="text-sm text-secondary">{step.detail}</p>
                <ToneBadge tone={tone}>{evidenceStepLabel(step.key, state)}</ToneBadge>
              </li>
            )
          })}
        </ol>
      </section>

      <section className="page-section-divider" aria-labelledby="conversion-integrity-connections-title">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Connection evidence</p>
            <h3 id="conversion-integrity-connections-title" className="text-base font-semibold text-heading">Google Ads and Tag Manager</h3>
          </div>
        </div>
        <div className="evidence-table-wrap">
          <table className="evidence-table">
            <caption className="sr-only">Google Ads and Tag Manager connection and stored evidence state</caption>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Connection</th>
                <th scope="col">Selection</th>
                <th scope="col">Stored evidence</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {providerRow({
                label: 'Google Ads',
                connection: workspace.googleAds,
                ...(workspace.googleAds.state === 'connected' || workspace.googleAds.state === 'stale'
                  ? { changeSelectionLabel: 'Change Google Ads account', onChangeSelection: onChangeGoogleAdsSelection }
                  : {}),
                actionPending,
              })}
              {providerRow({
                label: 'Google Tag Manager',
                connection: workspace.gtm,
                ...(workspace.gtm.state === 'connected' || workspace.gtm.state === 'stale'
                  ? { changeSelectionLabel: 'Change Tag Manager container', onChangeSelection: onChangeGtmSelection }
                  : {}),
                actionPending,
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-sm leading-6 text-caution">
          Static API evidence does not prove that a browser tag fired or that Google Ads recorded a conversion.
        </p>
        {(workspace.googleAds.snapshotError || workspace.gtm.snapshotError) && onRetryEvidence ? (
          <Button type="button" variant="outline" className="mt-3" onClick={onRetryEvidence}>Retry evidence</Button>
        ) : null}
      </section>

      {workspace.snapshots.length > 0 ? (
        <section className="page-section-divider" aria-labelledby="conversion-integrity-snapshots-title">
          <div className="section-head section-head-inline">
            <div>
              <p className="eyebrow eyebrow-soft">Recent observations</p>
              <h3 id="conversion-integrity-snapshots-title" className="text-base font-semibold text-heading">Latest sanitized snapshots</h3>
            </div>
          </div>
          <div className="evidence-table-wrap">
            <table className="evidence-table">
              <caption className="sr-only">Latest stored Google marketing snapshots</caption>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Observation</th>
                  <th scope="col">Captured</th>
                  <th scope="col">Identifier</th>
                </tr>
              </thead>
              <tbody>
                {workspace.snapshots.slice(0, 5).map((snapshot) => (
                  <tr key={snapshot.id}>
                    <td className="font-medium text-heading">{snapshot.provider === 'google-ads' ? 'Google Ads' : 'Google Tag Manager'}</td>
                    <td className="text-secondary">{snapshot.kind}</td>
                    <td className="text-secondary">{formatTimestamp(snapshot.capturedAt)}</td>
                    <td className="font-mono text-[11px] text-muted">{shortIdentifier(snapshot.id)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {passingFindings.length > 0 ? (
        <details className="inline-disclosure mt-8">
          <summary>{passingFindings.length} {passingFindings.length === 1 ? 'passing check' : 'passing checks'} from the latest assessment</summary>
          <div className="findings-table-wrap mt-3">
            <table className="findings-table">
              <caption className="sr-only">Conversion integrity findings</caption>
              <thead>
                <tr>
                  <th scope="col">Check</th>
                  <th scope="col">Result</th>
                  <th scope="col">Subject</th>
                </tr>
              </thead>
              <tbody>
                {passingFindings.map((finding) => {
                  const item = findingPresentation(finding)
                  return (
                    <tr key={`${finding.code}:${finding.subject}`}>
                      <td className="text-secondary">
                        <p>{item.label}</p>
                        <p className="mt-1 font-mono text-[11px] text-muted">Diagnostic: {finding.code}</p>
                        {finding.evidenceIds.length > 0 ? <p className="mt-1 break-words font-mono text-[11px] text-muted">Evidence: {finding.evidenceIds.join(', ')}</p> : null}
                      </td>
                      <td><ToneBadge tone={item.tone}>{item.outcome}</ToneBadge></td>
                      <td className="break-words text-secondary">{finding.subject}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      {state === 'runtime-unverified' ? (
        <section id="conversion-integrity-runtime-guidance" className="page-section-divider" aria-labelledby="conversion-integrity-runtime-title">
          <div className="section-head section-head-inline">
            <div>
              <p className="eyebrow eyebrow-soft">Runtime verification</p>
              <h3 id="conversion-integrity-runtime-title" className="text-base font-semibold text-heading">Runtime verification checklist</h3>
            </div>
          </div>
          <ol className="max-w-2xl list-decimal space-y-2 pl-5 text-sm leading-6 text-secondary marker:text-muted">
            <li>Use a controlled browser session on {runtimeHostSummary(workspace.contract!)} and complete the conversion that emits <span className="font-mono text-heading">{workspace.contract!.eventName}</span>.</li>
            <li>In Tag Manager preview or debugging, confirm tag <span className="font-mono text-heading">{shortIdentifier(workspace.contract!.gtm.tagId)}</span> fires with {runtimeFieldSummary(workspace.contract!)}.</li>
            <li>Confirm Google Ads records the matching conversion action <span className="font-mono text-heading">{shortIdentifier(workspace.contract!.googleAds.conversionActionId)}</span>. Do not change the account or publish a Tag Manager version just to verify it.</li>
          </ol>
        </section>
      ) : null}
    </section>
  )
}
