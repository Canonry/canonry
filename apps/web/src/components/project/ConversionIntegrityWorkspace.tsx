import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { RunKinds } from '@ainyc/canonry-contracts'
import type {
  ConversionTrackingOptionsDto,
  ConversionTrackingContractWriteRequest,
  GoogleAdsConnectionStatusDto,
  GtmConnectionStatusDto,
} from '@ainyc/canonry-api-client'
import {
  deleteApiV1ProjectsByNameGoogleAdsConnectionMutation,
  deleteApiV1ProjectsByNameGtmConnectionMutation,
  getApiV1ProjectsByNameConversionTrackingContractsByContractIdIntegrityOptions,
  getApiV1ProjectsByNameConversionTrackingContractsOptions,
  getApiV1ProjectsByNameConversionTrackingOptionsOptions,
  getApiV1ProjectsByNameGoogleAdsCustomersOptions,
  getApiV1ProjectsByNameGoogleAdsSnapshotsOptions,
  getApiV1ProjectsByNameGoogleAdsStatusOptions,
  getApiV1ProjectsByNameGtmAccountsByAccountIdContainersByContainerIdWorkspacesOptions,
  getApiV1ProjectsByNameGtmAccountsByAccountIdContainersOptions,
  getApiV1ProjectsByNameGtmAccountsOptions,
  getApiV1ProjectsByNameGtmSnapshotsOptions,
  getApiV1ProjectsByNameGtmStatusOptions,
  postApiV1ProjectsByNameConversionTrackingContractsMutation,
  postApiV1ProjectsByNameGoogleAdsOauthConnectMutation,
  postApiV1ProjectsByNameGoogleAdsSyncMutation,
  postApiV1ProjectsByNameGtmOauthConnectMutation,
  postApiV1ProjectsByNameGtmSyncMutation,
  putApiV1ProjectsByNameGoogleAdsSelectionMutation,
  putApiV1ProjectsByNameGtmSelectionMutation,
} from '@ainyc/canonry-api-client/react-query'

import { heyClient, type ApiRun } from '../../api.js'
import { useAccount } from '../../contexts/account-context.js'
import { asyncHandler } from '../../lib/async-handler.js'
import { extractErrorMessage } from '../../lib/extract-error-message.js'
import { getRunTrackerState, subscribeRunTracker, trackRun } from '../../lib/run-tracker-store.js'
import { addToast } from '../../lib/toast-store.js'
import { assertCanWrite } from '../../lib/write-guard.js'
import { Button } from '../ui/button.js'
import { WriteButton } from '../shared/AccessControls.js'
import {
  ConversionIntegritySection,
  type ConversionIntegrityConnectionVm,
  type ConversionIntegrityPrimaryAction,
  type ConversionIntegritySnapshotVm,
  type ConversionIntegrityWorkspaceVm,
} from './ConversionIntegritySection.js'

const GOOGLE_MARKETING_STALE_MS = 30_000

type ContractDraft = {
  name: string
  eventName: string
  conversionActionId: string
  conversionId: string
  conversionLabel: string
  campaignIds: string
  tagId: string
  triggerIds: string
  variableIds: string
  productionHosts: string
  requireBiddableGoal: boolean
  requirePrimaryAction: boolean
  verificationRequired: boolean
  requireTransactionId: boolean
  requireValue: boolean
  requireCurrency: boolean
}

const EMPTY_CONTRACT_DRAFT: ContractDraft = {
  name: '',
  eventName: '',
  conversionActionId: '',
  conversionId: '',
  conversionLabel: '',
  campaignIds: '',
  tagId: '',
  triggerIds: '',
  variableIds: '',
  productionHosts: '',
  requireBiddableGoal: true,
  requirePrimaryAction: true,
  verificationRequired: true,
  requireTransactionId: true,
  requireValue: true,
  requireCurrency: true,
}

const fieldClassName = 'mt-1 w-full rounded-md border border-base bg-bg px-3 py-2 text-sm text-heading outline-none transition-colors placeholder-mono-600 focus:border-mono-500 focus:ring-2 focus:ring-mono-500/30'
const labelClassName = 'text-sm font-medium text-secondary'

type SnapshotEvidenceVm = Pick<ConversionIntegrityConnectionVm, 'snapshotCount' | 'snapshotState' | 'snapshotError'>

type DiscoveryResponseMeta = {
  totalAccessible: number
  truncated: boolean
}

function snapshotEvidenceVm(
  snapshotCount: number,
  isLoading: boolean,
  isError: boolean,
  error: unknown,
): SnapshotEvidenceVm {
  if (isError) {
    return {
      snapshotCount,
      snapshotState: 'unavailable',
      snapshotError: extractErrorMessage(error),
    }
  }
  if (isLoading) {
    return {
      snapshotCount,
      snapshotState: 'loading',
    }
  }
  return { snapshotCount }
}

function splitList(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map(item => item.trim()).filter(Boolean))]
}

function googleAdsConnectionVm(
  status: GoogleAdsConnectionStatusDto | undefined,
  snapshot: SnapshotEvidenceVm,
  failed: boolean,
): ConversionIntegrityConnectionVm {
  if (failed) {
    return {
      state: 'unavailable',
      selection: null,
      ...snapshot,
      evidence: 'Stored Google Ads connection status could not be loaded.',
      lastSnapshotAt: null,
    }
  }
  if (!status || status.status === 'not-connected') {
    return {
      state: 'not-connected',
      selection: null,
      ...snapshot,
      evidence: 'No Google Ads OAuth connection is stored for this project.',
      lastSnapshotAt: null,
    }
  }
  if (status.status === 'selection-required') {
    const customerId = status.connection.selection.customerId
    if (customerId) {
      return {
        state: 'stale',
        selection: `Selected customer ${customerId}`,
        ...snapshot,
        evidence: 'A customer is selected, but Canonry needs a fresh conversion-goal observation.',
        lastSnapshotAt: status.connection.lastInventorySnapshotAt,
      }
    }
    return {
      state: 'selection-required',
      selection: null,
      ...snapshot,
      evidence: 'OAuth access is connected, but Canonry needs a customer account selection.',
      lastSnapshotAt: status.connection.lastInventorySnapshotAt,
    }
  }
  const selectedCustomer = status.selectedCustomer
  return {
    state: status.status,
    selection: selectedCustomer.descriptiveName ?? `Selected customer ${selectedCustomer.customerId}`,
    ...snapshot,
    evidence: status.status === 'stale'
      ? 'The selected customer needs a fresh conversion-goal observation.'
      : 'Selected customer and conversion-goal evidence are stored.',
    lastSnapshotAt: status.connection.lastInventorySnapshotAt,
  }
}

/**
 * The identifying values of a settled Tag Manager selection, in the order an
 * operator recognises them: the container first, then the account it lives
 * under, then the draft workspace when one is pinned.
 */
function gtmSelectionSummary(
  containerId: string,
  accountId: string,
  workspaceId: string | null,
): string {
  const parts = [`Container ${containerId}`, `account ${accountId}`]
  if (workspaceId) parts.push(`workspace ${workspaceId}`)
  return parts.join(' · ')
}

function gtmConnectionVm(
  status: GtmConnectionStatusDto | undefined,
  snapshot: SnapshotEvidenceVm,
  failed: boolean,
): ConversionIntegrityConnectionVm {
  if (failed) {
    return {
      state: 'unavailable',
      selection: null,
      ...snapshot,
      evidence: 'Stored Tag Manager connection status could not be loaded.',
      lastSnapshotAt: null,
    }
  }
  if (!status || status.status === 'not-connected') {
    return {
      state: 'not-connected',
      selection: null,
      ...snapshot,
      evidence: 'No Tag Manager OAuth connection is stored for this project.',
      lastSnapshotAt: null,
    }
  }
  const selection = status.selection
  if (status.status === 'selection-required' || !selection.accountId || !selection.containerId) {
    return {
      state: 'selection-required',
      selection: null,
      ...snapshot,
      evidence: 'OAuth access is connected, but Canonry needs an account and container selection.',
      lastSnapshotAt: status.connection.lastSnapshotAt,
    }
  }
  return {
    state: status.status,
    // Name the selection, do not describe its shape. "Selected account,
    // container, and draft workspace" told an operator which FIELDS were filled
    // in, never which container they are looking at, so two projects pointed at
    // different containers read identically. The status DTO carries ids and no
    // display names, so the ids are the identity.
    selection: gtmSelectionSummary(selection.containerId, selection.accountId, selection.workspaceId),
    ...snapshot,
    evidence: status.status === 'stale'
      ? 'The selected container needs a fresh static configuration observation.'
      : 'Selected container configuration evidence is stored.',
    lastSnapshotAt: status.connection.lastSnapshotAt,
  }
}

