import type { ProjectCommandCenterVm } from '../../view-models.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from './ToneBadge.js'
import { Sparkline } from './Sparkline.js'

export function MetricCard({ metric }: { metric: ProjectCommandCenterVm['visibilitySummary'] }) {
  const numericValue = Number.parseInt(metric.value, 10)
  const progressValue = Number.isNaN(numericValue) ? 0 : Math.max(0, Math.min(numericValue, 100))

  return (
    <Card className={`metric-card metric-card-${metric.tone}`}>
      <div className="metric-card-head">
        <p className="eyebrow eyebrow-soft">{metric.label}</p>
        <ToneBadge tone={metric.tone}>{metric.delta}</ToneBadge>
      </div>
      <div className="metric-card-body">
        <div>
          <p className="metric-value">{metric.value}</p>
          <p className="metric-description">{metric.description}</p>
        </div>
        <Sparkline points={metric.trend} tone={metric.tone} />
      </div>
      <div className="progress-track" aria-hidden="true">
        <div className={`progress-fill progress-fill-${metric.tone}`} style={{ width: `${progressValue}%` }} />
      </div>
    </Card>
  )
}
