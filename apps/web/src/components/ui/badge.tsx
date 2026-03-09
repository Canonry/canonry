import * as React from 'react'

import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/utils.js'

const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium tracking-wide',
  {
    variants: {
      variant: {
        neutral: 'border-zinc-800 bg-zinc-950 text-zinc-300',
        success: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
        warning: 'border-amber-500/25 bg-amber-500/10 text-amber-300',
        destructive: 'border-rose-500/25 bg-rose-500/10 text-rose-300',
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