function toContractRequest(
  draft: ContractDraft,
  googleAdsCustomerId: string,
  gtmSelection: { accountId: string; containerId: string },
): ConversionTrackingContractWriteRequest {
  return {
    name: draft.name.trim(),
    eventName: draft.eventName.trim(),
    googleAds: {
      customerId: googleAdsCustomerId,
      conversionActionId: draft.conversionActionId.trim(),
      ...(draft.conversionId.trim() ? { conversionId: draft.conversionId.trim() } : {}),
      ...(draft.conversionLabel.trim() ? { conversionLabel: draft.conversionLabel.trim() } : {}),
      campaignIds: splitList(draft.campaignIds),
      requireBiddableGoal: draft.requireBiddableGoal,
      requirePrimaryAction: draft.requirePrimaryAction,
    },
    gtm: {
      accountId: gtmSelection.accountId,
      containerId: gtmSelection.containerId,
      tagId: draft.tagId.trim(),
      triggerIds: splitList(draft.triggerIds),
      variableIds: splitList(draft.variableIds),
    },
    runtime: {
      verificationRequired: draft.verificationRequired,
      requireTransactionId: draft.requireTransactionId,
      requireValue: draft.requireValue,
      requireCurrency: draft.requireCurrency,
      productionHosts: splitList(draft.productionHosts),
    },
  }
}

function startGoogleOauth(url: string, onClosed: () => void): void {
  const popup = window.open(url, '_blank', 'width=600,height=700')
  if (!popup) {
    window.location.assign(url)
    return
  }
  const timer = window.setInterval(() => {
    if (!popup.closed) return
    window.clearInterval(timer)
    onClosed()
  }, 1_000)
}

function discoverySummary(label: string, response: DiscoveryResponseMeta | undefined, shown: number): string | null {
  if (!response) return null
  const resourceLabel = response.totalAccessible === 1 ? label : `${label}s`
  if (response.truncated) {
    return `Incomplete result: showing ${shown} of ${response.totalAccessible} accessible ${resourceLabel}. Use the CLI or API if the resource is not shown.`
  }
  return `${response.totalAccessible} accessible ${resourceLabel} found.`
}

function savedResourceQualifier(
  unavailable: boolean,
  response: DiscoveryResponseMeta | undefined,
  failed: boolean,
): string {
  if (unavailable) return 'no longer accessible'
  if (failed) return 'access not verified'
  if (!response) return 'checking access'
  return 'not in the current result'
}

function SelectionField({
  id,
  label,
  value,
  onChange,
  children,
  disabled = false,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  children: ReactNode
  disabled?: boolean
}) {
  return (
    <label htmlFor={id} className={labelClassName}>
      {label}
      <select id={id} className={fieldClassName} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        {children}
      </select>
    </label>
  )
}

function CheckField({
  id,
  checked,
  onChange,
  children,
}: {
  id: string
  checked: boolean
  onChange: (checked: boolean) => void
  children: ReactNode
}) {
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-sm text-secondary">
      <input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 size-4 rounded border-base bg-bg accent-mono-100" />
      <span>{children}</span>
    </label>
  )
}

