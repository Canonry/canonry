import { useEffect, useMemo, useState } from 'react'
import { Minus } from 'lucide-react'
import type { CitationCoverageProvider, CitationVisibilityResponse } from '@ainyc/canonry-contracts'
import { fetchCitationVisibility } from '../../api.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { ProviderBadge } from '../shared/ProviderBadge.js'

export function CitationVisibilitySection({ projectName }: { projectName: string }) {
  const [data, setData] = useState<CitationVisibilityResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchCitationVisibility(projectName)
      .then(res => { if (!cancelled) setData(res) })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectName])

  if (loading && !data) return null
  if (error) {
    return (
      <section className="page-section-divider">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Citation visibility</p>
            <h2>Citation + answer-mention coverage</h2>
          </div>
        </div>
        <p className="text-sm text-rose-400">{error}</p>
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
        <p className="text-sm text-zinc-500">
          {data.reason === 'no-keywords'
            ? 'Add keywords to start tracking AI citations.'
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
            <InfoTooltip text="An engine is &lsquo;citing&rsquo; when our domain appears in its grounding source list (the structured citation/search-result attribution it returns alongside the answer). Counts each configured engine that cites the project on at least one tracked keyword in the latest snapshot per (keyword × provider)." />
          </h2>
          <p className="text-base text-zinc-300 flex items-center gap-2">
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
    totalKeywords,
    keywordsCitedAndMentioned,
    keywordsCitedOnly,
    keywordsMentionedOnly,
    keywordsInvisible,
  } = data.summary
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-4">
      <SummaryCell
        label="Cited + mentioned"
        value={`${keywordsCitedAndMentioned} / ${totalKeywords}`}
        helper="In sources AND named in answer"
        tone={keywordsCitedAndMentioned > 0 ? 'positive' : 'neutral'}
      />
      <SummaryCell
        label="Cited only"
        value={`${keywordsCitedOnly} / ${totalKeywords}`}
        helper="In sources, not named in answer"
        tone={keywordsCitedOnly > 0 ? 'positive-dim' : 'neutral'}
      />
      <SummaryCell
        label="Mentioned only"
        value={`${keywordsMentionedOnly} / ${totalKeywords}`}
        helper="Named in answer, no source link"
        tone={keywordsMentionedOnly > 0 ? 'caution' : 'neutral'}
      />
      <SummaryCell
        label="Invisible"
        value={`${keywordsInvisible} / ${totalKeywords}`}
        helper="No engine cites or mentions"
        tone={keywordsInvisible > 0 ? 'negative' : 'neutral'}
      />
    </div>
  )
}

type Tone = 'positive' | 'positive-dim' | 'caution' | 'negative' | 'neutral'

function SummaryCell({ label, value, helper, tone }: { label: string; value: string; helper: string; tone: Tone }) {
  const valueClass = tone === 'positive'
    ? 'text-emerald-300'
    : tone === 'positive-dim'
      ? 'text-emerald-400/70'
      : tone === 'caution'
        ? 'text-amber-300'
        : tone === 'negative'
          ? 'text-rose-300'
          : 'text-zinc-100'
  return (
    <div className="rounded-md border border-zinc-800/60 bg-zinc-900/30 px-4 py-3">
      <p className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</p>
      <p className="text-[11px] text-zinc-500">{helper}</p>
    </div>
  )
}

function CoverageTable({ data }: { data: CitationVisibilityResponse }) {
  const providerColumns = useMemo(() => {
    const set = new Set<string>()
    for (const row of data.byKeyword) {
      for (const p of row.providers) set.add(p.provider)
    }
    return Array.from(set).sort()
  }, [data.byKeyword])

  if (data.byKeyword.length === 0) {
    return <p className="text-sm text-zinc-500">No keyword coverage rows.</p>
  }

  return (
    <div>
      <CoverageLegend />
      <div className="evidence-table-wrap">
        <table className="evidence-table">
          <thead>
            <tr>
              <th>Keyword</th>
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
            {data.byKeyword.map(row => (
              <tr key={row.keywordId}>
                <td className="font-medium text-zinc-100">{row.keyword}</td>
                {providerColumns.map(p => {
                  const provider = row.providers.find(x => x.provider === p)
                  return (
                    <td key={p} className="text-center">
                      {provider == null ? (
                        <Minus className="inline h-3.5 w-3.5 text-zinc-700" aria-label="no data" />
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
                        ? 'text-emerald-300'
                        : row.citedCount > 0
                          ? 'text-emerald-400/70'
                          : 'text-zinc-500'
                    }
                  >
                    {row.citedCount}/{row.totalProviders}
                  </span>
                </td>
                <td className="text-right tabular-nums">
                  <span
                    className={
                      row.totalProviders > 0 && row.mentionedCount === row.totalProviders
                        ? 'text-sky-300'
                        : row.mentionedCount > 0
                          ? 'text-sky-400/70'
                          : 'text-zinc-500'
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
    <div className="mb-2 flex flex-wrap items-center gap-3 text-[11px] text-zinc-500">
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
    return <span className="inline-block h-2 w-2 rounded-full border border-zinc-700/80 bg-transparent" aria-hidden="true" />
  }
  const className = tone === 'cited'
    ? 'inline-block h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_0_1px_rgba(16,185,129,0.25)]'
    : 'inline-block h-2 w-2 rounded-full bg-sky-400 shadow-[0_0_0_1px_rgba(56,189,248,0.25)]'
  return <span className={className} aria-hidden="true" />
}

function CompetitorGapList({ data }: { data: CitationVisibilityResponse }) {
  return (
    <div className="mt-4">
      <h3 className="text-sm font-semibold text-zinc-200 mb-2 flex items-center gap-2">
        Competitor gaps
        <InfoTooltip text="Keywords where the project is not cited but a configured competitor is. Each row maps to one (keyword, engine) pair — the same keyword may surface for multiple engines." />
        <span className="text-[10px] font-normal uppercase tracking-wide text-zinc-500">
          {data.competitorGaps.length} {data.competitorGaps.length === 1 ? 'gap' : 'gaps'}
        </span>
      </h3>
      <div className="evidence-table-wrap">
        <table className="evidence-table">
          <thead>
            <tr>
              <th>Keyword</th>
              <th>Engine</th>
              <th>Competitors cited</th>
            </tr>
          </thead>
          <tbody>
            {data.competitorGaps.map(gap => (
              <tr key={`${gap.keywordId}::${gap.provider}`}>
                <td className="font-medium text-zinc-100">{gap.keyword}</td>
                <td><ProviderBadge provider={gap.provider} /></td>
                <td className="text-zinc-300">{gap.citingCompetitors.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
