import { useEffect, useState } from 'react'
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

import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { fetchInsights, heyClient } from '../../api.js'
import { addToast } from '../../lib/toast-store.js'

// Headline conversion metrics first, then the impression breakdowns. Any metric
// the API returns that isn't listed here still renders (appended, raw name).
const METRIC_ORDER = [
  'BUSINESS_DIRECTION_REQUESTS',
  'WEBSITE_CLICKS',
  'CALL_CLICKS',
  'BUSINESS_BOOKINGS',
  'BUSINESS_CONVERSATIONS',
  'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
  'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
  'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
  'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
]

const METRIC_LABELS: Record<string, string> = {
  BUSINESS_DIRECTION_REQUESTS: 'Direction requests',
  WEBSITE_CLICKS: 'Website clicks',
  CALL_CLICKS: 'Call clicks',
  BUSINESS_BOOKINGS: 'Bookings',
  BUSINESS_CONVERSATIONS: 'Conversations',
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: 'Search impressions (desktop)',
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH: 'Search impressions (mobile)',
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: 'Maps impressions (desktop)',
  BUSINESS_IMPRESSIONS_MOBILE_MAPS: 'Maps impressions (mobile)',
}

function metricLabel(metric: string): string {
  return METRIC_LABELS[metric] ?? metric
}

function orderedMetrics(totals: Record<string, number>): string[] {
  const present = Object.keys(totals)
  const ordered = METRIC_ORDER.filter((m) => m in totals)
  const extra = present.filter((m) => !METRIC_ORDER.includes(m)).sort()
  return [...ordered, ...extra]
}

/** Render a 7-day delta as a tone-coloured chip. `null` (no prior window) → em dash. */
function DeltaChip({ delta }: { delta: number | null | undefined }) {
  if (delta === null || delta === undefined) {
    return <span className="text-zinc-600" title="No prior 7-day window to compare">—</span>
  }
  const tone = delta > 0 ? 'text-emerald-400' : delta < 0 ? 'text-rose-400' : 'text-zinc-400'
  const sign = delta > 0 ? '+' : ''
  return <span className={`font-mono text-xs ${tone}`}>{sign}{delta}%</span>
}

export function GbpSection({ projectName }: { projectName: string }) {
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

  // Errors surface through the global error toast (no skipGlobalErrorToast meta).
  const syncMutation = useMutation({
    ...postApiV1ProjectsByNameGbpSyncMutation(),
    onSuccess: () => {
      addToast('Google Business Profile sync started.', 'positive')
      invalidateGbp()
    },
  })

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
            performance, search terms, booking CTAs, and how your public Maps listing compares to the profile you control.
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
            <h2>Google Business Profile</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-zinc-500">
              How AI answer engines and Maps surface this business — performance, search terms, booking CTAs, and how your public listing compares to the profile you control.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ToneBadge tone="positive">Connected</ToneBadge>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={syncMutation.isPending}
              onClick={() => syncMutation.mutate({ client: heyClient, path: { name: projectName }, body: {} })}
            >
              {syncMutation.isPending ? 'Syncing…' : 'Sync'}
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
                    <p className="text-sm font-medium text-zinc-200">{ins.title}</p>
                    {ins.recommendation?.reason && (
                      <p className="text-sm leading-6 text-zinc-400">{ins.recommendation.reason}</p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Performance scorecard — totals + 7-day deltas (all computed server-side). */}
            {summary && (
              <div className="mb-6">
                <p className="eyebrow eyebrow-soft mb-2">Performance · last 7 days vs prior 7</p>
                {orderedMetrics(summary.performance.totals).length === 0 ? (
                  <p className="text-sm text-zinc-500">No performance data yet — run a sync.</p>
                ) : (
                  <div className="metric-grid grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {orderedMetrics(summary.performance.totals).map((metric) => (
                      <div key={metric} className="metric-card rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-3 py-2">
                        <div className="text-[11px] uppercase tracking-wide text-zinc-500">{metricLabel(metric)}</div>
                        <div className="mt-1 flex items-baseline justify-between">
                          <span className="font-mono text-lg text-zinc-50">{(summary.performance.totals[metric] ?? 0).toLocaleString()}</span>
                          <DeltaChip delta={summary.performance.deltaPct[metric]} />
                        </div>
                        <div className="mt-0.5 text-[11px] text-zinc-600">
                          {(summary.performance.recent7d[metric] ?? 0).toLocaleString()} recent · {(summary.performance.prior7d[metric] ?? 0).toLocaleString()} prior
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* CTA presence + lodging completeness tiles. */}
            {summary && (
              <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <SignalTile label="Reservation CTA" present={summary.placeActions.hasReservationCta} />
                <SignalTile label="Booking CTA" present={summary.placeActions.hasBookingCta} />
                <SignalTile
                  label="Direct booking link"
                  present={summary.placeActions.hasDirectMerchantCta}
                  absentTone="caution"
                  absentHint="Only aggregator/OTA links — AI may surface third-party booking"
                />
                <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-3 py-2">
                  <div className="text-[11px] uppercase tracking-wide text-zinc-500">Lodging profile</div>
                  {summary.lodging.lodgingLocationCount === 0 ? (
                    <div className="mt-1 text-sm text-zinc-500">Not a lodging property</div>
                  ) : (
                    <div className="mt-1 flex items-baseline justify-between">
                      <span className="font-mono text-lg text-zinc-50">
                        {summary.lodging.populatedLodgingCount}/{summary.lodging.lodgingLocationCount}
                      </span>
                      {summary.lodging.emptyLodgingCount > 0 ? (
                        <ToneBadge tone="caution">{summary.lodging.emptyLodgingCount} empty</ToneBadge>
                      ) : (
                        <ToneBadge tone="positive">complete</ToneBadge>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

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

function SignalTile({
  label,
  present,
  absentTone = 'neutral',
  absentHint,
}: {
  label: string
  present: boolean
  absentTone?: 'neutral' | 'caution'
  absentHint?: string
}) {
  return (
    <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1" title={!present ? absentHint : undefined}>
        {present
          ? <ToneBadge tone="positive">Present</ToneBadge>
          : <ToneBadge tone={absentTone}>Absent</ToneBadge>}
      </div>
    </div>
  )
}
