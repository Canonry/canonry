import type { MetricTone } from '../../view-models.js'
import { InfoTooltip } from './InfoTooltip.js'

export function ScoreGauge({
  value,
  label,
  delta,
  tone,
  description,
  tooltip,
  isNumeric = true,
  progress,
}: {
  value: string
  label: string
  delta: string
  tone: MetricTone
  description: string
  tooltip?: string
  isNumeric?: boolean
  progress?: number
}) {
  const radius = 48
  const strokeWidth = 6
  const circumference = 2 * Math.PI * radius
  const numericValue = Number.parseInt(value, 10)
  const normalizedProgress = typeof progress === 'number' && Number.isFinite(progress)
    ? Math.min(Math.max(progress, 0), 1)
    : isNumeric && !Number.isNaN(numericValue)
      ? Math.min(numericValue / 100, 1)
      : 0.5
  const dashOffset = circumference * (1 - normalizedProgress)

  return (
    <div className="score-gauge">
      <div className="gauge-ring-wrapper">
        <svg className="gauge-ring" viewBox="0 0 120 120" aria-hidden="true">
          <circle className="gauge-bg" cx="60" cy="60" r={radius} strokeWidth={strokeWidth} />
          <circle
            className={`gauge-fill gauge-fill-${tone}`}
            cx="60"
            cy="60"
            r={radius}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            transform="rotate(-90 60 60)"
          />
        </svg>
        <div className="gauge-center">
          <span className={isNumeric ? 'gauge-value' : 'gauge-value-text'}>{value.split(' / ')[0]}</span>
        </div>
      </div>
      <p className="gauge-label">
        {label}
        {tooltip && <InfoTooltip text={tooltip} />}
      </p>
      <p className="gauge-delta">{delta}</p>
      <p className="gauge-description">{description}</p>
    </div>
  )
}
