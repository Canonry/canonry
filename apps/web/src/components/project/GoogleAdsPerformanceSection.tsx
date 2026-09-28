import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  formatMicros,
  formatPercent,
  type GoogleAdsCampaignStatus,
  type GoogleAdsMetricsWindow,
  type GoogleAdsPerformanceDto,
} from '@ainyc/canonry-contracts'
import { getApiV1ProjectsByNameGoogleAdsPerformanceOptions } from '@ainyc/canonry-api-client/react-query'

import { heyClient } from '../../api.js'
import { MetricsWindowPicker } from '../shared/MetricsWindowPicker.js'
import { extractErrorMessage } from '../../lib/extract-error-message.js'
import type { MetricTone } from '../../view-models.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import {
  CHART_SERIES_COLORS,
  MultiAxisTrendChart,
  formatChartDateLabel,
  formatChartDateTick,
  formatObservedInstantLabel,
  observedInstant,
  type TrendChartSeries,
} from '../shared/ChartPrimitives.js'
import { Button } from '../ui/button.js'

const GOOGLE_ADS_PERFORMANCE_STALE_MS = 60_000
const GOOGLE_ADS_WINDOWS: GoogleAdsMetricsWindow[] = ['7d', '14d', '30d']

/**
 * A ratio whose denominator was zero is UNDEFINED, not zero. The API sends
 * `null` for exactly that case, so every rate cell renders this word instead of
 * a number a reader would otherwise average, sort, or quote.
 */
export const GOOGLE_ADS_NOT_AVAILABLE = 'not available'

export const GOOGLE_ADS_PERFORMANCE_HELP = 'Figures come from the stored Google Ads snapshot; this view never calls Google. The window ends on the newest CLOSED day, because the capture day is only partly recorded and would read as a drop. A calendar day the provider returned no row for is zero delivery, so it is charted as zero. Rates with a zero denominator read "not available", never 0%.'

export const GOOGLE_ADS_PERFORMANCE_EMPTY_TITLE = 'No Google Ads snapshot stored yet'

export const GOOGLE_ADS_PERFORMANCE_EMPTY_BODY = 'Connect a Google Ads account in Conversion Integrity below, choose the customer, then run a Google Ads sync. Spend, clicks, impressions, and conversions appear here once the first snapshot is stored.'

export const GOOGLE_ADS_PERFORMANCE_AWAITING_TITLE = 'No closed days yet'
/**
 * Deliberately does NOT say "syncing". This state is reached when the stored
 * snapshot covers no closed day; nothing here knows whether a sync is running,
 * so claiming one would mask a stalled workflow as "wait".
 */
export const GOOGLE_ADS_PERFORMANCE_AWAITING_BODY = 'The stored snapshot covers no completed day yet. Figures appear after a full day closes in the account time zone; the day a snapshot is captured is partial and is left out on purpose. If this persists, check the latest Google Ads sync in Activity.'

/**
 * Only 'insufficient-history' can reach the comparison line. The route emits
 * 'no-snapshot' exclusively alongside `source: null`, which returns earlier, so a
 * 'no-snapshot' entry here would be dead copy that implies a state this branch
 * never renders.
 */
export const GOOGLE_ADS_COMPARISON_UNAVAILABLE_COPY: Record<'insufficient-history', string> = {
  'insufficient-history': 'Period change is hidden: the stored snapshot does not cover a prior period of equal length yet.',
}

const COUNT_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
/** Google reports fractional conversions, so 0.5 is a real value, not a rounding artifact. */
const CONVERSION_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })
/** Currency-less amount, used only when the account currency is unresolved. */
const AMOUNT_FORMAT = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * Micros as money, tolerant of null.
 *
 * `cpcMicros` and `costPerConversionMicros` are nullable by contract, and
 * formatMicros is not null-tolerant, so calling it directly would print a real
 * figure for a period that had no clicks or no conversions.
 */
