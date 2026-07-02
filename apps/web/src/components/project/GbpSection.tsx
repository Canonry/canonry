import { Fragment, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getApiV1ProjectsByNameGoogleConnectionsOptions,
  getApiV1ProjectsByNameGbpSummaryOptions,
  getApiV1ProjectsByNameGbpLocationsOptions,
  getApiV1ProjectsByNameGbpKeywordsOptions,
  getApiV1ProjectsByNameGbpLodgingOptions,
  getApiV1ProjectsByNameGbpPlaceActionsOptions,
  getApiV1ProjectsByNameGbpPlacesOptions,
  postApiV1ProjectsByNameGbpSyncMutation,
  putApiV1ProjectsByNameGbpLocationsByLocationNameSelectionMutation,
} from '@ainyc/canonry-api-client/react-query'
import type {
  GbpLocationDto,
  GbpLodgingListResponse,
  GbpPlaceActionListResponse,
  GbpPlaceDetailsListResponse,
  GbpSummaryDto,
} from '@ainyc/canonry-api-client'

import {
  formatGbpMetricLabel,
  classifyGbpMetric,
  GBP_CONVERSION_METRICS,
  GBP_REACH_METRICS,
  RunKinds,
  type InsightType,
} from '@ainyc/canonry-contracts'

import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  RechartsTooltip,
  Legend,
  ReferenceArea,
  CHART_TOOLTIP_STYLE,
  CHART_AXIS_TICK,
  CHART_AXIS_STROKE,
  CHART_GRID_STROKE,
  CHART_SERIES_COLORS,
  CHART_NEUTRAL,
  formatChartDateTick,
  formatChartDateLabel,
} from '../shared/ChartPrimitives.js'
import { fetchInsights, heyClient } from '../../api.js'
import { addToast } from '../../lib/toast-store.js'
import { getRunTrackerState, subscribeRunTracker, trackRun } from '../../lib/run-tracker-store.js'

const GBP_ATTENTION_TYPES = new Set<InsightType>([
  'gbp-listing-discrepancy',
  'gbp-lodging-gap',
  'gbp-cta-gap',
  'gbp-metric-drop',
  'gbp-keyword-drop',
])

