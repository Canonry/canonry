import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'

import { Card } from '../components/ui/card.js'
import { Button } from '../components/ui/button.js'
import { ScoreGauge } from '../components/shared/ScoreGauge.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { Sparkline } from '../components/shared/Sparkline.js'
import { fetchSocialSummary, type ApiSocialSummary } from '../api.js'
import type { MetricTone } from '../view-models.js'

const PLATFORMS = ['Twitter', 'Reddit', 'LinkedIn']

function sentimentTone(sentiment: number): MetricTone {
  if (sentiment >= 65) return 'positive'
  if (sentiment >= 40) return 'neutral'
  return 'negative'
}

function mentionSentimentTone(sentiment: 'positive' | 'negative' | 'neutral'): MetricTone {
  if (sentiment === 'positive') return 'positive'
  if (sentiment === 'negative') return 'negative'
  return 'neutral'
}

function formatEngagement(likes: number, shares: number, comments: number): string {
  const total = likes + shares + comments
  if (total >= 1000) return `${(total / 1000).toFixed(1)}k`
  return String(total)
}

function formatPostedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export function SocialPage() {
  const [data, setData] = useState<ApiSocialSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [platformFilter, setPlatformFilter] = useState<string>('All')
  const [mentionPage, setMentionPage] = useState(0)

  const PAGE_SIZE = 10

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetchSocialSummary()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load social data'))
      .finally(() => setLoading(false))
  }, [])

  const filteredMentions = (data?.recentMentions ?? []).filter(
    (m) => platformFilter === 'All' || m.platform === platformFilter,
  )
  const paginatedMentions = filteredMentions.slice(mentionPage * PAGE_SIZE, (mentionPage + 1) * PAGE_SIZE)
  const totalPages = Math.ceil(filteredMentions.length / PAGE_SIZE)

  const totalMentions = data?.totalMentions7d ?? 0
  const sentimentScore = data?.sentimentScore ?? 0
  const domainLinks = data?.domainLinks ?? 0
  const trendPoints = data?.trendByDay ?? []

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Social</h1>
          <p className="page-subtitle">Mentions, sentiment, and domain links across social platforms.</p>
        </div>
      </div>

      {loading && (
        <p className="supporting-copy" aria-live="polite">
          Loading social data…
        </p>
      )}

      {error && (
        <Card className="surface-card">
          <p className="text-sm text-rose-400" role="alert">
            {error}
          </p>
          <p className="supporting-copy mt-1">
            Social monitoring requires the social API endpoints to be configured. Check Settings → Social Platforms.
          </p>
        </Card>
      )}

      {!loading && !error && (
        <>
          {/* Hero metrics row */}
          <section className="page-section" aria-label="Social metrics overview">
            <div className="gauge-row">
              <ScoreGauge
                value={String(totalMentions)}
                label="Total Mentions (7d)"
                delta={trendPoints.length > 1 ? `${trendPoints.at(-1)! - trendPoints[0]!} since start of period` : '—'}
                tone={totalMentions > 0 ? 'positive' : 'neutral'}
                description="Posts and comments mentioning your brand across all connected platforms."
                isNumeric={false}
              />
              <ScoreGauge
                value={`${sentimentScore}%`}
                label="Sentiment Score"
                delta={sentimentScore >= 65 ? 'Mostly positive' : sentimentScore >= 40 ? 'Mixed' : 'Mostly negative'}
                tone={sentimentTone(sentimentScore)}
                description="Percentage of mentions with a positive sentiment signal."
                isNumeric={false}
              />
              <ScoreGauge
                value={String(domainLinks)}
                label="Domain Links"
                delta="Posts linking to your canonical domain"
                tone={domainLinks > 0 ? 'positive' : 'neutral'}
                description="Mentions that include a direct link to your canonical domain."
                isNumeric={false}
              />
            </div>

            {trendPoints.length > 1 && (
              <div className="mt-4 flex items-center gap-2">
                <span className="text-xs text-zinc-500">7d trend</span>
                <Sparkline points={trendPoints} tone={sentimentTone(sentimentScore)} />
              </div>
            )}
          </section>

          {/* Platform breakdown table */}
          <section className="page-section-divider" aria-label="Platform breakdown">
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">Social platforms</p>
                <h2>Platform breakdown</h2>
              </div>
            </div>

            {data?.platforms && data.platforms.length > 0 ? (
              <div className="data-table-wrapper">
                <table className="data-table" aria-label="Platform breakdown">
                  <thead>
                    <tr>
                      <th>Platform</th>
                      <th>Mentions (7d)</th>
                      <th>Engagement</th>
                      <th>Sentiment</th>
                      <th>Domain Links</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.platforms.map((platform) => (
                      <tr key={platform.id}>
                        <td className="font-medium">{platform.name}</td>
                        <td>{platform.mentions7d.toLocaleString()}</td>
                        <td>{platform.engagement.toLocaleString()}</td>
                        <td>
                          <ToneBadge tone={sentimentTone(platform.sentiment)}>
                            {platform.sentiment}%
                          </ToneBadge>
                        </td>
                        <td>{platform.domainLinks.toLocaleString()}</td>
                        <td>
                          <ToneBadge tone={platform.configured ? 'positive' : 'neutral'}>
                            {platform.configured ? 'Connected' : 'Disconnected'}
                          </ToneBadge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="supporting-copy">
                No platforms connected yet. Go to Settings → Social Platforms to connect your first platform.
              </p>
            )}
          </section>

          {/* Recent mentions table */}
          <section className="page-section-divider" aria-label="Recent mentions">
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">Recent activity</p>
                <h2>Recent mentions</h2>
              </div>
              <p className="supporting-copy">{filteredMentions.length} mention{filteredMentions.length !== 1 ? 's' : ''}</p>
            </div>

            {/* Platform filter chips */}
            <div className="filter-row mb-3" role="toolbar" aria-label="Platform filters">
              {['All', ...PLATFORMS].map((p) => (
                <button
                  key={p}
                  className={`filter-chip ${platformFilter === p ? 'filter-chip-active' : ''}`}
                  type="button"
                  aria-pressed={platformFilter === p}
                  onClick={() => {
                    setPlatformFilter(p)
                    setMentionPage(0)
                  }}
                >
                  {p}
                </button>
              ))}
            </div>

            {paginatedMentions.length > 0 ? (
              <>
                <div className="data-table-wrapper">
                  <table className="data-table" aria-label="Recent social mentions">
                    <thead>
                      <tr>
                        <th>Platform</th>
                        <th>Author</th>
                        <th>Content</th>
                        <th>Sentiment</th>
                        <th>Engagement</th>
                        <th>Posted At</th>
                        <th aria-label="Link"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedMentions.map((mention) => (
                        <tr key={mention.id}>
                          <td className="text-zinc-400 text-xs">{mention.platform}</td>
                          <td className="font-medium">{mention.author}</td>
                          <td
                            className="max-w-xs truncate text-zinc-300 text-sm"
                            title={mention.content}
                          >
                            {mention.content.length > 80
                              ? `${mention.content.slice(0, 80)}…`
                              : mention.content}
                          </td>
                          <td>
                            <ToneBadge tone={mentionSentimentTone(mention.sentiment)}>
                              {mention.sentiment}
                            </ToneBadge>
                          </td>
                          <td className="text-zinc-400 text-xs">
                            {formatEngagement(mention.likes, mention.shares, mention.comments)}
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

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between mt-3">
                    <p className="text-xs text-zinc-500">
                      Page {mentionPage + 1} of {totalPages}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={mentionPage === 0}
                        onClick={() => setMentionPage((p) => p - 1)}
                      >
                        Previous
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={mentionPage >= totalPages - 1}
                        onClick={() => setMentionPage((p) => p + 1)}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="supporting-copy">
                {platformFilter === 'All'
                  ? 'No mentions found. Connect a platform in Settings → Social Platforms.'
                  : `No ${platformFilter} mentions found.`}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  )
}
