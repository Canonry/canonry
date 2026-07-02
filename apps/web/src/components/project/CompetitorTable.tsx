import { ToneBadge } from '../shared/ToneBadge.js'
import { competitorTone } from '../../lib/tone-helpers.js'
import type { ProjectCommandCenterVm } from '../../view-models.js'

export function CompetitorTable({
  competitors,
  onSelectCompetitor,
  onRemoveCompetitor,
  activeFilter,
}: {
  competitors: ProjectCommandCenterVm['competitors']
  /** Click handler — fired when an analyst wants to filter the Evidence Table
   *  to the queries where this competitor surfaced. Receives the domain. */
  onSelectCompetitor?: (domain: string) => void
  /** Remove handler — fired when an analyst removes a tracked competitor.
   *  Receives the domain. When omitted, no remove control is rendered. */
  onRemoveCompetitor?: (domain: string) => void
  /** Currently-active competitor filter, for row highlighting. */
  activeFilter?: string | null
}) {
  if (competitors.length === 0) {
    return <p className="text-sm text-muted">No competitors configured. Add competitors to track overlap.</p>
  }

  const clickable = onSelectCompetitor != null
  const removable = onRemoveCompetitor != null

  return (
    <div className="competitor-table-wrap">
      <table className="competitor-table">
        <thead>
          <tr>
            <th>Domain</th>
            <th>Pressure</th>
            <th>Citations</th>
            <th>Queries</th>
            {removable && <th><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {competitors.map((competitor) => {
            const isActive = activeFilter != null && activeFilter.toLowerCase() === competitor.domain.toLowerCase()
            const rowClass = [
              clickable ? 'cursor-pointer hover:bg-mono-800/30 transition-colors' : '',
              isActive ? 'bg-negative-950/20' : '',
            ].filter(Boolean).join(' ')
            return (
              <tr
                key={competitor.id}
                className={rowClass}
                onClick={clickable ? () => onSelectCompetitor!(competitor.domain) : undefined}
                title={clickable ? `Filter answers to queries where ${competitor.domain} surfaced` : undefined}
              >
                <td className="font-medium text-heading">{competitor.domain}</td>
                <td>
                  <ToneBadge tone={competitorTone(competitor.pressureLabel)}>
                    {competitor.pressureLabel}
                  </ToneBadge>
                </td>
                <td className="text-neutral tabular-nums">
                  {competitor.totalQueries > 0
                    ? `${competitor.citationCount} / ${competitor.totalQueries}`
                    : '—'}
                </td>
                <td className="text-muted text-xs">
                  {competitor.citedQueries.length > 0
                    ? competitor.citedQueries.join(', ')
                    : 'Not cited'}
                </td>
                {removable && (
                  <td className="text-right">
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 text-xs text-muted transition-colors hover:text-negative-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-negative-500"
                      aria-label={`Remove competitor ${competitor.domain}`}
                      title={`Remove ${competitor.domain}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        onRemoveCompetitor!(competitor.domain)
                      }}
                    >
                      Remove
                    </button>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