export function GbpSection({ projectName, projectId }: { projectName: string; projectId: string }) {
  const queryClient = useQueryClient()
  // `null` = all tracked locations (aggregate). A locationName scopes every read
  // to one location. A single tracked location reads 1:1 with no selector.
  const [scopeLocation, setScopeLocation] = useState<string | null>(null)
  const [expandedLocation, setExpandedLocation] = useState<string | null>(null)
  const [showManage, setShowManage] = useState(false)

  const connectionsQuery = useQuery(
    getApiV1ProjectsByNameGoogleConnectionsOptions({ client: heyClient, path: { name: projectName } }),
  )
  const gbpConnection = connectionsQuery.data?.find((c) => c.connectionType === 'gbp')
  const connected = Boolean(gbpConnection)

  const scopeQuery = scopeLocation ? { locationName: scopeLocation } : undefined

  const locationsQuery = useQuery({
    ...getApiV1ProjectsByNameGbpLocationsOptions({ client: heyClient, path: { name: projectName } }),
    enabled: connected,
  })
  const summaryQuery = useQuery({
    ...getApiV1ProjectsByNameGbpSummaryOptions({ client: heyClient, path: { name: projectName }, query: scopeQuery }),
    enabled: connected,
  })
  const keywordsQuery = useQuery({
    ...getApiV1ProjectsByNameGbpKeywordsOptions({ client: heyClient, path: { name: projectName }, query: scopeQuery }),
    enabled: connected,
  })
  const lodgingQuery = useQuery({
    ...getApiV1ProjectsByNameGbpLodgingOptions({ client: heyClient, path: { name: projectName }, query: scopeQuery }),
    enabled: connected,
  })
  const placeActionsQuery = useQuery({
    ...getApiV1ProjectsByNameGbpPlaceActionsOptions({ client: heyClient, path: { name: projectName }, query: scopeQuery }),
    enabled: connected,
  })
  const placesQuery = useQuery({
    ...getApiV1ProjectsByNameGbpPlacesOptions({ client: heyClient, path: { name: projectName }, query: scopeQuery }),
    enabled: connected,
  })
  // Use the typed `fetchInsights` wrapper (the generated insights op is loosely
  // typed) so `data` is `InsightDto[]` and the gap filter below is type-safe.
  const insightsQuery = useQuery({
    queryKey: ['gbp-section-insights', projectName],
    queryFn: () => fetchInsights(projectName),
    enabled: connected,
  })

  function invalidateGbp() {
    void queryClient.invalidateQueries({
      predicate: (query) => {
        const head = query.queryKey[0] as { _id?: string } | undefined
        return typeof head?._id === 'string' && head._id.startsWith('getApiV1ProjectsByNameGbp')
      },
    })
  }

  // GBP sync is an async background run: POST /gbp/sync queues a `gbp-sync` run
  // and returns immediately. Hand the run to the global RunNotificationObserver
  // (via trackRun) so it polls to completion, invalidates the GBP queries once
  // the data is actually refreshed, and emits the completion toast — rather than
  // invalidating eagerly here (which refetches the same stale data while the run
  // is still in flight) and re-enabling the button the instant the POST returns.
  // Errors on the POST itself still surface through the global error toast.
  const syncMutation = useMutation({
    ...postApiV1ProjectsByNameGbpSyncMutation(),
    onSuccess: (data) => {
      trackRun({
        id: data.runId,
        projectId,
        kind: RunKinds['gbp-sync'],
        projectLabel: projectName,
        sourceAction: 'gbp-sync',
      })
      addToast({
        title: 'Business Profile sync started',
        detail: `${projectName} will refresh when the sync completes.`,
        tone: 'neutral',
        dedupeKey: `gbp-sync:${projectName}`,
        dedupeMode: 'replace',
      })
    },
  })

  // Keep the Sync button disabled until the queued run reaches a terminal
  // status. `syncMutation.isPending` only covers the brief POST; the tracked
  // run (cleared by RunNotificationObserver on completion) covers the
  // background sync that follows.
  const trackerState = useSyncExternalStore(subscribeRunTracker, getRunTrackerState, getRunTrackerState)
  const gbpSyncInFlight = Object.values(trackerState.runs).some(
    (run) => run.kind === RunKinds['gbp-sync'] && run.projectId === projectId,
  )
  const isSyncing = syncMutation.isPending || gbpSyncInFlight

  const selectionMutation = useMutation({
    ...putApiV1ProjectsByNameGbpLocationsByLocationNameSelectionMutation(),
    onSuccess: () => invalidateGbp(),
  })

  // If the active scope is no longer a selectable location — it was untracked,
  // or the tracked set shrank below the 2 needed to render the scope selector —
  // fall back to the aggregate view. Otherwise the selector disappears while
  // `scopeLocation` persists, leaving the section stuck on a hidden/untracked
  // location with no control to reset it.
  useEffect(() => {
    if (!scopeLocation || !locationsQuery.data) return
    const tracked = locationsQuery.data.locations.filter((l) => l.selected)
    if (tracked.length <= 1 || !tracked.some((l) => l.locationName === scopeLocation)) {
      setScopeLocation(null)
    }
  }, [scopeLocation, locationsQuery.data])

  useEffect(() => {
    if (!expandedLocation || !locationsQuery.data) return
    const visibleLocationNames = scopeLocation
      ? [scopeLocation]
      : locationsQuery.data.locations.filter((l) => l.selected).map((l) => l.locationName)
    if (!visibleLocationNames.includes(expandedLocation)) setExpandedLocation(null)
  }, [expandedLocation, locationsQuery.data, scopeLocation])

  if (connectionsQuery.isLoading) return null

  // The "Local Presence" tab is always reachable; when no Google Business
  // Profile is connected it renders a setup guide (onboarding state), not a
  // blank page. GBP setup is OAuth + account + location selection, so the
  // proven path is the CLI; the guide walks the four steps.
  if (!gbpConnection) {
    const steps: Array<{ title: string; command: string; note: ReactNode }> = [
      {
        title: 'Connect your Google account',
        command: `canonry gbp connect ${projectName}`,
        note: 'Opens Google OAuth. Grant Business Profile (business.manage) access.',
      },
      {
        title: 'Choose the account',
        command: `canonry gbp accounts ${projectName}`,
        note: 'Pick which Business Profile account this project tracks.',
      },
      {
        title: 'Select locations',
        command: `canonry gbp locations discover ${projectName}`,
        note: <>Then adopt the ones to sync: <code className="rounded bg-bg-elevated/80 px-1 py-0.5 font-mono text-[11px] text-secondary">canonry gbp locations select {projectName} &lt;location&gt;</code></>,
      },
      {
        title: 'Sync, and keep it fresh',
        command: `canonry gbp sync ${projectName}`,
        note: <>Schedule it: <code className="rounded bg-bg-elevated/80 px-1 py-0.5 font-mono text-[11px] text-secondary">canonry schedule set {projectName} --kind gbp-sync --preset daily</code></>,
      },
    ]
    return (
      <section className="page-section-divider">
        <Card className="surface-card">
          <p className="eyebrow eyebrow-soft">Local presence</p>
          <h2>Connect Google Business Profile</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
            Track local performance, search terms, place-action CTAs, and how your public Maps listing compares to
            the profile you control. Four steps from the CLI:
          </p>
          <ol className="mt-5 space-y-4">
            {steps.map((step, index) => (
              <li key={step.title} className="grid grid-cols-[1.5rem_1fr] gap-x-3">
                <span className="mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-mono-800 text-xs font-medium tabular-nums text-neutral" aria-hidden="true">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-strong">{step.title}</p>
                  <code className="mt-1.5 inline-block w-fit max-w-full overflow-x-auto rounded bg-bg-elevated/80 px-2 py-1 font-mono text-xs text-neutral">
                    {step.command}
                  </code>
                  <p className="mt-1 text-xs leading-5 text-muted">{step.note}</p>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      </section>
    )
  }

  const summary = summaryQuery.data
  const locations = locationsQuery.data?.locations ?? []
  const trackedLocations = locations.filter((l) => l.selected)
  const keywords = keywordsQuery.data?.keywords ?? []
  const lodging = lodgingQuery.data?.lodging ?? []
  const placeActions = placeActionsQuery.data?.placeActions ?? []
  const places = placesQuery.data?.places ?? []
  const account = locations.length > 0 ? locations[0].accountName : gbpConnection.domain

  const scopeDisplayName = scopeLocation
    ? locations.find((l) => l.locationName === scopeLocation)?.displayName ?? null
    : null
  const evidenceLocations = scopeLocation
    ? locations.filter((l) => l.locationName === scopeLocation)
    : trackedLocations
  const evidenceLocationNames = new Set(evidenceLocations.map((l) => l.locationName))
  const evidenceLodging = lodging.filter((l) => evidenceLocationNames.has(l.locationName))
  const evidencePlaceActions = placeActions.filter((pa) => evidenceLocationNames.has(pa.locationName))
  const evidencePlaces = places.filter((p) => evidenceLocationNames.has(p.locationName))
  const keywordLocationNames = new Set(trackedLocations.map((l) => l.locationName))
  const visibleKeywords = scopeLocation ? keywords : keywords.filter((kw) => keywordLocationNames.has(kw.locationName))
  const showKeywordLocation = !scopeLocation && trackedLocations.length > 1

  // Local-presence attention items are computed server-side by the GBP analyzer;
  // the dashboard only filters them into this tab and scopes them to the active
  // location when one is selected.
  const attentionInsights = (insightsQuery.data ?? []).filter((ins) =>
    !ins.dismissed
    && GBP_ATTENTION_TYPES.has(ins.type)
    && (!scopeDisplayName || ins.query === scopeDisplayName || ins.query === scopeLocation || ins.title.startsWith(scopeDisplayName)),
  )

  return (
    <section className="page-section-divider">
      <Card className="surface-card">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Local presence</p>
            <h2 className="flex items-center gap-2">
              Google Business Profile
              <InfoTooltip text="How AI answer engines and Maps surface this business: performance, search terms, and how your public listing compares to the profile you control." />
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <ToneBadge tone="positive">Connected</ToneBadge>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isSyncing}
              onClick={() => syncMutation.mutate({ client: heyClient, path: { name: projectName }, body: {} })}
            >
              {isSyncing ? 'Syncing…' : 'Sync'}
            </Button>
          </div>
        </div>

        <p className="mb-4 text-xs text-muted">
          {account ? <>Account <span className="font-mono text-secondary">{account}</span> · </> : null}
          {locationsQuery.data ? `${locationsQuery.data.totalSelected} of ${locationsQuery.data.totalDiscovered} locations tracked` : 'Loading locations…'}
        </p>

        {/* Location scope selector — only when more than one location is tracked. */}
        {trackedLocations.length > 1 && (
          <div className="mb-5 flex flex-wrap gap-1.5" role="tablist" aria-label="Location">
            <ScopeChip label="All locations" active={scopeLocation === null} onClick={() => setScopeLocation(null)} />
            {trackedLocations.map((loc) => (
              <ScopeChip
                key={loc.id}
                label={loc.displayName}
                active={scopeLocation === loc.locationName}
                onClick={() => setScopeLocation(loc.locationName)}
              />
            ))}
          </div>
        )}

        {trackedLocations.length === 0 ? (
          <p className="text-sm text-muted">
            No locations are tracked yet. Open <span className="font-medium text-neutral">Manage locations</span> below to track the one(s) for this business.
          </p>
        ) : (
          <>
            {attentionInsights.length > 0 && (
              <div className="mb-6 grid gap-2">
                <p className="eyebrow eyebrow-soft">Needs attention</p>
                {attentionInsights.map((ins) => (
                  <div key={ins.id} className={['insight-card', insightCardToneClass(ins.severity), 'rounded-r-lg border border-default bg-surface p-3 pl-4'].filter(Boolean).join(' ')}>
                    <p className="flex items-center gap-2 text-sm font-medium text-strong">
                      {ins.title}
                      {ins.recommendation?.reason && <InfoTooltip text={ins.recommendation.reason} />}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {/* Performance — graph-first: daily profile-action trend (the hero) and
                a reach area, with the reporting-lag tail marked pending and
                all-zero series collapsed to a footnote (#658). */}
            {summary && (
              <GbpPerformance
                performance={summary.performance}
                freshness={summary.freshness}
                timeseries={summary.timeseries}
              />
            )}

            {summary?.profileCompleteness && (
              <GbpProfileCompleteness summary={summary.profileCompleteness} />
            )}

            {evidenceLocations.length > 0 && (
              <GbpLocationEvidenceTable
                locations={evidenceLocations}
                lodging={evidenceLodging}
                places={evidencePlaces}
                placeActions={evidencePlaceActions}
                expandedLocation={expandedLocation}
                onToggleExpanded={(locationName) => {
                  setExpandedLocation((current) => current === locationName ? null : locationName)
                }}
              />
            )}

            {/* Search keywords table. */}
            <div className="mb-2">
              <div className="section-head section-head-inline mb-2">
                <p className="eyebrow eyebrow-soft">Search terms</p>
                {keywordsQuery.data && keywordsQuery.data.total > 0 && (
                  <span className="text-[11px] text-faint">
                    {keywordsQuery.data.thresholdedPct}% privacy-thresholded
                  </span>
                )}
              </div>
              {visibleKeywords.length === 0 ? (
                <p className="text-sm text-muted">No keyword impressions stored yet.</p>
              ) : (
                <table className="data-table w-full text-sm">
                  <thead>
                    <tr>
                      <th className="text-left">Search term</th>
                      {showKeywordLocation && <th className="text-left">Location</th>}
                      <th className="text-right">Impressions</th>
                      <th className="text-right">Window</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleKeywords.slice(0, 25).map((kw) => (
                      <tr key={`${kw.locationName}:${kw.keyword}`}>
                        <td className="text-neutral">{kw.keyword}</td>
                        {showKeywordLocation && (
                          <td className="text-muted">
                            {locations.find((l) => l.locationName === kw.locationName)?.displayName ?? kw.locationName}
                          </td>
                        )}
                        <td className="text-right font-mono text-strong">
                          {kw.valueCount !== null
                            ? kw.valueCount.toLocaleString()
                            : <span className="text-muted" title="Privacy floor — Google withheld the exact count">{'<'}{kw.valueThreshold}</span>}
                        </td>
                        <td className="text-right font-mono text-[11px] text-faint">{kw.periodStart}–{kw.periodEnd}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}

        {/* Manage locations — demoted. Discovery surfaces every location the
            connected Google account can see (often unrelated businesses); track
            only the one(s) for this project here. */}
        <div className="mt-6 border-t border-default pt-4">
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs font-medium text-secondary hover:text-strong"
            onClick={() => setShowManage((v) => !v)}
            aria-expanded={showManage}
          >
            <span aria-hidden="true">{showManage ? '▾' : '▸'}</span> Manage locations ({locations.length})
          </button>
          {showManage && (
            <div className="mt-3">
              {locations.length === 0 ? (
                <p className="text-sm text-muted">No locations discovered. Run <span className="font-mono">canonry gbp locations discover</span>.</p>
              ) : (
                <table className="data-table w-full text-sm">
                  <thead>
                    <tr>
                      <th className="text-left">Location</th>
                      <th className="text-left">Address</th>
                      <th className="text-left">Status</th>
                      <th className="text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {locations.map((loc) => (
                      <tr key={loc.id}>
                        <td className="text-strong">{loc.displayName}</td>
                        <td className="text-muted">{loc.storefrontAddress ?? '—'}</td>
                        <td>
                          <ToneBadge tone={loc.selected ? 'positive' : 'neutral'}>
                            {loc.selected ? 'Tracked' : 'Not tracked'}
                          </ToneBadge>
                        </td>
                        <td className="text-right">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={selectionMutation.isPending}
                            onClick={() => selectionMutation.mutate({
                              client: heyClient,
                              path: { name: projectName, locationName: loc.locationName },
                              body: { selected: !loc.selected },
                            })}
                          >
                            {loc.selected ? 'Untrack' : 'Track'}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </Card>
    </section>
  )
}

function ScopeChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
        active
          ? 'border-mono-500 bg-mono-800 text-heading'
          : 'border-mono-700/60 text-secondary hover:border-mono-600 hover:text-strong'
      }`}
    >
      {label}
    </button>
  )
}

type GbpLocation = GbpLocationDto
type GbpLodgingSnapshot = GbpLodgingListResponse['lodging'][number]
type GbpPlaceAction = GbpPlaceActionListResponse['placeActions'][number]
type GbpPlaceDetails = GbpPlaceDetailsListResponse['places'][number]
type ProfileCompletenessSummary = GbpSummaryDto['profileCompleteness']

function GbpProfileCompleteness({ summary }: { summary: ProfileCompletenessSummary }) {
  if (summary.locationCount === 0) return null
  const total = summary.locationCount
  const rows = [
    {
      label: 'Description',
      value: `${summary.withDescription}/${total}`,
      tone: completionTone(summary.withDescription, total, 'caution'),
    },
    {
      label: 'Hours',
      value: `${summary.withHours}/${total}`,
      tone: completionTone(summary.withHours, total, 'caution'),
    },
    {
      label: 'Phone',
      value: `${summary.withPrimaryPhone}/${total}`,
      tone: completionTone(summary.withPrimaryPhone, total, 'caution'),
    },
    {
      label: 'Service area',
      value: `${summary.withServiceArea}/${total}`,
      tone: completionTone(summary.withServiceArea, total, 'neutral'),
    },
    {
      label: 'Secondary categories',
      value: `${summary.withSecondaryCategories}/${total}`,
      detail: `${summary.secondaryCategoryTotal} total`,
      tone: completionTone(summary.withSecondaryCategories, total, 'caution'),
    },
    {
      label: 'Closed',
      value: String(summary.permanentlyClosed + summary.temporarilyClosed),
      detail: summary.permanentlyClosed || summary.temporarilyClosed
        ? `${summary.permanentlyClosed} permanent, ${summary.temporarilyClosed} temporary`
        : 'reported open',
      tone: summary.permanentlyClosed > 0 ? 'negative' : summary.temporarilyClosed > 0 ? 'caution' : 'positive',
    },
  ] satisfies Array<{ label: string; value: string; detail?: string; tone: 'positive' | 'caution' | 'negative' | 'neutral' }>

  return (
    <div className="mb-6 border-y border-default py-3">
      <div className="mb-3 flex items-center gap-2">
        <p className="eyebrow eyebrow-soft">Owner profile · Business Information</p>
        <InfoTooltip text="Counts selected locations where Google Business Information returned the owner-authored field. A missing value means it was not returned by this API response, not that every Google surface is empty." />
      </div>
      <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3">
            <span className="text-xs text-muted">{row.label}</span>
            <span className={`font-mono text-sm tabular-nums ${toneTextClass(row.tone)}`}>{row.value}</span>
            {row.detail && <span className="col-span-2 text-[11px] text-faint">{row.detail}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

function GbpLocationEvidenceTable({
  locations,
  lodging,
  places,
  placeActions,
  expandedLocation,
  onToggleExpanded,
}: {
  locations: GbpLocation[]
  lodging: GbpLodgingSnapshot[]
  places: GbpPlaceDetails[]
  placeActions: GbpPlaceAction[]
  expandedLocation: string | null
  onToggleExpanded: (locationName: string) => void
}) {
  const lodgingByLocation = new Map(lodging.map((l) => [l.locationName, l]))
  const placeByLocation = new Map(places.map((p) => [p.locationName, p]))
  const actionsByLocation = new Map<string, GbpPlaceAction[]>()
  for (const action of placeActions) {
    const existing = actionsByLocation.get(action.locationName) ?? []
    existing.push(action)
    actionsByLocation.set(action.locationName, existing)
  }

  return (
    <div className="mb-6">
      <div className="section-head section-head-inline mb-2">
        <div className="flex items-center gap-2">
          <p className="eyebrow eyebrow-soft">Source evidence</p>
          <InfoTooltip text="Each column names the Google surface it came from. Missing or empty means that surface did not return a value in the latest Canonry sync, not that every Google product lacks the information." />
        </div>
        <span className="text-[11px] text-faint">{locations.length} location{locations.length === 1 ? '' : 's'}</span>
      </div>
      <div className="data-table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th className="min-w-[14rem]">Location</th>
              <th className="min-w-[15rem]">Owner profile</th>
              <th className="min-w-[11rem]">Hotel data</th>
              <th className="min-w-[11rem]">Public Maps</th>
              <th className="min-w-[10rem]">CTAs</th>
              <th className="text-right">Detail</th>
            </tr>
          </thead>
          <tbody>
            {locations.map((loc) => {
              const locationLodging = lodgingByLocation.get(loc.locationName) ?? null
              const locationPlace = placeByLocation.get(loc.locationName) ?? null
              const locationActions = actionsByLocation.get(loc.locationName) ?? []
              const expanded = expandedLocation === loc.locationName
              return (
                <Fragment key={loc.id}>
                  <tr>
                    <td>
                      <div className="min-w-0">
                        <p className="font-medium text-strong">{loc.displayName}</p>
                        <p className="mt-1 text-xs text-faint">{loc.primaryCategoryDisplayName ?? 'Primary category not returned'}</p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <ToneBadge tone={loc.selected ? 'positive' : 'neutral'}>
                            {loc.selected ? 'Tracked' : 'Not tracked'}
                          </ToneBadge>
                          {loc.openStatus && loc.openStatus !== 'OPEN' && (
                            <ToneBadge tone={loc.openStatus === 'CLOSED_PERMANENTLY' ? 'negative' : 'caution'}>
                              {formatOpenStatus(loc.openStatus)}
                            </ToneBadge>
                          )}
                        </div>
                      </div>
                    </td>
                    <td><OwnerProfileCell location={loc} /></td>
                    <td><LodgingCell lodging={locationLodging} /></td>
                    <td><PlacesCell place={locationPlace} mapsUri={loc.mapsUri} /></td>
                    <td><PlaceActionsCell actions={locationActions} /></td>
                    <td className="text-right">
                      <Button type="button" variant="outline" size="sm" onClick={() => onToggleExpanded(loc.locationName)}>
                        {expanded ? 'Hide' : 'Details'}
                      </Button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="bg-mono-950/35 hover:bg-mono-950/35">
                      <td colSpan={6} className="px-4 py-4">
                        <LocationEvidenceDetail
                          location={loc}
                          lodging={locationLodging}
                          place={locationPlace}
                          placeActions={locationActions}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export type GbpSourceTone = 'positive' | 'caution' | 'negative' | 'neutral'

export interface GbpSourceState {
  tone: GbpSourceTone
  label: string
  detail: string
}

export function gbpOwnerProfileFacts(location: GbpLocation): Array<{ label: string; tone: GbpSourceTone; value: string }> {
  return [
    { label: 'Description', tone: hasText(location.description) ? 'positive' : 'neutral', value: hasText(location.description) ? 'set' : 'not returned' },
    { label: 'Hours', tone: location.regularHours ? 'positive' : 'neutral', value: location.regularHours ? 'set' : 'not returned' },
    { label: 'Phone', tone: hasText(location.primaryPhone) ? 'positive' : 'neutral', value: hasText(location.primaryPhone) ? 'set' : 'not returned' },
    { label: 'Website', tone: hasText(location.websiteUri) ? 'positive' : 'neutral', value: hasText(location.websiteUri) ? 'set' : 'not returned' },
    { label: 'Secondary', tone: location.additionalCategories.length > 0 ? 'positive' : 'neutral', value: location.additionalCategories.length > 0 ? String(location.additionalCategories.length) : 'not returned' },
    { label: 'Service area', tone: location.serviceArea ? 'positive' : 'neutral', value: location.serviceArea ? 'set' : 'not returned' },
  ]
}

function OwnerProfileCell({ location }: { location: GbpLocation }) {
  const facts = gbpOwnerProfileFacts(location)
  return (
    <div className="flex flex-wrap gap-1.5">
      {facts.map((fact) => (
        <ToneBadge key={fact.label} tone={fact.tone}>{fact.label} {fact.value}</ToneBadge>
      ))}
    </div>
  )
}

function LodgingCell({ lodging }: { lodging: GbpLodgingSnapshot | null }) {
  return <SourceCell {...gbpLodgingSourceState(lodging)} />
}

export function gbpLodgingSourceState(lodging: GbpLodgingSnapshot | null): GbpSourceState {
  if (!lodging) {
    return { tone: 'neutral', label: 'No Lodging API snapshot', detail: 'Not returned for this scoped location.' }
  }
  if (lodging.populatedGroupCount === 0) {
    return {
      tone: 'neutral',
      label: '0 groups returned',
      detail: 'Lodging API returned no readable groups; verify Hotel details.',
    }
  }
  return {
    tone: 'positive',
    label: `${lodging.populatedGroupCount} group${lodging.populatedGroupCount === 1 ? '' : 's'} returned`,
    detail: 'Owner lodging attributes.',
  }
}

function PlacesCell({ place, mapsUri }: { place: GbpPlaceDetails | null; mapsUri: string | null }) {
  return <SourceCell {...gbpPlacesSourceState(place, mapsUri)} />
}

export function gbpPlacesSourceState(place: GbpPlaceDetails | null, mapsUri: string | null): GbpSourceState {
  if (!place) {
    return {
      tone: 'neutral',
      label: 'Public listing not checked',
      detail: mapsUri ? 'Maps link available.' : 'No Places snapshot.',
    }
  }
  const amenityCount = place.amenities.length
  return {
    tone: amenityCount > 0 ? 'positive' : 'neutral',
    label: amenityCount > 0
      ? `${amenityCount} signal${amenityCount === 1 ? '' : 's'} detected`
      : '0 supported signals detected',
    detail: `Places tier: ${place.tier}`,
  }
}

function PlaceActionsCell({ actions }: { actions: GbpPlaceAction[] }) {
  return <SourceCell {...gbpPlaceActionsSourceState(actions)} />
}

export function gbpPlaceActionsSourceState(actions: GbpPlaceAction[]): GbpSourceState {
  if (actions.length === 0) {
    return { tone: 'neutral', label: 'No CTAs stored', detail: 'No placeActionLinks returned.' }
  }
  const merchantCount = actions.filter((a) => a.providerType === 'MERCHANT').length
  if (merchantCount === 0) {
    return {
      tone: 'neutral',
      label: `${actions.length} aggregator CTA${actions.length === 1 ? '' : 's'}`,
      detail: 'No merchant-owned CTA returned.',
    }
  }
  return {
    tone: 'positive',
    label: `${merchantCount} merchant CTA${merchantCount === 1 ? '' : 's'}`,
    detail: `${actions.length} total returned.`,
  }
}

function SourceCell({
  tone,
  label,
  detail,
}: {
  tone: GbpSourceTone
  label: string
  detail: string
}) {
  return (
    <div>
      <ToneBadge tone={tone}>{label}</ToneBadge>
      <p className="mt-1.5 text-xs leading-5 text-faint">{detail}</p>
    </div>
  )
}

function LocationEvidenceDetail({
  location,
  lodging,
  place,
  placeActions,
}: {
  location: GbpLocation
  lodging: GbpLodgingSnapshot | null
  place: GbpPlaceDetails | null
  placeActions: GbpPlaceAction[]
}) {
  const lodgingGroups = lodging ? populatedLodgingGroups(lodging.attributes) : []
  return (
    <div className="grid gap-5 text-xs lg:grid-cols-3">
      <EvidenceDetailGroup title="Owner profile · Business Information">
        <EvidenceRow label="Primary category" value={location.primaryCategoryDisplayName ?? 'Not returned'} />
        <EvidenceRow label="Secondary categories" value={location.additionalCategories.length > 0 ? location.additionalCategories.join(', ') : 'Not returned'} />
        <EvidenceRow label="Description" value={hasText(location.description) ? location.description : 'Not returned'} />
        <EvidenceRow label="Hours" value={location.regularHours ? 'Returned by Google' : 'Not returned'} />
        <EvidenceRow label="Service area" value={location.serviceArea ? 'Returned by Google' : 'Not returned'} />
        <EvidenceRow label="Phone" value={location.primaryPhone ?? 'Not returned'} />
        <EvidenceRow label="Website" value={location.websiteUri ?? 'Not returned'} />
        <EvidenceRow label="Open status" value={formatOpenStatus(location.openStatus)} />
        <EvidenceRow label="Opening date" value={location.openingDate ?? 'Not returned'} />
      </EvidenceDetailGroup>

      <EvidenceDetailGroup title="Hotel data · Lodging API">
        {lodging ? (
          <>
            <EvidenceRow label="Last checked" value={formatDateTime(lodging.syncedAt)} />
            <EvidenceRow label="Groups returned" value={String(lodging.populatedGroupCount)} />
            <EvidenceRow label="Populated groups" value={lodgingGroups.length > 0 ? lodgingGroups.join(', ') : 'None returned'} />
          </>
        ) : (
          <p className="leading-5 text-muted">No Lodging API snapshot was stored for this location.</p>
        )}
      </EvidenceDetailGroup>

      <EvidenceDetailGroup title="Public listing + CTAs">
        {place ? (
          <>
            <EvidenceRow label="Places tier" value={place.tier} />
            <EvidenceRow label="Last checked" value={formatDateTime(place.syncedAt)} />
            <EvidenceRow label="Public signals" value={place.amenities.length > 0 ? place.amenities.join(', ') : 'No supported signals detected'} />
          </>
        ) : (
          <p className="leading-5 text-muted">No Places Details snapshot was stored for this location.</p>
        )}
        {location.mapsUri && (
          <a href={location.mapsUri} target="_blank" rel="noopener noreferrer" className="inline-block text-muted hover:text-neutral">
            View on Google Maps →
          </a>
        )}
        <div className="mt-3 border-t border-default pt-3">
          {placeActions.length === 0 ? (
            <p className="leading-5 text-muted">No placeActionLinks returned.</p>
          ) : (
            <div className="grid gap-2">
              {placeActions.map((action) => (
                <div key={action.placeActionLinkName} className="grid gap-0.5">
                  <span className="font-medium text-neutral">
                    {formatToken(action.placeActionType)}
                    {action.isPreferred ? ' · preferred' : ''}
                  </span>
                  <span className="text-faint">
                    {formatToken(action.providerType)}{action.uri ? ` · ${displayDomain(action.uri)}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </EvidenceDetailGroup>
    </div>
  )
}

function EvidenceDetailGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{title}</p>
      <div className="grid gap-2">{children}</div>
    </div>
  )
}

function EvidenceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[7.25rem_minmax(0,1fr)] gap-3">
      <span className="text-faint">{label}</span>
      <span className="min-w-0 break-words text-secondary">{value}</span>
    </div>
  )
}

export function completionTone(count: number, total: number, emptyTone: 'caution' | 'neutral'): GbpSourceTone {
  if (count === total) return 'positive'
  if (count === 0) return emptyTone
  return 'caution'
}

function toneTextClass(tone: GbpSourceTone) {
  switch (tone) {
    case 'positive': return 'text-positive'
    case 'caution': return 'text-caution'
    case 'negative': return 'text-negative'
    case 'neutral': return 'text-neutral'
  }
}

function insightCardToneClass(severity: string): string {
  if (severity === 'critical' || severity === 'high') return 'insight-card-negative'
  if (severity === 'medium') return 'insight-card-caution'
  return ''
}

function hasText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function formatOpenStatus(status: string | null | undefined): string {
  if (!status) return 'Not returned'
  return formatToken(status)
}

function formatToken(value: string | null | undefined): string {
  if (!value) return 'Unknown'
  return value
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function displayDomain(uri: string): string {
  try {
    return new URL(uri).hostname.replace(/^www\./, '')
  } catch {
    return uri
  }
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function populatedLodgingGroups(attributes: Record<string, unknown>): string[] {
  return Object.entries(attributes)
    .filter(([key, value]) => key !== 'name' && key !== 'metadata' && isPopulated(value))
    .map(([key]) => formatToken(key.replace(/([a-z])([A-Z])/g, '$1_$2')))
}

function isPopulated(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value as object).length > 0
  return true
}

// ----- Performance: graph-first profile-action trend + reach (#658) -----

interface GbpTimeseriesDay {
  date: string
  pending: boolean
  metrics: Record<string, number>
}

/**
 * Replaces the old wall of equal-weight metric tiles. Leads with daily profile
 * actions (directions, website clicks, calls), keeps reach as supporting
 * context, marks the reporting-lag tail as pending instead of a false decline,
 * and collapses all-zero series to a one-line footnote.
 */
function GbpPerformance({
  performance,
  freshness,
  timeseries,
}: {
  performance: { totals: Record<string, number> }
  freshness: { dataThroughDate: string | null; pendingDays: number }
  timeseries: GbpTimeseriesDay[]
}) {
  const totals = performance.totals
  const profileActionMetrics = GBP_CONVERSION_METRICS.filter((m) => (totals[m] ?? 0) > 0)
  const reachMetrics = GBP_REACH_METRICS.filter((m) => (totals[m] ?? 0) > 0)
  // Active "other" outcomes (bookings, conversations, food) — shown as exact
  // figures next to the profile-action totals only when they actually have volume.
  const otherActive = Object.keys(totals)
    .filter((m) => (totals[m] ?? 0) > 0 && classifyGbpMetric(m) === 'other')
    .sort((a, b) => (totals[b] ?? 0) - (totals[a] ?? 0))
  // All-zero series collapse to a footnote rather than occupying prime tiles.
  const notActive = Object.keys(totals).filter((m) => (totals[m] ?? 0) === 0).sort()

  // Recharts wants flat rows: { date, <metric>: value, … }.
  const chartData = timeseries.map((d) => {
    const row: Record<string, string | number> = { date: d.date }
    for (const [metric, value] of Object.entries(d.metrics)) row[metric] = value
    return row
  })
  const firstPending = timeseries.find((d) => d.pending)?.date
  const lastDate = timeseries.length > 0 ? timeseries[timeseries.length - 1]!.date : undefined
  const hasSeries = chartData.length > 0

  const freshnessLabel = freshness.dataThroughDate
    ? `Data through ${formatChartDateLabel(freshness.dataThroughDate)}${freshness.pendingDays > 0 ? ` · ${freshness.pendingDays}d pending` : ''}`
    : null

  const profileActionStats = [...profileActionMetrics, ...otherActive]

  return (
    <div className="mb-6 grid gap-6">
      <div>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="eyebrow eyebrow-soft">Profile actions · daily</p>
          {freshnessLabel && <span className="text-[11px] text-muted">{freshnessLabel}</span>}
        </div>
        {!hasSeries || profileActionMetrics.length === 0 ? (
          <p className="text-sm text-muted">No profile action activity yet — run a sync.</p>
        ) : (
          <>
            <GbpTrendChart data={chartData} metrics={profileActionMetrics} kind="line" firstPending={firstPending} lastDate={lastDate} />
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
              {profileActionStats.map((m) => (
                <span key={m} className="text-sm text-secondary">
                  {formatGbpMetricLabel(m)}{' '}
                  <span className="font-mono text-heading">{(totals[m] ?? 0).toLocaleString()}</span>
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      {hasSeries && reachMetrics.length > 0 && (
        <div>
          <p className="eyebrow eyebrow-soft mb-2">Reach · impressions, daily</p>
          <GbpTrendChart data={chartData} metrics={reachMetrics} kind="area" firstPending={firstPending} lastDate={lastDate} />
        </div>
      )}

      {notActive.length > 0 && (
        <p className="text-xs text-faint">
          Not active: {notActive.map((m) => formatGbpMetricLabel(m)).join(', ')}
        </p>
      )}
    </div>
  )
}

function GbpTrendChart({
  data,
  metrics,
  kind,
  firstPending,
  lastDate,
}: {
  data: Array<Record<string, string | number>>
  metrics: readonly string[]
  kind: 'line' | 'area'
  firstPending?: string
  lastDate?: string
}) {
  return (
    <div className="h-48 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={CHART_GRID_STROKE} vertical={false} />
          <XAxis
            dataKey="date"
            tick={CHART_AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: CHART_AXIS_STROKE }}
            tickFormatter={formatChartDateTick}
            minTickGap={24}
          />
          <YAxis tick={CHART_AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} width={36} />
          <RechartsTooltip
            {...CHART_TOOLTIP_STYLE}
            labelFormatter={formatChartDateLabel}
            formatter={(value, name) => {
              const formatted = typeof value === 'number' ? value.toLocaleString() : String(value ?? 0)
              return [formatted, formatGbpMetricLabel(String(name ?? ''))]
            }}
          />
          <Legend wrapperStyle={{ fontSize: 11, color: CHART_NEUTRAL.text }} formatter={(value: string) => formatGbpMetricLabel(value)} />
          {/* The reporting-lag tail: a greyed band so a not-yet-reported day is
              never read as a real dip. */}
          {firstPending && lastDate && (
            <ReferenceArea
              x1={firstPending}
              x2={lastDate}
              fill={CHART_NEUTRAL.surface}
              fillOpacity={0.55}
              stroke="none"
              label={{ value: 'pending', position: 'insideTopRight', fill: CHART_NEUTRAL.textDim, fontSize: 10 }}
            />
          )}
          {metrics.map((m, i) => (
            kind === 'line' ? (
              <Line
                key={m}
                type="monotone"
                dataKey={m}
                stroke={CHART_SERIES_COLORS[i % CHART_SERIES_COLORS.length]}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            ) : (
              <Area
                key={m}
                type="monotone"
                dataKey={m}
                stackId="reach"
                stroke={CHART_SERIES_COLORS[i % CHART_SERIES_COLORS.length]}
                fill={CHART_SERIES_COLORS[i % CHART_SERIES_COLORS.length]}
                fillOpacity={0.25}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
            )
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
