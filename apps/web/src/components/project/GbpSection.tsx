import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getApiV1ProjectsByNameGoogleConnectionsOptions,
  getApiV1ProjectsByNameGbpSummaryOptions,
  getApiV1ProjectsByNameGbpLocationsOptions,
  getApiV1ProjectsByNameGbpKeywordsOptions,
  postApiV1ProjectsByNameGbpSyncMutation,
  putApiV1ProjectsByNameGbpLocationsByLocationNameSelectionMutation,
} from '@ainyc/canonry-api-client/react-query'

import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { heyClient } from '../../api.js'
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

  const connectionsQuery = useQuery(
    getApiV1ProjectsByNameGoogleConnectionsOptions({ client: heyClient, path: { name: projectName } }),
  )
  const gbpConnection = connectionsQuery.data?.find((c) => c.connectionType === 'gbp')
  const connected = Boolean(gbpConnection)

  const summaryQuery = useQuery({
    ...getApiV1ProjectsByNameGbpSummaryOptions({ client: heyClient, path: { name: projectName } }),
    enabled: connected,
  })
  const locationsQuery = useQuery({
    ...getApiV1ProjectsByNameGbpLocationsOptions({ client: heyClient, path: { name: projectName } }),
    enabled: connected,
  })
  const keywordsQuery = useQuery({
    ...getApiV1ProjectsByNameGbpKeywordsOptions({ client: heyClient, path: { name: projectName } }),
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

  // Self-gating: the section only appears for projects with a GBP connection.
  // Narrowing on `gbpConnection` (not the derived `connected`) lets TS treat it
  // as defined below.
  if (connectionsQuery.isLoading || !gbpConnection) return null

  const summary = summaryQuery.data
  const locations = locationsQuery.data?.locations ?? []
  const keywords = keywordsQuery.data?.keywords ?? []
  const account = locations.length > 0 ? locations[0].accountName : gbpConnection.domain

  return (
    <section className="page-section-divider">
      <Card className="surface-card">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Local presence</p>
            <h2>Google Business Profile</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-zinc-500">
              How AI answer engines and Maps surface this business — performance, search terms, booking CTAs, and profile completeness.
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
          {locationsQuery.data ? `${locationsQuery.data.totalSelected} of ${locationsQuery.data.totalDiscovered} locations selected` : 'Loading locations…'}
        </p>

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

        {/* Search keywords table. */}
        <div className="mb-6">
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

        {/* Locations table with selection toggle. */}
        <div>
          <p className="eyebrow eyebrow-soft mb-2">Locations</p>
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
      </Card>
    </section>
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
