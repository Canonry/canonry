import { useId } from 'react'
import type { MetricTone } from '../../view-models.js'

export function Sparkline({ points, tone }: { points: number[]; tone: MetricTone }) {
  const clipId = useId()
  if (points.length === 0) return null
  const height = 42
  const width = 132
  const padding = 5
  const min = Math.min(...points)
  const max = Math.max(...points)
  const range = max - min || 1
  const innerWidth = width - padding * 2
  const innerHeight = height - padding * 2
  const coordinates = points
    .map((point, index) => {
      const x = padding + (index / Math.max(points.length - 1, 1)) * innerWidth
      const y = padding + (1 - (point - min) / range) * innerHeight
      return `${x},${y}`
    })
    .join(' ')

  return (
    <svg className={`sparkline sparkline-${tone}`} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <rect x={padding} y={padding} width={innerWidth} height={innerHeight} rx="8" />
        </clipPath>
      </defs>
      <line className="sparkline-guide" x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} />
      <polyline clipPath={`url(#${clipId})`} points={coordinates} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
