import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Minus } from 'lucide-react'
import type { CitationCoverageProvider, CitationVisibilityResponse } from '@ainyc/canonry-contracts'
import { getApiV1ProjectsByNameCitationsVisibilityOptions } from '@ainyc/canonry-api-client/react-query'
import { heyClient } from '../../api.js'
import { STATIC_VISIBILITY_STALE_MS } from '../../queries/query-client.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { ProviderBadge } from '../shared/ProviderBadge.js'

export function CitationVisibilitySection({ projectName }: { projectName: string }) {
  const visibilityQuery = useQuery({
    ...getApiV1ProjectsByNameCitationsVisibilityOptions({
      client: heyClient,
      path: { name: projectName },
    }),
    staleTime: STATIC_VISIBILITY_STALE_MS,
  })
  const data = visibilityQuery.data ?? null
  const error = visibilityQuery.error

  if (visibilityQuery.isLoading && !data) return null
  if (error) {
    return (
      <section className="page-section-divider">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Citation visibility</p>
            <h2>Citation + answer-mention coverage</h2>
          </div>
        </div>
        <p className="text-sm text-negative-400">{error instanceof Error ? error.message : String(error)}</p>
      </section>
    )
  }
  if (!data) return null

  if (data.status === 'no-data') {
    return (
      <section className="page-section-divider">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Citation visibility</p>
            <h2>Citation + answer-mention coverage</h2>
          </div>
        </div>
        <p className="text-sm text-muted">
          {data.reason === 'no-queries'
            ? 'Add queries to start tracking AI citations.'
            : 'Run a sweep to see which engines cite this project.'}
        </p>
      </section>
    )
  }

  const { providersCiting, providersMentioning, providersConfigured } = data.summary

  return (
    <section className="page-section-divider">
      <div className="section-head section-head-inline">
        <div className="space-y-1">
          <p className="eyebrow eyebrow-soft">Citation visibility</p>
          <h2 className="flex items-center gap-2">
            Cited by {providersCiting} of {providersConfigured} engines
            <InfoTooltip text="An engine is &lsquo;citing&rsquo; when our domain appears in its grounding source list (the structured citation/search-result attribution it returns alongside the answer). Counts each configured engine that cites the project on at least one tracked query in the latest snapshot per (query × provider)." />
          </h2>
          <p className="text-base text-neutral flex items-center gap-2">
            Mentioned in {providersMentioning} of {providersConfigured} engine answers
            <InfoTooltip text="An engine is &lsquo;mentioning&rsquo; when our brand or domain appears inside the prose of the answer text — independent of whether it&rsquo;s in the citation list. Models often name-drop from training without citing a fresh page." />
          </p>
        </div>
        {data.summary.latestRunAt && (
          <p className="supporting-copy">
            Latest run {new Date(data.summary.latestRunAt).toLocaleString()}
          </p>
        )}
      </div>

      <CitationSummaryRow data={data} />
      <CoverageTable data={data} />
      {data.competitorGaps.length > 0 && <CompetitorGapList data={data} />}
    </section>
  )
}

function CitationSummaryRow({ data }: { data: CitationVisibilityResponse }) {
  const {
    totalQueries,
    queriesCitedAndMentioned,
    queriesCitedOnly,
    queriesMentionedOnly,
    queriesInvisible,
  } = data.summary
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-4">
      <SummaryCell
        label="Cited + mentioned"
        value={`${queriesCitedAndMentioned} / ${totalQueries}`}
        helper="In sources AND named in answer"
        tone={queriesCitedAndMentioned > 0 ? 'positive' : 'neutral'}
      />
      <SummaryCell
        label="Cited only"
        value={`${queriesCitedOnly} / ${totalQueries}`}
        helper="In sources, not named in answer"
        tone={queriesCitedOnly > 0 ? 'positive-dim' : 'neutral'}
      />
      <SummaryCell
        label="Mentioned only"
        value={`${queriesMentionedOnly} / ${totalQueries}`}
        helper="Named in answer, no source link"
        tone={queriesMentionedOnly > 0 ? 'caution' : 'neutral'}
      />
      <SummaryCell
        label="Invisible"
        value={`${queriesInvisible} / ${totalQueries}`}
        helper="No engine cites or mentions"
        tone={queriesInvisible > 0 ? 'negative' : 'neutral'}
      />
    </div>
  )
}

type Tone = 'positive' | 'positive-dim' | 'caution' | 'negative' | 'neutral'

function SummaryCell({ label, value, helper, tone }: { label: string; value: string; helper: string; tone: Tone }) {
  const valueClass = tone === 'positive'
    ? 'text-positive'
    : tone === 'positive-dim'
      ? 'text-positive-400/70'
      : tone === 'caution'
        ? 'text-caution'
        : tone === 'negative'
          ? 'text-negative'
          : 'text-heading'
  return (
    <div className="rounded-md border border-default bg-surface px-4 py-3">
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</p>
      <p className="text-[11px] text-muted">{helper}</p>
    </div>
  )
}