export function formatGoogleAdsMicros(micros: number | null, currency: string | null): string {
  if (micros === null || !Number.isFinite(micros)) return GOOGLE_ADS_NOT_AVAILABLE
  // No resolved account currency: show the magnitude without asserting a unit.
  // Printing "$" on a EUR account is a wrong number, not a missing one.
  if (currency === null) return AMOUNT_FORMAT.format(micros / 1_000_000)
  return formatMicros(micros, currency)
}

/**
 * A raw ratio (0.0731) as a display percentage. Never rounded before this point.
 * An undefined ratio keeps this surface's own word rather than the shared dash.
 */
export function formatGoogleAdsRatio(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return GOOGLE_ADS_NOT_AVAILABLE
  return formatPercent(ratio)
}

/**
 * A period-over-period change from `comparison.change`.
 *
 * Called only when a comparison EXISTS. A missing comparison renders no delta
 * at all: printing "0%" for a period that was never measured invents a flat
 * reading out of absent data.
 */
export function formatGoogleAdsChange(ratio: number | null, days: number): string {
  if (ratio === null || !Number.isFinite(ratio)) return `${GOOGLE_ADS_NOT_AVAILABLE} vs prior ${days}d`
  if (ratio === 0) return `no change vs prior ${days}d`
  return `${ratio > 0 ? '↑' : '↓'} ${formatPercent(Math.abs(ratio))} vs prior ${days}d`
}

function campaignStatusTone(status: GoogleAdsCampaignStatus): MetricTone {
  if (status === 'enabled') return 'positive'
  if (status === 'paused') return 'caution'
  return 'neutral'
}

function campaignStatusLabel(status: GoogleAdsCampaignStatus): string {
  if (status === 'enabled') return 'Enabled'
  if (status === 'paused') return 'Paused'
  if (status === 'removed') return 'Removed'
  return 'Unknown'
}

/**
 * Delta colour is a claim about whether the movement is GOOD, so only metrics
 * with an unambiguous direction get one. More clicks, impressions, and
 * conversions are better. More spend is neither: without a return figure beside
 * it, a green "spend up 40%" would be an assertion the data does not support.
 */
/**
 * Which way is GOOD for this metric.
 *
 * 'none' is not a fallback, it is a claim the data cannot support: spend rising
 * is neither good nor bad without a return figure beside it.
 *
 * 'down-good' exists because a boolean cannot express it. Cost per conversion
 * and cost per click improve as they FALL, so a two-state rule would paint a
 * CPA blowout green.
 */
type ChangeDirection = 'up-good' | 'down-good' | 'none'

/** Metrics with a matching per-day field on `daily`, so they can be plotted. */
type SeriesKey = 'costMicros' | 'conversions' | 'clicks' | 'impressions'

function changeToneClass(ratio: number | null, direction: ChangeDirection): string {
  if (direction === 'none' || ratio === null || !Number.isFinite(ratio) || ratio === 0) return 'text-muted'
  const improving = direction === 'up-good' ? ratio > 0 : ratio < 0
  return improving ? 'text-positive' : 'text-negative'
}