function DisconnectConnection({
  providerLabel,
  disabled,
  onDisconnect,
}: {
  providerLabel: string
  disabled: boolean
  onDisconnect: () => Promise<void>
}) {
  const [armed, setArmed] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const controlRef = useRef<HTMLDivElement>(null)
  const keepConnectedRef = useRef<HTMLButtonElement>(null)
  const wasArmedRef = useRef(false)

  useEffect(() => {
    const wasArmed = wasArmedRef.current
    wasArmedRef.current = armed
    if (armed) keepConnectedRef.current?.focus()
    else if (wasArmed) controlRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [armed])

  function arm() {
    setError(null)
    setArmed(true)
  }

  function cancel() {
    setError(null)
    setArmed(false)
  }

  async function disconnect() {
    setDisconnecting(true)
    setError(null)
    try {
      await onDisconnect()
    } catch (disconnectError) {
      setError(extractErrorMessage(disconnectError))
      setDisconnecting(false)
    }
  }

  return (
    <div ref={controlRef} className="mt-5 border-t border-subtle pt-4">
      {armed ? (
        <div role="group" aria-label={`Confirm disconnect ${providerLabel}`} className="max-w-2xl">
          <p className="text-sm font-medium text-heading">Remove Canonry's stored access and selection?</p>
          <p className="mt-1 text-sm leading-6 text-secondary">
            Saved evidence and conversion contracts remain. New checks stop until you reconnect.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button ref={keepConnectedRef} type="button" variant="outline" size="sm" className="min-h-11" disabled={disconnecting} onClick={cancel}>
              Keep connected
            </Button>
            <WriteButton type="button" variant="destructive" size="sm" className="min-h-11" disabled={disabled || disconnecting} onClick={() => void disconnect()}>
              {disconnecting ? 'Disconnecting…' : `Disconnect ${providerLabel}`}
            </WriteButton>
          </div>
          {error ? <p role="alert" className="mt-2 text-sm text-negative">{error}</p> : null}
        </div>
      ) : (
        <WriteButton
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-11 text-negative hover:text-negative"
          disabled={disabled}
          onClick={arm}
        >
          Disconnect {providerLabel}
        </WriteButton>
      )}
    </div>
  )
}


/**
 * A field that offers real, synced choices instead of asking the operator to
 * copy an opaque numeric id out of another console.
 *
 * Keeps a manual escape hatch: a contract may legitimately point at something
 * created since the last sync, and a select alone would make that unenterable.
 * The escape hatch is the fallback, never the default.
 */
function ConversionOptionField({
  id, label, options, synced, loading, failed, onRetry, emptyHint, value, onChange,
}: {
  id: string
  label: string
  options: ConversionTrackingOptionsDto['googleAds']['conversionActions']
  synced: boolean
  loading: boolean
  /** The options READ failed. Distinct from a successful read that found none. */
  failed: boolean
  onRetry: () => void
  emptyHint: string
  value: string
  onChange: (next: string) => void
}) {
  const known = options.some((option) => option.id === value)
  const [manual, setManual] = useState(false)
  const useManual = manual || (value !== '' && !known && options.length > 0)

  // The control and its mode switch are SIBLINGS of the label, never children.
  // A <label> wrapping two interactive elements has ambiguous activation
  // semantics: clicking the text can focus the field or press the button.
  const labelEl = <label htmlFor={id} className={labelClassName}>{label}</label>

  if (loading) {
    return (
      <div>
        {labelEl}
        <select id={id} className={fieldClassName} disabled>
          <option>Loading…</option>
        </select>
      </div>
    )
  }

  // Three states that must not collapse into one. A failed read is not an
  // unsynced provider, and neither is a provider that synced and genuinely has
  // no options: telling all three to "run a sync" sends the operator to do work
  // that will not help.
  if (failed) {
    return (
      <div>
        {labelEl}
        <input id={id} required className={fieldClassName} value={value} onChange={(event) => onChange(event.target.value)} />
        <p className="mt-1 text-xs text-negative">
          Could not load the list.{' '}
          <button type="button" className="text-link underline" onClick={onRetry}>Retry</button>
        </p>
      </div>
    )
  }

  if (!synced || options.length === 0) {
    return (
      <div>
        {labelEl}
        <input id={id} required className={fieldClassName} value={value} onChange={(event) => onChange(event.target.value)} />
        <p className="mt-1 text-xs text-muted">{synced ? 'Synced, but nothing to choose from yet.' : emptyHint}</p>
      </div>
    )
  }

  return (
    <div>
      {labelEl}
      {useManual ? (
        <input id={id} required className={fieldClassName} value={value} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <select id={id} required className={fieldClassName} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">Select {label.toLowerCase()}</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
              {option.detail ? ` (${option.detail})` : ''}
              {option.active ? '' : ' — inactive'}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        className="mt-1 text-xs text-link"
        onClick={() => { setManual(!useManual); onChange('') }}
      >
        {useManual ? 'Choose from synced list' : 'Enter an ID manually'}
      </button>
    </div>
  )
}


export function ConversionIntegrityWorkspace({ projectId, projectName }: { projectId: string; projectName: string }) {
  const account = useAccount()
  const [actionError, setActionError] = useState<string | null>(null)
  const [oauthNotice, setOauthNotice] = useState<string | null>(null)
  const [showGoogleAdsConnect, setShowGoogleAdsConnect] = useState(false)
  const [developerToken, setDeveloperToken] = useState('')
  const [selectionPanel, setSelectionPanel] = useState<'google-ads' | 'gtm' | null>(null)
  const [googleAdsSelectionSeeded, setGoogleAdsSelectionSeeded] = useState(false)
  const [gtmSelectionSeeded, setGtmSelectionSeeded] = useState(false)
  const [googleAdsCustomerId, setGoogleAdsCustomerId] = useState('')
  const [loginCustomerId, setLoginCustomerId] = useState('')
  const [gtmAccountId, setGtmAccountId] = useState('')
  const [gtmContainerId, setGtmContainerId] = useState('')
  const [gtmWorkspaceId, setGtmWorkspaceId] = useState('')
  const [showContractForm, setShowContractForm] = useState(false)
  const [contractDraft, setContractDraft] = useState<ContractDraft>(EMPTY_CONTRACT_DRAFT)
  const [selectedContractId, setSelectedContractId] = useState<string | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)

  const googleAdsStatusQuery = useQuery({
    ...getApiV1ProjectsByNameGoogleAdsStatusOptions({ client: heyClient, path: { name: projectName } }),
    staleTime: GOOGLE_MARKETING_STALE_MS,
  })
  const gtmStatusQuery = useQuery({
    ...getApiV1ProjectsByNameGtmStatusOptions({ client: heyClient, path: { name: projectName } }),
    staleTime: GOOGLE_MARKETING_STALE_MS,
  })
  const contractsQuery = useQuery({
    ...getApiV1ProjectsByNameConversionTrackingContractsOptions({ client: heyClient, path: { name: projectName } }),
    staleTime: GOOGLE_MARKETING_STALE_MS,
  })
  const conversionOptionsQuery = useQuery({
    ...getApiV1ProjectsByNameConversionTrackingOptionsOptions({ client: heyClient, path: { name: projectName } }),
    staleTime: GOOGLE_MARKETING_STALE_MS,
  })
  const conversionOptions = conversionOptionsQuery.data

  const googleAdsSnapshotsQuery = useQuery({
    ...getApiV1ProjectsByNameGoogleAdsSnapshotsOptions({ client: heyClient, path: { name: projectName }, query: { limit: 5 } }),
    staleTime: GOOGLE_MARKETING_STALE_MS,
  })
  const gtmSnapshotsQuery = useQuery({
    ...getApiV1ProjectsByNameGtmSnapshotsOptions({ client: heyClient, path: { name: projectName }, query: { limit: 5 } }),
    staleTime: GOOGLE_MARKETING_STALE_MS,
  })

  const contracts = contractsQuery.data ?? []
  const selectedContract = selectedContractId
    ? contracts.find((contract) => contract.id === selectedContractId) ?? null
    : null
  const activeContract = selectedContract ?? (contracts.length === 1 ? contracts[0] ?? null : null)
  const contractSelectionRequired = contracts.length > 1 && !activeContract
  const integrityQuery = useQuery({
    ...getApiV1ProjectsByNameConversionTrackingContractsByContractIdIntegrityOptions({
      client: heyClient,
      path: { name: projectName, contractId: activeContract?.id ?? '' },
    }),
    enabled: Boolean(activeContract),
    staleTime: GOOGLE_MARKETING_STALE_MS,
  })

  const googleAdsCustomersQuery = useQuery({
    ...getApiV1ProjectsByNameGoogleAdsCustomersOptions({ client: heyClient, path: { name: projectName } }),
    enabled: selectionPanel === 'google-ads' && googleAdsStatusQuery.data?.connected === true,
    staleTime: 0,
  })
  const gtmAccountsQuery = useQuery({
    ...getApiV1ProjectsByNameGtmAccountsOptions({ client: heyClient, path: { name: projectName } }),
    enabled: selectionPanel === 'gtm' && gtmStatusQuery.data?.connected === true,
    staleTime: 0,
  })
  const gtmContainersQuery = useQuery({
    ...getApiV1ProjectsByNameGtmAccountsByAccountIdContainersOptions({
      client: heyClient,
      path: { name: projectName, accountId: gtmAccountId },
    }),
    enabled: selectionPanel === 'gtm' && Boolean(gtmAccountId),
    staleTime: 0,
  })
  const gtmWorkspacesQuery = useQuery({
    ...getApiV1ProjectsByNameGtmAccountsByAccountIdContainersByContainerIdWorkspacesOptions({
      client: heyClient,
      path: { name: projectName, accountId: gtmAccountId, containerId: gtmContainerId },
    }),
    enabled: selectionPanel === 'gtm' && Boolean(gtmAccountId) && Boolean(gtmContainerId),
    staleTime: 0,
  })

  const googleAdsOauthMutation = useMutation(postApiV1ProjectsByNameGoogleAdsOauthConnectMutation({ client: heyClient }))
  const gtmOauthMutation = useMutation(postApiV1ProjectsByNameGtmOauthConnectMutation({ client: heyClient }))
  const googleAdsSelectionMutation = useMutation(putApiV1ProjectsByNameGoogleAdsSelectionMutation({ client: heyClient }))
  const gtmSelectionMutation = useMutation(putApiV1ProjectsByNameGtmSelectionMutation({ client: heyClient }))
  const googleAdsSyncMutation = useMutation(postApiV1ProjectsByNameGoogleAdsSyncMutation({ client: heyClient }))
  const gtmSyncMutation = useMutation(postApiV1ProjectsByNameGtmSyncMutation({ client: heyClient }))
  const googleAdsDisconnectMutation = useMutation(deleteApiV1ProjectsByNameGoogleAdsConnectionMutation({ client: heyClient }))
  const gtmDisconnectMutation = useMutation(deleteApiV1ProjectsByNameGtmConnectionMutation({ client: heyClient }))
  const createContractMutation = useMutation(postApiV1ProjectsByNameConversionTrackingContractsMutation({ client: heyClient }))

  useEffect(() => {
    if (selectionPanel !== 'google-ads' || googleAdsSelectionSeeded || !googleAdsStatusQuery.isSuccess) return
    const savedSelection = googleAdsStatusQuery.data.connection?.selection
    setGoogleAdsCustomerId(savedSelection?.customerId ?? '')
    setLoginCustomerId(savedSelection?.loginCustomerId ?? '')
    setGoogleAdsSelectionSeeded(true)
  }, [googleAdsSelectionSeeded, googleAdsStatusQuery.data, googleAdsStatusQuery.isSuccess, selectionPanel])

  useEffect(() => {
    if (selectionPanel !== 'gtm' || gtmSelectionSeeded || !gtmStatusQuery.isSuccess) return
    const saved = gtmStatusQuery.data.selection
    setGtmAccountId(saved?.accountId ?? '')
    setGtmContainerId(saved?.containerId ?? '')
    setGtmWorkspaceId(saved?.workspaceId ?? '')
    setGtmSelectionSeeded(true)
  }, [gtmSelectionSeeded, gtmStatusQuery.data, gtmStatusQuery.isSuccess, selectionPanel])

  useEffect(() => {
    if (!selectedContractId || !contractsQuery.data) return
    if (!contractsQuery.data.some((contract) => contract.id === selectedContractId)) {
      setSelectedContractId(null)
    }
  }, [contractsQuery.data, selectedContractId])

  const workspace = useMemo<ConversionIntegrityWorkspaceVm>(() => {
    const googleAdsSnapshots = googleAdsSnapshotsQuery.data?.snapshots ?? []
    const gtmSnapshots = gtmSnapshotsQuery.data?.snapshots ?? []
    const snapshots: ConversionIntegritySnapshotVm[] = [
      ...googleAdsSnapshots.map(snapshot => ({
        id: snapshot.id,
        provider: 'google-ads' as const,
        kind: snapshot.kind,
        capturedAt: snapshot.capturedAt,
      })),
      ...gtmSnapshots.map(snapshot => ({
        id: snapshot.id,
        provider: 'gtm' as const,
        kind: snapshot.kind,
        capturedAt: snapshot.capturedAt,
      })),
    ].sort((left, right) => right.capturedAt.localeCompare(left.capturedAt)).slice(0, 5)
    const assessmentEvidenceSnapshots: ConversionIntegritySnapshotVm[] = []
    const googleAdsAssessmentSnapshot = integrityQuery.data?.googleAdsSnapshot
    const gtmAssessmentSnapshot = integrityQuery.data?.gtmSnapshot
    if (googleAdsAssessmentSnapshot) {
      assessmentEvidenceSnapshots.push({
        id: googleAdsAssessmentSnapshot.id,
        provider: 'google-ads',
        kind: googleAdsAssessmentSnapshot.kind,
        capturedAt: googleAdsAssessmentSnapshot.capturedAt,
      })
    }
    if (gtmAssessmentSnapshot) {
      assessmentEvidenceSnapshots.push({
        id: gtmAssessmentSnapshot.id,
        provider: 'gtm',
        kind: gtmAssessmentSnapshot.kind,
        capturedAt: gtmAssessmentSnapshot.capturedAt,
      })
    }

    return {
      contract: integrityQuery.data?.assessment.contract ?? activeContract,
      assessment: integrityQuery.data?.assessment ?? null,
      contractSelectionRequired,
      assessmentState: activeContract
        ? integrityQuery.isError ? 'unavailable'
          : integrityQuery.isLoading ? 'loading'
            : undefined
        : undefined,
      assessmentError: integrityQuery.isError ? extractErrorMessage(integrityQuery.error) : null,
      googleAds: googleAdsConnectionVm(
        googleAdsStatusQuery.data,
        snapshotEvidenceVm(
          googleAdsSnapshotsQuery.data?.total ?? 0,
          googleAdsSnapshotsQuery.isLoading,
          googleAdsSnapshotsQuery.isError,
          googleAdsSnapshotsQuery.error,
        ),
        googleAdsStatusQuery.isError,
      ),
      gtm: gtmConnectionVm(
        gtmStatusQuery.data,
        snapshotEvidenceVm(
          gtmSnapshotsQuery.data?.total ?? 0,
          gtmSnapshotsQuery.isLoading,
          gtmSnapshotsQuery.isError,
          gtmSnapshotsQuery.error,
        ),
        gtmStatusQuery.isError,
      ),
      snapshots,
      assessmentEvidenceSnapshots,
    }
  }, [
    activeContract,
    contractSelectionRequired,
    googleAdsSnapshotsQuery.data,
    googleAdsSnapshotsQuery.error,
    googleAdsSnapshotsQuery.isError,
    googleAdsSnapshotsQuery.isLoading,
    googleAdsStatusQuery.data,
    googleAdsStatusQuery.isError,
    gtmSnapshotsQuery.data,
    gtmSnapshotsQuery.error,
    gtmSnapshotsQuery.isError,
    gtmSnapshotsQuery.isLoading,
    gtmStatusQuery.data,
    gtmStatusQuery.isError,
    integrityQuery.data,
    integrityQuery.error,
    integrityQuery.isError,
    integrityQuery.isLoading,
  ])

  const trackerState = useSyncExternalStore(subscribeRunTracker, getRunTrackerState, getRunTrackerState)
  const googleMarketingSyncInFlight = Object.values(trackerState.runs).some(
    (run) => run.projectId === projectId
      && (run.kind === RunKinds['google-ads-sync'] || run.kind === RunKinds['gtm-sync']),
  )

  const actionPending = googleAdsOauthMutation.isPending
    || gtmOauthMutation.isPending
    || googleAdsSelectionMutation.isPending
    || gtmSelectionMutation.isPending
    || googleAdsSyncMutation.isPending
    || gtmSyncMutation.isPending
    || googleAdsDisconnectMutation.isPending
    || gtmDisconnectMutation.isPending
    || createContractMutation.isPending
    || googleMarketingSyncInFlight

  async function refreshStoredEvidence() {
    await Promise.all([
      googleAdsStatusQuery.refetch(),
      gtmStatusQuery.refetch(),
      contractsQuery.refetch(),
      googleAdsSnapshotsQuery.refetch(),
      gtmSnapshotsQuery.refetch(),
      conversionOptionsQuery.refetch(),
      activeContract ? integrityQuery.refetch() : Promise.resolve(),
    ])
  }

  /**
   * Selecting a resource queues a provider sync server-side, so a single
   * refetch lands BEFORE that run finishes and the operator sees the
   * pre-sync state with nothing to tell them more is coming.
   *
   * Polls until the snapshot evidence the sync writes actually appears, then
   * stops. Bounded, because a sync can fail: after the last attempt the surface
   * simply shows its normal unsynced state rather than spinning forever.
   */
  async function refreshUntilSyncLands(hasEvidence: () => boolean) {
    await refreshStoredEvidence()
    for (let attempt = 0; attempt < 10 && !hasEvidence(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      await refreshStoredEvidence()
    }
  }

  function rememberOpener() {
    const activeElement = document.activeElement
    openerRef.current = activeElement instanceof HTMLElement ? activeElement : null
  }

  function scheduleAfterRender(callback: () => void) {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(callback)
      return
    }
    globalThis.setTimeout(callback, 0)
  }

  function prefersReducedMotion() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  function focusElement(element: HTMLElement | null) {
    if (!element) return
    const naturallyFocusable = element.matches('a[href], button, input, select, textarea, [contenteditable="true"]')
    if (!naturallyFocusable && !element.hasAttribute('tabindex')) element.tabIndex = -1
    element.focus({ preventScroll: true })
  }

  function scrollAndFocus(targetId: string, focusTargetId = targetId) {
    const target = document.getElementById(targetId)
    if (target instanceof HTMLDetailsElement) target.open = true
    const scrollIntoView = (target as { scrollIntoView?: (options: ScrollIntoViewOptions) => void } | null)?.scrollIntoView
    if (typeof scrollIntoView === 'function') {
      scrollIntoView.call(target, { behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' })
    }
    focusElement(document.getElementById(focusTargetId) ?? target)
  }

  function reveal(targetId: string, headingId: string) {
    rememberOpener()
    scheduleAfterRender(() => scrollAndFocus(targetId, headingId))
  }

  function restoreOpener() {
    const opener = openerRef.current
    openerRef.current = null
    if (!opener) return
    scheduleAfterRender(() => {
      if (opener.isConnected) opener.focus({ preventScroll: true })
    })
  }

  function cancelGoogleAdsConnect() {
    setActionError(null)
    setShowGoogleAdsConnect(false)
    restoreOpener()
  }

  function cancelSelection() {
    setActionError(null)
    setSelectionPanel(null)
    restoreOpener()
  }

  function cancelContractForm() {
    setActionError(null)
    setShowContractForm(false)
    restoreOpener()
  }

  function openGoogleAdsConnect() {
    setActionError(null)
    setSelectionPanel(null)
    setShowGoogleAdsConnect(true)
    reveal('google-ads-connect-panel', 'google-ads-connect-title')
  }

  function openGoogleAdsSelection() {
    setActionError(null)
    setGoogleAdsCustomerId('')
    setLoginCustomerId('')
    setGoogleAdsSelectionSeeded(false)
    setSelectionPanel('google-ads')
    setShowGoogleAdsConnect(false)
    reveal('google-ads-selection-panel', 'google-ads-selection-title')
  }

  function openGtmSelection() {
    setActionError(null)
    setGtmAccountId('')
    setGtmContainerId('')
    setGtmWorkspaceId('')
    setGtmSelectionSeeded(false)
    setSelectionPanel('gtm')
    setShowGoogleAdsConnect(false)
    reveal('gtm-selection-panel', 'gtm-selection-title')
  }

  function openContractForm() {
    setActionError(null)
    setShowContractForm(true)
    reveal('conversion-integrity-contract-form', 'conversion-integrity-contract-form-title')
  }

  function trackGoogleMarketingRun(
    run: ApiRun,
    sourceAction: 'google-ads-sync' | 'gtm-sync',
  ) {
    trackRun({
      id: run.id,
      projectId: run.projectId,
      kind: run.kind,
      projectLabel: projectName,
      sourceAction,
    })
    addToast({
      title: sourceAction === 'google-ads-sync' ? 'Google Ads sync queued' : 'Tag Manager sync queued',
      detail: `${projectName} will refresh when the sync completes.`,
      tone: 'neutral',
      dedupeKey: `google-marketing-sync:${run.id}`,
      dedupeMode: 'replace',
    })
  }

  async function beginGoogleAdsOAuth() {
    assertCanWrite(account)
    setActionError(null)
    try {
      const result = await googleAdsOauthMutation.mutateAsync({
        path: { name: projectName },
        body: {
          provider: 'google-ads',
          ...(developerToken.trim() ? { developerToken: developerToken.trim() } : {}),
        },
      })
      setDeveloperToken('')
      setShowGoogleAdsConnect(false)
      setOauthNotice('Finish the Google Ads consent flow in the new window. Canonry will refresh stored status after it closes.')
      startGoogleOauth(result.authorizationUrl, () => {
        void refreshStoredEvidence()
        setOauthNotice(null)
        restoreOpener()
      })
    } catch (error) {
      setActionError(extractErrorMessage(error))
    }
  }

  async function beginGtmOAuth() {
    assertCanWrite(account)
    setActionError(null)
    try {
      const result = await gtmOauthMutation.mutateAsync({
        path: { name: projectName },
        body: { provider: 'gtm' },
      })
      setOauthNotice('Finish the Tag Manager consent flow in the new window. Canonry will refresh stored status after it closes.')
      startGoogleOauth(result.authorizationUrl, () => {
        void refreshStoredEvidence()
        setOauthNotice(null)
        restoreOpener()
      })
    } catch (error) {
      setActionError(extractErrorMessage(error))
    }
  }

  async function saveGoogleAdsSelection() {
    assertCanWrite(account)
    if (!googleAdsCustomerId) {
      setActionError('Select a Google Ads customer before saving.')
      return
    }
    setActionError(null)
    try {
      await googleAdsSelectionMutation.mutateAsync({
        path: { name: projectName },
        body: {
          customerId: googleAdsCustomerId,
          ...(loginCustomerId.trim() ? { loginCustomerId: loginCustomerId.trim() } : {}),
        },
      })
      setSelectionPanel(null)
      restoreOpener()
      await refreshUntilSyncLands(() => googleAdsStatusQuery.data?.selectedCustomer != null)
    } catch (error) {
      setActionError(extractErrorMessage(error))
    }
  }

  async function saveGtmSelection() {
    assertCanWrite(account)
    if (!gtmAccountId || !gtmContainerId) {
      setActionError('Select a Tag Manager account and container before saving.')
      return
    }
    setActionError(null)
    try {
      await gtmSelectionMutation.mutateAsync({
        path: { name: projectName },
        body: {
          accountId: gtmAccountId,
          containerId: gtmContainerId,
          ...(gtmWorkspaceId ? { workspaceId: gtmWorkspaceId } : {}),
        },
      })
      setSelectionPanel(null)
      restoreOpener()
      await refreshUntilSyncLands(() => gtmStatusQuery.data?.status === 'connected')
    } catch (error) {
      setActionError(extractErrorMessage(error))
    }
  }

  async function disconnectGoogleAds() {
    assertCanWrite(account)
    setActionError(null)
    await googleAdsDisconnectMutation.mutateAsync({ path: { name: projectName } })
    setSelectionPanel(null)
    setShowGoogleAdsConnect(false)
    setGoogleAdsCustomerId('')
    setLoginCustomerId('')
    setGoogleAdsSelectionSeeded(false)
    setOauthNotice(null)
    await refreshStoredEvidence()
    addToast({
      title: 'Google Ads disconnected',
      detail: 'Stored evidence and conversion contracts were retained.',
      tone: 'neutral',
      dedupeKey: `google-ads-disconnected:${projectId}`,
      dedupeMode: 'replace',
    })
    openerRef.current = null
    scheduleAfterRender(() => focusElement(document.getElementById('conversion-integrity-title')))
  }

  async function disconnectGtm() {
    assertCanWrite(account)
    setActionError(null)
    await gtmDisconnectMutation.mutateAsync({ path: { name: projectName } })
    setSelectionPanel(null)
    setGtmAccountId('')
    setGtmContainerId('')
    setGtmWorkspaceId('')
    setGtmSelectionSeeded(false)
    setOauthNotice(null)
    await refreshStoredEvidence()
    addToast({
      title: 'Tag Manager disconnected',
      detail: 'Stored evidence and conversion contracts were retained.',
      tone: 'neutral',
      dedupeKey: `gtm-disconnected:${projectId}`,
      dedupeMode: 'replace',
    })
    openerRef.current = null
    scheduleAfterRender(() => focusElement(document.getElementById('conversion-integrity-title')))
  }

  async function queueGoogleAdsSync() {
    assertCanWrite(account)
    setActionError(null)
    try {
      const run = await googleAdsSyncMutation.mutateAsync({ path: { name: projectName } })
      trackGoogleMarketingRun(run, 'google-ads-sync')
    } catch (error) {
      setActionError(extractErrorMessage(error))
    }
  }

  async function queueGtmSync() {
    assertCanWrite(account)
    setActionError(null)
    try {
      const run = await gtmSyncMutation.mutateAsync({ path: { name: projectName } })
      trackGoogleMarketingRun(run, 'gtm-sync')
    } catch (error) {
      setActionError(extractErrorMessage(error))
    }
  }

  async function queueStaticEvidenceSync() {
    assertCanWrite(account)
    setActionError(null)
    try {
      const results = await Promise.allSettled([
        googleAdsSyncMutation.mutateAsync({ path: { name: projectName } }),
        gtmSyncMutation.mutateAsync({ path: { name: projectName } }),
      ])
      const [googleAdsResult, gtmResult] = results
      if (googleAdsResult.status === 'fulfilled') {
        trackGoogleMarketingRun(googleAdsResult.value, 'google-ads-sync')
      }
      if (gtmResult.status === 'fulfilled') {
        trackGoogleMarketingRun(gtmResult.value, 'gtm-sync')
      }
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    } catch (error) {
      setActionError(extractErrorMessage(error))
    }
  }

  async function createContract() {
    assertCanWrite(account)
    const customerId = googleAdsStatusQuery.data?.connection?.selection.customerId
    const selection = gtmStatusQuery.data?.selection
    if (!customerId || !selection?.accountId || !selection.containerId) {
      setActionError('Select Google Ads and Tag Manager resources before declaring a conversion.')
      return
    }
    setActionError(null)
    try {
      const createdContract = await createContractMutation.mutateAsync({
        path: { name: projectName },
        body: toContractRequest(contractDraft, customerId, {
          accountId: selection.accountId,
          containerId: selection.containerId,
        }),
      })
      setContractDraft(EMPTY_CONTRACT_DRAFT)
      setShowContractForm(false)
      restoreOpener()
      const refreshedContracts = await contractsQuery.refetch()
      if (refreshedContracts.data?.some((contract) => contract.id === createdContract.id)) {
        setSelectedContractId(createdContract.id)
      }
    } catch (error) {
      setActionError(extractErrorMessage(error))
    }
  }

  function handlePrimaryAction(action: ConversionIntegrityPrimaryAction) {
    switch (action) {
      case 'connect-google-ads':
        openGoogleAdsConnect()
        return
      case 'connect-gtm':
        rememberOpener()
        void beginGtmOAuth()
        return
      case 'select-google-ads':
        openGoogleAdsSelection()
        return
      case 'select-gtm':
        openGtmSelection()
        return
      case 'sync-google-ads':
        void queueGoogleAdsSync()
        return
      case 'sync-gtm':
        void queueGtmSync()
        return
      case 'sync-static-evidence':
        void queueStaticEvidenceSync()
        return
      case 'declare-contract':
        openContractForm()
        return
      case 'review-findings':
        reveal('conversion-integrity-findings', 'conversion-integrity-findings')
        return
      case 'review-runtime-verification':
        reveal('conversion-integrity-runtime-guidance', 'conversion-integrity-runtime-title')
        return
      case 'retry-connection-status':
        void refreshStoredEvidence()
        return
      case 'select-contract':
        reveal('conversion-integrity-contract-select', 'conversion-integrity-contract-select')
        return
      case 'retry-integrity':
        void integrityQuery.refetch()
        return
      case 'waiting-for-integrity':
        return
    }
  }

  const googleAdsCustomers = googleAdsCustomersQuery.data?.customers ?? []
  const gtmAccounts = gtmAccountsQuery.data?.accounts ?? []
  const gtmContainers = gtmContainersQuery.data?.containers ?? []
  const gtmWorkspaces = gtmWorkspacesQuery.data?.workspaces ?? []
  const googleAdsSavedCustomerMissing = Boolean(googleAdsCustomerId) && !googleAdsCustomers.some((customer) => customer.customerId === googleAdsCustomerId)
  const gtmSavedAccountMissing = Boolean(gtmAccountId) && !gtmAccounts.some((account) => account.id === gtmAccountId)
  const gtmSavedContainerMissing = Boolean(gtmContainerId) && !gtmContainers.some((container) => container.id === gtmContainerId)
  const gtmSavedWorkspaceMissing = Boolean(gtmWorkspaceId) && !gtmWorkspaces.some((workspace) => workspace.id === gtmWorkspaceId)
  const googleAdsSavedCustomerUnavailable = googleAdsSavedCustomerMissing
    && googleAdsCustomersQuery.isSuccess
    && googleAdsCustomersQuery.data.truncated === false
  const gtmSavedAccountUnavailable = gtmSavedAccountMissing
    && gtmAccountsQuery.isSuccess
    && gtmAccountsQuery.data.truncated === false
  const gtmSavedContainerUnavailable = gtmSavedContainerMissing
    && gtmContainersQuery.isSuccess
    && gtmContainersQuery.data.truncated === false
  const gtmSavedWorkspaceUnavailable = gtmSavedWorkspaceMissing
    && gtmWorkspacesQuery.isSuccess
    && gtmWorkspacesQuery.data.truncated === false
  const gtmSavedSelectionUnavailable = gtmSavedAccountUnavailable
    || gtmSavedContainerUnavailable
    || gtmSavedWorkspaceUnavailable
  const gtmSavedSelectionUnavailableMessage = gtmSavedAccountUnavailable
    ? 'The saved Tag Manager account is no longer accessible. Choose an available account before saving.'
    : gtmSavedContainerUnavailable
      ? 'The saved Tag Manager container is no longer accessible. Choose an available container before saving.'
      : gtmSavedWorkspaceUnavailable
        ? 'The saved draft workspace is no longer accessible. Choose an available workspace or No draft workspace before saving.'
        : null
  const googleAdsSavedCustomerQualifier = savedResourceQualifier(
    googleAdsSavedCustomerUnavailable,
    googleAdsCustomersQuery.data,
    googleAdsCustomersQuery.isError,
  )
  const gtmSavedAccountQualifier = savedResourceQualifier(
    gtmSavedAccountUnavailable,
    gtmAccountsQuery.data,
    gtmAccountsQuery.isError,
  )
  const gtmSavedContainerQualifier = savedResourceQualifier(
    gtmSavedContainerUnavailable,
    gtmContainersQuery.data,
    gtmContainersQuery.isError,
  )
  const gtmSavedWorkspaceQualifier = savedResourceQualifier(
    gtmSavedWorkspaceUnavailable,
    gtmWorkspacesQuery.data,
    gtmWorkspacesQuery.isError,
  )
  const googleAdsSelectionError = googleAdsCustomersQuery.isError ? extractErrorMessage(googleAdsCustomersQuery.error) : null
  const gtmSelectionError = gtmAccountsQuery.isError ? extractErrorMessage(gtmAccountsQuery.error)
    : gtmContainersQuery.isError ? extractErrorMessage(gtmContainersQuery.error)
      : gtmWorkspacesQuery.isError ? extractErrorMessage(gtmWorkspacesQuery.error) : null
  const selectionError = selectionPanel === 'google-ads' ? googleAdsSelectionError
    : selectionPanel === 'gtm' ? gtmSelectionError
      : null
  const googleAdsDiscoverySummary = discoverySummary('customer', googleAdsCustomersQuery.data, googleAdsCustomers.length)
  const gtmAccountsDiscoverySummary = discoverySummary('account', gtmAccountsQuery.data, gtmAccounts.length)
  const gtmContainersDiscoverySummary = discoverySummary('container', gtmContainersQuery.data, gtmContainers.length)
  const gtmWorkspacesDiscoverySummary = discoverySummary('draft workspace', gtmWorkspacesQuery.data, gtmWorkspaces.length)
  const gtmSelectionFetchBlocked = gtmAccountsQuery.isError
    || gtmContainersQuery.isError
    || (gtmWorkspacesQuery.isError && Boolean(gtmWorkspaceId))
  const activeWorkspacePanel = showGoogleAdsConnect || selectionPanel !== null || showContractForm

  function retryGoogleAdsSelectionDiscovery() {
    void googleAdsCustomersQuery.refetch()
  }

  function retryGtmSelectionDiscovery() {
    if (gtmAccountsQuery.isError) {
      void gtmAccountsQuery.refetch()
      return
    }
    if (gtmContainersQuery.isError) {
      void gtmContainersQuery.refetch()
      return
    }
    if (gtmWorkspacesQuery.isError) void gtmWorkspacesQuery.refetch()
  }

  const initialSetupLoading = googleAdsStatusQuery.isLoading
    || gtmStatusQuery.isLoading
    || contractsQuery.isLoading

  if (initialSetupLoading) {
    return (
      <section className="page-section" aria-busy="true" aria-labelledby="conversion-integrity-title">
        <p className="eyebrow">Google marketing</p>
        <h2 id="conversion-integrity-title" className="mt-1 text-xl font-semibold tracking-[-0.02em] text-heading">Conversion Integrity</h2>
        <div aria-hidden="true" className="mt-5 grid gap-4 sm:grid-cols-2">
          {[0, 1].map((index) => (
            <div key={index} className="page-skeleton-card">
              <div className="skeleton-text w-28" />
              <div className="skeleton-text-sm w-full" />
              <div className="skeleton-text-sm w-3/4" />
            </div>
          ))}
        </div>
        <p role="status" className="sr-only">Loading conversion setup…</p>
      </section>
    )
  }

  if (contractsQuery.isError && !contractsQuery.data) {
    return (
      <section className="page-section" aria-labelledby="conversion-integrity-title">
        <p className="eyebrow">Google marketing</p>
        <h2 id="conversion-integrity-title" className="mt-1 text-xl font-semibold tracking-[-0.02em] text-heading">Conversion Integrity</h2>
        <p role="alert" className="mt-3 text-sm text-negative">Could not load conversion contracts: {extractErrorMessage(contractsQuery.error)}</p>
        <Button type="button" variant="outline" className="mt-3" onClick={() => void contractsQuery.refetch()}>Retry contracts</Button>
      </section>
    )
  }

  return (
    <>
      <ConversionIntegritySection
        workspace={workspace}
        onPrimaryAction={handlePrimaryAction}
        actionPending={actionPending}
        actionError={activeWorkspacePanel ? null : actionError}
        contracts={contracts}
        selectedContractId={activeContract?.id ?? null}
        onSelectContract={(contractId) => setSelectedContractId(contractId || null)}
        contractError={contractsQuery.isError ? extractErrorMessage(contractsQuery.error) : null}
        onRetryContracts={() => void contractsQuery.refetch()}
        onRetryEvidence={() => {
          void Promise.all([googleAdsSnapshotsQuery.refetch(), gtmSnapshotsQuery.refetch()])
        }}
        onChangeGoogleAdsSelection={openGoogleAdsSelection}
        onChangeGtmSelection={openGtmSelection}
        onAddContract={() => handlePrimaryAction('declare-contract')}
      />

      {oauthNotice ? <p role="status" className="page-section text-sm text-secondary">{oauthNotice}</p> : null}

      {showGoogleAdsConnect ? (
        <section id="google-ads-connect-panel" className="page-section-divider" aria-labelledby="google-ads-connect-title">
          <div className="section-head section-head-inline">
            <div>
              <p className="eyebrow eyebrow-soft">Google Ads</p>
              <h3 id="google-ads-connect-title" tabIndex={-1} className="text-base font-semibold text-heading">Connect read-only access</h3>
            </div>
          </div>
          {actionError ? <p role="alert" className="mb-4 text-sm text-negative">{actionError}</p> : null}
          <form className="max-w-xl" onSubmit={asyncHandler(async (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault()
            await beginGoogleAdsOAuth()
          })}>
            <label htmlFor="google-ads-developer-token" className={labelClassName}>
              Developer token
              <input
                id="google-ads-developer-token"
                type="password"
                autoComplete="off"
                value={developerToken}
                onChange={(event) => setDeveloperToken(event.target.value)}
                className={fieldClassName}
                placeholder="Required only when this project has no saved token"
              />
            </label>
            <p className="mt-2 text-sm leading-6 text-secondary">
              Canonry stores this securely. It never appears in saved evidence.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <WriteButton type="submit" disabled={googleAdsOauthMutation.isPending}>
                {googleAdsOauthMutation.isPending ? 'Starting…' : 'Continue to Google'}
              </WriteButton>
              <Button type="button" variant="outline" onClick={cancelGoogleAdsConnect}>Cancel</Button>
            </div>
          </form>
        </section>
      ) : null}

      {selectionPanel === 'google-ads' ? (
        <section id="google-ads-selection-panel" className="page-section-divider" aria-labelledby="google-ads-selection-title">
          <div className="section-head section-head-inline">
            <div>
              <p className="eyebrow eyebrow-soft">Google Ads</p>
              <h3 id="google-ads-selection-title" tabIndex={-1} className="text-base font-semibold text-heading">Select customer context</h3>
            </div>
          </div>
          {selectionError ? (
            <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 text-sm text-negative">
              <span>{selectionError}</span>
              <Button type="button" variant="outline" size="sm" onClick={retryGoogleAdsSelectionDiscovery}>Retry customer list</Button>
            </div>
          ) : null}
          {actionError ? <p role="alert" className="mb-4 text-sm text-negative">{actionError}</p> : null}
          {googleAdsSavedCustomerUnavailable ? <p role="alert" className="mb-4 text-sm text-negative">The saved customer is no longer accessible. Choose another customer before saving.</p> : null}
          <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
            <SelectionField id="google-ads-customer" label="Customer account" value={googleAdsCustomerId} onChange={(customerId) => {
              setGoogleAdsSelectionSeeded(true)
              setGoogleAdsCustomerId(customerId)
              const selected = googleAdsCustomers.find(customer => customer.customerId === customerId)
              setLoginCustomerId(selected?.parentCustomerId ?? '')
            }} disabled={googleAdsCustomersQuery.isLoading}>
              <option value="">{googleAdsCustomersQuery.isLoading ? 'Loading accessible customers…' : 'Select a customer'}</option>
              {googleAdsSavedCustomerMissing ? (
                <option value={googleAdsCustomerId} disabled={googleAdsSavedCustomerUnavailable}>
                  Saved customer {googleAdsCustomerId} ({googleAdsSavedCustomerQualifier})
                </option>
              ) : null}
              {googleAdsCustomers.map(customer => (
                <option key={customer.customerId} value={customer.customerId}>
                  {customer.descriptiveName ?? `Customer ${customer.customerId}`}
                </option>
              ))}
            </SelectionField>
            <label htmlFor="google-ads-login-customer" className={labelClassName}>
              Manager account ID (optional)
              <input id="google-ads-login-customer" className={fieldClassName} value={loginCustomerId} onChange={(event) => {
                setGoogleAdsSelectionSeeded(true)
                setLoginCustomerId(event.target.value)
              }} placeholder="Use only when a manager context is required" />
            </label>
          </div>
          {googleAdsDiscoverySummary ? <p role="status" className={`mt-3 text-sm ${googleAdsCustomersQuery.data?.truncated ? 'text-caution' : 'text-secondary'}`}>{googleAdsDiscoverySummary}</p> : null}
          <div className="mt-4 flex flex-wrap gap-3">
            <WriteButton type="button" disabled={googleAdsSelectionMutation.isPending || googleAdsCustomersQuery.isLoading || googleAdsCustomersQuery.isError || googleAdsSavedCustomerUnavailable || !googleAdsCustomerId} onClick={asyncHandler(saveGoogleAdsSelection)}>
              {googleAdsSelectionMutation.isPending ? 'Saving…' : 'Save customer selection'}
            </WriteButton>
            <Button type="button" variant="outline" onClick={cancelSelection}>Cancel</Button>
          </div>
          {googleAdsStatusQuery.data?.connected ? (
            <DisconnectConnection
              providerLabel="Google Ads"
              disabled={actionPending}
              onDisconnect={disconnectGoogleAds}
            />
          ) : null}
        </section>
      ) : null}

      {selectionPanel === 'gtm' ? (
        <section id="gtm-selection-panel" className="page-section-divider" aria-labelledby="gtm-selection-title">
          <div className="section-head section-head-inline">
            <div>
              <p className="eyebrow eyebrow-soft">Google Tag Manager</p>
              <h3 id="gtm-selection-title" tabIndex={-1} className="text-base font-semibold text-heading">Select container context</h3>
            </div>
          </div>
          {selectionError ? (
            <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 text-sm text-negative">
              <span>{selectionError}</span>
              <Button type="button" variant="outline" size="sm" onClick={retryGtmSelectionDiscovery}>
                {gtmAccountsQuery.isError ? 'Retry account list' : gtmContainersQuery.isError ? 'Retry container list' : 'Retry workspace list'}
              </Button>
            </div>
          ) : null}
          {actionError ? <p role="alert" className="mb-4 text-sm text-negative">{actionError}</p> : null}
          {gtmSavedSelectionUnavailableMessage ? <p role="alert" className="mb-4 text-sm text-negative">{gtmSavedSelectionUnavailableMessage}</p> : null}
          <div className="grid max-w-3xl gap-4 sm:grid-cols-3">
            <SelectionField id="gtm-account" label="Account" value={gtmAccountId} onChange={(value) => {
              setGtmSelectionSeeded(true)
              if (value !== gtmAccountId) {
                setGtmContainerId('')
                setGtmWorkspaceId('')
              }
              setGtmAccountId(value)
            }} disabled={gtmAccountsQuery.isLoading}>
              <option value="">{gtmAccountsQuery.isLoading ? 'Loading accounts…' : 'Select an account'}</option>
              {gtmSavedAccountMissing ? <option value={gtmAccountId} disabled={gtmSavedAccountUnavailable}>Saved account {gtmAccountId} ({gtmSavedAccountQualifier})</option> : null}
              {gtmAccounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
            </SelectionField>
            <SelectionField id="gtm-container" label="Container" value={gtmContainerId} onChange={(value) => {
              setGtmSelectionSeeded(true)
              if (value !== gtmContainerId) setGtmWorkspaceId('')
              setGtmContainerId(value)
            }} disabled={!gtmAccountId || gtmContainersQuery.isLoading}>
              <option value="">{gtmContainersQuery.isLoading ? 'Loading containers…' : 'Select a container'}</option>
              {gtmSavedContainerMissing ? <option value={gtmContainerId} disabled={gtmSavedContainerUnavailable}>Saved container {gtmContainerId} ({gtmSavedContainerQualifier})</option> : null}
              {gtmContainers.map(container => <option key={container.id} value={container.id}>{container.name}</option>)}
            </SelectionField>
            <SelectionField id="gtm-workspace" label="Draft workspace (optional)" value={gtmWorkspaceId} onChange={(value) => {
              setGtmSelectionSeeded(true)
              setGtmWorkspaceId(value)
            }} disabled={!gtmContainerId || gtmWorkspacesQuery.isLoading}>
              <option value="">{gtmWorkspacesQuery.isLoading ? 'Loading workspaces…' : 'No draft workspace'}</option>
              {gtmSavedWorkspaceMissing ? <option value={gtmWorkspaceId} disabled={gtmSavedWorkspaceUnavailable}>Saved draft workspace {gtmWorkspaceId} ({gtmSavedWorkspaceQualifier})</option> : null}
              {gtmWorkspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
            </SelectionField>
          </div>
          <div className="mt-3 grid max-w-3xl gap-2 text-sm sm:grid-cols-3">
            {gtmAccountsDiscoverySummary ? <p role="status" className={gtmAccountsQuery.data?.truncated ? 'text-caution' : 'text-secondary'}>{gtmAccountsDiscoverySummary}</p> : null}
            {gtmContainersDiscoverySummary ? <p role="status" className={gtmContainersQuery.data?.truncated ? 'text-caution' : 'text-secondary'}>{gtmContainersDiscoverySummary}</p> : null}
            {gtmWorkspacesDiscoverySummary ? <p role="status" className={gtmWorkspacesQuery.data?.truncated ? 'text-caution' : 'text-secondary'}>{gtmWorkspacesDiscoverySummary}</p> : null}
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <WriteButton
              type="button"
              disabled={gtmSelectionMutation.isPending
                || gtmAccountsQuery.isLoading
                || gtmContainersQuery.isLoading
                || (gtmWorkspacesQuery.isLoading && Boolean(gtmWorkspaceId))
                || gtmSelectionFetchBlocked
                || gtmSavedSelectionUnavailable
                || !gtmAccountId
                || !gtmContainerId}
              onClick={asyncHandler(saveGtmSelection)}
            >
              {gtmSelectionMutation.isPending ? 'Saving…' : 'Save container selection'}
            </WriteButton>
            <Button type="button" variant="outline" onClick={cancelSelection}>Cancel</Button>
          </div>
          {gtmStatusQuery.data?.connected ? (
            <DisconnectConnection
              providerLabel="Tag Manager"
              disabled={actionPending}
              onDisconnect={disconnectGtm}
            />
          ) : null}
        </section>
      ) : null}

      {showContractForm ? (
        <section id="conversion-integrity-contract-form" className="page-section-divider" aria-labelledby="conversion-integrity-contract-form-title">
          <div className="section-head section-head-inline">
            <div>
              <p className="eyebrow eyebrow-soft">Declared conversion</p>
              <h3 id="conversion-integrity-contract-form-title" tabIndex={-1} className="text-base font-semibold text-heading">Declare the expected path</h3>
            </div>
          </div>
          {actionError ? <p role="alert" className="mb-4 text-sm text-negative">{actionError}</p> : null}
          <form onSubmit={asyncHandler(async (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault()
            await createContract()
          })}>
            <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
              <label htmlFor="contract-name" className={labelClassName}>
                Conversion name
                <input id="contract-name" required maxLength={120} className={fieldClassName} value={contractDraft.name} onChange={(event) => setContractDraft(previous => ({ ...previous, name: event.target.value }))} placeholder="Booking completed" />
              </label>
              <label htmlFor="contract-event-name" className={labelClassName}>
                Website event
                <input id="contract-event-name" required className={fieldClassName} value={contractDraft.eventName} onChange={(event) => setContractDraft(previous => ({ ...previous, eventName: event.target.value }))} placeholder="booking_complete" />
              </label>
              <ConversionOptionField
                id="contract-conversion-action"
                label="Google Ads conversion action"
                options={conversionOptions?.googleAds.conversionActions ?? []}
                synced={conversionOptions?.googleAds.syncedAt != null}
                loading={conversionOptionsQuery.isLoading}
                failed={conversionOptionsQuery.isError}
                onRetry={() => void conversionOptionsQuery.refetch()}
                emptyHint="Run a Google Ads sync to list conversion actions."
                value={contractDraft.conversionActionId}
                onChange={(next) => setContractDraft(previous => ({ ...previous, conversionActionId: next }))}
              />
              <ConversionOptionField
                id="contract-gtm-tag"
                label="Tag Manager tag"
                options={conversionOptions?.gtm.tags ?? []}
                synced={conversionOptions?.gtm.syncedAt != null}
                loading={conversionOptionsQuery.isLoading}
                failed={conversionOptionsQuery.isError}
                onRetry={() => void conversionOptionsQuery.refetch()}
                emptyHint="Run a Tag Manager sync to list tags."
                value={contractDraft.tagId}
                onChange={(next) => setContractDraft(previous => ({ ...previous, tagId: next }))}
              />
            </div>
            <details className="inline-disclosure mt-5 max-w-3xl">
              <summary>Additional matching rules</summary>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label htmlFor="contract-conversion-id" className={labelClassName}>
                  Google conversion ID (optional)
                  <input id="contract-conversion-id" className={fieldClassName} value={contractDraft.conversionId} onChange={(event) => setContractDraft(previous => ({ ...previous, conversionId: event.target.value }))} />
                </label>
                <label htmlFor="contract-conversion-label" className={labelClassName}>
                  Google conversion label (optional)
                  <input id="contract-conversion-label" className={fieldClassName} value={contractDraft.conversionLabel} onChange={(event) => setContractDraft(previous => ({ ...previous, conversionLabel: event.target.value }))} />
                </label>
                <label htmlFor="contract-trigger-ids" className={labelClassName}>
                  Trigger IDs
                  <input id="contract-trigger-ids" className={fieldClassName} value={contractDraft.triggerIds} onChange={(event) => setContractDraft(previous => ({ ...previous, triggerIds: event.target.value }))} placeholder="Comma-separated, optional" />
                </label>
                <label htmlFor="contract-variable-ids" className={labelClassName}>
                  Variable IDs
                  <input id="contract-variable-ids" className={fieldClassName} value={contractDraft.variableIds} onChange={(event) => setContractDraft(previous => ({ ...previous, variableIds: event.target.value }))} placeholder="Comma-separated, optional" />
                </label>
                <label htmlFor="contract-campaign-ids" className={labelClassName}>
                  Campaign IDs
                  <input id="contract-campaign-ids" className={fieldClassName} value={contractDraft.campaignIds} onChange={(event) => setContractDraft(previous => ({ ...previous, campaignIds: event.target.value }))} placeholder="Optional campaign-specific goal checks" />
                </label>
                <label htmlFor="contract-production-hosts" className={labelClassName}>
                  Production hosts
                  <input id="contract-production-hosts" className={fieldClassName} value={contractDraft.productionHosts} onChange={(event) => setContractDraft(previous => ({ ...previous, productionHosts: event.target.value }))} placeholder="example.com" />
                </label>
              </div>
              <fieldset className="mt-5 border-t border-subtle pt-4">
                <legend className="text-sm font-medium text-heading">Required evidence</legend>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <CheckField id="contract-primary-action" checked={contractDraft.requirePrimaryAction} onChange={(checked) => setContractDraft(previous => ({ ...previous, requirePrimaryAction: checked }))}>Google Ads action is primary</CheckField>
                  <CheckField id="contract-biddable-goal" checked={contractDraft.requireBiddableGoal} onChange={(checked) => setContractDraft(previous => ({ ...previous, requireBiddableGoal: checked }))}>Google Ads goal is biddable</CheckField>
                  <CheckField id="contract-runtime-verification" checked={contractDraft.verificationRequired} onChange={(checked) => setContractDraft(previous => ({ ...previous, verificationRequired: checked }))}>Runtime proof is required</CheckField>
                  <CheckField id="contract-transaction-id" checked={contractDraft.requireTransactionId} onChange={(checked) => setContractDraft(previous => ({ ...previous, requireTransactionId: checked }))}>Transaction ID is required</CheckField>
                  <CheckField id="contract-value" checked={contractDraft.requireValue} onChange={(checked) => setContractDraft(previous => ({ ...previous, requireValue: checked }))}>Conversion value is required</CheckField>
                  <CheckField id="contract-currency" checked={contractDraft.requireCurrency} onChange={(checked) => setContractDraft(previous => ({ ...previous, requireCurrency: checked }))}>Currency is required</CheckField>
                </div>
              </fieldset>
            </details>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-secondary">
              This creates a Canonry contract only. It does not alter a Google Ads conversion action or create, edit, or publish a Tag Manager version.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <WriteButton type="submit" disabled={createContractMutation.isPending}>
                {createContractMutation.isPending ? 'Saving…' : 'Save conversion contract'}
              </WriteButton>
              <Button type="button" variant="outline" onClick={cancelContractForm}>Cancel</Button>
            </div>
          </form>
        </section>
      ) : null}
    </>
  )
}