function CoverageTable({ data }: { data: CitationVisibilityResponse }) {
  const providerColumns = useMemo(() => {
    const set = new Set<string>()
    for (const row of data.byQuery) {
      for (const p of row.providers) set.add(p.provider)
    }
    return Array.from(set).sort()
  }, [data.byQuery])

  if (data.byQuery.length === 0) {
    return <p className="text-sm text-muted">No query coverage rows.</p>
  }

  return (
    <div>
      <CoverageLegend />
      <div className="evidence-table-wrap">
        <table className="evidence-table">
          <thead>
            <tr>
              <th>Query</th>
              {providerColumns.map(p => (
                <th key={p} className="text-center">
                  <ProviderBadge provider={p} />
                </th>
              ))}
              <th className="text-right">Cite</th>
              <th className="text-right">Ment</th>
            </tr>
          </thead>
          <tbody>
            {data.byQuery.map(row => (
              <tr key={row.queryId}>
                <td className="font-medium text-heading">{row.query}</td>
                {providerColumns.map(p => {
                  const provider = row.providers.find(x => x.provider === p)
                  return (
                    <td key={p} className="text-center">
                      {provider == null ? (
                        <Minus className="inline h-3.5 w-3.5 text-mono-700" aria-label="no data" />
                      ) : (
                        <DualIndicator provider={provider} />
                      )}
                    </td>
                  )
                })}
                <td className="text-right tabular-nums">
                  <span
                    className={
                      row.totalProviders > 0 && row.citedCount === row.totalProviders
                        ? 'text-positive'
                        : row.citedCount > 0
                          ? 'text-positive-400/70'
                          : 'text-muted'
                    }
                  >
                    {row.citedCount}/{row.totalProviders}
                  </span>
                </td>
                <td className="text-right tabular-nums">
                  <span
                    className={
                      row.totalProviders > 0 && row.mentionedCount === row.totalProviders
                        ? 'text-info-300'
                        : row.mentionedCount > 0
                          ? 'text-info-400/70'
                          : 'text-muted'
                    }
                  >
                    {row.mentionedCount}/{row.totalProviders}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function CoverageLegend() {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-3 text-[11px] text-muted">
      <span className="flex items-center gap-1.5">
        <IndicatorDot active tone="cited" />
        <span>cited (in sources)</span>
      </span>
      <span className="flex items-center gap-1.5">
        <IndicatorDot active tone="mentioned" />
        <span>mentioned (in answer)</span>
      </span>
      <span className="flex items-center gap-1.5">
        <IndicatorDot active={false} tone="cited" />
        <IndicatorDot active={false} tone="mentioned" />
        <span>neither</span>
      </span>
    </div>
  )
}

function DualIndicator({ provider }: { provider: CitationCoverageProvider }) {
  const title = describeIndicator(provider)
  return (
    <span className="inline-flex items-center justify-center gap-1" title={title}>
      <IndicatorDot active={provider.cited} tone="cited" />
      <IndicatorDot active={provider.mentioned} tone="mentioned" />
    </span>
  )
}

function describeIndicator(provider: CitationCoverageProvider): string {
  if (provider.cited && provider.mentioned) return 'Cited in sources and mentioned in answer'
  if (provider.cited) return 'Cited in sources, not mentioned in answer'
  if (provider.mentioned) return 'Mentioned in answer, not in sources'
  return 'Not cited and not mentioned'
}

function IndicatorDot({ active, tone }: { active: boolean; tone: 'cited' | 'mentioned' }) {
  if (!active) {
    return <span className="inline-block h-2 w-2 rounded-full border border-strong/80 bg-transparent" aria-hidden="true" />
  }
  const className = tone === 'cited'
    ? 'inline-block h-2 w-2 rounded-full bg-positive-400 shadow-[0_0_0_1px_rgba(16,185,129,0.25)]'
    : 'inline-block h-2 w-2 rounded-full bg-info-400 shadow-[0_0_0_1px_rgba(56,189,248,0.25)]'
  return <span className={className} aria-hidden="true" />
}

function CompetitorGapList({ data }: { data: CitationVisibilityResponse }) {
  return (
    <div className="mt-4">
      <h3 className="text-sm font-semibold text-strong mb-2 flex items-center gap-2">
        Competitor gaps
        <InfoTooltip text="Queries where the project is not cited but a configured competitor is. Each row maps to one (query, engine) pair — the same query may surface for multiple engines." />
        <span className="text-[10px] font-normal uppercase tracking-wide text-muted">
          {data.competitorGaps.length} {data.competitorGaps.length === 1 ? 'gap' : 'gaps'}
        </span>
      </h3>
      <div className="evidence-table-wrap">
        <table className="evidence-table">
          <thead>
            <tr>
              <th>Query</th>
              <th>Engine</th>
              <th>Competitors cited</th>
            </tr>
          </thead>
          <tbody>
            {data.competitorGaps.map(gap => (
              <tr key={`${gap.queryId}::${gap.provider}`}>
                <td className="font-medium text-heading">{gap.query}</td>
                <td><ProviderBadge provider={gap.provider} /></td>
                <td className="text-neutral">{gap.citingCompetitors.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
