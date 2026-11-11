import type { ReactNode } from 'react'

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet.js'

export function Drawer({
  title,
  subtitle,
  children,
  open,
  onClose,
  onClosed,
}: {
  title: string
  subtitle: string
  children: ReactNode
  open: boolean
  onClose: () => void
  onClosed?: () => void
}) {
  return (
    <Sheet open={open} onOpenChange={(nextOpen) => (nextOpen ? undefined : onClose())}>
      <SheetContent onCloseAutoFocus={event => { if (onClosed) { event.preventDefault(); onClosed() } }}>
        <SheetHeader className="drawer-head">
          <SheetTitle id="drawer-title">{title}</SheetTitle>
          <SheetDescription>{subtitle}</SheetDescription>
        </SheetHeader>
        <div className="drawer-body">{children}</div>
      </SheetContent>
    </Sheet>
  )
}
