import * as React from 'react'

import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/utils.js'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-zinc-50 text-black hover:bg-zinc-200',
        secondary: 'border border-zinc-800 bg-zinc-950 text-zinc-100 hover:bg-zinc-900',
        ghost: 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-50',
        outline: 'border border-zinc-800 bg-transparent text-zinc-100 hover:bg-zinc-900',
        destructive: 'bg-rose-600 text-white hover:bg-rose-700',
      },
      size: {
        default: 'h-9 px-4',
        sm: 'h-8 px-3 text-xs',
        icon: 'size-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'

    return <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
  },
)
Button.displayName = 'Button'

export { Button, buttonVariants }
