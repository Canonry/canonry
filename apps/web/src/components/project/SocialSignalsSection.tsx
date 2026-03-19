import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'

import { ToneBadge } from '../shared/ToneBadge.js'
import { Sparkline } from '../shared/Sparkline.js'
import { fetchProjectSocialMentions, type ApiSocialMention } from '../../api.js'
import type { MetricTone } from '../../view-models.js'

const PLATFORM_FILTERS = ['All', 'Twitter', 'Reddit', 'LinkedIn']

function sentimentTone(sentiment: 'positive' | 'negative' | 'neutral'): MetricTone {
  if (sentiment === 'positive') return 'positive'
  if (sentiment === 'negative') return 'negative'
  return 'neutral'
}

function summarizeMentions(mentions: ApiSocialMention[]) {
  const positive = mentions.filter((m) => m.sentiment === 'positive').length
  const negative = mentions.filter((m) => m.sentiment === 'negative').length
  const total = mentions.length

  // Find top hashtag or subreddit pattern
  const tags: Record<string, number> = {}
  for (const m of mentions) {
    const matches = m.content.match(/[#/][\w]+/g) ?? []
    for (const tag of matches) {
      tags[tag] = (tags[tag] ?? 0) + 1
    }
  }
  const topTag = Object.entries(tags).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—'

  return {
    total,
    positivePercent: total > 0 ? Math.round((positive / total) * 100) : 0,
    negativePercent: total > 0 ? Math.round((negative / total) * 100) : 0,
    topTag,
  }
}

function formatPostedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return iso
  }
}

export function SocialSignalsSection({ projectName }: { projectName: string }) {
  const [mentions, setMentions] = useState<ApiSocialMention[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [platformFilter, setPlatformFilter] = useState<string>('All')

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetchProjectSocialMentions(projectName, { limit: 50 })
      .then(setMentions)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load social signals'))
      .finally(() => setLoading(false))
  }, [projectName])

  const filteredMentions = mentions.filter(
    (m) => platformFilter === 'All' || m.platform === platformFilter,
  )

  const summary = summarizeMentions(filteredMentions)

  // Build a simple 7-day sparkline from postedAt timestamps
  const trendByDay = (() => {
    const counts: Record<string, number> = {}
    for (const m of mentions) {
      const day = m.postedAt.slice(0, 10)
      counts[day] = (counts[day] ?? 0) + 1
    }
    const days = Object.keys(counts).sort()
    return days.map((d) => counts[d] ?? 0)
  })()

  if (loading) {
    return (
      <section className="page-section-divider" aria-label="Social Signals">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Social</p>
            <h2>Social Signals</h2>
          </div>
        </div>
        <p className="supporting-copy" aria-live="polite">Loading social signals…</p>
      </section>
    )
  }

  if (error) {
    return (
      <section className="page-section-divider" aria-label="Social Signals">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Social</p>
            <h2>Social Signals</h2>
          </div>
        </div>
        <p className="text-sm text-zinc-500">
          Social monitoring not available. Connect platforms in{' '}
          <a href="/settings" className="underline underline-offset-2 hover:text-zinc-200">
            Settings → Social Platforms
          </a>
          .
        </p>
      </section>
    )
  }

  return (
    <section className="page-section-divider" aria-label="Social Signals">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Social</p>
          <h2>Social Signals</h2>
        </div>
      </div>

      {/* Summary row */}
      <div className="flex flex-wrap items-center gap-4 mb-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
        <div>
          <p className="text-xs text-zinc-500">Mentions</p>
          <p className="text-lg font-semibold text-zinc-100">{summary.total}</p>
        </div>
        <div>
          <p className="text-xs text-zinc-500">Positive</p>
          <p className="text-lg font-semibold text-emerald-400">{summary.positivePercent}%</p>
        </div>
        <div>
          <p className="text-xs text-zinc-500">Negative</p>
          <p className="text-lg font-semibold text-rose-400">{summary.negativePercent}%</p>
        </div>
        <div>
          <p className="text-xs text-zinc-500">Top tag</p>
          <p className="text-sm font-medium text-zinc-300 font-mono">{summary.topTag}</p>
        </div>
        {trendByDay.length > 1 && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-zinc-500">Trend</span>
            <Sparkline points={trendByDay} tone="neutral" />
          </div>
        )}
      </div>

      {/* Platform filter chips */}
      <div className="filter-row mb-3" role="toolbar" aria-label="Platform filters">
        {PLATFORM_FILTERS.map((p) => (
          <button
            key={p}
            className={`filter-chip ${platformFilter === p ? 'filter-chip-active' : ''}`}
            type="button"
            aria-pressed={platformFilter === p}
            onClick={() => setPlatformFilter(p)}
          >
            {p}
          </button>
        ))}
      </div>

      {filteredMentions.length > 0 ? (
        <div className="data-table-wrapper">
          <table className="data-table" aria-label="Social mentions for this project">
            <thead>
              <tr>
                <th>Platform</th>
                <th>Author</th>
                <th>Content</th>
                <th>Sentiment</th>
                <th>Engagement</th>
                <th>Posted</th>
                <th aria-label="Link"></th>
              </tr>
            </thead>
            <tbody>
              {filteredMentions.slice(0, 20).map((mention) => (
                <tr key={mention.id}>
                  <td className="text-zinc-400 text-xs">{mention.platform}</td>
                  <td className="font-medium">{mention.author}</td>
                  <td
                    className="max-w-xs truncate text-zinc-300 text-sm"
                    title={mention.content}
                  >
                    {mention.content.length > 60
                      ? `${mention.content.slice(0, 60)}…`
                      : mention.content}
                  </td>
                  <td>
                    <ToneBadge tone={sentimentTone(mention.sentiment)}>
                      {mention.sentiment}
                    </ToneBadge>
                  </td>
                  <td className="text-zinc-400 text-xs">
                    {mention.likes + mention.shares + mention.comments}
                  </td>
                  <td className="text-zinc-500 text-xs whitespace-nowrap">
                    {formatPostedAt(mention.postedAt)}
                  </td>
                  <td>
                    {mention.url && (
                      <a
                        href={mention.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-zinc-500 hover:text-zinc-200 transition-colors"
                        aria-label={`Open mention by ${mention.author} on ${mention.platform}`}
                      >
                        <ExternalLink className="size-3.5" />
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="supporting-copy">
          {platformFilter === 'All'
            ? 'No social mentions found for this project. Connect platforms in Settings → Social Platforms.'
            : `No ${platformFilter} mentions found for this project.`}
        </p>
      )}
    </section>
  )
}
