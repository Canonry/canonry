import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

const twMerge = extendTailwindMerge<'geist-type' | 'material'>({
  extend: {
    classGroups: {
      'geist-type': [
        { 'text-heading': [(value: string) => /^\d+(?:-subtle)?$/.test(value)] },
        { 'text-label': [(value: string) => /^\d+(?:-mono)?(?:-strong)?$/.test(value)] },
        { 'text-copy': [(value: string) => /^\d+(?:-mono)?(?:-strong)?$/.test(value)] },
        { 'text-button': [(value: string) => /^\d+$/.test(value)] },
      ],
      material: [{ material: ['base', 'small', 'medium', 'large', 'tooltip', 'menu', 'modal', 'fullscreen'] }],
    },
    conflictingClassGroups: {
      'geist-type': ['font-size', 'font-weight', 'leading', 'tracking'],
      'font-size': ['geist-type'],
      material: ['rounded', 'bg-color', 'shadow', 'border-w', 'border-color'],
    },
  },
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
