import { ToneBadge } from '../shared/ToneBadge.js'
import { competitorTone } from '../../lib/tone-helpers.js'
import type { ProjectCommandCenterVm } from '../../view-models.js'

export function CompetitorTable({
  competitors,
  onSelectCompetitor,
  activeFilter,
}: {
  competitors: ProjectCommandCenterVm['competitors']
  /** Click handler — fired when an analyst wants to filter the Evidence Table
   *  to the queries where this competitor surfaced. Receives the domain. */
  onSelectCompetitor?: (domain: string) => void
  /** Currently-active competitor filter, for row highlighting. */
  activeFilter?: string | null
}) {
  if (competitors.length === 0) {
    return <p className="text-sm text-zinc-500">No competitors configured. Add competitors to track overlap.</p>
  }

  const clickable = onSelectCompetitor != null

  return (
    <div className="competitor-table-wrap">
      <table className="competitor-table">
        <thead>
          <tr>
            <th>Domain</th>
            <th>Pressure</th>
            <th>Citations</th>
            <th>Queries</th>
          </tr>
        </thead>
        <tbody>
          {competitors.map((competitor) => {
            const isActive = activeFilter != null && activeFilter.toLowerCase() === competitor.domain.toLowerCase()
            const rowClass = [
              clickable ? 'cursor-pointer hover:bg-zinc-800/30 transition-colors' : '',
              isActive ? 'bg-rose-950/20' : '',
            ].filter(Boolean).join(' ')
            return (
              <tr
                key={competitor.id}
                className={rowClass}
                onClick={clickable ? () => onSelectCompetitor!(competitor.domain) : undefined}
                title={clickable ? `Filter answers to queries where ${competitor.domain} surfaced` : undefined}
              >
                <td className="font-medium text-zinc-100">{competitor.domain}</td>
                <td>
                  <ToneBadge tone={competitorTone(competitor.pressureLabel)}>
                    {competitor.pressureLabel}
                  </ToneBadge>
                </td>
                <td className="text-zinc-300 tabular-nums">
                  {competitor.totalQueries > 0
                    ? `${competitor.citationCount} / ${competitor.totalQueries}`
                    : '—'}
                </td>
                <td className="text-zinc-500 text-xs">
                  {competitor.citedQueries.length > 0
                    ? competitor.citedQueries.join(', ')
                    : 'Not cited'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