export function GoogleAdsPerformanceSection({ projectName }: { projectName: string }) {
  const [metricsWindow, setMetricsWindow] = useState<GoogleAdsMetricsWindow>('14d')
  // Which tiles are plotted. Spend and conversions are the default pair; the
  // last selected series cannot be turned off, or the chart renders empty axes.
  const [selectedSeries, setSelectedSeries] = useState<ReadonlySet<SeriesKey>>(
    () => new Set(['costMicros', 'conversions'] as const),
  )
  const performanceQuery = useQuery({
    ...getApiV1ProjectsByNameGoogleAdsPerformanceOptions({
      client: heyClient,
      path: { name: projectName },
      query: { window: metricsWindow },
    }),
    staleTime: GOOGLE_ADS_PERFORMANCE_STALE_MS,
  })

  const performance: GoogleAdsPerformanceDto | undefined = performanceQuery.data

  const header = (
    <div className="section-head section-head-inline">
      <div>
        <p className="eyebrow">Google Ads</p>
        <div className="flex items-center gap-1.5">
          <h2 id="google-ads-performance-title" className="text-xl font-semibold tracking-[-0.02em] text-heading">
            Ad performance
          </h2>
          <InfoTooltip text={GOOGLE_ADS_PERFORMANCE_HELP} />
        </div>
        {performance?.source ? (
          <p className="text-xs text-muted">
            {formatChartDateLabel(performance.startDate)} to {formatChartDateLabel(performance.endDate)}
            {' · '}{performance.days} closed {performance.days === 1 ? 'day' : 'days'}
          </p>
        ) : null}
      </div>
      <MetricsWindowPicker
        windows={GOOGLE_ADS_WINDOWS}
        value={metricsWindow}
        onChange={setMetricsWindow}
        label="Google Ads time period"
      />
    </div>
  )

  if (performanceQuery.isLoading) {
    return (
      <section className="page-section" aria-busy="true" aria-labelledby="google-ads-performance-title">
        {header}
        <div aria-hidden="true" className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="page-skeleton-card">
              <div className="skeleton-text w-20" />
              <div className="skeleton-text-sm w-28" />
            </div>
          ))}
        </div>
        <p role="status" className="sr-only">Loading Google Ads performance…</p>
      </section>
    )
  }

  if (performanceQuery.isError || !performance) {
    return (
      <section className="page-section" aria-labelledby="google-ads-performance-title">
        {header}
        <p role="alert" className="mt-4 text-sm text-negative">
          Could not load Google Ads performance: {extractErrorMessage(performanceQuery.error)}
        </p>
        <Button type="button" variant="outline" className="mt-3" onClick={() => void performanceQuery.refetch()}>
          Retry performance
        </Button>
      </section>
    )
  }

  const { totals, daily, campaigns, comparison, comparisonUnavailableReason, source } = performance

  // No stored snapshot at all. Onboarding copy is the one place this surface is
  // allowed to instruct inline, because there is no data to push down.
  if (!source) {
    // `source: null` carries two different situations and they need different copy.
    // 'insufficient-history' means the account IS connected and synced but no day
    // has closed yet; telling that operator to connect an account is wrong.
    const awaitingFirstClosedDay = comparisonUnavailableReason === 'insufficient-history'
    return (
      <section className="page-section" aria-labelledby="google-ads-performance-title">
        {header}
        <div className="mt-4 max-w-2xl rounded-md border border-default bg-surface-subtle p-5">
          <h3 className="text-base font-semibold text-heading">
            {awaitingFirstClosedDay
              ? GOOGLE_ADS_PERFORMANCE_AWAITING_TITLE
              : GOOGLE_ADS_PERFORMANCE_EMPTY_TITLE}
          </h3>
          <p className="mt-2 text-sm leading-6 text-secondary">
            {awaitingFirstClosedDay
              ? GOOGLE_ADS_PERFORMANCE_AWAITING_BODY
              : GOOGLE_ADS_PERFORMANCE_EMPTY_BODY}
          </p>
        </div>
      </section>
    )
  }

  // The DTO permits a null currency (no sync has resolved the account yet).
  // Defaulting to USD would print dollar signs on, say, a EUR account, which is
  // a wrong number rather than a missing one.
  const currency = source.currencyCode
  // The row cap (`truncated`) and the 50-campaign query cap are DIFFERENT limits.
  // An account with more than 50 campaigns is summed from the queried subset while
  // `truncated` stays false, so gating this on `truncated` would print a subtotal
  // as the account total with no caveat at all. Compare the counts directly.
  // `campaignsInInventory` is 0 when no inventory snapshot is stored, which proves
  // nothing about coverage, so that case is not reported as a shortfall.
  const coverageShortfall =
    source.campaignsInInventory > 0 && source.campaignsQueried < source.campaignsInInventory
      ? { queried: source.campaignsQueried, inInventory: source.campaignsInInventory }
      : null
  // Spend with zero conversions is INFINITE cost per conversion (pure waste).
  // Spend with no data is UNDEFINED. Both arrive as null, so they must not read
  // the same: the first is the single worst state on this page.
  const wastedSpend = totals.costMicros > 0 && totals.conversions === 0

  const tiles: {
    key: string
    label: string
    value: string
    change: number | null
    /**
     * False when the DTO carries no change field for this metric at all, which
     * is different from a change that exists and is null. "not available vs
     * prior" reads as missing data; the truth is that nothing was computed.
     */
    comparable: boolean
    direction: ChangeDirection
    /** null = not chartable: no matching per-day field on `daily`. */
    seriesKey: SeriesKey | null
  }[] = [
    { key: 'spend', comparable: true, label: 'Spend', value: formatGoogleAdsMicros(totals.costMicros, currency), change: comparison?.change.costMicros ?? null, direction: 'none', seriesKey: 'costMicros' },
    { key: 'conversions', comparable: true, label: 'Conversions', value: CONVERSION_FORMAT.format(totals.conversions), change: comparison?.change.conversions ?? null, direction: 'up-good', seriesKey: 'conversions' },
    {
      key: 'cost-per-conversion',
      label: 'Cost / conv.',
      value: wastedSpend ? 'no conversions' : formatGoogleAdsMicros(totals.costPerConversionMicros, currency),
      // The DTO carries no cost-per-conversion change yet, so no delta is shown
      // rather than one derived here: derived metrics belong in the API.
      change: null,
      comparable: false,
      direction: 'down-good',
      seriesKey: null,
    },
    { key: 'conversion-rate', comparable: true, label: 'Conv. rate', value: formatGoogleAdsRatio(totals.conversionRate), change: comparison?.change.conversionRate ?? null, direction: 'up-good', seriesKey: null },
  ]

  // The volume figures the tiles displaced. A flat definition strip, not a
  // second rank of bordered tiles: eight boxes is a wall, and the ask was density.
  const rateStrip: { key: string; label: string; value: string; seriesKey: SeriesKey | null }[] = [
    { key: 'clicks', label: 'Clicks', value: COUNT_FORMAT.format(totals.clicks), seriesKey: 'clicks' },
    { key: 'impressions', label: 'Impressions', value: COUNT_FORMAT.format(totals.impressions), seriesKey: 'impressions' },
    // CTR and CPC have no per-day field on `daily`, so they are values only.
    { key: 'ctr', label: 'CTR', value: formatGoogleAdsRatio(totals.ctr), seriesKey: null },
    { key: 'cpc', label: 'CPC', value: formatGoogleAdsMicros(totals.cpcMicros, currency), seriesKey: null },
  ]

  const SERIES_META: Record<SeriesKey, { label: string; color: string; axisId: string; formatValue: (v: number) => string }> = {
    // Micros stay integers all the way to the axis; the formatter is the single
    // render edge that turns them into money.
    costMicros: { label: 'Spend', color: CHART_SERIES_COLORS[1]!, axisId: 'spend', formatValue: (v) => formatGoogleAdsMicros(v, currency) },
    conversions: { label: 'Conversions', color: CHART_SERIES_COLORS[0]!, axisId: 'conversions', formatValue: (v) => CONVERSION_FORMAT.format(v) },
    // Its own axis: clicks and conversions differ by an order of magnitude
    // (913 vs 37.5 on the reference fixture), so sharing one axis renders
    // conversions as a flat line at roughly 4% of the scale.
    clicks: { label: 'Clicks', color: CHART_SERIES_COLORS[2]!, axisId: 'clicks', formatValue: (v) => COUNT_FORMAT.format(v) },
    impressions: { label: 'Impressions', color: CHART_SERIES_COLORS[3]!, axisId: 'impressions', formatValue: (v) => COUNT_FORMAT.format(v) },
  }

  const chartSeries: TrendChartSeries[] = [...selectedSeries]
    .map((key) => ({ dataKey: key, ...SERIES_META[key] }))

  return (
    <section className="page-section" aria-labelledby="google-ads-performance-title">
      {header}

      {coverageShortfall !== null ? (
        <p role="status" className="mt-3 text-sm text-caution">
          Totals cover {COUNT_FORMAT.format(coverageShortfall.queried)} of{' '}
          {COUNT_FORMAT.format(coverageShortfall.inInventory)} campaigns, so they are a subset of the account.
        </p>
      ) : null}

      {source.truncated ? (
        <p role="status" className="mt-3 text-sm text-caution">
          The provider returned a bounded result, so some rows are missing from the figures below.
        </p>
      ) : null}

      {!comparison && comparisonUnavailableReason === 'insufficient-history' ? (
        <p className="mt-3 text-sm text-secondary">
          {GOOGLE_ADS_COMPARISON_UNAVAILABLE_COPY['insufficient-history']}
        </p>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {tiles.map((tile) => {
          const selected = tile.seriesKey !== null && selectedSeries.has(tile.seriesKey)
          // Locked when it is the only plotted series: turning it off would
          // leave the chart with no data and empty axes.
          const locked = selected && selectedSeries.size === 1
          const body = (
            <>
              <span className="flex items-center gap-1.5 text-xs text-secondary">
                {tile.seriesKey ? (
                  <span
                    aria-hidden="true"
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: selected ? SERIES_META[tile.seriesKey].color : 'var(--color-mono-600)' }}
                  />
                ) : null}
                {tile.label}
              </span>
              <span className="mt-0.5 block text-lg tabular-nums text-strong">{tile.value}</span>
              {comparison && tile.comparable ? (
                <span className={`block text-[11px] tabular-nums ${changeToneClass(tile.change, tile.direction)}`}>
                  {formatGoogleAdsChange(tile.change, comparison.days)}
                </span>
              ) : (
                // A fixed third slot so switching window does not reflow the
                // grid. Blank for a metric that has no change field at all.
                <span className="block text-[11px] text-muted">
                  {tile.comparable ? `no prior ${metricsWindow} period stored` : '\u00a0'}
                </span>
              )}
            </>
          )
          if (tile.seriesKey === null) {
            return (
              <div key={tile.key} className="rounded-md border border-subtle bg-surface-subtle px-3 py-2">{body}</div>
            )
          }
          return (
            <button
              key={tile.key}
              type="button"
              aria-pressed={selected}
              disabled={locked}
              onClick={() => setSelectedSeries((current) => {
                const next = new Set(current)
                if (next.has(tile.seriesKey!)) next.delete(tile.seriesKey!)
                else next.add(tile.seriesKey!)
                return next.size === 0 ? current : next
              })}
              className={`rounded-md border px-3 py-2 text-left transition-colors ${
                selected ? 'border-strong bg-surface-active' : 'border-subtle bg-surface-subtle hover:bg-surface-hover'
              } ${locked ? 'cursor-default' : ''}`}
            >
              {body}
            </button>
          )
        })}
      </div>

      <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 rounded-md border border-subtle bg-surface-subtle px-3 py-2">
        {rateStrip.map((item) => {
          const selected = item.seriesKey !== null && selectedSeries.has(item.seriesKey)
          const locked = selected && selectedSeries.size === 1
          const inner = (
            <>
              <dt className="flex items-center gap-1.5 text-xs text-secondary">
                {item.seriesKey ? (
                  <span
                    aria-hidden="true"
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: selected ? SERIES_META[item.seriesKey].color : 'var(--color-mono-600)' }}
                  />
                ) : null}
                {item.label}
              </dt>
              <dd className="text-sm tabular-nums text-strong">{item.value}</dd>
            </>
          )
          if (item.seriesKey === null) {
            return <div key={item.key} className="flex items-baseline gap-1.5">{inner}</div>
          }
          return (
            <button
              key={item.key}
              type="button"
              aria-pressed={selected}
              disabled={locked}
              onClick={() => setSelectedSeries((current) => {
                const next = new Set(current)
                if (next.has(item.seriesKey!)) next.delete(item.seriesKey!)
                else next.add(item.seriesKey!)
                return next.size === 0 ? current : next
              })}
              className={`flex items-baseline gap-1.5 rounded px-1 -mx-1 ${locked ? 'cursor-default' : 'hover:bg-surface-hover'}`}
            >
              {inner}
            </button>
          )
        })}
      </dl>

      <div className="mt-4">
        <MultiAxisTrendChart
          data={daily}
          xKey="date"
          series={chartSeries}
          xTickFormatter={formatChartDateTick}
          labelFormatter={formatChartDateLabel}
        />
        {/* Recharts owns the SVG and exposes no readable series, so the same
            days are listed for assistive tech. A densified day says so: it is a
            measured zero, not a gap in the record. */}
        <ul className="sr-only">
          {daily.map((point) => (
            <li key={point.date}>
              {formatChartDateLabel(point.date)}:{' '}
              {chartSeries
                .map((series) => `${series.label} ${SERIES_META[series.dataKey as SeriesKey].formatValue(point[series.dataKey as SeriesKey])}`)
                .join(', ')}
              {point.origin === 'filled' ? ', no delivery reported' : ''}
            </li>
          ))}
        </ul>
      </div>

      <div className="page-section-divider">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">By campaign</p>
            <h3 className="text-base font-semibold text-heading">Campaign performance</h3>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="data-table w-full text-sm">
            <caption className="sr-only">Google Ads campaign performance for the selected window</caption>
            <thead>
              <tr>
                <th className="text-left">Campaign</th>
                <th className="text-left">Status</th>
                <th className="text-right">Impressions</th>
                <th className="text-right">Clicks</th>
                <th className="text-right">Spend</th>
                <th className="text-right">Conversions</th>
                <th className="text-right">CTR</th>
                <th className="text-right">Cost / conv.</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-secondary">No campaign delivered in this window.</td>
                </tr>
              ) : campaigns.map((campaign) => (
                <tr key={campaign.campaignId}>
                  <td className="max-w-xs truncate text-strong" title={campaign.name ?? campaign.campaignId}>
                    {campaign.name ?? <span className="font-mono text-secondary">{campaign.campaignId}</span>}
                  </td>
                  <td><ToneBadge tone={campaignStatusTone(campaign.status)}>{campaignStatusLabel(campaign.status)}</ToneBadge></td>
                  <td className="text-right tabular-nums text-secondary">{COUNT_FORMAT.format(campaign.totals.impressions)}</td>
                  <td className="text-right tabular-nums text-secondary">{COUNT_FORMAT.format(campaign.totals.clicks)}</td>
                  <td className="text-right tabular-nums text-strong">{formatGoogleAdsMicros(campaign.totals.costMicros, currency)}</td>
                  <td className="text-right tabular-nums text-secondary">{CONVERSION_FORMAT.format(campaign.totals.conversions)}</td>
                  <td className="text-right tabular-nums text-secondary">{formatGoogleAdsRatio(campaign.totals.ctr)}</td>
                  <td className="text-right tabular-nums">
                    {campaign.totals.costMicros > 0 && campaign.totals.conversions === 0 ? (
                      // Spend with no conversions is the waste case, and the row
                      // that most deserves attention. Rendering it as a bare
                      // "not available" makes it the quietest row on the page.
                      <ToneBadge tone="caution">no conversions</ToneBadge>
                    ) : (
                      <span className="text-secondary">
                        {formatGoogleAdsMicros(campaign.totals.costPerConversionMicros, currency)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11px] text-muted">
          Snapshot {formatObservedInstantLabel(observedInstant(source.capturedAt))}
          {' · '}customer {source.customerId}
          {' · '}latest closed day {formatChartDateLabel(source.asOfDate)}
          {source.openDate ? <>{' · '}{formatChartDateLabel(source.openDate)} still open, excluded</> : null}
          {/* Days close in the ACCOUNT time zone, not the reader's. Without it a
              cross-time-zone operator cannot tell what "closed" means, and the
              excluded open day looks arbitrary. */}
          {source.timeZone ? <>{' · '}days close in {source.timeZone}</> : null}
        </p>
      </div>
    </section>
  )
}
