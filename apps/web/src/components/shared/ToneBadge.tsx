import type { ReactNode } from 'react'
import type { MetricTone } from '../../view-models.js'
import { Badge } from '../ui/badge.js'

export function ToneBadge({ tone, children }: { tone: MetricTone; children: ReactNode }) {
  const variant =
    tone === 'positive' ? 'success' : tone === 'caution' ? 'warning' : tone === 'negative' ? 'destructive' : 'neutral'

  return <Badge variant={variant}>{children}</Badge>
}
