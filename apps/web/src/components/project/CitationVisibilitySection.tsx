import { useEffect, useMemo, useState } from 'react'
import { Check, X, Minus } from 'lucide-react'
import type { CitationVisibilityResponse } from '@ainyc/canonry-contracts'
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
            <h2>Cited by N of M engines</h2>
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
            <h2>Cited by N of M engines</h2>
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

  return (
    <section className="page-section-divider">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Citation visibility</p>
          <h2>
            Cited by {data.summary.providersCiting} of {data.summary.providersConfigured} engines{' '}
            <InfoTooltip text="Number of configured AI engines that cite this project for at least one tracked keyword in the latest snapshot per (keyword × provider). Works at any traffic volume." />
          </h2>
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
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 mb-4">
      <SummaryCell
        label="Cited keywords"
        value={`${data.summary.keywordsCited} / ${data.summary.totalKeywords}`}
        helper="Cited by at least one engine"
        tone={data.summary.keywordsCited > 0 ? 'positive' : 'neutral'}
      />
      <SummaryCell
        label="Fully covered"
        value={`${data.summary.keywordsFullyCovered} / ${data.summary.totalKeywords}`}
        helper="Cited by every configured engine"
        tone={data.summary.keywordsFullyCovered > 0 ? 'positive' : 'neutral'}
      />
      <SummaryCell
        label="Uncovered"
        value={`${data.summary.keywordsUncovered} / ${data.summary.totalKeywords}`}
        helper="No engine cites the project"
        tone={data.summary.keywordsUncovered > 0 ? 'caution' : 'neutral'}
      />
    </div>
  )
}

type Tone = 'positive' | 'caution' | 'negative' | 'neutral'

function SummaryCell({ label, value, helper, tone }: { label: string; value: string; helper: string; tone: Tone }) {
  const valueClass = tone === 'positive'
    ? 'text-emerald-300'
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
            <th className="text-right">Coverage</th>
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
                    ) : provider.cited ? (
                      <Check className="inline h-4 w-4 text-emerald-400" aria-label="cited" />
                    ) : (
                      <X className="inline h-4 w-4 text-zinc-600" aria-label="not cited" />
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
                        ? 'text-amber-300'
                        : 'text-zinc-500'
                  }
                >
                  {row.citedCount}/{row.totalProviders}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
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
