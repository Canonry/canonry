import { ToneBadge } from '../shared/ToneBadge.js'
import { competitorTone } from '../../lib/tone-helpers.js'
import type { ProjectCommandCenterVm } from '../../view-models.js'

export function CompetitorTable({ competitors }: { competitors: ProjectCommandCenterVm['competitors'] }) {
  if (competitors.length === 0) {
    return <p className="text-sm text-zinc-500">No competitors configured. Add competitors to track overlap.</p>
  }

  return (
    <div className="competitor-table-wrap">
      <table className="competitor-table">
        <thead>
          <tr>
            <th>Domain</th>
            <th>Pressure</th>
            <th>Citations</th>
            <th>Key Phrases</th>
          </tr>
        </thead>
        <tbody>
          {competitors.map((competitor) => (
            <tr key={competitor.id}>
              <td className="font-medium text-zinc-100">{competitor.domain}</td>
              <td>
                <ToneBadge tone={competitorTone(competitor.pressureLabel)}>
                  {competitor.pressureLabel}
                </ToneBadge>
              </td>
              <td className="text-zinc-300 tabular-nums">
                {competitor.totalKeywords > 0
                  ? `${competitor.citationCount} / ${competitor.totalKeywords}`
                  : '\u2014'}
              </td>
              <td className="text-zinc-500 text-xs">
                {competitor.citedKeywords.length > 0
                  ? competitor.citedKeywords.join(', ')
                  : 'Not cited'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
