import type { ReactNode } from 'react'
import type { MetricTone } from '../../view-models.js'
import type { BadgeProps } from '../ui/badge.js'
import { Badge } from '../ui/badge.js'

type ToneBadgeProps = Omit<BadgeProps, 'variant'> & {
  tone: MetricTone
  children: ReactNode
}

export function ToneBadge({ tone, children, ...props }: ToneBadgeProps) {
  const variant =
    tone === 'positive' ? 'success' : tone === 'caution' ? 'warning' : tone === 'negative' ? 'destructive' : 'neutral'

  return <Badge variant={variant} {...props}>{children}</Badge>
}
