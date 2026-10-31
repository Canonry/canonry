import * as React from 'react'

import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/utils.js'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-button-14 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-50 pointer-coarse:min-h-11',
  {
    variants: {
      variant: {
        default: 'bg-accent text-on-inverse hover:bg-accent-hover',
        secondary: 'border border-base bg-bg text-heading hover:bg-bg-elevated',
        ghost: 'text-secondary hover:bg-bg-elevated hover:text-primary',
        outline: 'border border-base bg-transparent text-heading hover:bg-bg-elevated',
        destructive: 'bg-negative-600 text-on-emphasis hover:bg-negative-hover',
      },
      size: {
        default: 'h-9 px-4',
        sm: 'h-8 px-3',
        lg: 'h-10 rounded-lg px-5 text-button-16',
        icon: 'size-9 pointer-coarse:min-w-11',
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
