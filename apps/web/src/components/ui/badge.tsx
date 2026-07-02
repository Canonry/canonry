import * as React from 'react'

import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/utils.js'

const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium tracking-wide',
  {
    variants: {
      variant: {
        neutral: 'border-base bg-bg text-neutral',
        success: 'border-positive bg-positive-soft text-positive',
        warning: 'border-caution-500/25 bg-caution-soft text-caution',
        destructive: 'border-negative bg-negative-soft text-negative',
      },
    },
    defaultVariants: {
      variant: 'neutral',
    },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
