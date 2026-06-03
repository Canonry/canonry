import { useEffect, useState, useSyncExternalStore } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getApiV1ProjectsByNameGoogleConnectionsOptions,
  getApiV1ProjectsByNameGbpSummaryOptions,
  getApiV1ProjectsByNameGbpLocationsOptions,
  getApiV1ProjectsByNameGbpKeywordsOptions,
  getApiV1ProjectsByNameGbpPlacesOptions,
  postApiV1ProjectsByNameGbpSyncMutation,
  putApiV1ProjectsByNameGbpLocationsByLocationNameSelectionMutation,
} from '@ainyc/canonry-api-client/react-query'

import {
  formatGbpMetricLabel,
  classifyGbpMetric,
  GBP_CONVERSION_METRICS,
  GBP_REACH_METRICS,
  RunKinds,
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

export function GbpSection({ projectName, projectId }: { projectName: string; projectId: string }) {
  const queryClient = useQueryClient()
  // `null` = all tracked locations (aggregate). A locationName scopes every read
  // to one location. A single tracked location reads 1:1 with no selector.
  const [scopeLocation, setScopeLocation] = useState<string | null>(null)
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

  if (connectionsQuery.isLoading) return null

  // The dedicated "Local Presence" tab can be reached by direct navigation even
  // without a connection — render an explicit empty state, not a blank page.
  if (!gbpConnection) {
    return (
      <section className="page-section-divider">
        <Card className="surface-card compact-card">
          <p className="eyebrow eyebrow-soft">Local presence</p>
          <h2>Google Business Profile</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">
            No Google Business Profile is connected for this project. Connect one with{' '}
            <span className="font-mono text-zinc-400">canonry gbp connect {projectName}</span> to track local
            performance, search terms, and how your public Maps listing compares to the profile you control.
          </p>
        </Card>
      </section>
    )
  }

  const summary = summaryQuery.data
  const locations = locationsQuery.data?.locations ?? []
  const trackedLocations = locations.filter((l) => l.selected)
  const keywords = keywordsQuery.data?.keywords ?? []
  const places = placesQuery.data?.places ?? []
  const account = locations.length > 0 ? locations[0].accountName : gbpConnection.domain

  const scopeDisplayName = scopeLocation
    ? locations.find((l) => l.locationName === scopeLocation)?.displayName ?? null
    : null

  // The owner-vs-public amenity gap is computed server-side by the GBP analyzer
  // (the `gbp-listing-discrepancy` / `gbp-lodging-gap` insights); we only render
  // it. Filter to the active scope via the location-labelled title/query.
  const gapInsights = (insightsQuery.data ?? []).filter((ins) =>
    !ins.dismissed
    && (ins.type === 'gbp-listing-discrepancy' || ins.type === 'gbp-lodging-gap')
    && (!scopeDisplayName || ins.query === scopeLocation || ins.title.startsWith(scopeDisplayName)),
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

        <p className="mb-4 text-xs text-zinc-500">
          {account ? <>Account <span className="font-mono text-zinc-400">{account}</span> · </> : null}
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
          <p className="text-sm text-zinc-500">
            No locations are tracked yet. Open <span className="font-medium text-zinc-300">Manage locations</span> below to track the one(s) for this business.
          </p>
        ) : (
          <>
            {/* Owner-vs-public gap (server-computed insights) — the headline AEO signal. */}
            {gapInsights.length > 0 && (
              <div className="mb-6 grid gap-2">
                {gapInsights.map((ins) => (
                  <div key={ins.id} className="insight-card insight-card-negative rounded-r-lg border border-zinc-800/60 bg-zinc-900/30 p-3 pl-4">
                    <p className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                      {ins.title}
                      {ins.recommendation?.reason && <InfoTooltip text={ins.recommendation.reason} />}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {/* Performance — graph-first: a daily conversion trend (the hero) and
                a reach area, with the reporting-lag tail marked pending and
                all-zero series collapsed to a footnote (#658). */}
            {summary && (
              <GbpPerformance
                performance={summary.performance}
                freshness={summary.freshness}
                timeseries={summary.timeseries}
              />
            )}

            {/* Owner-configured Place Action CTAs and the raw lodging-completeness
                count are deliberately not rendered here. Both come only from the
                owner-set profile and have no public counterpart to cross-reference,
                so an "Absent" / "empty" tile reads as fact when it is really an
                unverifiable owner signal (#648). The cross-referenced lodging gap
                still surfaces above as the gbp-listing-discrepancy insight, and the
                public Maps listing surfaces below. Operators who want the raw
                owner-configured data read `cnry gbp place-actions` / `gbp lodging`;
                the /gbp/summary API still carries both fields. */}

            {/* Public listing (Places, #648) — amenities Google's public Maps listing
                advertises, derived server-side. The gap vs the owner profile is the
                AEO signal surfaced above as an insight. */}
            {places.length > 0 && (
              <div className="mb-6">
                <p className="eyebrow eyebrow-soft mb-2">Public listing · Google Maps</p>
                <div className="grid gap-2">
                  {places.map((place) => {
                    const loc = locations.find((l) => l.locationName === place.locationName)
                    return (
                      <div key={place.locationName} className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-3 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm text-zinc-300">{loc?.displayName ?? place.locationName}</span>
                          <span className="text-[11px] text-zinc-600">
                            {place.amenities.length} amenit{place.amenities.length === 1 ? 'y' : 'ies'} advertised
                          </span>
                        </div>
                        {place.amenities.length > 0 ? (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {place.amenities.map((a) => (
                              <span key={a} className="rounded-full border border-zinc-700/60 px-2 py-0.5 text-[11px] text-zinc-400">{a}</span>
                            ))}
                          </div>
                        ) : (
                          <p className="mt-1 text-sm text-zinc-500">Public listing advertises no structured amenities.</p>
                        )}
                        {loc?.mapsUri && (
                          <a
                            href={loc.mapsUri}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-2 inline-block text-[11px] text-zinc-500 hover:text-zinc-300"
                          >
                            View on Google Maps →
                          </a>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Search keywords table. */}
            <div className="mb-2">
              <div className="section-head section-head-inline mb-2">
                <p className="eyebrow eyebrow-soft">Search terms</p>
                {keywordsQuery.data && keywordsQuery.data.total > 0 && (
                  <span className="text-[11px] text-zinc-600">
                    {keywordsQuery.data.thresholdedPct}% privacy-thresholded
                  </span>
                )}
              </div>
              {keywords.length === 0 ? (
                <p className="text-sm text-zinc-500">No keyword impressions stored yet.</p>
              ) : (
                <table className="data-table w-full text-sm">
                  <thead>
                    <tr>
                      <th className="text-left">Search term</th>
                      <th className="text-right">Impressions</th>
                      <th className="text-right">Window</th>
                    </tr>
                  </thead>
                  <tbody>
                    {keywords.slice(0, 25).map((kw) => (
                      <tr key={`${kw.locationName}:${kw.keyword}`}>
                        <td className="text-zinc-300">{kw.keyword}</td>
                        <td className="text-right font-mono text-zinc-200">
                          {kw.valueCount !== null
                            ? kw.valueCount.toLocaleString()
                            : <span className="text-zinc-500" title="Privacy floor — Google withheld the exact count">{'<'}{kw.valueThreshold}</span>}
                        </td>
                        <td className="text-right font-mono text-[11px] text-zinc-600">{kw.periodStart}–{kw.periodEnd}</td>
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
        <div className="mt-6 border-t border-zinc-800/60 pt-4">
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200"
            onClick={() => setShowManage((v) => !v)}
            aria-expanded={showManage}
          >
            <span aria-hidden="true">{showManage ? '▾' : '▸'}</span> Manage locations ({locations.length})
          </button>
          {showManage && (
            <div className="mt-3">
              {locations.length === 0 ? (
                <p className="text-sm text-zinc-500">No locations discovered. Run <span className="font-mono">canonry gbp locations discover</span>.</p>
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
                        <td className="text-zinc-200">{loc.displayName}</td>
                        <td className="text-zinc-500">{loc.storefrontAddress ?? '—'}</td>
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
          ? 'border-zinc-500 bg-zinc-800 text-zinc-100'
          : 'border-zinc-700/60 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
      }`}
    >
      {label}
    </button>
  )
}

// ----- Performance: graph-first conversion trend + reach (#658) -----

interface GbpTimeseriesDay {
  date: string
  pending: boolean
  metrics: Record<string, number>
}

/**
 * Replaces the old wall of equal-weight metric tiles. Leads with the daily
 * conversion trend (the outcome that moves revenue), keeps reach as supporting
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
  const conversionMetrics = GBP_CONVERSION_METRICS.filter((m) => (totals[m] ?? 0) > 0)
  const reachMetrics = GBP_REACH_METRICS.filter((m) => (totals[m] ?? 0) > 0)
  // Active "other" outcomes (bookings, conversations, food) — shown as exact
  // figures next to the conversion totals only when they actually have volume.
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

  const conversionStats = [...conversionMetrics, ...otherActive]

  return (
    <div className="mb-6 grid gap-6">
      <div>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="eyebrow eyebrow-soft">Conversions · daily</p>
          {freshnessLabel && <span className="text-[11px] text-zinc-500">{freshnessLabel}</span>}
        </div>
        {!hasSeries || conversionMetrics.length === 0 ? (
          <p className="text-sm text-zinc-500">No conversion activity yet — run a sync.</p>
        ) : (
          <>
            <GbpTrendChart data={chartData} metrics={conversionMetrics} kind="line" firstPending={firstPending} lastDate={lastDate} />
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
              {conversionStats.map((m) => (
                <span key={m} className="text-sm text-zinc-400">
                  {formatGbpMetricLabel(m)}{' '}
                  <span className="font-mono text-zinc-100">{(totals[m] ?? 0).toLocaleString()}</span>
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
        <p className="text-xs text-zinc-600">
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
