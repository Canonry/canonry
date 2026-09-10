import {
  REPORT_VISIBILITY_COPY as copy,
  reportQueryClassLabel,
  reportVisibilityRate,
  reportVisibilityEvidence,
  reportVisibilityComparison,
  reportVisibilityMeasurementLabel,
  reportVisibilityHistoryLabel,
  type ReportVisibility,
} from '@ainyc/canonry-contracts'

export function ReportVisibilitySummary({ visibility }: { visibility: ReportVisibility }) {
  const populations = visibility.populations.filter(population => population.queryClass !== 'unknown' || population.summary.answerCount > 0)
  const historyPopulations = visibility.populations.filter(population => population.queryClass !== 'unknown' || population.trend.some(point => point.answerCount > 0))
  return <section id="client-summary" className="page-section-divider" aria-label={copy.title}>
    <h2 className="text-xl font-semibold text-heading">{copy.title}</h2>
    <p className="mt-2 text-sm text-secondary">{visibility.selection.mode === 'advanced' ? copy.description : copy.simpleDescription}</p>
    <p className="mt-2 text-sm text-secondary">{reportVisibilityMeasurementLabel(visibility)}</p>
    <div className="mt-4 overflow-x-auto">
      <table className="data-table w-full text-sm">
        <thead><tr>{[copy.queryType, copy.queries, copy.answers, copy.mentioned, copy.cited].map(label => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>{populations.map(population => <tr key={population.queryClass}>
          <td>{reportQueryClassLabel(population.queryClass)}</td>
          <td>{population.summary.queryCount}</td><td>{population.summary.answerCount}</td>
          {[population.summary.mentionCoverage, population.summary.citationCoverage].map((rate, index) => <td key={index}>
            <strong>{reportVisibilityRate(rate)}</strong><p className="text-xs text-secondary">{reportVisibilityEvidence(rate)}</p>
          </td>)}
        </tr>)}</tbody>
      </table>
    </div>
    <details className="mt-4">
      <summary className="cursor-pointer text-sm text-secondary">{reportVisibilityHistoryLabel(visibility)}</summary>
      <div className="mt-3 overflow-x-auto"><table className="data-table w-full text-sm">
        <thead><tr>{[copy.date, copy.queryType, copy.mentioned, copy.cited, copy.comparison].map(label => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>{historyPopulations.flatMap(population => population.trend.map(point => <tr key={`${population.queryClass}:${point.runId}`}>
          <td><time dateTime={point.createdAt}>{point.createdAt.slice(0, 10)}</time></td>
          <td>{reportQueryClassLabel(population.queryClass)}</td>
          {[point.mentionCoverage, point.citationCoverage].map((rate, index) => <td key={index}>{reportVisibilityRate(rate)}<p className="text-xs text-secondary">{reportVisibilityEvidence(rate)}</p></td>)}
          <td>{reportVisibilityComparison(point.continuity.state, point.continuity.comparedRunId !== null && !population.trend.some(previous => previous.runId === point.continuity.comparedRunId))}</td>
        </tr>))}</tbody>
      </table></div>
    </details>
  </section>
}
