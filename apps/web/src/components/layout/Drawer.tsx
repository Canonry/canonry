import type { ReactNode } from 'react'

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet.js'

export function Drawer({
  title,
  subtitle,
  children,
  open,
  onClose,
  onClosed,
  onCloseAutoFocus,
}: {
  title: string
  subtitle: string
  children: ReactNode
  open: boolean
  onClose: () => void
  onClosed?: () => void
  onCloseAutoFocus?: (event: Event) => void
}) {
  const restoreFocus = (event: Event) => {
    onCloseAutoFocus?.(event)
    if (onClosed && !event.defaultPrevented) {
      event.preventDefault()
      onClosed()
    }
  }

  return (
    <Sheet open={open} onOpenChange={(nextOpen) => (nextOpen ? undefined : onClose())}>
      <SheetContent onCloseAutoFocus={restoreFocus}>
        <SheetHeader className="drawer-head">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{subtitle}</SheetDescription>
        </SheetHeader>
        <div className="drawer-body">{children}</div>
      </SheetContent>
    </Sheet>
  )
}
