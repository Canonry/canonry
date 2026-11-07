import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

/** Shared viewport positioning for plain and rich help, including embedded reports. */
export function useTooltipPosition(placement: 'top' | 'bottom', width: string) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 8, left: 8 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const bubbleRef = useRef<HTMLSpanElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearClose = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }, [])
  const show = useCallback(() => { clearClose(); setOpen(true) }, [clearClose])
  const hide = useCallback(() => { clearClose(); setOpen(false) }, [clearClose])
  // The gap between trigger and bubble must not close help while a pointer crosses it.
  const hideAfterPointerLeaves = useCallback(() => {
    clearClose()
    closeTimer.current = setTimeout(hide, 150)
  }, [clearClose, hide])

  useEffect(() => clearClose, [clearClose])
  useLayoutEffect(() => {
    if (!open) return
    const positionBubble = () => {
      if (!triggerRef.current || !bubbleRef.current) return
      const trigger = triggerRef.current.getBoundingClientRect()
      const bubble = bubbleRef.current.getBoundingClientRect()
      const preferredTop = placement === 'bottom' ? trigger.bottom + 8 : trigger.top - bubble.height - 8
      const top = Math.max(8, Math.min(preferredTop, window.innerHeight - bubble.height - 8))
      const left = Math.max(8, Math.min(trigger.left + (trigger.width - bubble.width) / 2, window.innerWidth - bubble.width - 8))
      setPosition(current => current.top === top && current.left === left ? current : { top, left })
    }
    positionBubble()
    window.addEventListener('resize', positionBubble)
    window.addEventListener('scroll', positionBubble, true)
    return () => {
      window.removeEventListener('resize', positionBubble)
      window.removeEventListener('scroll', positionBubble, true)
    }
  }, [open, placement])

  const style: CSSProperties = {
    position: 'fixed',
    ...position,
    width,
    maxWidth: 'calc(100vw - 1rem)',
    maxHeight: 'calc(100vh - 1rem)',
    overflowY: 'auto',
    overflowWrap: 'anywhere',
    zIndex: 9999,
  }
  return { open, triggerRef, bubbleRef, style, show, hide, hideAfterPointerLeaves }
}
