import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * Scroll physics for chat-style transcripts. Mirrors the behavior described
 * in the TanStack Virtual Chat blog post — end-anchored, conditional follow,
 * stable through streaming growth — without pulling the dependency.
 *
 * The caller passes `deps` (typically the message list and any streaming
 * state). When those change, if the user was already at the bottom we pin
 * to the new bottom; if they had scrolled up, we leave the viewport alone.
 * A `ResizeObserver` covers height changes that don't come through React
 * deps (markdown reflow, image loads, late font metrics).
 */
export interface UseChatScrollOptions {
  /** Pixels from the bottom within which the user counts as "at end". */
  threshold?: number
}

export interface UseChatScrollResult<T extends HTMLElement> {
  ref: RefObject<T | null>
  scrollToEnd: () => void
  isAtEnd: () => boolean
}

export function useChatScroll<T extends HTMLElement = HTMLDivElement>(
  deps: ReadonlyArray<unknown>,
  options: UseChatScrollOptions = {},
): UseChatScrollResult<T> {
  const { threshold = 80 } = options
  const ref = useRef<T | null>(null)
  const state = useRef({ scrollHeight: 0, wasAtEnd: true })

  function distanceFromEnd(el: HTMLElement): number {
    return el.scrollHeight - el.scrollTop - el.clientHeight
  }

  function isAtEnd(): boolean {
    const el = ref.current
    if (!el) return true
    return distanceFromEnd(el) <= threshold
  }

  function scrollToEnd(): void {
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    state.current.wasAtEnd = true
    state.current.scrollHeight = el.scrollHeight
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = (): void => {
      state.current.wasAtEnd = distanceFromEnd(el) <= threshold
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [threshold])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const newHeight = el.scrollHeight
    const grew = newHeight > state.current.scrollHeight
    if (grew && state.current.wasAtEnd) el.scrollTop = newHeight
    state.current.scrollHeight = newHeight
  }, deps)

  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const newHeight = el.scrollHeight
      const grew = newHeight > state.current.scrollHeight
      if (grew && state.current.wasAtEnd) el.scrollTop = newHeight
      state.current.scrollHeight = newHeight
    })
    observer.observe(el)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    return () => observer.disconnect()
  }, [])

  return { ref, scrollToEnd, isAtEnd }
}
