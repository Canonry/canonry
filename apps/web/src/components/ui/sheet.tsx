import * as React from 'react'

import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

import { cn } from '../../lib/utils.js'

const Sheet = Dialog.Root
const SheetTrigger = Dialog.Trigger
const SheetClose = Dialog.Close
const SheetPortal = Dialog.Portal

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof Dialog.Overlay>,
  React.ComponentPropsWithoutRef<typeof Dialog.Overlay>
>(({ className, ...props }, ref) => (
  <Dialog.Overlay
    ref={ref}
    className={cn('fixed inset-0 z-50 bg-black/70 backdrop-blur-sm', className)}
    {...props}
  />
))
SheetOverlay.displayName = Dialog.Overlay.displayName

const MIN_WIDTH = 400
const MAX_WIDTH = 1200
const DEFAULT_WIDTH = 720

const SheetContent = React.forwardRef<
  React.ElementRef<typeof Dialog.Content>,
  React.ComponentPropsWithoutRef<typeof Dialog.Content>
>(({ className, children, ...props }, ref) => {
  const [width, setWidth] = React.useState(DEFAULT_WIDTH)
  const isDragging = React.useRef(false)
  const startX = React.useRef(0)
  const startWidth = React.useRef(0)

  const onPointerDown = React.useCallback((e: React.PointerEvent) => {
    isDragging.current = true
    startX.current = e.clientX
    startWidth.current = width
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    e.preventDefault()
  }, [width])

  const onPointerMove = React.useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return
    const delta = startX.current - e.clientX
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + delta))
    setWidth(next)
  }, [])

  const onPointerUp = React.useCallback(() => {
    isDragging.current = false
  }, [])

  return (
    <SheetPortal>
      <SheetOverlay />
      <Dialog.Content
        ref={ref}
        className={cn(
          'fixed z-50 flex flex-col bg-zinc-950 px-5 py-4 shadow-2xl overflow-hidden',
          'max-md:inset-x-0 max-md:bottom-0 max-md:top-auto max-md:max-h-[88vh] max-md:rounded-t-2xl max-md:border-t',
          'md:inset-y-0 md:right-0 md:h-full md:border-l',
          'border-zinc-800',
          className,
        )}
        style={{ width: `min(${width}px, 100vw)` }}
        {...props}
      >
        {/* Resize handle */}
        <div
          className="absolute inset-y-0 left-0 w-1.5 cursor-col-resize hover:bg-zinc-700/50 active:bg-zinc-600/50 transition-colors max-md:hidden"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
        {children}
        <Dialog.Close className="absolute right-4 top-4 inline-flex size-8 items-center justify-center rounded-md text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400">
          <X className="size-4" />
          <span className="sr-only">Close</span>
        </Dialog.Close>
      </Dialog.Content>
    </SheetPortal>
  )
})
SheetContent.displayName = Dialog.Content.displayName

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col gap-1.5 pr-10', className)} {...props} />
)

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof Dialog.Title>,
  React.ComponentPropsWithoutRef<typeof Dialog.Title>
>(({ className, ...props }, ref) => (
  <Dialog.Title ref={ref} className={cn('text-lg font-medium text-zinc-50', className)} {...props} />
))
SheetTitle.displayName = Dialog.Title.displayName

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof Dialog.Description>,
  React.ComponentPropsWithoutRef<typeof Dialog.Description>
>(({ className, ...props }, ref) => (
  <Dialog.Description ref={ref} className={cn('text-sm text-zinc-500', className)} {...props} />
))
SheetDescription.displayName = Dialog.Description.displayName

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
}
